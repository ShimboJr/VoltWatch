# VoltWatch Pre-Travel Checklist

> Run this **at your trading desk, before you leave.** Takes < 5 minutes.
> Keep a copy on your phone (or save this page from the dashboard).

---

## ⚡ Power & hardware

- [ ] **Charger plugged in** and laptop shows charging (battery indicator not draining)
- [ ] **Power strip / UPS** is powered on and seated in the wall socket
- [ ] **Surge protector not tripped** — test with a phone charger if uncertain
- [ ] **Monitor / peripherals on separate circuit** from laptop charger where possible

---

## 💤 Windows sleep & hibernate settings

*(Control Panel → Power Options → Change plan settings → Change advanced power settings)*

- [ ] **Sleep: On battery → Never**
- [ ] **Sleep: Plugged in → Never**
- [ ] **Hibernate: On battery → Never**
- [ ] **Hibernate: Plugged in → Never**
- [ ] **Lid close action: On battery → Do nothing**
- [ ] **Lid close action: Plugged in → Do nothing**

> Fast path: `powercfg /change standby-timeout-dc 0 && powercfg /change standby-timeout-ac 0 && powercfg /change hibernate-timeout-dc 0 && powercfg /change hibernate-timeout-ac 0`

---

## 🔄 Windows Update

- [ ] **Active hours set** (e.g. 08:00–22:00) to prevent forced restarts while trading
- [ ] **Restart policy:** "Notify to schedule restart" (not automatic)
- [ ] No pending update requiring a restart right now

---

## 📊 MetaTrader 5

- [ ] **MT5 in Windows Startup** — check Task Manager → Startup tab
- [ ] MT5 is **open and showing live quotes**
- [ ] **AutoTrading button is ON** (green arrow icon, not grey)
- [ ] EA attached to the correct chart and showing smiley face (not sad face)

---

## 🤖 VoltWatch Agent

- [ ] **Agent is running** — check for the VoltWatch tray icon (⚡) in the system tray
- [ ] Dashboard Live screen shows **green "Online"** status for this laptop
- [ ] Battery % and AC status shown on Live screen **match what you see on the laptop**
- [ ] If agent is not in system tray: `cd C:\...\agent && python voltwatch_agent.py --api ... --token ...`

---

## 📱 Dashboard and alerts (on your phone)

- [ ] Open VoltWatch dashboard on phone — **Live screen loads and shows current data**
- [ ] **Alarm armed:** Settings → Alarm → Arm (button should show "✅ Armed")
- [ ] **Phone volume is NOT on silent** — critical alarm must be audible
- [ ] **VoltWatch notification permission is enabled** in phone Settings → Apps → VoltWatch → Notifications
- [ ] Push notifications enabled: Settings → Push notifications → Status shows "Active"
- [ ] Run a **test alert**: Settings → Alerts → Test alert → confirm sound, vibration and takeover appear

---

## 🔋 Thresholds review

- [ ] Alert thresholds set at: **50%, 30%, 20%, 15%** (or your preference)
- [ ] Critical level is **15%** (or lower than your lowest threshold)
- [ ] Quiet hours NOT covering your trading hours unless intentional

---

## 🏠 BIOS / firmware

- [ ] **"Power on after AC restore"** is enabled in BIOS (prevents laptop staying off after a power cut and restore)
  - Usually: BIOS → Power → AC Power Recovery → Power On (or Last State if laptop was on)

---

## 👥 Trusted person (optional but recommended)

- [ ] A person with physical access to the laptop location **knows they may get a call** if a critical alert fires and you cannot respond
- [ ] They know: plug the charger back in / check the power strip / restart the laptop if needed
- [ ] They have the building access needed to reach the laptop

---

## ✅ Final check — Live screen confirmation

Before you walk out:

1. Phone in hand → open VoltWatch → Live screen
2. Confirm: **green "Online" status, battery % plausible, AC connected ⚡**
3. Confirm: **alarm icon shows 🔔 Armed**
4. Walk out

---

*If any item is unchecked when you are about to leave, do not leave until it is resolved or you have accepted the risk and told your trusted contact.*
