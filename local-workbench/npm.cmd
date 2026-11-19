@echo off
setlocal
node "%~dp0scripts\npm.mjs" %*
exit /b %errorlevel%
