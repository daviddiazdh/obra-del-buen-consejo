@echo off
rem Asistente de instalacion - Obra del Buen Consejo.
rem Doble clic en este archivo. Windows pedira permiso de administrador.
rem -ExecutionPolicy Bypass solo afecta a esta ejecucion; no cambia la
rem configuracion de seguridad del equipo.
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0instalar-windows.ps1"
