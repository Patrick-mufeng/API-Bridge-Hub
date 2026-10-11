"""Log ring buffer: channel classification, bounded capacity, handler wiring."""

from __future__ import annotations

import logging
import threading
import unittest

from src import logbuf


class ClassifyLineTests(unittest.TestCase):
    def test_chat_channel_is_the_per_request_table_row(self):
        self.assertEqual(logbuf.classify_line("| #12 | glm-5.3 | 200 |"), logbuf.CHAT)

    def test_task_channel_covers_checkin_and_panel_actions(self):
        for line in (
            "checkin uid=abc ok",
            "panel: 手动全量签到已触发",
            "balance uid=abc credits=10/20",
            "activity uid=abc",
            "keepalive uid=abc",
        ):
            with self.subTest(line=line):
                self.assertEqual(logbuf.classify_line(line), logbuf.TASK)

    def test_everything_else_is_system(self):
        for line in ("server started", "warn: upstream 502", ""):
            with self.subTest(line=line):
                self.assertEqual(logbuf.classify_line(line), logbuf.SYS)

    def test_real_per_request_lines_are_chat_not_system(self):
        # Regression: the relay logs request lifecycle lines without the "| #"
        # table marker, so the chat channel was empty for every real request.
        for line in (
            "request received id=r1 path=/v1/chat/completions keys=model messages=1",
            "request body received id=r1 endpoint=chat bytes=63",
            "request binding id=r1 account=a1 billing=a1 session=s1",
            "dispatch start model=glm-5.3 stream=False messages=1",
            "dispatch route id=r1 mode=remote candidates=remote",
            "remote create start id=r1 account=a1 model=glm-5.3",
            "public stream closed id=r1 status=200 chunks=4 done=True",
            "auto route id=r1 model_request=glm-5.3 endpoint=remote",
        ):
            with self.subTest(line=line):
                self.assertEqual(logbuf.classify_line(line), logbuf.CHAT)

    def test_startup_notices_stay_system(self):
        for line in (
            "Trae CN relay initialized (auth source=web-login edition=cn)",
            "web login listener ready on http://127.0.0.1:8765",
        ):
            with self.subTest(line=line):
                self.assertEqual(logbuf.classify_line(line), logbuf.SYS)

    def test_chat_prefix_wins_over_task_prefix(self):
        # A table row must not be stolen by a task prefix it happens to contain.
        self.assertEqual(logbuf.classify_line("| #7 | checkin |"), logbuf.CHAT)


class LogRingTests(unittest.TestCase):
    def test_entries_keep_insertion_order(self):
        ring = logbuf.LogRing(capacity=10)
        ring.write("first")
        ring.write("second")
        self.assertEqual([e.text for e in ring.snapshot()], ["first", "second"])

    def test_capacity_evicts_oldest_first(self):
        ring = logbuf.LogRing(capacity=3)
        for i in range(5):
            ring.write(f"line-{i}")
        self.assertEqual(
            [e.text for e in ring.snapshot()], ["line-2", "line-3", "line-4"]
        )

    def test_timestamp_prefix_is_stripped(self):
        ring = logbuf.LogRing(capacity=5)
        ring.write("2026/10/09 08:30:00 hello")
        self.assertEqual(ring.snapshot()[0].text, "hello")

    def test_blank_lines_are_dropped(self):
        ring = logbuf.LogRing(capacity=5)
        ring.write("")
        ring.write("   \n")
        self.assertEqual(ring.snapshot(), [])

    def test_snapshot_is_a_copy_the_caller_can_hold(self):
        ring = logbuf.LogRing(capacity=5)
        ring.write("one")
        snap = ring.snapshot()
        ring.write("two")
        self.assertEqual(len(snap), 1)

    def test_clear_empties_the_ring(self):
        ring = logbuf.LogRing(capacity=5)
        ring.write("one")
        ring.clear()
        self.assertEqual(ring.snapshot(), [])

    def test_concurrent_writes_stay_bounded(self):
        # Review Focus 3: log floods must never grow the buffer without bound.
        ring = logbuf.LogRing(capacity=100)

        def burst(tag):
            for i in range(250):
                ring.write(f"{tag}-{i}")

        threads = [threading.Thread(target=burst, args=(f"t{n}",)) for n in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(len(ring.snapshot()), 100)


class RingLogHandlerTests(unittest.TestCase):
    def test_handler_routes_logger_records_into_the_ring(self):
        ring = logbuf.LogRing(capacity=20)
        logger = logging.getLogger("trae-free-test-handler")
        logger.handlers = []
        logger.propagate = False
        logger.setLevel(logging.INFO)
        handler = logbuf.RingLogHandler(ring)
        handler.setFormatter(logging.Formatter("%(message)s"))
        logger.addHandler(handler)
        try:
            logger.info("checkin uid=abc")
        finally:
            logger.removeHandler(handler)

        snapshot = ring.snapshot()
        self.assertEqual(len(snapshot), 1)
        self.assertEqual(snapshot[0].ch, logbuf.TASK)

    def test_install_ring_handler_is_idempotent(self):
        logger = logging.getLogger("trae-free-test-install")
        logger.handlers = []
        logger.propagate = False
        try:
            first = logbuf.install_ring_handler(logger, capacity=10)
            second = logbuf.install_ring_handler(logger, capacity=10)
            self.assertIs(first, second)
            self.assertEqual(len(logger.handlers), 1)
        finally:
            for h in list(logger.handlers):
                logger.removeHandler(h)


if __name__ == "__main__":
    unittest.main()
