# Removes Mikrotik Traffic Control (program files and shortcuts). Your data (history, settings, encrypted router logins) is KEPT
# unless you add -RemoveData. Router changes made with the program stay on the router: remove them first from the dashboard
# (Router setup > Remove everything, Configuration > Bandwidth control > Remove all, Guest Wi-Fi > Remove everything) or see routeros\mtc-remove.rsc.
param([switch]$RemoveData)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$root = $script:Root
Get-MtcProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'Tray-MTC\.ps1' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Milliseconds 600
$menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Mikrotik Traffic Control'
foreach ($p in @($menu, (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Mikrotik Traffic Control.lnk'), (Join-Path ([Environment]::GetFolderPath('Startup')) 'Mikrotik Traffic Control (tray).lnk'))) { if (Test-Path $p) { Remove-Item $p -Recurse -Force } }
if ($RemoveData) { $d = Join-Path $env:LOCALAPPDATA 'Mikrotik Traffic Control'; if (Test-Path $d) { Remove-Item $d -Recurse -Force; "Data removed: $d" } } else { "Data kept in: $(Get-MtcData)" }
# the folder we run from cannot delete itself: schedule it
$cmd = "ping 127.0.0.1 -n 3 >nul & rmdir /s /q `"$root`""
Start-Process cmd.exe -ArgumentList "/c $cmd" -WindowStyle Hidden
'Mikrotik Traffic Control was removed.'
