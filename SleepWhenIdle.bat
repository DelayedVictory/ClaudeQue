@echo off
rem Sleep the PC once every Claude Code session has emptied its queue and gone
rem quiet. Double-click to run; close the window or press Ctrl+C to cancel.
rem
rem   SleepWhenIdle.bat            wait 15 minutes of quiet, then sleep
rem   SleepWhenIdle.bat 30         wait 30 minutes of quiet instead
rem   SleepWhenIdle.bat 15 test    report only, never sleep
rem
rem %~dp0 is this file's folder, so it works wherever the repo lives. It ends
rem in a backslash, hence the trailing "." - "...\" would escape the quote.

setlocal
set MINUTES=%~1
if "%MINUTES%"=="" set MINUTES=15

set DRY=
if /i "%~2"=="test" set DRY=--dry-run

title ClaudeQue - sleep when idle
node "%~dp0src\sleep-when-idle.js" --minutes %MINUTES% %DRY%

rem Only reached if the script exits on its own or is cancelled.
echo.
pause
