"""
Windows-specific event handling.

Covers:
  1. WM_QUERYENDSESSION / WM_ENDSESSION — logoff / shutdown detection
     (hidden message-only window using ctypes; falls back gracefully on non-Windows)
  2. Unexpected-shutdown detection by querying the Windows event log
     for Kernel-Power Event ID 41 and EventLog 6008
  3. Sleep / resume detection via monotonic-vs-wall-clock gap comparison

All Windows-only code is guarded by sys.platform checks so the module
imports cleanly on Linux/macOS (useful for running tests).
"""

from __future__ import annotations

import logging
import subprocess
import sys
import time
from datetime import datetime, timezone
from typing import Callable

log = logging.getLogger(__name__)

# ── Sleep / resume detection ───────────────────────────────────────────────────

def detect_sleep_resume(
    prev_monotonic: float,
    prev_wall: float,
    sample_interval_sec: float,
    threshold_multiplier: float = 3.0,
) -> float | None:
    """
    Pure function: compare wall-clock gap vs monotonic gap.

    If the wall-clock moved significantly more than the monotonic clock
    (by > threshold_multiplier × sample_interval_sec), a sleep/resume occurred.

    Args:
        prev_monotonic:       time.monotonic() from the previous sample.
        prev_wall:            time.time() from the previous sample.
        sample_interval_sec:  Expected sampling period in seconds.
        threshold_multiplier: How many missed periods = a sleep gap.

    Returns:
        Gap in seconds (wall-clock) if sleep detected, else None.
    """
    now_mono = time.monotonic()
    now_wall = time.time()

    mono_gap = now_mono - prev_monotonic
    wall_gap = now_wall - prev_wall
    extra    = wall_gap - mono_gap

    if extra > threshold_multiplier * sample_interval_sec:
        return round(wall_gap, 1)
    return None


# ── Unexpected-shutdown detection ──────────────────────────────────────────────

_PS_UNCLEAN = r"""
$events = @()
try {
    $e41 = Get-WinEvent -FilterHashtable @{LogName='System';Id=41;ProviderName='Microsoft-Windows-Kernel-Power'} `
           -MaxEvents 5 -ErrorAction SilentlyContinue
    if ($e41) { $events += $e41 }
} catch {}
try {
    $e6008 = Get-WinEvent -FilterHashtable @{LogName='System';Id=6008} `
             -MaxEvents 5 -ErrorAction SilentlyContinue
    if ($e6008) { $events += $e6008 }
} catch {}
$events | Sort-Object TimeCreated -Descending | Select-Object -First 1 |
    ForEach-Object { $_.TimeCreated.ToUniversalTime().ToString('o') }
"""


def query_last_unclean_shutdown() -> datetime | None:
    """
    Query Windows event log for the most recent unclean shutdown event.

    Returns:
        UTC datetime of the event, or None if not found / not on Windows.
    """
    if sys.platform != "win32":
        return None
    try:
        result = subprocess.run(  # noqa: S603, S607
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", _PS_UNCLEAN],
            capture_output=True,
            text=True,
            timeout=15,
        )
        out = result.stdout.strip()
        if not out:
            return None
        dt = datetime.fromisoformat(out.replace("Z", "+00:00"))
        return dt.astimezone(timezone.utc)
    except Exception as exc:
        log.debug("Unclean-shutdown query failed: %s", exc)
        return None


def parse_shutdown_timestamp(iso_str: str | None) -> datetime | None:
    """Parse a stored ISO timestamp string into a datetime (UTC). Pure function."""
    if not iso_str:
        return None
    try:
        dt = datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
        return dt.astimezone(timezone.utc)
    except ValueError:
        return None


def is_unexpected_shutdown(
    last_event_dt: datetime | None,
    last_run_dt: datetime | None,
) -> bool:
    """
    Return True if last_event_dt occurred after last_run_dt.

    Pure function — fully testable without Windows.

    Args:
        last_event_dt:  Most recent unclean-shutdown event time (UTC).
        last_run_dt:    Timestamp when this agent last ran (UTC).
    """
    if last_event_dt is None or last_run_dt is None:
        return False
    return last_event_dt > last_run_dt


# ── WM_QUERYENDSESSION hidden window (Windows only) ───────────────────────────

