# VoltWatch Agent

A lightweight Windows 11 system-tray application that monitors laptop battery and MetaTrader 5 status, and reports it to a VoltWatch backend so you can check in from your phone while away.

---

## Features

| Feature | Detail |
|---------|--------|
| Battery reading | `psutil` primary; PowerShell `Win32_Battery` fallback |
| AC transition events | Detected within 5 seconds, sent immediately |
| MT5 detection | Watches `terminal64.exe` / `terminal.exe` (configurable) |
| Offline queue | SQLite, 10,000 rows / 7 days, exponential back-off with jitter |
| Sleep/resume | Gap detection via monotonic vs wall-clock comparison |
| Planned stop | Sends `agent_stopping_planned` before exiting (no false alert) |
| Shutdown detection | Queries Windows event log (Kernel-Power 41 / EventLog 6008) on startup |
| Tray icon | Colour-coded percentage: green/blue/amber/red/grey |
| Start with Windows | HKCU Run key toggle in tray menu |
| Single instance | Named mutex (Windows) |
| Doctor mode | `VoltWatchAgent.exe --doctor` |

---

## Requirements (source / dev)

- Python 3.11+
- Windows 10 / 11 (runs headless on other platforms for development)

```bat
pip install -r requirements.txt
```

---

## First run — pairing

1. Create a device in the VoltWatch dashboard: **Devices → Add Device**. Copy the token (shown once).
2. Run `VoltWatchAgent.exe`. A setup dialog appears:
   - **Backend API URL**: e.g. `https://your-backend.com/api/v1`
   - **Device Token**: paste from the dashboard
3. Click **Connect & Save**. The agent validates the token, saves config, and starts monitoring.

**Alternative — bootstrap config:**  
Place `voltwatch-config.json` next to the exe:
```json
{
  "apiUrl": "https://your-backend.com/api/v1",
  "deviceToken": "your-token-here"
}
```
The file is auto-imported on first run and renamed to `voltwatch-config.json.imported`.

Config is stored at:
```
%LOCALAPPDATA%\VoltWatch\config.json
```
The token is stored in **Windows Credential Manager** (Device → VoltWatch → device_token), falling back to the JSON file.

---

## Running from source

```bat
:: Standard run (tray icon)
python -m voltwatch_agent.main

:: Headless (no tray — for servers or testing)
python -m voltwatch_agent.main --no-tray

:: Doctor mode
python -m voltwatch_agent.main --doctor
```

---

## Doctor mode

```bat
VoltWatchAgent.exe --doctor
```

Checks and reports:
- Battery detected
- Config loaded
- Server reachable (`/health`)
- Token valid (test heartbeat)
- Clock drift
- Offline queue size
- MT5 currently running

Exit code 0 = all good, 1 = failures found.

---

## Tray menu

| Item | Action |
|------|--------|
| Status line | Current %, power state, MT5, last report time |
| Open Dashboard | Opens browser to dashboard URL |
| Pause Reporting | Sends `agent_stopping_planned`; suppresses offline alert for 15 min |
| Resume Reporting | Re-enables reporting |
| Start with Windows | Toggle HKCU Run registry key |
| Open Log Folder | Opens `%LOCALAPPDATA%\VoltWatch\logs\` |
| About | Version info |
| Quit | Sends `agent_stopping_planned`, exits |

---

## Offline behaviour

When the network is unavailable:
1. Readings are stored in `%LOCALAPPDATA%\VoltWatch\queue.db`
2. When connectivity returns, the freshest reading is sent first (live update), then the queue is flushed oldest-first via `/agent/batch` (500 per call)
3. Back-off: 5 s → 10 s → 20 s … up to 5 min (with ±25% jitter)
4. Cap: 10,000 readings or 7 days (older entries are pruned)

---

## Building the exe

```bat
cd agent
build.bat
```

Output: `agent\dist\VoltWatchAgent.exe`

Requirements: PyInstaller (`pip install pyinstaller`)

### Antivirus false positive

PyInstaller one-file executables are sometimes flagged by antivirus software (including Windows Defender) because they self-extract to a temp directory at startup — a technique also used by malware.

**This is a false positive.** To whitelist:

1. Open **Windows Security → Virus & threat protection → Exclusions**
2. Add the folder: `%LOCALAPPDATA%\VoltWatch\`
3. Or submit the exe to your AV vendor as a false positive

The agent requires **no admin rights**, no network drivers, and no kernel access.

---

## Running tests

```bat
cd agent
python -m pytest tests/ -v
```

Pure-function tests run on any platform (no Windows, no battery, no network required).

```
tests/test_battery_mt5.py              — battery parsers, AC detection, MT5
tests/test_client_queue_winevents.py   — payload builder, queue, backoff, sleep/shutdown
```

---

## Project layout

```
agent/
  voltwatch_agent/
    __init__.py       Package init + version string
    version.py        VERSION + BUILD_DATE (updated by build.bat)
    config.py         Load/save config, keyring token, autostart registry
    logging_setup.py  Rotating file log + token-redaction filter
    battery.py        Battery reading (psutil + PowerShell fallback)
    mt5.py            MT5 process detection
    client.py         HTTP client (heartbeat, batch, drift check)
    queue.py          SQLite offline queue + exponential backoff
    winevents.py      Sleep/resume detection, shutdown event log, WM_QUERYENDSESSION
    pairing.py        Tkinter first-run setup dialog
    tray.py           pystray tray icon + menu
    main.py           Orchestrator, sampling loop, startup, doctor mode
  tests/
    test_battery_mt5.py
    test_client_queue_winevents.py
  requirements.txt
  build.bat
  README.md
```
