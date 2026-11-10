# Installs Mikrotik Traffic Control for the current Windows user (no administrator rights needed).   (c) Kish IT - https://kish-it.com
#   powershell -ExecutionPolicy Bypass -File install.ps1
# Options:
#   -TargetDir <path>     install here (default %LOCALAPPDATA%\Programs\Mikrotik Traffic Control)
#   -StartWithWindows     start the tray agent when you sign in
#   -NoShortcuts          no Start Menu / Desktop shortcuts
#   -NoLaunch             do not start the program at the end
#   -InstallNode          install Node.js LTS with winget if no suitable Node.js is found (without asking)
# Data (history, settings, encrypted router logins) lives in %LOCALAPPDATA%\Mikrotik Traffic Control\data and is kept on upgrade / uninstall.
param([string]$TargetDir = (Join-Path $env:LOCALAPPDATA 'Programs\Mikrotik Traffic Control'), [switch]$StartWithWindows, [switch]$NoShortcuts, [switch]$NoLaunch, [switch]$InstallNode)
$ErrorActionPreference = 'Stop'
$src = Split-Path $PSScriptRoot -Parent
if (-not (Test-Path (Join-Path $src 'src\manager.js'))) { throw "Run this script from the unpacked release (src\manager.js not found next to windows\)." }

Write-Host "`nMikrotik Traffic Control - installer  (c) Kish IT`n" -ForegroundColor Cyan

# 1. Node.js (bundled runtime, or 22.5+ on PATH)
$needNode = -not (Test-Path (Join-Path $src 'runtime\node.exe'))
if ($needNode) {
    $ok = $false
    $c = Get-Command node -ErrorAction SilentlyContinue
    if ($c) { $v = ((& $c.Source --version) -replace '^v', '').Split('.') | ForEach-Object { [int]$_ }; $ok = ($v[0] -gt 22) -or ($v[0] -eq 22 -and $v[1] -ge 5) }
    if (-not $ok) {
        Write-Host 'Node.js 22.5 or newer is required (this package does not bundle it).' -ForegroundColor Yellow
        $w = Get-Command winget -ErrorAction SilentlyContinue
        if ($w -and ($InstallNode -or (Read-Host 'Install Node.js LTS now with winget? (y/n)') -match '^[yY]')) {
            winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
            $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
            if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js was installed but is not on PATH yet: open a new PowerShell window and run this script again.' }
        } else { throw 'Install Node.js (https://nodejs.org, LTS) and run this script again.' }
    }
}

# 2. stop a running copy, then copy the files (never touches the data folder)
$stop = Join-Path $TargetDir 'windows\Stop-MTC.ps1'
if (Test-Path $stop) { try { & $stop | Out-Null } catch { } }
Write-Host "Copying files to $TargetDir ..."
New-Item -ItemType Directory -Force $TargetDir | Out-Null
$xd = @('.git', 'data', 'data-demo', 'node_modules', 'dist', 'test', 'i18n-src', '.github')
& robocopy $src $TargetDir /E /NFL /NDL /NJH /NJS /NP /XD $xd /XF '*.tmp.js' | Out-Null
if ($LASTEXITCODE -ge 8) { throw "File copy failed (robocopy exit code $LASTEXITCODE)." }
$data = Join-Path $env:LOCALAPPDATA 'Mikrotik Traffic Control\data'; New-Item -ItemType Directory -Force $data | Out-Null

# 3. shortcuts
. (Join-Path $TargetDir 'windows\common.ps1')
$ico = Join-Path $TargetDir 'windows\mtc.ico'; try { Save-MtcIco $ico } catch { $ico = "$env:SystemRoot\System32\shell32.dll,238" }
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$tray = Join-Path $TargetDir 'windows\Tray-MTC.ps1'
function New-Lnk($path, $args2) { $s = (New-Object -ComObject WScript.Shell).CreateShortcut($path); $s.TargetPath = $ps; $s.Arguments = $args2; $s.WorkingDirectory = Join-Path $TargetDir 'windows'; $s.WindowStyle = 7; $s.IconLocation = $ico; $s.Description = 'Mikrotik Traffic Control'; $s.Save() }
if (-not $NoShortcuts) {
    $menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Mikrotik Traffic Control'; New-Item -ItemType Directory -Force $menu | Out-Null
    New-Lnk (Join-Path $menu 'Mikrotik Traffic Control.lnk') "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -STA -File `"$tray`" -OpenDashboard"
    New-Lnk (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Mikrotik Traffic Control.lnk') "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -STA -File `"$tray`" -OpenDashboard"
    $un = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $menu 'Uninstall.lnk')); $un.TargetPath = $ps; $un.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $TargetDir 'windows\uninstall.ps1')`""; $un.Save()
}
if ($StartWithWindows) { New-Lnk (Join-Path ([Environment]::GetFolderPath('Startup')) 'Mikrotik Traffic Control (tray).lnk') "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -STA -File `"$tray`" -NoSplash" }

Write-Host "`nInstalled. Data folder: $data" -ForegroundColor Green
Write-Host 'On first start the setup guide opens in your browser: it connects your MikroTik router in a few minutes.'
if (-not $NoLaunch) { Start-Process $ps -WindowStyle Hidden -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-STA', '-File', "`"$tray`"", '-OpenDashboard' }
