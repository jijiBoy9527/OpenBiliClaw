@echo off
setlocal
node "%~dp0scripts\research-workbench.mjs" --stop
if errorlevel 1 pause
