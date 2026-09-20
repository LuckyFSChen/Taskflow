param([switch]$NoBrowser,[switch]$NoDialog)
$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
. (Join-Path $PSScriptRoot 'scripts\TaskFlow-Ports.ps1')
# 這個捷徑也會啟動 server\index.js：繼承來的 runtime Port 不得決定主服務的位置。
Reset-TaskFlowPortEnvironment
$taskUrl = "http://127.0.0.1:$TaskFlowMainPort"
$startedServer = $null
function Test-TaskFlow {
    try {
        $health = Invoke-RestMethod -Uri ($taskUrl + '/api/health') -TimeoutSec 5
        return ($health.ok -eq $true -and $health.service -eq 'taskflow')
    } catch { return $false }
}
$guard = New-Object System.Threading.Mutex($false, 'Local\TaskFlowDesktopLauncher')
$locked = $false
try {
    $locked = $guard.WaitOne(45000)
    if (-not $locked) { throw 'TaskFlow is still starting. Please try again shortly.' }
    if (-not (Test-TaskFlow)) {
        if (Get-TaskFlowPortOwner -Port $TaskFlowMainPort) {
            throw "Port $TaskFlowMainPort is occupied but TaskFlow is not responding. No service was stopped."
        }
        if (-not (Test-Path -LiteralPath (Join-Path $taskRoot 'dist/index.html'))) {
            throw 'TaskFlow build is missing. Run Start-TaskFlow.ps1 first.'
        }
        $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
        $serverPath = Join-Path $taskRoot 'server/index.js'
        $server = Start-Process -FilePath $nodePath -ArgumentList ('"' + $serverPath + '"') -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskRoot 'data/server.log') -RedirectStandardError (Join-Path $taskRoot 'data/server-error.log') -PassThru
        $startedServer = $server
        $server.Id | Set-Content -LiteralPath (Join-Path $taskRoot 'data/server.pid')
        $ready = $false
        $loggedPort = $null
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            if ($server.HasExited) { break }
            # Port 不是正式 Port 就是 startup failure：不等滿 30 次，也不接受那個 Port。
            $loggedPort = Get-TaskFlowLoggedPort -LogPath (Join-Path $taskRoot 'data/server.log')
            if ($loggedPort -and $loggedPort -ne $TaskFlowMainPort) { break }
            $owner = Get-TaskFlowPortOwner -Port $TaskFlowMainPort
            if ($owner -and $owner.OwningProcess -eq $server.Id -and (Test-TaskFlow)) { $ready = $true; break }
            Start-Sleep -Milliseconds 500
        }
        if ($loggedPort -and $loggedPort -ne $TaskFlowMainPort) {
            throw "TaskFlow main server started on an unexpected port. Expected: $TaskFlowMainPort. Actual: $loggedPort."
        }
        if (-not $ready) { throw "TaskFlow could not start on port $TaskFlowMainPort. See $taskRoot\data\server-error.log." }
        $startedServer = $null
    }
    & (Join-Path $taskRoot 'Start-Service-Guardian.ps1')
    if (-not $NoBrowser) { Start-Process $taskUrl }
} catch {
    # 啟動失敗就不留下這一輪開出來的 server\index.js。只停這一個 PID。
    if ($startedServer) {
        [void](Stop-TaskFlowProcessById -ProcessId $startedServer.Id)
        $savedPidFile = Join-Path $taskRoot 'data/server.pid'
        if (Test-Path -LiteralPath $savedPidFile) {
            $savedPid = (Get-Content -LiteralPath $savedPidFile -Raw -ErrorAction SilentlyContinue).Trim()
            if ($savedPid -eq "$($startedServer.Id)") { Remove-Item -LiteralPath $savedPidFile -Force -ErrorAction SilentlyContinue }
        }
    }
    if ($NoDialog) { Write-Error $_.Exception.Message -ErrorAction Continue; exit 1 }
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'TaskFlow') | Out-Null
    exit 1
} finally {
    if ($locked) { $guard.ReleaseMutex() }
    $guard.Dispose()
}
