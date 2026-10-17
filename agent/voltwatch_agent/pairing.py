"""
First-run pairing dialog (Tkinter).

Shown when config.json is missing. Asks for:
  - Server URL (e.g. https://api.voltwatch.app/api/v1)
  - Device token (paste from dashboard)

Validates by sending a test heartbeat, then saves config.
"""

from __future__ import annotations

import logging
import socket
import threading
import uuid
from datetime import datetime, timezone
from typing import Callable

log = logging.getLogger(__name__)


def show_pairing_dialog(
    on_success: Callable[[str, str], None],
) -> None:
    """
    Show a Tkinter pairing dialog.

    Args:
        on_success: Called with (api_url, token) after successful validation.
    """
    try:
        import tkinter as tk
        from tkinter import messagebox, ttk
    except ImportError:
        log.error("Tkinter is not available — cannot show pairing dialog")
        return

    root = tk.Tk()
    root.title("VoltWatch — First Run Setup")
    root.resizable(False, False)
    root.configure(bg="#1a1a2e")

    # ── Styles ──────────────────────────────────────────────────────────────
    BG   = "#1a1a2e"
    FG   = "#e0e0e0"
    ACCENT = "#4fc3f7"
    ENTRY_BG = "#16213e"
    BTN_BG   = "#0f3460"
    FONT_HEAD = ("Segoe UI", 14, "bold")
    FONT_BODY = ("Segoe UI", 10)

    root.option_add("*Font", FONT_BODY)

    frame = tk.Frame(root, bg=BG, padx=30, pady=24)
    frame.pack(fill="both", expand=True)

    tk.Label(frame, text="⚡ VoltWatch Setup", font=FONT_HEAD,
             bg=BG, fg=ACCENT).grid(row=0, column=0, columnspan=2, pady=(0, 16))

    tk.Label(frame, text="Backend API URL:", bg=BG, fg=FG).grid(
        row=1, column=0, sticky="w", pady=4)
    url_var = tk.StringVar(value="http://localhost:3001/api/v1")
    url_entry = tk.Entry(frame, textvariable=url_var, width=44,
                         bg=ENTRY_BG, fg=FG, insertbackground=FG,
                         relief="flat", bd=6)
    url_entry.grid(row=1, column=1, pady=4, padx=(8, 0))

    tk.Label(frame, text="Device Token:", bg=BG, fg=FG).grid(
        row=2, column=0, sticky="w", pady=4)
    token_var = tk.StringVar()
    token_entry = tk.Entry(frame, textvariable=token_var, width=44, show="•",
                           bg=ENTRY_BG, fg=FG, insertbackground=FG,
                           relief="flat", bd=6)
    token_entry.grid(row=2, column=1, pady=4, padx=(8, 0))

    # Show/hide token toggle
    show_var = tk.BooleanVar(value=False)
    def toggle_show():
        token_entry.config(show="" if show_var.get() else "•")
    tk.Checkbutton(frame, text="Show token", variable=show_var, command=toggle_show,
                   bg=BG, fg=FG, selectcolor=BTN_BG, activebackground=BG).grid(
        row=3, column=1, sticky="e")

    status_var = tk.StringVar(value="")
    status_label = tk.Label(frame, textvariable=status_var, bg=BG, fg="#ef5350",
                             font=FONT_BODY, wraplength=380)
    status_label.grid(row=4, column=0, columnspan=2, pady=8)

    def do_connect():
        api_url = url_var.get().strip().rstrip("/")
        token   = token_var.get().strip()

        if not api_url:
            status_var.set("Please enter the backend API URL.")
            return
        if not token:
            status_var.set("Please paste your device token.")
            return

        status_var.set("Connecting…")
        status_label.config(fg=ACCENT)
        root.update()

        def _validate():
            try:
                from voltwatch_agent.client import AgentClient, build_payload
                client = AgentClient(
                    api_url=api_url,
                    token=token,
                    agent_version="1.0.0",
                    hostname=socket.gethostname(),
                )
                payload = build_payload(
                    reading_id=str(uuid.uuid4()),
                    device_time=datetime.now(tz=timezone.utc).isoformat(),
                    kind="heartbeat",
                    percent=50.0,
                    charging=True,
                    ac_connected=True,
                    secs_left=None,
                    mt5_running=False,
                    uptime_sec=0,
                    internet_latency_ms=None,
                    agent_version="1.0.0",
                    hostname=socket.gethostname(),
                )
                result = client.send_heartbeat(payload)
                if result.ok:
                    root.after(0, lambda: _on_ok(api_url, token))
                else:
                    root.after(0, lambda: _on_err(result.error or "Unknown error"))
            except Exception as exc:
                root.after(0, lambda: _on_err(str(exc)))

        threading.Thread(target=_validate, daemon=True).start()

    def _on_ok(api_url: str, token: str):
        status_var.set("✓ Connected! Saving config…")
        status_label.config(fg="#66bb6a")
        root.update()
        root.after(800, lambda: [root.destroy(), on_success(api_url, token)])

    def _on_err(msg: str):
        status_var.set(f"✗ {msg}")
        status_label.config(fg="#ef5350")

    btn_frame = tk.Frame(frame, bg=BG)
    btn_frame.grid(row=5, column=0, columnspan=2, pady=(12, 0))

    tk.Button(
        btn_frame, text="Connect & Save",
        command=do_connect, bg=ACCENT, fg="#000",
        relief="flat", padx=16, pady=6,
        font=("Segoe UI", 10, "bold"),
        cursor="hand2",
    ).pack(side="left", padx=8)

    tk.Button(
        btn_frame, text="Cancel",
        command=root.destroy, bg=BTN_BG, fg=FG,
        relief="flat", padx=16, pady=6,
        cursor="hand2",
    ).pack(side="left")

    # Centre on screen
    root.update_idletasks()
    w, h = root.winfo_width(), root.winfo_height()
    sw, sh = root.winfo_screenwidth(), root.winfo_screenheight()
    root.geometry(f"+{(sw - w) // 2}+{(sh - h) // 2}")

    root.mainloop()