class _ShutdownWatcher:
    """
    Creates a hidden message-only window to intercept Windows shutdown/logoff.

    When WM_QUERYENDSESSION is received, calls the provided callback and then
    confirms it can proceed. Blocks shutdown for at most 3 seconds.
    """

    def __init__(self, on_shutdown: Callable[[], None]) -> None:
        self._on_shutdown = on_shutdown
        self._thread = None

    def start(self) -> None:
        if sys.platform != "win32":
            return
        import threading
        self._thread = threading.Thread(target=self._run, daemon=True, name="ShutdownWatcher")
        self._thread.start()

    def _run(self) -> None:
        try:
            import ctypes
            import ctypes.wintypes as wt

            WM_QUERYENDSESSION = 0x0011
            WM_ENDSESSION      = 0x0016
            WS_EX_NOACTIVATE   = 0x08000000
            ERROR_CLASS_ALREADY_EXISTS = 1410
            HWND_MESSAGE = ctypes.cast(-3, wt.HWND)  # message-only window parent

            kernel32 = ctypes.windll.kernel32
            user32   = ctypes.windll.user32

            WNDPROCTYPE = ctypes.WINFUNCTYPE(
                ctypes.c_long, wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM
            )

            def wnd_proc(hwnd, msg, wparam, lparam):
                if msg in (WM_QUERYENDSESSION, WM_ENDSESSION):
                    log.info("Received Windows shutdown/logoff signal")
                    self._on_shutdown()
                    return 1  # Allow shutdown
                return user32.DefWindowProcW(hwnd, msg, wparam, lparam)

            wnd_proc_ref = WNDPROCTYPE(wnd_proc)

            # Full WNDCLASSW struct
            class WNDCLASSW(ctypes.Structure):
                _fields_ = [
                    ("style",         ctypes.c_uint),
                    ("lpfnWndProc",   WNDPROCTYPE),
                    ("cbClsExtra",    ctypes.c_int),
                    ("cbWndExtra",    ctypes.c_int),
                    ("hInstance",     wt.HINSTANCE),
                    ("hIcon",         wt.HICON),
                    ("hCursor",       wt.HANDLE),
                    ("hbrBackground", wt.HBRUSH),
                    ("lpszMenuName",  wt.LPCWSTR),
                    ("lpszClassName", wt.LPCWSTR),
                ]

            wc = WNDCLASSW()
            wc.style         = 0
            wc.lpfnWndProc   = wnd_proc_ref
            wc.cbClsExtra    = 0
            wc.cbWndExtra    = 0
            wc.hInstance     = kernel32.GetModuleHandleW(None)
            wc.hIcon         = None
            wc.hCursor       = None
            wc.hbrBackground = None
            wc.lpszMenuName  = None
            wc.lpszClassName = "VoltWatchShutdownWatcher"

            reg_ok = user32.RegisterClassW(ctypes.byref(wc))
            if not reg_ok:
                err = kernel32.GetLastError()
                if err != ERROR_CLASS_ALREADY_EXISTS:
                    log.warning("Could not register window class for shutdown detection (error %d)", err)
                    return
                # Class already registered from a previous run — that's fine, continue.

            hwnd = user32.CreateWindowExW(
                WS_EX_NOACTIVATE,
                "VoltWatchShutdownWatcher",
                "VoltWatch",
                0, 0, 0, 0, 0,
                HWND_MESSAGE,
                None, None, None,
            )

            if not hwnd:
                err = kernel32.GetLastError()
                log.warning("Could not create message window for shutdown detection (error %d)", err)
                return

            msg = wt.MSG()
            while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) != 0:
                user32.TranslateMessage(ctypes.byref(msg))
                user32.DispatchMessageW(ctypes.byref(msg))
        except Exception as exc:
            log.debug("ShutdownWatcher thread error: %s", exc)


def start_shutdown_watcher(on_shutdown: Callable[[], None]) -> _ShutdownWatcher:
    """
    Start a background thread that intercepts Windows shutdown/logoff.

    Args:
        on_shutdown: Callable invoked (with ≤3 seconds budget) before shutdown.

    Returns:
        The running _ShutdownWatcher instance.
    """
    watcher = _ShutdownWatcher(on_shutdown)
    watcher.start()
    return watcher
