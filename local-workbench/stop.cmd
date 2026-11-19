@echo off
setlocal
node "%~dp0scripts\research-workbench.mjs" --stop
if errorlevel 1 (
  pause
  exit /b 1
)
node "%~dp0scripts\workspace.mjs" stop
if errorlevel 1 pause
