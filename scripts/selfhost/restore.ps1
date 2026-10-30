# Restores a backup made by backup.ps1 or backup.sh.
#   powershell -ExecutionPolicy Bypass -File scripts\selfhost\restore.ps1 backups\mymail-backup-<time>.tar.gz
param([Parameter(Mandatory = $true)][string]$Archive)
$Archive = (Resolve-Path $Archive).Path
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..\..")
function DC { docker compose -f docker-compose.selfhost.yml @args; if ($LASTEXITCODE -ne 0) { throw "docker compose $args failed" } }
function EnvValue($name) { (Get-Content .env | Where-Object { $_ -match "^$name=" } | Select-Object -First 1) -replace "^$name=", "" }

$name = [IO.Path]::GetFileName($Archive) -replace "\.tar\.gz$", ""
New-Item -ItemType Directory -Force -Path backups/restore | Out-Null
tar xzf $Archive -C backups/restore
$src = "backups/restore/$name"
if (-not (Test-Path "$src/mymail.db")) { throw "$Archive does not look like a Multies backup." }
$old = (Get-Content "$src/env" | Where-Object { $_ -match "^APP_SECRET=" }) -replace "^APP_SECRET=", ""
if ($old -ne (EnvValue "APP_SECRET")) { Write-Host "Note: APP_SECRET in this backup differs from .env. Copy it from $src/env into .env if encrypted keys stop working." }
DC stop mymail mail-bridge stalwart
DC --profile tools run --rm --no-deps tools restore "/$src/mymail.db" /data/mymail.db
DC --profile tools run --rm --no-deps --user root -v mymail_stalwart-data:/stalwart --entrypoint sh tools -c "find /stalwart -mindepth 1 -delete && tar xzf /$src/stalwart-data.tar.gz -C /stalwart"
DC up -d
Remove-Item -Recurse -Force backups/restore
Write-Host "Restored from $Archive"
