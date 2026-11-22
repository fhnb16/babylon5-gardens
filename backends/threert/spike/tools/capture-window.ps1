# Captures the ThreeRT client window (picture + the app-drawn HUD, which `threert shot` does not include) to a PNG.
#   ./tools/capture-window.ps1 shots/h_hud.png
param([Parameter(Mandatory = $true)][string]$Out)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class B5Win {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
[void][B5Win]::SetProcessDPIAware()
$p = Get-Process ThreeRT -ErrorAction Stop | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
$h = $p.MainWindowHandle
[void][B5Win]::ShowWindow($h, 9)   # SW_RESTORE
[void][B5Win]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 800
$r = New-Object B5Win+RECT
[void][B5Win]::GetWindowRect($h, [ref]$r)
$w = $r.R - $r.L; $hh = $r.B - $r.T
$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp)
# Screen copy (what is on the display, HUD overlay included); PrintWindow(PW_RENDERFULLCONTENT) as the fallback.
$g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
$g.Dispose()
$full = [IO.Path]::GetFullPath((Join-Path (Get-Location) $Out))
$bmp.Save($full, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
"$full ${w}x${hh}"
