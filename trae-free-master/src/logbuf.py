"""Bounded in-process log ring buffer with channel classification.

The console log page reads from this ring instead of tailing a file, so the
operator sees recent activity without the relay needing a log volume, a
rotating file, or shell access to the host.

Design notes:
  - One lock guards the deque; writes never block on the network or on disk.
  - Lines are classified into three channels so a burst of chat traffic does
    not flush the task/check-in results an operator is watching for.
  - The handler attaches to a logger and is idempotent, because app startup
    may run more than once in a single process (tests import and re-init).
"""

from __future__ import annotations

import logging
import re
import threading
import time
from collections import deque
from dataclasses import dataclass

# Log channels. Chat is the per-request table row; task covers scheduled and
# operator-triggered work; everything else is system.
CHAT = "chat"
TASK = "task"
SYS = "sys"

# A request-table row is emitted with this marker by the relay request logger.
_CHAT_PREFIX = "| #"

# Per-request lifecycle lines. These carry the model traffic an operator filters
# for, so they belong to the chat channel. Mirrors the "request received" /
# "dispatch" / "stream closed" phrasing the relay actually logs.
_CHAT_PREFIXES = (
    "request received ",
    "request body received ",
    "request binding ",
    "dispatch ",
    "remote create ",
    "public stream ",
    "raw stream ",
    "auto route ",
    "traework custom ingress ",
    "traework native ",
)

# Line prefixes belonging to scheduled or operator-triggered work.
_TASK_PREFIXES = (
    "checkin ",
    "balance ",
    "activity ",
    "keepalive ",
    "panel: ",
    "user-resource ",
    "school ",
    "travel ",
    "blackcat ",
    "lottery ",
    "streak-bonus ",
    "auto-checkin ",
)

# The logging module default date/time prefix, stripped before classification
# so prefixes match at the true start of the message.
_TS_PREFIX = re.compile(r"^\d{4}[-/]\d{2}[-/]\d{2} \d{2}:\d{2}:\d{2}(?:,\d{3})? ")


@dataclass(frozen=True)
class LogEntry:
    """One log line: epoch seconds, channel, and the message text."""

    ts: float
    ch: str
    text: str

    def as_dict(self) -> dict:
        return {"ts": self.ts, "ch": self.ch, "text": self.text}


def classify_line(line: str) -> str:
    """Return the channel for a log line.

    Chat rows are matched first: a table row may contain a word that also
    starts a task prefix, and misclassifying it would hide it from the chat
    channel an operator filters on.
    """
    text = _TS_PREFIX.sub("", line, count=1)
    if text.startswith(_CHAT_PREFIX):
        return CHAT
    for prefix in _CHAT_PREFIXES:
        if text.startswith(prefix):
            return CHAT
    for prefix in _TASK_PREFIXES:
        if text.startswith(prefix):
            return TASK
    return SYS


class LogRing:
    """Thread-safe fixed-capacity ring of log entries.

    The `write` method accepts either a single line or a chunk
    containing newlines, so it can be driven directly from a logging handler or
    a stream wrapper. Blank lines are dropped; oldest entries evict first.
    """

    def __init__(self, capacity: int = 500) -> None:
        if capacity <= 0:
            capacity = 500
        self._cap = capacity
        self._lock = threading.Lock()
        self._entries: deque[LogEntry] = deque(maxlen=capacity)

    @property
    def capacity(self) -> int:
        return self._cap

    def write(self, line: str, *, now: float | None = None) -> None:
        if not line:
            return
        stamp = time.time() if now is None else now
        normalized = str(line).replace("\r\n", "\n").replace("\r", "\n")
        for raw in normalized.split("\n"):
            text = _TS_PREFIX.sub("", raw, count=1).rstrip()
            if not text.strip():
                continue
            entry = LogEntry(ts=stamp, ch=classify_line(text), text=text)
            with self._lock:
                self._entries.append(entry)

    def snapshot(self) -> list[LogEntry]:
        """Return a copy of the buffered entries in insertion order."""
        with self._lock:
            return list(self._entries)

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()

    def __len__(self) -> int:
        with self._lock:
            return len(self._entries)


class RingLogHandler(logging.Handler):
    """A logging handler that appends formatted records to a LogRing."""

    def __init__(self, ring: LogRing, level: int = logging.NOTSET) -> None:
        super().__init__(level)
        self.ring = ring

    def emit(self, record: logging.LogRecord) -> None:
        try:
            self.ring.write(self.format(record))
        except Exception:  # pragma: no cover - logging must never raise
            self.handleError(record)


def install_ring_handler(logger: logging.Logger, capacity: int = 500) -> LogRing:
    """Attach a RingLogHandler to a logger and return its ring.

    Idempotent: repeated calls for the same logger reuse the existing handler
    and ring, so importing or re-initialising the app twice does not duplicate
    every log line.
    """
    existing = getattr(logger, "_relay_ring", None)
    if isinstance(existing, LogRing):
        return existing

    ring = LogRing(capacity=capacity)
    handler = RingLogHandler(ring)
    handler.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(handler)
    logger._relay_ring = ring  # type: ignore[attr-defined]
    return ring
