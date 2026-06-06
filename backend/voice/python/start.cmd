@echo off
REM Inicia el servicio XTTS-v2 de clonacion de voz para Jarvis.
REM Por defecto escucha en http://127.0.0.1:8789
REM Override con: set XTTS_PORT=9000

set COQUI_TOS_AGREED=1
cd /d "%~dp0"
".venv\Scripts\python.exe" xtts_service.py
