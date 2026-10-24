# Moves data across from Cloudflare D1 into this computer's Multies (see d1-import.sh for details).
#   powershell -ExecutionPolicy Bypass -File scripts\selfhost\d1-import.ps1                       production (mymail-au)
#   powershell -ExecutionPolicy Bypass -File scripts\selfhost\d1-import.ps1 -Database mymail-staging -Staging
#   powershell -ExecutionPolicy Bypass -File scripts\selfhost\d1-import.ps1 -Sql import\file.sql
param([string]$Database = "mymail-au", [switch]$Staging, [string]$Sql)
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..\..")
function DC { docker compose -f docker-compose.selfhost.yml @args; if ($LASTEXITCODE -ne 0) { throw "docker compose $args failed" } }
function EnvValue($name) { (Get-Content .env | Where-Object { $_ -match "^$name=" } | Select-Object -First 1) -replace "^$name=", "" }

New-Item -ItemType Directory -Force -Path import | Out-Null
if ($Sql) {
  if (-not $Sql.Replace("\", "/").StartsWith("import/")) { Copy-Item $Sql import/; $Sql = "import/" + [IO.Path]::GetFileName($Sql) }
} else {
  $Sql = "import/$Database-$(Get-Date -Format 'yyyyMMdd-HHmmss').sql"
  $extra = @(); if ($Staging) { $extra = @("--env", "staging") }
  Write-Host "== exporting $Database from Cloudflare (read only)"
  docker run --rm -e HOME=/tmp --env-file .env -v "${PWD}:/w" -w /w node:22-bookworm-slim npx -y wrangler@4 d1 export $Database --remote "--output=$Sql" @extra
  if ($LASTEXITCODE -ne 0) { throw "Export failed. Check CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in .env." }
}
$Sql = $Sql.Replace("\", "/")
Write-Host "== importing $Sql"
DC stop mymail
DC --profile tools run --rm --no-deps tools import "/$Sql" /data/mymail.db
DC up -d mymail
Write-Host "Done. Sign in with the same email and password as before."
