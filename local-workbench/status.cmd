@echo off
setlocal
node "%~dp0scripts\research-workbench.mjs" --status
node "%~dp0scripts\workspace.mjs" status
pause
