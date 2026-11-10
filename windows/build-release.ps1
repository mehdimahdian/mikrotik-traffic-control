# Builds the Windows release in dist\ :
#   dist\MikrotikTrafficControl-<version>-win-x64.zip      portable zip (unzip, double-click windows\Install.cmd)
#   dist\MikrotikTrafficControl-<version>-Setup.exe        single installer, only when Inno Setup (ISCC.exe) is found
# Options:
#   -NodeExe <path>   bundle this node.exe (Node 22.5+ / 24 LTS, win-x64) as runtime\node.exe so the user needs no Node.js.
#                     Without it the package needs Node.js on the target PC (install.ps1 offers to install it with winget).
param([string]$NodeExe = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$ver = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$dist = Join-Path $root 'dist'; $stage = Join-Path $dist 'stage'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force $stage | Out-Null
foreach ($d in 'src', 'routeros', 'windows', 'docs', 'tools') { & robocopy (Join-Path $root $d) (Join-Path $stage $d) /E /NFL /NDL /NJH /NJS /NP /XF '*.tmp.js' | Out-Null; if ($LASTEXITCODE -ge 8) { throw "copy $d failed" } }
foreach ($f in 'package.json', 'README.md', 'LICENSE', 'CHANGELOG.md') { if (Test-Path (Join-Path $root $f)) { Copy-Item (Join-Path $root $f) $stage } }
if ($NodeExe) { New-Item -ItemType Directory -Force (Join-Path $stage 'runtime') | Out-Null; Copy-Item $NodeExe (Join-Path $stage 'runtime\node.exe'); Write-Host "Bundled $NodeExe" }
# icon used by the installer and the shortcuts
. (Join-Path $PSScriptRoot 'common.ps1'); Save-MtcIco (Join-Path $stage 'windows\mtc.ico')
$zip = Join-Path $dist "MikrotikTrafficControl-$ver-win-x64.zip"
if (Test-Path $zip) { Remove-Item $zip }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip
Write-Host "Built $zip"
$iscc = @("${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe", "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($iscc) { & $iscc "/DAppVersion=$ver" "/DStageDir=$stage" "/DOutDir=$dist" (Join-Path $PSScriptRoot 'installer.iss'); Write-Host "Built the Setup.exe in $dist" }
else { Write-Host 'Inno Setup 6 not found: only the zip was built (https://jrsoftware.org/isinfo.php to build Setup.exe).' -ForegroundColor Yellow }

# checksums
Get-ChildItem $dist -File | Where-Object { $_.Extension -in '.zip', '.exe' } | ForEach-Object { '{0}  {1}' -f (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower(), $_.Name } | Set-Content (Join-Path $dist 'SHA256SUMS.txt')
