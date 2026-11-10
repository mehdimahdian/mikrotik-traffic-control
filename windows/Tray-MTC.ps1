# Tray agent: Kish IT splash, notification-area icon with live Mbps, right-click menu, restarts the program if it dies,
# balloon for new high-severity security alerts. Only one copy runs at a time.   (c) Kish IT - https://kish-it.com
#   -OpenDashboard  if the agent is already running, just open the dashboard window.
#   -NoSplash       skip the splash screen
param([switch]$OpenDashboard, [switch]$NoSplash)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\KishIT-MikrotikTrafficControl-Tray', [ref]$created)
if (-not $created) { if ($OpenDashboard) { try { Open-MtcDashboard } catch { } }; return }

$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Mikrotik Traffic Control (tray).lnk'
$ps  = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not $NoSplash) { Show-MtcSplash }
try { Start-Mtc } catch { [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Mikrotik Traffic Control', 'OK', 'Error') | Out-Null; $mutex.ReleaseMutex(); return }
if ($OpenDashboard -or -not (Get-MtcData | Join-Path -ChildPath 'settings.json' | Test-Path)) { Open-MtcDashboard }   # first run: open the setup guide at once

$icon = New-MtcIcon
$ni = New-Object System.Windows.Forms.NotifyIcon
$ni.Icon = $icon; $ni.Text = 'Mikrotik Traffic Control'; $ni.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miOpen   = $menu.Items.Add('Open dashboard'); $miOpen.Font = New-Object System.Drawing.Font($miOpen.Font, 'Bold')
$miStatus = $menu.Items.Add('Status: starting...'); $miStatus.Enabled = $false
[void]$menu.Items.Add('-')
$miRestart = $menu.Items.Add('Restart')
$miAuto    = $menu.Items.Add('Start with Windows'); $miAuto.Checked = (Test-Path $lnk)
[void]$menu.Items.Add('-')
$miAbout = $menu.Items.Add('About')
$miExit  = $menu.Items.Add('Exit tray (the program keeps running)')
$miStop  = $menu.Items.Add('Stop the program and exit')
$ni.ContextMenuStrip = $menu

$miOpen.add_Click({ try { Start-Mtc; Open-MtcDashboard } catch { } })
$ni.add_BalloonTipClicked({ try { Open-MtcDashboard } catch { } })
$ni.add_MouseDoubleClick({ if ($_.Button -eq 'Left') { try { Open-MtcDashboard } catch { } } })
$miRestart.add_Click({ try { Start-Mtc -Restart } catch { } })
$miAbout.add_Click({ [System.Windows.Forms.MessageBox]::Show("Mikrotik Traffic Control`n`n(c) $((Get-Date).Year) Kish IT - kish-it.com`nMIT License`n`nData folder: $(Get-MtcData)", 'About', 'OK', 'Information') | Out-Null })
$miAuto.add_Click({
    if (Test-Path $lnk) { Remove-Item $lnk -Force; $miAuto.Checked = $false }
    else {
        $s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
        $s.TargetPath = $ps; $s.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -STA -File `"$PSCommandPath`" -NoSplash"
        $s.WorkingDirectory = $PSScriptRoot; $s.WindowStyle = 7; $s.Save(); $miAuto.Checked = $true
    }
})
function Close-Tray { $timer.Stop(); $ni.Visible = $false; $ni.Dispose(); [System.Windows.Forms.Application]::Exit() }
$miExit.add_Click({ Close-Tray })
$miStop.add_Click({ Get-MtcProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Close-Tray })

$script:fails = 0; $script:seenSec = @{}
$timer = New-Object System.Windows.Forms.Timer; $timer.Interval = 5000
$timer.add_Tick({
    try {
        $r = @(Invoke-RestMethod "$($script:Url)/api/routers" -TimeoutSec 2); $script:fails = 0
        foreach ($x in $r) {
            $s2 = $x.status
            if ($s2 -and $s2.secHigh -gt 0) {
                $prev = if ($script:seenSec.ContainsKey($x.id)) { $script:seenSec[$x.id] } else { 0 }
                if ($s2.secLastId -gt $prev) { $ni.ShowBalloonTip(10000, 'Mikrotik Traffic Control - security alert', ('{0}: {1} high alert(s). Open the Security tab.' -f $x.name, $s2.secHigh), [System.Windows.Forms.ToolTipIcon]::Warning); $script:seenSec[$x.id] = $s2.secLastId }
            }
        }
        if (-not $r.Count) { $ni.Text = 'Mikrotik Traffic Control - setup needed'; $miStatus.Text = 'Status: no router added yet (open the dashboard)'; return }
        $m = $r[0]; $st = $m.status
        if ($st -and $st.ok) {
            $dn = $st.rate[1] * 8 / 1e6; $up = $st.rate[0] * 8 / 1e6
            $ni.Text = ('MTC - down {0:N1} / up {1:N1} Mbps' -f $dn, $up)
            $more = if ($r.Count -gt 1) { " (+$($r.Count - 1) more)" } else { '' }
            $miStatus.Text = ('{0}: down {1:N1} / up {2:N1} Mbps, {3} conns{4}' -f $m.name, $dn, $up, $st.conns, $more)
        } else { $ni.Text = 'MTC - router not reachable'; $miStatus.Text = ('{0}: {1}' -f $m.name, $(if ($st -and $st.error) { $st.error } else { 'no data yet' })) }
    } catch {
        $script:fails++; $ni.Text = 'MTC - not running'; $miStatus.Text = 'Status: not running'
        if ($script:fails -eq 2) { try { Start-Mtc } catch { } }
    }
})
$timer.Start()
[System.Windows.Forms.Application]::Run((New-Object System.Windows.Forms.ApplicationContext))
$mutex.ReleaseMutex()
