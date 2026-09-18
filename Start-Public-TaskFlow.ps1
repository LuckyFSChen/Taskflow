$ErrorActionPreference='Stop'
Set-Location -LiteralPath $PSScriptRoot
$result=& (Join-Path $PSScriptRoot 'scripts/Recover-TaskFlow.ps1')
if(!$result){throw 'No recovery result returned.'}
$public=$result | ConvertFrom-Json
if(!$public.ok){throw 'Public service is unavailable.'}
& (Join-Path $PSScriptRoot 'Start-Service-Guardian.ps1')
Write-Host ('TaskFlow public URL: '+$public.url)
