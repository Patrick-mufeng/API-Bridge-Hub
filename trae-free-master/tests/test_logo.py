"""Project logo is served as the favicon and used in the console brand mark."""

from __future__ import annotations

import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from src import main as main_module


class LogoFaviconTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main_module.app)

    def test_favicon_routes_serve_svg_without_auth(self):
        for path in ("/favicon.svg", "/favicon.ico"):
            response = self.client.get(path)
            self.assertEqual(response.status_code, 200, path)
            self.assertTrue(response.headers["content-type"].startswith("image/svg+xml"))
            self.assertIn("<svg", response.text)
            self.assertIn(main_module.console_icons.BRAND_ACCENT, response.text)

    def test_console_links_favicon_and_uses_logo(self):
        html = self.client.get("/web/login").text
        self.assertIn('rel="icon" type="image/svg+xml" href="/favicon.svg"', html)
        brand = html.split('class="brand-mark">', 1)[1].split("</span>", 1)[0]
        self.assertIn('viewBox="0 0 64 64"', brand)

    def test_docs_logo_matches_served_logo(self):
        # docs/logo.svg is the published copy of the served mark; it must not
        # drift. The brand mark is an open ring with an arrow through the gap.
        doc = Path(__file__).resolve().parent.parent / "docs" / "logo.svg"
        text = doc.read_text("utf-8")
        for fragment in (
            'M43.6 18.2A18 18 0 1 0 43.6 45.8',
            '<path d="M25 32h18.5"/>',
            '<path d="M35 24.5 43.5 32 35 39.5"/>',
        ):
            with self.subTest(fragment=fragment):
                self.assertIn(fragment, text)
                self.assertIn(fragment, main_module.LOGO_SVG)

    def test_logo_module_is_the_single_source_of_truth(self):
        # main.py re-exports; a duplicated copy would let the favicon and the
        # sidebar mark drift apart.
        self.assertEqual(main_module._LOGO_PATHS, main_module.console_icons.LOGO_PATHS)
        self.assertEqual(main_module.LOGO_SVG, main_module.console_icons.LOGO_SVG)
        self.assertEqual(
            main_module._LOGO_SVG_INLINE, main_module.console_icons.LOGO_SVG_INLINE
        )


if __name__ == "__main__":
    unittest.main()
