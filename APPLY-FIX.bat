@echo off
setlocal
node "%~dp0Apply-YediHub-All-Fixes.cjs"
set "RESULT=%ERRORLEVEL%"
echo.
if not "%RESULT%"=="0" echo The patch did not complete. Do not commit or push; send the error text instead.
pause
exit /b %RESULT%
