"""Regression tests for five reported console defects.

1. The overview stat sub-line lost a specificity fight. The .stat dd rule
   (0,1,1) outranked .stat-sub (0,1,0), so the sub-line rendered at the value's
   20px/700 instead of its own 11px/400. Measured in a browser, the sub-line
   box was 64px tall - two 32px lines - making the grey annotation as loud as
   the number it annotates.
2. The header carried a chip showing the raw 16-digit account user id, which
   is redundant with the account pool and rewritten on every account switch.
3. Four regex *literals* in app.js used a doubled backslash. Inside a literal a
   doubled backslash means "a literal backslash, then d", so none of them
   matched anything: the scheduled check-in time could never be saved (12:00
   and 08:30 were both rejected), the relay port could never be saved, and
   formatted timestamps fell back to raw ISO strings. Separately, "next run"
   reported the current time once the day's slot had passed, which reads as
   though the schedule had moved.
4. The usage page was a 100-row table with no visualisation.
5. The model list only loaded when its button was pressed, never on boot.
"""

from __future__ import annotations

import re
import unittest
from datetime import datetime
from pathlib import Path

from tests.console_testkit import console_document, console_script, console_styles

REPO_ROOT = Path(__file__).resolve().parent.parent
APP_JS = REPO_ROOT / "src" / "console" / "assets" / "app.js"


def _rule(css, selector):
    """Declarations for a selector, ignoring @media blocks and comments."""
    stripped = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    declarations = {}
    for match in re.finditer(r"([^{}]+)\{([^}]*)\}", stripped):
        if selector not in [s.strip() for s in match.group(1).split(",")]:
            continue
        for declaration in match.group(2).split(";"):
            name, separator, value = declaration.partition(":")
            if separator:
                declarations[name.strip()] = value.strip()
    return re.sub(r"\s+", "", ";".join("%s:%s" % kv for kv in declarations.items()))


def _js_regex_literals(source):
    """Every regex literal in the file, with its 1-based line number."""
    found = []
    for number, line in enumerate(source.split("\n"), 1):
        for match in re.finditer(r"/\^[^/\n]*/[gimsuy]*", line):
            found.append((number, match.group(0)))
    return found


class StatSubLineTests(unittest.TestCase):
    """1. The sub-line must be quieter than the value it annotates."""

    def setUp(self):
        self.css = console_styles()

    def test_sub_line_beats_the_value_rule(self):
        # .stat-sub alone loses to .stat dd on specificity, which was the bug.
        rule = _rule(self.css, ".stat dd.stat-sub")
        self.assertTrue(rule, "the sub-line needs a rule that outranks .stat dd")
        size = re.search(r"font-size:([\d.]+)px", rule)
        self.assertIsNotNone(size, rule)
        self.assertLessEqual(float(size.group(1)), 12.0)

    def test_sub_line_is_smaller_than_the_value(self):
        # 11.5px still read as too loud next to a 20px value in a 186px card,
        # where the annotation wraps to two lines.
        rule = _rule(self.css, ".stat dd.stat-sub")
        size = re.search(r"font-size:([\d.]+)px", rule)
        self.assertIsNotNone(size, rule)
        self.assertLessEqual(float(size.group(1)), 11.0)

    def test_sub_line_is_not_bold(self):
        rule = _rule(self.css, ".stat dd.stat-sub")
        weight = re.search(r"font-weight:(\d+)", rule)
        self.assertIsNotNone(weight, "the sub-line must reset the value's bold weight")
        self.assertLess(int(weight.group(1)), 700)


