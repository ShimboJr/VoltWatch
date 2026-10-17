"""
MT5 (MetaTrader 5) process detection.

Pure functions so tests run without psutil or Windows.
"""

from __future__ import annotations

import logging
from typing import Callable, Iterable

log = logging.getLogger(__name__)

_DEFAULT_NAMES = {"terminal64.exe", "terminal.exe"}


# ── Pure helpers ───────────────────────────────────────────────────────────────

def process_names_running(
    process_list: Iterable[str],
    target_names: Iterable[str],
) -> bool:
    """
    Return True if any name in ``target_names`` appears in ``process_list``
    (case-insensitive).

    Args:
        process_list:  Iterable of running process names.
        target_names:  Names to search for.
    """
    targets = {n.lower() for n in target_names}
    for name in process_list:
        if name.lower() in targets:
            return True
    return False


def state_changed(prev: bool, curr: bool) -> str | None:
    """
    Return the event string if MT5 started or stopped, else None.

    Returns:
        ``"mt5_started"``   if prev=False and curr=True
        ``"mt5_stopped"``   if prev=True  and curr=False
        ``None``            if unchanged
    """
    if not prev and curr:
        return "mt5_started"
    if prev and not curr:
        return "mt5_stopped"
    return None


# ── Platform reader ────────────────────────────────────────────────────────────

def _list_process_names_psutil() -> list[str]:
    try:
        import psutil  # type: ignore
        return [p.name() for p in psutil.process_iter(["name"])]
    except Exception as exc:
        log.debug("psutil process list failed: %s", exc)
        return []


# ── Public API ─────────────────────────────────────────────────────────────────

def is_mt5_running(
    process_names: Iterable[str] | None = None,
    lister: Callable[[], list[str]] = _list_process_names_psutil,
) -> bool:
    """
    Check whether MetaTrader 5 is running.

    Args:
        process_names:  Names to watch (default: terminal64.exe, terminal.exe).
        lister:         Injectable process-list provider for testing.
    """
    targets = process_names or _DEFAULT_NAMES
    try:
        running = lister()
        return process_names_running(running, targets)
    except Exception as exc:
        log.warning("MT5 detection failed: %s", exc)
        return False
