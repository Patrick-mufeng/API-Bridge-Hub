"""Console package: server-rendered shell, design tokens, and static assets."""

from __future__ import annotations

from pathlib import Path


def assets_path() -> Path:
    """Directory holding console.css and app.js."""
    return Path(__file__).resolve().parent / "assets"
