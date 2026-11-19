@echo off
setlocal
node "%~dp0scripts\collect-xhs-comments.mjs" %*
exit /b %errorlevel%
