@echo off
rem Start the RacroS III recorder in the background (no console window).
rem Prefer the venv in this folder (office\.venv); fall back to pythonw on PATH.
cd /d "%~dp0"
if exist "%~dp0.venv\Scripts\pythonw.exe" (
  start "" "%~dp0.venv\Scripts\pythonw.exe" -m recorder run
) else (
  start "" pythonw -m recorder run
)
