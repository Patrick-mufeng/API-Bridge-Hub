"""Inline SVG icon set for the console.

Values are moved verbatim from the original inline definition so the rendered
markup is byte-identical; tests compare against these strings. Inline rather
than a font or sprite sheet because intranet deployments must not fetch icons
from a CDN.
"""

from __future__ import annotations

ICONS: dict[str, str] = {
    "zap": "<path d=\"M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z\"/>",
    "users": "<path d=\"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2\"/><circle cx=\"9\" cy=\"7\" r=\"4\"/><path d=\"M22 21v-2a4 4 0 0 0-3-3.87\"/><path d=\"M16 3.13a4 4 0 0 1 0 7.75\"/>",
    "receipt": "<path d=\"M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z\"/><path d=\"M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8\"/><path d=\"M12 17.5v-11\"/>",
    "sliders-horizontal": "<line x1=\"21\" x2=\"14\" y1=\"4\" y2=\"4\"/><line x1=\"10\" x2=\"3\" y1=\"4\" y2=\"4\"/><line x1=\"21\" x2=\"12\" y1=\"12\" y2=\"12\"/><line x1=\"8\" x2=\"3\" y1=\"12\" y2=\"12\"/><line x1=\"21\" x2=\"16\" y1=\"20\" y2=\"20\"/><line x1=\"12\" x2=\"3\" y1=\"20\" y2=\"20\"/><line x1=\"14\" x2=\"14\" y1=\"2\" y2=\"6\"/><line x1=\"8\" x2=\"8\" y1=\"10\" y2=\"14\"/><line x1=\"16\" x2=\"16\" y1=\"18\" y2=\"22\"/>",
    "activity": "<path d=\"M22 12h-4l-3 9L9 3l-3 9H2\"/>",
    "calendar-check": "<path d=\"M8 2v4\"/><path d=\"M16 2v4\"/><rect width=\"18\" height=\"18\" x=\"3\" y=\"4\" rx=\"2\"/><path d=\"M3 10h18\"/><path d=\"m9 16 2 2 4-4\"/>",
    "arrow-left-right": "<path d=\"M8 3 4 7l4 4\"/><path d=\"M4 7h16\"/><path d=\"m16 21 4-4-4-4\"/><path d=\"M20 17H4\"/>",
    "trash-2": "<path d=\"M3 6h18\"/><path d=\"M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6\"/><path d=\"M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2\"/><line x1=\"10\" x2=\"10\" y1=\"11\" y2=\"17\"/><line x1=\"14\" x2=\"14\" y1=\"11\" y2=\"17\"/>",
    "log-out": "<path d=\"M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4\"/><polyline points=\"16 17 21 12 16 7\"/><line x1=\"21\" x2=\"9\" y1=\"12\" y2=\"12\"/>",
    "log-in": "<path d=\"M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4\"/><polyline points=\"10 17 15 12 10 7\"/><line x1=\"15\" x2=\"3\" y1=\"12\" y2=\"12\"/>",
    "refresh-cw": "<path d=\"M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8\"/><path d=\"M21 3v5h-5\"/><path d=\"M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16\"/><path d=\"M8 16H3v5\"/>",
    "coins": "<circle cx=\"8\" cy=\"8\" r=\"6\"/><path d=\"M18.09 10.37A6 6 0 1 1 10.34 18\"/><path d=\"M7 6h1v4\"/><path d=\"m16.71 13.88.7.71-2.82 2.82\"/>",
    "check-check": "<path d=\"M18 6 7 17l-5-5\"/><path d=\"m22 10-7.5 7.5L13 16\"/>",
    "shield-check": "<path d=\"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z\"/><path d=\"m9 12 2 2 4-4\"/>",
    "download": "<path d=\"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4\"/><polyline points=\"7 10 12 15 17 10\"/><line x1=\"12\" x2=\"12\" y1=\"15\" y2=\"3\"/>",
    "external-link": "<path d=\"M15 3h6v6\"/><path d=\"M10 14 21 3\"/><path d=\"M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6\"/>",
    "play": "<polygon points=\"6 3 20 12 6 21 6 3\"/>",
    "save": "<path d=\"M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z\"/><path d=\"M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7\"/><path d=\"M7 3v4a1 1 0 0 0 1 1h7\"/>",
    "search": "<circle cx=\"11\" cy=\"11\" r=\"8\"/><path d=\"m21 21-4.3-4.3\"/>",
    "list": "<line x1=\"8\" x2=\"21\" y1=\"6\" y2=\"6\"/><line x1=\"8\" x2=\"21\" y1=\"12\" y2=\"12\"/><line x1=\"8\" x2=\"21\" y1=\"18\" y2=\"18\"/><line x1=\"3\" x2=\"3.01\" y1=\"6\" y2=\"6\"/><line x1=\"3\" x2=\"3.01\" y1=\"12\" y2=\"12\"/><line x1=\"3\" x2=\"3.01\" y1=\"18\" y2=\"18\"/>",
    "sun": "<circle cx=\"12\" cy=\"12\" r=\"4\"/><path d=\"M12 2v2\"/><path d=\"M12 20v2\"/><path d=\"m4.93 4.93 1.41 1.41\"/><path d=\"m17.66 17.66 1.41 1.41\"/><path d=\"M2 12h2\"/><path d=\"M20 12h2\"/><path d=\"m6.34 17.66-1.41 1.41\"/><path d=\"m19.07 4.93-1.41 1.41\"/>",
    "moon": "<path d=\"M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z\"/>",
    "list-plus": "<path d=\"M11 12H3\"/><path d=\"M16 6H3\"/><path d=\"M16 18H3\"/><path d=\"M18 9v6\"/><path d=\"M21 12h-6\"/>",
    "layout-dashboard": "<rect width=\"7\" height=\"9\" x=\"3\" y=\"3\" rx=\"1\"/><rect width=\"7\" height=\"5\" x=\"14\" y=\"3\" rx=\"1\"/><rect width=\"7\" height=\"9\" x=\"14\" y=\"12\" rx=\"1\"/><rect width=\"7\" height=\"5\" x=\"3\" y=\"16\" rx=\"1\"/>",
    "database": "<ellipse cx=\"12\" cy=\"5\" rx=\"9\" ry=\"3\"/><path d=\"M3 5V19A9 3 0 0 0 21 19V5\"/><path d=\"M3 12A9 3 0 0 0 21 12\"/>",
    "arrow-down-to-line": "<path d=\"M12 17V3\"/><path d=\"m6 11 6 6 6-6\"/><path d=\"M19 21H5\"/>",
    "arrow-up-from-line": "<path d=\"m18 9-6-6-6 6\"/><path d=\"M12 3v14\"/><path d=\"M5 21h14\"/>",
    "sigma": "<path d=\"M18 7V5a1 1 0 0 0-1-1H6.5a.5.5 0 0 0-.4.8l4.5 6a2 2 0 0 1 0 2.4l-4.5 6a.5.5 0 0 0 .4.8H17a1 1 0 0 0 1-1v-2\"/>",
    "calendar": "<path d=\"M8 2v4\"/><path d=\"M16 2v4\"/><rect width=\"18\" height=\"18\" x=\"3\" y=\"4\" rx=\"2\"/><path d=\"M3 10h18\"/>",
    "server": "<rect width=\"20\" height=\"8\" x=\"2\" y=\"2\" rx=\"2\" ry=\"2\"/><rect width=\"20\" height=\"8\" x=\"2\" y=\"14\" rx=\"2\" ry=\"2\"/><line x1=\"6\" x2=\"6.01\" y1=\"6\" y2=\"6\"/><line x1=\"6\" x2=\"6.01\" y1=\"18\" y2=\"18\"/>",
}

