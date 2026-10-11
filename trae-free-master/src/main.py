"""
main.py - trae-free 中转站
提供 OpenAI 兼容的 REST API:  GET  /v1/models
  POST /v1/chat/completions
  POST /v1/responses
  POST /v1/chat
  POST /v1

上游模式:  UPSTREAM_MODE=cli  - 只使用本地 Trae CLI 子进程
  UPSTREAM_MODE=auto - 与 raw 相同，所有模型请求直达 Trae 原生 chat 协议
  UPSTREAM_MODE=raw  - 直连 Trae 原生 chat 协议（direct 为别名）
  UPSTREAM_MODE=remote/9router - 只用 9router 风格 remote 会话
  UPSTREAM_MODE=web  - 只用旧版 CN remote 会话（兼容保留）
  UPSTREAM_MODE=ide  - 只用 IDE Agent /api/agent/v3/llm_utils_chat
  UPSTREAM_MODE=solo - 只用 Trae SOLO /api/agent/v3/llm_utils_chat
  UPSTREAM_MODE=traework-native - Windows helper 承载 TraeWork ai-agent.dll
"""

import asyncio
import base64
import binascii
import codecs
import gzip
import hashlib
import html as html_mod
import ipaddress
import json
import logging
import os
import re
import threading
import time
import secrets
import sys
import uuid as uuid_mod
import zlib
from collections import OrderedDict
from contextlib import asynccontextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping, Optional

import dotenv

# Several transport modules cache environment-derived defaults at import time.
# Load the project .env before importing them so local and Docker startup use
# the same configuration order.
dotenv.load_dotenv()

import anyio
import httpx
from fastapi import FastAPI, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse, Response, StreamingResponse
from fastapi.responses import FileResponse

from . import (
    auth,
    cli_client,
    logbuf,
    raw_client,
    responses_api,
    trae_client,
    trae_remote_client,
    traework_compat,
    traework_native_bridge,
    web_auth,
)
from .console import icons as console_icons
from .console import page as console_page
from .model_limits import clamp_max_completion_tokens
from .sse import (
    EmptyUpstreamResponse,
    ModelProviderMismatch,
    RepeatedCompletedToolResponse,
    collect_nonstream_cli,
    collect_nonstream_ide,
    collect_nonstream_web,
    translate_cli_stream,
    translate_ide_stream,
    translate_web_events,
)

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO").upper())
logger = logging.getLogger("trae-free")

# In-process log ring backing the console log page. Installed at import so the
# ring exists even before the app lifespan runs (and in tests).
_LOG_RING = logbuf.install_ring_handler(logger)

HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8015"))
API_KEYS = [k.strip() for k in os.environ.get("RELAY_API_KEYS", "").split(",") if k.strip()]
UPSTREAM_MODE = (os.environ.get("UPSTREAM_MODE", "remote") or "remote").lower()
_VALID_UPSTREAM_MODES = (
    "remote", "raw", "direct", "auto", "web", "ide", "solo", "work-agent",
    "9router", "trae-remote", "cli", "traework-native",
    "native", "traework",
)


def _current_upstream_mode() -> str:
    """Read the upstream mode at request time so preset changes apply immediately."""
    # The module attribute is authoritative.  The startup read already merged
    # env defaults, and runtime preset changes update both env and the module
    # value.  Tests can patch ``src.main.UPSTREAM_MODE`` to isolate scenarios.
    return str(globals().get("UPSTREAM_MODE") or "remote").lower()


def _restore_persisted_relay_settings() -> dict:
    """Apply console settings that live in the account store after startup.

    The container environment is a useful bootstrap/default, but the web
    console also persists relay settings in ``data/accounts.json``.  Restore
    those values after ``auth.init_auth()`` so a container recreation does not
    silently switch the selected upstream back to the image's ``.env``.
    """

    global UPSTREAM_MODE, WEB_BASE
    settings = auth.get_settings() or {}
    # The IDE Raw/IDE Agent and Remote/Work Agent presets intentionally share
    # base URLs.  ``endpoint_id`` is therefore the authoritative persisted
    # identity when present; URL-only restoration is retained for stores
    # written by older releases.
    endpoint_id = str(settings.get("endpoint_id") or "").strip().lower()
    endpoint = next(
        (
            item
            for item in UPSTREAM_ENDPOINT_PRESETS
            if str(item.get("id") or "").strip().lower() == endpoint_id
        ),
        None,
    ) if endpoint_id else None
    mode = str(
        (endpoint or {}).get("mode")
        or settings.get("upstream_mode")
        or ""
    ).strip().lower()
    if mode in _VALID_UPSTREAM_MODES:
        UPSTREAM_MODE = mode
        os.environ["UPSTREAM_MODE"] = mode
    web_base = str(
        (endpoint or {}).get("base_url")
        or settings.get("web_base_url")
        or ""
    ).strip().rstrip("/")
    if web_base:
        WEB_BASE = web_base
        os.environ["TRAE_WEB_BASE_URL"] = web_base
    # Repair partially migrated stores once at startup.  This also makes the
    # settings API/UI observe the same canonical mode and URL as dispatch.
    if endpoint is not None and (
        settings.get("upstream_mode") != endpoint["mode"]
        or str(settings.get("web_base_url") or "").strip().rstrip("/")
        != str(endpoint["base_url"]).rstrip("/")
    ):
        try:
            auth.set_relay_settings(
                web_base_url=str(endpoint["base_url"]),
                upstream_mode=str(endpoint["mode"]),
                endpoint_id=str(endpoint["id"]),
            )
            # ``auth.set_relay_settings`` persists the canonical values, but
            # an older/custom store adapter may return a stale snapshot from
            # ``get_settings`` immediately afterwards.  Return the same
            # canonical state that was applied to the running process so the
            # settings page cannot rehydrate the shared URL as Raw/Remote.
            settings = dict(settings)
            settings.update(
                {
                    "web_base_url": str(endpoint["base_url"]).rstrip("/"),
                    "upstream_mode": str(endpoint["mode"]).strip().lower(),
                    "endpoint_id": str(endpoint["id"]).strip().lower(),
                }
            )
        except Exception:
            logger.debug("could not repair persisted endpoint preset", exc_info=True)
    return settings

FORWARD_USAGE = (os.environ.get("FORWARD_USAGE", "true") or "true").lower() == "true"
CHECKIN_INTERVAL = float(os.environ.get("TRAE_CHECKIN_INTERVAL_SECONDS", "60") or "60")
CHECKIN_RETRY_AFTER = float(
    os.environ.get("TRAE_CHECKIN_9074_RETRY_SECONDS", "60") or "60"
)
CHECKIN_9074_MAX_BACKOFF = float(
    os.environ.get("TRAE_CHECKIN_9074_MAX_BACKOFF_SECONDS", "3600") or "3600"
)
# Cap the doubling so a long 9074 streak settles at minutes, not the ceiling.
CHECKIN_9074_BACKOFF_EXPONENT_CAP = max(
    0,
    int(os.environ.get("TRAE_CHECKIN_9074_BACKOFF_EXPONENT_CAP", "3") or "3"),
)
CHECKIN_AUTO_RETRY_INTERVAL = float(
    os.environ.get("TRAE_CHECKIN_AUTO_RETRY_INTERVAL_SECONDS", "60") or "60"
)
WEB_BASE = (os.environ.get("TRAE_WEB_BASE_URL", "https://trae-api-cn.mchost.guru/api/remote/v1")).rstrip("/")
UPSTREAM_ENDPOINT_PRESETS = (
    {
        "id": "remote",
        "label": "Remote / chat_sessions",
        "base_url": "https://trae-api-cn.mchost.guru/api/remote/v1",
        "mode": "remote",
    },
    {
        "id": "ide",
        "label": "IDE Agent / llm_utils_chat",
        "base_url": "https://trae-api-cn.mchost.guru",
        "mode": "ide",
    },
    {
        "id": "solo",
        "label": "Solo / api/agent/v3/llm_utils_chat",
        "base_url": "https://trae-api-cn.mchost.guru",
        "endpoint_url": "https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat",
        "endpoint_path": "/api/agent/v3/llm_utils_chat",
        # The Solo transport is implemented by the existing IDE client.  The
        # distinct mode keeps the selected protocol visible and persistent
        # while reusing its headers, SSE parser and fallback behavior.
        "mode": "solo",
    },
    {
        "id": "agent",
        "label": "Work Agent / solo_work_remote",
        "base_url": "https://trae-api-cn.mchost.guru/api/remote/v1",
        "mode": "work-agent",
    },
)
CHAT_OPTION_FIELDS = (
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "client_context",
    "clientContext",
    "session_id",
    "sessionId",
    "max_tokens",
    "maxTokens",
    "max_completion_tokens",
    "temperature",
    "top_p",
    "stop",
    "presence_penalty",
    "frequency_penalty",
    "seed",
    # ``thinking`` is a client-visible presentation/request hint.  It must be
    # retained through the relay even though the native raw body has no field
    # for it; the SSE/Responses translators use it to expose a compact
    # reasoning summary without leaking the full upstream trace.
    "thinking",
    "reasoning_effort",
    # Per-request 1M max opt-in; the console switch is the global default.
    "trae_max_mode",
    "max_mode",
    "stream_options",
    "response_format",
    "service_tier",
    "user",
    "logprobs",
    "top_logprobs",
    # TraeWork model-selection aliases passed through to the raw transport.
    # Raw session ids are intentionally not caller-overridable: the relay pins
    # one upstream conversation to each account/model pair.
    "traeRawConfigName",
    "traeRawModelName",
    "rawModelName",
    "configName",
    "displayName",
    "modelName",
    "provider",
    "configSource",
    # TraeWork native Ode/Gpt payload aliases. These are ignored by raw/remote
    # transports and are consumed only by the opt-in Windows helper route.
    "native_data",
    "native_user_info",
    "native_common_params",
    "native_streamlined_common_params",
    "native_client_info",
    "connect_session_id",
    "connectSessionId",
    "native_session_id",
    "native_channel_id",
    "channel_id",
    "workspace_folder",
    "workspacePath",
    "workspace_id",
    "workspaceId",
    "device_id",
    "deviceId",
    "agent_type",
    "shell_execute_strategy",
    "model_auto_selection",
    "custom_model",
    "model_config_source",
    "modelConfigSource",
    "model_is_preset",
    "modelIsPreset",
    "model_provider",
    "modelProvider",
    "ppe_env_name",
    "ppeEnvName",
    "envLane",
    "agentEnv",
    "forceSandboxType",
    "version_code",
    "versionCode",
)

# Per-request usage tracking. Records are stored separately from account data so
# a dashboard/deploy change can never rewrite the saved login cache.
_USAGE_HISTORY: list[dict] = []
_USAGE_MAX_HISTORY = 100
_USAGE_LOCK = threading.RLock()
_USAGE_RECORDS_PATH = Path(
    os.environ.get("TRAE_USAGE_RECORDS_PATH", "")
    or (Path(__file__).resolve().parent.parent / "data" / "usage_records.json")
)
# Lifetime token totals bucketed by Asia/Shanghai day. The request history
# above is capped, so the dashboard overview reads this file instead.
_USAGE_STATS_PATH_OVERRIDE = os.environ.get("TRAE_USAGE_STATS_PATH", "")
_USAGE_STATS: dict[str, Any] = {"days": {}}
_USAGE_STATS_FIELDS = (
    "requests",
    "completed",
    "failed",
    "input_tokens",
    "output_tokens",
    "cached_tokens",
    "total_tokens",
    "credits",
    # Request capability metadata is aggregated separately from token
    # accounting so the dashboard can answer "how many requests used Max or
    # tools?" without scanning the capped request history.
    "max_mode_requests",
    "max_mode_enabled_requests",
    "tool_requests",
    "tool_calls",
)
_USAGE_STATS_MAX_DAYS = 400
_PROCESS_STARTED_AT = time.time()

# Project logo lives in src/console/icons.py, which the console package owns.
# Re-exported here because tests and the favicon route read these names.
_LOGO_PATHS = console_icons.LOGO_PATHS
LOGO_SVG = console_icons.LOGO_SVG
_LOGO_SVG_INLINE = console_icons.LOGO_SVG_INLINE
_FAVICON_LINKS = (
    '<link rel="icon" type="image/svg+xml" href="/favicon.svg">'
    '<link rel="apple-touch-icon" href="/favicon.svg">'
)
_USAGE_TRACKER: ContextVar[Any] = ContextVar("trae_usage_tracker", default=None)
_USAGE_ENRICH_TASKS: set[asyncio.Task] = set()
_USAGE_SNAPSHOT_TASKS: set[asyncio.Task] = set()
_USAGE_ACTIVE_ACCOUNTS: dict[str, int] = {}
_USAGE_UNSAFE_ACCOUNTS: set[str] = set()
_CHECKIN_ACCOUNT_LOCKS: dict[str, asyncio.Lock] = {}
_CHECKIN_CLAIM_GATE: asyncio.Lock | None = None
_CHECKIN_CLAIM_GATE_LOOP: asyncio.AbstractEventLoop | None = None
_CHECKIN_NEXT_CLAIM_AT = 0.0
_CHECKIN_COOLDOWN_UNTIL: dict[str, float] = {}
# The claim endpoint and the status endpoint are throttled independently: 9074
# ("too many users, retry later") on claim does not stop status from answering
# code=0. Track the status-side window separately so a claim cooldown cannot
# freeze the dashboard on a stale checked_in value.
_CHECKIN_STATUS_COOLDOWN_UNTIL: dict[str, float] = {}
_CHECKIN_ACCEPTED_UNTIL: dict[str, float] = {}
_CHECKIN_TIMEZONE = timezone(timedelta(hours=8), name="Asia/Shanghai")
# Kept as a compatibility knob for older integrations; claim no longer runs
# automatic verification probes.
_CHECKIN_VERIFY_DELAYS: tuple[float, ...] = ()

# OpenAI clients normally replay the complete conversation instead of sending
# a relay-specific session id. Tool execution can legitimately take several
# minutes, so keep the credential/session binding long enough for those
# continuations to return to the same upstream account.
_CHAT_SESSION_TTL = max(
    1.0,
    float(
        os.environ.get(
            "TRAE_SESSION_IDLE_TIMEOUT_SECONDS",
            os.environ.get("TRAE_CHAT_SESSION_TTL_SECONDS", "3600"),
        )
        or "3600"
    ),
)
_CHAT_SESSION_MAX = max(64, int(os.environ.get("TRAE_CHAT_SESSION_CACHE_SIZE", "2048") or "2048"))
_CHAT_SESSION_LOCK = threading.RLock()
_CHAT_HISTORY_SESSIONS: OrderedDict[str, tuple[str, float]] = OrderedDict()


@dataclass
class _UpstreamSessionLease:
    account_id: str
    billing_id: str
    auth_token: str
    last_client_activity: float
    active_streams: int = 0
    provider_specific: dict[str, Any] = field(default_factory=dict)


_UPSTREAM_SESSION_LEASES: OrderedDict[str, _UpstreamSessionLease] = OrderedDict()


class _ModelAccountUnavailable(RuntimeError):
    """No enabled credential can receive this model request."""


def _ensure_model_account_enabled(account_id: str = "", token: str = "") -> None:
    identities = {str(account_id or ""), _account_id_from_token(token)} - {""}
    for identity in identities:
        if not auth.is_account_model_enabled(identity):
            raise _ModelAccountUnavailable(
                "The bound model account is disabled; enable it in 账号与签到 "
                "or start a new session with an enabled account"
            )
    if not identities:
        accounts = auth.get_accounts_raw()
        if accounts and all(not auth._record_model_enabled(rec) for _, rec in accounts):
            raise _ModelAccountUnavailable(
                "No enabled model account available; enable an account in 账号与签到"
            )


def _credit_settle_seconds() -> float:
    try:
        value = float(os.environ.get("TRAE_USAGE_CREDIT_SETTLE_SECONDS", "1"))
    except (TypeError, ValueError):
        value = 1.0
    return max(0.0, min(value, 10.0))


def _session_usage_enabled() -> bool:
    return str(os.environ.get("TRAE_USAGE_SESSION_QUERY", "true")).strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }

# Web login auth
TRAE_AUTH_URL = os.environ.get("TRAE_AUTH_URL", "https://www.trae.cn/authorization")
TRAE_CLIENT_ID = os.environ.get("TRAE_CLIENT_ID") or "ono9krqynydwx5"
LOCAL_LISTENER_PORT = int(os.environ.get("WEB_LOGIN_LISTENER_PORT", "8765"))
PUBLIC_PATHS = {
    "/healthz",
    "/favicon.svg",
    "/favicon.ico",
    "/v1/status",
    "/v1/models",
    "/models",
    "/web/login",
    "/authorize",
    "/api/web-auth",
    "/api/logout",
    "/api/accounts",
    "/api/accounts/switch",
    "/api/accounts/remove",
    "/api/settings",
    "/api/polling",
    "/api/polling-mode",
    "/api/max-mode",
    "/api/max-mode/models",
    "/api/models/detail",
    "/api/auto-route",
    "/api/auto-checkin",
    "/api/auto-checkin/run",
    "/api/checkin/status",
    "/api/checkin/claim",
    "/api/checkin/accounts",
    "/api/checkin/claim-all",
    "/api/checkin/claim-credits",
    "/api/checkin/account",
    "/api/checkin/work-credits",
    "/api/usage/last",
    "/api/usage/records",
    "/api/overview",
    "/api/logs",
    "/api/web-login/status",
    "/api/web-login/state",
    # TraeWork custom-model management probes cannot reliably attach the
    # relay API key before the model has been saved. Chat ingress remains
    # protected by the normal middleware; only connectivity is public.
    "/api/agent/v3/custom_model_connectivity_check",
    "/api/ide/v1/custom_model_connectivity_check",
    "/v1/custom_model/connectivity",
}
PUBLIC_PATH_PREFIXES = ("/api/checkin", "/api/accounts", "/console/")


class _RequestBodyError(ValueError):
    """A client request body could not be decoded as an OpenAI JSON object."""

    def __init__(self, message: str, *, raw_bytes: int = 0):
        super().__init__(message)
        self.raw_bytes = max(0, int(raw_bytes))


def _request_body_charset(content_type: str) -> str:
    """Return a safe charset from Content-Type, defaulting to UTF-8."""

    match = re.search(r"(?:^|;)\s*charset\s*=\s*['\"]?([^;\"']+)", content_type, re.I)
    candidate = (match.group(1).strip() if match else "utf-8")
    try:
        return codecs.lookup(candidate).name
    except LookupError:
        return "utf-8"


def _decode_request_content(raw: bytes, content_encoding: str) -> bytes:
    """Decode common HTTP content codings before JSON parsing.

    httpx/zcode may gzip the request body while the relay is served directly
    by uvicorn. Starlette intentionally leaves Content-Encoding untouched, so
    ``Request.json()`` would reject an otherwise valid payload. Decode only
    codings available in the standard library; unknown codings are reported to
    the caller instead of silently forwarding an empty prompt.
    """

    codings = [
        item.strip().lower()
        for item in (content_encoding or "").split(",")
        if item.strip() and item.strip().lower() != "identity"
    ]
    decoded = raw
    for coding in reversed(codings):
        if coding in ("gzip", "x-gzip"):
            try:
                decoded = gzip.decompress(decoded)
            except (OSError, EOFError) as exc:
                raise _RequestBodyError(
                    "Invalid gzip request body", raw_bytes=len(raw)
                ) from exc
        elif coding == "deflate":
            try:
                decoded = zlib.decompress(decoded)
            except zlib.error:
                try:
                    # A few clients send a raw DEFLATE stream without zlib
                    # framing. Accept it when the standard form fails.
                    decoded = zlib.decompress(decoded, -zlib.MAX_WBITS)
                except zlib.error as exc:
                    raise _RequestBodyError(
                        "Invalid deflate request body", raw_bytes=len(raw)
                    ) from exc
        else:
            raise _RequestBodyError(
                f"Unsupported request Content-Encoding: {coding}",
                raw_bytes=len(raw),
            )
    return decoded


async def _read_json_body(
    request: Request,
    *,
    endpoint: str = "",
    trace_id: str = "",
) -> tuple[dict[str, Any], int]:
    """Read and normalize one incoming JSON body without losing client data.

    The raw byte count is returned for diagnostics. We deliberately do not log
    body contents or token-bearing fields. A small compatibility allowance for
    double-encoded JSON helps clients that pass a serialized request through a
    generic transport wrapper.
    """

    try:
        raw = await request.body()
    except Exception as exc:
        # A client that disconnects while still uploading must never look like
        # an accepted empty task. Report it as a request-body failure, before
        # any upstream route is selected.
        raise _RequestBodyError(
            "Request body could not be read before the upload completed"
        ) from exc
    raw_size = len(raw)
    content_encoding = request.headers.get("content-encoding", "")
    decoded = _decode_request_content(raw, content_encoding)
    if not decoded.strip():
        raise _RequestBodyError("Request body is empty", raw_bytes=raw_size)
    charset = _request_body_charset(request.headers.get("content-type", ""))
    try:
        text = decoded.decode(charset).lstrip("\ufeff").strip()
    except UnicodeDecodeError as exc:
        raise _RequestBodyError(
            f"Request body is not valid {charset} JSON", raw_bytes=raw_size
        ) from exc
    try:
        payload: Any = json.loads(text)
    except (TypeError, json.JSONDecodeError) as exc:
        raise _RequestBodyError(
            "Invalid JSON body", raw_bytes=raw_size
        ) from exc
    if isinstance(payload, str):
        nested = payload.lstrip("\ufeff").strip()
        if nested.startswith("{"):
            try:
                payload = json.loads(nested)
            except json.JSONDecodeError as exc:
                raise _RequestBodyError(
                    "Invalid nested JSON body", raw_bytes=raw_size
                ) from exc
    if not isinstance(payload, Mapping):
        raise _RequestBodyError(
            "JSON body must be an object", raw_bytes=raw_size
        )
    body = dict(payload)
    logger.info(
        "request body received id=%s endpoint=%s bytes=%d decoded_bytes=%d content_type=%s "
        "content_encoding=%s keys=%s",
        trace_id or "-",
        endpoint or request.url.path,
        raw_size,
        len(decoded),
        request.headers.get("content-type", ""),
        content_encoding or "identity",
        ",".join(sorted(str(key) for key in body.keys())),
    )
    return body, raw_size


def _message_content_fallback(message: Mapping[str, Any]) -> Any:
    """Extract common non-OpenAI aliases used by zcode/OpenCode adapters."""

    for key in ("parts", "text", "prompt", "message", "input"):
        value = message.get(key)
        if value not in (None, "", [], {}):
            return value
    return None


def _normalize_chat_messages(value: Any) -> list[dict[str, Any]]:
    """Coerce compatible chat message wrappers while preserving tool fields."""

    if isinstance(value, str):
        candidate = value.strip()
        if candidate.startswith("["):
            try:
                value = json.loads(candidate)
            except json.JSONDecodeError:
                value = [value]
        else:
            value = [value]
    if isinstance(value, Mapping):
        value = [value]
    if not isinstance(value, list):
        return []
    normalized: list[dict[str, Any]] = []
    for item in value:
        if isinstance(item, str):
            normalized.append({"role": "user", "content": item})
            continue
        if not isinstance(item, Mapping):
            continue
        message = dict(item)
        role = str(message.get("role") or message.get("speaker") or "user")
        if role not in ("system", "developer", "user", "assistant", "tool", "function"):
            role = "user"
        message["role"] = role
        if (
            message.get("content") in (None, "", [])
            and not message.get("tool_calls")
        ):
            fallback = _message_content_fallback(message)
            if fallback is not None:
                message["content"] = fallback
        normalized.append(message)
    return cli_client.repair_tool_call_history(normalized)


def _json_loads_safe(value: str) -> dict:
    if not value:
        return {}
    try:
        return json.loads(value)
    except (json.JSONDecodeError, TypeError):
        return {}


async def _parse_oauth_params(query: dict) -> dict:
    """解析 Trae 授权回调参数。

    Trae 网页授权页实际会走两套流程：
      1. 新流程 (code_challenge): callback 会带 authCodeInfo / code 等参数
      2. 老流程 (refreshToken): callback 直接带 refreshToken=xxx
    对于老流程，本地不会拥有 Cloud-IDE-JWT，需要拿到 refreshToken 后通过
    oauth/ExchangeToken 向 api.trae.cn 兑换 Cloud-IDE-JWT。
    """
    user_jwt = _json_loads_safe(query.get("userJwt", ""))
    token = user_jwt.get("Token") or user_jwt.get("token") or ""
    refresh = user_jwt.get("RefreshToken") or user_jwt.get("refreshToken") or query.get("refreshToken") or query.get("data") or ""
    token_exp = user_jwt.get("TokenExpireAt") or user_jwt.get("tokenExpireAt") or ""
    refresh_exp = user_jwt.get("RefreshExpireAt") or user_jwt.get("refreshExpireAt") or query.get("refreshExpireAt") or ""

    user_info = _json_loads_safe(query.get("userInfo", ""))
    user_id = user_info.get("UserID") or user_info.get("userId") or user_info.get("userID") or query.get("userId") or ""
    region = user_info.get("Region") or user_info.get("region") or query.get("region") or "CN"
    ai_region = user_info.get("AIRegion") or user_info.get("aiRegion") or region
    client_id = user_jwt.get("ClientID") or user_jwt.get("clientId") or query.get("clientID") or query.get("clientId") or query.get("client_id") or ""
    host = query.get("host") or user_info.get("Host") or user_info.get("host") or ""

    if not token and refresh:
        exchange = await _exchange_refresh_token(
            refresh_token=refresh,
            client_id=client_id or TRAE_CLIENT_ID,
            host=host,
        )
        if exchange.get("token"):
            token = exchange["token"]
            refresh = exchange.get("refresh_token") or refresh
            token_exp = exchange.get("expired_at") or token_exp
            refresh_exp = exchange.get("refresh_expired_at") or refresh_exp
            client_id = exchange.get("client_id") or client_id
            host = exchange.get("host") or host
            user_id = exchange.get("user_id") or user_id
            user_info = exchange.get("user_info") or user_info
            region = exchange.get("region") or region
            ai_region = exchange.get("ai_region") or region

    if not token:
        return {}

    uid = user_id or ""
    return {
        "token": token,
        "refresh_token": refresh,
        "user_id": uid,
        "tenant_id": user_info.get("TenantID") or user_info.get("tenantId") or "",
        "region": region,
        "ai_region": ai_region,
        "host": host,
        "expired_at": str(token_exp) if token_exp else "",
        "refresh_expired_at": str(refresh_exp) if refresh_exp else "",
        "client_id": client_id,
        "web_id": user_info.get("WebId") or user_info.get("webId") or uid,
        "biz_user_id": user_info.get("BizUserId") or user_info.get("bizUserId") or uid,
        "user_unique_id": user_info.get("UserUniqueId") or user_info.get("userUniqueId") or uid,
        "scope": query.get("scope") or user_info.get("Scope") or user_info.get("scope") or "",
        "tenant": user_info.get("Tenant") or user_info.get("tenant") or "",
        "app_language": user_info.get("AppLanguage") or user_info.get("appLanguage") or "",
        "user_region": query.get("userRegion") or user_info.get("UserRegion") or user_info.get("userRegion") or "",
        "user_identity": user_info.get("UserIdentity") or user_info.get("userIdentity") or "",
        "screen_name": user_info.get("ScreenName") or user_info.get("screenName") or "",
    }

async def _exchange_refresh_token(refresh_token: str, client_id: str, host: str = "") -> dict:
    """使用 refreshToken 向 Trae CN 兑换 Cloud-IDE-JWT。

    与 Trae 官网实现一致:
      POST https://api.trae.cn/cloudide/api/v3/trae/oauth/ExchangeToken
      {"ClientID":..., "RefreshToken":..., "ClientSecret":"-", "UserID":""}
    """
    if not refresh_token:
        return {}
    base = host or "https://api.trae.cn"
    base = base.rstrip("/")
    url = base + "/cloudide/api/v3/trae/oauth/ExchangeToken"
    payload = {
        "ClientID": client_id,
        "RefreshToken": refresh_token,
        "ClientSecret": "-",
        "UserID": "",
    }
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.post(url, json=payload)
            body = resp.text
            status = resp.status_code
    except Exception as e:
        logger.warning("ExchangeToken failed: %s", e)
        return {}

    if status != 200:
        logger.warning("ExchangeToken HTTP %s: %s", status, body[:500])
        return {}

    result = _json_loads_safe(body)
    data = result.get("Result") or result.get("result") or result
    if not isinstance(data, dict):
        logger.warning("ExchangeToken unexpected result: %s", body[:500])
        return {}

    token = data.get("Token") or data.get("token") or data.get("AccessToken") or data.get("accessToken") or ""
    if not token:
        logger.warning("ExchangeToken missing Token: %s", body[:500])
        return {}

    refresh2 = data.get("RefreshToken") or data.get("refreshToken") or refresh_token
    user_info = _json_loads_safe(str(data.get("UserInfo") or data.get("userInfo") or ""))
    return {
        "token": token,
        "refresh_token": refresh2,
        "expired_at": str(data.get("TokenExpireAt") or data.get("tokenExpireAt") or ""),
        "refresh_expired_at": str(data.get("RefreshExpireAt") or data.get("refreshExpireAt") or ""),
        "client_id": data.get("ClientID") or data.get("clientId") or client_id,
        "host": host or base,
        "user_id": user_info.get("UserID") or user_info.get("userId") or data.get("UserID") or data.get("userId") or "",
        "user_info": user_info,
        "region": user_info.get("Region") or user_info.get("region") or data.get("Region") or data.get("region") or "CN",
        "ai_region": user_info.get("AIRegion") or user_info.get("aiRegion") or data.get("AIRegion") or data.get("aiRegion") or "",
    }


def _apply_parsed_creds(p: dict) -> None:
    """将解析后的凭证写入 auth 状态。"""
    auth.apply_oauth_callback(
        token=p.get("token", ""),
        refresh_token=p.get("refresh_token", ""),
        user_id=p.get("user_id", ""),
        tenant_id=p.get("tenant_id", ""),
        region=p.get("region", ""),
        ai_region=p.get("ai_region", ""),
        host=p.get("host", ""),
        expired_at=p.get("expired_at", ""),
        refresh_expired_at=p.get("refresh_expired_at", ""),
        client_id=p.get("client_id", ""),
        web_id=p.get("web_id", ""),
        biz_user_id=p.get("biz_user_id", ""),
        user_unique_id=p.get("user_unique_id", ""),
        scope=p.get("scope", ""),
        tenant=p.get("tenant", ""),
        app_language=p.get("app_language", ""),
        user_region=p.get("user_region", ""),
        user_identity=p.get("user_identity", ""),
        screen_name=p.get("screen_name", ""),
    )


APP_VERSION = "1.0.3"

# Icons and logo glyphs live in src/console/icons.py so the console package owns
# its own rendering. These aliases preserve the historical module attributes
# that tests and external importers read.
_LUCIDE_ICONS = console_icons.ICONS
_LOGO_PATHS = console_icons.LOGO_PATHS


def _icon(name: str, size: int = 24) -> str:
    return console_icons.icon(name, size)


def _etag_matches(header_value: Optional[str], etag: str) -> bool:
    """True when an If-None-Match header covers this ETag (weak-aware)."""
    if not header_value:
        return False
    if header_value.strip() == "*":
        return True
    def _bare(value: str) -> str:
        return value.strip().lstrip("W/").strip('"')
    candidate = _bare(etag)
    return any(_bare(item) == candidate for item in header_value.split(","))


def _console_assets_path() -> Path:
    """Directory holding the console static assets."""
    return Path(__file__).resolve().parent / "console" / "assets"


def _status_badge() -> str:
    s = auth.get_auth()
    if s.token and s.is_valid():
        return '<span class="badge badge-ok">\u5df2\u767b\u5f55</span>'
    if s.token:
        return '<span class="badge badge-expired">\u5df2\u8fc7\u671f</span>'
    return '<span class="badge badge-none">\u672a\u767b\u5f55</span>'


