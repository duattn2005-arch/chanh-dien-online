@echo off
:: Self-elevating script to install ChanhDienTinhTam-AutoStart into Windows Task Scheduler
chcp 65001 >nul
net session >nul 2>&1
if %errorLevel% == 0 (
    goto :admin
) else (
    echo Yêu cầu quyền Administrator để cài Task Scheduler...
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

:admin
cd /d "%~dp0"
echo Đang đăng ký tác vụ ChanhDienTinhTam-AutoStart vào Windows Task Scheduler...
schtasks /create /tn "ChanhDienTinhTam-AutoStart" /tr "wscript.exe \"%~dp0start-service.vbs\"" /sc onlogon /rl highest /f
if %errorLevel% == 0 (
    echo [THÀNH CÔNG] Đã tạo tác vụ ChanhDienTinhTam-AutoStart trong Task Scheduler!
) else (
    echo [LỖI] Không thể tạo tác vụ trong Task Scheduler.
)
timeout /t 5

