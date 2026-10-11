"""The relay port must be 8015 everywhere it is declared.

Five places declare or publish this port and they have to agree:

  * src/main.py         - the in-process default when PORT is unset
  * .env / .env.example - what a native run actually binds
  * Dockerfile          - ENV PORT, EXPOSE, healthcheck and CMD default
  * docker-compose files - host-to-container mapping

Docker fails confusingly when these drift: the container listens on one
port while compose publishes another, so the relay looks dead. Pinning them
together is the point of this test.

Deliberately not covered: WEB_LOGIN_LISTENER_PORT (the browser login
callback listener, a different port), and the 8000-valued fixtures in
test_issue6_settings / test_login_e2e / test_web_auth, which are arbitrary
sample values rather than defaults.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
EXPECTED_PORT = "8015"


class RelayPortDefaultTests(unittest.TestCase):
    def test_main_defaults_to_the_project_port(self):
        source = (REPO_ROOT / "src" / "main.py").read_text(encoding="utf-8")
        match = re.search(r'^PORT = int\(os\.environ\.get\("PORT", "(\d+)"\)\)', source, re.M)
        self.assertIsNotNone(match, "PORT declaration not found in main.py")
        self.assertEqual(match.group(1), EXPECTED_PORT)

    def test_env_example_declares_the_project_port(self):
        text = (REPO_ROOT / ".env.example").read_text(encoding="utf-8")
        self.assertIn("PORT=" + EXPECTED_PORT, text)

    def test_local_env_declares_the_project_port(self):
        # Untracked, but it is what the running process reads.
        path = REPO_ROOT / ".env"
        if not path.is_file():
            self.skipTest(".env is not present")
        self.assertIn("PORT=" + EXPECTED_PORT, path.read_text(encoding="utf-8"))


class DockerPortTests(unittest.TestCase):
    def setUp(self):
        self.dockerfile = (REPO_ROOT / "Dockerfile").read_text(encoding="utf-8")

    def test_dockerfile_env_expose_and_cmd_agree(self):
        self.assertRegex(self.dockerfile, r"(?m)^\s*PORT=" + EXPECTED_PORT)
        self.assertRegex(self.dockerfile, r"(?m)^EXPOSE " + EXPECTED_PORT)
        self.assertIn("${PORT:-" + EXPECTED_PORT + "}", self.dockerfile)
        self.assertIn("os.environ.get('PORT', '" + EXPECTED_PORT + "')", self.dockerfile)

    def test_no_dockerfile_reference_to_the_old_port(self):
        offenders = [
            line.strip()
            for line in self.dockerfile.splitlines()
            if re.search(r"\b8000\b", line)
        ]
        self.assertEqual(offenders, [], "Dockerfile still references 8000: %r" % offenders)

    def test_compose_publishes_and_targets_the_same_port(self):
        for name in ("docker-compose.yml", "docker-compose.image.yml"):
            with self.subTest(compose=name):
                text = (REPO_ROOT / name).read_text(encoding="utf-8")
                mapping = [l for l in text.splitlines() if "RELAY_PORT" in l]
                self.assertTrue(mapping, "no RELAY_PORT mapping in " + name)
                numbers = re.findall(r"\b(\d{4})\b", mapping[0])
                self.assertTrue(numbers, "no port number in " + mapping[0])
                for value in numbers:
                    self.assertEqual(value, EXPECTED_PORT,
                                     "%s maps port %s, project port is %s" % (name, value, EXPECTED_PORT))


class DocumentationPortTests(unittest.TestCase):
    def test_user_facing_docs_point_at_the_project_port(self):
        for name in ("README.md", "docs/INTEGRATION.md"):
            with self.subTest(doc=name):
                text = (REPO_ROOT / name).read_text(encoding="utf-8")
                stale = [
                    line.strip()[:100]
                    for line in text.splitlines()
                    if re.search(r"127\.0\.0\.1:8000|:\s*8000\b", line)
                ]
                self.assertEqual(stale, [], "%s still points at 8000: %r" % (name, stale))


if __name__ == "__main__":
    unittest.main()
