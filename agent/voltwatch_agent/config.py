"""
Configuration management.

Config is stored in %LOCALAPPDATA%\\VoltWatch\\config.json.
The device token is stored in Windows Credential Manager (via keyring) and
falls back to the JSON file with a user-only ACL warning if keyring fails.

A downloaded ``voltwatch-config.json`` placed next to the executable is
detected on first run and auto-imported.
"""

from __future__ import annotations

import json
import logging
import os
import stat
import sys
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

# ── Paths ──────────────────────────────────────────────────────────────────────

def get_data_dir() -> Path:
    local_app = os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local"))
    data_dir = Path(local_app) / "VoltWatch"
    data_dir.mkdir(parents=True, exist_ok=True)
    return data_dir


def get_config_path() -> Path:
    return get_data_dir() / "config.json"


def _exe_dir() -> Path:
    """Directory of the running executable (or script)."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).parent
    return Path(__file__).parent.parent


# ── Keyring helpers ────────────────────────────────────────────────────────────

_SERVICE = "VoltWatch"
_USERNAME = "device_token"


def _store_token_keyring(token: str) -> bool:
    try:
        import keyring  # type: ignore
        keyring.set_password(_SERVICE, _USERNAME, token)
        return True
    except Exception as exc:
        log.warning("keyring unavailable (%s); token will be stored in config.json", exc)
        return False


def _load_token_keyring() -> str | None:
    try:
        import keyring  # type: ignore
        return keyring.get_password(_SERVICE, _USERNAME)
    except Exception:
        return None


def _delete_token_keyring() -> None:
    try:
        import keyring  # type: ignore
        keyring.delete_password(_SERVICE, _USERNAME)
    except Exception:
        pass


# ── Config dataclass ───────────────────────────────────────────────────────────

class Config:
    """Holds all runtime configuration."""

    def __init__(
        self,
        api_url: str,
        device_token: str,
        interval_sec: int = 45,
        mt5_process_names: list[str] | None = None,
        log_level: str = "INFO",
        dashboard_url: str = "",
        config_version: int = 1,
    ) -> None:
        self.api_url = api_url.rstrip("/")
        self.device_token = device_token
        self.interval_sec = max(30, min(60, interval_sec))
        self.mt5_process_names = mt5_process_names or ["terminal64.exe", "terminal.exe"]
        self.log_level = log_level
        self.dashboard_url = dashboard_url
        self.config_version = config_version

    def update_from_server(self, server_config: dict[str, Any]) -> bool:
        """Apply server-returned config. Returns True if interval changed."""
        new_interval = server_config.get("intervalSec", self.interval_sec)
        new_interval = max(30, min(60, int(new_interval)))
        new_version  = server_config.get("configVersion", self.config_version)
        changed = new_interval != self.interval_sec
        self.interval_sec   = new_interval
        self.config_version = new_version
        return changed

    def to_dict(self) -> dict:
        return {
            "apiUrl": self.api_url,
            # Token stored in keyring; include here only as fallback marker
            "intervalSec": self.interval_sec,
            "mt5ProcessNames": self.mt5_process_names,
            "logLevel": self.log_level,
            "dashboardUrl": self.dashboard_url,
            "configVersion": self.config_version,
        }


# ── Persistence ────────────────────────────────────────────────────────────────

def save_config(cfg: Config, store_token_in_file: bool = False) -> None:
    """Persist config to disk. Token goes to keyring unless fallback is forced."""
    path = get_config_path()
    data = cfg.to_dict()

    # Try keyring first
    if not _store_token_keyring(cfg.device_token) or store_token_in_file:
        data["deviceToken"] = cfg.device_token
        log.warning("Storing token in config.json — ensure file permissions are restricted")

    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)

    # Restrict permissions on Windows (best-effort)
    try:
        import subprocess  # noqa: S404
        subprocess.run(  # noqa: S603
            ["icacls", str(path), "/inheritance:r", "/grant:r", f"{os.getlogin()}:(R,W)"],
            capture_output=True,
            check=False,
        )
    except Exception:
        pass

    log.info("Config saved to %s", path)


def load_config() -> Config | None:
    """
    Load config from disk.
    1. Check for a downloaded voltwatch-config.json next to the exe.
    2. Load from the standard data directory.
    3. Merge token from keyring.
    """
    # Check for bootstrap config next to exe
    bootstrap = _exe_dir() / "voltwatch-config.json"
    if bootstrap.exists():
        try:
            with open(bootstrap, encoding="utf-8") as f:
                data = json.load(f)
            log.info("Importing bootstrap config from %s", bootstrap)
            cfg = _dict_to_config(data)
            if cfg:
                save_config(cfg)
                bootstrap.rename(bootstrap.with_suffix(".json.imported"))
                return cfg
        except Exception as exc:
            log.warning("Failed to import bootstrap config: %s", exc)

    path = get_config_path()
    if not path.exists():
        return None

    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except Exception as exc:
        log.error("Cannot read config: %s", exc)
        return None

    return _dict_to_config(data)


def _dict_to_config(data: dict) -> Config | None:
    api_url = data.get("apiUrl") or data.get("api_url", "")
    if not api_url:
        log.error("Config missing apiUrl")
        return None

    # Token from keyring first, then JSON
    token = _load_token_keyring() or data.get("deviceToken") or data.get("device_token", "")
    if not token:
        log.error("Config missing device token")
        return None

    return Config(
        api_url=api_url,
        device_token=token,
        interval_sec=int(data.get("intervalSec", 45)),
        mt5_process_names=data.get("mt5ProcessNames") or ["terminal64.exe", "terminal.exe"],
        log_level=data.get("logLevel", "INFO"),
        dashboard_url=data.get("dashboardUrl", ""),
        config_version=int(data.get("configVersion", 1)),
    )


# ── Windows autostart (HKCU Run key) ──────────────────────────────────────────

_RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
_RUN_VALUE = "VoltWatchAgent"


def set_autostart(enabled: bool) -> bool:
    """Toggle the HKCU Run registry key for auto-start with Windows."""
    try:
        import winreg  # type: ignore
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, _RUN_KEY, 0, winreg.KEY_SET_VALUE)
        if enabled:
            exe = sys.executable if not getattr(sys, "frozen", False) else sys.executable
            winreg.SetValueEx(key, _RUN_VALUE, 0, winreg.REG_SZ, f'"{exe}"')
            log.info("Autostart enabled")
        else:
            try:
                winreg.DeleteValue(key, _RUN_VALUE)
                log.info("Autostart disabled")
            except FileNotFoundError:
                pass
        winreg.CloseKey(key)
        return True
    except ImportError:
        log.warning("winreg not available — autostart not supported on this platform")
        return False
    except Exception as exc:
        log.error("Failed to set autostart: %s", exc)
        return False


def get_autostart() -> bool:
    """Return True if the HKCU Run key is set."""
    try:
        import winreg  # type: ignore
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, _RUN_KEY, 0, winreg.KEY_READ)
        try:
            winreg.QueryValueEx(key, _RUN_VALUE)
            return True
        except FileNotFoundError:
            return False
        finally:
            winreg.CloseKey(key)
    except Exception:
        return False
