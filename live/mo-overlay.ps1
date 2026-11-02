# Opens the overlay for streaming, in its own browser so it stays sharp and smooth:
#  - as large as Windows allows, in exact 9:16, so the capture needs little or no upscaling
#  - keeps drawing when covered by another window (a normal browser pauses and the stream stutters)
#  - apart from the other tabs, and with sound on from the start
$Url = 'http://localhost:3000/live/overlay.html?auto=1&fps=30'
$Browser = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $Browser) { Write-Host 'Không tìm thấy Chrome hoặc Edge.'; Read-Host 'Nhấn Enter để đóng'; exit 1 }
try { $null = Invoke-WebRequest 'http://localhost:3000/live/overlay.html' -UseBasicParsing -TimeoutSec 3 } catch { Write-Host 'Server chưa chạy. Hãy chạy npm start trong thư mục live trước.'; Read-Host 'Nhấn Enter để đóng'; exit 1 }

Add-Type @'
using System; using System.Runtime.InteropServices;
public class OverlayWindow {
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L,T,Ri,B; }
  public delegate bool Cb(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool EnumWindows(Cb c, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int ht, uint f);
}
'@
[void][OverlayWindow]::SetProcessDPIAware()
$Profile_ = Join-Path $env:LOCALAPPDATA 'ChanhDienOverlay'
$Exe = Split-Path $Browser -Leaf
$null = Start-Process -FilePath $Browser -ArgumentList @("--user-data-dir=`"$Profile_`"", '--no-first-run', '--no-default-browser-check', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--autoplay-policy=no-user-gesture-required', '--force-device-scale-factor=1', '--window-position=0,0', "--app=$Url")

$script:Win = [IntPtr]::Zero
foreach ($try in 1..30) {
  Start-Sleep -Milliseconds 500
  $ids = @(Get-CimInstance Win32_Process -Filter "Name='$Exe'" | Where-Object { $_.CommandLine -like '*ChanhDienOverlay*' } | ForEach-Object { [int]$_.ProcessId })
  [void][OverlayWindow]::EnumWindows({ param($w, $l) $o = 0; [void][OverlayWindow]::GetWindowThreadProcessId($w, [ref]$o); if ($ids -contains [int]$o -and [OverlayWindow]::IsWindowVisible($w)) { $r = New-Object OverlayWindow+R; [void][OverlayWindow]::GetWindowRect($w, [ref]$r); if (($r.Ri - $r.L) -gt 200) { $script:Win = $w } }; $true }, [IntPtr]::Zero)
  if ($script:Win -ne [IntPtr]::Zero) { break }
}
if ($script:Win -eq [IntPtr]::Zero) { Write-Host 'Không mở được cửa sổ overlay.'; Read-Host 'Nhấn Enter để đóng'; exit 1 }

function Fit([int]$W, [int]$H) {
  $r = New-Object OverlayWindow+R; $c = New-Object OverlayWindow+R
  [void][OverlayWindow]::GetWindowRect($script:Win, [ref]$r); [void][OverlayWindow]::GetClientRect($script:Win, [ref]$c)
  [void][OverlayWindow]::SetWindowPos($script:Win, [IntPtr]::Zero, 0, 0, $W + ($r.Ri - $r.L) - $c.Ri, $H + ($r.B - $r.T) - $c.B, 0x14)
  Start-Sleep -Milliseconds 700
  [void][OverlayWindow]::GetClientRect($script:Win, [ref]$c); return $c
}
# Ask for 720x1280 of picture; Windows stops at what the screen allows, then the width is set to keep exactly 9:16.
# In an app window the browser draws its own title bar inside the client area.
$TitleBar = 31
$c = Fit 720 (1280 + $TitleBar)
$h = $c.B - $TitleBar
$c = Fit ([math]::Round($h * 9 / 16)) $c.B
Write-Host "Overlay đã mở, vùng hình $($c.Ri)x$($c.B - $TitleBar)."