def _web_login_html() -> str:
    s = auth.get_auth()
    client_id = TRAE_CLIENT_ID
    listener_port = LOCAL_LISTENER_PORT
    auth_url = html_mod.escape(TRAE_AUTH_URL)
    state = s
    accounts = auth.list_accounts()
    polling = auth.get_polling_status()
    settings = auth.get_settings()
    auto_route_on = _auto_route_enabled()

    # Header status chips; the active-user chip is updated in place by JS.
    upstream_label = AUTO_ROUTE_MODE if auto_route_on else _current_upstream_mode()
    status_html = f"""
    <div class="status-chips">
      {_status_badge()}
      <span class="chip" title="凭据来源"><span class="chip-key">源</span><code>{html_mod.escape(state.source)}</code></span>
      <span class="chip" title="当前上游模式"><span class="chip-key">上游</span><code>{html_mod.escape(upstream_label)}</code></span>
      <span class="chip"><span class="chip-key">轮询</span><code>{'开' if polling.get('enabled') else '关'}</code></span>
    </div>"""

    # Consumption history is rendered in its own panel below the account list.
    usage_records_html = """
    <div id="usage-records-container" class="usage-records-container">
      <table class="usage-table">
        <thead>
          <tr>
            <th>时间</th>
            <th>账号</th>
            <th>模型</th>
            <th>思考强度</th>
            <th>上下文模式</th>
            <th>Max 模式</th>
            <th>Tool 参数</th>
            <th class="numeric">Tokens（入 / 出 / 总）</th>
            <th class="numeric">消耗积分</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody id="usage-records-body"></tbody>
      </table>
      <div id="usage-empty" class="usage-empty">暂无消费记录</div>
    </div>"""

    ic = {name: _icon(name) for name in _LUCIDE_ICONS}

    # 账号列表
    rows = ""
    stat_valid = 0
    stat_checked = 0
    stat_remaining = 0.0
    stat_known = False
    stat_unlimited = False
    for acc in accounts:
        if acc.get("is_valid"):
            st = '<span class="badge badge-ok">有效</span>'
            stat_valid += 1
        else:
            st = '<span class="badge badge-expired">无效</span>'
        act = (
            '<span class="badge badge-active" data-account-active>当前</span>'
            if acc.get("is_active")
            else '<span class="badge badge-active" data-account-active hidden>当前</span>'
        )
        active_row = "active-row" if acc.get("is_active") else ""
        switch_disabled = " disabled" if acc.get("is_active") else ""
        aid = html_mod.escape(acc.get("id") or "")
        model_enabled = bool(acc.get("model_enabled", True))
        model_checked = " checked" if model_enabled else ""
        model_badge = (
            '<span class="badge badge-ok" id="model-state-%s">已开启</span>'
            % aid
            if model_enabled
            else '<span class="badge badge-none" id="model-state-%s">已关闭</span>' % aid
        )
        label = html_mod.escape(acc.get("label") or acc.get("user_id") or acc.get("id") or "")
        uid = html_mod.escape(acc.get("user_id") or acc.get("id") or "")
        expires = html_mod.escape((acc.get("expires") or "")[:16])
        account_credits = acc.get("account_credits") or {}
        if account_credits.get("unlimited"):
            credits_text = "☆ 无限"
            stat_unlimited = True
        elif account_credits.get("remaining") is not None:
            remaining = float(account_credits["remaining"])
            credits_text = f"剩{remaining:.2f}/总{float(account_credits.get('total_limit') or 0):.2f}"
            stat_remaining += remaining
            stat_known = True
        else:
            credits_text = "-"
        checked_in = acc.get("checked_in")
        if checked_in is True:
            checkin_badge = '<span class="badge badge-ok">已签到</span>'
            stat_checked += 1
        elif checked_in is False:
            checkin_badge = '<span class="badge badge-active">未签到</span>'
        else:
            checkin_badge = '<span class="badge badge-none">未知</span>'
        valid_flag = "1" if acc.get("is_valid") else "0"
        rows += f"""<tr id="row-{aid}" class="{active_row}" data-account-id="{aid}" data-valid="{valid_flag}" data-model-enabled="{'1' if model_enabled else '0'}">
          <td><div class="acct-cell"><strong id="label-{aid}">{label}</strong><small class="row-subtitle mono">{uid}</small></div></td>
          <td class="status-cell">{st}{act}</td>
          <td class="muted-cell">{expires}</td>
          <td class="numeric"><span id="general-credits-{aid}" class="credit-value">{credits_text}</span></td>
          <td><span id="checkin-{aid}" class="checkin-state">{checkin_badge}</span><small id="checkin-detail-{aid}" class="row-subtitle"></small></td>
          <td class="model-toggle-cell"><div id="model-state-wrap-{aid}" class="model-toggle-state">{model_badge}</div><label class="switch account-model-switch" title="仅控制模型请求，不影响签到"><input type="checkbox" data-action="model-toggle" onchange="markAccountModelDirty('{aid}', this)" aria-label="启用账号模型请求"{model_checked}><span class="track"></span></label></td>
          <td class="row-actions">
            <button class="icon-btn" data-action="checkin" onclick="checkinAccount('{aid}')" title="签到" aria-label="签到">{ic['calendar-check']}</button>
            <button class="icon-btn" data-action="switch-account" onclick="switchAccount('{aid}')" title="切换为当前账号" aria-label="切换为当前账号"{switch_disabled}>{ic['arrow-left-right']}</button>
            <button class="icon-btn danger" onclick="removeAccount('{aid}')" title="删除账号" aria-label="删除账号">{ic['trash-2']}</button>
          </td>
        </tr>"""
    if accounts:
        accounts_html = f"""<div class="table-wrap">
          <table class="acct-table">
            <thead><tr><th>账号</th><th>状态</th><th>有效期</th><th class="numeric">通用积分</th><th>签到状态</th><th>模型请求</th><th class="actions-col">操作</th></tr></thead>
            <tbody>{rows}</tbody>
          </table>
        </div>"""
    else:
        accounts_html = '<div class="empty-state">暂无账号，请先授权登录或手动添加。</div>'
    # The toolbar stays in the DOM before the first login so the same script
    # handles an account list that becomes populated later.
    toolbar_hidden = "" if accounts else " hidden"
    stat_total = len(accounts)
    if stat_unlimited:
        stat_credits = "无限"
    elif stat_known:
        stat_credits = f"{stat_remaining:.2f}"
    else:
        stat_credits = "-"

    logout_btn = ''
    if state.token:
        logout_btn = f'<button class="icon-btn" onclick="logout()" title="登出" aria-label="登出">{ic["log-out"]}</button>'

    settings_web = (settings.get("web_base_url") or WEB_BASE).rstrip("/")
    settings_port = settings.get("relay_port") or os.environ.get("RELAY_PORT") or PORT
    # Remote/Work Agent and IDE Agent intentionally share upstream base URLs.
    # Select by mode as well as URL; URL-only matching can otherwise render a
    # different protocol after a reload.  IDE Raw is deliberately absent from
    # the public preset list because personal accounts consistently receive
    # ``2001 failed to get app config: record not found``; the raw transport
    # remains available only for internal protocol diagnostics.
    selected_endpoint_id = str(settings.get("endpoint_id") or "").strip().lower()
    selected_mode = str(
        settings.get("upstream_mode") or _current_upstream_mode() or ""
    ).strip().lower()
    selected_mode = {
        # Legacy values are kept readable in the settings store, but the
        # public UI no longer exposes the unsupported personal-account Raw
        # preset.  A stale raw selection is shown as custom until the user
        # explicitly chooses a supported endpoint.
        "direct": "raw",
        "auto": "raw",
        "9router": "remote",
        "trae-remote": "remote",
        "web": "remote",
    }.get(selected_mode, selected_mode)
    url_matches = [
        item
        for item in UPSTREAM_ENDPOINT_PRESETS
        if settings_web == str(item["base_url"]).rstrip("/")
    ]
    # Prefer the persisted preset identity.  Raw/IDE Agent and Remote/Work
    # Agent deliberately share URLs, so selecting by URL or by the first
    # matching mode can silently render the wrong option after a reload.
    matched_endpoint = next(
        (
            item
            for item in UPSTREAM_ENDPOINT_PRESETS
            if str(item.get("id") or "").strip().lower() == selected_endpoint_id
            and settings_web == str(item.get("base_url") or "").rstrip("/")
        ),
        None,
    )
    if matched_endpoint is None:
        matched_endpoint = next(
            (item for item in url_matches if item["mode"] == selected_mode),
            None,
        )
    if matched_endpoint is None and len(url_matches) == 1:
        matched_endpoint = url_matches[0]
    # Custom URLs that aren't in the preset list still appear as saved options.
    custom_is_saved = bool(settings.get("web_base_url")) and not matched_endpoint
    custom_selected = " selected" if not matched_endpoint else ""
    endpoint_options = [f'<option value=""{custom_selected}>自定义</option>']
    if custom_is_saved:
        endpoint_options.append(
            f'<option value="__saved" selected>{html_mod.escape(settings_web)}</option>'
        )
    for item in UPSTREAM_ENDPOINT_PRESETS:
        selected = " selected" if matched_endpoint and matched_endpoint["id"] == item["id"] else ""
        endpoint_options.append(
            f'<option value="{html_mod.escape(item["id"])}"{selected}>{html_mod.escape(item["label"])}</option>'
        )
    endpoint_options_html = "".join(endpoint_options)
    endpoint_map_json = json.dumps(
        {
            item["id"]: {
                "base_url": item["base_url"],
                "mode": item["mode"],
                "endpoint_url": item.get("endpoint_url") or item["base_url"],
                "endpoint_path": item.get("endpoint_path") or "",
            }
            for item in UPSTREAM_ENDPOINT_PRESETS
        },
        ensure_ascii=False,
    )
    poll_checked = 'checked' if polling.get("enabled") else ''
    poll_mode_rr = 'checked' if polling.get('mode', 'round-robin') == 'round-robin' else ''
    poll_mode_cp = 'checked' if polling.get('mode') == 'credit-priority' else ''
    max_settings = auth.get_max_mode_settings()
    max_checked = 'checked' if max_settings.get('enabled') else ''
    max_models = html_mod.escape(max_settings.get('models') or '')
    max_state_text = '已开启' if max_settings.get('enabled') else '已关闭'
    auto_route_checked = 'checked' if auto_route_on else ''
    auto_route_state_text = '已开启' if auto_route_on else '已关闭'
    auto_checkin = auth.get_auto_checkin_settings()
    auto_checkin_checked = 'checked' if auto_checkin.get('enabled') else ''
    auto_checkin_time = html_mod.escape(auto_checkin.get('time') or '08:30')
    poll_pill = ' on' if polling.get('enabled') else ''
    auto_route_pill = ' on' if auto_route_on else ''
    max_pill = ' on' if max_settings.get('enabled') else ''
    auto_checkin_pill = ' on' if auto_checkin.get('enabled') else ''
    auto_checkin_state_text = (
        f"每天 {auto_checkin_time} 自动签到" if auto_checkin.get('enabled') else '已关闭'
    )

    # The document is assembled by the console package; see src/console/page.py
    # for why placeholders replace f-string interpolation.
    return console_page.render_console(
        {
            "APP_VERSION": APP_VERSION,
            "status_html": status_html,
            "logout_btn": logout_btn,
            "accounts_html": accounts_html,
            "usage_records_html": usage_records_html,
            "endpoint_options_html": endpoint_options_html,
            "toolbar_hidden": toolbar_hidden,
            "stat_total": stat_total,
            "stat_valid": stat_valid,
            "stat_checked": stat_checked,
            "stat_credits": stat_credits,
            "listener_port": listener_port,
            "CLIENT_ID_ESC": html_mod.escape(client_id),
            "settings_web": settings_web,
            "SETTINGS_WEB_ESC": html_mod.escape(settings_web),
            "settings_port": settings_port,
            "POLL_ONOFF": "开" if polling.get("enabled") else "关",
            "POLL_ACCOUNT_COUNT": polling.get("account_count", 0),
            "poll_checked": poll_checked,
            "poll_mode_rr": poll_mode_rr,
            "poll_mode_cp": poll_mode_cp,
            "max_checked": max_checked,
            "max_models": max_models,
            "max_state_text": max_state_text,
            "max_pill": max_pill,
            "auto_route_checked": auto_route_checked,
            "auto_route_state_text": auto_route_state_text,
            "auto_route_pill": auto_route_pill,
            "auto_checkin_checked": auto_checkin_checked,
            "auto_checkin_time": auto_checkin_time,
            "auto_checkin_state_text": auto_checkin_state_text,
            "auto_checkin_pill": auto_checkin_pill,
            "bootstrap": {
                "version": APP_VERSION,
                "listenerPort": listener_port,
                "clientId": client_id,
                "authUrl": TRAE_AUTH_URL,
                "checkinInterval": CHECKIN_INTERVAL,
                "endpointMap": json.loads(endpoint_map_json),
            },
        }
    )


def _oauth_result_html(success: bool, message: str, login_trace_id: str = "") -> str:
    safe_msg = html_mod.escape(message)
    safe_trace = html_mod.escape(login_trace_id)
    return f"""<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>Trae 授权</title>{_FAVICON_LINKS}
<style>
body {{ font:16px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#eef0f4;color:#1d2331;padding:40px; }}
.msg {{ padding:20px;border-radius:10px;margin-bottom:16px;border:1px solid; }}
.ok {{ background:#e2f3eb;color:#0a7451;border-color:#bfe3d3; }}
.err {{ background:#fdecec;color:#dc2626;border-color:#f3c6c6; }}
</style>
</head>
<body>
<div class="msg {'ok' if success else 'err'}">
  <h2 style="margin:0 0 8px">{'成功' if success else '失败'}</h2>
  <p>{safe_msg}</p>
</div>
<script>
(function(){{
  // 授权回调由 Trae 授权页直接跳转到服务器 /authorize。
  // 成功后回到控制台自动刷新，失败则停留展示错误。
  if ({str(success).lower()}) {{
    setTimeout(function(){{ window.location.href = '/web/login'; }}, 1200);
  }}
}})();
</script>
</body>
</html>"""


async def _peek_async(ait):
    try:
        first = await ait.__anext__()
    except StopAsyncIteration:
        return None, ait

    async def chain():
        yield first
        async for item in ait:
            yield item

    return first, chain()


async def _empty_cli_events():
    if False:
        yield None


def _sse_headers() -> dict:
    return {
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
    }


def _stream_heartbeat_seconds() -> float:
    try:
        value = float(os.environ.get("SSE_HEARTBEAT_SECONDS", "1"))
    except (TypeError, ValueError):
        value = 1.0
    return max(0.0, value)


def _stream_error_event(response) -> str:
    """Turn a late upstream failure into an OpenAI-compatible SSE error."""
    raw = getattr(response, "body", b"")
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", errors="replace")
    try:
        payload = json.loads(raw or "{}")
    except Exception:
        payload = {}
    error = payload.get("error") if isinstance(payload, dict) else None
    if not isinstance(error, dict):
        error = {
            "message": str(payload or "Upstream stream failed"),
            "type": "api_error",
        }
    return "data: " + json.dumps({"error": error}, ensure_ascii=False) + "\n\n"


def _stream_start_event(model: str) -> str:
    """Send a parseable SSE frame while the first Trae frame is pending.

    A comment-only keepalive is legal SSE, but a few terminal clients treat it
    as an empty response and close/retry before the upstream request finishes.
    An empty OpenAI delta keeps those clients attached without exposing text or
    inventing a completion.

    The delta is deliberately empty: emitting ``role`` here would duplicate the
    translator's own opening frame, and the OpenAI stream contract carries the
    assistant role exactly once.
    """
    return (
        "data: "
        + json.dumps(
            {
                "id": "",
                "object": "chat.completion.chunk",
                "created": int(time.time()),
                "model": model,
                "choices": [
                    {
                        "index": 0,
                        "delta": {"content": ""},
                        "finish_reason": None,
                    }
                ],
            },
            ensure_ascii=False,
        )
        + "\n\n"
    )


async def _deferred_dispatch_stream(
    messages: list[dict], model: str, options: Optional[dict] = None
):
    """Open the public SSE stream before waiting for Trae's upstream headers.

    This keeps fallback routing intact because `_dispatch_chat` still performs
    the complete route selection in one task.  The task itself is awaited with
    keepalives, so a slow upstream cannot leave the client staring at a blank
    connection or freeze the event loop.
    """
    # Start routing before emitting any keepalive.  Some terminal clients
    # (notably zcode) treat a comment-only first frame as an empty cached
    # response and close the HTTP stream before asking for the next frame. The
    # old ordering created the upstream task *after* that first yield, so the
    # request could be cancelled without ever reaching Trae.
    options = _apply_auto_route(messages, options)
    requested_mode = str(
        options.get("_upstream_mode") or _current_upstream_mode()
    ).strip().lower()
    fallback_allowed = (
        not bool(options.get("_disable_upstream_fallback"))
        and requested_mode
        in {
            "raw",
            "direct",
            "auto",
            "ide",
            "solo",
            "work-agent",
            "traework-native",
            "native",
            "traework",
        }
    )
    fallback_attempted = False
    task = asyncio.create_task(_dispatch_chat(messages, model, True, options))
    dispatch_claimed = False
    response = None
    iterator = None
    request_id = str((options or {}).get("_relay_request_id") or "")
    started_at = time.monotonic()
    upstream_chunks = 0
    upstream_payload_chunks = 0
    saw_done = False
    stream_status = "opening"
    sent_start_event = False

    async def close_current() -> None:
        """Close the currently selected response/iterator before a retry."""

        nonlocal iterator, response
        if iterator is None:
            iterator = getattr(response, "body_iterator", None)
        if iterator is not None:
            close_iterator = getattr(iterator, "aclose", None)
            if close_iterator is not None:
                try:
                    await close_iterator()
                except Exception:
                    pass
            iterator = None
        close_response = getattr(response, "close", None)
        if close_response is not None:
            try:
                close_response()
            except Exception:
                pass
        response = None

    async def try_remote_fallback(reason: str):
        """Open one Remote stream after a native path fails before output."""

        nonlocal fallback_attempted, response
        if not fallback_allowed or fallback_attempted:
            return None
        fallback_attempted = True
        trace = options.get("_upstream_trace")
        _trace_append_failure(trace, requested_mode, reason)
        if isinstance(trace, dict):
            trace.update(
                fallback_used=True,
                fallback_target="remote",
            )
        fallback_options = _remote_fallback_options(options, requested_mode)
        logger.warning(
            "stream endpoint failed before output; falling back to remote "
            "id=%s requested_mode=%s reason=%s",
            request_id,
            requested_mode,
            reason,
        )
        try:
            fallback = await _dispatch_chat(
                messages, model, True, fallback_options
            )
        except Exception as exc:
            logger.warning(
                "stream remote fallback failed id=%s requested_mode=%s error=%s",
                request_id,
                requested_mode,
                exc,
            )
            return None
        if _upstream_response_error(fallback):
            logger.warning(
                "stream remote fallback returned error id=%s requested_mode=%s detail=%s",
                request_id,
                requested_mode,
                _upstream_response_error(fallback),
            )
            response = fallback
            await close_current()
            return None
        if isinstance(trace, dict):
            trace.update(
                actual_mode="remote",
                actual_endpoint="remote",
                fallback_used=True,
                fallback_target="remote",
            )
        return fallback

    async def forward_response(current_response):
        """Forward one StreamingResponse and propagate pre-output failures."""

        nonlocal iterator, upstream_chunks, upstream_payload_chunks
        nonlocal saw_done, stream_status, sent_start_event
        iterator = getattr(current_response, "body_iterator", None)
        if iterator is None:
            body = getattr(current_response, "body", b"")
            if body:
                yield body.decode("utf-8", errors="replace") if isinstance(body, bytes) else str(body)
            return
        async for chunk in iterator:
            if isinstance(chunk, bytes):
                chunk = chunk.decode("utf-8", errors="replace")
            if chunk:
                upstream_chunks += 1
                if any(
                    line.lstrip().startswith("data:")
                    for line in chunk.splitlines()
                ):
                    upstream_payload_chunks += 1
                if "data: [DONE]" in chunk:
                    saw_done = True
                    stream_status = "completed"
                if not sent_start_event and chunk.lstrip().startswith(":"):
                    yield _stream_start_event(model)
                    sent_start_event = True
                yield chunk

    async def close_dispatch() -> None:
        nonlocal response, iterator
        if not task.done():
            task.cancel()
        try:
            dispatched_response = await task
        except (asyncio.CancelledError, Exception):
            pass
        else:
            # Dispatch may have finished while the public stream was paused
            # at its initial frame, before it could take response ownership.
            if not dispatch_claimed:
                response = dispatched_response
        if iterator is None and response is not None:
            iterator = getattr(response, "body_iterator", None)
        await close_current()

    try:
        # Enter the selected transport before emitting the first keepalive,
        # while retaining ownership if cancellation occurs in this handoff.
        await asyncio.sleep(0)
        # The task may still be establishing the Trae request.  Emit one real
        # data frame before comment heartbeats so zcode/OpenCode does not treat
        # the stream as an empty cached response and cancel the task.
        if not task.done():
            yield _stream_start_event(model)
            sent_start_event = True
        interval = _stream_heartbeat_seconds()
        while True:
            try:
                if interval > 0:
                    response = await asyncio.wait_for(
                        asyncio.shield(task), interval
                    )
                else:
                    response = await task
                dispatch_claimed = True
                break
            except asyncio.TimeoutError:
                yield ": relay-keepalive\n\n"

        if getattr(response, "status_code", 200) >= 400:
            upstream_error = _upstream_response_error(response) or "http error"
            error_event = _stream_error_event(response)
            await close_current()
            fallback = await try_remote_fallback(
                upstream_error
            )
            if fallback is None:
                stream_status = "upstream_error"
                yield error_event
                yield "data: [DONE]\n\n"
                saw_done = True
                return
            response = fallback

        try:
            async for chunk in forward_response(response):
                yield chunk
        except (asyncio.CancelledError, GeneratorExit):
            raise
        except Exception as exc:
            if isinstance(exc, EmptyUpstreamResponse):
                _track_usage_from_exception(exc, model)
                if not exc.retryable or exc.observed_model_event:
                    raise
            # A StreamingResponse can be returned with HTTP 200 and fail only
            # when its body iterator starts (empty native SSE, invalid headers,
            # or a provider disconnect).  Retry Remote only before any native
            # payload has reached the caller; once partial output is visible we
            # preserve that stream and surface the original failure.
            if upstream_payload_chunks or fallback_attempted:
                raise
            await close_current()
            fallback = await try_remote_fallback(str(exc))
            if fallback is None:
                raise
            response = fallback
            async for chunk in forward_response(response):
                yield chunk
        stream_status = "completed"
    except asyncio.CancelledError:
        if saw_done:
            # The upstream already emitted [DONE]; a client disconnecting
            # during final teardown is not an aborted model turn.
            stream_status = "completed"
            logger.info(
                "public stream cancelled after done id=%s chunks=%d elapsed_ms=%d",
                request_id,
                upstream_chunks,
                int((time.monotonic() - started_at) * 1000),
            )
        else:
            stream_status = "client_cancelled"
            logger.warning(
                "public stream cancelled id=%s upstream_ready=%s task_done=%s chunks=%d elapsed_ms=%d",
                request_id,
                response is not None,
                task.done(),
                upstream_chunks,
                int((time.monotonic() - started_at) * 1000),
            )
        raise
    except GeneratorExit:
        stream_status = "client_closed" if not saw_done else "completed"
        raise
    except Exception as exc:
        stream_status = "error"
        _track_usage_from_exception(exc, model)
        logger.warning("deferred stream dispatch failed: %s", exc)
        yield "data: " + json.dumps(
            {"error": {"message": str(exc), "type": "api_error"}},
            ensure_ascii=False,
        ) + "\n\n"
        yield "data: [DONE]\n\n"
        saw_done = True
    finally:
        await _await_session_cleanup(asyncio.create_task(close_dispatch()))
        logger.info(
            "public stream closed id=%s status=%s chunks=%d done=%s elapsed_ms=%d",
            request_id,
            stream_status,
            upstream_chunks,
            saw_done,
            int((time.monotonic() - started_at) * 1000),
        )


def _tool_translation_options(
    options: Optional[dict], messages: Optional[list[dict]] = None
) -> dict:
    options = options or {}
    has_explicit_catalog = "tools" in options or "_inherited_tools" in options
    tool_catalog = (
        options["tools"]
        if "tools" in options
        else options.get("_inherited_tools", [])
    )
    # TraeWork's custom-model adapter owns the local toolhost and its raw
    # six-field request normally has no OpenAI ``tools`` array.  Passing an
    # empty list to the OpenAI translator means "suppress every tool call";
    # for this ingress that would turn a valid model tool request into plain
    # text and the desktop client could never execute it.  ``None`` preserves
    # the caller-owned protocol and lets the custom SSE adapter forward calls
    # parsed from native fields or the XML marker in the model response.
    if options.get("_traework_custom_model") and not has_explicit_catalog:
        tool_catalog = None
    return {
        # API callers execute tools. With no tools field, suppress any internal
        # Trae tool event instead of exposing a call the client cannot handle.
        "allowed_tools": tool_catalog,
        "tool_choice": options.get("tool_choice"),
        "parallel_tool_calls": options.get("parallel_tool_calls"),
        # Keep reasoning presentation separate from the raw upstream request.
        # ``thinking`` is intentionally consumed only by the translators.
        "include_reasoning": responses_api.thinking_requested(options),
        # Protect the continuation turn from an upstream model that echoes an
        # already completed call with a fresh id. A new user message after the
        # result clears this set in cli_client.completed_tool_signatures().
        "completed_tool_signatures": cli_client.completed_tool_signatures(
            messages or []
        ),
    }


def _tool_protocol_requested(
    options: Optional[dict], messages: Optional[list[dict]] = None
) -> bool:
    options = options or {}
    if options.get("_tool_protocol_requested") or any(
        key in options for key in ("tools", "tool_choice", "parallel_tool_calls")
    ):
        return True
    return any(
        isinstance(message, dict) and _message_contains_tool_protocol(message)
        for message in (messages or [])
    )


def _message_contains_tool_protocol(message: Mapping[str, Any]) -> bool:
    """Detect OpenAI and TraeWork renderer tool messages in request history.

    TraeWork does not always use an OpenAI ``role=tool`` message. Its renderer
    serializes calls/results as ``tool_use``/``tool_result`` content blocks,
    with results commonly carried by a ``role=user`` message. Those turns
    still require the tool-aware runtime prompt and the raw-safe route.
    """

    role = str(message.get("role") or "").strip().lower()
    if role in {"tool", "function"}:
        return True
    if role == "assistant" and (
        (isinstance(message.get("tool_calls"), list) and bool(message["tool_calls"]))
        or isinstance(message.get("function_call"), Mapping)
    ):
        return True
    content = message.get("content")
    if not isinstance(content, list):
        return False
    return any(
        isinstance(block, Mapping)
        and str(block.get("type") or "").strip().lower()
        in {"tool_use", "tool_call", "function_call", "tool_result"}
        for block in content
    )


def _with_auto_client_context(
    req: Request,
    body: Mapping[str, Any],
    messages: list[dict],
    options: dict,
) -> dict:
    """Infer caller environment and plugin catalog when the client omitted it."""

    if not _tool_protocol_requested(options, messages):
        return options
    if "client_context" in options or "clientContext" in options:
        return options
    # OpenAI clients commonly send `metadata`, while new-api's Responses DTO
    # preserves the equivalent caller hints under `client_metadata`.
    metadata = body.get("client_metadata") or body.get("metadata")
    metadata = metadata if isinstance(metadata, Mapping) else {}
    enriched = dict(options)
    enriched["client_context"] = raw_client.build_client_context(
        enriched,
        request_headers=dict(req.headers),
        metadata=metadata,
    )
    return enriched


def _request_session_hint(req: Request, body: Mapping[str, Any]) -> str:
    """Read common conversation-id aliases without exposing them downstream."""
    for key in ("session_id", "sessionId", "conversation_id", "conversationId"):
        value = body.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    metadata = body.get("client_metadata") or body.get("metadata")
    if isinstance(metadata, Mapping):
        for key in ("session_id", "sessionId", "conversation_id", "conversationId"):
            value = metadata.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    for key in (
        "x-session-id",
        "x-conversation-id",
        "x-chat-session-id",
        "conversation-id",
    ):
        value = req.headers.get(key)
        if value and value.strip():
            return value.strip()
    return ""


def _apply_tool_header_hints(req: Request, options: dict) -> dict:
    """Accept optional tool-policy hints used by nonstandard terminal clients.

    OpenAI places tool definitions in JSON, not headers. Some adapters still
    send a small ``Tool``/``X-Tools`` hint; treat it as a routing signal and,
    when it contains JSON, restore the same options that would have appeared in
    the request body. Arbitrary client headers are never forwarded upstream.
    """

    enriched = dict(options)
    saw_hint = False
    for header in ("tools", "tool", "x-tools", "x-tool"):
        value = req.headers.get(header)
        if not value:
            continue
        saw_hint = True
        if "tools" in enriched:
            continue
        try:
            parsed = json.loads(value)
        except (TypeError, json.JSONDecodeError):
            continue
        if isinstance(parsed, list):
            enriched["tools"] = parsed
    for header in ("tool-choice", "x-tool-choice"):
        value = req.headers.get(header)
        if not value:
            continue
        saw_hint = True
        if "tool_choice" in enriched:
            continue
        try:
            enriched["tool_choice"] = json.loads(value)
        except (TypeError, json.JSONDecodeError):
            enriched["tool_choice"] = value
    for header in ("parallel-tool-calls", "x-parallel-tool-calls"):
        value = req.headers.get(header)
        if not value:
            continue
        saw_hint = True
        if "parallel_tool_calls" not in enriched:
            enriched["parallel_tool_calls"] = value.strip().lower() in {
                "1", "true", "yes", "on",
            }
    if saw_hint:
        enriched["_tool_protocol_requested"] = True
    return enriched


