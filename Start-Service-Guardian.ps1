$ErrorActionPreference='Stop'
$taskRoot=$PSScriptRoot
$guardianPath=Join-Path $taskRoot 'server\service-guardian.js'
$existing=Get-NetTCPConnection -LocalPort 4311 -State Listen -ErrorAction SilentlyContinue
if($existing){
  $owner=Get-CimInstance Win32_Process -Filter "ProcessId = $($existing[0].OwningProcess)"
  if($owner.CommandLine.Replace('/','\') -notlike ('*'+$guardianPath+'*')){throw 'Guardian port is occupied by another process.'}
  exit 0
}
$guardian=Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList ('"'+$guardianPath+'"') -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskRoot 'data/service-guardian.log') -RedirectStandardError (Join-Path $taskRoot 'data/service-guardian-error.log') -PassThru
$guardian.Id | Set-Content -LiteralPath (Join-Path $taskRoot 'data/service-guardian.pid')
