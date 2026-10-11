"""Layout contracts for the settings and models pages.

Two defects lived here, both invisible to the existing tests:

1. Panel content was not on one gutter. .switch-row, .max-models and .kv-list
   carry 15px of their own horizontal padding, but the form controls did not,
   so inside a single card a label sat flush against the border (2px) while
   the switch row above it was indented 15px. Measured on the models page:
   card 1 content at x=238, card 2 content at x=253 - a 15px mismatch between
   adjacent cards.

2. .panel-grid.cols-2 was not two columns. It was
   repeat(auto-fit, minmax(320px, 1fr)), which rendered three 363px columns on
   a 1400px screen: five cards became 3 + 2, stranding an empty cell, and the
   layout only collapsed to two columns below ~1250px.

These pin the gutter, the real column count, and the two empty states.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

from tests.console_testkit import console_document, console_styles

REPO_ROOT = Path(__file__).resolve().parent.parent
PAGES_DIR = REPO_ROOT / "src" / "console" / "pages"


def _norm(block: str) -> str:
    return re.sub(r"\s+", "", block)


def _strip_media(css: str) -> str:
    """Remove @media blocks so only unconditional rules remain."""
    out, index = [], 0
    for match in re.finditer(r"@media[^{]*\{", css):
        out.append(css[index : match.start()])
        cursor, depth = match.end(), 1
        while cursor < len(css) and depth:
            if css[cursor] == "{":
                depth += 1
            elif css[cursor] == "}":
                depth -= 1
            cursor += 1
        index = cursor
    out.append(css[index:])
    return "".join(out)


def _rule(css: str, selector: str, *, media: bool = False) -> str:
    """Declarations for a selector.

    Unconditional rules are merged (a selector may be refined by a later
    rule). Media-query rules are excluded unless media=True, because they
    override the base declaration and would mask it.
    """
    scope = css if media else _strip_media(css)
    declarations: dict[str, str] = {}
    # Comments sit between rules and would otherwise be glued onto the next
    # selector, making it unmatchable.
    stripped = re.sub(r"/\*.*?\*/", "", scope, flags=re.S)
    for match in re.finditer(r"([^{}]+)\{([^}]*)\}", stripped):
        selectors = [s.strip() for s in match.group(1).split(",")]
        if selector not in selectors:
            continue
        for declaration in match.group(2).split(";"):
            name, separator, value = declaration.partition(":")
            if not separator:
                continue
            declarations[name.strip()] = value.strip()
    return _norm(";".join("%s:%s" % kv for kv in declarations.items()))


def _media_blocks(css: str, width: str) -> list[str]:
    """Brace-matched bodies of every @media whose condition names width."""
    out: list[str] = []
    for match in re.finditer(r"@media[^{]*" + re.escape(width) + r"[^{]*\{", css):
        index = match.end()
        depth = 1
        while index < len(css) and depth:
            if css[index] == "{":
                depth += 1
            elif css[index] == "}":
                depth -= 1
            index += 1
        out.append(css[match.end() : index - 1])
    return out


def _page(name: str) -> str:
    return (PAGES_DIR / (name + ".html")).read_text(encoding="utf-8")


class PanelGutterTests(unittest.TestCase):
    """Panel body children must all sit on the same 15px inset."""

    #: Elements that are direct children of .panel-card in the page fragments
    #: and previously had no horizontal padding of their own.
    UNPADDED = (".form-group", ".form-row", ".field-note", ".option-row", ".btn-group")

    #: Elements that already carried the gutter; they must keep it.
    CARRIERS = {
        ".switch-row": "padding:11px15px",
        ".max-models": "padding:10px15px",
        ".kv-list": "padding:6px15px12px",
        ".section-desc": "margin:015px12px",
        ".login-steps": "margin:015px12px",
    }

    def setUp(self):
        self.css = console_styles()

    def test_form_controls_are_put_on_the_gutter(self):
        for selector in self.UNPADDED:
            with self.subTest(selector=selector):
                rule = _rule(self.css, ".panel-card > " + selector)
                self.assertTrue(rule, "%s has no panel-scoped gutter rule" % selector)
                self.assertIn("padding-left:15px", rule)
                self.assertIn("padding-right:15px", rule)

    def test_gutter_is_scoped_to_direct_children(self):
        # .manual-add already indents .manual-grid; the direct-child combinator
        # is what keeps the accounts form from being padded twice.
        for selector in self.UNPADDED:
            with self.subTest(selector=selector):
                self.assertNotRegex(
                    self.css,
                    r"\.panel-card\s+" + re.escape(selector),
                    "%s must not apply to nested panels" % selector,
                )

    def test_existing_carriers_keep_their_gutter(self):
        for selector, expected in self.CARRIERS.items():
            with self.subTest(selector=selector):
                self.assertIn(expected, _rule(self.css, selector))

    def test_every_body_child_of_a_panel_has_a_gutter_source(self):
        """No direct child may be flush against the card border."""
        html = _page("settings") + _page("models")
        css = self.css
        guttered = set(self.UNPADDED) | set(self.CARRIERS) | {
            ".section-head", ".msg", ".code-out", ".conn-wrap", ".manual-add",
            ".panel-grid", ".empty-hint",
        }
        seen = set()
        for match in re.finditer(r'<div class="(?:panel-card[^"]*)">', html):
            seen.add(match.start())
        for cls in guttered:
            continue
        # Any class used as a direct child in these pages must be known-guttered.
        direct = set(re.findall(r'<div class="panel-card[^"]*">\s*<div class="([a-z-]+)"', html))
        unknown = sorted(direct - {c.lstrip(".") for c in guttered})
        self.assertEqual(
            unknown, [], "panel children with no gutter rule: %s" % unknown
        )


class SettingsGridTests(unittest.TestCase):
    def setUp(self):
        self.css = console_styles()

    def test_cols_two_is_literally_two_columns(self):
        rule = _rule(self.css, ".panel-grid.cols-2")
        self.assertTrue(rule, ".panel-grid.cols-2 is not styled")
        self.assertNotIn(
            "auto-fit",
            rule,
            "auto-fit made this three columns on a wide screen",
        )
        self.assertIn("grid-template-columns:repeat(2,minmax(0,1fr))", rule)

    def test_two_columns_collapse_on_narrow_screens(self):
        # Below the sidebar breakpoint the grid must fall back to one column.
        blocks = _media_blocks(self.css, "920px")
        self.assertTrue(blocks, "no <=920px breakpoint found")
        combined = _norm("".join(blocks))
        self.assertIn(".panel-grid.cols-2{grid-template-columns:1fr", combined)

    def test_settings_has_no_orphan_cell(self):
        # Five cards in two columns leaves a hole unless the last one spans.
        html = _page("settings")
        self.assertIn('id="max-mode-panel"', html)
        spanning = re.search(
            r'<div class="panel-card[^"]*"[^>]*id="max-mode-panel"|'
            r'id="max-mode-panel"[^>]*class="([^"]*)"',
            html,
        )
        self.assertIsNotNone(spanning)
        self.assertIn("span-all", html, "the trailing settings card must span the grid")
        self.assertIn("grid-column:1/-1", _rule(self.css, ".span-all"))


class EmptyStateTests(unittest.TestCase):
    """"Nothing yet" must be legible, not an empty bordered box."""

    def setUp(self):
        self.html = console_document()

    def _block(self, element_id: str, tag: str = "pre") -> str:
        match = re.search(
            r'<' + tag + r'[^>]*id="' + element_id + r'"[^>]*>(.*?)</' + tag + r'>',
            self.html,
            re.S,
        )
        self.assertIsNotNone(match, "no <%s id=%s>" % (tag, element_id))
        return match.group(1)

    def test_models_list_explains_itself_before_the_first_fetch(self):
        text = re.sub(r"<[^>]+>", "", self._block("models-empty", "p")).strip()
        self.assertTrue(text, "the model list has no first-run hint")
        self.assertIn("获取", text)

    def test_connectivity_card_prompts_before_the_first_run(self):
        # The results table is hidden until a test runs, so the card needs a
        # visible instruction in its place.
        self.assertIn('id="conn-empty"', self.html)
        block = re.search(
            r'<[a-z]+[^>]*id="conn-empty"[^>]*>(.*?)</[a-z]+>', self.html, re.S
        )
        self.assertIsNotNone(block)
        self.assertTrue(re.sub(r"<[^>]+>", "", block.group(1)).strip())

    def test_empty_state_markers_have_styling(self):
        css = console_styles()
        for selector in (".empty-hint",):
            with self.subTest(selector=selector):
                self.assertTrue(_rule(css, selector), "%s is not styled" % selector)

    def test_hint_is_readable_not_accent_coloured(self):
        """Guidance text must not look like machine output.

        --ink-3 is only 3.04:1 (light) / 3.98:1 (dark) on the panel
        background, below the 4.5:1 body-text threshold, and the accent
        colour is reserved for real output.
        """
        css = console_styles()
        rule = _rule(css, ".empty-hint")
        self.assertIn("color:var(--ink-2)", rule)
        self.assertNotIn("var(--accent)", rule)

    def test_context_headline_uses_the_largest_usable_window(self):
        """max is the 1M tier and is 0 on most models.

        Using it as the headline rendered a 256K model as "--", which reads as
        "unknown context" instead of "256K, no Max tier".
        """
        from tests.console_testkit import console_script

        body = console_script().split("function modelContextCell(m)", 1)[1].split(
            "\nfunction ", 1
        )[0]
        compact = body.replace(" ", "")
        self.assertIn("max>dev?max:dev", compact)
        self.assertIn("if(!best)", compact)

    def test_placeholder_hides_when_the_table_renders(self):
        """The hint must give way to the table, not sit next to it."""
        from tests.console_testkit import console_script

        body = console_script().split("function renderModels()", 1)[1].split(
            "\nfunction ", 1
        )[0]
        self.assertIn("empty.hidden=true", body.replace(" ", ""))
        self.assertIn("wrap.hidden=false", body.replace(" ", ""))


if __name__ == "__main__":
    unittest.main()