def _chat_history_key(messages: list[dict], length: int | None = None) -> str:
    selected = messages if length is None else messages[:length]
    encoded = json.dumps(
        selected,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _chat_has_prior_turn(messages: list[dict]) -> bool:
    return any(
        isinstance(message, dict)
        and message.get("role") in {"assistant", "tool", "function"}
        for message in messages
    )


def _prune_chat_sessions(now: float) -> None:
    cutoff = now - _CHAT_SESSION_TTL
    while _CHAT_HISTORY_SESSIONS:
        key, (_session_id, touched) = next(iter(_CHAT_HISTORY_SESSIONS.items()))
        if touched >= cutoff and len(_CHAT_HISTORY_SESSIONS) <= _CHAT_SESSION_MAX:
            break
        _CHAT_HISTORY_SESSIONS.pop(key, None)

    for session_id, lease in list(_UPSTREAM_SESSION_LEASES.items()):
        expired = lease.last_client_activity < cutoff
        oversized = len(_UPSTREAM_SESSION_LEASES) > _CHAT_SESSION_MAX
        if lease.active_streams or (not expired and not oversized):
            continue
        _UPSTREAM_SESSION_LEASES.pop(session_id, None)
        for key, (history_session_id, _touched) in list(
            _CHAT_HISTORY_SESSIONS.items()
        ):
            if history_session_id == session_id:
                _CHAT_HISTORY_SESSIONS.pop(key, None)


def _touch_chat_session(session_id: str, now: Optional[float] = None) -> None:
    """Record client activity without looking up or refreshing authentication."""

    if not session_id:
        return
    now = time.monotonic() if now is None else now
    with _CHAT_SESSION_LOCK:
        lease = _UPSTREAM_SESSION_LEASES.get(session_id)
        if lease is None:
            return
        lease.last_client_activity = now
        _UPSTREAM_SESSION_LEASES.move_to_end(session_id)
        for key, (history_session_id, _touched) in list(
            _CHAT_HISTORY_SESSIONS.items()
        ):
            if history_session_id == session_id:
                _CHAT_HISTORY_SESSIONS[key] = (session_id, now)
                _CHAT_HISTORY_SESSIONS.move_to_end(key)


def _capture_chat_session_auth(session_id: str, token: str) -> None:
    """Persist the token obtained on a first turn for later continuations."""

    if not session_id or not token:
        return
    with _CHAT_SESSION_LOCK:
        lease = _UPSTREAM_SESSION_LEASES.get(session_id)
        if lease is not None and not lease.auth_token:
            lease.auth_token = token
    _touch_chat_session(session_id)


def _rebind_chat_session_account(
    session_id: str,
    account_id: str,
    billing_id: str,
    token: str,
    provider_specific: Optional[Mapping[str, Any]] = None,
) -> None:
    """Keep the relay session lease aligned with a retry account."""

    if not session_id:
        return
    with _CHAT_SESSION_LOCK:
        lease = _UPSTREAM_SESSION_LEASES.get(session_id)
        if lease is None:
            return
        lease.account_id = str(account_id or lease.account_id)
        lease.billing_id = str(billing_id or lease.billing_id or lease.account_id)
        lease.auth_token = str(token or lease.auth_token)
        if provider_specific is not None:
            lease.provider_specific = dict(provider_specific)
        lease.last_client_activity = time.monotonic()
        _UPSTREAM_SESSION_LEASES.move_to_end(session_id)


def _begin_chat_stream(session_id: str) -> None:
    if not session_id:
        return
    with _CHAT_SESSION_LOCK:
        lease = _UPSTREAM_SESSION_LEASES.get(session_id)
        if lease is None:
            return
        lease.active_streams += 1
    _touch_chat_session(session_id)


def _end_chat_stream(session_id: str) -> None:
    if not session_id:
        return
    with _CHAT_SESSION_LOCK:
        lease = _UPSTREAM_SESSION_LEASES.get(session_id)
        if lease is None:
            return
        lease.active_streams = max(0, lease.active_streams - 1)
    _touch_chat_session(session_id)


async def _lease_stream(source, session_id: str):
    """Keep the session lease alive while the API client consumes an SSE body."""

    _begin_chat_stream(session_id)
    try:
        async for chunk in source:
            _touch_chat_session(session_id)
            yield chunk
    finally:
        _end_chat_stream(session_id)


async def _reap_idle_chat_sessions() -> int:
    now = time.monotonic()
    with _CHAT_SESSION_LOCK:
        before = len(_UPSTREAM_SESSION_LEASES)
        _prune_chat_sessions(now)
        return before - len(_UPSTREAM_SESSION_LEASES)


def _bind_chat_session(
    messages: list[dict],
    options: dict,
    *,
    requested_session_id: str = "",
    rotate_for_new: bool = True,
) -> dict:
    """Attach a stable upstream session and account to one API request."""
    now = time.monotonic()
    with _CHAT_SESSION_LOCK:
        _prune_chat_sessions(now)
        session_id = requested_session_id.strip()
        inferred_account_snapshot: tuple[str, dict] | None = None
        if not session_id and _chat_has_prior_turn(messages):
            # Capture the currently selected account once for an inferred
            # replay. This both makes the account comparison atomic and lets a
            # manual account switch take effect without consulting the mutable
            # legacy getters separately.
            inferred_account_snapshot = auth.get_active_account_snapshot()
            # Prefer the most specific known prefix, then fall back to the full
            # replay for idempotent retries of the same request.
            for length in range(len(messages), 0, -1):
                found = _CHAT_HISTORY_SESSIONS.get(_chat_history_key(messages, length))
                if found is not None:
                    candidate_id = found[0]
                    candidate_lease = _UPSTREAM_SESSION_LEASES.get(candidate_id)
                    # A client that switched accounts and then replayed a full
                    # OpenAI history without a relay session id must start a
                    # fresh upstream conversation. Explicit session ids (used
                    # by Responses continuation) bypass this branch and keep
                    # their original credential by design.
                    active_account = str(
                        (inferred_account_snapshot or ("", {}))[0] or ""
                    )
                    if (
                        active_account
                        and candidate_lease is not None
                        and candidate_lease.account_id
                        and candidate_lease.account_id != active_account
                    ):
                        continue
                    session_id = candidate_id
                    _CHAT_HISTORY_SESSIONS.move_to_end(_chat_history_key(messages, length))
                    break
        if not session_id:
            session_id = uuid_mod.uuid4().hex

        lease = _UPSTREAM_SESSION_LEASES.get(session_id)
        if lease is None:
            if rotate_for_new and _current_upstream_mode() in (
                "raw",
                "direct",
                "web",
                "remote",
                "9router",
                "trae-remote",
                "auto",
                "ide",
                "solo",
                "work-agent",
            ):
                auth.next_polling_account()
            # Read the selected id and its credential record as one snapshot.
            # Separate getter calls can race an account rotation and bind an
            # account id to a different account's token.
            if inferred_account_snapshot is not None and not bool(
                auth.get_polling_status().get("enabled")
            ):
                account_id, record = inferred_account_snapshot
            else:
                account_id, record = auth.get_active_account_snapshot()
            # A disabled account may remain selected for check-in management.
            # New sessions can select another enabled account; continuations
            # keep their credential and are refused while it is disabled.
            if not account_id or not auth._record_model_enabled(record):
                account_id, record = auth.get_model_account_snapshot()
            # Keep compatibility with integrations/tests that replace the
            # legacy getters while still preferring the atomic snapshot in
            # normal operation.
            if not account_id:
                # An account store with no eligible rows must not fall back to
                # the management-selected (possibly disabled) credential.
                if auth.get_accounts_raw():
                    raise _ModelAccountUnavailable(
                        "No enabled model account available; enable an account in "
                        "账号与签到"
                    )
                account_id = auth.get_active_account_id() or ""
            if account_id and not record:
                record = auth.get_account_record(account_id)
            _ensure_model_account_enabled(account_id, str(record.get("token") or ""))
            token = str(record.get("token") or "")
            if not token and not account_id:
                # Preserve the CLI/env single-credential path when the
                # account store is empty.  Once accounts are stored, an
                # all-disabled state must fail explicitly instead of silently
                # bypassing the per-account switch.
                if auth.get_accounts_raw():
                    raise _ModelAccountUnavailable(
                        "No enabled model account available; enable an account in "
                        "账号与签到"
                    )
                token = str(auth.get_token() or "")
            billing_id = _account_id_from_token(token) or account_id
            lease = _UpstreamSessionLease(
                account_id=account_id,
                billing_id=billing_id,
                auth_token=token,
                last_client_activity=now,
                provider_specific=dict(
                    record.get("provider_specific")
                    or record.get("providerSpecificData")
                    or {}
                ),
            )
            _UPSTREAM_SESSION_LEASES[session_id] = lease
        else:
            # A continuation must stay on the credential captured for its first
            # turn. Do not rotate accounts, call refresh, or mutate global auth.
            _ensure_model_account_enabled(lease.account_id, lease.auth_token)
            lease.last_client_activity = now
            _UPSTREAM_SESSION_LEASES.move_to_end(session_id)

        _CHAT_HISTORY_SESSIONS[_chat_history_key(messages)] = (session_id, now)
        _CHAT_HISTORY_SESSIONS.move_to_end(_chat_history_key(messages))

    bound = dict(options)
    bound["session_id"] = session_id
    if lease.account_id:
        bound["_account_id"] = lease.account_id
        if _current_upstream_mode() in ("raw", "direct", "auto"):
            bound["_auth_user_id"] = lease.billing_id or lease.account_id
    if lease.billing_id:
        bound["_billing_id"] = lease.billing_id
    if lease.auth_token:
        bound["_auth_token"] = lease.auth_token
    if _current_upstream_mode() != "cli":
        # Keep account metadata pinned with the credential. The global auth
        # state may switch before the remote request has built its headers.
        # An explicit empty mapping prevents fallback to another account's
        # mutable global metadata.
        bound["provider_specific"] = dict(lease.provider_specific)
    return bound


def _validate_chat_options(options: dict) -> Optional[JSONResponse]:
    """Validate the OpenAI tool surface before choosing an upstream route."""

    tool_names: set[str] = set()
    if "tools" in options:
        tools = options["tools"]
        if not isinstance(tools, list):
            return _openai_error(
                400, "tools must be an array", "invalid_request_error", "tools"
            )
        normalized_tools = []
        for index, tool in enumerate(tools):
            param = f"tools.{index}"
            if not isinstance(tool, dict) or tool.get("type") != "function":
                return _openai_error(
                    400,
                    f"{param} must be an OpenAI function tool",
                    "invalid_request_error",
                    param,
                )
            function = tool.get("function")
            if not isinstance(function, dict):
                # Accept the compact Responses-style flat tool shape and
                # normalize it to the Chat-completions nested function shape.
                function = {
                    key: tool.get(key)
                    for key in ("name", "description", "parameters", "strict")
                    if key in tool
                }
            name = function.get("name")
            if not isinstance(name, str) or not name.strip():
                return _openai_error(
                    400,
                    f"{param}.function.name must be a non-empty string",
                    "invalid_request_error",
                    f"{param}.function.name",
                )
            if name in tool_names:
                return _openai_error(
                    400,
                    f"Duplicate tool name: {name}",
                    "invalid_request_error",
                    f"{param}.function.name",
                )
            parameters = function.get("parameters")
            if parameters is not None and not isinstance(parameters, dict):
                return _openai_error(
                    400,
                    f"{param}.function.parameters must be an object",
                    "invalid_request_error",
                    f"{param}.function.parameters",
                )
            tool_names.add(name)
            normalized_tools.append({"type": "function", "function": dict(function)})
        if normalized_tools:
            options["tools"] = normalized_tools

    if "tool_choice" in options:
        tool_choice = options["tool_choice"]
        if isinstance(tool_choice, str):
            if tool_choice not in ("none", "auto", "required"):
                return _openai_error(
                    400,
                    "tool_choice must be none, auto, required, or a named function",
                    "invalid_request_error",
                    "tool_choice",
                )
            if tool_choice == "required" and not tool_names:
                return _openai_error(
                    400,
                    "tool_choice=required requires at least one tool",
                    "invalid_request_error",
                    "tool_choice",
                )
        elif isinstance(tool_choice, dict):
            function = tool_choice.get("function")
            if not isinstance(function, dict):
                # Accept the compact Responses-style flat tool_choice shape too.
                function = tool_choice
            name = function.get("name") if isinstance(function, dict) else None
            if tool_choice.get("type") != "function" or not isinstance(name, str):
                return _openai_error(
                    400,
                    "tool_choice must select a named function",
                    "invalid_request_error",
                    "tool_choice",
                )
            if name not in tool_names:
                return _openai_error(
                    400,
                    f"tool_choice references undeclared tool: {name}",
                    "invalid_request_error",
                    "tool_choice",
                )
            options["tool_choice"] = {"type": "function", "function": {"name": name}}
        else:
            return _openai_error(
                400,
                "tool_choice must be a string or object",
                "invalid_request_error",
                "tool_choice",
            )

    if "parallel_tool_calls" in options and not isinstance(
        options["parallel_tool_calls"], bool
    ):
        return _openai_error(
            400,
            "parallel_tool_calls must be a boolean",
            "invalid_request_error",
            "parallel_tool_calls",
        )

    for key in ("client_context", "clientContext"):
        if key in options and not isinstance(options[key], dict):
            return _openai_error(
                400,
                f"{key} must be an object",
                "invalid_request_error",
                key,
            )

    alias_pairs = (
        ("client_context", "clientContext"),
        ("session_id", "sessionId"),
        ("max_tokens", "maxTokens"),
    )
    for canonical, alias in alias_pairs:
        if canonical in options and alias in options and options[canonical] != options[alias]:
            return _openai_error(
                400,
                f"{canonical} and {alias} must not conflict",
                "invalid_request_error",
                canonical,
            )

    for key in ("session_id", "sessionId"):
        if key in options:
            value = options[key]
            if (
                not isinstance(value, str)
                or not value.strip()
                or len(value) > 256
                or "\x00" in value
            ):
                return _openai_error(
                    400,
                    f"{key} must be a non-empty string of at most 256 characters",
                    "invalid_request_error",
                    key,
                )

    for key in ("max_tokens", "maxTokens", "max_completion_tokens"):
        if key in options:
            value = options[key]
            if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
                return _openai_error(
                    400,
                    f"{key} must be a positive integer",
                    "invalid_request_error",
                    key,
                )
    return None


def _number_value(value: Any) -> int | float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return max(0, value)



def _credit_round(value: int | float | None) -> int | float | None:
    """Round credit values to 2 decimal places for consistent display."""
    if value is None:
        return None
    try:
        return round(float(value), 2)
    except (TypeError, ValueError):
        return None

def _first_number(data: Mapping[str, Any], *keys: str) -> int | float | None:
    for key in keys:
        value = _number_value(data.get(key))
        if value is not None:
            return value
    return None


def _usage_values(usage: Any) -> dict[str, Any]:
    if not isinstance(usage, Mapping):
        return {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
            "cached_tokens": 0,
            "credits_consumed": None,
        }
    prompt = _first_number(
        usage, "prompt_tokens", "input_tokens", "input_token", "inputTokens"
    ) or 0
    completion = _first_number(
        usage,
        "completion_tokens",
        "output_tokens",
        "output_token",
        "outputTokens",
    ) or 0
    total = _first_number(usage, "total_tokens", "total_token", "totalTokens")
    if total is None:
        total = prompt + completion
    credits = _first_number(
        usage,
        "credits_consumed",
        "consumed_credits",
        "credit_cost",
        "credits_cost",
        "credits_float",
    )
    billing = usage.get("billing") or usage.get("cost")
    if credits is None and isinstance(billing, Mapping):
        credits = _first_number(
            billing,
            "credits_consumed",
            "consumed_credits",
            "credit_cost",
            "credits_cost",
            "credits_float",
        )
    cached = _first_number(
        usage,
        "cached_tokens",
        "cache_read_tokens",
        "cacheReadTokens",
        "cachedTokens",
        "cache_read_input_tokens",
    )
    for details_key in ("prompt_tokens_details", "input_tokens_details"):
        details = usage.get(details_key)
        if cached is None and isinstance(details, Mapping):
            cached = _first_number(details, "cached_tokens", "cache_read_tokens")
    return {
        "prompt_tokens": int(prompt),
        "completion_tokens": int(completion),
        "total_tokens": int(total),
        "cached_tokens": int(cached or 0),
        "credits_consumed": credits,
    }


def _optional_bool(value: Any) -> bool | None:
    """Normalize persisted/request metadata without guessing missing values."""

    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return bool(value)
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on", "enabled", "是", "有"}:
            return True
        if normalized in {"0", "false", "no", "off", "disabled", "否", "无"}:
            return False
    return None


def _context_mode_bool(value: Any) -> bool | None:
    """Map known context labels to a Max-enabled boolean.

    Unknown labels stay ``None`` instead of being guessed as standard.  This
    matters when normalizing old records written by a custom adapter.
    """

    if value in (None, ""):
        return None
    normalized = str(value).strip().lower().replace("-", "_").replace(" ", "")
    if normalized in {"max", "max_1m", "max1m", "1m", "1000000", "agent_max", "max_mode"}:
        return True
    if normalized in {
        "standard",
        "default",
        "work",
        "dev",
        "200k",
        "200000",
        "normal",
    }:
        return False
    return None


def _option_flag(value: Any) -> bool:
    """Return a strict truth value for request flags."""

    return _optional_bool(value) is True


def _tool_catalog_has_entries(value: Any) -> bool:
    if isinstance(value, Mapping):
        return bool(value)
    if isinstance(value, (list, tuple, set)):
        return bool(value)
    return value not in (None, "", False)


def _tools_requested_from_options(options: Optional[Mapping[str, Any]]) -> bool:
    """Whether this request carries a caller tool protocol.

    ``_tool_protocol_requested`` can also be set for a continuation that only
    carries tool history.  An explicit ``tools=[]`` remains false unless an
    inherited catalog or a tool choice says otherwise.
    """

    options = options or {}
    # An explicit catalog, including ``tools=[]``, owns this turn.  Do not
    # revive a previous Responses catalog from ``_inherited_tools`` when the
    # caller intentionally supplied an empty tools array.
    if "tools" in options:
        return _tool_catalog_has_entries(options.get("tools"))
    if _tool_catalog_has_entries(options.get("_inherited_tools")):
        return True
    if "_inherited_tools" not in options:
        if _option_flag(options.get("_tool_protocol_requested")):
            return True
    choice = options.get("tool_choice")
    if choice not in (None, "", "none", False):
        return True
    return False


def _requested_reasoning_effort(options: Optional[Mapping[str, Any]]) -> str | None:
    """Extract the caller-facing thinking strength without normalizing labels."""

    options = options or {}
    for key in ("reasoning_effort", "reasoningEffort", "thinking_effort"):
        value = options.get(key)
        if value not in (None, ""):
            return str(value).strip() or None
    reasoning = options.get("reasoning")
    if isinstance(reasoning, Mapping):
        value = reasoning.get("effort") or reasoning.get("level")
        if value not in (None, ""):
            return str(value).strip() or None
    thinking = options.get("thinking")
    if isinstance(thinking, Mapping):
        value = (
            thinking.get("effort")
            or thinking.get("level")
            or thinking.get("budget_tokens")
            or thinking.get("budgetTokens")
        )
        if value not in (None, ""):
            return str(value).strip() or None
        if _option_flag(thinking.get("enabled")) or _option_flag(thinking.get("enable")):
            return "enabled"
    elif thinking not in (None, "", False):
        return "enabled"
    return None


def _context_mode_metadata(
    options: Optional[Mapping[str, Any]],
) -> tuple[str | None, str | None, int | float | None, bool | None]:
    """Return requested/actual context mode and its known token window."""

    options = options or {}
    trace = options.get("_upstream_trace")
    trace = trace if isinstance(trace, Mapping) else {}
    if "trae_max_mode" in options:
        requested_max = _option_flag(options["trae_max_mode"])
    elif "max_mode" in options:
        requested_max = _option_flag(options["max_mode"])
    else:
        requested_max = bool(auth.get_max_mode_settings().get("enabled"))
    applied_marker = trace.get("max_mode_applied") if "max_mode_applied" in trace else None
    applied_max = _optional_bool(applied_marker)
    requested = "max_1m" if requested_max else "standard"
    actual = (
        "max_1m"
        if applied_max is True
        else "standard"
        if applied_max is False
        # A request that explicitly/defaults to standard has no separate
        # upstream max acknowledgement to wait for.  Keep ordinary requests
        # useful in the console while preserving "unknown" for a requested
        # Max turn whose upstream trace never confirmed the mode.
        else "standard"
        if not requested_max
        else None
    )
    window = _number_value(trace.get("max_context_tokens"))
    if window is None and applied_max is True:
        window = 1_000_000
    return requested, actual, window, applied_max


def _tool_call_count(value: Any) -> int:
    """Count structured tool calls in one translated model payload."""

    if not isinstance(value, Mapping):
        return 0
    value_type = str(value.get("type") or "").strip().lower()
    if value_type in {
        "function_call",
        "custom_tool_call",
        "tool_call",
        "tool_use",
    }:
        return 1
    count = 0
    calls = value.get("tool_calls")
    if isinstance(calls, list):
        count += sum(1 for item in calls if isinstance(item, Mapping))
    elif isinstance(calls, Mapping):
        count += 1
    if isinstance(value.get("function_call"), Mapping):
        count += 1
    for key in ("message", "delta", "output", "response", "item", "items", "content"):
        nested = value.get(key)
        if isinstance(nested, Mapping):
            count += _tool_call_count(nested)
        elif isinstance(nested, list):
            count += sum(_tool_call_count(item) for item in nested)
    choices = value.get("choices")
    if isinstance(choices, list):
        count += sum(_tool_call_count(item) for item in choices)
    return count


def _request_account_identity() -> tuple[str, str]:
    token = auth.get_token() or ""
    token_identity = _account_id_from_token(token)
    if token_identity:
        return token_identity, token
    account_id = (
        auth.get_active_account_id()
        or auth.get_user_id()
        or token[:16]
        or "default"
    )
    return str(account_id), token


def _account_id_from_token(token: str) -> str:
    """Extract the immutable Trae account id carried by a JWT, if present."""

    raw_token = str(token or "").strip()
    if not raw_token:
        return ""
    try:
        parts = raw_token.split(".")
        if len(parts) < 2:
            return ""
        encoded = parts[1] + "=" * (-len(parts[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(encoded.encode("ascii")))
    except (ValueError, TypeError, UnicodeError, binascii.Error, json.JSONDecodeError):
        return ""
    if not isinstance(payload, Mapping):
        return ""
    data = payload.get("data")
    if isinstance(data, Mapping):
        for key in ("id", "user_id", "userId", "sub"):
            value = data.get(key)
            if value not in (None, ""):
                return str(value)
    for key in ("user_id", "userId", "sub"):
        value = payload.get(key)
        if value not in (None, ""):
            return str(value)
    return ""


async def _fetch_used_credits(token: str) -> int | float | None:
    if not token:
        return None
    try:
        raw = await trae_client.fetch_account_total_credits(token)
        parsed = trae_client.parse_account_credits(raw)
        return _number_value(parsed.get("used"))
    except Exception as exc:
        logger.debug("usage credit snapshot unavailable: %s", exc)
        return None


def _begin_credit_snapshot(account_id: str, token: str) -> bool:
    if not account_id or account_id == "default" or not token:
        return False
    with _USAGE_LOCK:
        active = _USAGE_ACTIVE_ACCOUNTS.get(account_id, 0)
        if active:
            _USAGE_UNSAFE_ACCOUNTS.add(account_id)
        _USAGE_ACTIVE_ACCOUNTS[account_id] = active + 1
        # A delta is only attributable when this account has one request in
        # flight. Concurrent calls share the same upstream counter.
        return active == 0


def _end_credit_snapshot(account_id: str) -> None:
    if not account_id:
        return
    with _USAGE_LOCK:
        active = _USAGE_ACTIVE_ACCOUNTS.get(account_id, 0)
        if active <= 1:
            _USAGE_ACTIVE_ACCOUNTS.pop(account_id, None)
            _USAGE_UNSAFE_ACCOUNTS.discard(account_id)
        else:
            _USAGE_ACTIVE_ACCOUNTS[account_id] = active - 1


def _credit_snapshot_is_safe(account_id: str) -> bool:
    with _USAGE_LOCK:
        return account_id not in _USAGE_UNSAFE_ACCOUNTS


def _spawn_usage_task(
    coro,
    registry: set[asyncio.Task] | None = None,
) -> asyncio.Task:
    registry = registry if registry is not None else _USAGE_ENRICH_TASKS
    task = asyncio.create_task(coro)
    registry.add(task)

    def done(completed: asyncio.Task) -> None:
        registry.discard(completed)
        try:
            completed.result()
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            logger.debug("usage enrichment failed: %s", exc)

    task.add_done_callback(done)
    return task


async def _cancel_usage_task(
    task: asyncio.Task | None,
    registry: set[asyncio.Task] | None = None,
) -> None:
    """Cancel and drain one background usage task without leaking exceptions."""
    if task is None:
        return
    try:
        if not task.done():
            task.cancel()
        await task
    except asyncio.CancelledError:
        pass
    except Exception as exc:
        logger.debug("usage background task stopped with error: %s", exc)
    finally:
        if registry is not None:
            registry.discard(task)


async def _cancel_usage_tasks() -> None:
    """Cancel and await all usage enrichment/snapshot tasks during shutdown."""
    tasks = set(_USAGE_ENRICH_TASKS) | set(_USAGE_SNAPSHOT_TASKS)
    if not tasks:
        return
    for task in tasks:
        if not task.done():
            task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    _USAGE_ENRICH_TASKS.difference_update(tasks)
    _USAGE_SNAPSHOT_TASKS.difference_update(tasks)


async def _enrich_usage_credits(
    request_id: str,
    account_id: str,
    token: str,
    before_task: asyncio.Task | None,
    *,
    usage_turn_id: str = "",
    credit_safe: bool = True,
) -> None:
    try:
        settle = _credit_settle_seconds()
        if settle:
            await asyncio.sleep(settle)
        if usage_turn_id and _session_usage_enabled():
            try:
                session_usage = await trae_client.fetch_session_usage(
                    usage_turn_id,
                    token,
                )
                credits = _number_value(session_usage.get("credits_consumed"))
                if credits is not None and credits >= 0:
                    await _cancel_usage_task(
                        before_task,
                        _USAGE_SNAPSHOT_TASKS,
                    )
                    before_task = None
                    _update_usage_record(
                        request_id,
                        credits_consumed=_credit_round(credits),
                        credits_source="session_usage",
                    )
                    return
            except Exception as exc:
                logger.debug("session usage enrichment unavailable: %s", exc)
        if not credit_safe or not _credit_snapshot_is_safe(account_id):
            return
        before = None
        if before_task is not None:
            try:
                before = await before_task
            except Exception:
                before = None
        after = await _fetch_used_credits(token)
        if before is None or after is None or after < before:
            return
        _update_usage_record(
            request_id,
            credits_consumed=_credit_round(after - before),
            credits_source="snapshot_delta",
            credits_before=_credit_round(before),
            credits_after=_credit_round(after),
        )
    finally:
        await _cancel_usage_task(before_task, _USAGE_SNAPSHOT_TASKS)
        _end_credit_snapshot(account_id)


class _UsageTracker:
    def __init__(
        self,
        model: str,
        endpoint: str,
        stream: bool,
        options: Optional[Mapping[str, Any]] = None,
        messages: Optional[list[dict[str, Any]]] = None,
    ):
        self.request_id = "req-" + uuid_mod.uuid4().hex
        options = options if isinstance(options, dict) else dict(options or {})
        if not isinstance(options.get("_upstream_trace"), dict):
            options["_upstream_trace"] = {}
        self.options = options
        self.messages = messages or []
        self.account_id = str(options.get("_account_id") or "")
        self.billing_id = str(options.get("_billing_id") or "")
        self.token = str(options.get("_auth_token") or "")
        if self.account_id and not self.token:
            # An explicitly bound account owns the lookup.  Never fill its
            # token from the mutable global auth state.
            record = auth.get_account_record(self.account_id)
            self.token = str(record.get("token") or "")
        token_identity = _account_id_from_token(self.token)
        if token_identity:
            # The JWT is the credential that the upstream actually bills. It
            # is authoritative over a stale UI-selected account id.
            if self.account_id and self.account_id != token_identity:
                logger.warning(
                    "usage account corrected from bound id=%s to token id=%s",
                    self.account_id,
                    token_identity,
                )
            self.account_id = token_identity
        if self.billing_id:
            # billing_id overrides account_id for usage records so the
            # deducted credits are attributed to the token owner.
            self.account_id = self.billing_id
        if not self.account_id or not self.token:
            fallback_account_id, fallback_token = _request_account_identity()
            self.account_id = self.account_id or fallback_account_id
            self.token = self.token or fallback_token
        self.model = model
        self.endpoint = endpoint
        self.stream = bool(stream)
        self.started = time.perf_counter()
        self.usage = _usage_values({})
        self.usage_turn_id = ""
        self.saw_usage = False
        # Request metadata is captured before dispatch; the trace and tool
        # return state are updated later as the selected upstream responds.
        self.reasoning_effort = _requested_reasoning_effort(options)
        (
            self.context_mode_requested,
            self.context_mode_actual,
            self.context_window_tokens,
            self.max_mode_applied,
        ) = _context_mode_metadata(options)
        # Keep request capability and model behaviour separate.  A non-empty
        # ``tools`` catalog means the caller offered tools; it does not mean
        # that this response actually returned a tool call.
        self.tools_requested = _tools_requested_from_options(options)
        self.tool_used: bool | None = None
        self.tool_calls_returned: bool | None = None
        self.status = "in_progress"
        self._finished = False
        self._credit_snapshot_started = bool(
            self.account_id and self.account_id != "default" and self.token
        )
        self._credit_safe = _begin_credit_snapshot(self.account_id, self.token)
        self._before_task = (
            _spawn_usage_task(
                _fetch_used_credits(self.token),
                _USAGE_SNAPSHOT_TASKS,
            )
            if self._credit_safe
            else None
        )

    def update(self, usage: Any) -> None:
        self.saw_usage = True
        values = _usage_values(usage)
        # Upstream streams may send cumulative usage more than once. Keep the
        # latest complete token snapshot instead of creating duplicate records.
        # A later token-only frame must not erase explicit credit evidence
        # reported by an earlier frame.
        if values["total_tokens"] >= self.usage["total_tokens"]:
            explicit_credits = self.usage.get("credits_consumed")
            self.usage.update(values)
            if (
                values.get("credits_consumed") is None
                and explicit_credits is not None
            ):
                self.usage["credits_consumed"] = explicit_credits
        elif values.get("credits_consumed") is not None:
            self.usage["credits_consumed"] = values["credits_consumed"]

    def mark_tool_calls(self, value: Any) -> None:
        """Record whether the model actually returned a structured tool call."""

        if value is None:
            return
        has_calls = (
            _tool_call_count(value) > 0
            if isinstance(value, Mapping)
            else bool(value)
        )
        if has_calls:
            self.tool_calls_returned = True

    def bind_usage_turn(self, usage_turn_id: Any, *, replace: bool = False) -> None:
        value = str(usage_turn_id or "").strip()
        if value and (replace or not self.usage_turn_id):
            self.usage_turn_id = value

    async def rebind(self, options: Optional[Mapping[str, Any]] = None) -> None:
        """Move billing/credit tracking to the account used by a retry.

        Remote account rotation can happen after the tracker has started its
        before-credit snapshot.  Cancel that snapshot and restart it for the
        new JWT so the eventual usage row and credit delta follow the account
        that actually handled the request.
        """
        options = options or {}
        token = str(options.get("_auth_token") or "").strip()
        account_id = str(options.get("_account_id") or "").strip()
        billing_id = str(options.get("_billing_id") or "").strip()
        token_identity = _account_id_from_token(token)
        if token_identity:
            billing_id = token_identity
            account_id = token_identity
        elif billing_id:
            account_id = billing_id
        if not account_id and token:
            account_id = str(auth.get_active_account_id() or "default")
        if not token and account_id:
            token = str((auth.get_account_record(account_id) or {}).get("token") or "").strip()
        if not account_id and not token:
            return
        if account_id == self.account_id and token == self.token:
            return

        old_account = self.account_id
        await _cancel_usage_task(self._before_task, _USAGE_SNAPSHOT_TASKS)
        self._before_task = None
        if self._credit_snapshot_started:
            _end_credit_snapshot(old_account)

        self.account_id = account_id or self.account_id
        self.billing_id = billing_id or self.account_id
        self.token = token or self.token
        self.usage_turn_id = ""
        self._credit_snapshot_started = bool(
            self.account_id and self.account_id != "default" and self.token
        )
        self._credit_safe = _begin_credit_snapshot(self.account_id, self.token)
        if self._credit_safe:
            self._before_task = _spawn_usage_task(
                _fetch_used_credits(self.token),
                _USAGE_SNAPSHOT_TASKS,
            )

    async def finish(self, status: str | None = None) -> None:
        if self._finished:
            return
        self._finished = True
        final_status = status or self.status or "completed"
        values = self.usage
        trace = self.options.get("_upstream_trace")
        trace = trace if isinstance(trace, Mapping) else {}
        requested_effort = _requested_reasoning_effort(self.options)
        if requested_effort:
            self.reasoning_effort = requested_effort
        applied_effort = (
            trace.get("reasoning_effort_applied")
            or self.options.get("_reasoning_effort_applied")
        )
        (
            context_requested,
            context_actual,
            context_window,
            max_applied,
        ) = _context_mode_metadata(self.options)
        self.context_mode_requested = context_requested or self.context_mode_requested
        self.context_mode_actual = context_actual or self.context_mode_actual
        self.context_window_tokens = context_window or self.context_window_tokens
        self.max_mode_applied = (
            max_applied
            if max_applied is not None
            else self.max_mode_applied
        )
        if self.tool_calls_returned is None and final_status == "completed":
            # A completed turn with an offered tool catalog and no structured
            # call is an explicit negative result.  Failed/cancelled turns
            # remain unknown because no terminal model decision was observed.
            self.tool_calls_returned = False
        if final_status == "completed":
            self.tool_used = self.tool_calls_returned is True
        else:
            self.tool_used = self.tool_calls_returned
        context_mode = self.context_mode_actual
        explicit_credits = values.get("credits_consumed")
        credits_source = "upstream" if explicit_credits is not None else "unknown"
        _record_usage(
            self.account_id,
            self.model,
            values["prompt_tokens"],
            values["completion_tokens"],
            credits_consumed=explicit_credits,
            credits_source=credits_source,
            request_id=self.request_id,
            endpoint=self.endpoint,
            stream=self.stream,
            status=final_status,
            duration_ms=round((time.perf_counter() - self.started) * 1000, 1),
            tokens_source="upstream" if self.saw_usage else "unknown",
            cached_tokens=values.get("cached_tokens", 0),
            reasoning_effort=self.reasoning_effort,
            requested_reasoning_effort=self.reasoning_effort,
            reasoning_effort_applied=(
                str(applied_effort).strip()
                if applied_effort not in (None, "")
                else None
            ),
            context_mode_requested=self.context_mode_requested,
            context_mode=context_mode,
            context_mode_actual=self.context_mode_actual,
            context_window_tokens=self.context_window_tokens,
            max_mode_applied=self.max_mode_applied,
            max_mode_requested=self.context_mode_requested == "max_1m",
            max_mode_enabled=self.max_mode_applied,
            tools_requested=self.tools_requested,
            tool_used=self.tool_used,
            tool_calls_returned=self.tool_calls_returned,
            tool_called=self.tool_used,
        )
        if explicit_credits is not None:
            try:
                await _cancel_usage_task(self._before_task, _USAGE_SNAPSHOT_TASKS)
            finally:
                self._before_task = None
                if self._credit_snapshot_started:
                    _end_credit_snapshot(self.account_id)
        elif self.usage_turn_id or self._credit_safe:
            _spawn_usage_task(
                _enrich_usage_credits(
                    self.request_id,
                    self.account_id,
                    self.token,
                    self._before_task,
                    usage_turn_id=self.usage_turn_id,
                    credit_safe=self._credit_safe,
                )
            )
        else:
            try:
                await _cancel_usage_task(self._before_task, _USAGE_SNAPSHOT_TASKS)
            finally:
                self._before_task = None
                if self._credit_snapshot_started:
                    _end_credit_snapshot(self.account_id)

    async def begin(self) -> None:
        if self._before_task is not None:
            # Let the before-snapshot request start without delaying the first
            # model frame on the result of a separate billing endpoint.
            await asyncio.sleep(0)


def _track_usage_from_result(result: dict, model: str) -> None:
    """Pass non-stream usage to the request tracker, or keep legacy fallback."""
    usage = result.get("usage") or {}
    tracker = _USAGE_TRACKER.get()
    if tracker is not None:
        mark_tool_calls = getattr(tracker, "mark_tool_calls", None)
        if callable(mark_tool_calls):
            mark_tool_calls(result)
        tracker.update(usage)
        return
    values = _usage_values(usage)
    account_id, _ = _request_account_identity()
    _record_usage(
        account_id,
        model,
        values["prompt_tokens"],
        values["completion_tokens"],
        credits_consumed=values.get("credits_consumed"),
        credits_source="upstream" if values.get("credits_consumed") is not None else "unknown",
        cached_tokens=values.get("cached_tokens", 0),
    )


def _track_usage_from_exception(exc: BaseException, model: str) -> None:
    usage = getattr(exc, "usage", None)
    if usage is not None and not getattr(exc, "_relay_usage_recorded", False):
        _track_usage_from_result({"usage": usage}, model)
        exc._relay_usage_recorded = True


def _track_usage_from_chunk(chunk: str, model: str) -> None:
    """Pass OpenAI and TraeWork SSE usage to the request tracker.

    Ordinary relay streams put usage on a ``data:`` JSON frame. The TraeWork
    custom-model adapter wraps the same payload as ``event: token_usage``.
    Parse complete SSE blocks instead of requiring a chunk to start with
    ``data:``; an ASGI chunk may contain several events.
    """
    if isinstance(chunk, (bytes, bytearray)):
        text = bytes(chunk).decode("utf-8", errors="replace")
    else:
        text = str(chunk or "")
    if not text:
        return

    tracker = _USAGE_TRACKER.get()
    normalized = text.replace("\r\n", "\n")
    for block in normalized.split("\n\n"):
        if not block.strip():
            continue
        event_name = ""
        data_lines: list[str] = []
        for line in block.split("\n"):
            stripped = line.strip()
            if stripped.lower().startswith("event:"):
                event_name = stripped.split(":", 1)[1].strip().lower()
            elif stripped.lower().startswith("data:"):
                data_lines.append(stripped.split(":", 1)[1].lstrip())
        if not data_lines:
            continue
        payload_text = "\n".join(data_lines).strip()
        if payload_text == "[DONE]":
            continue
        try:
            data = json.loads(payload_text)
        except Exception:
            continue
        if not isinstance(data, Mapping):
            continue
        if tracker is not None:
            mark_tool_calls = getattr(tracker, "mark_tool_calls", None)
            if callable(mark_tool_calls):
                mark_tool_calls(data)
        usage = data.get("usage")
        if not usage and event_name == "token_usage":
            usage = data
        if not isinstance(usage, Mapping):
            continue
        if tracker is not None:
            update = getattr(tracker, "update", None)
            if callable(update):
                update(usage)
            # Test/dummy trackers may only expose ``saw_usage``; they already
            # own their terminal bookkeeping and should not create a second
            # fallback usage row here.
            continue
        values = _usage_values(usage)
        account_id, _ = _request_account_identity()
        _record_usage(
            account_id,
            model,
            values["prompt_tokens"],
            values["completion_tokens"],
            credits_consumed=values.get("credits_consumed"),
            credits_source="upstream" if values.get("credits_consumed") is not None else "unknown",
            cached_tokens=values.get("cached_tokens", 0),
        )


def _bind_usage_turn(usage_turn_id: Any, *, replace: bool = False) -> None:
    tracker = _USAGE_TRACKER.get()
    if tracker is not None:
        tracker.bind_usage_turn(usage_turn_id, replace=replace)


def _bind_usage_turn_from_metadata(metadata: Any) -> None:
    if isinstance(metadata, Mapping):
        _bind_usage_turn(metadata.get("usage_turn_id"))


def _remote_only_models() -> set[str]:
    """Return explicit overrides for remote manual selection."""
    raw = os.environ.get("TRAE_REMOTE_ONLY_MODELS", "")
    configured: set[str] = set()
    for item in raw.split(","):
        value = item.strip().lower()
        if value.startswith("trae/"):
            value = value[5:]
        if value:
            configured.add(value)
    return configured


def _raw_history_limit_int(
    options: Mapping[str, Any],
    names: tuple[str, ...],
    env_name: str,
    default: int,
) -> int:
    value = None
    for name in names:
        value = options.get(name)
        if value is not None:
            break
    if value is None:
        value = os.environ.get(env_name, str(default))
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return default


def _bounded_remote_query(
    messages: list[Mapping[str, Any]],
    options: Mapping[str, Any],
) -> tuple[list[dict[str, Any]], int]:
    """Truncate oldest non-system messages so the flattened query fits upstream.

    Trae's remote session silently ends the event stream (no text, no ``done``)
    when initial_message.query exceeds roughly 500k chars.  Keep the system
    prompt and the newest turns intact and drop the oldest conversation from
    the front until ``flatten_query`` is under the configured cap.
    """

    raw_limit = _raw_history_limit_int(
        options,
        ("trae_remote_query_max_chars", "traeRemoteQueryMaxChars"),
        "TRAE_REMOTE_QUERY_MAX_CHARS",
        480_000,
    )
    if raw_limit <= 0:
        return [dict(m) for m in messages], 0
    bounded = [dict(m) for m in messages]
    removed = 0
    while True:
        query = trae_client.flatten_query(bounded)
        if len(query) <= raw_limit:
            return bounded, removed
        non_system = [
            index
            for index, message in enumerate(bounded)
            if str(message.get("role") or "user") not in {"system", "developer"}
        ]
        if len(non_system) <= 1:
            return bounded, removed
        head = non_system[0]
        drop = {head}
        head_message = bounded[head]
        if str(head_message.get("role") or "") == "assistant" and (
            head_message.get("tool_calls") or head_message.get("function_call")
        ):
            if head + 1 < len(bounded):
                following = bounded[head + 1]
                if str(following.get("role") or "") == "tool":
                    drop.add(head + 1)
        bounded = [m for index, m in enumerate(bounded) if index not in drop]
        removed += len(drop)


_CONTINUATION_ONLY_RE = re.compile(
    r"^(?:继续(?:执行|完成|处理|下载|安装|操作|进行|做)?|接着(?:做|执行|处理)?|"
    r"往下继续|下一步|j继续|continue(?:\s+(?:it|this|working))?|go\s+on|"
    r"proceed|keep\s+going|resume)[\s。.!！?？]*$",
    re.IGNORECASE,
)


def _remote_client_tool_task_anchor(
    messages: list[Mapping[str, Any]], options: Mapping[str, Any]
) -> dict[str, str] | None:
    """Keep the active client-tool task when the newest turn only says continue.

    Very large Codex sessions can contain more than a thousand messages. The
    remote query cap must discard old turns, but a short continuation such as
    ``继续`` has no task semantics by itself. Preserve the nearest preceding
    user request as a system constraint so URLs and destination paths survive
    compaction and the model still emits a caller-owned tool call.
    """
    if not _tool_protocol_requested(options, list(messages)):
        return None
    user_messages: list[tuple[int, str]] = []
    for index, message in enumerate(messages):
        if not isinstance(message, Mapping):
            continue
        if str(message.get("role") or "user") != "user":
            continue
        text = raw_client._content_to_text(message.get("content")).strip()
        if text:
            user_messages.append((index, text))
    if len(user_messages) < 2:
        return None
    latest_index, latest_text = user_messages[-1]
    if not _CONTINUATION_ONLY_RE.fullmatch(latest_text):
        return None
    for index, text in reversed(user_messages[:-1]):
        if index >= latest_index or _CONTINUATION_ONLY_RE.fullmatch(text):
            continue
        max_chars = 16_000
        if len(text) > max_chars:
            text = text[:8_000] + "\n...[task middle omitted]...\n" + text[-8_000:]
        return {
            "role": "system",
            "content": (
                "Active caller task retained during history compaction. The "
                "latest user message is only a continuation request. Continue "
                "the task below. For any caller-side download or file change, "
                "emit the matching client tool call and wait for its result; "
                "do not claim success from a remote/internal tool.\n\n"
                + text
            ),
        }
    return None


def _requires_remote_model(model: str) -> bool:
    """Return whether an explicit operator override forces remote routing."""

    configured = _remote_only_models()
    if not configured:
        return False
    if "*" in configured:
        return True
    value = str(model or "").strip()
    if value.lower().startswith("trae/"):
        value = value[5:]
    candidates = {value.lower()} if value else set()
    try:
        mapped = str(trae_client.convert_model_name(value) or "").strip().lower()
    except Exception:
        mapped = ""
    if mapped:
        candidates.add(mapped)
    return bool(candidates & configured)


def _chunk_stream_state(chunk: Any) -> str | None:
    """Return the public stream state proven by one SSE chunk.

    Clients commonly close immediately after the final Chat Completions
    frame (the one carrying ``finish_reason``), before they consume the
    protocol ``[DONE]`` sentinel.  Treating that normal close as a cancelled
    turn makes already-billed streaming requests look unpaid in the console.
    Parse both OpenAI data frames and Responses event names here so usage
    tracking has one protocol-aware terminal check.
    """
    if isinstance(chunk, (bytes, bytearray)):
        try:
            text = bytes(chunk).decode("utf-8", errors="replace")
        except Exception:
            text = ""
    elif isinstance(chunk, str):
        text = chunk
    else:
        text = str(chunk)
    normalized = text.replace("\r\n", "\n")
    # Parse one SSE block at a time so a custom ``event: output`` line stays
    # associated with its data payload. This also handles a proxy coalescing
    # ``token_usage`` and ``done`` events in one chunk.
    for block in normalized.split("\n\n"):
        if not block.strip():
            continue
        event_name = ""
        data_lines: list[str] = []
        for line in block.split("\n"):
            stripped = line.strip()
            if stripped.lower().startswith("event:"):
                event_name = stripped.split(":", 1)[1].strip().lower()
            elif stripped.lower().startswith("data:"):
                data_lines.append(stripped.split(":", 1)[1].lstrip())
        if event_name in {"response.failed", "error"}:
            return "error"
        if event_name in {"response.completed", "response.incomplete"}:
            return "completed"
        if not data_lines:
            if event_name == "done":
                return "completed"
            continue
        payload = "\n".join(data_lines).strip()
        if payload == "[DONE]":
            return "completed"
        try:
            value = json.loads(payload)
        except Exception:
            continue
        if not isinstance(value, Mapping):
            if event_name == "done":
                return "completed"
            continue
        value_type = str(value.get("type") or "").strip().lower()
        if value_type in {"response.failed", "error"}:
            return "error"
        if value_type in {"response.completed", "response.incomplete"}:
            return "completed"
        if isinstance(value.get("error"), Mapping):
            return "error"
        if event_name == "done":
            status = str(value.get("status") or "").strip().lower()
            if status in {"error", "failed", "cancelled", "canceled"}:
                return "error"
            return "completed"
        # TraeWork's output event carries the terminal finish reason in its
        # own payload. A client may close immediately after consuming this
        # frame, before the adapter's later ``event: done`` sentinel arrives.
        if event_name == "output" and value.get("finish_reason") not in (None, ""):
            return "completed"
        # The public translators put finish_reason inside ``choices`` only on
        # the final OpenAI frame. Upstream cumulative snapshots are consumed
        # before translation, so this is safe to use when a client disconnects
        # just before the following [DONE].
        choices = value.get("choices")
        if isinstance(choices, list):
            for choice in choices:
                if not isinstance(choice, Mapping):
                    continue
                if choice.get("finish_reason") in (None, ""):
                    continue
                # A terminal translated frame has an empty delta. Do not
                # classify a cumulative frame that carries both text/tool data
                # and a provisional finish_reason as complete.
                delta = choice.get("delta")
                if isinstance(delta, Mapping) and not any(
                    item not in (None, "", [], {}) for item in delta.values()
                ):
                    return "completed"
    return None


def _chunk_marks_terminal(chunk: Any) -> bool:
    """Whether an SSE chunk proves the response reached its end."""
    return _chunk_stream_state(chunk) is not None


async def _tracked_stream(source, tracker: _UsageTracker):
    context_token = _USAGE_TRACKER.set(tracker)
    status = "cancelled"
    saw_terminal = False
    terminal_status: str | None = None
    try:
        await tracker.begin()
        async for chunk in source:
            # TraeWork custom streams expose usage as ``event: token_usage``;
            # feed every frame through the shared parser so streaming and
            # non-stream requests settle the same usage record.
            _track_usage_from_chunk(chunk, getattr(tracker, "model", ""))
            chunk_status = _chunk_stream_state(chunk)
            if chunk_status is not None:
                saw_terminal = True
                # Keep an error terminal state sticky if a cleanup sentinel is
                # emitted after it.
                if chunk_status == "error" or terminal_status is None:
                    terminal_status = chunk_status
            yield chunk
        usage_seen = bool(getattr(tracker, "saw_usage", False))
        status = terminal_status or ("completed" if usage_seen else "cancelled")
    except asyncio.CancelledError:
        # A final usage frame is emitted immediately before [DONE] by the
        # OpenAI translators.  Some clients close after consuming that frame
        # but before reading [DONE]; preserve the billable turn as completed.
        usage_seen = bool(getattr(tracker, "saw_usage", False))
        status = terminal_status or ("completed" if saw_terminal or usage_seen else "cancelled")
        raise
    except GeneratorExit:
        usage_seen = bool(getattr(tracker, "saw_usage", False))
        status = terminal_status or ("completed" if saw_terminal or usage_seen else "cancelled")
        raise
    except Exception:
        status = "error"
        raise
    finally:
        _USAGE_TRACKER.reset(context_token)
        await tracker.finish(status)


async def _tracked_dispatch(
    messages: list[dict],
    model: str,
    options: dict,
    tracker: _UsageTracker,
):
    context_token = _USAGE_TRACKER.set(tracker)
    status = "completed"
    try:
        await tracker.begin()
        response = await _dispatch_chat(messages, model, False, options)
        if getattr(response, "status_code", 200) >= 400:
            status = "error"
        return response
    except Exception:
        status = "error"
        raise
    finally:
        _USAGE_TRACKER.reset(context_token)
        await tracker.finish(status)


async def run_cli_chat(messages, model, stream: bool, options: Optional[dict] = None):
    """本地 Trae CLI 子进程上游。"""
    event_iter = cli_client.stream_cli_chat(messages, model, options=options)
    translation_options = _tool_translation_options(options, messages)
    if not stream:
        result = await collect_nonstream_cli(event_iter, model, **translation_options)
        _track_usage_from_result(result, model)
        return JSONResponse(content=result)

    first, rest = await _peek_async(event_iter)
    if first is None:
        async def empty_gen():
            async for chunk in translate_cli_stream(
                _empty_cli_events(), model, FORWARD_USAGE, **translation_options
            ):
                yield chunk
        return StreamingResponse(empty_gen(), media_type="text/event-stream", headers=_sse_headers())
    if first.type == "error":
        raise RuntimeError(first.error or "Trae CLI failed before output")

    async def gen():
        async def chain():
            yield first
            async for item in rest:
                yield item
        async for chunk in translate_cli_stream(
            chain(), model, FORWARD_USAGE, **translation_options
        ):
            _track_usage_from_chunk(chunk, model)
            yield chunk

    return StreamingResponse(gen(), media_type="text/event-stream", headers=_sse_headers())


async def _await_session_cleanup(task: asyncio.Task) -> None:
    """Finish owned cleanup before propagating repeated client cancellation."""
    pending_exception = sys.exception()
    cancellation = (
        pending_exception if isinstance(pending_exception, asyncio.CancelledError) else None
    )
    with anyio.CancelScope(shield=True):
        while not task.done():
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError as exc:
                if task.cancelled():
                    raise
                cancellation = cancellation or exc
            except Exception:
                break
        try:
            task.result()
        except BaseException:
            if cancellation is None:
                raise
            logger.warning("session cleanup failed while client cancelled", exc_info=True)
    if cancellation is not None:
        raise cancellation


class _SessionStreamIterator:
    """Keep cleanup ownership even when a response is closed before iteration."""

    def __init__(self, source, close):
        self._source = source
        self._close = close

    def __aiter__(self):
        return self

    async def __anext__(self):
        return await anext(self._source)

    async def aclose(self):
        try:
            await self._source.aclose()
        finally:
            await self._close()


def _chat_response_closer(response, upstream_metadata: dict[str, Any]):
    cleanup_task = None

    async def cleanup() -> None:
        try:
            _bind_usage_turn_from_metadata(upstream_metadata)
        finally:
            response.close()

    async def close() -> None:
        nonlocal cleanup_task
        if cleanup_task is None:
            cleanup_task = asyncio.create_task(cleanup())
        await _await_session_cleanup(cleanup_task)

    return close


async def run_web_session(messages, model, stream: bool, options: Optional[dict] = None):
    """OmniRoute 风格网页版 remote 会话，带账号并发槽和空闲回收。"""
    options = dict(options or {})
    token = str(options.get("_auth_token") or "").strip()
    account_id = str(options.get("_account_id") or "").strip()
    record = auth.get_account_record(account_id) if account_id else {}
    if not account_id and not token:
        account_id, record = auth.get_model_account_snapshot()
    if not token and account_id:
        token = str((record or {}).get("token") or "").strip()
    if not token and not account_id:
        if auth.get_accounts_raw():
            raise _ModelAccountUnavailable(
                "No enabled model account available; enable an account in 账号与签到"
            )
        token = str(auth.get_token() or "").strip()
    _ensure_model_account_enabled(account_id, token)
    token_identity = _account_id_from_token(token)
    if token_identity:
        account_id = token_identity
    if not account_id:
        account_id = str(
            auth.get_active_account_id() or auth.get_user_id() or token[:16] or "default"
        )
    if not token:
        token = str((auth.get_account_record(account_id) or {}).get("token") or "").strip()
    if not token:
        raise RuntimeError("No Cloud-IDE-JWT token available")
    translation_options = _tool_translation_options(options, messages)
    bound_options = {**options, "_auth_token": token, "_account_id": account_id}
    provider_specific = bound_options.get("provider_specific")
    if provider_specific is None and "providerSpecificData" in bound_options:
        provider_specific = bound_options.get("providerSpecificData")
    if not isinstance(provider_specific, Mapping):
        provider_specific = (record or {}).get("provider_specific") or (
            record or {}
        ).get("providerSpecificData")
    bound_options["provider_specific"] = (
        dict(provider_specific) if isinstance(provider_specific, Mapping) else {}
    )
    await trae_client.acquire_web_slot(
        account_id, timeout=float(os.environ.get("TRAE_WEB_SLOT_TIMEOUT", "60"))
    )
    client = None
    session_id = ""
    message_id = ""
    lease_registered = False
    cleanup_task = None

    async def cleanup_web_session() -> None:
        # Claim the registered lease before any await so the idle reaper and
        # response teardown cannot both close and release the same resources.
        if lease_registered and not trae_client.unregister_web_lease(session_id):
            return
        try:
            if session_id and client is not None:
                await trae_client.stop_web_session(
                    client, session_id, message_id, options=bound_options
                )
        finally:
            try:
                if client is not None:
                    await client.aclose()
            finally:
                trae_client.release_web_slot(account_id)

    async def close_web_session() -> None:
        nonlocal cleanup_task
        if cleanup_task is None:
            cleanup_task = asyncio.create_task(cleanup_web_session())
        await _await_session_cleanup(cleanup_task)

    try:
        client = httpx.AsyncClient(timeout=60)
        session_id, message_id = await trae_client.create_web_session(
            client,
            model,
            messages,
            options=bound_options,
        )
        _bind_usage_turn(message_id)
        trae_client.register_web_lease(
            account_id,
            session_id,
            message_id,
            client,
            token=token,
            provider_specific=bound_options.get("provider_specific"),
        )
        lease_registered = True
        event_iter = trae_client.stream_web_events(
            client, session_id, message_id, options=bound_options
        )
        if stream:
            async def gen():
                try:
                    async for chunk in translate_web_events(
                        event_iter, model, FORWARD_USAGE, **translation_options
                    ):
                        _track_usage_from_chunk(chunk, model)
                        yield chunk
                finally:
                    await close_web_session()
            return StreamingResponse(
                _SessionStreamIterator(gen(), close_web_session),
                media_type="text/event-stream",
                headers=_sse_headers(),
            )
        try:
            result = await collect_nonstream_web(
                event_iter, model, **translation_options
            )
            _track_usage_from_result(result, model)
            return JSONResponse(content=result)
        finally:
            await close_web_session()
    except BaseException:
        await close_web_session()
        raise


async def run_remote_session(messages, model, stream: bool, options: Optional[dict] = None):
    """9router-style Trae remote session using the current account snapshot.

    Unlike the legacy web helper, this path never reads a mutable global token
    after dispatch.  The account-bound token and provider metadata captured by
    ``_bind_chat_session`` are used for both create and events requests.
    """
    options = dict(options or {})
    account_id = str(options.get("_account_id") or "").strip()
    token = str(options.get("_auth_token") or "").strip()
    model_record: dict = {}
    if not account_id and not token:
        account_id, model_record = auth.get_model_account_snapshot()
    if not token and account_id:
        # A bound account owns its credential.  Do not fall back to the
        # mutable global token, which may belong to a concurrently selected
        # account.
        token = str((auth.get_account_record(account_id) or {}).get("token") or "").strip()
    if not token and not account_id:
        if auth.get_accounts_raw():
            raise _ModelAccountUnavailable(
                "No enabled model account available; enable an account in 账号与签到"
            )
        token = str(auth.get_token() or "").strip()
    _ensure_model_account_enabled(account_id, token)
    token_identity = _account_id_from_token(token)
    if token_identity:
        # The JWT is the identity Trae bills.  It is authoritative if an old
        # account-store key or UI selection is stale.
        account_id = token_identity
    if not account_id:
        account_id = str(auth.get_active_account_id() or "default")
    record = auth.get_account_record(account_id) if account_id else model_record
    if not token:
        token = str(record.get("token") or "").strip()
    if not token:
        raise RuntimeError("No Cloud-IDE-JWT token available")
    remote_options = dict(options)
    # Caller-owned tools must run in the API client's workspace.  Agent owns a
    # separate remote workspace and can consume file/shell work internally,
    # then return only a success sentence; Work keeps the advertised tools as
    # calls for Codex/the API client to execute.  Plain text requests remain
    # Agent-first (including the 1M/max profile), and operators can explicitly
    # opt tool requests back into Agent with ``...USE_WORK=0`` for diagnostics.
    caller_tools_use_work = (
        os.environ.get("TRAE_REMOTE_CALLER_TOOLS_USE_WORK", "1").strip().lower()
        in {"1", "true", "yes", "on"}
    )
    if (
        caller_tools_use_work
        and _tool_protocol_requested(options, messages)
        and not remote_options.get("_remote_agent_type")
        and not remote_options.get("remote_agent_type")
    ):
        # Agent sessions own a remote workspace and may consume their internal
        # shell/file tools, then report success without emitting a caller tool
        # call. Work mode has no such ownership ambiguity: caller-advertised
        # tools remain executable only by Codex/the API client.
        remote_options["_remote_agent_type"] = "solo_work_remote"
        remote_options["_session_variant"] = "caller-tools-work"
    # A session lease may carry provider metadata captured from the account
    # store before the JWT identity is normalized. Prefer that bound snapshot;
    # only consult the mutable account lookup as a fallback.
    provider_specific = remote_options.get("provider_specific") or remote_options.get(
        "providerSpecificData"
    )
    if not isinstance(provider_specific, Mapping):
        provider_specific = record.get("provider_specific") or record.get(
            "providerSpecificData"
        )
    remote_options["provider_specific"] = (
        dict(provider_specific) if isinstance(provider_specific, Mapping) else {}
    )
    slot_released = False
    cleanup_task = None

    def release_slot_once() -> None:
        """Release the account slot exactly once across all exit paths."""

        nonlocal slot_released
        if slot_released:
            return
        slot_released = True
        trae_client.release_web_slot(account_id)

    client = None
    session_id = ""
    message_id = ""

    async def cleanup_remote_session() -> None:
        """Stop and close one remote attempt without leaking its account slot."""
        try:
            if session_id and client is not None:
                await trae_remote_client.stop_session(
                    client,
                    token,
                    session_id,
                    message_id,
                    options=remote_options,
                )
        finally:
            try:
                if client is not None:
                    await client.aclose()
            finally:
                release_slot_once()

    async def close_remote_session() -> None:
        nonlocal cleanup_task
        if cleanup_task is None:
            cleanup_task = asyncio.create_task(cleanup_remote_session())
        await _await_session_cleanup(cleanup_task)

    translation_options = _tool_translation_options(options, messages)
    explicit_remote_type = str(
        remote_options.get("_remote_agent_type")
        or remote_options.get("remote_agent_type")
        or ""
    ).strip().lower()
    explicit_work = explicit_remote_type in {
        "solo_work_remote",
        "solo_work_lite",
        "work",
    } or str(model or "").strip().lower() in {"work", "auto-work", "solo-work"}
    work_fallback_enabled = (
        os.environ.get("TRAE_REMOTE_WORK_FALLBACK", "1").strip().lower()
        in {"1", "true", "yes", "on"}
    )
    can_work_fallback = work_fallback_enabled and not explicit_work
    can_work_fallback = can_work_fallback and (
        trae_remote_client.remote_agent_type(model, remote_options)
        == "solo_agent_remote"
    )
    work_fallback_used = False

    def work_fallback_options(base: Mapping[str, Any]) -> dict[str, Any]:
        fallback = dict(base)
        fallback["_remote_agent_type"] = "solo_work_remote"
        fallback["_session_variant"] = "work-fallback"
        return fallback

    # Inject caller-owned tool definitions as a system prompt so the
    # remote upstream sees the available tools even though its transport
    # only accepts text messages.
    prepared_messages = trae_client._messages_with_client_runtime(messages, options)
    task_anchor = _remote_client_tool_task_anchor(messages, options)
    if task_anchor is not None:
        prepared_messages = [prepared_messages[0], task_anchor, *prepared_messages[1:]]
        logger.info(
            "remote retained active client-tool task id=%s anchor_chars=%d",
            str(options.get("_relay_request_id") or ""),
            len(task_anchor["content"]),
        )
    compact_options = dict(options)
    # The agent-remote session advertises a 1M-token window, but the upstream
    # silently drops sessions whose flattened query exceeds ~500k chars.
    # Bound history by message count and content size first, then trim the
    # flattened query to the hard cap so large tool sessions still respond.
    compact_options.setdefault(
        "trae_raw_max_messages",
        os.environ.get("TRAE_REMOTE_MAX_MESSAGES", "500"),
    )
    compact_options.setdefault(
        "trae_raw_max_history_chars",
        os.environ.get("TRAE_REMOTE_MAX_HISTORY_CHARS", "480000"),
    )
    compact_options.setdefault(
        "trae_remote_query_max_chars",
        os.environ.get("TRAE_REMOTE_QUERY_MAX_CHARS", "480000"),
    )
    original_message_count = len(prepared_messages)
    prepared_messages, omitted_history = raw_client._compact_raw_history(
        prepared_messages, compact_options
    )
    prepared_messages, query_trimmed = _bounded_remote_query(
        prepared_messages, compact_options
    )
    if omitted_history:
        logger.info(
            "remote history compacted input_messages=%d output_messages=%d omitted=%d",
            original_message_count,
            len(prepared_messages),
            omitted_history,
        )
    if query_trimmed:
        logger.warning(
            "remote query trimmed for upstream size input_messages=%d output_messages=%d dropped=%d query_chars=%d",
            original_message_count,
            len(prepared_messages),
            query_trimmed,
            len(trae_client.flatten_query(prepared_messages)),
        )
    await trae_client.acquire_web_slot(
        account_id,
        timeout=float(os.environ.get("TRAE_WEB_SLOT_TIMEOUT", "60")),
    )
    try:
        client = httpx.AsyncClient(timeout=None)
        logger.info(
            "remote create start id=%s account=%s model=%s messages=%d last_chars=%d",
            str(options.get("_relay_request_id") or ""),
            account_id,
            model,
            len(messages),
            len(str(messages[-1].get("content") or "")) if messages else 0,
        )
        try:
            session_id, message_id = await trae_remote_client.create_session(
                client,
                token,
                model,
                prepared_messages,
                options=remote_options,
            )
        except Exception as create_exc:
            if not can_work_fallback:
                raise
            logger.warning(
                "remote Agent create failed; falling back to Work id=%s model=%s error=%s",
                str(options.get("_relay_request_id") or ""),
                model,
                create_exc,
            )
            # No session id was returned, so the failed create cannot be
            # stopped. Reuse the acquired account slot with a fresh client.
            failed_client = client
            client = None
            await _await_session_cleanup(asyncio.create_task(failed_client.aclose()))
            client = httpx.AsyncClient(timeout=None)
            remote_options = work_fallback_options(remote_options)
            work_fallback_used = True
            session_id, message_id = await trae_remote_client.create_session(
                client,
                token,
                model,
                prepared_messages,
                options=remote_options,
            )
        _bind_usage_turn(message_id)
        logger.info(
            "remote create ok id=%s chat_session=%s message=%s",
            str(options.get("_relay_request_id") or ""),
            session_id,
            message_id,
        )
        event_iter = trae_remote_client.stream_events(
            client,
            token,
            session_id,
            message_id,
            options=remote_options,
        )
        if stream:
            async def gen():
                nonlocal work_fallback_used
                request_id = str(options.get("_relay_request_id") or "")
                started_at = time.monotonic()
                chunk_count = 0
                tool_chunk_count = 0
                saw_done = False
                stream_status = "running"
                try:
                    try:
                        async for chunk in translate_web_events(
                            event_iter,
                            model,
                            FORWARD_USAGE,
                            fail_on_empty=True,
                            **translation_options,
                        ):
                            _track_usage_from_chunk(chunk, model)
                            chunk_count += 1
                            if '"tool_calls"' in chunk:
                                tool_chunk_count += 1
                            if "data: [DONE]" in chunk:
                                saw_done = True
                                stream_status = "completed"
                            yield chunk
                        stream_status = "completed"
                    except (
                        EmptyUpstreamResponse,
                        trae_remote_client.RemoteFirstEventTimeout,
                    ) as exc:
                        exc_usage = getattr(exc, "usage", None)
                        exc_retryable = bool(getattr(exc, "retryable", True))
                        exc_observed_model_event = bool(
                            getattr(exc, "observed_model_event", False)
                        )
                        if exc_usage is not None:
                            _track_usage_from_exception(exc, model)
                        polling_retry_enabled = bool(
                            auth.get_polling_status().get("enabled")
                        )
                        if (
                            not exc_retryable
                            or work_fallback_used
                            or not (can_work_fallback or polling_retry_enabled)
                        ):
                            logger.warning(
                                "remote empty response is not safe to retry "
                                "id=%s model=%s observed_model_event=%s fallback_used=%s",
                                request_id,
                                model,
                                exc_observed_model_event,
                                work_fallback_used,
                            )
                            raise
                        logger.warning(
                            "remote upstream ended before any model event; "
                            "%s once id=%s model=%s",
                            "falling back to Work" if can_work_fallback and not work_fallback_used else "retrying",
                            request_id,
                            model,
                        )
                        await close_remote_session()
                        slot_reacquired = False
                        retry_client = None
                        retry_session_id = ""
                        retry_message_id = ""
                        retry_account_id = account_id

                        async def cleanup_retry_session() -> None:
                            try:
                                if retry_session_id and retry_client is not None:
                                    try:
                                        await trae_remote_client.stop_session(
                                            retry_client,
                                            retry_token,
                                            retry_session_id,
                                            retry_message_id,
                                            options=retry_options,
                                        )
                                    except Exception:
                                        pass
                            finally:
                                try:
                                    if retry_client is not None:
                                        await retry_client.aclose()
                                finally:
                                    if slot_reacquired:
                                        trae_client.release_web_slot(retry_account_id)

                        try:
                            retry_options = dict(remote_options)
                            retry_model = model
                            if can_work_fallback and not work_fallback_used:
                                retry_options = work_fallback_options(retry_options)
                                work_fallback_used = True
                            retry_token = token
                            # Prefer the same-account Work fallback.  Account
                            # rotation remains the outer retry policy after a
                            # Work attempt is exhausted.
                            if auth.get_polling_status().get("enabled") and not (
                                can_work_fallback and work_fallback_used
                            ):
                                next_snapshot = _next_retry_account_snapshot(
                                    {_retry_account_key(options, 0)}, 1
                                )
                                if next_snapshot is not None:
                                    next_account_id, record = next_snapshot
                                    retry_account_id = next_account_id
                                    retry_token = (
                                        str(record.get("token") or "") or retry_token
                                    )
                                    retry_billing_id = (
                                        _account_id_from_token(retry_token)
                                        or next_account_id
                                    )
                                    retry_options = dict(retry_options)
                                    retry_options["_account_id"] = next_account_id
                                    retry_options["_billing_id"] = retry_billing_id
                                    retry_options["_auth_token"] = retry_token
                                    retry_options["_auth_user_id"] = retry_billing_id
                                    retry_provider = (
                                        record.get("provider_specific")
                                        or record.get("providerSpecificData")
                                        or {}
                                    )
                                    if isinstance(retry_provider, Mapping):
                                        retry_options["provider_specific"] = dict(
                                            retry_provider
                                        )
                                    retry_tracker = _USAGE_TRACKER.get()
                                    if retry_tracker is not None:
                                        await retry_tracker.rebind(retry_options)
                                    _rebind_chat_session_account(
                                        str(
                                            retry_options.get("session_id")
                                            or retry_options.get("sessionId")
                                            or ""
                                        ),
                                        next_account_id,
                                        retry_billing_id,
                                        retry_token,
                                        retry_provider,
                                    )
                            await trae_client.acquire_web_slot(
                                retry_account_id,
                                timeout=float(
                                    os.environ.get("TRAE_WEB_SLOT_TIMEOUT", "60")
                                ),
                            )
                            slot_reacquired = True
                            retry_client = httpx.AsyncClient(timeout=None)
                            logger.info(
                                "remote empty retry start id=%s model=%s account=%s",
                                request_id,
                                model,
                                str(retry_options.get("_account_id") or ""),
                            )
                            retry_session_id, retry_message_id = (
                                await trae_remote_client.create_session(
                                    retry_client,
                                    retry_token,
                                    retry_model,
                                    prepared_messages,
                                    options=retry_options,
                                )
                            )
                            # The first Agent attempt ended before any model
                            # event. Credit enrichment must follow the Work (or
                            # rotated-account) attempt that actually completed.
                            _bind_usage_turn(retry_message_id, replace=True)
                            retry_event_iter = trae_remote_client.stream_events(
                                retry_client,
                                retry_token,
                                retry_session_id,
                                retry_message_id,
                                options=retry_options,
                            )
                            async for chunk in translate_web_events(
                                retry_event_iter,
                                model,
                                FORWARD_USAGE,
                                fail_on_empty=True,
                                **translation_options,
                            ):
                                _track_usage_from_chunk(chunk, model)
                                chunk_count += 1
                                if '"tool_calls"' in chunk:
                                    tool_chunk_count += 1
                                if "data: [DONE]" in chunk:
                                    saw_done = True
                                    stream_status = "completed"
                                yield chunk
                            stream_status = "completed"
                        finally:
                            await _await_session_cleanup(
                                asyncio.create_task(cleanup_retry_session())
                            )
                except asyncio.CancelledError:
                    stream_status = "client_cancelled"
                    raise
                except GeneratorExit:
                    stream_status = "client_closed" if not saw_done else "completed"
                    raise
                except Exception:
                    stream_status = "error"
                    raise
                finally:
                    logger.info(
                        "public stream closed id=%s status=%s chunks=%d "
                        "tool_chunks=%d done=%s elapsed_ms=%d",
                        request_id,
                        stream_status,
                        chunk_count,
                        tool_chunk_count,
                        saw_done,
                        int((time.monotonic() - started_at) * 1000),
                    )
                    await close_remote_session()

            return StreamingResponse(
                _SessionStreamIterator(gen(), close_remote_session),
                media_type="text/event-stream",
                headers=_sse_headers(),
            )
        try:
            result = await collect_nonstream_web(
                event_iter,
                model,
                fail_on_empty=True,
                **translation_options,
            )
            _track_usage_from_result(result, model)
            return JSONResponse(content=result)
        except EmptyUpstreamResponse as exc:
            _track_usage_from_exception(exc, model)
            if not (can_work_fallback and not work_fallback_used and exc.retryable):
                raise
            logger.warning(
                "remote upstream ended before any model event; falling back to Work "
                "id=%s model=%s",
                str(options.get("_relay_request_id") or ""),
                model,
            )
            work_fallback_used = True
            stopped_session_id = session_id
            stopped_message_id = message_id
            session_id = ""
            message_id = ""
            try:
                if stopped_session_id:
                    await _await_session_cleanup(
                        asyncio.create_task(
                            trae_remote_client.stop_session(
                                client,
                                token,
                                stopped_session_id,
                                stopped_message_id,
                                options=remote_options,
                            )
                        )
                    )
            except Exception:
                pass
            remote_options = work_fallback_options(remote_options)
            session_id, message_id = await trae_remote_client.create_session(
                client,
                token,
                model,
                prepared_messages,
                options=remote_options,
            )
            # Replace the empty Agent attempt's message id with the Work turn
            # that produced the response and incurred the final charge.
            _bind_usage_turn(message_id, replace=True)
            fallback_events = trae_remote_client.stream_events(
                client,
                token,
                session_id,
                message_id,
                options=remote_options,
            )
            result = await collect_nonstream_web(
                fallback_events,
                model,
                fail_on_empty=True,
                **translation_options,
            )
            _track_usage_from_result(result, model)
            return JSONResponse(content=result)
        finally:
            await close_remote_session()
    except BaseException:
        await close_remote_session()
        raise


def _effort_note(effort: str, trace: Mapping[str, Any]) -> Optional[str]:
    """Explain why a requested thinking strength was not applied."""

    if not effort or trace.get("reasoning_effort_applied"):
        return None
    mode = str(trace.get("actual_mode") or trace.get("actual_endpoint") or "")
    if mode in {"ide", "solo"}:
        # llm_utils_chat is the IDE/Solo utility route (titles/prompt tools); the
        # real IDE sends strength only via the ai-agent task, so the field is
        # ignored here.
        return "llm_utils_chat 端点不接受强度字段"
    if mode == "raw":
        return "raw 端点需要企业 PAT"
    return "该模型未声明 reasoning_effort_config"


async def run_ide_chat(messages, model, stream: bool, options: Optional[dict] = None):
    """trae2api 风格 IDE chat，流式响应消费完成后关闭 response 和 client。"""
    translation_options = _tool_translation_options(options, messages)
    upstream_metadata: dict[str, Any] = {}
    ide_resp = await trae_client.send_chat_request(messages, model, stream, options=options)
    response = ide_resp.response
    close_response = _chat_response_closer(ide_resp, upstream_metadata)
    if stream:
        async def gen():
            try:
                async for chunk in translate_ide_stream(
                    response,
                    model,
                    FORWARD_USAGE,
                    fail_on_empty=True,
                    upstream_metadata=upstream_metadata,
                    **translation_options,
                ):
                    _bind_usage_turn_from_metadata(upstream_metadata)
                    _track_usage_from_chunk(chunk, model)
                    yield chunk
            finally:
                await close_response()
        try:
            return StreamingResponse(
                _SessionStreamIterator(gen(), close_response),
                media_type="text/event-stream",
                headers=_sse_headers(),
            )
        except BaseException:
            await close_response()
            raise
    try:
        result = await collect_nonstream_ide(
            response,
            model,
            fail_on_empty=True,
            upstream_metadata=upstream_metadata,
            **translation_options,
        )
        _bind_usage_turn_from_metadata(upstream_metadata)
        _track_usage_from_result(result, model)
        return JSONResponse(content=result)
    finally:
        await close_response()


async def run_traework_native_chat(
    messages, model, stream: bool, options: Optional[dict] = None
):
    """TraeWork native AHA bridge backed by an external Windows helper.

    The helper owns ai_agent.dll and sscronet.dll and returns the native SSE
    event stream. Linux deployments receive a clear 502 instead of attempting
    to load a Windows PE DLL.
    """

    translation_options = _tool_translation_options(options, messages)
    upstream_metadata: dict[str, Any] = {}
    native_resp = await traework_native_bridge.send_native_chat_request(
        messages,
        model,
        stream=stream,
        options=options,
    )
    close_response = _chat_response_closer(native_resp, upstream_metadata)
    if stream:
        async def gen():
            try:
                async for chunk in translate_ide_stream(
                    native_resp.response,
                    model,
                    FORWARD_USAGE,
                    fail_on_empty=True,
                    upstream_metadata=upstream_metadata,
                    **translation_options,
                ):
                    _bind_usage_turn_from_metadata(upstream_metadata)
                    _track_usage_from_chunk(chunk, model)
                    yield chunk
            finally:
                await close_response()

        try:
            return StreamingResponse(
                _SessionStreamIterator(gen(), close_response),
                media_type="text/event-stream",
                headers=_sse_headers(),
            )
        except BaseException:
            await close_response()
            raise
    try:
        result = await collect_nonstream_ide(
            native_resp.response,
            model,
            fail_on_empty=True,
            upstream_metadata=upstream_metadata,
            **translation_options,
        )
        _bind_usage_turn_from_metadata(upstream_metadata)
        _track_usage_from_result(result, model)
        return JSONResponse(content=result)
    finally:
        await close_response()


async def run_raw_chat(messages, model, stream: bool, options: Optional[dict] = None):
    """直连 Trae 原生 chat 协议，响应暂复用 IDE SSE 翻译器。"""
    translation_options = _tool_translation_options(options, messages)
    upstream_metadata: dict[str, Any] = {}
    logger.info(
        "raw send start id=%s model=%s messages=%d last_chars=%d",
        str((options or {}).get("_relay_request_id") or ""),
        model,
        len(messages),
        len(str(messages[-1].get("content") or "")) if messages else 0,
    )
    raw_resp = await raw_client.send_raw_chat_request(messages, model, options)
    current = raw_resp
    close_current = _chat_response_closer(current, upstream_metadata)

    async def close_response() -> None:
        await close_current()

    try:
        logger.info(
            "raw send ok id=%s status=%s",
            str((options or {}).get("_relay_request_id") or ""),
            getattr(raw_resp.response, "status_code", 0),
        )
        _capture_chat_session_auth(
            str((options or {}).get("session_id") or ""),
            str(getattr(raw_resp, "auth_token", "") or ""),
        )
    except BaseException:
        await close_response()
        raise
    if stream:
        async def gen():
            nonlocal current, close_current
            request_id = str((options or {}).get("_relay_request_id") or "")
            started_at = time.monotonic()
            chunk_count = 0
            tool_chunk_count = 0
            saw_done = False
            stream_status = "running"
            try:
                retry_options = dict(options or {})
                for attempt in range(2):
                    try:
                        async for chunk in translate_ide_stream(
                            current.response,
                            model,
                            FORWARD_USAGE,
                            fail_on_empty=True,
                            require_terminal=False,
                            upstream_metadata=upstream_metadata,
                            **translation_options,
                        ):
                            _bind_usage_turn_from_metadata(upstream_metadata)
                            chunk_count += 1
                            if '"tool_calls"' in chunk:
                                tool_chunk_count += 1
                            if "data: [DONE]" in chunk:
                                saw_done = True
                                stream_status = "completed"
                            _track_usage_from_chunk(chunk, model)
                            yield chunk
                        stream_status = "completed"
                        return
                    except RepeatedCompletedToolResponse as exc:
                        _track_usage_from_exception(exc, model)
                        logger.warning(
                            "raw upstream repeated an already completed tool call; "
                            "automatic replay is disabled to avoid a second billed turn"
                        )
                        raise
                    except EmptyUpstreamResponse as exc:
                        _bind_usage_turn_from_metadata(upstream_metadata)
                        _track_usage_from_exception(exc, model)
                        if attempt or not exc.retryable:
                            logger.warning(
                                "raw upstream response is not safe to retry "
                                "attempt=%d observed_model_event=%s",
                                attempt + 1,
                                exc.observed_model_event,
                            )
                            raise
                        logger.warning(
                            "raw upstream ended before any model event; retrying once"
                        )
                        retry_options = dict(options or {})
                    finally:
                        await close_response()

                    try:
                        current = await raw_client.send_raw_chat_request(
                            messages, model, retry_options
                        )
                        close_current = _chat_response_closer(current, upstream_metadata)
                        _capture_chat_session_auth(
                            str((options or {}).get("session_id") or ""),
                            str(getattr(current, "auth_token", "") or ""),
                        )
                    except Exception as exc:
                        logger.warning("raw empty-response retry failed: %s", exc)
                        stream_status = "empty_retry_failed"
                        raise
            except asyncio.CancelledError:
                stream_status = "client_cancelled"
                raise
            except GeneratorExit:
                stream_status = "client_closed" if not saw_done else "completed"
                raise
            except Exception:
                stream_status = "error"
                raise
            finally:
                await close_response()
                logger.info(
                    "raw stream closed id=%s status=%s chunks=%d tool_chunks=%d done=%s elapsed_ms=%d",
                    request_id,
                    stream_status,
                    chunk_count,
                    tool_chunk_count,
                    saw_done,
                    int((time.monotonic() - started_at) * 1000),
                )
        try:
            return StreamingResponse(
                _SessionStreamIterator(gen(), close_response),
                media_type="text/event-stream",
                headers=_sse_headers(),
            )
        except BaseException:
            await close_response()
            raise

    retry_options = dict(options or {})
    for attempt in range(2):
        try:
            result = await collect_nonstream_ide(
                current.response,
                model,
                fail_on_empty=True,
                require_terminal=False,
                upstream_metadata=upstream_metadata,
                **translation_options,
            )
            _bind_usage_turn_from_metadata(upstream_metadata)
            _track_usage_from_result(result, model)
            return JSONResponse(content=result)
        except RepeatedCompletedToolResponse as exc:
            _bind_usage_turn_from_metadata(upstream_metadata)
            _track_usage_from_exception(exc, model)
            logger.warning(
                "raw upstream repeated an already completed tool call; "
                "automatic replay is disabled to avoid a second billed turn"
            )
            raise
        except EmptyUpstreamResponse as exc:
            _bind_usage_turn_from_metadata(upstream_metadata)
            _track_usage_from_exception(exc, model)
            if attempt or not exc.retryable:
                logger.warning(
                    "raw upstream response is not safe to retry "
                    "attempt=%d observed_model_event=%s",
                    attempt + 1,
                    exc.observed_model_event,
                )
                raise
            logger.warning(
                "raw upstream ended before any model event; retrying once"
            )
            retry_options = dict(options or {})
        finally:
            await close_response()
        try:
            current = await raw_client.send_raw_chat_request(
                messages, model, retry_options
            )
            close_current = _chat_response_closer(current, upstream_metadata)
            _capture_chat_session_auth(
                str((options or {}).get("session_id") or ""),
                str(getattr(current, "auth_token", "") or ""),
            )
        except BaseException as exc:
            await close_response()
            logger.warning("raw empty-response retry failed: %s", exc)
            raise

    raise RuntimeError("raw empty-response retry ended unexpectedly")


def _openai_error(status: int, message: str, error_type: str, param: Optional[str] = None) -> JSONResponse:
    body = {"error": {"message": message, "type": error_type}}
    if param:
        body["error"]["param"] = param
    return JSONResponse(body, status_code=status)


def _retry_account_key(options: Optional[Mapping[str, Any]], fallback_index: int) -> str:
    options = options or {}
    token = str(options.get("_auth_token") or "")
    token_identity = _account_id_from_token(token)
    if token_identity:
        # The JWT owner is the account Trae actually bills. Two stale account
        # rows that reference the same JWT must not receive this request twice.
        return token_identity
    if token:
        return "token:" + hashlib.sha256(token.encode("utf-8")).hexdigest()
    account_id = str(
        options.get("_account_id")
        or options.get("_billing_id")
        or auth.get_active_account_id()
        or ""
    )
    if account_id:
        return account_id
    return f"attempt-{fallback_index}"


def _polling_retry_limit(options: Optional[Mapping[str, Any]]) -> int:
    """Count usable polling accounts without granting an extra retry."""

    account_ids: set[str] = set()
    anonymous_accounts = 0
    for account in auth.list_accounts():
        if isinstance(account, Mapping):
            if (
                account.get("is_valid") is False
                or account.get("model_enabled") is False
                or account.get("model_eligible") is False
            ):
                continue
            account_id = str(account.get("id") or "")
            if account_id:
                account_ids.add(account_id)
            else:
                anonymous_accounts += 1
        else:
            anonymous_accounts += 1
    bound_account = str((options or {}).get("_account_id") or "")
    if bound_account and auth._record_model_enabled(auth.get_account_record(bound_account)):
        account_ids.add(bound_account)
    return max(1, len(account_ids) + anonymous_accounts)


def _next_retry_account_snapshot(
    attempted_accounts: set[str], max_rotations: int
) -> tuple[str, dict] | None:
    """Rotate to an account that has not already received this request."""

    for rotation_index in range(max(1, max_rotations)):
        auth.next_polling_account()
        account_id, record = auth.get_active_account_snapshot()
        safe_record = dict(record) if isinstance(record, Mapping) else {}
        if not auth._record_model_enabled(safe_record):
            continue
        candidate_options = {
            "_account_id": str(account_id or ""),
            "_auth_token": str(safe_record.get("token") or ""),
        }
        account_key = _retry_account_key(candidate_options, rotation_index)
        if account_key not in attempted_accounts:
            return str(account_id or ""), safe_record
    return None


async def _run_web_with_retry(
    messages,
    model,
    stream: bool,
    options: Optional[dict] = None,
    *,
    tracker: Optional[_UsageTracker] = None,
):
    """web 上游 429 并发限制时轮询切换账号重试。"""
    tracker = tracker or _USAGE_TRACKER.get()
    if auth.get_polling_status().get("enabled"):
        attempts = _polling_retry_limit(options)
        attempted_accounts: set[str] = set()
        for attempt_index in range(attempts):
            account_key = _retry_account_key(options, attempt_index)
            if account_key in attempted_accounts:
                break
            attempted_accounts.add(account_key)
            try:
                return await run_web_session(messages, model, stream, options)
            except RuntimeError as e:
                err = str(e)
                if "solo_agent_parallel_limit" in err or "429" in err:
                    if attempt_index + 1 >= attempts:
                        break
                    logger.warning("web 429 parallel limit, rotating account: %s", err)
                    next_snapshot = _next_retry_account_snapshot(
                        attempted_accounts, attempts
                    )
                    if next_snapshot is None:
                        break
                    # Rebind options from the newly rotated account so the
                    # retry uses the correct token and billing identity.
                    account_id, record = next_snapshot
                    token = str(record.get("token") or "")
                    billing_id = _account_id_from_token(token) or account_id
                    provider_specific = (
                        record.get("provider_specific")
                        or record.get("providerSpecificData")
                        or {}
                    )
                    options = dict(options or {})
                    options["_account_id"] = account_id
                    options["_billing_id"] = billing_id
                    options["_auth_token"] = token
                    options["_auth_user_id"] = billing_id
                    if isinstance(provider_specific, Mapping):
                        options["provider_specific"] = dict(provider_specific)
                    if tracker is not None:
                        await tracker.rebind(options)
                    _rebind_chat_session_account(
                        str(options.get("session_id") or options.get("sessionId") or ""),
                        account_id,
                        billing_id,
                        token,
                        provider_specific,
                    )
                    continue
                raise
        raise RuntimeError("All web accounts busy: Trae parallel limit reached")
    return await run_web_session(messages, model, stream, options)


async def _run_remote_with_retry(
    messages,
    model,
    stream,
    options: Optional[dict] = None,
    *,
    tracker: Optional[_UsageTracker] = None,
):
    """Retry 9router-style remote sessions on the provider's parallel limit."""
    tracker = tracker or _USAGE_TRACKER.get()
    if auth.get_polling_status().get("enabled"):
        attempts = _polling_retry_limit(options)
        attempted_accounts: set[str] = set()

        async def rotate_remote_account(reason: str) -> bool:
            nonlocal options
            logger.warning("remote %s, rotating account", reason)
            next_snapshot = _next_retry_account_snapshot(
                attempted_accounts, attempts
            )
            if next_snapshot is None:
                return False
            account_id, record = next_snapshot
            token = str(record.get("token") or "")
            billing_id = _account_id_from_token(token) or account_id
            provider_specific = (
                record.get("provider_specific")
                or record.get("providerSpecificData")
                or {}
            )
            options = dict(options or {})
            options["_account_id"] = account_id
            options["_billing_id"] = billing_id
            options["_auth_token"] = token
            options["_auth_user_id"] = billing_id
            if isinstance(provider_specific, Mapping):
                options["provider_specific"] = dict(provider_specific)
            if tracker is not None:
                await tracker.rebind(options)
            _rebind_chat_session_account(
                str(options.get("session_id") or options.get("sessionId") or ""),
                account_id,
                billing_id,
                token,
                provider_specific,
            )
            return True

        for attempt_index in range(attempts):
            account_key = _retry_account_key(options, attempt_index)
            if account_key in attempted_accounts:
                break
            attempted_accounts.add(account_key)
            try:
                return await run_remote_session(messages, model, stream, options)
            except EmptyUpstreamResponse as exc:
                if not exc.retryable or attempt_index + 1 >= attempts:
                    raise
                if not await rotate_remote_account(
                    "upstream returned an empty response"
                ):
                    raise
                continue
            except RuntimeError as exc:
                message = str(exc)
                lowered = message.lower()
                unavailable = (
                    "remote model is not available for the bound account" in lowered
                    or "model binding mismatch" in lowered
                )
                if unavailable:
                    # Model entitlements differ per account. A bound account
                    # missing the requested model is not a request failure;
                    # rotate to the next polling account that can serve it.
                    reason = "model unavailable on bound account"
                elif "parallel" in lowered or "429" in lowered:
                    reason = "parallel limit"
                else:
                    raise
                if attempt_index + 1 >= attempts:
                    if unavailable:
                        raise
                    break
                if not await rotate_remote_account(reason):
                    if unavailable:
                        raise
                    break
                continue
        raise RuntimeError("All remote accounts busy: Trae parallel limit reached")
    return await run_remote_session(messages, model, stream, options)


def _normalize_usage_record(record: Mapping[str, Any]) -> dict[str, Any]:
    normalized = dict(record)
    values = _usage_values(record)
    prompt = values["prompt_tokens"]
    completion = values["completion_tokens"]
    total = values["total_tokens"] or prompt + completion
    credits = values.get("credits_consumed")
    requested_effort = (
        record.get("reasoning_effort")
        or record.get("requested_reasoning_effort")
        or record.get("reasoning_effort_requested")
        or record.get("thinking_effort")
    )
    applied_effort = (
        record.get("reasoning_effort_applied")
        or record.get("applied_reasoning_effort")
        or record.get("native_reasoning_effort")
    )
    requested_context = (
        record.get("context_mode_requested")
        or record.get("requested_context_mode")
    )
    context_mode = (
        record.get("context_mode")
        or record.get("contextMode")
        or record.get("context_window_mode")
    )
    actual_context_mode = (
        record.get("context_mode_actual")
        or record.get("actual_context_mode")
    )
    # Older rows recorded the requested standard profile but did not persist
    # an explicit actual/max result.  Standard is deterministic in that case:
    # expose it as an actual non-Max request instead of rendering ``--`` in
    # the console.  Unknown/custom profiles remain unknown.
    requested_context_bool = _context_mode_bool(requested_context)
    if context_mode in (None, "") and requested_context_bool is False:
        context_mode = "standard"
    if actual_context_mode in (None, "") and requested_context_bool is False:
        actual_context_mode = "standard"
    max_applied = _optional_bool(record.get("max_mode_applied"))
    if max_applied is None:
        max_applied = _optional_bool(record.get("max_mode_enabled"))
    if max_applied is None:
        max_applied = _optional_bool(record.get("max_mode"))
    if context_mode in (None, "") and max_applied is not None:
        context_mode = "max_1m" if max_applied else "standard"
    if context_mode in (None, "") and actual_context_mode not in (None, ""):
        context_mode = actual_context_mode
    if actual_context_mode in (None, "") and max_applied is not None:
        actual_context_mode = "max_1m" if max_applied else "standard"
    if actual_context_mode in (None, "") and context_mode not in (None, ""):
        actual_context_mode = context_mode
    # Keep explicit boolean metadata alongside the human-readable context
    # fields.  The booleans are easier for API clients and daily aggregation
    # to consume, while the legacy fields remain available for old consoles.
    max_mode_requested = _optional_bool(
        record.get("max_mode_requested")
        if "max_mode_requested" in record
        else None
    )
    if max_mode_requested is None and requested_context not in (None, ""):
        max_mode_requested = _context_mode_bool(requested_context)
    if max_mode_requested is None and "max_mode" in record:
        max_mode_requested = _optional_bool(record.get("max_mode"))
    max_mode_enabled = _optional_bool(
        record.get("max_mode_enabled")
        if "max_mode_enabled" in record
        else None
    )
    if max_mode_enabled is None:
        max_mode_enabled = max_applied
    if max_mode_enabled is None and actual_context_mode not in (None, ""):
        max_mode_enabled = _context_mode_bool(actual_context_mode)
    tool_used = _optional_bool(record.get("tool_used"))
    tools_requested = _optional_bool(
        record.get("tools_requested")
        if "tools_requested" in record
        else record.get("tool_protocol_requested")
    )
    tool_calls_returned = _optional_bool(
        record.get("tool_calls_returned")
        if "tool_calls_returned" in record
        else record.get("tool_call_returned")
    )
    tool_called = _optional_bool(
        record.get("tool_called") if "tool_called" in record else None
    )
    if tool_called is None:
        # ``tool_used`` is the canonical actual-result marker in v1.0.2;
        # ``tool_calls_returned`` is retained for compatibility with rows
        # written by the stream parser.
        tool_called = tool_used
    if tool_called is None:
        tool_called = tool_calls_returned
    context_window_tokens = _number_value(
        record.get("context_window_tokens")
        or record.get("max_context_tokens")
    )
    normalized.update(
        {
            "account_id": str(record.get("account_id") or "default"),
            "model": str(record.get("model") or "auto"),
            "prompt_tokens": prompt,
            "completion_tokens": completion,
            "input_tokens": prompt,
            "output_tokens": completion,
            "total_tokens": total,
            "cached_tokens": int(values.get("cached_tokens") or 0),
            "tokens_source": str(
                record.get("tokens_source")
                or (
                    "upstream"
                    if any(
                        key in record
                        for key in (
                            "prompt_tokens",
                            "completion_tokens",
                            "input_tokens",
                            "output_tokens",
                            "total_tokens",
                        )
                    )
                    else "unknown"
                )
            ),
            "credits_consumed": _credit_round(credits),
            "credits_source": str(
                record.get("credits_source")
                or ("upstream" if credits is not None else "unknown")
            ),
            "request_id": str(record.get("request_id") or ""),
            "endpoint": record.get("endpoint") or None,
            "stream": record.get("stream") if "stream" in record else None,
            "status": str(record.get("status") or "completed"),
            "duration_ms": _number_value(record.get("duration_ms")),
            "timestamp": _number_value(record.get("timestamp")) or 0,
            # Request metadata is kept separate from token accounting so old
            # rows can still be rendered with an explicit unknown marker.
            "reasoning_effort": (
                str(requested_effort).strip()
                if requested_effort not in (None, "")
                else None
            ),
            "requested_reasoning_effort": (
                str(requested_effort).strip()
                if requested_effort not in (None, "")
                else None
            ),
            "reasoning_effort_applied": (
                str(applied_effort).strip()
                if applied_effort not in (None, "")
                else None
            ),
            "context_mode_requested": (
                str(requested_context).strip()
                if requested_context not in (None, "")
                else None
            ),
            "context_mode": (
                str(context_mode).strip()
                if context_mode not in (None, "")
                else None
            ),
            "context_mode_actual": (
                str(actual_context_mode).strip()
                if actual_context_mode not in (None, "")
                else None
            ),
            "context_window_tokens": context_window_tokens,
            "max_mode_applied": max_applied,
            "max_mode_requested": max_mode_requested,
            "max_mode_enabled": max_mode_enabled,
            # Stable aliases for API clients and older frontends.  The
            # canonical fields above retain the requested-vs-actual
            # distinction; these aliases represent the actual observed
            # capability when it is known.
            "max_mode": max_mode_enabled,
            "tools_requested": tools_requested,
            "tool_used": tool_used,
            "tool_calls_returned": tool_calls_returned,
            "tool_called": tool_called,
            "tool": tool_called,
        }
    )
    return normalized


def _save_usage_history_locked() -> None:
    try:
        _USAGE_RECORDS_PATH.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": 1,
            "records": _USAGE_HISTORY[:_USAGE_MAX_HISTORY],
        }
        temporary = _USAGE_RECORDS_PATH.with_name(
            _USAGE_RECORDS_PATH.name + ".tmp"
        )
        temporary.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            "utf-8",
        )
        os.replace(temporary, _USAGE_RECORDS_PATH)
    except Exception as exc:
        logger.warning("usage records could not be saved: %s", exc)


def _load_usage_history() -> None:
    global _USAGE_HISTORY
    try:
        if not _USAGE_RECORDS_PATH.exists():
            return
        payload = json.loads(_USAGE_RECORDS_PATH.read_text("utf-8"))
        records = payload.get("records", []) if isinstance(payload, dict) else payload
        if not isinstance(records, list):
            raise ValueError("usage records must be a list")
        normalized = [
            _normalize_usage_record(record)
            for record in records
            if isinstance(record, Mapping)
        ][:_USAGE_MAX_HISTORY]
        with _USAGE_LOCK:
            _USAGE_HISTORY = normalized
    except Exception as exc:
        logger.warning("usage records could not be loaded: %s", exc)


def _usage_day(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, _CHECKIN_TIMEZONE).strftime("%Y-%m-%d")


def _empty_usage_bucket() -> dict[str, Any]:
    bucket: dict[str, Any] = {key: 0 for key in _USAGE_STATS_FIELDS}
    bucket["credits"] = 0.0
    bucket["models"] = {}
    return bucket


def _usage_contribution(record: Mapping[str, Any]) -> dict[str, Any]:
    status = str(record.get("status") or "completed")
    credits = _number_value(record.get("credits_consumed"))
    return {
        "model": str(record.get("model") or "auto"),
        "requests": 1,
        "completed": 1 if status == "completed" else 0,
        "failed": 1 if status == "error" else 0,
        "input_tokens": int(record.get("input_tokens") or 0),
        "output_tokens": int(record.get("output_tokens") or 0),
        "cached_tokens": int(record.get("cached_tokens") or 0),
        "total_tokens": int(record.get("total_tokens") or 0),
        "credits": float(credits or 0),
        "max_mode_requests": 1
        if _optional_bool(record.get("max_mode_requested")) is True
        else 0,
        "max_mode_enabled_requests": 1
        if _optional_bool(record.get("max_mode_enabled")) is True
        else 0,
        "tool_requests": 1
        if _optional_bool(record.get("tools_requested")) is True
        else 0,
        "tool_calls": 1
        if _optional_bool(record.get("tool_called")) is True
        else 0,
    }


def _apply_usage_contribution_locked(
    day: str, contribution: Mapping[str, Any], sign: int
) -> None:
    days = _USAGE_STATS.setdefault("days", {})
    bucket = days.setdefault(day, _empty_usage_bucket())
    for key in _USAGE_STATS_FIELDS:
        value = bucket.get(key, 0) + sign * contribution.get(key, 0)
        bucket[key] = max(0, round(value, 4) if key == "credits" else int(value))
    models = bucket.setdefault("models", {})
    model = contribution.get("model") or "auto"
    entry = models.setdefault(
        model, {"requests": 0, "input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
    )
    for key in ("requests", "input_tokens", "output_tokens", "total_tokens"):
        entry[key] = max(0, int(entry.get(key, 0) + sign * contribution.get(key, 0)))
    if entry["requests"] == 0:
        models.pop(model, None)
    if len(days) > _USAGE_STATS_MAX_DAYS:
        for stale in sorted(days)[: len(days) - _USAGE_STATS_MAX_DAYS]:
            days.pop(stale, None)


def _usage_stats_replace_locked(
    previous: Mapping[str, Any] | None, record: Mapping[str, Any]
) -> None:
    """Move one request's contribution from its previous form to ``record``.

    Records are rewritten in place (same request id) when retries settle or
    credits are enriched later; subtracting the old row keeps totals exact.
    """
    if previous is not None:
        day = _usage_day(float(previous.get("timestamp") or 0) or time.time())
        _apply_usage_contribution_locked(day, _usage_contribution(previous), -1)
    day = _usage_day(float(record.get("timestamp") or 0) or time.time())
    _apply_usage_contribution_locked(day, _usage_contribution(record), 1)
    _save_usage_stats_locked()


def _usage_stats_path() -> Path:
    # Sits next to usage_records.json unless explicitly overridden, so a
    # relocated records path (tests, alternate data dirs) moves both files.
    if _USAGE_STATS_PATH_OVERRIDE:
        return Path(_USAGE_STATS_PATH_OVERRIDE)
    return _USAGE_RECORDS_PATH.with_name("usage_stats.json")


def _save_usage_stats_locked() -> None:
    try:
        path = _usage_stats_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"version": 1, "days": _USAGE_STATS.get("days", {})}
        temporary = path.with_name(path.name + ".tmp")
        temporary.write_text(json.dumps(payload, ensure_ascii=False) + "\n", "utf-8")
        os.replace(temporary, path)
    except Exception as exc:
        logger.warning("usage stats could not be saved: %s", exc)


def _load_usage_stats() -> None:
    """Load daily totals, seeding them once from the request history."""
    global _USAGE_STATS
    try:
        path = _usage_stats_path()
        if path.exists():
            payload = json.loads(path.read_text("utf-8"))
            days = payload.get("days") if isinstance(payload, dict) else None
            if not isinstance(days, dict):
                raise ValueError("usage stats must contain a days mapping")
            with _USAGE_LOCK:
                _USAGE_STATS = {"days": days}
            return
        with _USAGE_LOCK:
            _USAGE_STATS = {"days": {}}
            for record in _USAGE_HISTORY:
                day = _usage_day(float(record.get("timestamp") or 0) or time.time())
                _apply_usage_contribution_locked(day, _usage_contribution(record), 1)
            if _USAGE_HISTORY:
                _save_usage_stats_locked()
    except Exception as exc:
        logger.warning("usage stats could not be loaded: %s", exc)


def _usage_overview(days: int = 30) -> dict[str, Any]:
    days = max(1, min(int(days or 30), 366))
    now = time.time()
    today = _usage_day(now)
    with _USAGE_LOCK:
        stored = json.loads(json.dumps(_USAGE_STATS.get("days", {})))
    totals = _empty_usage_bucket()
    totals.pop("models")
    for bucket in stored.values():
        for key in _USAGE_STATS_FIELDS:
            totals[key] += bucket.get(key, 0)
    totals["credits"] = round(totals["credits"], 2)
    start = datetime.fromtimestamp(now, _CHECKIN_TIMEZONE).date()
    daily = []
    for offset in range(days):
        day = (start - timedelta(days=offset)).strftime("%Y-%m-%d")
        bucket = stored.get(day) or _empty_usage_bucket()
        models = sorted(
            (
                {"model": name, **values}
                for name, values in (bucket.get("models") or {}).items()
            ),
            key=lambda item: item.get("total_tokens", 0),
            reverse=True,
        )
        daily.append(
            {
                "date": day,
                **{key: bucket.get(key, 0) for key in _USAGE_STATS_FIELDS},
                "credits": round(float(bucket.get("credits") or 0), 2),
                "models": models[:6],
            }
        )
    return {
        "today": next((row for row in daily if row["date"] == today), daily[0]),
        "totals": totals,
        "active_days": sum(1 for bucket in stored.values() if bucket.get("requests")),
        "first_day": min(stored) if stored else None,
        "daily": daily,
    }


def _record_usage(
    account_id: str,
    model: str,
    prompt_tokens: int,
    completion_tokens: int,
    *,
    credits_consumed: int | float | None = None,
    credits_source: str = "unknown",
    request_id: str = "",
    endpoint: str | None = None,
    stream: bool | None = None,
    status: str = "completed",
    duration_ms: int | float | None = None,
    tokens_source: str = "upstream",
    cached_tokens: int = 0,
    reasoning_effort: str | None = None,
    requested_reasoning_effort: str | None = None,
    reasoning_effort_applied: str | None = None,
    context_mode_requested: str | None = None,
    context_mode: str | None = None,
    context_mode_actual: str | None = None,
    context_window_tokens: int | float | None = None,
    max_mode_applied: bool | None = None,
    max_mode_requested: bool | None = None,
    max_mode_enabled: bool | None = None,
    tools_requested: bool | None = None,
    tool_used: bool | None = None,
    tool_calls_returned: bool | None = None,
    tool_called: bool | None = None,
) -> dict[str, Any]:
    """Record one API request (newest first) and persist it independently."""
    global _USAGE_HISTORY
    record = _normalize_usage_record(
        {
            "account_id": account_id,
            "model": model,
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
            "cached_tokens": cached_tokens,
            "tokens_source": tokens_source,
            "credits_consumed": credits_consumed,
            "credits_source": credits_source,
            "request_id": request_id,
            "endpoint": endpoint,
            "stream": stream,
            "status": status,
            "duration_ms": duration_ms,
            "timestamp": time.time(),
            "reasoning_effort": reasoning_effort,
            "requested_reasoning_effort": requested_reasoning_effort,
            "reasoning_effort_applied": reasoning_effort_applied,
            "context_mode_requested": context_mode_requested,
            "context_mode": context_mode,
            "context_mode_actual": context_mode_actual,
            "context_window_tokens": context_window_tokens,
            "max_mode_applied": max_mode_applied,
            "max_mode_requested": max_mode_requested,
            "max_mode_enabled": max_mode_enabled,
            "tools_requested": tools_requested,
            "tool_used": tool_used,
            "tool_calls_returned": tool_calls_returned,
            "tool_called": tool_called,
        }
    )
    with _USAGE_LOCK:
        previous = None
        if request_id:
            for index, existing in enumerate(_USAGE_HISTORY):
                if existing.get("request_id") == request_id:
                    previous = existing
                    # Keep the original day bucket for a rewritten request.
                    record["timestamp"] = existing.get("timestamp") or record["timestamp"]
                    _USAGE_HISTORY[index] = record
                    break
            else:
                _USAGE_HISTORY.insert(0, record)
        else:
            _USAGE_HISTORY.insert(0, record)
        _usage_stats_replace_locked(previous, record)
        if len(_USAGE_HISTORY) > _USAGE_MAX_HISTORY:
            _USAGE_HISTORY = _USAGE_HISTORY[:_USAGE_MAX_HISTORY]
        _save_usage_history_locked()
    return record


def _upstream_response_error(response: Any) -> str:
    """Return a concise error for an upstream response, or ``""``.

    Adapters normally raise on non-2xx responses, but a few native bridges
    return a JSON error response instead.  Treat both forms uniformly so the
    dispatcher can continue to the configured Remote fallback.
    """

    status = int(getattr(response, "status_code", 200) or 200)
    if status < 400:
        return ""
    payload = _response_json_payload(response)
    error = payload.get("error") if isinstance(payload, Mapping) else None
    if isinstance(error, Mapping):
        message = str(error.get("message") or "").strip()
    else:
        message = str(error or "").strip()
    return f"HTTP {status}: {message or 'upstream returned an error'}"


def _remote_fallback_options(
    options: Optional[Mapping[str, Any]], requested_mode: str
) -> dict[str, Any]:
    """Build options for a native-endpoint -> Remote fallback attempt."""

    fallback = dict(options or {})
    fallback["_upstream_mode"] = "remote"
    fallback["_upstream_fallback_from"] = requested_mode
    # ``work-agent`` is a selectable Work tier, but its fallback must be the
    # ordinary Remote/Agent tier.  Carrying ``solo_work_remote`` (or
    # ``_trae_mode=work``) here only changes the log label while issuing a
    # second Work request, which is why the UI appeared to "fall back to
    # Remote" without ever leaving Work.  Native TraeWork compatibility modes
    # retain their historical Work-tier fallback because they are separate
    # helper transports.
    if requested_mode == "work-agent":
        fallback.pop("_trae_mode", None)
        fallback.pop("_remote_agent_type", None)
        fallback.pop("remote_agent_type", None)
        fallback["_remote_agent_type"] = "solo_agent_remote"
    elif not (
        fallback.get("_remote_agent_type")
        or fallback.get("remote_agent_type")
    ):
        fallback_agent_type = (
            "solo_work_remote"
            if requested_mode in {
                "traework-native",
                "native",
                "traework",
            }
            else "solo_agent_remote"
        )
        fallback["_remote_agent_type"] = fallback_agent_type
    fallback.setdefault("_session_variant", f"{requested_mode}-fallback")
    return fallback


def _update_usage_record(request_id: str, **updates: Any) -> None:
    if not request_id:
        return
    with _USAGE_LOCK:
        for index, existing in enumerate(_USAGE_HISTORY):
            if existing.get("request_id") != request_id:
                continue
            merged = dict(existing)
            merged.update(updates)
            # Round credit fields before normalizing
            for key in ("credits_consumed", "credits_before", "credits_after"):
                if key in merged:
                    merged[key] = _credit_round(merged[key])
            _USAGE_HISTORY[index] = _normalize_usage_record(merged)
            _usage_stats_replace_locked(existing, _USAGE_HISTORY[index])
            _save_usage_history_locked()
            return


# Raw v2 answers ``2001 failed to get app config: record not found`` when the
# account has no enterprise app config.  That is deterministic, so remember it
# briefly and route straight to the next candidate instead of paying the
# round-trip on every request.
_RAW_APP_CONFIG_MISSING: dict[str, float] = {}
_RAW_APP_CONFIG_TTL_SECONDS = 600.0


def _raw_app_config_missing_error(error: Any) -> bool:
    text = str(error or "").lower()
    return "app config" in text and "record not found" in text


def _raw_app_config_key(model: Any, options: Mapping) -> str:
    return f"{options.get('_account_id') or 'default'}|{str(model or '').lower()}"


def _raw_app_config_known_missing(model: Any, options: Mapping) -> bool:
    if not options.get("_account_id"):
        return False
    key = _raw_app_config_key(model, options)
    expires = _RAW_APP_CONFIG_MISSING.get(key)
    if not expires:
        return False
    if expires < time.monotonic():
        _RAW_APP_CONFIG_MISSING.pop(key, None)
        return False
    return True


AUTO_ROUTE_MODE = "auto-route"
# Endpoints chosen by auto routing. IDE Agent passes the full tool suite
# (including parallel calls); Remote is the general chat path and the final
# fallback for everything.
AUTO_ROUTE_TOOL_ENDPOINT = "ide"
AUTO_ROUTE_CHAT_ENDPOINT = "remote"


def _auto_route_enabled() -> bool:
    try:
        return bool(auth.get_auto_route_settings().get("enabled"))
    except Exception:
        return False


def _apply_auto_route(
    messages: Optional[list[dict]], options: Optional[dict]
) -> dict:
    """Resolve the endpoint for one request when auto routing applies.

    Auto routing runs when the caller asked for ``auto-route`` explicitly, or
    when the console switch is on and the request carries no explicit
    endpoint.  Tool requests (tool definitions or tool history) go to IDE
    Agent, plain chat goes to Remote; the dispatcher's existing fallback then
    lands on Remote if the chosen endpoint fails.
    """

    options = dict(options or {})
    explicit = str(options.get("_upstream_mode") or "").strip().lower()
    if explicit and explicit != AUTO_ROUTE_MODE:
        return options
    if options.get("_traework_custom_model"):
        return options
    if not explicit:
        if not _auto_route_enabled():
            return options
        # Local CLI / native helper modes are host-specific; leave them alone.
        if _current_upstream_mode() in (
            "cli", "traework-native", "native", "traework"
        ):
            return options
    uses_tools = _tool_protocol_requested(options, messages)
    endpoint = AUTO_ROUTE_TOOL_ENDPOINT if uses_tools else AUTO_ROUTE_CHAT_ENDPOINT
    options["_upstream_mode"] = endpoint
    options["_auto_route"] = "tools" if uses_tools else "chat"
    trace = options.get("_upstream_trace")
    if isinstance(trace, dict):
        trace.update(auto_route=True, auto_route_reason=options["_auto_route"])
    logger.info(
        "auto route id=%s model_request=%s endpoint=%s",
        str(options.get("_relay_request_id") or ""),
        options["_auto_route"],
        endpoint,
    )
    return options


def _trace_failure_reason(endpoint: str, error: Any) -> str:
    """Return a bounded, readable endpoint failure diagnostic."""

    detail = str(error or "upstream request failed").strip().replace("\r", " ").replace("\n", " ")
    if len(detail) > 400:
        detail = detail[:397] + "..."
    return f"{endpoint}: {detail}" if endpoint else detail


def _trace_append_failure(trace: Any, endpoint: str, error: Any) -> None:
    """Append one endpoint failure to the request trace without duplication."""

    if not isinstance(trace, dict):
        return
    item = _trace_failure_reason(endpoint, error)
    previous = str(trace.get("fallback_reason") or "").strip()
    parts = [part.strip() for part in previous.split(";") if part.strip()]
    if item not in parts:
        parts.append(item)
    trace["fallback_reason"] = "; ".join(parts)[:1200]
    if endpoint:
        failed = [part.strip() for part in str(trace.get("failed_endpoint") or "").split(",") if part.strip()]
        if endpoint not in failed:
            failed.append(endpoint)
        trace["failed_endpoint"] = ",".join(failed)


async def _dispatch_chat(messages, model, stream: bool, options: Optional[dict] = None):
    options = _apply_auto_route(messages, options)
    try:
        _ensure_model_account_enabled(
            str(options.get("_account_id") or ""),
            str(options.get("_auth_token") or ""),
        )
    except _ModelAccountUnavailable as exc:
        return _openai_error(503, str(exc), "model_account_unavailable")
    active_mode = str(options.get("_upstream_mode") or _current_upstream_mode()).lower()
    trace = options.get("_upstream_trace")
    fallback_from = str(options.get("_upstream_fallback_from") or "").strip().lower()
    if isinstance(trace, dict):
        if fallback_from:
            # A streaming/native fallback re-enters this dispatcher with the
            # same trace object. Preserve the original requested endpoint and
            # reason while updating the current target.
            trace.setdefault("requested_mode", fallback_from)
            trace.setdefault("requested_endpoint", fallback_from)
            trace.update(
                actual_mode="",
                actual_endpoint="",
                fallback_used=True,
                fallback_target=active_mode,
            )
        else:
            trace.update(
                requested_mode=active_mode,
                requested_endpoint=active_mode,
                actual_mode="",
                actual_endpoint="",
                fallback_used=False,
                fallback_reason="",
                fallback_target="",
                failed_endpoint="",
            )
    logger.info(
        "dispatch start model=%s stream=%s messages=%d last_role=%s last_chars=%d "
        "tools=%s session=%s",
        model,
        stream,
        len(messages or []),
        (messages[-1].get("role") if messages and isinstance(messages[-1], Mapping) else ""),
        (len(str(messages[-1].get("content") or "")) if messages and isinstance(messages[-1], Mapping) else 0),
        _tool_protocol_requested(options, messages),
        str(options.get("session_id") or options.get("sessionId") or "")[:16],
    )
    if not str(model or "").strip():
        return _openai_error(
            400,
            "model is required and cannot be blank",
            "invalid_request_error",
            "model",
        )
    if not trae_client.is_model_supported(model):
        return _openai_error(400, f"Unsupported model: {model}", "invalid_request_error", "model")

    # TraeWork's custom-model adapter is a separate ingress contract while the
    # actual file/shell tools remain owned by the Windows client. The official
    # raw endpoint currently returns a business authentication error for these
    # account credentials, so the verified remote transport is the default.
    # Keep raw/direct as explicit diagnostics instead of advertising a fallback
    # that cannot catch errors raised later by a StreamingResponse iterator.
    if options.get("_traework_custom_model"):
        custom_mode = str(
            options.get("_traework_upstream_mode")
            or os.environ.get("TRAEWORK_CUSTOM_UPSTREAM_MODE", "remote")
        ).strip().lower()
        if custom_mode in {"raw", "direct", "auto"}:
            logger.info(
                "dispatch TraeWork custom-model ingress id=%s mode=raw model=%s",
                str(options.get("_relay_request_id") or ""),
                model,
            )
            return await run_raw_chat(messages, model, stream, options)
        if custom_mode in {"remote", "web"}:
            logger.info(
                "dispatch TraeWork custom-model ingress id=%s mode=%s model=%s",
                str(options.get("_relay_request_id") or ""),
                custom_mode,
                model,
            )
            if custom_mode == "web":
                return await _run_web_with_retry(messages, model, stream, options)
            return await _run_remote_with_retry(messages, model, stream, options)
        raise RuntimeError(
            "Unsupported TRAEWORK_CUSTOM_UPSTREAM_MODE: " + custom_mode
        )

    # External tools always execute on the API caller.  Web/IDE agent routes
    # may execute their own tools on the relay host, so they are never valid
    # fallbacks for a request that advertises caller-owned tools.
    tool_protocol_requested = _tool_protocol_requested(options, messages)
    # Caller-owned tools are now supported on all upstream paths.
    # Remote/web routes inject tool definitions as a system prompt via
    # `_messages_with_client_runtime` and filter tool calls from the
    # upstream text response with `_filter_tool_calls`.
    if tool_protocol_requested:
        logger.info(
            "dispatch tool protocol id=%s mode=%s model=%s",
            str(options.get("_relay_request_id") or ""),
            active_mode,
            model,
        )

    # Raw v2 is the default for every model. Operators can opt specific models
    # (or ``*``) into the account-bound remote executor for diagnostics.
    if not options.get("_disable_upstream_fallback") and _requires_remote_model(model) and active_mode in (
        "raw",
        "direct",
        "auto",
        "ide",
        "solo",
    ):
        logger.info(
            "dispatch remote-only model id=%s model=%s account=%s",
            str(options.get("_relay_request_id") or ""),
            model,
            str(options.get("_account_id") or "default"),
        )
        try:
            if isinstance(trace, dict):
                trace.update(
                    actual_mode="remote",
                    actual_endpoint="remote",
                    fallback_used=True,
                    fallback_target="remote",
                )
                _trace_append_failure(
                    trace,
                    active_mode,
                    "model is configured for the Remote executor",
                )
            return await _run_remote_with_retry(messages, model, stream, options)
        except ModelProviderMismatch as exc:
            _trace_append_failure(trace, "remote", exc)
            logger.error(
                "remote provider model mismatch id=%s requested=%s error=%s",
                str(options.get("_relay_request_id") or ""),
                model,
                exc,
            )
            return _openai_error(502, str(exc), "upstream_model_mismatch", "model")

    # ``auto`` is the direct-proxy mode: every model request reaches Trae's
    # native llm_utils_chat endpoint. Legacy modes remain explicit opt-ins for
    # diagnostics, but they are never silent fallbacks for API traffic.
    errors = []
    fallback_reasons: list[str] = []
    modes = []
    if active_mode == "cli":
        modes = ["cli"]
    elif active_mode in ("raw", "direct"):
        modes = ["raw"]
    elif active_mode in ("remote", "9router", "trae-remote"):
        modes = ["remote"]
    elif active_mode == "web":
        modes = ["web"]
    elif active_mode in ("ide", "solo"):
        modes = [active_mode]
    elif active_mode == "work-agent":
        modes = ["work-agent"]
    elif active_mode in ("traework-native", "native", "traework"):
        modes = ["traework-native"]
    else:
        modes = ["raw"]

    # Native IDE/Work/Raw paths are useful diagnostics, but the current CN
    # gateway does not expose all three paths for every account.  Keep the
    # selected path first and automatically try the verified Remote transport
    # for both plain and caller-owned-tool requests.  The old implementation
    # excluded tool requests here, which turned a transient native rejection
    # into a guaranteed 502 for Codex clients.
    fallback_enabled = not bool(options.get("_disable_upstream_fallback"))
    fallback_modes = {
        "raw",
        "direct",
        "auto",
        "ide",
        "solo",
        "work-agent",
        "traework-native",
        "native",
        "traework",
    }
    if fallback_enabled and active_mode in ("raw", "direct"):
        modes.append("ide")
    if fallback_enabled and active_mode in fallback_modes and "remote" not in modes:
        modes.append("remote")
    route_initial_mode = modes[0] if modes else active_mode
    raw_skipped = False
    if (
        fallback_enabled
        and modes[:1] == ["raw"]
        and len(modes) > 1
        and _raw_app_config_known_missing(model, options)
    ):
        skip_detail = "skipped (app config record not found, cached)"
        skip_reason = f"raw: {skip_detail}"
        errors.append(skip_reason)
        fallback_reasons.append(skip_reason)
        _trace_append_failure(trace, "raw", skip_detail)
        raw_skipped = True
        modes = modes[1:]

    logger.info(
        "dispatch route id=%s mode=%s candidates=%s tool_protocol=%s",
        str(options.get("_relay_request_id") or ""),
        active_mode,
        ",".join(modes),
        tool_protocol_requested,
    )

    for mode in modes:
        try:
            if isinstance(trace, dict):
                route_fallback = (
                    bool(fallback_from)
                    or bool(fallback_reasons)
                    or raw_skipped
                    or mode != route_initial_mode
                )
                trace.update(
                    actual_mode=mode,
                    actual_endpoint=mode,
                    fallback_used=route_fallback,
                )
                if route_fallback:
                    trace["fallback_target"] = (
                        "remote-work" if mode == "work-agent" else mode
                    )
                    if fallback_reasons:
                        trace["fallback_reason"] = "; ".join(fallback_reasons)[:1200]
                trace.pop("reasoning_effort_applied", None)
                trace.pop("max_context_tokens", None)
                if mode in {"raw", "ide", "solo", "cli", "traework-native", "web"}:
                    trace["max_mode_applied"] = False
                else:
                    trace.pop("max_mode_applied", None)
            mode_options = dict(options)
            if mode == "raw":
                result = await run_raw_chat(messages, model, stream, mode_options)
                error = _upstream_response_error(result)
                if error:
                    raise RuntimeError(f"raw returned {error}")
                if isinstance(trace, dict) and (fallback_reasons or raw_skipped):
                    trace["fallback_target"] = "raw"
                return result
            # Web and remote routes must receive the lease-bound credential;
            # otherwise a concurrent account switch can make the upstream bill
            # one token while the usage tracker records another.
            if mode not in (
                "remote",
                "web",
                "ide",
                "solo",
                "work-agent",
                "traework-native",
            ):
                mode_options.pop("_auth_token", None)
                mode_options.pop("_account_id", None)
            if mode == "cli":
                mode_options.pop("_upstream_trace", None)
                result = await run_cli_chat(messages, model, stream, mode_options)
                error = _upstream_response_error(result)
                if error:
                    raise RuntimeError(f"cli returned {error}")
                return result
            if mode == "web":
                result = await _run_web_with_retry(messages, model, stream, mode_options)
                error = _upstream_response_error(result)
                if error:
                    raise RuntimeError(f"web returned {error}")
                return result
            if mode == "remote":
                if modes[0] != "remote":
                    mode_options = _remote_fallback_options(
                        mode_options, active_mode
                    )
                result = await _run_remote_with_retry(messages, model, stream, mode_options)
                error = _upstream_response_error(result)
                if error:
                    raise RuntimeError(f"remote returned {error}")
                return result
            if mode == "work-agent":
                mode_options["_trae_mode"] = "work"
                mode_options["_remote_agent_type"] = "solo_work_remote"
                mode_options.setdefault("_session_variant", "work-agent")
                if isinstance(trace, dict):
                    trace.update(actual_endpoint="remote-work")
                result = await _run_remote_with_retry(
                    messages, model, stream, mode_options
                )
                error = _upstream_response_error(result)
                if error:
                    raise RuntimeError(f"work-agent returned {error}")
                return result
            if mode == "traework-native":
                result = await run_traework_native_chat(
                    messages, model, stream, mode_options
                )
                error = _upstream_response_error(result)
                if error:
                    raise RuntimeError(f"traework-native returned {error}")
                return result
            if mode in ("ide", "solo"):
                mode_options["_ide_endpoint"] = "/api/agent/v3/llm_utils_chat"
            result = await run_ide_chat(messages, model, stream, mode_options)
            if getattr(result, "status_code", 200) >= 400:
                payload = _response_json_payload(result)
                detail = payload.get("error") if isinstance(payload, Mapping) else None
                detail = (
                    detail.get("message")
                    if isinstance(detail, Mapping)
                    else str(detail or "upstream returned an error")
                )
                raise RuntimeError(
                    f"{mode} returned HTTP {getattr(result, 'status_code', 0)}: {detail}"
                )
            return result
        except Exception as e:
            logger.warning("upstream %s failed: %s", mode, e)
            reason = _trace_failure_reason(mode, e)
            fallback_reasons.append(reason)
            _trace_append_failure(trace, mode, e)
            if isinstance(e, _ModelAccountUnavailable):
                return _openai_error(503, str(e), "model_account_unavailable")
            if isinstance(e, EmptyUpstreamResponse):
                _track_usage_from_exception(e, model)
                if not e.retryable or e.observed_model_event:
                    if stream:
                        raise
                    return _openai_error(502, str(e), "api_error")
            errors.append(f"{mode}: {e}")
            if (
                mode == "raw"
                and options.get("_account_id")
                and _raw_app_config_missing_error(e)
            ):
                _RAW_APP_CONFIG_MISSING[_raw_app_config_key(model, options)] = (
                    time.monotonic() + _RAW_APP_CONFIG_TTL_SECONDS
                )

    return _openai_error(502, "All upstream paths failed: " + "; ".join(errors), "api_error")


def _response_json_payload(response: Any) -> dict[str, Any]:
    """Decode a Starlette JSON response without assuming a concrete class."""

    body = getattr(response, "body", b"")
    if isinstance(body, bytes):
        body = body.decode("utf-8", errors="replace")
    if isinstance(body, str):
        try:
            value = json.loads(body)
        except (TypeError, ValueError, json.JSONDecodeError):
            return {}
        return dict(value) if isinstance(value, Mapping) else {}
    return dict(body) if isinstance(body, Mapping) else {}


async def _handle_traework_custom(
    req: Request,
    body: Optional[Mapping[str, Any]] = None,
    *,
    request_id: str = "",
):
    """Serve TraeWork's custom-model/raw ingress and preserve client tools.

    The desktop client owns the toolhost. This endpoint only converts its raw
    request into the existing relay dispatch and converts the OpenAI-shaped
    result back to TraeWork's cumulative ``event: output`` stream. No tool is
    executed in the relay container.
    """

    request_id = request_id or ("req-" + uuid_mod.uuid4().hex)
    if body is None:
        try:
            body, _ = await _read_json_body(
                req, endpoint="traework-custom", trace_id=request_id
            )
        except _RequestBodyError as exc:
            return _openai_error(400, str(exc), "invalid_request_error")
    try:
        descriptor = traework_compat.normalize_inbound_request(
            body,
            headers=dict(req.headers),
            path=req.url.path,
        )
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        return _openai_error(400, str(exc), "invalid_request_error")

    messages = cli_client.sanitize_assistant_history_messages(
        _normalize_chat_messages(descriptor.messages)
    )
    options = dict(descriptor.options)
    options = _apply_tool_header_hints(req, options)
    options = _with_auto_client_context(req, body, messages, options)
    options = _bind_chat_session(
        messages,
        options,
        requested_session_id=descriptor.session_id,
    )
    # These values are deliberately set after session binding. The lease owns
    # the account/JWT; the custom model's Bearer key must never replace it.
    options["_traework_custom_model"] = True
    options["_relay_request_id"] = request_id
    tracker = _UsageTracker(
        descriptor.model,
        req.url.path,
        descriptor.stream,
        options,
        messages,
    )
    tracker.request_id = request_id
    logger.info(
        "traework custom ingress id=%s path=%s model=%s stream=%s messages=%d tools=%s session=%s",
        request_id,
        req.url.path,
        descriptor.model,
        descriptor.stream,
        len(messages),
        _tool_protocol_requested(options, messages),
        descriptor.session_id[:32],
    )

    if descriptor.stream:
        async def openai_source():
            async for chunk in _deferred_dispatch_stream(
                messages, descriptor.model, options
            ):
                yield chunk

        translated = traework_compat.translate_openai_stream_to_traework(
            openai_source(), model=descriptor.model, request_id=request_id
        )
        session_id = str(options.get("session_id") or descriptor.session_id)
        return StreamingResponse(
            _tracked_stream(_lease_stream(translated, session_id), tracker),
            media_type="text/event-stream",
            headers=_sse_headers(),
        )

    response = await _tracked_dispatch(messages, descriptor.model, options, tracker)
    if getattr(response, "status_code", 200) >= 400:
        payload = _response_json_payload(response)
        return JSONResponse(
            traework_compat.openai_error_to_traework(
                payload,
                model=descriptor.model,
                request_id=request_id,
            ),
            status_code=getattr(response, "status_code", 502),
        )
    payload = _response_json_payload(response)
    return JSONResponse(
        traework_compat.openai_completion_to_traework(
            payload, model=descriptor.model
        )
    )


async def handle_chat(req: Request):
    request_id = "req-" + uuid_mod.uuid4().hex
    try:
        body, _body_bytes = await _read_json_body(
            req,
            endpoint="chat",
            trace_id=request_id,
        )
    except _RequestBodyError as exc:
        logger.warning(
            "request body rejected id=%s endpoint=chat bytes=%d error=%s",
            request_id,
            exc.raw_bytes,
            exc,
        )
        return _openai_error(400, str(exc), "invalid_request_error")

    # A TraeWork custom model may use the ordinary /v1/chat/completions URL,
    # but native raw paths and the client's identifying headers are distinct
    # enough to route it without changing OpenAI callers.
    if traework_compat.is_traework_request(
        req.url.path, dict(req.headers), body
    ):
        return await _handle_traework_custom(
            req, body=body, request_id=request_id
        )

    messages = _normalize_chat_messages(body.get("messages"))
    if not isinstance(messages, list) or not messages:
        # Accept the lightweight aliases emitted by a few terminal adapters.
        # This keeps a valid user prompt from being mistaken for an empty
        # request when the adapter does not use the Chat Completions field name.
        for alias in ("prompt", "query", "input_text", "content"):
            candidate = body.get(alias)
            if candidate not in (None, "", [], {}):
                messages = [{"role": "user", "content": candidate}]
                break
        if messages:
            options_from_response = {}
        else:
            # Some OpenAI-compatible clients accidentally send a Responses-shaped
            # payload to /chat/completions. Normalize it instead of dropping the
            # user prompt before the request can reach Trae.
            if "input" in body:
                try:
                    messages, response_options, _response_context = responses_api.normalize_request(body)
                    options_from_response = dict(response_options)
                except responses_api.ResponsesRequestError as exc:
                    return _openai_error(400, str(exc), "invalid_request_error", exc.param)
            else:
                return _openai_error(400, "messages is required", "invalid_request_error")
    else:
        options_from_response = {}

    messages = cli_client.sanitize_assistant_history_messages(messages)

    model = body.get("model") or "auto"
    stream = bool(body.get("stream", False))
    options = {
        key: body[key]
        for key in CHAT_OPTION_FIELDS
        if key in body
    }
    options.update(options_from_response)
    options = _apply_tool_header_hints(req, options)
    requested_session_id = _request_session_hint(req, body)
    if requested_session_id and not options.get("session_id") and not options.get("sessionId"):
        options["session_id"] = requested_session_id

    option_error = _validate_chat_options(options)
    if option_error is not None:
        return option_error
    for key in ("max_tokens", "maxTokens", "max_completion_tokens"):
        if key in options:
            options[key] = clamp_max_completion_tokens(options[key], model)
    options = _with_auto_client_context(req, body, messages, options)
    options = _bind_chat_session(
        messages,
        options,
        requested_session_id=requested_session_id,
    )
    tracker = _UsageTracker(model, req.url.path, stream, options, messages)
    tracker.request_id = request_id
    options["_relay_request_id"] = request_id
    logger.info(
        "request received id=%s path=%s keys=%s messages=%d input_chars=%d stream=%s",
        tracker.request_id,
        req.url.path,
        ",".join(sorted(str(key) for key in body.keys())),
        len(messages),
        sum(len(str(item.get("content") or "")) for item in messages if isinstance(item, Mapping)),
        stream,
    )
    logger.info(
        "request binding id=%s account=%s billing=%s session=%s",
        tracker.request_id,
        str(options.get("_account_id") or "default"),
        str(options.get("_billing_id") or options.get("_account_id") or "default"),
        str(options.get("session_id") or options.get("sessionId") or "")[:32],
    )
    if stream:
        session_id = str(options.get("session_id") or options.get("sessionId") or "")
        return StreamingResponse(
            _tracked_stream(
                _lease_stream(
                    _deferred_dispatch_stream(messages, model, options), session_id
                ),
                tracker,
            ),
            media_type="text/event-stream",
            headers=_sse_headers(),
        )
    return await _tracked_dispatch(messages, model, options, tracker)


async def handle_responses(req: Request):
    request_id = "req-" + uuid_mod.uuid4().hex
    try:
        body, _body_bytes = await _read_json_body(
            req,
            endpoint="responses",
            trace_id=request_id,
        )
    except _RequestBodyError as exc:
        logger.warning(
            "request body rejected id=%s endpoint=responses bytes=%d error=%s",
            request_id,
            exc.raw_bytes,
            exc,
        )
        return _openai_error(400, str(exc), "invalid_request_error")

    try:
        messages, options, context = responses_api.normalize_request(body)
    except responses_api.ResponsesRequestError as exc:
        return _openai_error(
            400, str(exc), "invalid_request_error", exc.param
        )

    messages = cli_client.sanitize_assistant_history_messages(messages)

    options = _apply_tool_header_hints(req, options)
    option_error = _validate_chat_options(options)
    if option_error is not None:
        return option_error
    if "max_tokens" in options:
        options["max_tokens"] = clamp_max_completion_tokens(
            options["max_tokens"], context.model
        )
    options = _with_auto_client_context(req, body, messages, options)
    # Responses response ids change on every turn.  The context retains the
    # first raw session id so multi-tool continuations stay in one upstream
    # Trae conversation even when the caller sends only function_call_output.
    if not options.get("session_id") and not options.get("sessionId"):
        options["session_id"] = context.upstream_session_id or context.response_id
    options = _bind_chat_session(
        messages,
        options,
        requested_session_id=str(options.get("session_id") or options.get("sessionId") or ""),
    )
    stream = bool(body.get("stream", False))
    tracker = _UsageTracker(context.model, req.url.path, stream, options, messages)
    tracker.request_id = request_id
    options["_relay_request_id"] = request_id
    logger.info(
        "request received id=%s path=%s keys=%s messages=%d input_chars=%d stream=%s",
        tracker.request_id,
        req.url.path,
        ",".join(sorted(str(key) for key in body.keys())),
        len(messages),
        sum(len(str(item.get("content") or "")) for item in messages if isinstance(item, Mapping)),
        stream,
    )
    logger.info(
        "request binding id=%s account=%s billing=%s session=%s",
        tracker.request_id,
        str(options.get("_account_id") or "default"),
        str(options.get("_billing_id") or options.get("_account_id") or "default"),
        str(options.get("session_id") or options.get("sessionId") or "")[:32],
    )
    if stream:
        session_id = str(options.get("session_id") or options.get("sessionId") or "")
        return StreamingResponse(
            _tracked_stream(
                _lease_stream(
                    responses_api.translate_chat_stream(
                        _deferred_dispatch_stream(messages, context.model, options),
                        context,
                    ),
                    session_id,
                ),
                tracker,
            ),
            media_type="text/event-stream",
            headers=_sse_headers(),
        )
    chat_response = await _tracked_dispatch(
        messages, context.model, options, tracker
    )
    if getattr(chat_response, "status_code", 200) >= 400:
        return chat_response
    try:
        completion = json.loads(chat_response.body)
    except Exception:
        return _openai_error(
            502, "Invalid Chat Completions response", "api_error"
        )
    return JSONResponse(
        content=responses_api.completion_to_response(completion, context)
    )


async def init_app():
    _load_usage_history()
    _load_usage_stats()
    auth.init_auth()
    _restore_persisted_relay_settings()
    auth.apply_max_mode_settings()
    logger.info(
        "trae-free relay initialized (auth source=%s edition=%s cli=%s)",
        auth.get_auth().source,
        auth.get_auth().edition,
        cli_client.resolve_cli_command() or "not-found",
    )


async def _web_reaper_loop():
    interval = float(os.environ.get("TRAE_WEB_REAP_INTERVAL", "10"))
    while True:
        await asyncio.sleep(interval)
        try:
            await trae_client.reap_idle_web_sessions()
        except Exception as e:
            logger.warning("web reaper error: %s", e)


async def _terminal_session_reaper_loop():
    try:
        interval = float(os.environ.get("TRAE_SESSION_REAP_INTERVAL_SECONDS", "5"))
    except (TypeError, ValueError):
        interval = 5.0
    interval = max(1.0, min(interval, 60.0))
    while True:
        await asyncio.sleep(interval)
        try:
            reaped = await _reap_idle_chat_sessions()
            if reaped:
                logger.info("reaped %d idle terminal session lease(s)", reaped)
        except Exception as e:
            logger.warning("terminal session reaper error: %s", e)


async def _checkin_auto_retry_cycle() -> None:
    """Retry accounts whose persisted 9074 backoff has expired."""
    try:
        for account_id, record in auth.get_accounts_raw():
            checkin = record.get("checkin") or {}
            if checkin.get("checked_in") is True and _checkin_cache_is_today(record):
                if float(checkin.get("retry_backoff") or 0) > 0:
                    _checkin_clear_retry_state(account_id)
                continue
            if not (record.get("token") or ""):
                continue
            # Only accounts that actually hit 9074 belong here; this loop must
            # not turn into a general claim poller. ``device_generation``
            # survives a retry-state reset, so an account stays visible after
            # its backoff is cleared but before it has claimed.
            pending_9074 = (
                float(checkin.get("retry_backoff") or 0) > 0
                or int(checkin.get("retry_9074_count") or 0) > 0
                or int(checkin.get("device_generation") or 0) > 0
            )
            if not pending_9074:
                continue
            cooldown = _checkin_cooldown_remaining(account_id)
            if cooldown:
                continue
            try:
                result = await _claim_checkin_account(account_id)
            except Exception as exc:
                logger.warning(
                    "checkin auto retry account=%s error: %s",
                    account_id,
                    exc,
                )
                continue
            if result.get("success"):
                logger.info(
                    "checkin auto retry ok account=%s skipped=%s",
                    account_id,
                    result.get("skipped"),
                )
            else:
                logger.info(
                    "checkin auto retry pending account=%s retry_after=%s",
                    account_id,
                    result.get("retry_after_seconds"),
                )
    except Exception as exc:
        logger.warning("checkin auto retry cycle error: %s", exc)


async def _checkin_auto_retry_loop():
    """Periodically retry accounts stuck in an upstream 9074 window."""
    interval = max(15.0, float(CHECKIN_AUTO_RETRY_INTERVAL))
    while True:
        await asyncio.sleep(interval)
        await _checkin_auto_retry_cycle()


# Scheduled daily check-in.  The loop wakes every few seconds, re-reads the
# console settings and fires once per business day (UTC+8) after the chosen
# time.  A relay that starts late still claims that same day.
AUTO_CHECKIN_POLL_SECONDS = 30.0
_AUTO_CHECKIN_STATE: dict = {
    "running": False,
    "last_run_at": 0.0,
    "last_run_date": "",
    "last_trigger": "",
    "summary": None,
}
_AUTO_CHECKIN_LOCK = asyncio.Lock()


def _auto_checkin_target(now: Optional[datetime] = None, time_text: str = "08:30") -> datetime:
    """Return today's scheduled run time in the check-in timezone."""
    current = now or datetime.now(_CHECKIN_TIMEZONE)
    hour, minute = (int(part) for part in time_text.split(":", 1))
    return current.replace(hour=hour, minute=minute, second=0, microsecond=0)


def _auto_checkin_next_run(settings: dict, now: Optional[datetime] = None) -> Optional[datetime]:
    """The next scheduled run, always at the configured wall-clock time.

    Reporting ``max(target, now)`` made an already-passed slot display the
    current time, which reads as though the schedule had moved. A slot that
    has passed but was not consumed is still owed today, so it is reported
    as today's time; the scheduler loop fires on its next tick.
    """
    if not settings.get("enabled"):
        return None
    current = now or datetime.now(_CHECKIN_TIMEZONE)
    target = _auto_checkin_target(current, settings.get("time") or "08:30")
    if _AUTO_CHECKIN_STATE.get("last_run_date") == current.date().isoformat():
        return target + timedelta(days=1)
    return target


def _auto_checkin_due(settings: dict, now: Optional[datetime] = None) -> bool:
    if not settings.get("enabled"):
        return False
    current = now or datetime.now(_CHECKIN_TIMEZONE)
    if _AUTO_CHECKIN_STATE.get("last_run_date") == current.date().isoformat():
        return False
    return current >= _auto_checkin_target(current, settings.get("time") or "08:30")


async def _auto_checkin_cycle(trigger: str = "schedule") -> dict:
    """Claim check-in for every account with a token, strictly in order."""
    summary = {"total": 0, "ok": 0, "skipped": 0, "failed": 0, "no_token": 0}
    if _AUTO_CHECKIN_LOCK.locked():
        return {**summary, "busy": True}
    async with _AUTO_CHECKIN_LOCK:
        _AUTO_CHECKIN_STATE["running"] = True
        now = datetime.now(_CHECKIN_TIMEZONE)
        try:
            for account_id, record in list(auth.get_accounts_raw()):
                summary["total"] += 1
                if not (record.get("token") or ""):
                    summary["no_token"] += 1
                    continue
                checkin = record.get("checkin") or {}
                if checkin.get("checked_in") is True and _checkin_cache_is_today(record):
                    summary["skipped"] += 1
                    continue
                try:
                    result = await _claim_checkin_account(account_id)
                except Exception as exc:
                    logger.warning("auto checkin account=%s error: %s", account_id, exc)
                    summary["failed"] += 1
                    continue
                if result.get("success"):
                    summary["skipped" if result.get("skipped") else "ok"] += 1
                else:
                    summary["failed"] += 1
        finally:
            _AUTO_CHECKIN_STATE.update(
                running=False,
                last_run_at=time.time(),
                last_trigger=trigger,
                summary=dict(summary),
            )
            # Only the scheduler consumes the daily slot; a manual run leaves
            # the scheduled pass in place (already claimed accounts are skipped).
            if trigger == "schedule":
                _AUTO_CHECKIN_STATE["last_run_date"] = now.date().isoformat()
        logger.info(
            "auto checkin done trigger=%s total=%d ok=%d skipped=%d failed=%d no_token=%d",
            trigger,
            summary["total"],
            summary["ok"],
            summary["skipped"],
            summary["failed"],
            summary["no_token"],
        )
        return summary


async def _auto_checkin_loop():
    while True:
        await asyncio.sleep(AUTO_CHECKIN_POLL_SECONDS)
        try:
            if _auto_checkin_due(auth.get_auto_checkin_settings()):
                await _auto_checkin_cycle("schedule")
        except Exception as exc:
            logger.warning("auto checkin loop error: %s", exc)


def _auto_checkin_payload() -> dict:
    settings = auth.get_auto_checkin_settings()
    next_run = _auto_checkin_next_run(settings)
    last_at = float(_AUTO_CHECKIN_STATE.get("last_run_at") or 0)
    return {
        "success": True,
        **settings,
        "timezone": "Asia/Shanghai",
        "next_run": next_run.isoformat(timespec="minutes") if next_run else None,
        # True when the configured time has passed today and the run is still
        # owed, so the console can say so instead of showing a past time that
        # looks like it already ran.
        "due_now": bool(next_run and next_run <= datetime.now(_CHECKIN_TIMEZONE)),
        "running": bool(_AUTO_CHECKIN_STATE.get("running")),
        "last_run_at": (
            datetime.fromtimestamp(last_at, _CHECKIN_TIMEZONE).isoformat(timespec="seconds")
            if last_at > 0
            else None
        ),
        "last_trigger": _AUTO_CHECKIN_STATE.get("last_trigger") or None,
        "summary": _AUTO_CHECKIN_STATE.get("summary"),
    }


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_app()
    # Browser login runs in-process. A failure to bind degrades login only:
    # the relay and every other route keep working.
    global _WEB_AUTH_SERVER
    _WEB_AUTH_SERVER = web_auth.build_default_server(
        LOCAL_LISTENER_PORT, f"http://127.0.0.1:{PORT}"
    )
    await _WEB_AUTH_SERVER.start()
    web_reaper = asyncio.create_task(_web_reaper_loop())
    terminal_reaper = asyncio.create_task(_terminal_session_reaper_loop())
    checkin_retry = asyncio.create_task(_checkin_auto_retry_loop())
    auto_checkin = asyncio.create_task(_auto_checkin_loop())
    try:
        yield
    finally:
        if _WEB_AUTH_SERVER is not None:
            await _WEB_AUTH_SERVER.stop()
        for reaper in (web_reaper, terminal_reaper, checkin_retry, auto_checkin):
            reaper.cancel()
        await asyncio.gather(web_reaper, terminal_reaper, return_exceptions=True)
        await asyncio.gather(checkin_retry, auto_checkin, return_exceptions=True)
        await _cancel_usage_tasks()


app = FastAPI(title="trae-free", version=APP_VERSION, lifespan=lifespan)


@app.exception_handler(_ModelAccountUnavailable)
async def model_account_unavailable_handler(_request: Request, exc: _ModelAccountUnavailable):
    return _openai_error(503, str(exc), "model_account_unavailable")


@app.get("/api/overview")
async def api_overview(days: int = Query(30, ge=1, le=366)):
    """Dashboard home: token totals by day plus account and service state."""
    accounts = auth.list_accounts()
    remaining = 0.0
    credits_known = False
    unlimited = False
    for account in accounts:
        credits = account.get("account_credits") or {}
        if credits.get("unlimited"):
            unlimited = True
        elif credits.get("remaining") is not None:
            try:
                remaining += float(credits["remaining"])
                credits_known = True
            except (TypeError, ValueError):
                pass
    polling = auth.get_polling_status()
    with _USAGE_LOCK:
        in_flight = sum(_USAGE_ACTIVE_ACCOUNTS.values())
        recent = [_normalize_usage_record(record) for record in _USAGE_HISTORY[:5]]
    return JSONResponse(
        {
            "success": True,
            "generated_at": time.time(),
            "timezone": "Asia/Shanghai",
            "usage": _usage_overview(days),
            "accounts": {
                "total": len(accounts),
                "valid": sum(1 for account in accounts if account.get("is_valid")),
                "checked_in": sum(1 for account in accounts if account.get("checked_in") is True),
                "credits_remaining": (
                    "unlimited" if unlimited else round(remaining, 2) if credits_known else None
                ),
                "active": auth.get_active_account_id() or None,
            },
            "service": {
                "version": APP_VERSION,
                "uptime_seconds": round(time.time() - _PROCESS_STARTED_AT),
                "upstream_mode": _current_upstream_mode(),
                "auto_route": _auto_route_enabled(),
                "polling": bool(polling.get("enabled")),
                "polling_mode": polling.get("mode"),
                "max_mode": bool(auth.get_max_mode_settings().get("enabled")),
                "auto_checkin": auth.get_auto_checkin_settings(),
                "in_flight": in_flight,
                "token_ok": auth.get_auth().is_valid(),
            },
            "recent": recent,
        },
        headers={"Cache-Control": "no-store"},
    )


@app.get("/api/usage/records")
async def get_usage_records():
    """Return the usage history list (newest first)."""
    with _USAGE_LOCK:
        records = [_normalize_usage_record(record) for record in _USAGE_HISTORY]
    return JSONResponse(records, headers={"Cache-Control": "no-store"})

@app.get("/api/usage/last")
async def api_usage_last():
    """Backward-compatible: return only the latest record."""
    with _USAGE_LOCK:
        records = [_normalize_usage_record(record) for record in _USAGE_HISTORY[:1]]
    return JSONResponse(records, headers={"Cache-Control": "no-store"})


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    if not API_KEYS:
        return await call_next(request)
    if request.url.path == "/api/model-test":
        # Keep the dashboard probe usable on loopback/RFC1918 management
        # networks without exposing a billable model endpoint to the public.
        client_host = str(getattr(request.client, "host", "") or "").strip()
        try:
            client_ip = ipaddress.ip_address(client_host)
        except ValueError:
            client_ip = None
        if client_ip is not None and (
            client_ip.is_loopback
            or client_ip.is_private
            or client_ip.is_link_local
        ):
            return await call_next(request)
    if request.url.path in PUBLIC_PATHS or request.url.path.startswith(PUBLIC_PATH_PREFIXES):
        return await call_next(request)
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        token = header[7:].strip()
    else:
        token = header.strip()
    if token not in API_KEYS:
        return _openai_error(401, "Invalid API key", "authentication_error")
    return await call_next(request)


@app.get("/")
async def root():
    return {"service": "trae-free", "status": "ok"}


# In-process Trae authorization callback listener. Started by the app lifespan;
# None while stopped so /api/web-login/status can report the degraded state.
_WEB_AUTH_SERVER: Optional[web_auth.AuthCallbackServer] = None


@app.get("/api/web-login/status")
async def api_web_login_status():
    """Report the in-process login listener so the console can show its state.

    Never errors: a listener that failed to bind (port busy) still answers, so
    the relay and its API stay usable while browser login is unavailable.
    """
    server = _WEB_AUTH_SERVER
    return JSONResponse(
        {
            "listenerRunning": bool(server and server.running),
            "port": LOCAL_LISTENER_PORT,
            "lastError": (server.last_error if server else "listener not started"),
            "clientId": TRAE_CLIENT_ID,
            "authUrl": TRAE_AUTH_URL,
        },
        headers={"Cache-Control": "no-store"},
    )


@app.post("/api/web-login/state")
async def api_web_login_state():
    """Mint a one-time state nonce and return the authorization URL.

    The nonce is registered here and consumed by the callback listener, so a
    callback that was not started from this console is refused.
    """
    registry = web_auth.get_registry()
    registry.prune()
    state = web_auth.new_state()
    registry.register(state)
    url = web_auth.build_auth_url(
        state,
        client_id=TRAE_CLIENT_ID,
        auth_url=TRAE_AUTH_URL,
        listener_port=LOCAL_LISTENER_PORT,
    )
    return JSONResponse(
        {"state": state, "url": url, "port": LOCAL_LISTENER_PORT},
        headers={"Cache-Control": "no-store"},
    )


@app.get("/api/logs")
async def api_logs(
    limit: int = Query(500, ge=1, le=2000),
    channel: str = Query(""),
):
    """Recent in-process log lines for the console log page.

    Newest entries last, so a tail-following view appends naturally.
    """
    entries = _LOG_RING.snapshot()
    if channel and channel != "all":
        entries = [e for e in entries if e.ch == channel]
    return JSONResponse(
        {
            "entries": [e.as_dict() for e in entries[-limit:]],
            "total": len(entries),
        },
        headers={"Cache-Control": "no-store"},
    )


@app.get("/favicon.svg", include_in_schema=False)
@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    return Response(
        LOGO_SVG,
        media_type="image/svg+xml",
        headers={"Cache-Control": "public, max-age=86400"},
    )


# Console static assets are public (see PUBLIC_PATH_PREFIXES): they contain no
# credentials, and the API key gate lives on the API routes.
# f-string: the browser gets a document that a JS engine can parse directly, and
# the CSS/JS no longer need brace and backslash escaping.
_CONSOLE_ASSET_TYPES = {
    "console.css": "text/css; charset=utf-8",
    "app.js": "application/javascript; charset=utf-8",
}


@app.get("/console/{asset_name}", include_in_schema=False)
async def console_asset(asset_name: str, request: Request):
    media_type = _CONSOLE_ASSET_TYPES.get(asset_name)
    if media_type is None:
        return JSONResponse({"error": "unknown asset"}, status_code=404)
    path = _console_assets_path() / asset_name
    if not path.is_file():
        return JSONResponse({"error": "asset not found"}, status_code=404)
    # Cache-Control: FileResponse emitted only ETag/Last-Modified here, so
    # browsers applied heuristic freshness and could keep serving a stylesheet
    # edited minutes ago without revalidating - which made a CSS fix look like
    # it had never been applied. no-cache forces revalidation on every load.
    stat = path.stat()
    etag = '"%s-%s"' % (int(stat.st_mtime), stat.st_size)
    # Starlette sets FileResponse's ETag lazily at send time, so it is empty
    # here; derive the same validator from the file and answer 304 directly.
    if _etag_matches(request.headers.get("if-none-match"), etag):
        return Response(
            status_code=304,
            headers={"Cache-Control": "no-cache", "ETag": etag},
        )
    return FileResponse(
        str(path),
        media_type=media_type,
        headers={"Cache-Control": "no-cache", "ETag": etag},
    )


@app.get("/healthz")
async def healthz():
    return {"status": "ok"}


@app.get("/v1/status")
async def status():
    state = auth.get_auth()
    return {
        "status": "ok",
        "edition": state.edition,
        "source": state.source,
        "base_url": state.host,
        "web_base": auth.get_settings().get("web_base_url") or WEB_BASE,
        "upstream_mode": _current_upstream_mode(),
        "auto_route": _auto_route_enabled(),
        "build_revision": os.environ.get("RELAY_BUILD_REVISION", "local"),
        "traework_native": {
            "enabled": traework_native_bridge.NativeBridgeConfig.from_env().enabled,
            "platform_supported": traework_native_bridge.NativeBridgeConfig.from_env().enabled_for_platform,
            "install_dir_configured": bool(
                traework_native_bridge.NativeBridgeConfig.from_env().install_dir
            ),
            "helper_url": traework_native_bridge.NativeBridgeConfig.from_env().bridge_url,
        },
        "tool_execution": "client",
        "capabilities": {
            "openai_tool_calls": True,
            "openai_responses": True,
            "responses_custom_tools": True,
            "responses_namespaces": True,
            "client_context": True,
            "tool_result_continuation": True,
            "traework_custom_model": True,
            "traework_raw_ingress": True,
            "traework_connectivity_check": True,
            "parallel_tool_calls": True,
            "server_executes_caller_tools": False,
            "tool_upstreams": (
                ["raw"]
                if _current_upstream_mode() in ("raw", "direct", "auto")
                else ["cli"]
                if _current_upstream_mode() == "cli"
                else ["traework-native"]
                if _current_upstream_mode() in ("traework-native", "native", "traework")
                else []
            ),
            "terminal_session_leases": True,
        },
        "has_token": bool(state.token),
        "token_ok": state.is_valid(),
        "session_idle_timeout_seconds": _CHAT_SESSION_TTL,
        "port": PORT,
        "cli": cli_client.get_cli_status(),
    }


@app.get("/v1/models")
async def models(request: Request):
    force = request.query_params.get("refresh", "").lower() in ("1", "true", "yes")
    try:
        items = await trae_client.get_models(force=force)
    except Exception as e:
        return _openai_error(502, str(e), "api_error")
    return {"object": "list", "data": items}


@app.get("/models")
async def models_compat(request: Request):
    """Unversioned discovery alias used by some TraeWork model forms."""

    return await models(request)


@app.post("/v1")
async def chat_v1(req: Request):
    return await handle_chat(req)


@app.post("/v1/chat")
async def chat_v1_chat(req: Request):
    return await handle_chat(req)


@app.post("/v1/chat/completions")
async def chat_completions(req: Request):
    return await handle_chat(req)


@app.post("/chat/completions")
async def chat_completions_compat(req: Request):
    """OpenAI-compatible alias for custom-model base URLs without ``/v1``."""

    return await handle_chat(req)


@app.post("/api/ide/v2/llm_raw_chat")
@app.post("/api/agent/v3/llm_raw_chat_custom_model")
@app.post("/api/agent/v3/custom_model_proxy/chat")
@app.post("/v1/traework/chat")
async def traework_custom_chat(req: Request):
    return await _handle_traework_custom(req)


@app.post("/api/agent/v3/custom_model_connectivity_check")
@app.post("/api/ide/v1/custom_model_connectivity_check")
@app.post("/v1/custom_model/connectivity")
async def traework_custom_connectivity(req: Request):
    request_id = "req-" + uuid_mod.uuid4().hex
    try:
        body, _ = await _read_json_body(
            req, endpoint="traework-connectivity", trace_id=request_id
        )
    except _RequestBodyError:
        # Several TraeWork builds send an empty connectivity POST and expect
        # the backend to report its default model. Keep that probe useful.
        body = {}
    try:
        upstream_models = await trae_client.get_models(force=False)
    except Exception as exc:
        logger.warning("traework connectivity model list failed: %s", exc)
        upstream_models = []
    return JSONResponse(
        traework_compat.connectivity_response(body, models=upstream_models)
    )


@app.post("/v1/responses")
async def responses(req: Request):
    return await handle_responses(req)


@app.post("/api/model-test")
async def api_model_test(req: Request):
    """Probe one model end to end through the real dispatch path.

    Runs the same routing a client request would, so the result reflects actual
    connectivity rather than a config lookup. ``mode`` selects a plain text
    probe or a tool-call probe.
    """

    try:
        body = await req.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    model = str(body.get("model") or "").strip()
    if not model:
        return JSONResponse(
            {"success": False, "error": "model is required"}, status_code=400
        )
    mode = str(body.get("mode") or "text").strip().lower()
    if mode not in {"text", "tool"}:
        return JSONResponse(
            {"success": False, "error": "mode must be text or tool"}, status_code=400
        )
    try:
        timeout = float(body.get("timeout") or 120)
    except (TypeError, ValueError):
        timeout = 120.0
    timeout = max(10.0, min(timeout, 600.0))
    endpoint = str(body.get("endpoint") or _current_upstream_mode()).strip().lower()
    if endpoint not in set(_VALID_UPSTREAM_MODES) | {AUTO_ROUTE_MODE}:
        return JSONResponse(
            {"success": False, "error": f"unsupported endpoint: {endpoint}"},
            status_code=400,
        )

    probe_tools = [
        {
            "type": "function",
            "function": {
                "name": "relay_probe",
                "description": "Echo a probe token back to the relay",
                "parameters": {
                    "type": "object",
                    "properties": {"token": {"type": "string"}},
                    "required": ["token"],
                },
            },
        }
    ]
    if mode == "tool":
        messages = [
            {
                "role": "user",
                "content": (
                    "Call relay_probe with token=\"pong\". Tool call only, "
                    "no explanation."
                ),
            }
        ]
        options: dict[str, Any] = {
            "tools": probe_tools,
            "tool_choice": "auto",
            "parallel_tool_calls": False,
        }
    else:
        messages = [{"role": "user", "content": "Reply with exactly: pong"}]
        options = {}
    options["max_tokens"] = 64
    effort = str(body.get("reasoning_effort") or "").strip().lower()
    if effort:
        if effort not in {"minimal", "low", "medium", "high", "xhigh", "max"}:
            return JSONResponse(
                {"success": False, "error": f"unsupported reasoning_effort: {effort}"},
                status_code=400,
            )
        options["reasoning_effort"] = effort
        # Effort only matters when the model actually thinks; give it room.
        options["max_tokens"] = 4096
    if bool(body.get("thinking")):
        options["thinking"] = {"type": "enabled"}
    max_mode_requested = bool(body.get("max_mode"))
    if max_mode_requested:
        options["trae_max_mode"] = True
    trace: dict[str, Any] = {}
    options["_upstream_mode"] = endpoint
    # Connectivity checks should exercise the same resilient route as a real
    # API request.  Operators can still pass ``disable_fallback=true`` when
    # diagnosing one native endpoint in isolation.
    options["_disable_upstream_fallback"] = bool(body.get("disable_fallback", False))
    options["_upstream_trace"] = trace

    started = time.monotonic()
    try:
        result = await asyncio.wait_for(
            _dispatch_chat(messages, model, False, options),
            timeout=timeout,
        )
    except asyncio.TimeoutError:
        return JSONResponse(
            {
                "success": False,
                "model": model,
                "mode": mode,
                "requested_endpoint": endpoint,
                **trace,
                "elapsed_ms": int((time.monotonic() - started) * 1000),
                "error": f"timed out after {int(timeout)}s",
            }
        )
    except Exception as exc:
        return JSONResponse(
            {
                "success": False,
                "model": model,
                "mode": mode,
                "requested_endpoint": endpoint,
                **trace,
                "elapsed_ms": int((time.monotonic() - started) * 1000),
                "error": str(exc)[:400],
            }
        )

    elapsed_ms = int((time.monotonic() - started) * 1000)
    payload: dict[str, Any] = {}
    http_status = 200
    if isinstance(result, JSONResponse):
        http_status = result.status_code
        try:
            payload = json.loads(bytes(result.body).decode("utf-8"))
        except Exception:
            payload = {}
    elif isinstance(result, Mapping):
        payload = dict(result)
    if not isinstance(payload, dict):
        payload = {}
    upstream_error = payload.get("error")
    if http_status >= 400 or isinstance(upstream_error, Mapping):
        message = ""
        if isinstance(upstream_error, Mapping):
            message = str(upstream_error.get("message") or "")
        return JSONResponse(
            {
                "success": False,
                "model": model,
                "mode": mode,
                "requested_endpoint": endpoint,
                **trace,
                "elapsed_ms": elapsed_ms,
                "error": (message or f"upstream returned HTTP {http_status}")[:400],
            }
        )
    result = payload
    choice = ((result or {}).get("choices") or [{}])[0]
    message = choice.get("message") or {}
    content = str(message.get("content") or "")
    tool_calls = message.get("tool_calls") or []
    usage = (result or {}).get("usage") or {}
    empty_marker = "trae upstream returned an empty response" in content
    if mode == "tool":
        ok = bool(tool_calls)
    else:
        ok = bool(content.strip()) and not empty_marker
    return JSONResponse(
        {
            "success": ok,
            "model": model,
            "mode": mode,
            "requested_endpoint": endpoint,
            **trace,
            "elapsed_ms": elapsed_ms,
            "finish_reason": choice.get("finish_reason"),
            "provider_model_name": (result or {}).get("provider_model_name") or "",
            "requested_reasoning_effort": effort or None,
            "reasoning_effort_applied": trace.get("reasoning_effort_applied") or None,
            "reasoning_effort_note": _effort_note(effort, trace),
            "requested_max_mode": max_mode_requested,
            "reasoning": str(message.get("reasoning_content") or "")[:600] or None,
            "reply": content[:200],
            "tool_calls": [
                {
                    "name": (call.get("function") or {}).get("name"),
                    "arguments": ((call.get("function") or {}).get("arguments") or "")[
                        :120
                    ],
                }
                for call in tool_calls
                if isinstance(call, dict)
            ],
            "usage": {
                "prompt_tokens": usage.get("prompt_tokens"),
                "completion_tokens": usage.get("completion_tokens"),
                "total_tokens": usage.get("total_tokens"),
                "reasoning_tokens": (
                    usage["completion_tokens_details"].get("reasoning_tokens")
                    if isinstance(usage.get("completion_tokens_details"), Mapping)
                    else usage.get("reasoning_tokens")
                ),
            },
            "error": None if ok else (
                "upstream returned an empty response"
                if empty_marker or not content.strip()
                else "no tool call was returned"
            ),
        }
    )


@app.get("/v1")
async def v1_index(request: Request):
    return await models(request)


# ---- Web login endpoints ----

@app.get("/web/login", response_class=HTMLResponse)
async def web_login():
    # The document pins the content-hashed asset URLs, so a cached copy would
    # keep requesting the OLD stylesheet and the hash would never help. It is
    # small and assembled in memory, so revalidate it on every load.
    return HTMLResponse(
        _web_login_html(),
        headers={"Cache-Control": "no-cache"},
    )


@app.get("/authorize", response_class=HTMLResponse)
async def oauth_callback(request: Request):
    parsed = await _parse_oauth_params(dict(request.query_params))
    trace_id = request.query_params.get("loginTraceID") or request.query_params.get("login_trace_id") or ""
    if not parsed.get("token"):
        return HTMLResponse(
            _oauth_result_html(False, "未收到有效的 userJwt，请确认已登录 trae.cn", trace_id),
            status_code=400,
        )
    try:
        auth.add_account(parsed)
    except ValueError as e:
        return HTMLResponse(_oauth_result_html(False, str(e), trace_id), status_code=400)
    return HTMLResponse(_oauth_result_html(True, "登录成功，凭证已写入服务器", trace_id))


@app.post("/api/web-auth")
async def api_web_auth(request: Request):
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"success": False, "error": "Invalid JSON body"}, status_code=400)

    token = body.get("token") or body.get("accessToken") or ""
    if not token:
        return JSONResponse({"success": False, "error": "token is required"}, status_code=400)

    parsed = {
        "token": token,
        "refresh_token": body.get("refreshToken") or body.get("refresh_token") or "",
        "user_id": body.get("userId") or body.get("user_id") or "",
        "tenant_id": body.get("tenantId") or body.get("tenant_id") or "",
        "region": body.get("region") or "",
        "ai_region": body.get("aiRegion") or body.get("ai_region") or "",
        "host": body.get("host") or "",
        "expired_at": body.get("expiredAt") or body.get("expired_at") or body.get("tokenExpires") or "",
        "refresh_expired_at": body.get("refreshExpiredAt") or body.get("refresh_expired_at") or body.get("refreshExpires") or "",
        "client_id": body.get("clientId") or body.get("client_id") or body.get("clientID") or "",
        "web_id": body.get("webId") or body.get("web_id") or "",
        "biz_user_id": body.get("bizUserId") or body.get("biz_user_id") or "",
        "user_unique_id": body.get("userUniqueId") or body.get("user_unique_id") or "",
        "scope": body.get("scope") or "",
        "tenant": body.get("tenant") or "",
        "app_language": body.get("appLanguage") or body.get("app_language") or "",
        "user_region": body.get("userRegion") or body.get("user_region") or "",
        "user_identity": body.get("userIdentity") or body.get("user_identity") or "",
        "screen_name": body.get("screenName") or body.get("screen_name") or "",
    }
    label = body.get("label") or ""
    try:
        auth.add_account(parsed, label=label)
    except ValueError as e:
        return JSONResponse({"success": False, "error": str(e)}, status_code=400)

    s = auth.get_auth()
    return JSONResponse({
        "success": True,
        "has_token": bool(s.token),
        "user_id": s.user_id or "",
    })


