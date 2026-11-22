@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Pocket Scribe Desktop - setup
cd /d "%~dp0"
set "ROOT=%~dp0"
set "STATUS=%ROOT%setup_status.txt"
echo STARTED %DATE% %TIME%> "%STATUS%"

echo.
echo   Pocket Scribe Desktop setup  (first run takes 5-10 minutes, needs internet)
echo   ----------------------------------------------------------------

rem ---------- 1. Python 3.11 / 3.12 / 3.13 (faster-whisper has no wheels for 3.14 yet)
set "PY="
for %%v in (3.12 3.11 3.13) do call :trypy %%v
if defined PY goto havepy

echo   Python 3.11-3.13 not found - installing Python 3.12 with winget...
echo STEP python-install>> "%STATUS%"
winget install -e --id Python.Python.3.12 --scope user --silent --accept-package-agreements --accept-source-agreements
call :trypy 3.12
if defined PY goto havepy
if exist "%LocalAppData%\Programs\Python\Python312\python.exe" set "PY=%LocalAppData%\Programs\Python\Python312\python.exe"
if defined PY goto havepy
echo FAILED no-python>> "%STATUS%"
echo.
echo   Could not find or install Python. Install Python 3.12 from python.org, then run this file again.
pause
exit /b 1

:havepy
echo   Using Python: %PY%
echo STEP venv python=%PY%>> "%STATUS%"

rem ---------- 2. virtual environment + packages
if not exist ".venv\Scripts\python.exe" (
  %PY% -m venv .venv
  if errorlevel 1 goto fail
)
echo STEP packages>> "%STATUS%"
".venv\Scripts\python.exe" -m pip install --upgrade pip
".venv\Scripts\python.exe" -m pip install -r requirements.txt pyinstaller
if errorlevel 1 goto fail

rem ---------- 3. build "Pocket Scribe Desktop.exe" (small launcher; the app itself stays in this folder)
echo STEP build-exe>> "%STATUS%"
".venv\Scripts\python.exe" -m PyInstaller --noconfirm --onefile --noconsole --name "Pocket Scribe Desktop" --icon "%ROOT%pocket-scribe.ico" --distpath "%ROOT%." --workpath "%ROOT%build" --specpath "%ROOT%build" "%ROOT%launcher.py"
if errorlevel 1 goto fail
if not exist "%ROOT%Pocket Scribe Desktop.exe" goto fail

rem ---------- 4. Desktop + Start menu shortcuts
echo STEP shortcuts>> "%STATUS%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\install-shortcuts.ps1"
if errorlevel 1 goto fail

rem ---------- 5. finish
echo DONE>> "%STATUS%"
echo.
echo   Done!  Use the "Pocket Scribe Desktop" icon on your Desktop.
echo   (This window closes in 8 seconds.)
timeout /t 8 >nul
exit /b 0

:fail
echo FAILED see-console>> "%STATUS%"
echo.
echo   Setup failed - scroll up for the error. You can run this file again safely.
pause
exit /b 1

:trypy
if defined PY goto :eof
py -%1 -c "import sys" >nul 2>&1
if not errorlevel 1 set "PY=py -%1"
goto :eof
