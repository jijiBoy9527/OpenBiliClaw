@echo off
setlocal
node "%~dp0scripts\workspace.mjs" start
if errorlevel 1 pause
