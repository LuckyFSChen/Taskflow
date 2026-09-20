$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
. (Join-Path $PSScriptRoot 'scripts\TaskFlow-Ports.ps1')
# npm start 會啟動 server\index.js：繼承來的 runtime Port 不得決定主服務的位置。
Reset-TaskFlowPortEnvironment
if (-not (Test-Path -LiteralPath 'node_modules')) { & npm.cmd ci; if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' } }
& npm.cmd run setup
if ($LASTEXITCODE -ne 0) { throw 'Account setup failed.' }
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
Write-Host "TaskFlow: http://127.0.0.1:$TaskFlowMainPort ; first login: data/first-login.txt"
& (Join-Path $PSScriptRoot 'Start-Service-Guardian.ps1')
& npm.cmd start