@app.get("/api/checkin/status")
async def api_checkin_status():
    try:
        data = await trae_client.fetch_checkin_credits_status()
    except Exception as e:
        return JSONResponse({"success": False, "error": str(e)}, status_code=502)
    return JSONResponse({"success": True, "data": data})

@app.get("/api/checkin/accounts")
async def api_checkin_accounts():
    """Refresh daily checkin state only for every stored account.

    Entitlement credits use a different upstream API and are intentionally
    refreshed through ``/api/checkin/credits/accounts``. Keeping these probes
    apart stops an ordinary dashboard refresh from creating extra checkin
    traffic while a user is recovering from code 9074.
    """
    raw_accounts = auth.get_accounts_raw()

    async def _query_one(aid: str, rec: dict) -> dict:
        row = _cached_checkin_account_snapshot(aid, rec)
        if not (rec.get("token") or ""):
            row["error"] = "No token"
            return row
        try:
            async with _checkin_account_lock(aid):
                row.update(
                    await _fetch_checkin_status_snapshot(
                        aid, rec, use_cached_on_cooldown=True
                    )
                )
        except Exception as e:
            row["error"] = str(e)
        # Username check rides on the status refresh, not on credits queries.
        try:
            row.update(await _sync_account_user_name(aid))
        except Exception as e:
            row["user_name_error"] = str(e)[:200]
        return row

    results = await asyncio.gather(
        *[_query_one(aid, rec) for aid, rec in raw_accounts],
        return_exceptions=True,
    )
    for idx, item in enumerate(results):
        if isinstance(item, BaseException):
            aid, rec = raw_accounts[idx]
            results[idx] = {
                **_cached_checkin_account_snapshot(aid, rec),
                "error": str(item),
            }
    return JSONResponse(
        {"success": True, "active": auth.get_active_account_id(), "accounts": results}
    )


