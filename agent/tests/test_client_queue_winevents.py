"""
Unit tests for pure functions in client.py, queue.py, and winevents.py.

All tests run on any platform — no Windows, no network required.
"""

import json
import time
import tempfile
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from voltwatch_agent.client import build_payload, check_clock_drift
from voltwatch_agent.queue import ReadingQueue, next_backoff, INITIAL_BACKOFF_SEC, BATCH_SIZE
from voltwatch_agent.winevents import (
    detect_sleep_resume,
    is_unexpected_shutdown,
    parse_shutdown_timestamp,
)


# ── build_payload ──────────────────────────────────────────────────────────────

class TestBuildPayload:
    def _base(self, **kw):
        defaults = dict(
            percent=75.0,
            charging=False,
            ac_connected=False,
            secs_left=4500,
            mt5_running=True,
            uptime_sec=3600,
            internet_latency_ms=80,
            agent_version="1.0.0",
            hostname="TEST-PC",
        )
        defaults.update(kw)
        return build_payload(**defaults)

    def test_required_fields_present(self):
        p = self._base()
        for field in ["readingId", "deviceTime", "kind", "event", "percent",
                      "charging", "acConnected", "secsLeft", "mt5Running",
                      "uptimeSec", "internetLatencyMs", "agentVersion", "hostname", "meta"]:
            assert field in p, f"Missing field: {field}"

    def test_defaults(self):
        p = self._base()
        assert p["kind"] == "heartbeat"
        assert p["event"] is None
        assert p["meta"] == {}

    def test_event_kind(self):
        p = self._base(kind="event", event="ac_disconnected")
        assert p["kind"] == "event"
        assert p["event"] == "ac_disconnected"

    def test_percent_rounded(self):
        p = self._base(percent=73.678)
        assert p["percent"] == 73.7

    def test_custom_reading_id(self):
        custom_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        p = self._base(reading_id=custom_id)
        assert p["readingId"] == custom_id

    def test_auto_reading_id_is_uuid_format(self):
        p = self._base()
        parts = p["readingId"].split("-")
        assert len(parts) == 5

    def test_secs_left_null(self):
        p = self._base(secs_left=None)
        assert p["secsLeft"] is None

    def test_meta_passed_through(self):
        p = self._base(meta={"gapSec": 300})
        assert p["meta"]["gapSec"] == 300


# ── check_clock_drift ──────────────────────────────────────────────────────────

class TestCheckClockDrift:
    def test_no_drift(self):
        now_iso = datetime.now(tz=timezone.utc).isoformat()
        drift = check_clock_drift(now_iso)
        assert abs(drift) < 5  # allow 5s tolerance

    def test_server_ahead(self):
        future = (datetime.now(tz=timezone.utc) + timedelta(seconds=300)).isoformat()
        drift = check_clock_drift(future)
        assert drift > 290  # server is 5 minutes ahead

    def test_server_behind(self):
        past = (datetime.now(tz=timezone.utc) - timedelta(seconds=300)).isoformat()
        drift = check_clock_drift(past)
        assert drift < -290

    def test_invalid_timestamp_returns_zero(self):
        assert check_clock_drift("not-a-timestamp") == 0

    def test_z_suffix_accepted(self):
        now_z = datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        drift = check_clock_drift(now_z)
        assert abs(drift) < 5


# ── ReadingQueue ───────────────────────────────────────────────────────────────

@pytest.fixture
def tmp_queue(tmp_path):
    """Create a fresh queue in a temp directory."""
    return ReadingQueue(path=tmp_path / "queue.db")


def _make_reading(reading_id: str, device_time: str = None) -> dict:
    return {
        "readingId": reading_id,
        "deviceTime": device_time or datetime.now(tz=timezone.utc).isoformat(),
        "kind": "heartbeat",
        "event": None,
        "percent": 80,
        "charging": True,
        "acConnected": True,
        "secsLeft": None,
        "mt5Running": True,
        "uptimeSec": 3600,
        "internetLatencyMs": 100,
        "agentVersion": "1.0.0-test",
        "hostname": "TEST",
        "meta": {},
    }


