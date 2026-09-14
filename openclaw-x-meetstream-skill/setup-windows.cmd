@echo off
setlocal
title MeetStream for OpenClaw Setup

echo MeetStream for OpenClaw
echo =======================
echo.

where wsl.exe >nul 2>&1
if errorlevel 1 (
  echo WSL2 is not installed yet.
  echo.
  echo Open PowerShell as Administrator, run:
  echo   wsl --install -d Ubuntu-24.04
  echo.
  echo Restart Windows if requested, finish Ubuntu setup, then double-click
  echo this file again.
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%I in ('wsl.exe wslpath -a "%~dp0."') do set "WSL_SETUP_PATH=%%I"
if not defined WSL_SETUP_PATH (
  echo WSL2 could not open this project folder.
  echo Move the folder into your Ubuntu home directory and try again.
  echo.
  pause
  exit /b 1
)

wsl.exe --cd "%WSL_SETUP_PATH%" bash ./install.sh
set "SETUP_STATUS=%ERRORLEVEL%"
echo.
if "%SETUP_STATUS%"=="0" (
  echo Setup finished successfully. You can close this window.
  echo Open OpenClaw and say: Show me the MIA agents I can use.
) else (
  echo Setup stopped with an error. Review the message above.
  echo Make sure OpenClaw is installed and onboarded inside WSL2.
)
echo.
pause
exit /b %SETUP_STATUS%
