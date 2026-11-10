# Stops Mikrotik Traffic Control (the manager and every router collector). History stays in the data folder.
. (Join-Path $PSScriptRoot 'common.ps1')
$p = @(Get-MtcProcesses)
if ($p.Count) { $p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Start-Sleep -Milliseconds 800; 'Stopped.' } else { 'Not running.' }
