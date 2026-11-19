@echo off
setlocal
node "%~dp0scripts\research-workbench.mjs" --settings
if errorlevel 1 pause
