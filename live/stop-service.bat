@echo off
chcp 65001 >nul
echo Đang dừng dịch vụ Chánh Điện Tịnh Tâm...
powershell -NoProfile -Command ^
  "$pids = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*supervisor.mjs*' -or $_.CommandLine -like '*server.mjs*' } | Select-Object -ExpandProperty ProcessId); foreach ($p in $pids) { try { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue } catch {} }"
echo Đã dừng tất cả tiến trình Chánh Điện Tịnh Tâm.
timeout /t 2 >nul
