@echo off
:: VoltWatch Agent — PyInstaller build script
:: Run from the agent/ directory with:  build.bat
:: Requires: Python 3.11+, pip install -r requirements.txt

setlocal enabledelayedexpansion

:: ── Read version ──────────────────────────────────────────────────────────────
for /f "tokens=2 delims== " %%v in ('python -c "from voltwatch_agent.version import VERSION; print(VERSION)"') do (
    set VERSION=%%v
)
if "%VERSION%"=="" set VERSION=0.0.0

echo Building VoltWatch Agent v%VERSION%...

:: ── Stamp build date ──────────────────────────────────────────────────────────
for /f "tokens=1-3 delims=/ " %%a in ('date /t') do (
    set BUILD_DATE=%%c-%%a-%%b
)
python -c "
import re, pathlib
p = pathlib.Path('voltwatch_agent/version.py')
txt = p.read_text()
txt = re.sub(r'BUILD_DATE\s*=\s*\".*?\"', f'BUILD_DATE = \"%BUILD_DATE%\"', txt)
p.write_text(txt)
"

:: ── Run tests before building ─────────────────────────────────────────────────
echo.
echo Running tests...
python -m pytest tests/ -q --tb=short
if %errorlevel% neq 0 (
    echo.
    echo ERROR: Tests failed. Aborting build.
    exit /b 1
)

:: ── PyInstaller ───────────────────────────────────────────────────────────────
echo.
echo Packaging with PyInstaller...

pyinstaller ^
    --onefile ^
    --noconsole ^
    --name VoltWatchAgent ^
    --icon assets\icon.ico ^
    --add-data "voltwatch_agent;voltwatch_agent" ^
    --version-file version_info.txt ^
    --hidden-import keyring.backends.Windows ^
    --hidden-import pystray._win32 ^
    voltwatch_agent\main.py

if %errorlevel% neq 0 (
    echo.
    echo ERROR: PyInstaller failed.
    exit /b 1
)

:: ── Output ────────────────────────────────────────────────────────────────────
echo.
echo ============================================================
echo  Build complete!
echo  Output: dist\VoltWatchAgent.exe
echo  Version: %VERSION%
echo.
echo  NOTE: Windows Defender may flag the exe as suspicious.
echo  This is a common false positive with PyInstaller one-file
echo  builds. See README.md for antivirus whitelist instructions.
echo ============================================================

endlocal
