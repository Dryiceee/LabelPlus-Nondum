@echo off
:: Installs LabelPlus-Nondum: double-click this file. Creative Cloud is not needed.
cd /d "%~dp0" || exit /b 1

:: PowerShell with the execution policy bypassed for this script only
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\install.ps1" -Uxp %*
exit /b %errorlevel%
