"""Assemble the console document from the shell and page fragments.

Placeholders are filled by literal replace(), never by f-string interpolation.
The historical renderer built the whole document inside an f-string, which
forced every JavaScript brace to be doubled and every backslash to be
re-escaped; a single mistake there produced a page whose script could not
parse, i.e. a blank console. Placeholder substitution cannot collide with
JavaScript syntax.

Runtime configuration the browser needs (listener port, client id, auth URL)
is emitted as a JSON bootstrap object rather than baked into the script.

Asset URLs carry a content hash (see views.ASSET_REVISION) so a changed
stylesheet is fetched instead of reused from cache.
"""

from __future__ import annotations

import json
import re
from typing import Any, Mapping

from . import icons as console_icons
from . import views

_PLACEHOLDER = re.compile(r"@@([A-Za-z_][A-Za-z0-9_]*)@@")


def _fill(text: str, values: Mapping[str, Any]) -> str:
    """Substitute @@NAME@@ tokens; unknown tokens render empty."""

    def replace(match: re.Match) -> str:
        key = match.group(1)
        value = values.get(key)
        return "" if value is None else str(value)

    return _PLACEHOLDER.sub(replace, text)


def build_bootstrap(config: Mapping[str, Any]) -> str:
    """The window.__CONSOLE__ payload consumed by app.js."""
    payload = json.dumps(config, ensure_ascii=False)
    # U+003C is escaped so the JSON cannot terminate the surrounding script.
    payload = payload.replace("<", "\\u003c")
    return f"window.__CONSOLE__ = {payload};"


def render_console(state: Mapping[str, Any]) -> str:
    """Render the full console document for the given view state."""
    values: dict[str, Any] = dict(state)
    values.setdefault("ASSET_REVISION", views.ASSET_REVISION)
    values.setdefault("FAVICON", console_icons.FAVICON_LINKS)
    values.setdefault("LOGO", console_icons.LOGO_SVG_INLINE)
    values.setdefault("LOGIN_ICON", console_icons.icon("log-in"))
    values.setdefault("EXT_ICON", console_icons.icon("external-link"))

    head = _fill(views.SHELL_HEAD, values)
    pages = "".join(
        _fill(views.PAGES[key], values) for key in views.PAGE_ORDER
    )
    bootstrap = build_bootstrap(state.get("bootstrap") or {})
    revision = str(values.get("ASSET_REVISION") or "")

    return (
        "<!doctype html>\n"
        + head
        + pages
        + "</main>\n</div>\n"
        + "<script>\n" + bootstrap + "\n</script>\n"
        + '<script src="/console/app.js?v=' + revision + '" defer></script>\n'
        + "</body>\n</html>\n"
    )
