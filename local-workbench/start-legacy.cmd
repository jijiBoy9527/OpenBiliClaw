@echo off
setlocal
"%~dp0runtime\node-v22.19.0-win-x64\node.exe" "%~dp0scripts\workspace.mjs" start
if errorlevel 1 pause
