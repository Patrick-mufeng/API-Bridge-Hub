"""End-to-end check of the in-process browser login flow.

Drives the console login API and delivers a real HTTP callback to the listener
on 127.0.0.1 - the path a browser takes after the operator approves the Trae
authorization page. No helper script is downloaded or run at any point.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request

from fastapi.testclient import TestClient

from src import auth, main as main_module, web_auth


def _user_jwt(token="e2e-token", refresh="e2e-refresh"):
    return json.dumps({
        "ClientID": "ono9krqynydwx5",
        "Token": token,
        "RefreshToken": refresh,
        "TokenExpireAt": "1900000000000",
    })


def _user_info(uid="e2e-uid"):
    return json.dumps(
        {
            "UserID": uid,
            "TenantID": "e2e-tenant",
            "Region": "CN",
            "AIRegion": "cn",
        }
    )


class _Listener:
    """Runs the real callback listener on its own event loop in a thread."""

    def __init__(self, port):
        self.port = port
        self.server = None
        self.loop = None
        self._ready = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _run(self):
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        self.server = web_auth.build_default_server(
            self.port, "http://127.0.0.1:8000"
        )
        ok = self.loop.run_until_complete(self.server.start())
        if not ok:
            self._ready.set()
            return
        self._ready.set()
        self.loop.run_forever()

    def start(self):
        self._thread.start()
        self._ready.wait(timeout=10)
        # Give accept() a moment to arm before the first request.
        for _ in range(50):
            if self.server is not None and self.server.running:
                return True
            time.sleep(0.1)
        return False

    def stop(self):
        if self.loop is None:
            return
        try:
            if self.server is not None:
                asyncio.run_coroutine_threadsafe(
                    self.server.stop(), self.loop
                ).result(timeout=5)
        except Exception:
            pass
        self.loop.call_soon_threadsafe(self.loop.stop)
        self._thread.join(timeout=5)


class InProcessLoginTests(unittest.TestCase):
    """Browser login completes inside the relay process."""

    def setUp(self):
        self.client = TestClient(main_module.app)
        self.added = []
        self._real_add = auth.add_account

        def fake_add(creds, label=""):
            self.added.append(creds)
            return creds.get("user_id") or "e2e"

        auth.add_account = fake_add
        self.listener = None

    def tearDown(self):
        auth.add_account = self._real_add
        if self.listener is not None:
            self.listener.stop()

    def _start_listener(self):
        listener = _Listener(main_module.LOCAL_LISTENER_PORT)
        if not listener.start():
            return None
        self.listener = listener
        return listener

    def _callback_url(self, **params):
        return "http://127.0.0.1:{}/authorize?{}".format(
            main_module.LOCAL_LISTENER_PORT, urllib.parse.urlencode(params)
        )

    def test_login_panel_offers_no_download(self):
        html = self.client.get("/web/login").text
        for artifact in ("start_auth.bat", "web_login.py", "/web/login/download"):
            with self.subTest(artifact=artifact):
                self.assertNotIn(artifact, html)

    def test_status_endpoint_reports_listener_fields(self):
        body = self.client.get("/api/web-login/status").json()
        for key in ("listenerRunning", "port", "lastError"):
            self.assertIn(key, body)

    def test_registered_state_callback_writes_credentials(self):
        state = self.client.post("/api/web-login/state").json()
        parsed = urllib.parse.urlparse(state["url"])
        query = dict(urllib.parse.parse_qsl(parsed.query))
        self.assertEqual(
            query["auth_callback_url"],
            "http://127.0.0.1:{}/authorize".format(main_module.LOCAL_LISTENER_PORT),
        )
        if self._start_listener() is None:
            self.skipTest("listener port unavailable in this environment")

        url = self._callback_url(
            state=state["state"], userJwt=_user_jwt(), userInfo=_user_info()
        )
        with urllib.request.urlopen(url, timeout=15) as resp:
            body = resp.read().decode("utf-8", "replace")
            self.assertEqual(resp.status, 200)
        self.assertIn("授权成功", body)
        self.assertEqual(len(self.added), 1)
        self.assertEqual(self.added[0]["token"], "e2e-token")
        self.assertEqual(self.added[0]["user_id"], "e2e-uid")

    def test_forged_state_is_refused_and_writes_nothing(self):
        if self._start_listener() is None:
            self.skipTest("listener port unavailable in this environment")
        url = self._callback_url(state="forged-state", userJwt=_user_jwt())
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(url, timeout=15)
        self.assertEqual(caught.exception.code, 400)
        self.assertEqual(self.added, [])

    def test_replayed_state_is_refused(self):
        state = self.client.post("/api/web-login/state").json()["state"]
        if self._start_listener() is None:
            self.skipTest("listener port unavailable in this environment")
        url = self._callback_url(
            state=state, userJwt=_user_jwt(), userInfo=_user_info()
        )
        with urllib.request.urlopen(url, timeout=15) as resp:
            self.assertEqual(resp.status, 200)
        self.assertEqual(len(self.added), 1)
        # One-time nonce: a replay must not add a second account.
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(url, timeout=15)
        self.assertEqual(caught.exception.code, 400)
        self.assertEqual(len(self.added), 1)


if __name__ == "__main__":
    unittest.main()
