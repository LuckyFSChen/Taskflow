param([ValidateSet('Ensure','Restart')][string]$Mode = 'Ensure')
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $taskRoot
. (Join-Path $PSScriptRoot 'TaskFlow-Ports.ps1')
Reset-TaskFlowPortEnvironment
$nodePath = (Get-Content (Join-Path $PSScriptRoot 'service-watchdog-config.json') -Raw | ConvertFrom-Json).nodePath
$logPath = Join-Path $taskRoot 'data\service-watchdog.log'
function Write-Log([string]$Message) {
    $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Mode, $Message
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
    Write-Host $line
}
function Test-Owned($Process, [string]$Path) {
    return ($Process -and $Process.Name -eq 'node.exe' -and $Process.CommandLine -and $Process.CommandLine.Replace('/','\') -match ('(?i)(?:"|\s)' + [regex]::Escape($Path.Replace('/','\')) + '(?:"|\s|$)'))
}
function Get-OwnedListener($Service) {
    $owner = Get-TaskFlowPortOwner -Port $Service.Port
    if (!$owner) { return $null }
    $info = Get-TaskFlowProcessInfo -ProcessId $owner.OwningProcess
    if (!(Test-Owned $info $Service.Path)) { throw "$($Service.Name): port $($Service.Port) belongs to an unknown process; leaving it untouched." }
    return $info
}
function Test-Ready($Service) {
    if (!(Get-OwnedListener $Service)) { return $false }
    if ($Service.Name -eq 'TaskFlow') {
        try {
            $health = Invoke-RestMethod 'http://127.0.0.1:4310/api/health' -TimeoutSec 3
            return ($health.ok -eq $true -and $health.service -eq 'taskflow')
        } catch { return $false }
    }
    return $true
}
function Start-Missing($Service) {
    if (Get-OwnedListener $Service) {
        if (!(Test-Ready $Service)) { throw "$($Service.Name): running but health check failed; hourly check will not interrupt a running process." }
        Write-Log "$($Service.Name): already running on $($Service.Port)."
        return
    }
    $existing = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { Test-Owned $_ $Service.Path })
    if ($existing.Count -gt 0) { throw "$($Service.Name): process exists without a listener; refusing to create a duplicate." }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $outLog = Join-Path $taskRoot "data\$($Service.Name)-$stamp.log"
    $errLog = Join-Path $taskRoot "data\$($Service.Name)-$stamp-error.log"
    $started = Start-Process -FilePath $nodePath -ArgumentList ('"' + $Service.Path + '"') -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
    $started.Id | Set-Content -LiteralPath $Service.PidFile
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        if ($started.HasExited) { throw "$($Service.Name): exited during startup; see $errLog" }
        if (Test-Ready $Service) { Write-Log "$($Service.Name): started PID $($started.Id), port $($Service.Port)."; return }
        Start-Sleep -Milliseconds 500
    }
    throw "$($Service.Name): startup not ready; see $errLog. Process retained for diagnosis; no duplicate will be started."
}
function Stop-Owned($Service) {
    $null = Get-OwnedListener $Service
    $instances = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { Test-Owned $_ $Service.Path })
    foreach ($instance in $instances) {
        if (!(Stop-TaskFlowProcessById -ProcessId $instance.ProcessId -ExpectedPath $Service.Path)) { throw "$($Service.Name): stop failed: $TaskFlowLastStopError" }
        Write-Log "$($Service.Name): stopped PID $($instance.ProcessId)."
    }
    Remove-Item -LiteralPath $Service.PidFile -Force -ErrorAction SilentlyContinue
}
$main = @{Name='TaskFlow'; Port=4310; Path=(Join-Path $taskRoot 'server\index.js'); PidFile=(Join-Path $taskRoot 'data\server.pid')}
$guardian = @{Name='Guardian'; Port=4311; Path=(Join-Path $taskRoot 'server\service-guardian.js'); PidFile=(Join-Path $taskRoot 'data\service-guardian.pid')}
$locks = @()
$paused = $false
$failed = $false
try {
    # Coordinate with both existing manual restart and Guardian recovery launchers.
    foreach ($name in @('Local\TaskFlowServiceWatchdog','Local\TaskFlowRestart','Local\TaskFlowDesktopLauncher')) {
        $mutex = New-Object System.Threading.Mutex($false, $name)
        try { $acquired = $mutex.WaitOne(10000) } catch [System.Threading.AbandonedMutexException] { $acquired = $true }
        if (!$acquired) { $mutex.Dispose(); throw 'Another service operation is in progress; try again later.' }
        $locks += $mutex
    }
    if ((Test-Path $logPath) -and (Get-Item $logPath).Length -gt 2MB) { Move-Item -LiteralPath $logPath -Destination "$logPath.1" -Force }
    Write-Log 'Checking services.'
    if ($Mode -eq 'Restart') {
        & $nodePath (Join-Path $PSScriptRoot 'service-state.js') check-idle
        if ($LASTEXITCODE -ne 0) { throw 'TaskFlow has active AI work (or idle check failed); restart postponed.' }
        # Validate both owners before stopping either one.
        $null = Get-OwnedListener $main
        $null = Get-OwnedListener $guardian
        $paused = Suspend-TaskFlowGuardianSchedule
        $oldSchedule = Get-ScheduledTask -TaskName 'TaskFlow-ServiceGuardian' -ErrorAction SilentlyContinue
        if ($oldSchedule -and $oldSchedule.State -ne 'Disabled') { throw 'Could not pause Guardian schedule; restart postponed.' }
        Stop-Owned $guardian
        Stop-Owned $main
    }
    # A failed main service check must not prevent Guardian from being restored.
    foreach ($service in @($main,$guardian)) {
        try { Start-Missing $service } catch { $failed = $true; Write-Log $_.Exception.Message }
    }
} catch { $failed = $true; Write-Log $_.Exception.Message }
finally {
    Resume-TaskFlowGuardianSchedule -WasEnabled $paused
    [array]::Reverse($locks)
    foreach ($mutex in $locks) { $mutex.ReleaseMutex(); $mutex.Dispose() }
}
# The existing Windows service has its own 20-second crash recovery policy.
try {
    $tunnel = Get-Service -Name 'Cloudflared' -ErrorAction Stop
    if ($tunnel.Status -eq 'Stopped') {
        Start-Service -Name 'Cloudflared' -ErrorAction Stop
        $tunnel.WaitForStatus('Running', [TimeSpan]::FromSeconds(20))
        Write-Log 'Cloudflared: started the existing Windows service.'
    }
    elseif ($tunnel.Status -ne 'Running') { throw "Cloudflared service status: $($tunnel.Status)" }
    $publicHealth = Invoke-RestMethod -Uri 'https://taskflow.lucky0504.idv.tw/api/health' -TimeoutSec 20
    if ($publicHealth.ok -ne $true -or $publicHealth.service -ne 'taskflow') { throw 'Unexpected public TaskFlow health response.' }
    Write-Log 'TaskFlow public HTTPS health OK; Cloudflared running.'
} catch {
    $failed = $true
    Write-Log "TaskFlow tunnel/public check FAILED: $($_.Exception.Message)"
}
# Production idv-web runs on Cloudflare. Check independently; never deploy.
try {
    $health = Invoke-RestMethod -Uri 'https://idv.lucky0504.idv.tw/api/health' -TimeoutSec 20
    if ($health.status -ne 'ok') { throw 'Unexpected health response.' }
    $page = Invoke-WebRequest -Uri 'https://idv.lucky0504.idv.tw/' -UseBasicParsing -TimeoutSec 20
    if ($page.StatusCode -ne 200 -or $page.Content -notmatch '<html') { throw 'Homepage did not return HTML with HTTP 200.' }
    Write-Log 'idv-web production: homepage and health endpoint OK (Cloudflare Worker; no local restart or deploy).'
} catch {
    $failed = $true
    Write-Log "idv-web production FAILED: $($_.Exception.Message) Cloudflare investigation required; deployment was not run."
}
if ($failed) { exit 1 }
Write-Log 'Service check completed.'
exit 0
