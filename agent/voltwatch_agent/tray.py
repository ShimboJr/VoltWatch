"""
System tray icon (pystray + Pillow).

Generates a battery-percentage icon colour-coded by state:
  Green  — AC connected, OK
  Blue   — Actively charging
  Amber  — On battery
  Red    — At or below critical level on battery
  Grey   — Cannot reach server (offline / error)

Menu items:
  Status line (non-clickable)
  ─────
  Open Dashboard
  ─────
  Pause Reporting
  Resume Reporting
  ─────
  Start with Windows  (toggle, checkmark)
  ─────
  Open Log Folder
  About
  ─────
  Quit
"""

from __future__ import annotations

import logging
import os
import subprocess
import sys
import threading
import webbrowser
from datetime import datetime, timezone
from typing import Callable

log = logging.getLogger(__name__)

# ── Icon generation ────────────────────────────────────────────────────────────

ICON_SIZE = 64
FONT_SIZE = 22


def _make_icon_image(
    percent: int,
    state: str,  # "ac_ok" | "charging" | "battery" | "critical" | "offline"
):
    """
    Generate a PIL Image for the tray icon.

    Args:
        percent:  0–100
        state:    Colour-coded state string
    """
    try:
        from PIL import Image, ImageDraw, ImageFont  # type: ignore
    except ImportError:
        log.warning("Pillow not available — cannot generate tray icon")
        return None

    COLOURS = {
        "ac_ok":    ("#27ae60", "#ffffff"),  # green
        "charging": ("#2980b9", "#ffffff"),  # blue
        "battery":  ("#e67e22", "#ffffff"),  # amber
        "critical": ("#c0392b", "#ffffff"),  # red
        "offline":  ("#7f8c8d", "#ecf0f1"),  # grey
    }
    bg_colour, fg_colour = COLOURS.get(state, COLOURS["offline"])

    img  = Image.new("RGBA", (ICON_SIZE, ICON_SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Rounded rectangle background
    draw.rounded_rectangle([(2, 2), (ICON_SIZE - 2, ICON_SIZE - 2)],
                            radius=12, fill=bg_colour)

    # Battery level bar at bottom
    bar_height = max(3, int((percent / 100) * (ICON_SIZE - 4)))
    draw.rounded_rectangle(
        [(2, ICON_SIZE - 2 - bar_height), (ICON_SIZE - 2, ICON_SIZE - 2)],
        radius=4, fill=fg_colour + "55",
    )

    # Percentage text
    text = str(percent) if percent < 100 else "AC"
    try:
        # Use a bundled or system font
        font = ImageFont.truetype("segoeui.ttf", FONT_SIZE)
    except Exception:
        try:
            font = ImageFont.truetype("arial.ttf", FONT_SIZE)
        except Exception:
            font = ImageFont.load_default()

    # Centre the text
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    draw.text(
        ((ICON_SIZE - tw) / 2, (ICON_SIZE - th) / 2 - 2),
        text, fill=fg_colour, font=font,
    )

    return img


def _icon_state(percent: int, ac_connected: bool, charging: bool,
                server_reachable: bool, critical_level: int) -> str:
    if not server_reachable:
        return "offline"
    if charging:
        return "charging"
    if ac_connected:
        return "ac_ok"
    if percent <= critical_level:
        return "critical"
    return "battery"


# ── Tray class ─────────────────────────────────────────────────────────────────

class TrayApp:
    """
    Manages the system tray icon and menu.

    Callbacks are invoked on a daemon thread; callers must be thread-safe.
    """

    def __init__(
        self,
        on_pause:         Callable[[], None],
        on_resume:        Callable[[], None],
        on_quit:          Callable[[], None],
        dashboard_url:    str = "",
        critical_level:   int = 15,
    ) -> None:
        self._on_pause       = on_pause
        self._on_resume      = on_resume
        self._on_quit        = on_quit
        self._dashboard_url  = dashboard_url
        self._critical_level = critical_level

        self._percent         = 0
        self._ac_connected    = True
        self._charging        = True
        self._mt5_running     = False
        self._paused          = False
        self._server_reachable = True
        self._last_report_at  : datetime | None = None
        self._icon_obj        = None

    # ── State update (called from main loop thread) ────────────────────────────

    def update_state(
        self,
        percent: int,
        ac_connected: bool,
        charging: bool,
        mt5_running: bool,
        server_reachable: bool,
        last_report_at: datetime | None = None,
    ) -> None:
        self._percent          = percent
        self._ac_connected     = ac_connected
        self._charging         = charging
        self._mt5_running      = mt5_running
        self._server_reachable = server_reachable
        self._last_report_at   = last_report_at
        self._refresh_icon()

    def set_paused(self, paused: bool) -> None:
        self._paused = paused
        self._refresh_icon()

    def set_dashboard_url(self, url: str) -> None:
        self._dashboard_url = url

    # ── Icon & tooltip ─────────────────────────────────────────────────────────

    def _state_str(self) -> str:
        return _icon_state(
            self._percent, self._ac_connected, self._charging,
            self._server_reachable, self._critical_level,
        )

    def _tooltip(self) -> str:
        power = "Charging" if self._charging else ("AC" if self._ac_connected else "Battery")
        mt5   = "running" if self._mt5_running else "NOT running"
        last  = (self._last_report_at.strftime("%H:%M:%S")
                 if self._last_report_at else "never")
        paused = " [PAUSED]" if self._paused else ""
        warn = "\n⚠ Laptop sleep will stop MT5 and this agent"
        return (
            f"VoltWatch{paused}\n"
            f"{self._percent}% — {power}\n"
            f"MT5: {mt5}\n"
            f"Last report: {last}"
            f"{warn}"
        )

    def _refresh_icon(self) -> None:
        if self._icon_obj is None:
            return
        try:
            img = _make_icon_image(self._percent, self._state_str())
            if img:
                self._icon_obj.icon  = img
                self._icon_obj.title = self._tooltip()
        except Exception as exc:
            log.debug("Icon refresh failed: %s", exc)

    # ── Menu builders ──────────────────────────────────────────────────────────

    def _build_menu(self):
        try:
            import pystray  # type: ignore
        except ImportError:
            return None

        from voltwatch_agent.config import get_autostart, set_autostart

        def _status_item():
            power = "Charging" if self._charging else ("AC" if self._ac_connected else "Battery")
            mt5   = "✓" if self._mt5_running else "✗"
            last  = (self._last_report_at.strftime("%H:%M:%S")
                     if self._last_report_at else "never")
            return f"{self._percent}% {power} | MT5 {mt5} | {last}"



        items = [
            pystray.MenuItem(lambda _: _status_item(), None, enabled=False),
            pystray.Menu.SEPARATOR,
        ]

        if self._dashboard_url:
            items.append(
                pystray.MenuItem("Open Dashboard",
                                 lambda: webbrowser.open(self._dashboard_url))
            )
            items.append(pystray.Menu.SEPARATOR)

        if self._paused:
            items.append(pystray.MenuItem("Resume Reporting", self._do_resume))
        else:
            items.append(pystray.MenuItem("Pause Reporting", self._do_pause))

        items.append(pystray.Menu.SEPARATOR)

        # Autostart toggle
        try:
            autostart_on = get_autostart()
        except Exception:
            autostart_on = False

        def toggle_autostart(icon, item):
            new_val = not get_autostart()
            set_autostart(new_val)
            # Rebuild menu to reflect new state
            self._icon_obj.menu = self._build_menu()

        items.append(
            pystray.MenuItem(
                "Start with Windows",
                toggle_autostart,
                checked=lambda _: get_autostart(),
            )
        )

        items.append(pystray.Menu.SEPARATOR)
        items.append(pystray.MenuItem("Open Log Folder", self._open_log_folder))
        items.append(pystray.MenuItem("About", self._show_about))
        items.append(pystray.Menu.SEPARATOR)
        items.append(pystray.MenuItem("Quit", self._do_quit))

        return pystray.Menu(*items)

    # ── Actions ────────────────────────────────────────────────────────────────

    def _do_pause(self, icon=None, item=None):
        self._paused = True
        self._on_pause()
        if self._icon_obj:
            self._icon_obj.menu = self._build_menu()
        self._refresh_icon()

    def _do_resume(self, icon=None, item=None):
        self._paused = False
        self._on_resume()
        if self._icon_obj:
            self._icon_obj.menu = self._build_menu()
        self._refresh_icon()

    def _do_quit(self, icon=None, item=None):
        if self._icon_obj:
            self._icon_obj.stop()
        self._on_quit()

    def _open_log_folder(self, icon=None, item=None):
        try:
            from voltwatch_agent.logging_setup import get_log_dir
            path = str(get_log_dir())
            if sys.platform == "win32":
                os.startfile(path)  # noqa: S606
            else:
                subprocess.Popen(["xdg-open", path])  # noqa: S603, S607
        except Exception as exc:
            log.warning("Cannot open log folder: %s", exc)

    def _show_about(self, icon=None, item=None):
        try:
            from voltwatch_agent.version import VERSION, BUILD_DATE
            import tkinter as tk
            from tkinter import messagebox
            root = tk.Tk(); root.withdraw()
            messagebox.showinfo(
                "About VoltWatch",
                f"VoltWatch Agent v{VERSION}\nBuilt: {BUILD_DATE}\n\n"
                "Battery + MT5 monitor for unattended trading.\n"
                "github.com/yourrepo/voltwatch",
            )
            root.destroy()
        except Exception:
            pass

    # ── Lifecycle ──────────────────────────────────────────────────────────────

    def run(self) -> None:
        """Block until the tray icon is stopped. Call from the main thread."""
        try:
            import pystray  # type: ignore
        except ImportError:
            log.error(
                "pystray is not installed — tray icon unavailable. "
                "Running headless; use Ctrl+C to stop."
            )
            # Block until quit is signalled externally
            import signal
            signal.pause()
            return

        img = _make_icon_image(self._percent, self._state_str())
        if img is None:
            # Minimal fallback: 1×1 white pixel
            from PIL import Image
            img = Image.new("RGBA", (1, 1), (255, 255, 255, 255))

        self._icon_obj = pystray.Icon(
            "VoltWatch",
            icon=img,
            title=self._tooltip(),
            menu=self._build_menu(),
        )
        self._icon_obj.run()

    def stop(self) -> None:
        """Stop the tray icon from another thread."""
        if self._icon_obj:
            try:
                self._icon_obj.stop()
            except Exception:
                pass
