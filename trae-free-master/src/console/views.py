"""Console page fragments.

Fragments are stored as real HTML files under src/console/pages/ so they can be
edited directly. They are loaded once at import and exposed as strings.

Placeholders use @@NAME@@ and are substituted by page.py with str.replace,
deliberately not f-string interpolation: the historical renderer embedded
JavaScript inside a Python f-string, so every brace had to be doubled and every
backslash re-escaped. One mistake there produced a document whose script could
not parse, i.e. a blank console. Placeholders cannot collide with JS syntax.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

PAGES_DIR = Path(__file__).resolve().parent / "pages"
ASSETS_DIR = Path(__file__).resolve().parent / "assets"

# Document order. Only one page is visible at a time (.tab-page is display:none
# until .active), so this order has no visual effect; it is fixed because
# existing tests pin models AFTER the settings page.
PAGE_ORDER = ("overview", "accounts", "usage", "logs", "settings", "models")

# Sidebar order. Independent of PAGE_ORDER on purpose: the operator-facing
# sequence puts the model surface before global configuration.
NAV_ORDER = ("overview", "accounts", "usage", "logs", "models", "settings")


def _load(name: str) -> str:
    return (PAGES_DIR / (name + ".html")).read_text(encoding="utf-8")

def _asset_revision() -> str:
    """Short content hash over the console assets.

    A stylesheet URL that changes with the file content cannot be served from
    a stale cache: the browser sees a different URL and fetches it. Cache
    headers alone were not enough - an already-cached copy keeps its own
    freshness, so a fix could stay invisible until a manual hard refresh.
    """
    digest = hashlib.sha256()
    for name in ("console.css", "app.js"):
        path = ASSETS_DIR / name
        if path.is_file():
            digest.update(path.read_bytes())
    return digest.hexdigest()[:12]


ASSET_REVISION = _asset_revision()


SHELL_HEAD = _load("_shell_head")
PAGES = {key: _load(key) for key in PAGE_ORDER}
