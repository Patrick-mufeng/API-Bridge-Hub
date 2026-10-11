"""In-process Trae OAuth callback listener.

Trae forces the authorization callback to http://127.0.0.1:<port>/authorize.
A browser page cannot listen on a local TCP port, so the relay runs this
listener inside its own process and writes the credentials directly through
the auth store. This replaces the old flow that made the operator download
and run a helper script by hand.

Bound to 127.0.0.1 on purpose: the relay is expected to run on the same
machine as the browser. Nothing here is reachable from the network.

Security: every login attempt registers a one-time, expiring state nonce.
A callback is honored only when its state matches a registered, unconsumed
nonce, which closes the hole where anyone who could reach the web-auth
endpoint could inject credentials.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import urllib.parse
import uuid

logger = logging.getLogger("trae-free.web_auth")

DEFAULT_LISTENER_PORT = 8765
LOGIN_STATE_TTL_SECONDS = 15 * 60

# Identity fields Trae expects on the authorization URL. Kept identical to the
# values the native client sends so the authorization page accepts the request.
_AUTH_PARAMS = {
    "login_version": "1",
    "auth_from": "solo",
    "login_channel": "native_ide",
    "plugin_version": "2.3.24254",
    "auth_type": "local",
    "redirect": "0",
    "x_device_brand": "ASUS TUF Gaming A15 FA507RM_FA507RM",
    "x_device_type": "windows",
    "x_os_version": "Windows 10 Pro",
    "x_env": "",
    "x_app_version": "3.3.65",
    "x_app_type": "stable",
    "hide_saas_login": "true",
}


class LoginRegistry:
    """One-time, expiring state nonces for in-flight login attempts."""

    def __init__(self, ttl: float = LOGIN_STATE_TTL_SECONDS) -> None:
        self._ttl = ttl
        self._issued: dict[str, float] = {}

    def register(self, state: str, *, now: float | None = None) -> None:
        if not state:
            return
        self._issued[state] = time.time() if now is None else now

    def consume(self, state: str, *, now: float | None = None) -> bool:
        """Validate and burn a state. True only for a fresh registered nonce."""
        if not state:
            return False
        stamp = self._issued.pop(state, None)
        if stamp is None:
            return False
        current = time.time() if now is None else now
        return current - stamp <= self._ttl

    def prune(self, *, now: float | None = None) -> int:
        """Drop expired nonces; returns how many were removed."""
        current = time.time() if now is None else now
        stale = [s for s, t in self._issued.items() if current - t > self._ttl]
        for state in stale:
            self._issued.pop(state, None)
        return len(stale)

    def __len__(self) -> int:
        return len(self._issued)


_REGISTRY = LoginRegistry()


def get_registry() -> LoginRegistry:
    """Process-wide registry shared by the API routes and the listener."""
    return _REGISTRY


def new_state() -> str:
    return str(uuid.uuid4())


def build_auth_url(
    state: str,
    *,
    client_id: str,
    auth_url: str,
    listener_port: int,
) -> str:
    """Build the Trae authorization URL whose callback hits this listener."""
    params = dict(_AUTH_PARAMS)
    params.update(
        {
            "client_id": client_id,
            "login_trace_id": state,
            "auth_callback_url": "http://127.0.0.1:%d/authorize" % listener_port,
        }
    )
    separator = "&" if "?" in auth_url else "?"
    return auth_url + separator + urllib.parse.urlencode(params)


def _escape(value: str) -> str:
    """Escape text for an HTML text node AND for a JS string literal.

    The result page puts the login trace id inside a single-line JS string, so
    a value that is safe in HTML is not automatically safe there: an unescaped
    backslash before the closing quote escapes that quote and turns the rest of
    the trace id into code. Escaping the backslash is what makes the quoting
    hold; the quote and angle-bracket escapes keep the text node safe.
    """
    return (
        str(value)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        # Backslash first, so the escapes added below are not themselves escaped.
        .replace(chr(92), chr(92) + chr(92))
        .replace(chr(34), "&quot;")
        .replace(chr(39), "&#39;")
    )


def _page(title: str, detail: str, *, success: bool, state: str) -> bytes:
    """Result page that notifies the opener and closes itself."""
    accent = "#46d67f" if success else "#ff5d6c"
    script = (
        "try{if(window.opener){window.opener.postMessage({"
        'type:"trae-relay-web-login",success:@@FLAG@@,loginTraceId:"@@STATE@@"'
        '}, "*");}}catch(e){}setTimeout(function(){window.close();},@@DELAY@@);'
    )
    html = _PAGE_TEMPLATE.replace("@@TITLE@@", _escape(title))
    html = html.replace("@@DETAIL@@", _escape(detail))
    html = html.replace("@@ACCENT@@", accent)
    html = html.replace(
        "@@SCRIPT@@",
        script.replace("@@FLAG@@", "true" if success else "false")
        .replace("@@STATE@@", _escape(state))
        .replace("@@DELAY@@", "800" if success else "4000"),
    )
    return html.encode("utf-8")


_PAGE_TEMPLATE = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>@@TITLE@@</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#0b0e14;color:#dce7f2;font:14px/1.6 ui-monospace,Consolas,monospace}
.box{border:2px solid #2d3849;background:#11161f;padding:24px 28px;max-width:460px;
box-shadow:4px 4px 0 0 rgba(0,0,0,.5)}
h1{font-size:16px;margin:0 0 10px;color:@@ACCENT@@}
p{margin:0;color:#94a5ba;font-size:13px;line-height:1.6}
</style></head>
<body><div class="box"><h1>@@TITLE@@</h1><p>@@DETAIL@@</p></div>
<script>(function(){@@SCRIPT@@})();</script>
</body></html>
"""

