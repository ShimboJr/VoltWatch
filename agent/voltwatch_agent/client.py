"""
HTTP client for the VoltWatch backend agent API.

Handles:
  - Single heartbeat POST with latency measurement
  - Batch POST for offline queue flush
  - Server-clock drift warning (> 2 minutes)
  - Returns structured result objects; never raises on network errors
"""

from __future__ import annotations

import logging
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import urllib.request
import urllib.error
import json

log = logging.getLogger(__name__)

CLOCK_DRIFT_WARN_SEC = 120  # 2 minutes


# ── Result types ───────────────────────────────────────────────────────────────

@dataclass
class HeartbeatResult:
    ok: bool
    duplicate: bool = False
    latency_ms: int | None = None
    config: dict[str, Any] = field(default_factory=dict)
    error: str | None = None


@dataclass
class BatchResult:
    ok: bool
    processed: int = 0
    duplicates: int = 0
    errors: int = 0
    error: str | None = None


# ── Pure payload builder ───────────────────────────────────────────────────────

def build_payload(
    *,
    reading_id: str | None = None,
    device_time: str | None = None,
    kind: str = "heartbeat",
    event: str | None = None,
    percent: float,
    charging: bool,
    ac_connected: bool,
    secs_left: int | None,
    mt5_running: bool,
    uptime_sec: int,
    internet_latency_ms: int | None,
    agent_version: str,
    hostname: str,
    meta: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    Build a reading payload dict matching the backend schema exactly.

    All arguments are keyword-only to prevent positional mistakes.
    This is a pure function — fully testable without network or OS.
    """
    return {
        "readingId": reading_id or str(uuid.uuid4()),
        "deviceTime": device_time or datetime.now(tz=timezone.utc).isoformat(),
        "kind": kind,
        "event": event,
        "percent": round(percent, 1),
        "charging": charging,
        "acConnected": ac_connected,
        "secsLeft": secs_left,
        "mt5Running": mt5_running,
        "uptimeSec": uptime_sec,
        "internetLatencyMs": internet_latency_ms,
        "agentVersion": agent_version,
        "hostname": hostname,
        "meta": meta or {},
    }


# ── Clock-drift check ──────────────────────────────────────────────────────────

def check_clock_drift(server_time_iso: str) -> int:
    """
    Return offset in seconds (server - local). Log a warning if abs > threshold.

    Args:
        server_time_iso: ISO-8601 UTC string from server response.

    Returns:
        Drift in seconds (positive = server ahead).
    """
    try:
        server_dt = datetime.fromisoformat(server_time_iso.replace("Z", "+00:00"))
        local_dt = datetime.now(tz=timezone.utc)
        drift_sec = int((server_dt - local_dt).total_seconds())
        if abs(drift_sec) > CLOCK_DRIFT_WARN_SEC:
            log.warning(
                "Clock drift detected: local is %d seconds %s server time",
                abs(drift_sec),
                "behind" if drift_sec > 0 else "ahead of",
            )
        return drift_sec
    except Exception as exc:
        log.debug("Could not parse server time for drift check: %s", exc)
        return 0


# ── HTTP helpers ───────────────────────────────────────────────────────────────

def _post_json(url: str, token: str, body: dict) -> tuple[int, dict]:
    """
    POST JSON to url with Bearer token auth.

    Returns (status_code, response_dict).
    Raises urllib.error.URLError on network errors.
    """
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        raw = resp.read()
        return resp.status, json.loads(raw) if raw else {}


# ── Public client ──────────────────────────────────────────────────────────────

class AgentClient:
    """Stateless HTTP client for VoltWatch agent endpoints."""

    def __init__(self, api_url: str, token: str, agent_version: str, hostname: str) -> None:
        self.api_url = api_url.rstrip("/")
        self.token = token
        self.agent_version = agent_version
        self.hostname = hostname
        self._last_latency_ms: int | None = None

    @property
    def last_latency_ms(self) -> int | None:
        """Latency of the most recent successful request."""
        return self._last_latency_ms

    def send_heartbeat(self, payload: dict[str, Any]) -> HeartbeatResult:
        """
        POST a single reading to /agent/heartbeat.

        Never raises; errors are captured in HeartbeatResult.error.
        """
        url = f"{self.api_url}/agent/heartbeat"
        t0 = time.monotonic()
        try:
            status, data = _post_json(url, self.token, payload)
            latency_ms = int((time.monotonic() - t0) * 1000)
            self._last_latency_ms = latency_ms

            if data.get("duplicate"):
                return HeartbeatResult(ok=True, duplicate=True, latency_ms=latency_ms)

            server_time = data.get("serverTime")
            if server_time:
                check_clock_drift(server_time)

            return HeartbeatResult(
                ok=True,
                latency_ms=latency_ms,
                config=data.get("config", {}),
            )
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            log.warning("Heartbeat HTTP %d: %s", exc.code, body[:200])
            return HeartbeatResult(ok=False, error=f"HTTP {exc.code}: {body[:200]}")
        except Exception as exc:
            log.warning("Heartbeat failed: %s", exc)
            return HeartbeatResult(ok=False, error=str(exc))

    def send_batch(self, readings: list[dict[str, Any]]) -> BatchResult:
        """
        POST a batch of readings to /agent/batch.

        Never raises; errors are captured in BatchResult.error.
        """
        if not readings:
            return BatchResult(ok=True)

        url = f"{self.api_url}/agent/batch"
        try:
            t0 = time.monotonic()
            status, data = _post_json(url, self.token, {"readings": readings})
            self._last_latency_ms = int((time.monotonic() - t0) * 1000)
            return BatchResult(
                ok=True,
                processed=data.get("processed", 0),
                duplicates=data.get("duplicates", 0),
                errors=data.get("errors", 0),
            )
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            log.warning("Batch HTTP %d: %s", exc.code, body[:200])
            return BatchResult(ok=False, error=f"HTTP {exc.code}")
        except Exception as exc:
            log.warning("Batch failed: %s", exc)
            return BatchResult(ok=False, error=str(exc))

    def check_connectivity(self) -> bool:
        """Return True if /health endpoint is reachable."""
        try:
            url = f"{self.api_url}/health"
            req = urllib.request.Request(url, method="GET")
            with urllib.request.urlopen(req, timeout=8) as resp:
                return resp.status == 200
        except Exception:
            return False
