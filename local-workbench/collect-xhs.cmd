@echo off
setlocal
node "%~dp0scripts\collect-xhs.mjs" %*
exit /b %errorlevel%
