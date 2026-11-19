@echo off
setlocal
node "%~dp0scripts\research-xhs.mjs" %*
exit /b %errorlevel%