@app.get("/api/checkin/credits/accounts")
async def api_checkin_credits_accounts():
    """Refresh entitlement credits only for every stored account.

    This endpoint never calls the daily-checkin status API. It is deliberately
    separate from ``/api/checkin/accounts`` so credits refreshes cannot create
    extra checkin probes or interfere with claim cooldown handling.
    """
    raw_accounts = auth.get_accounts_raw()

    async def _query_one(aid: str, rec: dict) -> dict:
        row = _cached_checkin_account_snapshot(aid, rec)
        if not (rec.get("token") or ""):
            row["error"] = "No token"
            return row
        try:
            async with _checkin_account_lock(aid):
                row.update(await _fetch_credit_account_snapshot(aid, rec))
        except Exception as e:
            row["error"] = str(e)
        return row

    results = await asyncio.gather(
        *[_query_one(aid, rec) for aid, rec in raw_accounts],
        return_exceptions=True,
    )
    for idx, item in enumerate(results):
        if isinstance(item, BaseException):
            aid, rec = raw_accounts[idx]
            results[idx] = {
                **_cached_checkin_account_snapshot(aid, rec),
                "error": str(item),
            }
    return JSONResponse({"success": True, "accounts": results})


@app.get("/api/checkin/credits/{account_id}")
async def api_checkin_credits(account_id: str):
    """Fetch general account credits for one account without querying checkin.

    Keep this dynamic route after ``/api/checkin/credits/accounts``. Starlette
    resolves routes in declaration order, so placing it first makes the bulk
    path look like an account whose id is literally ``accounts``.
    """
    rec = auth.get_account_record(account_id)
    token = rec.get("token") or ""
    if not token:
        return JSONResponse(
            {"success": False, "error": "account not found or token missing"},
            status_code=404,
        )
    try:
        raw = await trae_client.fetch_account_credits(token)
        parsed = trae_client.parse_account_credits(raw)
        auth.merge_account_credits(account_id, {"account_credits": parsed})
        return JSONResponse(
            {
                "success": True,
                "id": account_id,
                "credits": parsed,
                "raw": raw,
            }
        )
    except Exception as e:
        return JSONResponse({"success": False, "error": str(e)}, status_code=502)


