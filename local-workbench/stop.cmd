@echo off
setlocal
"%~dp0runtime\node-v22.19.0-win-x64\node.exe" "%~dp0scripts\research-workbench.mjs" --stop
if errorlevel 1 (
  pause
  exit /b 1
)
"%~dp0runtime\node-v22.19.0-win-x64\node.exe" "%~dp0scripts\workspace.mjs" stop
if errorlevel 1 pause
