"""Console static assets: routes, design tokens, and JS syntax validity."""

from __future__ import annotations

import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from src import main as main_module
from src.console import icons as console_icons


class ConsoleAssetRouteTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main_module.app)

    def test_css_route_serves_css(self):
        response = self.client.get("/console/console.css")
        self.assertEqual(response.status_code, 200)
        self.assertIn("text/css", response.headers["content-type"])

    def test_js_route_serves_javascript(self):
        response = self.client.get("/console/app.js")
        self.assertEqual(response.status_code, 200)
        self.assertIn("javascript", response.headers["content-type"])


class DesignTokenTests(unittest.TestCase):
    def setUp(self):
        self.css = TestClient(main_module.app).get("/console/console.css").text

    def test_pixel_ops_tokens_are_present(self):
        for token in ("--accent", "--shadow", "--line", "--ink", "--bg"):
            with self.subTest(token=token):
                self.assertIn(token, self.css)

    def test_light_theme_overrides_exist(self):
        self.assertIn('[data-theme="light"]', self.css)

    def test_grid_and_scanline_layers_are_present(self):
        # The pixel-terminal identity depends on both overlay layers.
        self.assertIn("body::before", self.css)
        self.assertIn("repeating-linear-gradient", self.css)

    def test_no_external_font_or_cdn_reference(self):
        # Intranet deployments must not need egress to render the console.
        self.assertNotIn("@import", self.css)
        self.assertNotIn("https://", self.css)
        self.assertNotIn("http://", self.css)


class JavaScriptValidityTests(unittest.TestCase):
    """Review Focus 4: a JS syntax error white-screens the whole console."""

    def test_app_js_parses(self):
        if shutil.which("node") is None:
            self.skipTest("node not available")
        source = TestClient(main_module.app).get("/console/app.js").text
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "app.js"
            path.write_text(source, encoding="utf-8")
            proc = subprocess.run(
                ["node", "--check", str(path)],
                capture_output=True,
                text=True,
            )
        self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_no_leftover_python_fstring_braces(self):
        source = TestClient(main_module.app).get("/console/app.js").text
        self.assertNotIn("{{", source)
        self.assertNotIn("}}", source)


class IconParityTests(unittest.TestCase):
    def test_main_icon_matches_console_icon(self):
        for name in ("users", "coins", "refresh-cw"):
            with self.subTest(name=name):
                self.assertEqual(
                    main_module._icon(name), console_icons.icon(name)
                )

    def test_logo_is_still_exported_from_main(self):
        # test_logo.py pins main.LOGO_SVG; the console must not break it.
        self.assertIn("<svg", main_module.LOGO_SVG)
        self.assertIn('viewBox="0 0 64 64"', main_module.LOGO_SVG)


if __name__ == "__main__":
    unittest.main()
