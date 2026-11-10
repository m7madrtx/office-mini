@echo off
rem Office Mini - double-click to stop the server.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "server\stop.ps1"
rem short pause so you can read the message before the window closes
ping -n 4 127.0.0.1 >nul
