"""Helpers for console contract tests.

The console was once a single server-rendered document with its CSS and
JavaScript inlined. It is now delivered as three resources:

  * the document        - markup only (GET /web/login)
  * /console/console.css - styles
  * /console/app.js      - behaviour

Tests that pin behaviour must read the resource that actually carries it, or
they silently stop testing anything. These helpers make the choice explicit.
"""

from __future__ import annotations

from src import main as main_module
from src.console import assets_path


def console_document() -> str:
    """The rendered markup document (no inlined CSS or JS)."""
    return main_module._web_login_html()


def console_script() -> str:
    """The served JavaScript asset."""
    path = assets_path() / "app.js"
    return path.read_text(encoding="utf-8")


def console_styles() -> str:
    """The served stylesheet."""
    path = assets_path() / "console.css"
    return path.read_text(encoding="utf-8")


def extract_js_function(source: str, name: str) -> str:
    """Return one JS function body (braces balanced), for contract tests."""
    marker = f"function {name}("
    start = source.index(marker)
    opening = source.index("{", start)
    depth = 0
    for index in range(opening, len(source)):
        char = source[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source[start : index + 1]
    raise AssertionError(f"unterminated function: {name}")