def _credits_user_name(raw: dict) -> str:
    """Extract the upstream 用户名 from an entitlement-usage response.

    The pay API sometimes carries the profile name (user_name / userName /
    screenName) next to the pack list; use whichever key shows up first.
    """
    if not isinstance(raw, dict):
        return ""
    for key in ("user_name", "userName", "screenName", "screen_name", "userNickName"):
        value = raw.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    user = raw.get("user") or raw.get("user_info")
    if isinstance(user, dict):
        for key in ("user_name", "userName", "screenName", "name"):
            value = user.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return ""


async def _fetch_full_credits(token: str) -> dict:
    """Fetch the merged general (通用) credits for one token.

    Upstream merged every pack into a single 通用积分 pool, so the relay only
    queries req_source=1 and no longer derives work/total splits.
    """
    raw_ac = await trae_client.fetch_account_credits(token)
    return {
        "account_credits": trae_client.parse_account_credits(raw_ac),
        "user_name": _credits_user_name(raw_ac),
    }


def _cached_checkin_account_snapshot(
    account_id: str, rec: dict | None = None
) -> dict:
    """Build one dashboard row from the persisted cache without an upstream call."""
    record = rec if rec is not None else auth.get_account_record(account_id)
    cached = dict(record.get("checkin") or {})
    return {
        "success": True,
        "id": account_id,
        "user_id": record.get("user_id", account_id),
        "label": record.get("label") or record.get("user_id") or account_id,
        "source": record.get("source", ""),
        "has_token": bool(record.get("token")),
        "is_active": account_id == auth.get_active_account_id(),
        "is_valid": bool(record.get("token")),
        "expires": record.get("expired_at", ""),
        "checked_in": cached.get("checked_in"),
        "credits": cached.get("credits"),
        "checkin_enable": cached.get("enable"),
        "account_credits": cached.get("account_credits"),
        "checkin_updated_at": record.get(
            "checkin_status_updated_at", record.get("checkin_updated_at", 0)
        ),
        "credits_updated_at": record.get("credits_updated_at", 0),
        "checkin": cached,
    }


