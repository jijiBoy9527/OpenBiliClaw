@echo off
setlocal
node "%~dp0scripts\research-workbench.mjs" %*
if errorlevel 1 pause
