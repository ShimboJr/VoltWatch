"""
Battery state reading.

Primary: psutil.sensors_battery()
Fallback: PowerShell Win32_Battery CIM query (Windows-only)

Pure-function interface so tests run on any platform without psutil or Windows.
"""

from __future__ import annotations

import logging
import subprocess
import sys
from dataclasses import dataclass, field
from typing import Callable

log = logging.getLogger(__name__)


# ── Data class ─────────────────────────────────────────────────────────────────

@dataclass
class BatteryState:
    percent: float          # 0.0 – 100.0
    ac_connected: bool      # Charger physically plugged in
    charging: bool          # Battery actually gaining charge
    secs_left: int | None   # Estimated seconds remaining (None = unknown/unlimited)

    @property
    def percent_rounded(self) -> int:
        return round(self.percent)


# ── Pure helpers ───────────────────────────────────────────────────────────────

def parse_psutil_battery(
    percent: float,
    secs_left: float | None,
    power_plugged: bool,
) -> BatteryState:
    """
    Convert raw psutil values into a BatteryState.

    psutil sets secs_left to a very large number or -1 when plugged in and
    full; we normalise those to None.

    Args:
        percent:      Battery percentage (0–100).
        secs_left:    psutil secsleft value (may be None / -1 / very large).
        power_plugged: psutil power_plugged value.
    """
    # Laptop may be plugged in but NOT charging (charge cap / full battery)
    charging = power_plugged and percent < 99.5

    normalised_secs: int | None = None
    if not power_plugged and secs_left is not None and 0 < secs_left < 86_400 * 7:
        normalised_secs = int(secs_left)

    return BatteryState(
        percent=round(percent, 1),
        ac_connected=power_plugged,
        charging=charging,
        secs_left=normalised_secs,
    )


def parse_powershell_output(stdout: str) -> BatteryState | None:
    """
    Parse the newline-separated output of the PowerShell fallback query.

    Expected format (two lines):
        EstimatedChargeRemaining: 75
        BatteryStatus: 2

    BatteryStatus values:
        1 = Discharging, 2 = AC, 3 = Fully Charged,
        4 = Low, 5 = Critical, 6 = Charging, 7 = Charging High,
        8 = Charging Low, 9 = Charging Critical, 10 = Undefined, 11 = Partially Charged
    """
    data: dict[str, str] = {}
    for line in stdout.strip().splitlines():
        if ":" in line:
            k, _, v = line.partition(":")
            data[k.strip()] = v.strip()

    try:
        percent = float(data["EstimatedChargeRemaining"])
        status = int(data["BatteryStatus"])
    except (KeyError, ValueError):
        return None

    ac_connected = status in (2, 3, 6, 7, 8, 9, 11)
    charging = status in (6, 7, 8, 9)
    secs_left: int | None = None

    if not ac_connected:
        try:
            secs_left = int(float(data.get("EstimatedRunTime", "-1"))) * 60
            if secs_left <= 0 or secs_left > 86_400 * 7:
                secs_left = None
        except (ValueError, TypeError):
            secs_left = None

    return BatteryState(
        percent=round(percent, 1),
        ac_connected=ac_connected,
        charging=charging,
        secs_left=secs_left,
    )


# ── Platform readers ───────────────────────────────────────────────────────────

def _read_via_psutil() -> BatteryState | None:
    try:
        import psutil  # type: ignore
        batt = psutil.sensors_battery()
        if batt is None:
            return None
        return parse_psutil_battery(batt.percent, batt.secsleft, batt.power_plugged)
    except Exception as exc:
        log.debug("psutil battery read failed: %s", exc)
        return None


_PS_QUERY = (
    "Get-CimInstance Win32_Battery | "
    "Select-Object EstimatedChargeRemaining, BatteryStatus, EstimatedRunTime | "
    "ForEach-Object { "
    "  \"EstimatedChargeRemaining: $($_.EstimatedChargeRemaining)\"; "
    "  \"BatteryStatus: $($_.BatteryStatus)\"; "
    "  \"EstimatedRunTime: $($_.EstimatedRunTime)\" "
    "}"
)


def _read_via_powershell() -> BatteryState | None:
    try:
        result = subprocess.run(  # noqa: S603, S607
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", _PS_QUERY],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode != 0:
            log.debug("PowerShell battery query failed: %s", result.stderr)
            return None
        return parse_powershell_output(result.stdout)
    except Exception as exc:
        log.debug("PowerShell battery fallback failed: %s", exc)
        return None


# ── Public API ─────────────────────────────────────────────────────────────────

def get_battery_state(
    psutil_reader: Callable[[], BatteryState | None] = _read_via_psutil,
    ps_reader: Callable[[], BatteryState | None] = _read_via_powershell,
) -> BatteryState | None:
    """
    Read current battery state.

    Tries psutil first, falls back to PowerShell on Windows.
    Returns None if no battery is present or both methods fail.

    Args:
        psutil_reader: Injectable for testing.
        ps_reader:     Injectable for testing.
    """
    state = psutil_reader()
    if state is not None:
        return state

    if sys.platform == "win32":
        state = ps_reader()

    return state


def states_differ(prev: BatteryState | None, curr: BatteryState | None) -> bool:
    """Return True if the AC/charging state changed (triggers an immediate event send)."""
    if prev is None or curr is None:
        return False
    return prev.ac_connected != curr.ac_connected or prev.charging != curr.charging