def _checkin_cache_is_today(record: dict) -> bool:
    """Only trust a cached checked-in flag for today's Trae CN business day."""
    try:
        updated_at = float(record.get("checkin_status_updated_at") or 0)
    except (TypeError, ValueError):
        return False
    if updated_at <= 0:
        return False
    updated_date = datetime.fromtimestamp(updated_at, _CHECKIN_TIMEZONE).date()
    current_date = datetime.fromtimestamp(time.time(), _CHECKIN_TIMEZONE).date()
    return updated_date == current_date


def _checkin_response_is_rate_limited(data: dict) -> bool:
    return isinstance(data, dict) and (
        data.get("code") == 9074 or data.get("_error_code") == 9074
    )


def _checkin_auth_failed(data: dict) -> bool:
    """Detect a server-side token invalidation inside a business-code response."""
    if not isinstance(data, dict):
        return False
    if data.get("code") == 1001:
        return True
    text = str(data.get("message") or data.get("error") or "")
    return "not able to authenticate" in text


def _credits_auth_failed(exc: BaseException) -> bool:
    """Detect a server-side token invalidation inside a credits fetch error."""
    text = str(exc)
    return "[401]" in text or "not able to authenticate" in text


async def _fetch_credit_account_snapshot(
    account_id: str, rec: dict | None = None
) -> dict:
    """Refresh entitlement credits only, preserving cached daily-checkin state."""
    record = rec if rec is not None else auth.get_account_record(account_id)
    token = record.get("token") or ""
    if not token:
        raise KeyError("account not found or token missing")

    try:
        full = await _fetch_full_credits(token)
    except Exception as exc:
        if _credits_auth_failed(exc) and await auth.refresh_account(account_id):
            fresh = auth.get_account_record(account_id)
            full = await _fetch_full_credits(fresh.get("token") or "")
        else:
            raise
    patch = {key: value for key, value in full.items() if value is not None}
    merged = (
        auth.merge_account_credits(account_id, patch)
        if patch
        else dict(record.get("checkin") or {})
    )
    row = _cached_checkin_account_snapshot(account_id, record)
    row.update(
        {
            "account_credits": merged.get("account_credits"),
            "checkin": merged,
        }
    )
    return row


async def _sync_account_user_name(account_id: str) -> dict:
    """Fetch GetUserInfo once and sync the ScreenName into the account label."""
    record = auth.get_account_record(account_id)
    token = record.get("token") or ""
    if not token:
        raise KeyError("account not found or token missing")
    try:
        info = await trae_client.fetch_user_info(token)
    except Exception as exc:
        if _credits_auth_failed(exc) and await auth.refresh_account(account_id):
            fresh = auth.get_account_record(account_id)
            info = await trae_client.fetch_user_info(fresh.get("token") or "")
        else:
            raise
    name = str(info.get("ScreenName") or "").strip()
    label, changed = auth.sync_account_screen_name(
        account_id, name, str(info.get("UserID") or "")
    )
    out = {"label_synced": changed}
    if label:
        out["label"] = label
    if name:
        out["user_name"] = name
    return out


async def _fetch_checkin_status_snapshot(
    account_id: str,
    rec: dict | None = None,
    *,
    respect_pending: bool = True,
    use_cached_on_cooldown: bool = False,
) -> dict:
    """Refresh daily-checkin state only, never entitlement credits."""
    record = rec if rec is not None else auth.get_account_record(account_id)
    token = record.get("token") or ""
    if not token:
        raise KeyError("account not found or token missing")

    cached_row = _cached_checkin_account_snapshot(account_id, record)
    # The 9074 cooldown belongs to the *claim* endpoint only. Probing showed the
    # status endpoint keeps answering code=0 during that window, so skipping it
    # here only pinned the dashboard to a stale checked_in=false.
    cooldown_remaining = (
        _checkin_cooldown_remaining(account_id) if use_cached_on_cooldown else 0
    )
    if use_cached_on_cooldown:
        status_cooldown = _checkin_status_cooldown_remaining(account_id)
        if status_cooldown:
            # The status endpoint itself answered 9074 recently; probing again
            # only extends that window.
            return {
                **cached_row,
                "success": False,
                "stale": True,
                "rate_limited": True,
                "retryable": True,
                "retry_after_seconds": status_cooldown,
                "error": (
                    "Trae checkin status skipped [9074]: local cooldown active; "
                    f"retry after at least {status_cooldown}s"
                ),
            }

    status = await trae_client.fetch_checkin_credits_status(token, account_id)
    if _checkin_auth_failed(status):
        if await auth.refresh_account(account_id):
            fresh = auth.get_account_record(account_id)
            status = await trae_client.fetch_checkin_credits_status(
                fresh.get("token") or "", account_id
            )
    if _checkin_response_is_rate_limited(status):
        retry_after = _checkin_start_cooldown(account_id)
        _CHECKIN_STATUS_COOLDOWN_UNTIL[account_id] = time.monotonic() + retry_after
        return {
            **cached_row,
            "success": False,
            "rate_limited": True,
            "data": status,
            "retryable": True,
            "retry_after_seconds": retry_after,
            "error": _checkin_claim_error(status),
        }

    # A successful claim can be visible at the status endpoint a little later.
    # Keep accepted state monotonic during the grace window without issuing
    # extra automatic verification probes.
    now = time.monotonic()
    accepted_until = _CHECKIN_ACCEPTED_UNTIL.get(account_id, 0.0)
    if status.get("checked_in") is True:
        _CHECKIN_ACCEPTED_UNTIL.pop(account_id, None)
        status = {**status, "verification_pending": False}
        # The account is done for today, so a leftover 9074 backoff would only
        # block tomorrow's first claim. Retire it together with the cooldown.
        _CHECKIN_COOLDOWN_UNTIL.pop(account_id, None)
        _CHECKIN_STATUS_COOLDOWN_UNTIL.pop(account_id, None)
        if _checkin_retry_state(account_id)[0]:
            _checkin_clear_retry_state(account_id)
    elif respect_pending and accepted_until > now:
        status = {
            **status,
            "checked_in": True,
            "verification_pending": True,
        }
    elif accepted_until:
        _CHECKIN_ACCEPTED_UNTIL.pop(account_id, None)

    merged = auth.merge_account_checkin(account_id, status)
    row = {
        **cached_row,
        "checked_in": status.get("checked_in"),
        "credits": status.get("credits"),
        "checkin_enable": status.get("enable"),
        "checkin": status,
        "account_credits": merged.get("account_credits"),
        "checkin_updated_at": auth.get_account_record(account_id).get(
            "checkin_status_updated_at",
            auth.get_account_record(account_id).get(
                "checkin_updated_at", cached_row.get("checkin_updated_at", 0)
            ),
        ),
    }
    if cooldown_remaining and status.get("checked_in") is not True:
        # Report the live status and keep the claim window visible so the UI
        # does not invite a claim the upstream will reject with 9074.
        row.update(
            {
                "claim_rate_limited": True,
                "retryable": True,
                "retry_after_seconds": cooldown_remaining,
            }
        )
    return row


async def _fetch_checkin_account_snapshot(
    account_id: str,
    rec: dict | None = None,
    *,
    respect_pending: bool = True,
) -> dict:
    """Backward-compatible name for a checkin-only account refresh."""
    return await _fetch_checkin_status_snapshot(
        account_id,
        rec,
        respect_pending=respect_pending,
        use_cached_on_cooldown=True,
    )

def _checkin_claim_error(data: dict) -> str:
    """Format an upstream business-code failure without hiding its cause."""
    data = data if isinstance(data, dict) else {}
    code = data.get("code")
    message = data.get("message") or data.get("error") or "unknown upstream error"
    if code == 9074:
        retry_after = max(1, int(CHECKIN_RETRY_AFTER))
        message = f"{message}; upstream rate limit, retry after at least {retry_after}s"
    return f"Trae checkin failed [{code}]: {message}"


