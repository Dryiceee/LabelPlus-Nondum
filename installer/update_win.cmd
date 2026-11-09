@echo off
:: Updates LabelPlus-Nondum without opening Photoshop: downloads the latest
:: release, checks it and installs it (installer\get.ps1). Close Photoshop first.
:: Your styles and settings are kept.
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0get.ps1"
set "UPDATE_EXIT_CODE=%ERRORLEVEL%"
if /I "%~1"=="--silent" exit /b %UPDATE_EXIT_CODE%
echo.
pause
exit /b %UPDATE_EXIT_CODE%
