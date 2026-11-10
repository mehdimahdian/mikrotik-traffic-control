# Shared helpers for the Windows launchers (dot-sourced).   (c) Kish IT - https://kish-it.com
# Layout: this file lives in <root>\windows\. <root> holds src\, routeros\, docs\, and (installed builds) runtime\node.exe.

$script:Root = Split-Path $PSScriptRoot -Parent
$script:Port = if ($env:MTC_PORT) { [int]$env:MTC_PORT } else { 8787 }
$script:Url  = "http://127.0.0.1:$($script:Port)"
$script:AppName = 'Mikrotik Traffic Control'

# Data directory: MTC_DATA, or <root>\data when <root>\portable.flag exists, else %LOCALAPPDATA%\Mikrotik Traffic Control\data
function Get-MtcData {
    if ($env:MTC_DATA) { return $env:MTC_DATA }
    if (Test-Path (Join-Path $script:Root 'portable.flag')) { return (Join-Path $script:Root 'data') }
    return (Join-Path $env:LOCALAPPDATA 'Mikrotik Traffic Control\data')
}

# Node.js: the bundled runtime if present, otherwise the one on PATH (needs 22.5 or newer for node:sqlite)
function Get-MtcNode {
    $bundled = Join-Path $script:Root 'runtime\node.exe'
    if (Test-Path $bundled) { return $bundled }
    $c = Get-Command node -ErrorAction SilentlyContinue
    if (-not $c) { return $null }
    $v = (& $c.Source --version) -replace '^v', ''
    $p = $v.Split('.') | ForEach-Object { [int]$_ }
    if ($p[0] -lt 22 -or ($p[0] -eq 22 -and $p[1] -lt 5)) { throw "Node.js $v is too old: version 22.5 or newer is required (https://nodejs.org)." }
    return $c.Source
}

function Test-MtcUp { try { Invoke-RestMethod "$($script:Url)/api/settings" -TimeoutSec 2 | Out-Null; $true } catch { $false } }

# Our processes, found by command line (never touches other node processes)
function Get-MtcProcesses {
    $pat = [regex]::Escape((Join-Path $script:Root 'src')) + '\\(manager|server)\.js'
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match $pat }
}

function Start-Mtc {
    param([switch]$Restart)
    if ($Restart) { Get-MtcProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Start-Sleep -Milliseconds 1000 }
    if (Test-MtcUp) { return }
    $node = Get-MtcNode
    if (-not $node) { throw 'Node.js was not found. Install it from https://nodejs.org (version 22.5 or newer) or use the installer that bundles it.' }
    $data = Get-MtcData; New-Item -ItemType Directory -Force $data | Out-Null
    $env:MTC_DATA = $data
    $log = Join-Path $data 'manager.log'
    Start-Process -FilePath $node -ArgumentList ('"' + (Join-Path $script:Root 'src\manager.js') + '"') -WorkingDirectory $script:Root -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError ($log + '.err')
    for ($i = 0; $i -lt 60 -and -not (Test-MtcUp); $i++) { Start-Sleep -Milliseconds 250 }
    if (-not (Test-MtcUp)) { throw "The program did not start; see $log.err" }
}

