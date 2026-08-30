@echo off
setlocal

rem One-click entry point for the BongoCat OBS music overlay bundle.
rem OBS remains an external display host; all project files and the optional
rem WASAPI helper live beside this launcher when the bundle is staged.
set "BONGO_PROJECT_DIR=%~dp0"
if not defined BONGO_AUDIO_CAPTURE if exist "%BONGO_PROJECT_DIR%audio_capture-windows-x64.exe" set "BONGO_AUDIO_CAPTURE=%BONGO_PROJECT_DIR%audio_capture-windows-x64.exe"

if not exist "%BONGO_PROJECT_DIR%scripts\launch-bongocat-obs.cmd" (
  echo BongoCat project files are incomplete under:
  echo %BONGO_PROJECT_DIR%
  exit /b 1
)

call "%BONGO_PROJECT_DIR%scripts\launch-bongocat-obs.cmd" %*
set "EXIT_CODE=%ERRORLEVEL%"
endlocal & exit /b %EXIT_CODE%
