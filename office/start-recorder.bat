@echo off
rem Start the RacroS III recorder in the background (no console window).
cd /d "%~dp0"
start "" pythonw -m recorder run
