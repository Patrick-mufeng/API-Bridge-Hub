# SDD ledger — plan: docs/superpowers/plans/2026-10-09-console-rewrite.md

Spec: docs/superpowers/specs/2026-10-09-console-rewrite-inprocess-login-design.md
Baseline: 705 tests, 36 failures + 4 errors (docs/superpowers/baseline-tests.txt)
Pre-flight: Tasks 1,2,3 are greenfield (no shared interfaces). Tasks 4->3 consumes PIXEL_CSS/ICONS (defined Task 3). Task 5 consumes window.__CONSOLE__ (defined Task 4). Task 6 consumes logbuf.install_ring_handler (Task 1) + web_auth.* (Task 2). Task 7 consumes Task 4/5 DOM+JS. No conflicts found.
Task 1: complete (tests: python -m unittest tests.test_logbuf -> 13/13 pass)
Task 2: complete (tests: python -m unittest tests.test_web_auth -> 10/10 pass)
Task 2: Ruling: implemented work_auth callback add_account as synchronous call - real auth.add_account is sync (auth.py:1148); my first test fake was async, which silently never ran - cost if wrong: a future async add_account would need an await here
Task 3: complete (tests: tests.test_console_assets -> 10/10 pass; full suite 705 tests == baseline 36F+4E, no new failures)
Task 3: Ruling: /console/ added to PUBLIC_PATH_PREFIXES - assets hold no credentials and the page is already public; the key gate stays on API routes - cost if wrong: console assets readable without a key
Task 4: complete (console package renders 6 pages; main.py 10315 -> 8593 lines; all 124 legacy ids preserved)
Task 5: complete (app.js 1484 lines, node --check PASS, zero doubled braces; login panel has no download links)
Task 5: Ruling: page fragments moved from repr() strings to real .html files - repr() injection made views.py unmaintainable and broke once; files are editable and views.py is a loader - cost if wrong: one extra directory
Task 6: complete (tests.test_console_wiring -> 7/7 pass; /api/logs, /api/web-login/status, /api/web-login/state wired)
Task 6: Ruling: renamed existing route fn web_auth -> api_web_auth - it shadowed the web_auth module import inside the module namespace - cost if wrong: none, route path unchanged
Task 7: complete (745 tests, failure set IDENTICAL to baseline 36F+4E; tests/console_testkit.py routes DOM vs JS assertions)
Task 7: Ruling: behavior assertions read /console/app.js, markup assertions read the document - the split is real, and the alternative (inlining JS) reintroduces the f-string escaping hazard - cost if wrong: a future inline-JS change must update the testkit
Task 7: Ruling: app.js backslash escapes un-doubled - original JS lived in a Python f-string so source \\n was delivered as \n; verbatim copy left [\\n,] which matches the letter n. Caught by test_rendered_console_keeps_javascript_newline_escapes - cost if wrong: none, node --check passes and regex semantics are now correct
Task 8: complete (750 tests, failure set identical to baseline 36F+4E; tests/test_login_e2e.py 5/5 pass incl. forged/replayed state rejection)
Final: fixed chat channel never populated - live check showed sys=N chat=0 because the relay per-request lines (request received/dispatch/remote create/public stream) carry no "| #" marker; classifier now matches them. Verified live chat=7 sys=2. tests/test_logbuf.py RED->GREEN.
Final: verified /api/logs leaks no secrets - live run with RELAY_API_KEYS set showed no api key, no Bearer header, no JWT-shaped strings; ring captures request ids/model/counts only.
Final: fixed README still documenting the download-the-script flow and a five-page console - it now describes in-process login, the six pages, and the state nonce.
Final: fixed unescaped backslash in web_auth._page - the trace id sits in a JS string literal, so a trailing backslash escaped the closing quote and broke the result page script (no code execution proven, but string breakout was real). _escape now doubles backslash. Verified in node: all 5 injection payloads PWNED=0. tests/test_web_auth.py RED->GREEN, 15/15.
