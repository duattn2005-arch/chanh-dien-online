@echo off
chcp 65001 >nul
echo Khởi động Chánh Điện Tịnh Tâm ngầm (không hiện cửa sổ)...
wscript.exe "%~dp0start-service.vbs"
timeout /t 2 >nul
echo Đã khởi động. Kiểm tra http://localhost:3000/live/overlay.html
pause
