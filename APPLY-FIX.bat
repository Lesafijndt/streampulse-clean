@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js was not found. Install Node.js, then run this again.
  echo No source files were changed.
  pause
  exit /b 1
)
node Apply-YediHub-Reliable-Fix.cjs
if errorlevel 1 (
  echo.
  echo Patch stopped. No files were written.
  echo Do not commit this attempt. Send the complete error message.
) else (
  echo.
  echo Next: run npm run build. Commit/push only if the build succeeds.
)
echo.
pause
