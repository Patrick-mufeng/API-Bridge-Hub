"""Console wiring: log ring endpoint, in-process login status/state routes."""

from __future__ import annotations

import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from src import main as main_module
from src import logbuf, web_auth


class LogsEndpointTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main_module.app)

    def test_logs_returns_entries_contract(self):
        response = self.client.get("/api/logs")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertIn("entries", body)
        self.assertIsInstance(body["entries"], list)

    def test_logs_filters_by_channel(self):
        ring = main_module._LOG_RING
        ring.clear()
        ring.write("checkin uid=abc ok")
        ring.write("| #1 | glm-5.3 | 200 |")
        ring.write("server started")
        try:
            chat = self.client.get("/api/logs?channel=chat").json()["entries"]
            self.assertEqual(len(chat), 1)
            self.assertEqual(chat[0]["ch"], logbuf.CHAT)
            task = self.client.get("/api/logs?channel=task").json()["entries"]
            self.assertEqual(len(task), 1)
            self.assertEqual(task[0]["ch"], logbuf.TASK)
            every = self.client.get("/api/logs").json()["entries"]
            self.assertEqual(len(every), 3)
        finally:
            ring.clear()

    def test_logs_respects_limit(self):
        ring = main_module._LOG_RING
        ring.clear()
        for i in range(10):
            ring.write("sys line %d" % i)
        try:
            body = self.client.get("/api/logs?limit=4").json()
            self.assertEqual(len(body["entries"]), 4)
            # Newest last: a log view wants the most recent activity at the end.
            self.assertEqual(body["entries"][-1]["text"], "sys line 9")
        finally:
            ring.clear()


class WebLoginStatusTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main_module.app)

    def test_status_reports_listener_fields_without_500(self):
        # Review Focus 1: a busy port must degrade login, not break the API.
        response = self.client.get("/api/web-login/status")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        for key in ("listenerRunning", "port", "lastError"):
            self.assertIn(key, body)
        self.assertIsInstance(body["listenerRunning"], bool)

    def test_status_reports_not_running_when_listener_failed(self):
        with patch.object(main_module, "_WEB_AUTH_SERVER", None):
            body = self.client.get("/api/web-login/status").json()
        self.assertFalse(body["listenerRunning"])

    def test_state_returns_local_callback_url(self):
        response = self.client.post("/api/web-login/state")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body.get("state"))
        url = body.get("url") or ""
        self.assertIn("127.0.0.1", url)
        self.assertIn("auth_callback_url", url)
        # The nonce must actually be registered, or the callback would refuse it.
        self.assertTrue(web_auth.get_registry().consume(body["state"]))


class PublicPathTests(unittest.TestCase):
    def test_new_console_paths_are_public(self):
        for path in ("/api/logs", "/api/web-login/status", "/api/web-login/state"):
            with self.subTest(path=path):
                self.assertTrue(
                    path in main_module.PUBLIC_PATHS,
                    path + " must be reachable by the public console",
                )


if __name__ == "__main__":
    unittest.main()