# ── Brand mark: trae-free ────────────────────────────────────────────────────
# An open ring with an arrow leaving through the gap: the relay hands work off
# and the circuit is never closed, which is the "free" half of the name. Drawn
# as three strokes in a 64-unit box and scaled to 84% so the glyph keeps a
# visible margin inside the tile; verified legible down to a 16px favicon.
#
# Single source of truth: main.py re-exports these, so the favicon, the sidebar
# mark and docs/logo.svg cannot drift apart.
BRAND_ACCENT = "#2ad4e8"
BRAND_TILE = "#0b100d"

# The mark itself: an 18-radius ring left open on the right, and an arrow whose
# shaft starts on the centre line and whose head meets the opening.
GLYPH_MARK = (
    '<path d="M43.6 18.2A18 18 0 1 0 43.6 45.8"/>'
    '<path d="M25 32h18.5"/>'
    '<path d="M35 24.5 43.5 32 35 39.5"/>'
)

_GLYPH_SCALE = 0.84
_GLYPH_OFFSET = round((64 - 64 * _GLYPH_SCALE) / 2, 2)

LOGO_PATHS = (
    '<rect x="2.5" y="2.5" width="59" height="59" rx="13" fill="' + BRAND_TILE + '" '
    'stroke="' + BRAND_ACCENT + '" stroke-width="4"/>'
    '<g transform="translate(%s %s) scale(%s)" fill="none" stroke="%s" '
    'stroke-width="5.6" stroke-linecap="round" stroke-linejoin="round">'
    % (_GLYPH_OFFSET, _GLYPH_OFFSET, _GLYPH_SCALE, BRAND_ACCENT)
    + GLYPH_MARK
    + "</g>"
)

LOGO_SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" '
    'aria-label="trae-free"><title>trae-free</title>' + LOGO_PATHS + "</svg>"
)

# Compact brand mark for the sidebar: no title/aria so the surrounding markup
# owns the accessible name.
LOGO_SVG_INLINE = (
    '<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">'
    + LOGO_PATHS
    + "</svg>"
)

FAVICON_LINKS = (
    '<link rel="icon" type="image/svg+xml" href="/favicon.svg">'
    '<link rel="apple-touch-icon" href="/favicon.svg">'
)


def icon(name: str, size: int = 24) -> str:
    """Render a named Lucide icon as inline SVG.

    Unknown names render an empty glyph rather than raising: a missing
    icon must never take down the console page.
    """
    body = ICONS.get(name, "")
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" ' % (size, size)
        + 'fill="none" stroke="currentColor" stroke-width="2" '
        + 'stroke-linecap="round" stroke-linejoin="round" '
        + 'aria-hidden="true">' + body + "</svg>"
    )
