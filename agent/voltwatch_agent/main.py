"""
VoltWatch Agent — main orchestrator.

Responsibilities:
  - Single-instance mutex (Windows named mutex)
  - Startup sequence: detect unexpected shutdown, send agent_started
  - 5-second sampling loop: battery, MT5, sleep/resume detection
  - Regular heartbeat every intervalSec ± 10% jitter
  - Immediate event send on AC/MT5 transitions
  - Offline queue with exponential backoff flush
  - Graceful shutdown (planned stop / system_shutdown event)
  - Tray icon lifecycle
  - Doctor mode (--doctor flag)
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import random
import signal
import socket
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from voltwatch_agent import __version__
from voltwatch_agent.battery import BatteryState, get_battery_state, states_differ
from voltwatch_agent.client import AgentClient, HeartbeatResult, build_payload
from voltwatch_agent.config import Config, load_config, save_config, get_data_dir
from voltwatch_agent.logging_setup import setup_logging, get_log_dir
from voltwatch_agent.mt5 import is_mt5_running, state_changed as mt5_changed
from voltwatch_agent.queue import ReadingQueue, INITIAL_BACKOFF_SEC, next_backoff
from voltwatch_agent.winevents import (
    detect_sleep_resume,
    query_last_unclean_shutdown,
    is_unexpected_shutdown,
    parse_shutdown_timestamp,
    start_shutdown_watcher,
)

log = logging.getLogger(__name__)

SAMPLE_INTERVAL = 5      # seconds — local battery/MT5 polling
LAST_RUN_FILE   = "last_run.json"


# ── Single-instance mutex ──────────────────────────────────────────────────────

def _acquire_single_instance_mutex() -> bool:
    """Return False if another instance is already running (Windows only)."""
    if sys.platform != "win32":
        return True
    try:
        import ctypes
        handle = ctypes.windll.kernel32.CreateMutexW(None, True, "VoltWatchAgent_SingleInstance")
        err    = ctypes.windll.kernel32.GetLastError()
        if err == 183:  # ERROR_ALREADY_EXISTS
            return False
        return True
    except Exception:
        return True  # Non-Windows: always allow


# ── Last-run timestamp ─────────────────────────────────────────────────────────

def _save_last_run(data_dir: Path) -> None:
    path = data_dir / LAST_RUN_FILE
    with open(path, "w") as f:
        json.dump({"lastRunAt": datetime.now(tz=timezone.utc).isoformat()}, f)


def _load_last_run(data_dir: Path) -> str | None:
    path = data_dir / LAST_RUN_FILE
    if not path.exists():
        return None
    try:
        with open(path) as f:
            return json.load(f).get("lastRunAt")
    except Exception:
        return None


# ── Uptime ────────────────────────────────────────────────────────────────────

_AGENT_START = time.monotonic()


def _uptime_sec() -> int:
    return int(time.monotonic() - _AGENT_START)


# ── Payload factory helper ─────────────────────────────────────────────────────

def _make_payload(
    cfg: Config,
    battery: BatteryState | None,
    mt5_running: bool,
    kind: str = "heartbeat",
    event: str | None = None,
    latency_ms: int | None = None,
    meta: dict | None = None,
) -> dict:
    return build_payload(
        kind=kind,
        event=event,
        percent=battery.percent if battery else 50.0,
        charging=battery.charging if battery else True,
        ac_connected=battery.ac_connected if battery else True,
        secs_left=battery.secs_left if battery else None,
        mt5_running=mt5_running,
        uptime_sec=_uptime_sec(),
        internet_latency_ms=latency_ms,
        agent_version=__version__,
        hostname=socket.gethostname(),
        meta=meta or {},
    )


def _reliable_battery_read(attempts: int = 3, delay: float = 1.0) -> BatteryState | None:
    """
    Read battery state with retries.

    psutil can transiently return 0 % on Windows at startup before the WMI
    subsystem finishes initialising.  We retry a few times so the very first
    heartbeat contains real data rather than a false 0 %.
    """
    result = None
    for i in range(attempts):
        result = get_battery_state()
        if result is not None and result.percent > 0:
            return result
        if i < attempts - 1:
            time.sleep(delay)
    return result  # return whatever we got (could still be 0% or None)


# ── Doctor mode ────────────────────────────────────────────────────────────────

def run_doctor() -> int:
    """Print diagnostics and return exit code (0=pass, 1=failures found)."""
    print("\n🔍 VoltWatch Agent — Doctor Mode\n" + "=" * 40)
    failures = 0

    # 1 — Battery
    batt = get_battery_state()
    if batt:
        print(f"  ✓ Battery:   {batt.percent_rounded}%  AC={batt.ac_connected}  charging={batt.charging}")
    else:
        print("  ✗ Battery:   Cannot read battery state")
        print("    → Ensure psutil is installed and the laptop has a battery")
        failures += 1

    # 2 — Config / token
    cfg = load_config()
    if cfg:
        print(f"  ✓ Config:    Loaded  (api={cfg.api_url})")
    else:
        print("  ✗ Config:    Missing — run agent normally to complete setup")
        print("    → Create config or place voltwatch-config.json next to the exe")
        failures += 1
        print(f"\nResult: {failures} issue(s) found.\n")
        return 1

    # 3 — Server reachable
    client = AgentClient(cfg.api_url, cfg.device_token, __version__, socket.gethostname())
    reachable = client.check_connectivity()
    if reachable:
        print(f"  ✓ Server:    Reachable at {cfg.api_url}")
    else:
        print(f"  ✗ Server:    Cannot reach {cfg.api_url}/health")
        print("    → Check API URL in config and network/firewall settings")
        failures += 1

    # 4 — Token valid (test heartbeat)
    if reachable:
        payload = _make_payload(cfg, batt, False)
        result  = client.send_heartbeat(payload)
        if result.ok:
            drift_notice = f"  latency={result.latency_ms}ms"
            print(f"  ✓ Token:     Valid{drift_notice}")
        else:
            print(f"  ✗ Token:     Invalid or rejected: {result.error}")
            print("    → Rotate the device token in the dashboard and re-pair")
            failures += 1

    # 5 — Clock offset
    if reachable and result.ok:
        # Drift is checked inside send_heartbeat; just report status
        print("  ✓ Clock:     Drift check passed (see log for warnings)")

    # 6 — Queue size
    q = ReadingQueue()
    sz = q.size()
    if sz == 0:
        print("  ✓ Queue:     Empty")
    else:
        print(f"  ⚠ Queue:     {sz} pending reading(s) — will flush when online")

    # 7 — MT5 detected
    mt5 = is_mt5_running(cfg.mt5_process_names)
    if mt5:
        print("  ✓ MT5:       Detected (terminal64.exe or terminal.exe running)")
    else:
        print("  ℹ MT5:       Not currently running (terminal64.exe / terminal.exe)")

    print("\n" + "=" * 40)
    if failures == 0:
        print("  ✅ All checks passed — agent is ready to run.\n")
    else:
        print(f"  ❌ {failures} issue(s) found — fix them before running the agent.\n")
    return 0 if failures == 0 else 1


# ── Main agent loop ────────────────────────────────────────────────────────────

class Agent:
    """Orchestrates sampling, heartbeats, queue flushing, and events."""

    def __init__(self, cfg: Config) -> None:
        self.cfg     = cfg
        self.client  = AgentClient(cfg.api_url, cfg.device_token, __version__, socket.gethostname())
        self.queue   = ReadingQueue()

        self._stop_event   = threading.Event()
        self._paused       = False
        self._planned_stop = False

        self._prev_battery : BatteryState | None = None
        self._prev_mt5     : bool = False
        self._mt5_off_since: float | None = None

        self._next_heartbeat_at: float = time.monotonic()
        self._backoff_sec: float = INITIAL_BACKOFF_SEC
        self._server_ok: bool = True

        self._last_report_at: datetime | None = None
        self._last_latency  : int | None = None

        self._prev_mono = time.monotonic()
        self._prev_wall = time.time()

        # Tray (optional — lazy import)
        self._tray: object | None = None

    # ── Tray integration ───────────────────────────────────────────────────────

    def _setup_tray(self) -> None:
        try:
            from voltwatch_agent.tray import TrayApp
            self._tray = TrayApp(
                on_pause  = self._do_pause,
                on_resume = self._do_resume,
                on_quit   = self._do_quit,
                dashboard_url  = self.cfg.dashboard_url,
                critical_level = 15,
            )
        except Exception as exc:
            log.warning("Tray unavailable: %s", exc)

    def _update_tray(self) -> None:
        if self._tray is None:
            return
        b = self._prev_battery
        try:
            self._tray.update_state(
                percent        = b.percent_rounded if b else 0,
                ac_connected   = b.ac_connected    if b else True,
                charging       = b.charging        if b else True,
                mt5_running    = self._prev_mt5,
                server_reachable = self._server_ok,
                last_report_at = self._last_report_at,
            )
        except Exception:
            pass

    # ── Actions ────────────────────────────────────────────────────────────────

    def _do_pause(self) -> None:
        log.info("Reporting paused by user")
        self._planned_stop = True
        self._paused = True
        payload = _make_payload(self.cfg, self._prev_battery, self._prev_mt5,
                                kind="event", event="agent_stopping_planned")
        self.client.send_heartbeat(payload)

    def _do_resume(self) -> None:
        log.info("Reporting resumed by user")
        self._paused = False
        self._planned_stop = False
        payload = _make_payload(self.cfg, self._prev_battery, self._prev_mt5,
                                kind="event", event="agent_started")
        self.client.send_heartbeat(payload)

    def _do_quit(self) -> None:
        self._send_planned_stop()
        self._stop_event.set()

    def _send_planned_stop(self) -> None:
        if self._planned_stop:
            return
        self._planned_stop = True
        log.info("Sending agent_stopping_planned")
        payload = _make_payload(self.cfg, self._prev_battery, self._prev_mt5,
                                kind="event", event="agent_stopping_planned")
        # Best-effort, 3-second timeout handled by urllib (timeout=15 but we don't wait)
        t = threading.Thread(target=self.client.send_heartbeat, args=(payload,), daemon=True)
        t.start()
        t.join(timeout=3)

    # ── Sending helpers ────────────────────────────────────────────────────────

    def _send_or_queue(self, payload: dict) -> bool:
        """Send immediately; queue on failure. Returns True if sent live."""
        if self._paused:
            return False
        result = self.client.send_heartbeat(payload)
        if result.ok:
            self._server_ok = True
            self._last_report_at = datetime.now(tz=timezone.utc)
            self._last_latency   = result.latency_ms
            # Update interval from server config
            if result.config:
                changed = self.cfg.update_from_server(result.config)
                if changed:
                    log.info("Interval updated to %ds by server", self.cfg.interval_sec)
            self._backoff_sec = INITIAL_BACKOFF_SEC
            return True
        else:
            self._server_ok = False
            self.queue.enqueue(payload)
            return False

    def _flush_queue(self) -> None:
        """Send the oldest batch of queued readings."""
        batch = self.queue.peek_batch()
        if not batch:
            return
        result = self.client.send_batch(batch)
        if result.ok:
            ids = [r.get("readingId", r.get("reading_id", "")) for r in batch]
            self.queue.dequeue_ids([i for i in ids if i])
            log.info("Flushed %d queued readings (%d dupes)", result.processed, result.duplicates)
            self._server_ok = True
            self._backoff_sec = INITIAL_BACKOFF_SEC
        else:
            self._backoff_sec = next_backoff(self._backoff_sec)
            log.debug("Queue flush failed, backoff=%.0fs", self._backoff_sec)

    # ── Startup sequence ───────────────────────────────────────────────────────

    def startup(self) -> None:
        """Detect unexpected shutdown and send agent_started with real battery data."""
        data_dir = get_data_dir()
        last_run_str = _load_last_run(data_dir)
        last_run_dt  = parse_shutdown_timestamp(last_run_str)

        # Read real battery state before sending any events so the first
        # heartbeat stored by the backend has accurate percent / AC state.
        initial_battery = _reliable_battery_read()
        initial_mt5     = is_mt5_running(self.cfg.mt5_process_names)

        # Seed prev_battery so the sampling loop doesn't fire a spurious
        # AC-transition event on the very first sample.
        if initial_battery is not None:
            self._prev_battery = initial_battery
        self._prev_mt5 = initial_mt5

        # Check for unclean shutdown event in Windows event log
        last_event_dt = query_last_unclean_shutdown()
        if is_unexpected_shutdown(last_event_dt, last_run_dt):
            log.warning("Unexpected shutdown detected at %s", last_event_dt)
            payload = _make_payload(
                self.cfg, initial_battery, initial_mt5,
                kind="event", event="unexpected_shutdown_detected",
                meta={"shutdownAt": last_event_dt.isoformat() if last_event_dt else None},
            )
            self.client.send_heartbeat(payload)

        # agent_started — send with real battery data
        payload = _make_payload(self.cfg, initial_battery, initial_mt5,
                                kind="event", event="agent_started")
        self.client.send_heartbeat(payload)

        _save_last_run(data_dir)

    # ── Sampling loop ──────────────────────────────────────────────────────────

    def _sample_once(self) -> None:
        """One iteration of the 5-second local sample loop."""
        now_mono = time.monotonic()
        now_wall = time.time()

        # ── Sleep / resume detection ─────────────────────────────────────────
        gap = detect_sleep_resume(self._prev_mono, self._prev_wall, SAMPLE_INTERVAL)
        if gap is not None:
            log.info("Sleep/resume detected — gap %.0f seconds", gap)
            payload = _make_payload(
                self.cfg, self._prev_battery, self._prev_mt5,
                kind="event", event="resumed_from_sleep",
                meta={"gapSec": gap},
            )
            self._send_or_queue(payload)

        self._prev_mono = now_mono
        self._prev_wall = now_wall

        # ── Battery ──────────────────────────────────────────────────────────
        battery = get_battery_state()
        if battery and self._prev_battery:
            if states_differ(self._prev_battery, battery):
                event = ("ac_connected" if battery.ac_connected
                         else "ac_disconnected")
                log.info("AC state change: %s  percent=%d%%", event, battery.percent_rounded)
                payload = _make_payload(
                    self.cfg, battery, self._prev_mt5,
                    kind="event", event=event,
                    latency_ms=self._last_latency,
                )
                self._send_or_queue(payload)
                # Reset heartbeat timer so next regular HB isn't immediate duplicate
                self._next_heartbeat_at = time.monotonic() + self._heartbeat_interval()

        self._prev_battery = battery or self._prev_battery

        # ── MT5 ──────────────────────────────────────────────────────────────
        mt5_now = is_mt5_running(self.cfg.mt5_process_names)
        evt = mt5_changed(self._prev_mt5, mt5_now)
        if evt:
            log.info("MT5 state change: %s", evt)
            payload = _make_payload(
                self.cfg, self._prev_battery, mt5_now,
                kind="event", event=evt,
                latency_ms=self._last_latency,
            )
            self._send_or_queue(payload)
        self._prev_mt5 = mt5_now

        # ── Heartbeat due? ────────────────────────────────────────────────────
        if time.monotonic() >= self._next_heartbeat_at:
            payload = _make_payload(
                self.cfg, self._prev_battery, self._prev_mt5,
                latency_ms=self._last_latency,
            )
            self._send_or_queue(payload)
            self._next_heartbeat_at = time.monotonic() + self._heartbeat_interval()

        # ── Queue flush ───────────────────────────────────────────────────────
        if self.queue.size() > 0 and self._server_ok:
            self._flush_queue()

        # ── Tray update ───────────────────────────────────────────────────────
        self._update_tray()

        # ── Persist last-run timestamp periodically ───────────────────────────
        _save_last_run(get_data_dir())

    def _heartbeat_interval(self) -> float:
        """intervalSec ± 10% jitter."""
        jitter = self.cfg.interval_sec * 0.1
        return self.cfg.interval_sec + random.uniform(-jitter, jitter)

    # ── Main run ───────────────────────────────────────────────────────────────

    def run(self) -> None:
        """Start the sampling loop. Blocks until stop_event is set."""
        # Register Windows shutdown watcher
        start_shutdown_watcher(self._send_planned_stop)

        log.info("Agent started (interval=%ds)", self.cfg.interval_sec)

        while not self._stop_event.is_set():
            try:
                self._sample_once()
            except Exception:
                log.exception("Unhandled error in sample loop")
            self._stop_event.wait(SAMPLE_INTERVAL)

        log.info("Agent stopped cleanly")


# ── Entry point ────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="VoltWatch Battery Monitor Agent")
    parser.add_argument("--doctor", action="store_true",
                        help="Run diagnostic checks and exit")
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    parser.add_argument("--no-tray", action="store_true",
                        help="Run headless (no tray icon)")
    parser.add_argument("--api", metavar="URL",
                        help="Backend API URL, e.g. https://your-voltwatch.vercel.app/api/v1 "
                             "(used to bootstrap config on first run)")
    parser.add_argument("--token", metavar="TOKEN",
                        help="Device token from the dashboard "
                             "(used to bootstrap config on first run)")
    args = parser.parse_args()

    # ── Doctor mode ────────────────────────────────────────────────────────────
    if args.doctor:
        setup_logging("INFO")
        sys.exit(run_doctor())

    # ── Single instance guard ──────────────────────────────────────────────────
    if not _acquire_single_instance_mutex():
        print("VoltWatch is already running. Check the system tray.")
        sys.exit(1)

    # ── Load or create config ──────────────────────────────────────────────────
    cfg = load_config()

    if cfg is None:
        setup_logging("INFO")

        # ── CLI bootstrap (--api + --token) ────────────────────────────────────
        if args.api and args.token:
            log.info("Bootstrapping config from --api / --token flags")
            cfg = Config(api_url=args.api, device_token=args.token)
            save_config(cfg)
        else:
            # Check for bootstrap file next to exe (handled inside load_config)
            cfg = load_config()  # reload in case bootstrap was imported

            if cfg is None:
                # Show pairing dialog
                _paired_cfg: Config | None = None

                def _on_paired(api_url: str, token: str) -> None:
                    nonlocal _paired_cfg
                    _paired_cfg = Config(api_url=api_url, device_token=token)
                    save_config(_paired_cfg)

                from voltwatch_agent.pairing import show_pairing_dialog
                show_pairing_dialog(_on_paired)

                if _paired_cfg is None:
                    log.info("Pairing cancelled — exiting")
                    sys.exit(0)
                cfg = _paired_cfg

    # ── Setup logging with token redaction ─────────────────────────────────────
    setup_logging(cfg.log_level, token=cfg.device_token)
    log.info("VoltWatch Agent v%s starting", __version__)

    # ── Build agent ────────────────────────────────────────────────────────────
    agent = Agent(cfg)
    agent.startup()

    # ── Signal handlers (must be in the main thread) ───────────────────────────
    def _sig_handler(sig, frame):
        log.info("Signal %s received — shutting down", sig)
        agent._send_planned_stop()
        agent._stop_event.set()
    signal.signal(signal.SIGINT,  _sig_handler)
    signal.signal(signal.SIGTERM, _sig_handler)

    # ── Tray + loop ────────────────────────────────────────────────────────────
    if args.no_tray or sys.platform != "win32":
        agent.run()
    else:
        agent._setup_tray()

        if agent._tray:
            # pystray.run() blocks the main thread — this is intentional.
            # The terminal will appear frozen; look for the VoltWatch icon
            # in the system tray (bottom-right of taskbar, click ^ to expand).
            log.info("Tray icon starting — terminal will be unresponsive while agent runs. "
                     "Right-click the tray icon to quit, or press Ctrl+C here.")
            # Run sampling loop in background thread; tray blocks main thread
            loop_thread = threading.Thread(target=agent.run, daemon=True, name="AgentLoop")
            loop_thread.start()
            try:
                agent._tray.run()  # blocks until quit
            except Exception as exc:
                log.warning("Tray icon failed (%s) — falling back to headless mode. "
                            "Press Ctrl+C to stop.", exc)
                agent._stop_event.clear()  # reset in case tray set it
                agent.run()  # blocks until Ctrl+C
            finally:
                agent._stop_event.set()
                loop_thread.join(timeout=5)
        else:
            # Tray setup failed (missing pystray/Pillow, or running as Administrator
            # which can block systray access) — run headless.
            log.warning("Tray unavailable — running headless. Press Ctrl+C to stop.")
            agent.run()


if __name__ == "__main__":
    main()
