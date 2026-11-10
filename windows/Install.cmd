@echo off
rem Mikrotik Traffic Control - double-click to install for the current user (no administrator rights needed).
rem (c) Kish IT - https://kish-it.com
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
