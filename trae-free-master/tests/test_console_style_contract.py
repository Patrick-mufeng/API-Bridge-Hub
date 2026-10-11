"""Style and data-contract tests for the console.

The console rewrite split one inlined document into markup + console.css +
app.js. Two classes of defect appeared at that seam and neither was covered:

1. Markup/JS emits class names the stylesheet never defines. The chart, the
   usage table, the account switches and every transient message rendered
   unstyled - a message the JS shows stayed display:none, so feedback was
   silently invisible. A served-CSS substring check cannot catch this: the
   classes are produced at runtime and the CSS still parses.
2. app.js reads requestJSON() results as if they were unwrapped payloads.
   requestJSON returns {ok, status, data}, so d.entries and d.listenerRunning
   were always undefined: the logs page was permanently empty and the login
   badge always claimed the listener was down.

These tests pin the contract on both sides of the seam.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

from tests.console_testkit import console_script, console_styles

REPO_ROOT = Path(__file__).resolve().parent.parent
PAGES_DIR = REPO_ROOT / "src" / "console" / "pages"


def _css_class_tokens(css: str) -> set[str]:
    body = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    return set(re.findall(r"\.(-?[A-Za-z_][A-Za-z0-9_-]*)", body))


_PLACEHOLDER = re.compile(r"@@[A-Za-z_][A-Za-z0-9_]*@@")
# A real CSS class token; anything else is JS concatenation debris.
_CLASS_TOKEN = re.compile(r"-?[A-Za-z_][A-Za-z0-9_-]*")


def _clean(tokens: set[str]) -> set[str]:
    """Drop template placeholders and JS quote/concat debris."""
    out: set[str] = set()
    for token in tokens:
        token = _PLACEHOLDER.sub(" ", token)
        for part in token.split():
            if not part or part.startswith("$"):
                continue
            if not _CLASS_TOKEN.fullmatch(part):
                continue
            out.add(part)
    return out


def _markup_class_tokens(markup: str) -> set[str]:
    tokens: set[str] = set()
    for match in re.finditer(r'class="([^"]*)"', markup):
        tokens.update(match.group(1).split())
    for match in re.finditer(r"class='([^']*)'", markup):
        tokens.update(match.group(1).split())
    return _clean(tokens)


def _js_class_tokens(js: str) -> set[str]:
    """Class names app.js puts into the DOM.

    Deliberately reads the literals the script emits rather than the rendered
    document: these views are built at runtime by fetch callbacks, so the
    served HTML never contains them.
    """
    tokens: set[str] = set()
    # class="a b c" and class='a b c' inside generated markup
    for match in re.finditer(r'class="([^"$]*)"', js):
        tokens.update(match.group(1).split())
    for match in re.finditer(r"class='([^']*)'", js):
        tokens.update(match.group(1).split())
    # el.className='a b c' (concatenations collapse to the literal prefix)
    for match in re.finditer(r"\.className\s*=\s*'([^']*)'", js):
        tokens.update(match.group(1).split())
    for match in re.finditer(r'\.className\s*=\s*"([^"]*)"', js):
        tokens.update(match.group(1).split())
    # classList.add/toggle/remove('name')
    for match in re.finditer(
        r"classList\.(?:add|toggle|remove)\(\s*'([^']+)'", js
    ):
        tokens.add(match.group(1))
    return _clean(tokens)


class StyleContractTests(unittest.TestCase):
    """Every class the console emits must have a rule in console.css."""

    @classmethod
    def setUpClass(cls):
        cls.css = console_styles()
        cls.defined = _css_class_tokens(cls.css)
        cls.js = console_script()
        cls.pages = "\n".join(
            p.read_text(encoding="utf-8") for p in sorted(PAGES_DIR.glob("*.html"))
        )

    def test_page_markup_classes_are_styled(self):
        unstyled = sorted(_markup_class_tokens(self.pages) - self.defined)
        self.assertEqual(
            unstyled,
            [],
            "page fragments emit classes with no CSS rule: %s" % unstyled,
        )

    def test_generated_markup_classes_are_styled(self):
        # The chart, usage table and account switches are built by app.js.
        unstyled = sorted(_js_class_tokens(self.js) - self.defined)
        self.assertEqual(
            unstyled,
            [],
            "app.js emits classes with no CSS rule: %s" % unstyled,
        )

    def test_transient_message_states_are_styled_and_visible(self):
        # app.js assigns exactly these; each must both exist and reveal the
        # element, otherwise operator feedback never appears.
        for cls in ("msg-ok", "msg-err", "msg-pending"):
            with self.subTest(cls=cls):
                rule = re.search(r"\.msg\." + cls + r"\b[^{]*\{([^}]*)\}", self.css)
                self.assertIsNotNone(rule, ".msg.%s is not styled" % cls)
                self.assertIn("display: block", rule.group(1).replace("display:block", "display: block"))

    def test_toast_and_busy_states_are_styled_and_visible(self):
        # app.js: toast.className='toast visible ok|error'; indicator gets 'visible'.
        toast = re.search(r"\.toast\.visible\b[^{]*\{([^}]*)\}", self.css)
        self.assertIsNotNone(toast, ".toast.visible is not styled")
        self.assertIn("display: block", toast.group(1).replace("display:block", "display: block"))
        for cls in ("ok", "error"):
            with self.subTest(cls=cls):
                self.assertIn(".toast.%s" % cls, self.css)
        busy = re.search(r"\.busy-indicator\.visible\b[^{]*\{([^}]*)\}", self.css)
        self.assertIsNotNone(busy, ".busy-indicator.visible is not styled")

    def test_chart_bar_classes_are_styled(self):
        # The overview chart is drawn as nested spans; without these the chart
        # renders as an empty box even though the data is present.
        for cls in ("bar-col", "bar-stack", "bar-seg", "seg-out", "seg-in", "seg-cache"):
            with self.subTest(cls=cls):
                self.assertIn(cls, self.defined, ".%s is not styled" % cls)


class SidebarFootTests(unittest.TestCase):
    def test_footer_lays_name_and_version_apart(self):
        # Markup is <div class="sidebar-foot"><span>name</span><span>vX</span>,
        # so the container itself must space its children: without a gap the
        # two spans render as "trae-freev1.0.3".
        css = console_styles()
        rule = re.search(r"\.sidebar-foot\s*\{([^}]*)\}", css)
        self.assertIsNotNone(rule, ".sidebar-foot is not styled")
        body = rule.group(1)
        self.assertTrue(
            "display: flex" in body.replace("display:flex", "display: flex"),
            ".sidebar-foot must be a flex container to space its spans",
        )
        self.assertRegex(body.replace(" ", ""), r"justify-content:space-between|gap:")

    def test_footer_supplies_both_values(self):
        markup = (PAGES_DIR / "_shell_head.html").read_text(encoding="utf-8")
        self.assertIn("sidebar-foot", markup)
        self.assertIn("@@APP_VERSION@@", markup)


class SlidingSelectionTests(unittest.TestCase):
    """app.js positions .nav-indicator and .seg-thumb absolutely.

    Both need a positioned ancestor and a stacking order that keeps the
    sliding block behind the labels, or it paints over the text it highlights.
    """

    def setUp(self):
        self.css = console_styles()

    def _rule(self, selector: str) -> str:
        match = re.search(re.escape(selector) + r"\s*\{([^}]*)\}", self.css)
        self.assertIsNotNone(match, "%s is not styled" % selector)
        return match.group(1).replace(" ", "")

    def test_nav_list_is_a_positioning_context(self):
        self.assertIn("position:relative", self._rule(".nav-list"))

    def test_segmented_is_a_positioning_context_with_labels_above_the_thumb(self):
        self.assertIn("position:relative", self._rule(".segmented"))
        label = self._rule(".segmented label")
        self.assertIn("position:relative", label)
        self.assertIn("z-index:1", label)

    def test_sliding_blocks_sit_behind_their_labels(self):
        for selector in (".nav-indicator", ".seg-thumb"):
            with self.subTest(selector=selector):
                self.assertIn("z-index:0", self._rule(selector))


class RequestJSONContractTests(unittest.TestCase):
    """requestJSON returns {ok, status, data}; callers must unwrap it."""

    @classmethod
    def setUpClass(cls):
        cls.js = console_script()
        cls.lines = cls.js.splitlines()

    def _call_sites(self):
        for index, line in enumerate(self.lines):
            if "await requestJSON(" not in line:
                continue
            match = re.search(r"(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=", line)
            if not match:
                continue
            name = match.group(1)
            following = "\n".join(self.lines[index : index + 14])
            yield index + 1, name, following

    def test_every_call_site_unwraps_the_envelope(self):
        offenders = []
        for lineno, name, following in self._call_sites():
            if not re.search(r"\b" + re.escape(name) + r"\.(data|ok|status)\b", following):
                offenders.append("line %d: %s" % (lineno, name))
        self.assertEqual(
            offenders,
            [],
            "requestJSON result used without unwrapping .data/.ok: %s" % offenders,
        )


class ConsolePageBehaviourTests(unittest.TestCase):
    """The specific regressions, pinned by name so they cannot return."""

    def setUp(self):
        self.js = console_script()

    def _function_body(self, name: str) -> str:
        body = self.js.split("async function " + name, 1)[1]
        return body.split("\nasync function ", 1)[0].split("\nfunction ", 1)[0]

    def _read_somewhere_from(self, name: str) -> str:
        """The unwrapped payload a view reads, whatever it names it."""
        body = self._function_body(name)
        self.assertIn(
            "await requestJSON(",
            body,
            "%s no longer calls requestJSON" % name,
        )
        match = re.search(r"await requestJSON\([^)]*\)", body)
        assigned = re.search(
            r"(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*" + re.escape(match.group(0)),
            body,
        )
        self.assertIsNotNone(assigned, "%s discards the requestJSON result" % name)
        return assigned.group(1)

    def test_listener_status_reads_the_wrapped_payload(self):
        var = self._read_somewhere_from("refreshWebLoginStatus")
        body = self._function_body("refreshWebLoginStatus")
        self.assertRegex(
            body,
            r"\b" + re.escape(var) + r"\.data\b",
            "listener badge must read the payload out of the requestJSON envelope",
        )

    def test_logs_view_reads_the_wrapped_payload(self):
        var = self._read_somewhere_from("loadLogs")
        body = self._function_body("loadLogs")
        self.assertRegex(
            body,
            r"\b" + re.escape(var) + r"\.data\b",
            "logs view must read the payload out of the requestJSON envelope",
        )


if __name__ == "__main__":
    unittest.main()