class AuthCallbackServer:
    """Minimal HTTP/1.1 server for the Trae authorization callback.

    Hand-written rather than pulled from a framework so the relay keeps its
    existing dependency set.
    """

    def __init__(
        self,
        port: int = DEFAULT_LISTENER_PORT,
        *,
        host: str = "127.0.0.1",
        relay_url: str = "",
        registry: LoginRegistry | None = None,
        parse_params=None,
        add_account=None,
    ) -> None:
        self.host = host
        self.port = port
        self.relay_url = relay_url
        # Explicit None check: an empty LoginRegistry is falsy (len == 0),
        # so `registry or get_registry()` would silently discard the caller's
        # registry and hand back the process-wide one.
        self.registry = registry if registry is not None else get_registry()
        self._parse_params = parse_params
        self._add_account = add_account
        self._server: asyncio.AbstractServer | None = None
        self.last_error = ""

    @property
    def running(self) -> bool:
        return self._server is not None and self._server.is_serving()

    async def start(self) -> bool:
        """Bind and serve.

        Returns False (never raises) when the port is busy, so a busy login
        port degrades browser login only and leaves the relay serving.
        """
        if self.running:
            return True
        try:
            self._server = await asyncio.start_server(
                self._handle, self.host, self.port
            )
        except OSError as exc:
            self._server = None
            self.last_error = "%s: %s" % (type(exc).__name__, exc)
            logger.warning(
                "web login listener could not bind %s:%s (%s); browser login is "
                "unavailable but the relay keeps running",
                self.host,
                self.port,
                self.last_error,
            )
            return False
        self.last_error = ""
        logger.info(
            "web login listener ready on http://%s:%s (in-process, no script download)",
            self.host,
            self.port,
        )
        return True

    async def stop(self) -> None:
        server, self._server = self._server, None
        if server is None:
            return
        server.close()
        try:
            await server.wait_closed()
        except Exception:  # pragma: no cover - shutdown best effort
            pass

    async def _handle(self, reader, writer) -> None:
        try:
            request_line = await asyncio.wait_for(reader.readline(), timeout=10)
            if not request_line:
                return
            parts = request_line.decode("latin-1").split()
            if len(parts) < 2:
                await self._respond(writer, 400, b"Bad Request")
                return
            target = parts[1]
            # Drain headers so the client is not left writing into a closed socket.
            while True:
                line = await asyncio.wait_for(reader.readline(), timeout=10)
                if line in (b"\r\n", b"\n", b""):
                    break
            parsed = urllib.parse.urlparse(target)
            query = dict(urllib.parse.parse_qsl(parsed.query))
            await self._route(writer, parsed.path, query)
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("web login listener request failed: %s", exc)
        finally:
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass

    async def _route(self, writer, path: str, query: dict) -> None:
        if path == "/healthz":
            await self._respond_json(
                writer, 200, {"status": "ok", "relay": self.relay_url, "port": self.port}
            )
            return
        if path == "/relay-url":
            await self._respond_json(writer, 200, {"relay": self.relay_url})
            return
        if path == "/authorize":
            await self._authorize(writer, query)
            return
        await self._respond(writer, 404, b"Not found")

    async def _authorize(self, writer, query: dict) -> None:
        state = (
            query.get("state")
            or query.get("loginTraceID")
            or query.get("login_trace_id")
            or ""
        )
        if not self.registry.consume(state):
            logger.warning("web login callback refused: unknown or expired state")
            await self._html_response(
                writer,
                400,
                "授权失败",
                "登录凭证已失效或来源不可信，请在控制台重新发起授权。",
                success=False,
                state=state,
            )
            return

        parse = self._parse_params
        add = self._add_account
        if parse is None or add is None:  # pragma: no cover - wired by main
            await self._respond(writer, 500, b"listener not configured")
            return

        creds = await parse(query)
        if not creds or not creds.get("token"):
            await self._html_response(
                writer,
                400,
                "授权失败",
                "未收到有效的 userJwt，请确认已在 trae.cn 登录后重试。",
                success=False,
                state=state,
            )
            return

        try:
            add(creds)
        except Exception as exc:
            logger.warning("web login credential write failed: %s", exc)
            await self._html_response(
                writer, 400, "授权失败", str(exc), success=False, state=state
            )
            return

        await self._html_response(
            writer,
            200,
            "授权成功",
            "凭证已写入服务器，可以关闭本窗口。",
            success=True,
            state=state,
        )

    async def _html_response(
        self, writer, status: int, title: str, detail: str, *, success: bool, state: str
    ) -> None:
        body = _page(title, detail, success=success, state=state)
        await self._respond(
            writer, status, body, content_type="text/html; charset=utf-8"
        )

    async def _respond(
        self, writer, status: int, body: bytes, *, content_type: str = "text/plain; charset=utf-8"
    ) -> None:
        reason = {
            200: "OK",
            400: "Bad Request",
            404: "Not Found",
            500: "Internal Server Error",
        }.get(status, "OK")
        head = (
            "HTTP/1.1 %d %s\r\n" % (status, reason)
            + "Content-Type: %s\r\n" % content_type
            + "Content-Length: %d\r\n" % len(body)
            + "Access-Control-Allow-Origin: *\r\n"
            + "Cache-Control: no-store\r\n"
            + "Connection: close\r\n\r\n"
        ).encode("latin-1")
        writer.write(head + body)
        await writer.drain()

    async def _respond_json(self, writer, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        await self._respond(
            writer, status, body, content_type="application/json; charset=utf-8"
        )


def build_default_server(port: int, relay_url: str) -> AuthCallbackServer:
    """Listener wired to the relay real parser and account store.

    Both lookups are lazy to avoid importing src.main at module import time,
    which would create a cycle.
    """
    from . import auth as auth_module
    from . import main as main_module

    async def _parse(query):
        return await main_module._parse_oauth_params(query)

    def _add(creds):
        return auth_module.add_account(creds, label=creds.get("screen_name") or "")

    return AuthCallbackServer(
        port=port, relay_url=relay_url, parse_params=_parse, add_account=_add
    )