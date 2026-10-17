"""
Unit tests for pure functions in battery.py and mt5.py.

These tests run on any platform (no psutil, no Windows, no tray).
"""

import pytest
from voltwatch_agent.battery import (
    BatteryState,
    parse_psutil_battery,
    parse_powershell_output,
    states_differ,
    get_battery_state,
)
from voltwatch_agent.mt5 import (
    process_names_running,
    state_changed,
    is_mt5_running,
)


# ── parse_psutil_battery ───────────────────────────────────────────────────────

class TestParsePsutilBattery:
    def test_on_battery(self):
        s = parse_psutil_battery(72.5, 3600, False)
        assert s.percent == 72.5
        assert s.ac_connected is False
        assert s.charging is False
        assert s.secs_left == 3600

    def test_charging(self):
        s = parse_psutil_battery(80.0, -1, True)
        assert s.ac_connected is True
        assert s.charging is True   # 80 < 99.5
        assert s.secs_left is None  # plugged in

    def test_plugged_not_charging(self):
        """AC connected but at 100% — charging should be False."""
        s = parse_psutil_battery(100.0, None, True)
        assert s.ac_connected is True
        assert s.charging is False  # 100 >= 99.5

    def test_secs_left_normalised_when_very_large(self):
        """psutil returns a huge value when plugged in — should be None."""
        s = parse_psutil_battery(60.0, 86_400 * 8, False)
        assert s.secs_left is None  # > 7 days → normalise to None

    def test_secs_left_negative(self):
        s = parse_psutil_battery(60.0, -1.0, False)
        assert s.secs_left is None

    def test_percent_rounded(self):
        s = parse_psutil_battery(47.8, 1800, False)
        assert s.percent_rounded == 48


# ── parse_powershell_output ────────────────────────────────────────────────────

class TestParsePowershellOutput:
    def _ps(self, pct, status, runtime=None):
        lines = [f"EstimatedChargeRemaining: {pct}", f"BatteryStatus: {status}"]
        if runtime is not None:
            lines.append(f"EstimatedRunTime: {runtime}")
        return "\n".join(lines)

    def test_discharging(self):
        s = parse_powershell_output(self._ps(55, 1, 330))
        assert s is not None
        assert s.percent == 55.0
        assert s.ac_connected is False
        assert s.charging is False
        assert s.secs_left == 330 * 60

    def test_ac_connected_not_charging(self):
        s = parse_powershell_output(self._ps(100, 3))
        assert s.ac_connected is True
        assert s.charging is False

    def test_charging(self):
        s = parse_powershell_output(self._ps(60, 6))
        assert s.ac_connected is True
        assert s.charging is True

    def test_invalid_returns_none(self):
        assert parse_powershell_output("garbage output") is None

    def test_missing_field_returns_none(self):
        assert parse_powershell_output("BatteryStatus: 1") is None

    def test_runtime_zero_gives_none(self):
        s = parse_powershell_output(self._ps(40, 1, 0))
        assert s.secs_left is None

    def test_runtime_very_large_gives_none(self):
        s = parse_powershell_output(self._ps(80, 1, 999_999))
        assert s.secs_left is None


# ── states_differ ──────────────────────────────────────────────────────────────

class TestStatesDiffer:
    def _s(self, ac, charging, pct=80):
        return BatteryState(percent=pct, ac_connected=ac, charging=charging, secs_left=None)

    def test_no_diff(self):
        assert states_differ(self._s(True, True), self._s(True, True)) is False

    def test_ac_disconnect(self):
        assert states_differ(self._s(True, True), self._s(False, False)) is True

    def test_ac_reconnect(self):
        assert states_differ(self._s(False, False), self._s(True, True)) is True

    def test_charging_flipped(self):
        assert states_differ(self._s(True, True), self._s(True, False)) is True

    def test_none_prev(self):
        assert states_differ(None, self._s(False, False)) is False

    def test_none_curr(self):
        assert states_differ(self._s(True, True), None) is False


# ── get_battery_state with injectable readers ──────────────────────────────────

class TestGetBatteryState:
    def _make_state(self, **kw):
        defaults = dict(percent=80.0, ac_connected=True, charging=True, secs_left=None)
        defaults.update(kw)
        return BatteryState(**defaults)

    def test_uses_psutil_when_available(self):
        fake_state = self._make_state()
        result = get_battery_state(
            psutil_reader=lambda: fake_state,
            ps_reader=lambda: None,
        )
        assert result is fake_state

    def test_falls_back_to_powershell(self):
        fallback = self._make_state(percent=55.0)
        result = get_battery_state(
            psutil_reader=lambda: None,
            ps_reader=lambda: fallback,
        )
        assert result is fallback

    def test_returns_none_when_both_fail(self):
        result = get_battery_state(
            psutil_reader=lambda: None,
            ps_reader=lambda: None,
        )
        assert result is None


# ── MT5 process detection ──────────────────────────────────────────────────────

class TestProcessNamesRunning:
    def test_mt5_found(self):
        assert process_names_running(
            ["chrome.exe", "terminal64.exe", "notepad.exe"],
            ["terminal64.exe", "terminal.exe"],
        ) is True

    def test_mt5_not_found(self):
        assert process_names_running(
            ["chrome.exe", "notepad.exe"],
            ["terminal64.exe", "terminal.exe"],
        ) is False

    def test_case_insensitive(self):
        assert process_names_running(
            ["TERMINAL64.EXE"],
            ["terminal64.exe"],
        ) is True

    def test_empty_process_list(self):
        assert process_names_running([], ["terminal64.exe"]) is False

    def test_empty_targets(self):
        assert process_names_running(["terminal64.exe"], []) is False


class TestMt5StateChanged:
    def test_started(self):
        assert state_changed(False, True) == "mt5_started"

    def test_stopped(self):
        assert state_changed(True, False) == "mt5_stopped"

    def test_no_change_running(self):
        assert state_changed(True, True) is None

    def test_no_change_not_running(self):
        assert state_changed(False, False) is None


class TestIsMt5Running:
    def test_detected(self):
        assert is_mt5_running(
            process_names=["terminal64.exe"],
            lister=lambda: ["terminal64.exe", "chrome.exe"],
        ) is True

    def test_not_detected(self):
        assert is_mt5_running(
            process_names=["terminal64.exe"],
            lister=lambda: ["chrome.exe"],
        ) is False

    def test_lister_exception_returns_false(self):
        def _bad():
            raise RuntimeError("no access")
        assert is_mt5_running(lister=_bad) is False
