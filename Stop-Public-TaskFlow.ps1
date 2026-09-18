$ErrorActionPreference='Stop'
Set-Location -LiteralPath $PSScriptRoot
if(Test-Path 'data/tunnel.pid'){
  $tunnel=Get-CimInstance Win32_Process -Filter "ProcessId = $([int](Get-Content 'data/tunnel.pid'))"
  if($tunnel){
    if($tunnel.ExecutablePath -ne (Join-Path $PSScriptRoot 'data/tools/cloudflared.exe')){throw 'Tunnel identity mismatch.'}
    Stop-Process -Id $tunnel.ProcessId
  }
  Remove-Item -LiteralPath 'data/tunnel.pid'
}
Write-Host 'Public tunnel stopped. Local TaskFlow remains running.'