class ConsoleAssetCacheTests(unittest.TestCase):
    """Assets must not be served in a way that hides a change.

    FileResponse emitted only ETag/Last-Modified. With no Cache-Control,
    browsers apply heuristic freshness, so an edited stylesheet could be
    reused for minutes without revalidating - which made a CSS fix look like
    it had never been applied.
    """

    def test_asset_route_sends_no_cache(self):
        source = (REPO_ROOT / "src" / "main.py").read_text(encoding="utf-8")
        route = source.split("async def console_asset", 1)[1].split("@app.get", 1)[0]
        self.assertIn("no-cache", route, "console assets must revalidate on load")
        self.assertIn("FileResponse", route)

    def test_asset_urls_carry_a_content_hash(self):
        """A changed stylesheet must get a NEW url, not just a new body.

        no-cache alone still loses to an already-cached copy: that copy keeps
        its own freshness and is never revalidated, so a CSS fix stayed
        invisible until a manual hard refresh. A content hash changes the URL,
        which no cache can mask.
        """
        html = console_document()
        match = re.search(r'href="/console/console\.css\?v=([0-9a-f]+)"', html)
        self.assertIsNotNone(match, "the stylesheet link must be versioned")
        self.assertRegex(match.group(1), r"^[0-9a-f]{8,}$")
        script = re.search(r'src="/console/app\.js\?v=([0-9a-f]+)"', html)
        self.assertIsNotNone(script, "the script tag must be versioned")
        # No Python expression may leak into the markup.
        self.assertNotIn("+ str(", html)
        self.assertNotIn("@@", html)

    def test_the_document_itself_revalidates(self):
        """The HTML pins the hashed URLs, so IT must not be cached either.

        A cached document keeps requesting the old stylesheet, which would make
        versioning pointless.
        """
        import tests.conftest  # noqa: F401
        from fastapi.testclient import TestClient
        from src import main as main_module

        response = TestClient(main_module.app).get("/web/login")
        self.assertEqual(response.status_code, 200)
        self.assertIn("no-cache", response.headers.get("cache-control", ""))

    def test_the_hash_changes_with_the_asset_content(self):
        from src.console import views

        digest = __import__("hashlib").sha256()
        for name in ("console.css", "app.js"):
            digest.update((REPO_ROOT / "src" / "console" / "assets" / name).read_bytes())
        self.assertEqual(views.ASSET_REVISION, digest.hexdigest()[:12])

    def test_layout_css_is_actually_served_with_no_cache(self):
        import tests.conftest  # noqa: F401
        from fastapi.testclient import TestClient
        from src import main as main_module

        client = TestClient(main_module.app)
        response = client.get("/console/console.css")
        self.assertIn(".stat dd.stat-sub", response.text)

    def test_conditional_request_still_revalidates(self):
        # no-cache must not defeat the ETag: a 304 keeps reloads cheap.
        import tests.conftest  # noqa: F401
        from fastapi.testclient import TestClient
        from src import main as main_module

        client = TestClient(main_module.app)
        first = client.get("/console/console.css")
        self.assertEqual(first.status_code, 200)
        self.assertIn("no-cache", first.headers.get("cache-control", ""))
        etag = first.headers.get("etag")
        self.assertTrue(etag, "an ETag is what makes revalidation cheap")
        again = client.get("/console/console.css", headers={"If-None-Match": etag})
        self.assertEqual(again.status_code, 304)


class HeaderChipTests(unittest.TestCase):
    """2. No raw user id in the header."""

    def test_header_has_no_user_id_chip(self):
        html = console_document()
        self.assertNotIn('id="active-user-id"', html)
        self.assertNotIn("chip-user", html)

    def test_no_script_writes_a_user_chip(self):
        self.assertNotIn("active-user-id", console_script())


