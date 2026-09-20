param([switch]$CheckOnly,[switch]$Restart,[switch]$Build,[string]$ResultFile)
$ErrorActionPreference='Stop'
if($CheckOnly -and $Restart){throw 'CheckOnly and Restart cannot be combined.'}
$taskRoot=Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $taskRoot
# Port ownership 只有一份定義（scripts/TaskFlow-Ports.ps1，對應 server/ports.js）。
. (Join-Path $PSScriptRoot 'TaskFlow-Ports.ps1')
# 這支腳本由 Service Guardian 啟動，而 Guardian 自己可能是從某個 runtime 環境啟動的。
# 繼承來的 PORT 會一路傳進新的 server\index.js，讓主服務綁到隨機高位 Port。
Reset-TaskFlowPortEnvironment
$localUrl="http://127.0.0.1:$TaskFlowMainPort"
# 本輪啟動的主服務；啟動失敗時必須停掉，不得留下第二個 server\index.js。
$startedServer=$null
$serverPath=Join-Path $taskRoot 'server\index.js'
$tunnelExe=Join-Path $taskRoot 'data\tools\cloudflared.exe'
function Test-ServiceUrl([string]$url){
  try {
    $response=Invoke-RestMethod -Uri ($url+'/api/health') -TimeoutSec 5
    return ($response.ok -eq $true -and $response.service -eq 'taskflow')
  }catch{
    # A Cloudflare hostname may resolve publicly before the local DNS cache updates.
    # Verify the same HTTPS hostname/certificate using a public DNS answer;
    # never disable TLS validation or change the computer's DNS settings.
    if($url -notmatch '^https://[a-z0-9.-]+(?::\d+)?$'){return $false}
    try{
      $dnsName=([uri]$url).DnsSafeHost
      $record=Resolve-DnsName -Name $dnsName -Server 1.1.1.1 -Type A -DnsOnly -ErrorAction Stop | Where-Object {$_.IPAddress} | Select-Object -First 1
      if(!$record){return $false}
      $raw=& curl.exe --fail --silent --show-error --connect-timeout 3 --max-time 5 --resolve ($dnsName+':443:'+$record.IPAddress) ($url+'/api/health') 2>$null
      if($LASTEXITCODE -ne 0){return $false}
      $response=$raw | ConvertFrom-Json
      return ($response.ok -eq $true -and $response.service -eq 'taskflow')
    }catch{return $false}
  }
}
function Owned-Process([string]$pidFile,[string]$expectedPath,[switch]$Node){
  if(!(Test-Path -LiteralPath $pidFile)){return $null}
  $processId=0
  if(![int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(),[ref]$processId)){throw 'Invalid saved process id.'}
  $found=Get-CimInstance Win32_Process -Filter "ProcessId = $processId"
  if(!$found){return $null}
  if($Node){
    $command=$found.CommandLine.Replace('/','\')
    if($found.Name -ne 'node.exe' -or $command -notmatch ('(?i)(?:"|\s)'+[regex]::Escape($expectedPath)+'(?:"|\s|$)')){throw 'Server process identity mismatch; refused to stop it.'}
  }elseif($found.ExecutablePath -ne $expectedPath){throw 'Tunnel process identity mismatch; refused to stop it.'}
  return $found
}
$guard=New-Object System.Threading.Mutex($false,'Local\TaskFlowDesktopLauncher')
$locked=$false
try{
  $locked=$guard.WaitOne(10000)
  if(!$locked){throw 'Another service operation is still running.'}
  # Build BEFORE stopping anything: merged source does not become dist/ by itself, and a
  # failed build must never cost the user a running service. Dependencies are intentionally
  # NOT reinstalled here (npm ci would delete node_modules while the server is using it);
  # if a dependency is missing the build fails and says so, and Restart-TaskFlow.ps1 remains
  # the manual path that runs npm ci.
  if($Build -and !$CheckOnly){
    if(!(Get-Command npm.cmd -ErrorAction SilentlyContinue)){throw 'npm.cmd was not found in PATH; the running service was not stopped.'}
    & npm.cmd run build
    if($LASTEXITCODE -ne 0){throw "Build failed with exit code $LASTEXITCODE; the running service was not stopped."}
    if(!(Test-Path -LiteralPath (Join-Path $taskRoot 'dist\index.html'))){throw 'Build finished but dist\index.html is missing; the running service was not stopped.'}
  }
  $localReady=Test-ServiceUrl $localUrl
  if((!$localReady -or $Restart) -and !$CheckOnly){
    $old=Owned-Process 'data/server.pid' $serverPath -Node
    if($old){
      # Do not interrupt active AI children just because an HTTP check timed out.
      & node (Join-Path $PSScriptRoot 'service-state.js') check-idle
      if($LASTEXITCODE -ne 0){throw 'Active AI work found; service restart postponed.'}
      Stop-Process -Id $old.ProcessId
      Wait-Process -Id $old.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
    }
    if(Get-TaskFlowPortOwner -Port $TaskFlowMainPort){throw "Port $TaskFlowMainPort is occupied; refused to stop an unknown process."}
    $localReady=$false
    $server=Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList ('"'+$serverPath+'"') -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput 'data/server.log' -RedirectStandardError 'data/server-error.log' -PassThru
    $startedServer=$server
    $server.Id | Set-Content -LiteralPath 'data/server.pid'
    for($attempt=0;$attempt -lt 20;$attempt++){
      if($server.HasExited){throw 'TaskFlow exited during startup.'}
      # 服務啟動成功時會把自己的網址寫進 server.log。Port 不是正式 Port 就是 startup failure，
      # 不再繼續等健康檢查，也不接受那個 Port。
      $loggedPort=Get-TaskFlowLoggedPort -LogPath 'data/server.log'
      if($loggedPort -and $loggedPort -ne $TaskFlowMainPort){throw "TaskFlow main server started on an unexpected port. Expected: $TaskFlowMainPort. Actual: $loggedPort."}
      $owner=Get-TaskFlowPortOwner -Port $TaskFlowMainPort
      if($owner -and $owner.OwningProcess -eq $server.Id -and (Test-ServiceUrl $localUrl)){$localReady=$true;break}
      Start-Sleep -Milliseconds 500
    }
    # 本輪啟動的服務已經健康而且真的擁有正式 Port：它不再是「待清理的殘留」。
    if($localReady){$startedServer=$null}
  }
  if(!$localReady){throw 'Local TaskFlow is not responding.'}
  $configuredPublicUrl=''
  if(Test-Path -LiteralPath '.env'){
    $configuredLine=Get-Content -LiteralPath '.env' | Where-Object {$_ -match '^PUBLIC_ORIGIN='} | Select-Object -First 1
    if($configuredLine -match '^PUBLIC_ORIGIN=(https://[a-z0-9.-]+(?::\d+)?)$'){$configuredPublicUrl=$Matches[1]}
  }
  $fixedPublicUrl=$configuredPublicUrl -and $configuredPublicUrl -notmatch '\.trycloudflare\.com$'
  if($fixedPublicUrl){
    $publicUrl=$configuredPublicUrl
    $publicReady=Test-ServiceUrl $publicUrl
    if(!$publicReady -and !$CheckOnly){$publicReady=Test-ServiceUrl $publicUrl}
  }else{
    $publicUrl=''
    if(Test-Path -LiteralPath 'data/public-url.txt'){$publicUrl=(Get-Content -LiteralPath 'data/public-url.txt' -Raw).Trim()}
    $currentTunnel=Owned-Process 'data/tunnel.pid' $tunnelExe
    if($currentTunnel -and (Test-Path -LiteralPath 'data/tunnel.log')){
      $currentLog=Get-Content -LiteralPath 'data/tunnel.log' -Raw
      if($currentLog -match 'https://[a-z0-9-]+\.trycloudflare\.com'){$publicUrl=$Matches[0]}
    }
    $validUrl=$publicUrl -match '^https://[a-z0-9-]+\.trycloudflare\.com$'
    $publicReady=$validUrl -and (Test-ServiceUrl $publicUrl)
    if(!$publicReady -and !$CheckOnly){
      # Retry once before rotating a tunnel after a transient network failure.
      if($validUrl){$publicReady=Test-ServiceUrl $publicUrl}
      if(!$publicReady){
        $oldTunnel=Owned-Process 'data/tunnel.pid' $tunnelExe
        if($oldTunnel){Stop-Process -Id $oldTunnel.ProcessId}
        $tunnel=Start-Process -FilePath $tunnelExe -ArgumentList "tunnel --url $localUrl --no-autoupdate" -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput 'data/tunnel-out.log' -RedirectStandardError 'data/tunnel.log' -PassThru
        $tunnel.Id | Set-Content -LiteralPath 'data/tunnel.pid'
        $publicUrl=''
        for($attempt=0;$attempt -lt 45;$attempt++){
          Start-Sleep -Seconds 1
          if($tunnel.HasExited){throw 'Cloudflare tunnel exited.'}
          $log=Get-Content -LiteralPath 'data/tunnel.log' -Raw -ErrorAction SilentlyContinue
          if($log -match 'https://[a-z0-9-]+\.trycloudflare\.com'){$publicUrl=$Matches[0];break}
        }
        if(!$publicUrl){throw 'No Cloudflare URL assigned.'}
        for($attempt=0;$attempt -lt 10;$attempt++){
          if(Test-ServiceUrl $publicUrl){$publicReady=$true;break}
          Start-Sleep -Seconds 2
        }
      }
    }
  }
  if(!$publicReady){throw 'Public Cloudflare URL is not responding.'}
  & node (Join-Path $PSScriptRoot 'service-state.js') set-url $publicUrl
  if($LASTEXITCODE -ne 0){throw 'Could not save public origin.'}
  $publicUrl | Set-Content -LiteralPath 'data/public-url.txt'
  $result=@{ok=$true;url=$publicUrl} | ConvertTo-Json -Compress
  if($ResultFile){$result | Set-Content -LiteralPath $ResultFile -Encoding UTF8}
  $result
}catch{
  # 只停本輪啟動、而且沒有成功接管正式 Port 的那一個 PID：不碰其他任何程序。
  if($startedServer){
    [void](Stop-TaskFlowProcessById -ProcessId $startedServer.Id)
    $savedPid=$null
    if(Test-Path -LiteralPath 'data/server.pid'){$savedPid=(Get-Content -LiteralPath 'data/server.pid' -Raw -ErrorAction SilentlyContinue).Trim()}
    if($savedPid -eq "$($startedServer.Id)"){Remove-Item -LiteralPath 'data/server.pid' -Force -ErrorAction SilentlyContinue}
  }
  if($ResultFile){@{ok=$false;error=$_.Exception.Message} | ConvertTo-Json -Compress | Set-Content -LiteralPath $ResultFile -Encoding UTF8}
  throw
}finally{
  if($locked){$guard.ReleaseMutex()};$guard.Dispose()
}
