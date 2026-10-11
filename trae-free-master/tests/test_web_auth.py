"""In-process OAuth callback listener: state nonce, auth URL, port handling."""

from __future__ import annotations

import asyncio
import socket
import time
import unittest
import urllib.parse

from src import web_auth


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class BuildAuthUrlTests(unittest.TestCase):
    def test_callback_points_at_the_local_listener(self):
        url = web_auth.build_auth_url(
            "trace-123",
            client_id="cid",
            auth_url="https://www.trae.cn/authorization",
            listener_port=8765,
        )
        parsed = urllib.parse.urlparse(url)
        query = dict(urllib.parse.parse_qsl(parsed.query))
        self.assertEqual(parsed.scheme, "https")
        self.assertEqual(parsed.netloc, "www.trae.cn")
        self.assertEqual(parsed.path, "/authorization")
        # The whole flow hinges on Trae accepting this exact callback shape.
        self.assertEqual(
            query["auth_callback_url"], "http://127.0.0.1:8765/authorize"
        )
        self.assertEqual(query["client_id"], "cid")
        self.assertEqual(query["login_trace_id"], "trace-123")


class LoginRegistryTests(unittest.TestCase):
    def test_registered_state_is_consumed_once(self):
        reg = web_auth.LoginRegistry()
        reg.register("s1")
        self.assertTrue(reg.consume("s1"))
        # Replaying a completed callback must not write credentials twice.
        self.assertFalse(reg.consume("s1"))

    def test_unregistered_state_is_rejected(self):
        reg = web_auth.LoginRegistry()
        self.assertFalse(reg.consume("never-registered"))
        self.assertFalse(reg.consume(""))

    def test_prune_drops_expired_states(self):
        reg = web_auth.LoginRegistry(ttl=10.0)
        reg.register("old")
        removed = reg.prune(now=time.time() + 11)
        self.assertEqual(removed, 1)
        self.assertFalse(reg.consume("old"))


class AuthCallbackServerTests(unittest.TestCase):
    def test_start_and_stop_reports_running(self):
        async def scenario():
            server = web_auth.AuthCallbackServer(port=_free_port())
            self.assertTrue(await server.start())
            try:
                self.assertTrue(server.running)
            finally:
                await server.stop()
            self.assertFalse(server.running)
        asyncio.run(scenario())

    def test_occupied_port_degrades_without_raising(self):
        # Review Focus 1: a busy port must not take the relay down.
        async def scenario():
            blocker = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            blocker.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            blocker.bind(("127.0.0.1", 0))
            blocker.listen(1)
            port = blocker.getsockname()[1]
            try:
                server = web_auth.AuthCallbackServer(port=port)
                self.assertFalse(await server.start())
                self.assertFalse(server.running)
                self.assertTrue(server.last_error)
            finally:
                blocker.close()
        asyncio.run(scenario())

    def test_callback_with_unregistered_state_is_refused(self):
        # Review Focus 2: a forged/absent state must never write credentials.
        calls = []

        async def fake_parse(query):
            return {"token": "should-not-be-used"}

        def fake_add(creds, label=""):
            calls.append(creds)
            return "account-1"

        async def scenario():
            port = _free_port()
            server = web_auth.AuthCallbackServer(
                port=port, parse_params=fake_parse, add_account=fake_add
            )
            self.assertTrue(await server.start())
            try:
                reader, writer = await asyncio.open_connection("127.0.0.1", port)
                writer.write(
                    b"GET /authorize?state=forged&userJwt=e30 HTTP/1.1\r\n"
                    b"Host: 127.0.0.1\r\nConnection: close\r\n\r\n"
                )
                await writer.drain()
                body = await reader.read()
                writer.close()
            finally:
                await server.stop()
            return body

        body = asyncio.run(scenario())
        self.assertEqual(calls, [])
        self.assertIn(b"400", body.split(b"\r\n", 1)[0])

    def test_callback_with_registered_state_writes_credentials(self):
        calls = []

        async def fake_parse(query):
            return {"token": "tok", "user_id": "u1"}

        def fake_add(creds, label=""):
            calls.append(creds)
            return "account-1"

        async def scenario():
            port = _free_port()
            registry = web_auth.LoginRegistry()
            server = web_auth.AuthCallbackServer(
                port=port,
                registry=registry,
                parse_params=fake_parse,
                add_account=fake_add,
            )
            registry.register("good-state")
            self.assertTrue(await server.start())
            try:
                reader, writer = await asyncio.open_connection("127.0.0.1", port)
                writer.write(
                    b"GET /authorize?state=good-state&userJwt=e30 HTTP/1.1\r\n"
                    b"Host: 127.0.0.1\r\nConnection: close\r\n\r\n"
                )
                await writer.drain()
                body = await reader.read()
                writer.close()
            finally:
                await server.stop()
            return body

        body = asyncio.run(scenario())
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["token"], "tok")
        self.assertIn(b"200", body.split(b"\r\n", 1)[0])

    def test_healthz_reports_listener_and_relay(self):
        async def scenario():
            port = _free_port()
            server = web_auth.AuthCallbackServer(
                port=port, relay_url="http://127.0.0.1:8000"
            )
            self.assertTrue(await server.start())
            try:
                reader, writer = await asyncio.open_connection("127.0.0.1", port)
                writer.write(
                    b"GET /healthz HTTP/1.1\r\n"
                    b"Host: 127.0.0.1\r\nConnection: close\r\n\r\n"
                )
                await writer.drain()
                body = await reader.read()
                writer.close()
            finally:
                await server.stop()
            return body

        body = asyncio.run(scenario())
        self.assertIn(b"200", body.split(b"\r\n", 1)[0])
        self.assertIn(b"\"relay\"", body)


class ResultPageEscapingTests(unittest.TestCase):
    """The result page embeds the trace id in a JS string literal.

    HTML-escaping alone is not enough there: an unescaped backslash before the
    closing quote escapes it and turns the rest of the value into code.
    """

    def _script(self, state):
        page = web_auth._page("失败", "detail", success=False, state=state)
        text = page.decode("utf-8")
        start = text.index("<script>") + len("<script>")
        end = text.index("</script>", start)
        return text[start:end]

    def test_backslash_is_escaped(self):
        self.assertEqual(web_auth._escape(chr(92)), chr(92) + chr(92))

    def test_angle_brackets_and_quotes_are_escaped(self):
        escaped = web_auth._escape('</script>"x"')
        self.assertNotIn("<", escaped)
        self.assertNotIn(chr(34), escaped)

    def test_trailing_backslash_does_not_break_the_result_script(self):
        # The escaped value must keep the JS string closed; an odd number of
        # trailing backslashes used to escape the closing quote.
        script = self._script(chr(92))
        self.assertEqual(script.count(chr(34)) % 2, 0)
        self.assertNotIn(chr(92) + chr(34) + "}", script.replace(chr(92) + chr(92), ""))

    def test_quote_breakout_payload_stays_inside_the_string(self):
        payload = chr(92) + chr(34) + ";globalThis.PWNED=1;//"
        script = self._script(payload)
        # No raw quote may appear directly before the injected statement.
        self.assertNotIn(chr(34) + ";globalThis.PWNED", script)

    def test_script_tag_payload_cannot_close_the_script(self):
        script = self._script("</script><script>globalThis.PWNED=1</script>")
        self.assertNotIn("</script>", script)
        self.assertNotIn("<script>", script)


class GetRegistryTests(unittest.TestCase):
    def test_get_registry_returns_a_singleton(self):
        self.assertIs(web_auth.get_registry(), web_auth.get_registry())


if __name__ == "__main__":
    unittest.main()