class TestReadingQueue:
    def test_enqueue_and_size(self, tmp_queue):
        assert tmp_queue.size() == 0
        tmp_queue.enqueue(_make_reading("id-1"))
        assert tmp_queue.size() == 1

    def test_duplicate_ignored(self, tmp_queue):
        r = _make_reading("id-dup")
        tmp_queue.enqueue(r)
        tmp_queue.enqueue(r)
        assert tmp_queue.size() == 1

    def test_peek_batch_order(self, tmp_queue):
        """Oldest device_time should come first."""
        # Use recent timestamps so they survive the 7-day prune
        base = datetime.now(tz=timezone.utc) - timedelta(minutes=10)
        for i in range(5):
            t = (base + timedelta(minutes=i)).isoformat()
            tmp_queue.enqueue(_make_reading(f"id-{i}", device_time=t))

        batch = tmp_queue.peek_batch()
        assert len(batch) == 5
        assert batch[0]["readingId"] == "id-0"
        assert batch[-1]["readingId"] == "id-4"

    def test_peek_does_not_remove(self, tmp_queue):
        tmp_queue.enqueue(_make_reading("id-x"))
        tmp_queue.peek_batch()
        assert tmp_queue.size() == 1

    def test_dequeue_ids(self, tmp_queue):
        for i in range(3):
            tmp_queue.enqueue(_make_reading(f"id-{i}"))
        tmp_queue.dequeue_ids(["id-0", "id-2"])
        assert tmp_queue.size() == 1
        remaining = tmp_queue.peek_batch()
        assert remaining[0]["readingId"] == "id-1"

    def test_clear(self, tmp_queue):
        for i in range(5):
            tmp_queue.enqueue(_make_reading(f"id-{i}"))
        tmp_queue.clear()
        assert tmp_queue.size() == 0

    def test_batch_size_limit(self, tmp_queue):
        """peek_batch returns at most BATCH_SIZE readings."""
        # Use recent timestamps so rows survive the 7-day prune
        base = datetime.now(tz=timezone.utc) - timedelta(hours=1)
        for i in range(BATCH_SIZE + 10):
            t = (base + timedelta(seconds=i)).isoformat()
            tmp_queue.enqueue(_make_reading(f"id-{i}", device_time=t))
        batch = tmp_queue.peek_batch()
        assert len(batch) == BATCH_SIZE

    def test_missing_reading_id_not_enqueued(self, tmp_queue):
        tmp_queue.enqueue({"deviceTime": datetime.now(tz=timezone.utc).isoformat()})
        assert tmp_queue.size() == 0


# ── next_backoff ───────────────────────────────────────────────────────────────

class TestNextBackoff:
    def test_doubles(self):
        b = next_backoff(5.0, max_secs=300.0, jitter=0.0)
        assert b == 10.0

    def test_caps_at_max(self):
        b = next_backoff(200.0, max_secs=300.0, jitter=0.0)
        assert b == 300.0

    def test_does_not_exceed_max_with_jitter(self):
        for _ in range(100):
            b = next_backoff(200.0, max_secs=300.0, jitter=0.25)
            assert b <= 300.0 * 1.25 + 1  # generous bound

    def test_initial_value(self):
        assert INITIAL_BACKOFF_SEC == 5.0


# ── winevents — pure functions ─────────────────────────────────────────────────

class TestDetectSleepResume:
    def test_no_sleep(self):
        """Small gap = normal sampling, no sleep detected."""
        prev_mono = time.monotonic() - 5.1
        prev_wall = time.time() - 5.1
        result = detect_sleep_resume(prev_mono, prev_wall, sample_interval_sec=5.0)
        assert result is None

    def test_sleep_detected(self):
        """Wall clock jumped 5 minutes; monotonic only advanced 5 seconds."""
        prev_mono = time.monotonic() - 5
        prev_wall = time.time() - 305  # 5 minutes on the wall
        result = detect_sleep_resume(prev_mono, prev_wall, sample_interval_sec=5.0)
        assert result is not None
        assert result > 200  # gap should be roughly 300s

    def test_threshold_respected(self):
        """Gap of 2× interval should not trigger (threshold = 3×)."""
        prev_mono = time.monotonic() - 5
        prev_wall = time.time() - 15  # ~2× interval wall jump (mono=5s)
        # Wall gap ≈ 15s, mono gap ≈ 5s, extra ≈ 10s < 3×5=15s
        result = detect_sleep_resume(prev_mono, prev_wall, sample_interval_sec=5.0,
                                     threshold_multiplier=3.0)
        assert result is None


class TestIsUnexpectedShutdown:
    def _dt(self, **kw) -> datetime:
        return datetime.now(tz=timezone.utc) + timedelta(**kw)

    def test_event_after_last_run(self):
        last_run = self._dt(hours=-2)
        event    = self._dt(hours=-1)
        assert is_unexpected_shutdown(event, last_run) is True

    def test_event_before_last_run(self):
        last_run = self._dt(hours=-1)
        event    = self._dt(hours=-2)
        assert is_unexpected_shutdown(event, last_run) is False

    def test_none_event(self):
        assert is_unexpected_shutdown(None, self._dt()) is False

    def test_none_last_run(self):
        assert is_unexpected_shutdown(self._dt(), None) is False

    def test_both_none(self):
        assert is_unexpected_shutdown(None, None) is False


class TestParseShutdownTimestamp:
    def test_valid_iso(self):
        iso = "2026-10-17T12:00:00+00:00"
        dt  = parse_shutdown_timestamp(iso)
        assert dt is not None
        assert dt.tzinfo is not None

    def test_z_suffix(self):
        dt = parse_shutdown_timestamp("2026-10-17T12:00:00Z")
        assert dt is not None

    def test_none_input(self):
        assert parse_shutdown_timestamp(None) is None

    def test_invalid_string(self):
        assert parse_shutdown_timestamp("not-a-date") is None
