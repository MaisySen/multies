# First run of self-hosted Multies on Windows (Docker Desktop). Safe to run again.
#   powershell -ExecutionPolicy Bypass -File scripts\selfhost\setup.ps1
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..\..")
function DC { docker compose -f docker-compose.selfhost.yml @args; if ($LASTEXITCODE -ne 0) { throw "docker compose $args failed" } }
function EnvValue($name) { (Get-Content .env | Where-Object { $_ -match "^$name=" } | Select-Object -First 1) -replace "^$name=", "" }

Write-Host "== 1/4 .env"
if (Get-Command node -ErrorAction SilentlyContinue) { node scripts/selfhost/gen-env.mjs }
else { docker run --rm -v "${PWD}:/w" -w /w node:22-alpine node scripts/selfhost/gen-env.mjs }

Write-Host "== 2/4 build (a few minutes the first time)"
DC build mymail

Write-Host "== 3/4 mail server"
$env:STALWART_RECOVERY_ADMIN = EnvValue "STALWART_SETUP_ADMIN"
$env:STALWART_RECOVERY_MODE = "1"
DC up -d --force-recreate stalwart
Remove-Item Env:STALWART_RECOVERY_MODE
$ready = $false
for ($i = 0; $i -lt 60 -and -not $ready; $i++) {
  docker compose -f docker-compose.selfhost.yml --profile setup run --rm --no-deps --entrypoint node setup -e "fetch('http://stalwart:8080/').then(()=>process.exit(0),()=>process.exit(1))" *> $null
  if ($LASTEXITCODE -eq 0) { $ready = $true } else { Start-Sleep -Seconds 2 }
}
if (-not $ready) { throw "Stalwart did not start. See: docker compose -f docker-compose.selfhost.yml logs stalwart" }
DC --profile setup run --rm --no-deps setup
Remove-Item Env:STALWART_RECOVERY_ADMIN
DC up -d --force-recreate stalwart

Write-Host "== 4/4 start"
DC up -d
Write-Host ""
Write-Host "Multies is starting at $(EnvValue 'APP_URL'). Create your account there."
Write-Host "Then add an inbound key (Settings, Inbound) to MYMAIL_INBOUND_KEYS in .env and run:"
Write-Host "  docker compose -f docker-compose.selfhost.yml up -d mail-bridge"
