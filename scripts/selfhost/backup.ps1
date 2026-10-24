# Backs up Multies' database (online), Stalwart's data and .env into backups\mymail-backup-<time>.tar.gz.
# The archive holds your mail and your secrets: keep it somewhere safe.
#   powershell -ExecutionPolicy Bypass -File scripts\selfhost\backup.ps1
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..\..")
function DC { docker compose -f docker-compose.selfhost.yml @args; if ($LASTEXITCODE -ne 0) { throw "docker compose $args failed" } }
function EnvValue($name) { (Get-Content .env | Where-Object { $_ -match "^$name=" } | Select-Object -First 1) -replace "^$name=", "" }

$ts = Get-Date -Format "yyyyMMdd-HHmmss"
$work = "backups/mymail-backup-$ts"
New-Item -ItemType Directory -Force -Path $work | Out-Null
DC --profile tools run --rm --no-deps --user root tools backup /data/mymail.db "/$work/mymail.db"
DC stop stalwart
try { DC --profile tools run --rm --no-deps --user root -v mymail_stalwart-data:/stalwart:ro --entrypoint tar tools czf "/$work/stalwart-data.tar.gz" -C /stalwart . }
finally { DC start stalwart }
Copy-Item .env "$work/env"
tar czf "$work.tar.gz" -C backups "mymail-backup-$ts"
Remove-Item -Recurse -Force $work
Write-Host "Backup written: $work.tar.gz"
