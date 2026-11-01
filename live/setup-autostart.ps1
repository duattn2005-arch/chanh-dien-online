# Setup Windows Autostart for Chánh Điện Tịnh Tâm
# Registers HKCU Run key, Startup folder shortcut, and attempts Task Scheduler registration

$ErrorActionPreference = 'Continue'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$VbsPath = Join-Path $ScriptDir "start-service.vbs"
$TaskName = "ChanhDienTinhTam-AutoStart"

Write-Host "1. Cấu hình Registry HKCU Run..."
$RegPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$RegCmd = "wscript.exe `"$VbsPath`""
Set-ItemProperty -Path $RegPath -Name $TaskName -Value $RegCmd
Write-Host "   -> Đã gán $TaskName trong $RegPath"

Write-Host "2. Tạo Shortcut trong thư mục Windows Startup..."
$StartupDir = [Environment]::GetFolderPath('Startup')
$WshShell = New-Object -ComObject WScript.Shell
$ShortcutPath = Join-Path $StartupDir "$TaskName.lnk"
$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = "wscript.exe"
$Shortcut.Arguments = "`"$VbsPath`""
$Shortcut.WorkingDirectory = $ScriptDir
$Shortcut.Description = "Tự động khởi động Chánh Điện Tịnh Tâm (Full HD TikTok LIVE)"
$Shortcut.Save()
Write-Host "   -> Đã tạo shortcut tại $ShortcutPath"

Write-Host "3. Thử đăng ký Windows Task Scheduler ($TaskName)..."
$SchCmd = "schtasks /create /tn `"$TaskName`" /tr `"wscript.exe \`"$VbsPath\`"`" /sc onlogon /f 2>&1"
$res = Invoke-Expression $SchCmd
Write-Host "   -> Kết quả: $res"

Write-Host "`nĐã hoàn thành cấu hình tự khởi động Windows vĩnh viễn!"

