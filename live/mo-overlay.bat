@echo off
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0mo-overlay.ps1"
timeout /t 4 >nul
