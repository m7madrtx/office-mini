@echo off
rem Office Mini - double-click to start. Close this window to stop.
cd /d "%~dp0"
if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo Created .env from .env.example. Add your OpenRouter key to it, then start again.
  notepad ".env"
  pause
  goto :eof
)
if not exist ".venv\Scripts\python.exe" (
  echo First run: setting up the Python environment...
  python -m venv .venv || goto :fail
  ".venv\Scripts\python.exe" -m pip install -q --disable-pip-version-check -r requirements.txt || goto :fail
)
start "" cmd /c "timeout /t 3 >nul & start http://127.0.0.1:8765"
".venv\Scripts\python.exe" -m server.app
goto :eof
:fail
echo Setup failed. Make sure Python 3.11+ is installed and on PATH.
pause
