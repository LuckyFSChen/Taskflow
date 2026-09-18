param([switch]$CheckOnly,[switch]$Restart,[string]$ResultFile)
$ErrorActionPreference='Stop'
if($CheckOnly -and $Restart){throw 'CheckOnly and Restart cannot be combined.'}
$taskRoot=Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $taskRoot
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
  $localReady=Test-ServiceUrl 'http://127.0.0.1:4310'
  if((!$localReady -or $Restart) -and !$CheckOnly){
    $old=Owned-Process 'data/server.pid' $serverPath -Node
    if($old){
      # Do not interrupt active AI children just because an HTTP check timed out.
      & node (Join-Path $PSScriptRoot 'service-state.js') check-idle
      if($LASTEXITCODE -ne 0){throw 'Active AI work found; service restart postponed.'}
      Stop-Process -Id $old.ProcessId
      Wait-Process -Id $old.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
    }
    if(Get-NetTCPConnection -LocalPort 4310 -State Listen -ErrorAction SilentlyContinue){throw 'Port 4310 is occupied; refused to stop an unknown process.'}
    $localReady=$false
    $server=Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList ('"'+$serverPath+'"') -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput 'data/server.log' -RedirectStandardError 'data/server-error.log' -PassThru
    $server.Id | Set-Content -LiteralPath 'data/server.pid'
    for($attempt=0;$attempt -lt 20;$attempt++){
      if(Test-ServiceUrl 'http://127.0.0.1:4310'){$localReady=$true;break}
      if($server.HasExited){throw 'TaskFlow exited during startup.'}
      Start-Sleep -Milliseconds 500
    }
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
        $tunnel=Start-Process -FilePath $tunnelExe -ArgumentList 'tunnel --url http://127.0.0.1:4310 --no-autoupdate' -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput 'data/tunnel-out.log' -RedirectStandardError 'data/tunnel.log' -PassThru
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
  if($ResultFile){@{ok=$false;error=$_.Exception.Message} | ConvertTo-Json -Compress | Set-Content -LiteralPath $ResultFile -Encoding UTF8}
  throw
}finally{
  if($locked){$guard.ReleaseMutex()};$guard.Dispose()
}
