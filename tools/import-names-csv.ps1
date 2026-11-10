# Loads device names from a CSV (columns IP, Device, Person) into Mikrotik Traffic Control. Rows without an IP or a Person are skipped.
# The name shown becomes "Person (Device)". Run it again any time after editing the CSV.
#   pwsh -File tools/import-names-csv.ps1 -File names.csv                 (router: the first one)
#   pwsh -File tools/import-names-csv.ps1 -File names.csv -Router <id>    (id: see http://127.0.0.1:8787/api/routers)
# CSV example (see tools/names-example.csv):  IP,Device,Person
param([Parameter(Mandatory)][string]$File, [string]$Router = '', [int]$Port = 8787)
$ErrorActionPreference = 'Stop'
if (-not $Router) { $Router = (Invoke-RestMethod "http://127.0.0.1:$Port/api/routers" | Select-Object -First 1).id }
if (-not $Router) { throw 'No router is configured yet: run the setup guide first.' }
$api = "http://127.0.0.1:$Port/api/r/$Router/api"
$n = 0
foreach ($r in Import-Csv $File -Encoding UTF8) {
    $ip = "$($r.IP)".Trim(); $person = "$($r.Person)".Trim(); $dev = "$($r.Device)".Trim()
    if (-not $person -or $ip -notmatch '^\d{1,3}(\.\d{1,3}){3}$') { continue }
    $label = if ($dev) { "$person ($dev)" } else { $person }
    Invoke-RestMethod "$api/name" -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes((@{ ip = $ip; name = $label } | ConvertTo-Json))) | Out-Null
    '{0,-16} -> {1}' -f $ip, $label; $n++
}
"$n names loaded."
