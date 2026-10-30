# VoltWatch — Screenshots Needed

> Capture these screenshots on a real device (or using the simulator with seeded data) and save them as the exact filenames listed below. The README embeds them from this folder.

---

## Required screenshots

| Filename | Screen | Notes |
|----------|--------|-------|
| `live.png` | **Live screen** | Show green ONLINE status, battery gauge at ~75%, AC connected ⚡, MT5 running |
| `critical-alarm.png` | **Critical battery takeover** | Full-screen red takeover overlay with percentage, "Connect charger immediately", Acknowledge / Snooze buttons |
| `history-chart.png` | **History chart** | 24 h battery % line chart with AC bands and MT5 strip below |
| `timeline.png` | **Timeline (Events)** | A mix of power events: AC_DISCONNECTED, LOW_BATTERY, HEARTBEAT_RECOVERED |
| `insights.png` | **Insights** | 7-day stats cards: time on battery, avg %, power cuts, MT5 uptime |
| `alerts-inbox.png` | **Alerts inbox** | Active alerts tab with at least one LOW_BATTERY and one HEARTBEAT_LOST card |
| `agent-tray.png` | **Agent tray icon** | Windows 11 system tray showing the VoltWatch ⚡ icon; right-click menu visible if possible |

---

## How to capture with the simulator

```powershell
# 1. Seed 30 days of realistic history (once)
npm run seed -- --token YOUR_DEVICE_TOKEN

# 2. Open the dashboard at https://your-voltwatch.vercel.app/app
#    Navigate to each screen and take a screenshot.

# 3. To capture a critical alarm:
npm run sim -- --token YOUR_DEVICE_TOKEN --scenario power-cut --speed 120
#    Wait until the dashboard shows the red takeover, then screenshot.
```

---

## Tips

- Use a phone (or Chrome DevTools mobile emulation at 390 × 844) for a realistic mobile-first look.
- Dark theme is the default; screenshots in dark mode look best in the README.
- Crop to the screen content — no browser chrome needed.
- PNG is preferred; keep file sizes reasonable (< 500 KB each).