function Open-MtcDashboard {
    $browsers = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LocalAppData\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ }
    if ($browsers) { Start-Process -FilePath $browsers[0] -ArgumentList "--app=$($script:Url)", "--user-data-dir=`"$(Join-Path (Get-MtcData) 'browser-profile')`"", '--window-size=1320,860' }
    else { Start-Process $script:Url }
}

# The program icon, drawn with GDI+ (blue rounded square with a rising traffic line)
function New-MtcBitmap([int]$size) {
    Add-Type -AssemblyName System.Drawing
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp); $g.SmoothingMode = 'AntiAlias'; $g.Clear([System.Drawing.Color]::Transparent)
    $s = $size / 128.0
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath; $r = 26 * $s; $x = 6 * $s; $w = 116 * $s
    $path.AddArc($x, $x, $r, $r, 180, 90); $path.AddArc($x + $w - $r, $x, $r, $r, 270, 90); $path.AddArc($x + $w - $r, $x + $w - $r, $r, $r, 0, 90); $path.AddArc($x, $x + $w - $r, $r, $r, 90, 90); $path.CloseFigure()
    $br = New-Object System.Drawing.Drawing2D.LinearGradientBrush ([System.Drawing.PointF]::new(0, 0)), ([System.Drawing.PointF]::new($size, $size)), ([System.Drawing.Color]::FromArgb(42, 125, 225)), ([System.Drawing.Color]::FromArgb(19, 73, 168))
    $g.FillPath($br, $path)
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), (8 * $s); $pen.StartCap = 'Round'; $pen.EndCap = 'Round'; $pen.LineJoin = 'Round'
    $g.DrawLines($pen, [System.Drawing.PointF[]]@([System.Drawing.PointF]::new(22 * $s, 88 * $s), [System.Drawing.PointF]::new(46 * $s, 62 * $s), [System.Drawing.PointF]::new(64 * $s, 76 * $s), [System.Drawing.PointF]::new(90 * $s, 44 * $s), [System.Drawing.PointF]::new(106 * $s, 56 * $s)))
    $pen2 = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 169, 77)), (8 * $s); $pen2.StartCap = 'Round'; $pen2.EndCap = 'Round'; $pen2.LineJoin = 'Round'
    $g.DrawLines($pen2, [System.Drawing.PointF[]]@([System.Drawing.PointF]::new(86 * $s, 40 * $s), [System.Drawing.PointF]::new(108 * $s, 40 * $s), [System.Drawing.PointF]::new(108 * $s, 62 * $s)))
    $g.Dispose(); return $bmp
}
function New-MtcIcon { $b = New-MtcBitmap 32; [System.Drawing.Icon]::FromHandle($b.GetHicon()) }
function Save-MtcIco([string]$path) { $i = New-MtcIcon; $fs = [System.IO.File]::Create($path); $i.Save($fs); $fs.Close() }

# Splash screen with the Kish IT copyright (shown for about 2 seconds)
function Show-MtcSplash {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $f = New-Object System.Windows.Forms.Form
    $f.FormBorderStyle = 'None'; $f.StartPosition = 'CenterScreen'; $f.Size = New-Object System.Drawing.Size 480, 290; $f.TopMost = $true; $f.ShowInTaskbar = $false; $f.BackColor = [System.Drawing.Color]::White
    $logo = New-MtcBitmap 96
    $f.Add_Paint({
        param($s, $e)
        $e.Graphics.SmoothingMode = 'AntiAlias'; $e.Graphics.TextRenderingHint = 'ClearTypeGridFit'
        $e.Graphics.DrawImage($logo, 192, 22, 96, 96)
        $sf = New-Object System.Drawing.StringFormat; $sf.Alignment = 'Center'
        $e.Graphics.DrawString('Mikrotik Traffic Control', (New-Object System.Drawing.Font 'Segoe UI Semibold', 20), [System.Drawing.Brushes]::Black, (New-Object System.Drawing.RectangleF 0, 128, 480, 40), $sf)
        $e.Graphics.DrawString("Live traffic, quotas, bandwidth control, guest Wi-Fi and security`nfor MikroTik networks", (New-Object System.Drawing.Font 'Segoe UI', 10), [System.Drawing.Brushes]::DimGray, (New-Object System.Drawing.RectangleF 0, 168, 480, 44), $sf)
        $e.Graphics.DrawString(('(c) {0} Kish IT  -  kish-it.com' -f (Get-Date).Year), (New-Object System.Drawing.Font 'Segoe UI', 9), [System.Drawing.Brushes]::Gray, (New-Object System.Drawing.RectangleF 0, 254, 480, 24), $sf)
        $e.Graphics.DrawRectangle((New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(205, 213, 224))), 0, 0, 479, 289)
    })
    $t = New-Object System.Windows.Forms.Timer; $t.Interval = 2200; $t.Add_Tick({ $t.Stop(); $f.Close() }); $t.Start()
    [void]$f.ShowDialog()
}
