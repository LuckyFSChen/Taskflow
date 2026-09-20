$ErrorActionPreference='Stop'
$taskRoot=$PSScriptRoot
. (Join-Path $PSScriptRoot 'scripts\TaskFlow-Ports.ps1')
# Guardian 會再啟動 server\index.js（透過 scripts/Recover-TaskFlow.ps1）。
# 它自己繼承到的 runtime Port 一路往下傳，就是主服務跑到隨機 Port 的來源之一。
Reset-TaskFlowPortEnvironment
$guardianPath=Join-Path $taskRoot 'server\service-guardian.js'
$existing=Get-TaskFlowPortOwner -Port $TaskFlowGuardianPort
if($existing){
  $owner=Get-TaskFlowProcessInfo -ProcessId $existing.OwningProcess
  if(-not (Test-TaskFlowCommandLine -CommandLine $owner.CommandLine -ExpectedPath $guardianPath)){throw 'Guardian port is occupied by another process.'}
  exit 0
}
$guardian=Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList ('"'+$guardianPath+'"') -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskRoot 'data/service-guardian.log') -RedirectStandardError (Join-Path $taskRoot 'data/service-guardian-error.log') -PassThru
$guardian.Id | Set-Content -LiteralPath (Join-Path $taskRoot 'data/service-guardian.pid')
