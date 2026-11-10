# Starts Mikrotik Traffic Control (hidden) and opens the dashboard in its own window.   (c) Kish IT - https://kish-it.com
#   Start-MTC.ps1            start if needed and open the dashboard
#   Start-MTC.ps1 -NoBrowser start only
#   Start-MTC.ps1 -Restart   restart it
param([switch]$NoBrowser, [switch]$Restart)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
Start-Mtc -Restart:$Restart
if (-not $NoBrowser) { Open-MtcDashboard }
