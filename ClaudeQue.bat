@echo off
rem Launch ClaudeQue and exit immediately, so no console window hangs around.
rem %~dp0 is this file's folder, so the batch file works wherever the repo lives.
rem Note the trailing "." — %~dp0 ends in a backslash, and "...\" would escape
rem the closing quote and corrupt the argument.
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