def _checkin_claim_ok(data: dict) -> bool:
    """Only code=0 is a successful claim; HTTP 200 alone is insufficient."""
    return isinstance(data, dict) and data.get("code") == 0


def _checkin_account_lock(account_id: str) -> asyncio.Lock:
    """Return an account lock that is safe across test event loops/reloads."""
    lock = _CHECKIN_ACCOUNT_LOCKS.get(account_id)
    current_loop = asyncio.get_running_loop()
    bound_loop = getattr(lock, "_loop", None) if lock is not None else None
    if lock is None or (bound_loop is not None and bound_loop is not current_loop):
        lock = asyncio.Lock()
        _CHECKIN_ACCOUNT_LOCKS[account_id] = lock
    return lock


def _checkin_claim_gate() -> asyncio.Lock:
    """Serialize actual upstream claims and enforce the configured interval."""
    global _CHECKIN_CLAIM_GATE, _CHECKIN_CLAIM_GATE_LOOP
    current_loop = asyncio.get_running_loop()
    if _CHECKIN_CLAIM_GATE is None or _CHECKIN_CLAIM_GATE_LOOP is not current_loop:
        _CHECKIN_CLAIM_GATE = asyncio.Lock()
        _CHECKIN_CLAIM_GATE_LOOP = current_loop
    return _CHECKIN_CLAIM_GATE


def _checkin_status_cooldown_remaining(account_id: str) -> int:
    """Return the remaining window after the *status* endpoint returned 9074.

    This is deliberately in-memory only: a claim-side 9074 is common and
    persisted, while a status-side 9074 is rare and must not survive a restart
    as a permanent read block.
    """

    until = _CHECKIN_STATUS_COOLDOWN_UNTIL.get(account_id, 0.0)
    remaining = until - time.monotonic()
    if remaining <= 0:
        _CHECKIN_STATUS_COOLDOWN_UNTIL.pop(account_id, None)
        return 0
    return max(1, int(remaining))


def _checkin_cooldown_remaining(account_id: str) -> int:
    until = _CHECKIN_COOLDOWN_UNTIL.get(account_id, 0.0)
    remaining = until - time.monotonic()
    if remaining <= 0:
        _CHECKIN_COOLDOWN_UNTIL.pop(account_id, None)
        # Fall back to persisted wall-clock retry deadline so a container
        # restart does not immediately re-hammer a still-limited upstream.
        rec = auth.get_account_record(account_id)
        checkin = rec.get("checkin") or {}
        backoff = float(checkin.get("retry_backoff") or 0)
        updated = float(checkin.get("retry_updated_at") or 0)
        if backoff > 0 and updated > 0:
            persisted_remaining = (updated + backoff) - time.time()
            if persisted_remaining > 0:
                remaining = persisted_remaining
    if remaining <= 0:
        return 0
    return max(1, int(remaining + 0.999))


def _checkin_retry_state(account_id: str) -> tuple[float, int]:
    """Return persisted (retry_after_backoff, consecutive_9074_count)."""
    rec = auth.get_account_record(account_id)
    checkin = rec.get("checkin") or {}
    backoff = float(checkin.get("retry_backoff") or 0)
    count = int(checkin.get("retry_9074_count") or 0)
    return backoff, count


def _checkin_persist_retry_state(
    account_id: str, backoff: float, count: int
) -> None:
    auth.merge_account_retry(
        account_id,
        {
            "retry_backoff": backoff,
            "retry_9074_count": count,
            "retry_updated_at": time.time(),
        },
    )


def _checkin_clear_retry_state(account_id: str) -> None:
    auth.merge_account_retry(
        account_id,
        {
            "retry_backoff": 0,
            "retry_9074_count": 0,
        },
    )


def _checkin_next_backoff(account_id: str) -> float:
    """Exponential backoff for one account's 9074 streak."""
    _, count = _checkin_retry_state(account_id)
    base = max(1.0, float(CHECKIN_RETRY_AFTER))
    # 9074 is an upstream capacity signal ("too many users"), not a penalty for
    # this account, and each retry now also rotates the device id. Escalate
    # gently so a still-unclaimed account keeps getting attempts within the
    # day instead of parking on the hour-long ceiling.
    backoff = base * (2 ** min(count, CHECKIN_9074_BACKOFF_EXPONENT_CAP))
    max_backoff = max(base, float(CHECKIN_9074_MAX_BACKOFF))
    return max(base, min(backoff, max_backoff))


def _checkin_start_cooldown(account_id: str, retry_after: float | None = None) -> int:
    """Start one account's local cooldown after an upstream 9074 response."""
    if retry_after is None:
        retry_after = _checkin_next_backoff(account_id)
    retry_after = max(1, int(retry_after))
    _CHECKIN_COOLDOWN_UNTIL[account_id] = time.monotonic() + retry_after
    _, count = _checkin_retry_state(account_id)
    _checkin_persist_retry_state(account_id, float(retry_after), count + 1)
    return retry_after


def _checkin_mark_accepted(account_id: str, snapshot: dict, *, pending: bool) -> None:
    """Persist a successful claim without allowing missing fields to erase cache."""
    cached = auth.get_account_record(account_id).get("checkin") or {}
    checkin = dict(cached)
    checkin.update(snapshot.get("checkin") or {})
    checkin["checked_in"] = True
    if pending:
        checkin["verification_pending"] = True
    else:
        checkin.pop("verification_pending", None)
    for key in ("account_credits",):
        value = snapshot.get(key)
        if value is not None:
            checkin[key] = value
    auth.merge_account_checkin(account_id, checkin)


def _checkin_cooldown_payload(snapshot: dict, retry_after: int) -> dict:
    data = {
        "code": 9074,
        "message": "local cooldown active; upstream claim was not sent",
    }
    return {
        **snapshot,
        "success": False,
        "skipped": True,
        "claim_sent": False,
        "data": data,
        "retryable": True,
        "retry_after_seconds": retry_after,
        "error": f"Trae checkin skipped [9074]: local cooldown active; retry after at least {retry_after}s",
    }


def _checkin_device_rotation_enabled() -> bool:
    """Whether a 9074 claim may rotate to a fresh device id.

    Set ``TRAE_CHECKIN_NO_DEVICE_ROTATION=1`` to keep one fixed id per account.
    """

    return str(
        os.environ.get("TRAE_CHECKIN_NO_DEVICE_ROTATION", "")
    ).strip().lower() not in {"1", "true", "yes", "on"}


async def _claim_checkin_throttled(account_id: str, token: str) -> tuple[dict | None, int]:
    """Send at most one claim after account cooldown and global spacing checks."""
    remaining = _checkin_cooldown_remaining(account_id)
    if remaining:
        return None, remaining

    global _CHECKIN_NEXT_CLAIM_AT
    async with _checkin_claim_gate():
        remaining = _checkin_cooldown_remaining(account_id)
        if remaining:
            return None, remaining
        wait_for = max(0.0, _CHECKIN_NEXT_CLAIM_AT - time.monotonic())
        if wait_for:
            await asyncio.sleep(wait_for)
        try:
            data = await trae_client.claim_checkin_credits(token, account_id)
        finally:
            _CHECKIN_NEXT_CLAIM_AT = time.monotonic() + max(0.0, CHECKIN_INTERVAL)

        if data.get("code") == 9074:
            # 9074 is scoped to the device id, not the account: the same token
            # claims successfully on a freshly derived id. Rotate once and retry
            # before falling back to a timed cooldown.
            if _checkin_device_rotation_enabled() and trae_client.rotate_checkin_device_id(
                token, account_id
            ):
                logger.info(
                    "checkin 9074 account=%s: rotated device id, retrying once",
                    account_id,
                )
                try:
                    data = await trae_client.claim_checkin_credits(token, account_id)
                finally:
                    _CHECKIN_NEXT_CLAIM_AT = time.monotonic() + max(
                        0.0, CHECKIN_INTERVAL
                    )
        if data.get("code") == 9074:
            retry_after = _checkin_start_cooldown(account_id)
            until = time.monotonic() + retry_after
            _CHECKIN_NEXT_CLAIM_AT = max(_CHECKIN_NEXT_CLAIM_AT, until)
            return data, retry_after
        if _checkin_claim_ok(data):
            _CHECKIN_COOLDOWN_UNTIL.pop(account_id, None)
            _checkin_clear_retry_state(account_id)
        return data, 0


async def _claim_checkin_account(account_id: str) -> dict:
    """Lock, use today's cache when available, and send at most one claim."""
    lock = _checkin_account_lock(account_id)
    async with lock:
        record = auth.get_account_record(account_id)
        token = record.get("token") or ""
        if not token:
            return {
                "success": False,
                "id": account_id,
                "error": "account not found or token missing",
            }

        before = _cached_checkin_account_snapshot(account_id, record)
        accepted_recently = _CHECKIN_ACCEPTED_UNTIL.get(account_id, 0.0) > time.monotonic()
        if accepted_recently:
            before["checked_in"] = True
            before["verification_pending"] = True
        if before.get("checked_in") is True and (
            accepted_recently or _checkin_cache_is_today(record)
        ):
            _CHECKIN_COOLDOWN_UNTIL.pop(account_id, None)
            _checkin_clear_retry_state(account_id)
            return {
                **before,
                "success": True,
                "skipped": True,
                "claim_sent": False,
                "data": {"code": 0, "message": "already checked in, skipped"},
            }

        cooldown = _checkin_cooldown_remaining(account_id)
        if cooldown:
            return _checkin_cooldown_payload(before, cooldown)

        try:
            data, retry_after = await _claim_checkin_throttled(account_id, token)
        except Exception as exc:
            return {**before, "success": False, "claim_sent": False, "error": str(exc)}

        if data is None:
            return _checkin_cooldown_payload(before, retry_after)

        if _checkin_auth_failed(data) and await auth.refresh_account(account_id):
            # Server-side token invalidation: rotate this account and retry the
            # claim once instead of surfacing a transient auth error.
            fresh = auth.get_account_record(account_id)
            data, retry_after = await _claim_checkin_throttled(
                account_id, fresh.get("token") or ""
            )
            if data is None:
                return _checkin_cooldown_payload(before, retry_after)

        if data.get("code") == 9074:
            # A 9074 response is already a rate-limit signal.  Querying status
            # immediately after it only compounds the upstream frequency limit.
            payload = _checkin_cooldown_payload(before, retry_after)
            payload["skipped"] = False
            payload["claim_sent"] = True
            payload["data"] = data
            payload["error"] = _checkin_claim_error(data)
            return payload

        if not _checkin_claim_ok(data):
            return {
                **before,
                "success": False,
                "skipped": False,
                "claim_sent": True,
                "data": data,
                "error": _checkin_claim_error(data),
            }

        # Code 0 is an accepted claim.  Persist it immediately; the explicit
        # status button can verify later without making the claim path noisy.
        _CHECKIN_ACCEPTED_UNTIL[account_id] = time.monotonic() + max(
            10.0, float(CHECKIN_RETRY_AFTER)
        )
        _CHECKIN_COOLDOWN_UNTIL.pop(account_id, None)
        _checkin_clear_retry_state(account_id)
        latest = {**before, "checked_in": True, "verification_pending": True}
        _checkin_mark_accepted(account_id, latest, pending=True)

        payload = {
            **latest,
            "success": True,
            "skipped": False,
            "claim_sent": True,
            "data": data,
            "checked_in": True,
        }
        payload["verification_pending"] = True
        return payload


@app.post("/api/checkin/claim-all")
async def api_checkin_claim_all():
    """One-click polling checkin for every stored account.

    Claims are strictly ordered, and this endpoint does not perform a status or
    credit refresh.  The separate dashboard query buttons own those reads;
    keeping them out of this path prevents a claim burst from becoming a 9074
    burst as well.
    """
    raw_accounts = list(auth.get_accounts_raw())
    active_id = auth.get_active_account_id()
    results = []
    for aid, rec in raw_accounts:
        token = rec.get("token") or ""
        row = _cached_checkin_account_snapshot(aid, rec)
        row["is_active"] = aid == active_id
        if not token:
            row["success"] = False
            row["skipped"] = False
            row["error"] = "No token"
            results.append(row)
            continue
        claimed = await _claim_checkin_account(row["id"])
        results.append({**row, **claimed})
    return JSONResponse({"success": True, "accounts": results, "interval": CHECKIN_INTERVAL})

@app.post("/api/checkin/claim-credits")
async def api_checkin_claim_credits():
    """Credit-ordered polling checkin.

    First fetches total entitlement credits for every account, sorts
    accounts by remaining credits descending (higher credits first),
    then processes them one by one with the standard interval.
    """
    results = []
    raw_accounts = list(auth.get_accounts_raw())
    records_by_id = {account_id: record for account_id, record in raw_accounts}
    enriched = []

    for aid, rec in raw_accounts:
        token = rec.get("token") or ""
        label = rec.get("label") or rec.get("user_id") or aid
        row = {
            "id": aid,
            "label": label,
            "user_id": rec.get("user_id", ""),
            "is_active": aid == auth.get_active_account_id(),
        }
        if not token:
            row["success"] = False
            row["error"] = "No token"
            row["credits_sort"] = -1
            enriched.append(row)
            continue

        cached = rec.get("checkin") or {}
        row["checked_in"] = cached.get("checked_in")
        row["checkin"] = cached

        credits_sort = 0
        try:
            full = await _fetch_full_credits(token)
            row.update(full)
            parsed = full.get("account_credits") or {}
            # Every pack lives in the merged 通用积分 pool, so the single
            # account_credits value drives the credit-priority ordering.
            credits_sort = parsed.get("remaining") or parsed.get("total_limit") or 0
            if parsed.get("unlimited"):
                credits_sort = 999999999
            fresh_checkin = dict(rec.get("checkin") or {})
            fresh_checkin.update({key: value for key, value in full.items() if value is not None})
            row["checkin"] = auth.merge_account_credits(aid, fresh_checkin)
        except Exception:
            row["account_credits"] = None
            credits_sort = 0

        row["credits_sort"] = credits_sort
        enriched.append(row)

    # Sort by credits descending (richer accounts first)
    enriched.sort(key=lambda x: x.get("credits_sort", 0), reverse=True)

    for row in enriched:
        if row.get("error"):
            results.append(row)
            continue
        if row.get("checked_in") is True and _checkin_cache_is_today(
            records_by_id.get(row["id"], {})
        ):
            row["success"] = True
            row["skipped"] = True
            row["data"] = {"code": 0, "message": "already checked in, skipped"}
            results.append(row)
            continue
        claimed = await _claim_checkin_account(row["id"])
        results.append({**row, **claimed})

    for r in results:
        if "credits_sort" in r:
            del r["credits_sort"]

    return JSONResponse({"success": True, "accounts": results, "interval": CHECKIN_INTERVAL})

@app.get("/api/checkin/account/{account_id}")
async def api_checkin_account_status(account_id: str):
    """Refresh only the requested account without sending a claim."""
    try:
        return JSONResponse(await _fetch_checkin_account_snapshot(account_id))
    except KeyError as exc:
        return JSONResponse({"success": False, "error": str(exc.args[0])}, status_code=404)
    except Exception as exc:
        return JSONResponse({"success": False, "error": str(exc)}, status_code=502)


@app.post("/api/checkin/account/{account_id}")
async def api_checkin_account(account_id: str):
    """Check in one account, avoiding duplicate or parallel claim requests."""
    if not (auth.get_account_record(account_id).get("token") or ""):
        return JSONResponse(
            {"success": False, "error": "account not found or token missing"},
            status_code=404,
        )
    return JSONResponse(await _claim_checkin_account(account_id))

@app.post("/api/checkin/claim")
async def api_checkin_claim():
    account_id = auth.get_active_account_id()
    if not account_id:
        return JSONResponse(
            {"success": False, "error": "no active account"}, status_code=404
        )
    return JSONResponse(await _claim_checkin_account(account_id))

# ---- Account management & settings endpoints ----

@app.post("/api/logout")
async def api_logout():
    auth.logout_active()
    return JSONResponse({"success": True})


@app.get("/api/accounts")
async def api_accounts():
    accounts = auth.list_accounts()
    polling = auth.get_polling_status()
    return JSONResponse({"success": True, "accounts": accounts, "polling": polling, "active": polling.get("active_account", "")})


@app.post("/api/accounts/switch")
async def api_accounts_switch(request: Request):
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"success": False, "error": "Invalid JSON body"}, status_code=400)
    account_id = body.get("account_id") or body.get("id") or ""
    if not account_id:
        return JSONResponse({"success": False, "error": "account_id is required"}, status_code=400)
    ok = auth.switch_account(account_id)
    if not ok:
        return JSONResponse({"success": False, "error": "account not found"}, status_code=404)
    accounts = auth.list_accounts()
    active = auth.get_active_account_id()
    account = next((item for item in accounts if item.get("id") == active), None)
    return JSONResponse(
        {
            "success": True,
            "active": active,
            "account": account,
            "accounts": accounts,
        },
        headers={"Cache-Control": "no-store"},
    )


@app.post("/api/accounts/model-enabled")
async def api_accounts_model_enabled(request: Request):
    """Toggle whether one account receives new model requests.

    This endpoint intentionally does not touch check-in state.  Disabled
    accounts remain visible and continue to participate in all daily
    check-in/status/credits operations.
    """
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(
            {"success": False, "error": "Invalid JSON body"}, status_code=400
        )
    if not isinstance(body, dict):
        return JSONResponse(
            {"success": False, "error": "JSON body must be an object"}, status_code=400
        )
    account_id = body.get("account_id") or body.get("id") or ""
    if not isinstance(account_id, str) or not account_id.strip():
        return JSONResponse(
            {"success": False, "error": "account_id is required"}, status_code=400
        )
    if "enabled" not in body and "model_enabled" not in body:
        return JSONResponse(
            {"success": False, "error": "enabled is required"}, status_code=400
        )
    value = body.get("enabled", body.get("model_enabled"))
    if isinstance(value, bool):
        enabled = value
    elif isinstance(value, str) and value.strip().lower() in {"true", "false"}:
        enabled = value.strip().lower() == "true"
    else:
        return JSONResponse(
            {"success": False, "error": "enabled must be a boolean"}, status_code=400
        )
    account_id = account_id.strip()
    if not auth.set_account_model_enabled(account_id, enabled):
        return JSONResponse(
            {"success": False, "error": "account not found"}, status_code=404
        )
    account = next(
        (item for item in auth.list_accounts() if item.get("id") == account_id),
        None,
    )
    return JSONResponse(
        {
            "success": True,
            "account": account,
            "account_id": account_id,
            "model_enabled": bool(account and account.get("model_enabled", enabled)),
        },
        headers={"Cache-Control": "no-store"},
    )


@app.post("/api/accounts/remove")
async def api_accounts_remove(request: Request):
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"success": False, "error": "Invalid JSON body"}, status_code=400)
    account_id = body.get("account_id") or body.get("id") or ""
    if not account_id:
        return JSONResponse({"success": False, "error": "account_id is required"}, status_code=400)
    ok = auth.remove_account(account_id)
    if not ok:
        return JSONResponse({"success": False, "error": "account not found"}, status_code=404)
    return JSONResponse({"success": True})


@app.post("/api/settings")
async def api_settings(request: Request):
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"success": False, "error": "Invalid JSON body"}, status_code=400)
    if not isinstance(body, dict):
        return JSONResponse({"success": False, "error": "JSON body must be an object"}, status_code=400)
    web_base_url = body.get("web_base_url") or ""
    upstream_mode = body.get("upstream_mode") or ""
    endpoint_id = body.get("endpoint_id")
    # Older clients only know URL/mode and do not send the newer preset
    # identity.  Keep ``None`` for a port-only update, where the existing
    # endpoint must remain untouched; endpoint-field updates are migrated below.
    endpoint_fields_present = (
        "web_base_url" in body or "upstream_mode" in body or "endpoint_id" in body
    )
    legacy_endpoint_update = endpoint_id is None and endpoint_fields_present
    if not isinstance(web_base_url, str) or not isinstance(upstream_mode, str):
        return JSONResponse({"success": False, "error": "URL and mode must be strings"}, status_code=400)
    if endpoint_id is not None and not isinstance(endpoint_id, str):
        return JSONResponse({"success": False, "error": "endpoint_id must be a string"}, status_code=400)
    web_base_url = web_base_url.strip().rstrip("/")
    upstream_mode = upstream_mode.strip().lower()
    endpoint_id = endpoint_id.strip().lower() if isinstance(endpoint_id, str) else None
    if endpoint_id:
        endpoint = next(
            (
                item
                for item in UPSTREAM_ENDPOINT_PRESETS
                if str(item.get("id") or "").strip().lower() == endpoint_id
            ),
            None,
        )
        if endpoint is None:
            return JSONResponse(
                {"success": False, "error": f"Unsupported endpoint preset: {endpoint_id}"},
                status_code=400,
            )
        # The preset id is authoritative.  This prevents a stale client URL or
        # mode field from turning Work Agent into Remote (or IDE Agent into Raw).
        if not web_base_url:
            web_base_url = str(endpoint["base_url"]).rstrip("/")
        if not upstream_mode:
            upstream_mode = str(endpoint["mode"]).strip().lower()
        if web_base_url != str(endpoint["base_url"]).rstrip("/") or upstream_mode != str(endpoint["mode"]).strip().lower():
            return JSONResponse(
                {"success": False, "error": "endpoint_id does not match URL/mode"},
                status_code=400,
            )
    elif legacy_endpoint_update and (web_base_url or upstream_mode):
        # Older clients only sent URL/mode.  Migrate those updates to the
        # unique preset when possible, and clear a stale shared-URL identity
        # when the update is custom or ambiguous.  Without this step a prior
        # ``raw``/``remote`` id can survive a legacy update and overwrite the
        # newly selected mode after the next restart.
        matches = [
            item
            for item in UPSTREAM_ENDPOINT_PRESETS
            if (
                not web_base_url
                or web_base_url == str(item.get("base_url") or "").rstrip("/")
            )
            and (
                not upstream_mode
                or upstream_mode == str(item.get("mode") or "").strip().lower()
            )
        ]
        endpoint_id = (
            str(matches[0].get("id") or "").strip().lower()
            if len(matches) == 1
            else ""
        )
    relay_port = body.get("relay_port", body.get("port", 0))
    port_requested = "relay_port" in body or "port" in body
    if upstream_mode and upstream_mode not in _VALID_UPSTREAM_MODES:
        return JSONResponse(
            {"success": False, "error": f"Unsupported upstream mode: {upstream_mode}"},
            status_code=400,
        )
    if port_requested:
        if (
            isinstance(relay_port, bool)
            or not isinstance(relay_port, (int, str))
            or not str(relay_port).strip().isdigit()
        ):
            return JSONResponse({"success": False, "error": "relay_port must be an integer between 1 and 65535"}, status_code=400)
        relay_port = int(relay_port)
        if not 1 <= relay_port <= 65535:
            return JSONResponse({"success": False, "error": "relay_port must be between 1 and 65535"}, status_code=400)
    if not web_base_url and not relay_port and not upstream_mode and endpoint_id is None:
        return JSONResponse({"success": False, "error": "nothing to update"}, status_code=400)
    relay_settings = {
        "web_base_url": web_base_url,
        "port": relay_port,
        "upstream_mode": upstream_mode,
    }
    # Keep the new keyword out of port-only calls for compatibility with
    # older store adapters.  Passing ``None`` is semantically equivalent in
    # the current adapter, but legacy wrappers may treat it as an overwrite.
    if endpoint_id is not None:
        relay_settings["endpoint_id"] = endpoint_id
    auth.set_relay_settings(**relay_settings)
    if upstream_mode:
        # Synchronise the running module so _current_upstream_mode() reflects
        # the new preset immediately without a container restart.
        global UPSTREAM_MODE
        UPSTREAM_MODE = upstream_mode
        os.environ["UPSTREAM_MODE"] = upstream_mode
    note = (
        "Relay 端口已保存；需同步 Docker 端口映射并重启容器生效"
        if relay_port
        else "上游端点设置已保存"
    )
    return JSONResponse(
        {
            "success": True,
            "note": note,
            "settings": auth.get_settings(),
        }
    )


def _truthy(value: Any) -> bool:
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return bool(value)


@app.get("/api/auto-route")
async def api_get_auto_route():
    return JSONResponse(
        {
            "success": True,
            **auth.get_auto_route_settings(),
            "tool_endpoint": AUTO_ROUTE_TOOL_ENDPOINT,
            "chat_endpoint": AUTO_ROUTE_CHAT_ENDPOINT,
        }
    )


@app.post("/api/auto-route")
async def api_set_auto_route(request: Request):
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"success": False, "error": "Invalid JSON body"}, status_code=400)
    if not isinstance(body, dict) or "enabled" not in body:
        return JSONResponse({"success": False, "error": "enabled is required"}, status_code=400)
    settings = auth.set_auto_route_settings(_truthy(body.get("enabled")))
    return JSONResponse({"success": True, **settings})


@app.get("/api/auto-checkin")
async def api_get_auto_checkin():
    return JSONResponse(_auto_checkin_payload(), headers={"Cache-Control": "no-store"})


@app.post("/api/auto-checkin")
async def api_set_auto_checkin(request: Request):
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"success": False, "error": "Invalid JSON body"}, status_code=400)
    if not isinstance(body, dict) or "enabled" not in body:
        return JSONResponse({"success": False, "error": "enabled is required"}, status_code=400)
    try:
        auth.set_auto_checkin_settings(_truthy(body.get("enabled")), body.get("time"))
    except ValueError as exc:
        return JSONResponse({"success": False, "error": str(exc)}, status_code=400)
    return JSONResponse(_auto_checkin_payload())


@app.post("/api/auto-checkin/run")
async def api_run_auto_checkin():
    if _AUTO_CHECKIN_LOCK.locked():
        return JSONResponse({**_auto_checkin_payload(), "started": False, "error": "already running"})
    asyncio.create_task(_auto_checkin_cycle("manual"))
    await asyncio.sleep(0)
    return JSONResponse({**_auto_checkin_payload(), "started": True})


@app.get("/api/max-mode")
async def api_get_max_mode():
    return JSONResponse({"success": True, **auth.get_max_mode_settings()})


@app.post("/api/max-mode")
async def api_set_max_mode(request: Request):
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"success": False, "error": "Invalid JSON body"}, status_code=400)
    if not isinstance(body, dict) or "enabled" not in body:
        return JSONResponse({"success": False, "error": "enabled is required"}, status_code=400)
    models = body.get("models", "")
    if models is None:
        models = ""
    if not isinstance(models, (str, list)):
        return JSONResponse(
            {"success": False, "error": "models must be a string or list"}, status_code=400
        )
    settings = auth.set_max_mode_settings(_truthy(body.get("enabled")), models)
    return JSONResponse({"success": True, **settings})


def _number_or_none(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _project_model_config(name, config):
    """Project an upstream model config into what the console table shows.

    This is an allowlist, not a subtraction: the raw config also carries
    ``ak``/``sk``/``base_url``/``auth_type``, which are credential material.
    They are blank in the payload we see today, and an allowlist keeps them
    out when they are not.

    Consumption and discount, in order of precedence:
      * ``features.consumption_rate.data.rate`` is the list price.
      * ``features.discount`` is a member discount carrying
        ``member_discount`` percent plus the already-reduced rate.
      * ``features.activity_discount`` is a subsidy or off-peak deal whose
        ``member``/``subsidy`` branch carries ``after_consumption_rate``.
    The shown rate is what the account pays now, so the discount is visible
    instead of a list price nobody is charged.
    """
    features = config.get("features")
    features = features if isinstance(features, Mapping) else {}

    context = config.get("context_window_tokens")
    context = context if isinstance(context, Mapping) else {}
    context_dev = _number_or_none(context.get("dev"))
    context_max = _number_or_none(context.get("max"))

    rate_block = features.get("consumption_rate")
    rate_block = rate_block if isinstance(rate_block, Mapping) else {}
    rate_data = rate_block.get("data")
    rate_data = rate_data if isinstance(rate_data, Mapping) else {}
    rate = _number_or_none(rate_data.get("rate"))

    discount_percent = None
    discount_kind = ""
    member = features.get("discount")
    if isinstance(member, Mapping) and member.get("enable"):
        data = member.get("data")
        data = data if isinstance(data, Mapping) else {}
        discount_percent = _number_or_none(data.get("member_discount"))
        discount_kind = str(member.get("subKey") or "member_discount")
        reduced = _number_or_none(data.get("consumption_rate"))
        if reduced is not None:
            rate = reduced
    activity = features.get("activity_discount")
    if isinstance(activity, Mapping) and activity.get("enable"):
        data = activity.get("data")
        data = data if isinstance(data, Mapping) else {}
        # An activity discount is conditional (an off-peak window, or a
        # membership tier), so it does not change what is charged right now.
        # ``current`` is the branch in force; the others describe the offer.
        current = data.get("current")
        if isinstance(current, Mapping):
            now = _number_or_none(current.get("consumption_rate"))
            if now is not None:
                rate = now
        best = None
        for branch in ("current", "member", "subsidy", "off_peak"):
            entry = data.get(branch)
            if not isinstance(entry, Mapping):
                continue
            percent = _number_or_none(entry.get("discount"))
            # discount: 100 means "no reduction"; keep those out of the table.
            if percent is not None and percent < 100:
                best = percent if best is None else min(best, percent)
        if best is not None:
            discount_percent = best
            discount_kind = str(activity.get("subKey") or "activity_discount")

    reasoning = config.get("reasoning_effort_config")
    reasoning = reasoning if isinstance(reasoning, Mapping) else {}
    options = reasoning.get("options")
    options = [str(item) for item in options] if isinstance(options, list) else []

    icon = config.get("icon")
    icon = icon if isinstance(icon, Mapping) else {}
    video = features.get("video_multimodal")
    custom_id = config.get("custom_model_id")

    return {
        "name": str(name),
        "display_name": str(config.get("display_name") or name),
        "config_name": str(config.get("config_name") or name),
        "model_name": str(config.get("model_name") or name),
        "provider": str(config.get("provider") or ""),
        "custom_model_id": "" if custom_id in (None, "") else str(custom_id),
        "multimodal": bool(config.get("multimodal")),
        "max_mode": bool(config.get("max_mode")),
        "supports_thinking": bool(reasoning.get("support_thinking")),
        "supports_video": bool(video.get("enable")) if isinstance(video, Mapping) else False,
        "is_default": bool(config.get("is_default")),
        "is_preset": bool(config.get("is_preset")),
        "is_new": bool(config.get("is_new")),
        "is_beta": bool(config.get("is_beta")),
        "context_dev": int(context_dev) if context_dev else 0,
        "context_max": int(context_max) if context_max else 0,
        "consumption_rate": rate,
        "discount_percent": discount_percent,
        "discount_kind": discount_kind,
        "reasoning_options": options,
        "reasoning_default": str(reasoning.get("default_level") or ""),
        "icon_light": str(icon.get("light") or ""),
        "icon_dark": str(icon.get("dark") or ""),
    }


@app.get("/api/models/detail")
async def api_models_detail():
    """The console model table: capabilities, contexts, credit rates."""

    try:
        configs = await trae_client._fetch_web_model_configs()
    except Exception as exc:
        logger.warning("model detail lookup failed: %s", exc)
        return JSONResponse(
            {"success": False, "error": "上游模型列表获取失败"},
            status_code=502,
        )
    if not configs:
        return JSONResponse(
            {"success": False, "error": "上游模型列表为空或需要重新登录"},
            status_code=502,
        )
    models = [
        _project_model_config(name, config)
        for name, config in configs.items()
        if isinstance(config, Mapping)
    ]
    models.sort(key=lambda item: (not item["is_default"], item["name"].lower()))
    return JSONResponse(
        {
            "success": True,
            "total": len(models),
            "max_mode_count": sum(1 for item in models if item["max_mode"]),
            "multimodal_count": sum(1 for item in models if item["multimodal"]),
            "models": models,
        }
    )


def _max_context_of(config: Mapping[str, Any]) -> int:
    size = config.get("context_window_size")
    if isinstance(size, Mapping):
        raw = size.get("max")
        if isinstance(raw, list):
            raw = raw[0] if raw else None
        if raw:
            try:
                return int(raw)
            except (TypeError, ValueError):
                pass
    tokens = config.get("context_window_tokens")
    if isinstance(tokens, Mapping) and tokens.get("max"):
        try:
            return int(tokens.get("max"))
        except (TypeError, ValueError):
            pass
    return 0


@app.get("/api/max-mode/models")
async def api_max_mode_models():
    """List Agent-tier models the active account marks with ``max_mode``."""

    account_id, record = auth.get_active_account_snapshot()
    token = str((record or {}).get("token") or "") or str(auth.get_token() or "")
    if not token:
        return JSONResponse({"success": False, "error": "没有可用账号"}, status_code=400)
    provider = (record or {}).get("provider_specific") or (record or {}).get(
        "providerSpecificData"
    )
    configs = await trae_client._fetch_web_model_configs(
        token_override=token,
        provider_specific=dict(provider) if isinstance(provider, Mapping) else None,
        agent_type="solo_agent_remote",
    )
    models = [
        {
            "name": name,
            "display_name": str(cfg.get("display_name") or name),
            "max_context": _max_context_of(cfg),
        }
        for name, cfg in configs.items()
        if isinstance(cfg, Mapping) and cfg.get("max_mode")
    ]
    if not configs:
        return JSONResponse(
            {"success": False, "error": "上游模型列表获取失败"}, status_code=502
        )
    return JSONResponse({"success": True, "account_id": account_id, "models": models})


@app.get("/api/polling")
async def api_get_polling():
    polling = auth.get_polling_status()
    return JSONResponse({"success": True, "enabled": polling.get("enabled", False), "mode": polling.get("mode", "round-robin")})


@app.post("/api/polling-mode")
async def api_polling_mode(request: Request):
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"success": False, "error": "Invalid JSON body"}, status_code=400)
    mode = (body.get("mode") or "").strip()
    if not mode:
        return JSONResponse({"success": False, "error": "mode is required"}, status_code=400)
    if mode not in ("round-robin", "credit-priority"):
        return JSONResponse({"success": False, "error": "mode must be round-robin or credit-priority"}, status_code=400)
    auth.set_polling_mode(mode)
    return JSONResponse({"success": True, "mode": mode})
@app.post("/api/polling")
async def api_polling(request: Request):
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"success": False, "error": "Invalid JSON body"}, status_code=400)
    enabled = bool(body.get("enabled", False))
    auth.set_polling(enabled)
    mode = (body.get("mode") or "").strip()
    if mode in ("round-robin", "credit-priority"):
        auth.set_polling_mode(mode)
    polling = auth.get_polling_status()
    return JSONResponse({"success": True, "enabled": enabled, "mode": polling.get("mode", "round-robin")})
