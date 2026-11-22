@echo off
rem Fallback launcher with a visible console (shows logs). The desktop shortcut uses "Pocket Scribe Desktop.exe" instead.
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Run "Setup Pocket Scribe Desktop.bat" first.
  pause
  exit /b 1
)
".venv\Scripts\python.exe" run.py
pause
