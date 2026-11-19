@echo off
setlocal
node "%~dp0scripts\xhs-safety.mjs" %*
exit /b %errorlevel%