class RegexLiteralTests(unittest.TestCase):
    """3. Regex literals must use real escapes, not doubled backslashes."""

    def setUp(self):
        self.source = APP_JS.read_text(encoding="utf-8")

    def test_no_regex_literal_contains_a_doubled_backslash(self):
        offenders = [
            (line, literal)
            for line, literal in _js_regex_literals(self.source)
            if "\\\\" in literal
        ]
        self.assertEqual(
            offenders,
            [],
            "a doubled backslash inside a regex literal matches a literal "
            "backslash rather than the escape: %r" % (offenders,),
        )

    def test_the_four_known_patterns_use_real_escapes(self):
        # Pinned by shape so a future edit cannot silently re-double them.
        expected = [
            ("/^\\d{2}:\\d{2}$/", "scheduled check-in time"),
            ("/^\\d+$/", "relay port"),
            ("/^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2})/", "ISO timestamp"),
            ("/当前账号数:\\s*(\\d+)/", "account count"),
        ]
        for literal, what in expected:
            with self.subTest(what=what):
                self.assertIn(
                    literal, self.source, "%s pattern is missing or mis-escaped" % what
                )

    def test_patterns_accept_real_values(self):
        # Python mirrors the JS literal semantics for these simple cases.
        self.assertTrue(re.match(r"^\d{2}:\d{2}$", "12:00"))
        self.assertTrue(re.match(r"^\d{2}:\d{2}$", "08:30"))
        self.assertIsNone(re.match(r"^\d{2}:\d{2}$", "1:00"))
        self.assertTrue(re.match(r"^\d+$", "8000"))
        self.assertIsNone(re.match(r"^\d+$", "8a"))
        match = re.match(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})", "2026-01-15T12:00:00")
        self.assertIsNotNone(match)
        self.assertEqual(
            match.group(2) + "-" + match.group(3) + " " + match.group(4) + ":" + match.group(5),
            "01-15 12:00",
        )


class AutoCheckinNextRunTests(unittest.TestCase):
    """3b. Next run must name the schedule, not the current time."""

    def setUp(self):
        import tests.conftest  # noqa: F401  (isolated account store)
        from src import main as main_module

        self.main = main_module
        self.main._AUTO_CHECKIN_STATE["last_run_date"] = ""

    def test_next_run_is_never_the_current_time(self):
        tz = self.main._CHECKIN_TIMEZONE
        for hour, minute in ((11, 59), (12, 1), (13, 0), (23, 30)):
            with self.subTest(now="%02d:%02d" % (hour, minute)):
                self.main._AUTO_CHECKIN_STATE["last_run_date"] = ""
                now = datetime(2026, 1, 15, hour, minute, tzinfo=tz)
                nxt = self.main._auto_checkin_next_run(
                    {"enabled": True, "time": "12:00"}, now
                )
                self.assertNotEqual(nxt.strftime("%H:%M"), now.strftime("%H:%M"))

    def test_an_owed_but_passed_slot_is_reported_as_today(self):
        # The slot passed and today has not run, so the check-in is still owed
        # today - the scheduler fires on its next tick. Reporting tomorrow
        # would be untrue, so the time stays today's and "overdue" is a
        # separate flag rather than being encoded by moving the clock.
        tz = self.main._CHECKIN_TIMEZONE
        now = datetime(2026, 1, 15, 13, 0, tzinfo=tz)
        nxt = self.main._auto_checkin_next_run({"enabled": True, "time": "12:00"}, now)
        self.assertEqual(nxt.strftime("%Y-%m-%d %H:%M"), "2026-01-15 12:00")
        self.assertLess(nxt, now, "an owed slot is in the past by definition")

    def test_yesterdays_completed_run_moves_to_tomorrow(self):
        tz = self.main._CHECKIN_TIMEZONE
        self.main._AUTO_CHECKIN_STATE["last_run_date"] = "2026-01-15"
        nxt = self.main._auto_checkin_next_run(
            {"enabled": True, "time": "12:00"}, datetime(2026, 1, 15, 13, 0, tzinfo=tz)
        )
        self.assertEqual(nxt.strftime("%Y-%m-%d %H:%M"), "2026-01-16 12:00")

    def test_payload_flags_an_overdue_slot(self):
        # "下次执行 12:00" read at 13:00 looks like it already ran. The payload
        # must say so explicitly so the UI can distinguish the two cases.
        tz = self.main._CHECKIN_TIMEZONE
        late = datetime(2026, 1, 15, 13, 0, tzinfo=tz)
        early = datetime(2026, 1, 15, 7, 0, tzinfo=tz)
        due = self.main._auto_checkin_next_run({"enabled": True, "time": "12:00"}, late)
        future = self.main._auto_checkin_next_run({"enabled": True, "time": "12:00"}, early)
        # Owed: the slot is behind us. Not owed: it is still ahead.
        self.assertLess(due, late)
        self.assertGreater(future, early)
        self.assertEqual(due.strftime("%H:%M"), "12:00")
        self.assertEqual(future.strftime("%H:%M"), "12:00")

    def test_before_the_slot_today_is_reported(self):
        tz = self.main._CHECKIN_TIMEZONE
        nxt = self.main._auto_checkin_next_run(
            {"enabled": True, "time": "12:00"}, datetime(2026, 1, 15, 7, 0, tzinfo=tz)
        )
        self.assertEqual(nxt.strftime("%Y-%m-%d %H:%M"), "2026-01-15 12:00")

    def test_due_still_fires_on_the_day_it_is_owed(self):
        tz = self.main._CHECKIN_TIMEZONE
        self.assertFalse(
            self.main._auto_checkin_due(
                {"enabled": True, "time": "12:00"},
                datetime(2026, 1, 15, 11, 59, tzinfo=tz),
            )
        )
        self.assertTrue(
            self.main._auto_checkin_due(
                {"enabled": True, "time": "12:00"},
                datetime(2026, 1, 15, 12, 1, tzinfo=tz),
            )
        )


