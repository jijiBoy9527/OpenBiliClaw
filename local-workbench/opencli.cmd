@echo off
setlocal
node "%~dp0scripts\opencli.mjs" %*
exit /b %errorlevel%
