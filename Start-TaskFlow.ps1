$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Test-Path -LiteralPath 'node_modules')) { & npm.cmd ci; if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' } }
& npm.cmd run setup
if ($LASTEXITCODE -ne 0) { throw 'Account setup failed.' }
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
Write-Host 'TaskFlow: http://127.0.0.1:4310 ; first login: data/first-login.txt'
& (Join-Path $PSScriptRoot 'Start-Service-Guardian.ps1')
& npm.cmd start
