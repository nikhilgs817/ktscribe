@echo off
rem Fallback launcher with a visible console (shows logs). The desktop shortcut uses "KT Scribe.exe" instead.
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Run "Setup KT Scribe.bat" first.
  pause
  exit /b 1
)
".venv\Scripts\python.exe" run.py
pause
