@echo off
setlocal

rem One-click entry point for the OBS music overlay. The bridge, Vite page,
rem and WASAPI helper are managed from this single launcher; OBS remains the
rem display host and is not bundled here.
if not defined BONGO_PROJECT_DIR set "BONGO_PROJECT_DIR=%~dp0.."
if not defined BONGO_AUDIO_CAPTURE if exist "%BONGO_PROJECT_DIR%\audio_capture-windows-x64.exe" set "BONGO_AUDIO_CAPTURE=%BONGO_PROJECT_DIR%\audio_capture-windows-x64.exe"

if not exist "%BONGO_PROJECT_DIR%\node_modules\.bin\tsx.cmd" (
  echo BongoCat runtime is missing: %BONGO_PROJECT_DIR%\node_modules\.bin\tsx.cmd
  echo Run pnpm install in the project directory first.
  exit /b 1
)

call "%BONGO_PROJECT_DIR%\node_modules\.bin\tsx.cmd" "%BONGO_PROJECT_DIR%\scripts\obsBongoBridge.ts" --spectrum --add-source %*
set "EXIT_CODE=%ERRORLEVEL%"
endlocal & exit /b %EXIT_CODE%