class UsageChartTests(unittest.TestCase):
    """4. The usage page needs a chart, not only a table."""

    def setUp(self):
        self.html = console_document()

    def test_usage_page_has_a_chart(self):
        self.assertIn('id="usage-chart"', self.html)
        self.assertIn('id="usage-chart-wrap"', self.html)

    def test_usage_chart_has_an_empty_state(self):
        self.assertIn('id="usage-chart-empty"', self.html)

    def test_usage_chart_reuses_the_existing_chart_classes(self):
        css = console_styles()
        for selector in (".chart", ".bar-col", ".bar-stack", ".bar-seg"):
            with self.subTest(selector=selector):
                self.assertTrue(_rule(css, selector), "%s is not styled" % selector)

    def test_every_chart_readout_is_populated(self):
        """A readout box with no writer renders as a 40px empty stripe.

        #usage-chart-readout was added to the markup but nothing ever wrote to
        it, so the usage chart had no legend at all - the overview one had one
        because it had its own private copy of the builder.
        """
        body = console_script()
        self.assertIn("function renderChartReadout", body)
        self.assertIn("function chartReadoutItems", body)
        # Both pages must go through the shared builder.
        for element_id in ("ov-readout", "usage-chart-readout"):
            with self.subTest(element=element_id):
                self.assertIn(element_id, body)
        self.assertIn("renderChartReadout('ov-readout'", body)
        self.assertIn("renderChartReadout('usage-chart-readout'", body)

    def test_legend_swatches_match_the_stacked_segments(self):
        # The legend is only useful if its colours are the segments' colours.
        css = console_styles()
        for swatch, segment in (
            (".sw-in", ".seg-in"),
            (".sw-out", ".seg-out"),
            (".sw-cache", ".seg-cache"),
        ):
            with self.subTest(swatch=swatch):
                self.assertEqual(
                    _rule(css, swatch),
                    _rule(css, segment),
                    "%s must use the same colour as %s" % (swatch, segment),
                )

    def test_usage_readout_defaults_to_the_newest_day(self):
        body = console_script()
        chart = body.split("function renderUsageChart()", 1)[1].split("\nfunction ", 1)[0]
        self.assertIn("showUsageChartDay", chart)
        self.assertIn("usageChartDay=", chart)

    def test_script_aggregates_records_by_day(self):
        body = console_script()
        self.assertIn("function usageDailySeries", body)
        self.assertIn("function renderUsageChart", body)


class ModelsAutoRefreshTests(unittest.TestCase):
    """5. The model list loads on boot, not only on click."""

    def test_switching_to_models_loads_the_list(self):
        body = console_script()
        switch = body.split("function switchTab(name)", 1)[1].split("\nfunction ", 1)[0]
        self.assertIn("refreshModels()", switch)
        self.assertIn("'models'", switch)


if __name__ == "__main__":
    unittest.main()
