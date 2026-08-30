@echo off
setlocal
cd /d "%~dp0.."
call "%~dp0..\node_modules\.bin\tsx.cmd" "%~dp0obsBongoBridge.ts" %*
endlocal
