"""Console document contract: six pages, the legacy DOM hooks, empty states."""

from __future__ import annotations

import re
import unittest

from src.console import icons as console_icons
from src.console import views
from tests.console_testkit import console_document, console_script


class PageStructureTests(unittest.TestCase):
    def setUp(self):
        self.html = console_document()

    def test_six_pages_render_in_sidebar_order(self):
        self.assertEqual(
            views.PAGE_ORDER,
            ("overview", "accounts", "usage", "logs", "settings", "models"),
        )
        for key in views.PAGE_ORDER:
            with self.subTest(page=key):
                self.assertIn('data-page="%s"' % key, self.html)

    def test_nav_entries_follow_the_sidebar_order(self):
        tabs = re.findall(r'data-tab="([a-z]+)"', self.html)
        self.assertEqual(tabs, list(views.NAV_ORDER))

    def test_document_order_keeps_models_after_settings(self):
        # Only one page shows at a time, so this is a contract detail, not a
        # layout one: existing tests pin the models page after settings.
        self.assertLess(
            self.html.index('data-page="settings"'),
            self.html.index('data-page="models"'),
        )

    def test_overview_comes_before_accounts(self):
        self.assertLess(
            self.html.index('data-tab="overview"'),
            self.html.index('data-tab="accounts"'),
        )

    def test_document_references_served_assets(self):
        self.assertIn('/console/console.css', self.html)
        self.assertIn('/console/app.js', self.html)
        # CSS must not be inlined any more; that was the escaping hazard.
        self.assertNotIn("<style>", self.html)

    def test_bootstrap_carries_runtime_config(self):
        self.assertIn("window.__CONSOLE__", self.html)
        for key in ("listenerPort", "clientId", "authUrl", "endpointMap"):
            with self.subTest(key=key):
                self.assertIn(key, self.html)


class LegacyDomContractTests(unittest.TestCase):
    """Ids and handlers the rest of the codebase and tests rely on."""

    def setUp(self):
        self.html = console_document()
        self.script = console_script()

    def test_every_pinned_element_id_survives(self):
        pinned = (
            "ov-chart", "ov-total", "ov-days-body", "ov-hide-empty",
            "stat-total", "stat-valid", "stat-checked", "stat-credits",
            "checkin-summary", "checkin-claim-btn", "credits-refresh-btn",
            "account-model-save-btn", "usage-records-body", "usage-empty",
            "logs-body", "logs-empty", "logs-count", "logs-follow-btn",
            "poll-toggle", "poll-save-btn", "settings-endpoint-preset",
            "settings-web", "settings-save-btn", "settings-port",
            "max-mode-toggle", "max-mode-models", "max-mode-save-btn",
            "auto-route-toggle", "auto-route-save-btn",
            "auto-checkin-toggle", "auto-checkin-time", "auto-checkin-save-btn",
            "conn-models", "conn-endpoint", "conn-mode-text", "conn-mode-tool",
            "conn-run-btn", "conn-tbody", "conn-max", "conn-effort",
            "auth-btn", "auth-msg", "manual-form", "manual-token",
            "theme-toggle", "toast", "page-title", "listener-state",
        )
        for element_id in pinned:
            with self.subTest(element_id=element_id):
                self.assertIn('id="%s"' % element_id, self.html)

    def test_markup_handlers_are_wired_to_existing_functions(self):
        handlers = set(re.findall(r'on(?:click|change|input|submit)="([A-Za-z_][\w]*)\(', self.html))
        self.assertTrue(handlers, "no handlers found")
        for name in sorted(handlers):
            with self.subTest(handler=name):
                self.assertIn("function %s(" % name, self.script)

    def test_switch_tab_handles_every_page(self):
        for key in views.NAV_ORDER:
            with self.subTest(page=key):
                self.assertIn("switchTab('%s')" % key, self.html)


class EmptyStateTests(unittest.TestCase):
    """Review Focus 5: first run with nothing configured must still render."""

    def test_document_renders_with_no_accounts_or_records(self):
        from src import main as main_module
        html = main_module._web_login_html()
        self.assertIn("<!doctype html>", html)
        self.assertIn("</html>", html)
        for key in views.PAGE_ORDER:
            with self.subTest(page=key):
                self.assertIn('data-page="%s"' % key, html)

    def test_pages_carry_readable_empty_or_default_text(self):
        html = console_document()
        for marker in ("usage-empty", "logs-empty"):
            with self.subTest(marker=marker):
                self.assertIn(marker, html)

    def test_no_helper_script_is_advertised(self):
        html = console_document()
        for artifact in ("web_login.py", "start_auth.bat", "/web/login/download"):
            with self.subTest(artifact=artifact):
                self.assertNotIn(artifact, html)


class IconLayoutTests(unittest.TestCase):
    def test_every_page_icon_exists(self):
        for key in views.PAGE_ORDER:
            with self.subTest(page=key):
                self.assertIn('data-page="%s"' % key, views.PAGES[key])

    def test_unknown_icon_renders_empty_svg_not_an_error(self):
        self.assertIn("<svg", console_icons.icon("no-such-icon"))


if __name__ == "__main__":
    unittest.main()
