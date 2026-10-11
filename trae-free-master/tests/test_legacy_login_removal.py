"""The helper-script login flow is gone, not merely hidden.

The console rewrite replaced the download-a-script login flow with an
in-process listener. The UI stopped advertising the script, but the route and
the files survived, so the flow was still reachable by URL. These tests pin the
removal: if the route, the constants, or the shipped files come back, the
cleanup silently regressed.
"""

from __future__ import annotations

import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from src import main as main_module

REPO_ROOT = Path(__file__).resolve().parent.parent


class LegacyDownloadRouteTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main_module.app)

    def test_download_route_is_gone(self):
        for url in ("/web/login/download", "/web/login/download?as=bat"):
            with self.subTest(url=url):
                self.assertEqual(self.client.get(url).status_code, 404)

    def test_download_route_is_not_public_any_more(self):
        self.assertNotIn("/web/login/download", main_module.PUBLIC_PATHS)

    def test_script_constants_are_gone(self):
        self.assertFalse(hasattr(main_module, "WEB_LOGIN_SCRIPT"))
        self.assertFalse(hasattr(main_module, "START_AUTH_BAT"))


class LegacyHelperFilesTests(unittest.TestCase):
    def test_helper_scripts_are_not_shipped(self):
        for name in ("web_login.py", "start_auth.bat"):
            with self.subTest(name=name):
                self.assertFalse(
                    (REPO_ROOT / name).exists(),
                    "%s still exists; the in-process listener replaced it" % name,
                )

    def test_container_does_not_copy_helper_scripts(self):
        dockerfile = (REPO_ROOT / "Dockerfile").read_text(encoding="utf-8")
        for name in ("web_login.py", "start_auth.bat"):
            with self.subTest(name=name):
                self.assertNotIn(name, dockerfile)

    def test_dockerignore_does_not_except_helper_scripts(self):
        ignored = (REPO_ROOT / ".dockerignore").read_text(encoding="utf-8")
        for name in ("web_login.py", "start_auth.bat"):
            with self.subTest(name=name):
                self.assertNotIn("!" + name, ignored)


class DeadConsoleCssTests(unittest.TestCase):
    def test_inline_console_css_constant_is_gone(self):
        # The stylesheet moved to src/console/assets/console.css; the old
        # inlined copy was left behind with zero references.
        self.assertFalse(hasattr(main_module, "_CONSOLE_CSS"))


class StaleCommentTests(unittest.TestCase):
    def test_app_js_does_not_reference_the_removed_helper(self):
        source = (REPO_ROOT / "src" / "console" / "assets" / "app.js").read_text(
            encoding="utf-8"
        )
        self.assertNotIn("web_login.py", source)


if __name__ == "__main__":
    unittest.main()
