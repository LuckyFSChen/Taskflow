param(
    [switch]$NoBrowser,
    [switch]$NoSetup
)

$ErrorActionPreference = 'Stop'

$taskRoot = $PSScriptRoot

# Port ownership 只有一份定義（scripts/TaskFlow-Ports.ps1，對應 server/ports.js）。
. (Join-Path $PSScriptRoot 'scripts\TaskFlow-Ports.ps1')

# 這支腳本可能是從一個 Task runtime（或在那個 runtime 裡工作的 AI CLI、或它開出來的終端機）
# 啟動的。那個環境裡的 PORT 會被 Start-Process 一路傳給 server\index.js，主服務就會綁到
# 隨機高位 Port。先把 runtime 的 Port 變數清掉，再釘上 TaskFlow 正式 Port。
Reset-TaskFlowPortEnvironment

$taskUrl = "http://127.0.0.1:$TaskFlowMainPort"

$serverPidFile = Join-Path $taskRoot 'data\server.pid'
$guardianPidFile = Join-Path $taskRoot 'data\service-guardian.pid'

$serverLog = Join-Path $taskRoot 'data\server.log'
$serverErrorLog = Join-Path $taskRoot 'data\server-error.log'

$serverPath = Join-Path $taskRoot 'server\index.js'
$guardianPath = Join-Path $taskRoot 'server\service-guardian.js'

# 本輪啟動的主服務。任何一個步驟失敗都必須把它停掉，否則每失敗一次就多留一個
# server\index.js 在系統裡（這次事故觀察到的殘留程序就是這樣累積的）。
$startedServer = $null

Set-Location -LiteralPath $taskRoot


# ------------------------------------------------------------
# 共用函式
# ------------------------------------------------------------

function Write-Step {
    param([string]$Message)

    Write-Host ''
    Write-Host ('=' * 60) -ForegroundColor DarkGray
    Write-Host $Message -ForegroundColor Cyan
    Write-Host ('=' * 60) -ForegroundColor DarkGray
}


function Test-TaskFlow {
    try {
        $health = Invoke-RestMethod `
            -Uri ($taskUrl + '/api/health') `
            -TimeoutSec 3

        return (
            $health.ok -eq $true -and
            $health.service -eq 'taskflow'
        )
    }
    catch {
        return $false
    }
}


function Stop-ServiceOnPort {
    param(
        [Parameter(Mandatory)]
        [int]$Port,

        [Parameter(Mandatory)]
        [string]$ExpectedPath,

        [Parameter(Mandatory)]
        [string]$Label,

        [string]$PidFile
    )

    $connection = Get-TaskFlowPortOwner -Port $Port

    if (-not $connection) {

        Write-Host "$Label is not currently listening on port $Port."

        if ($PidFile) {
            Remove-Item `
                -LiteralPath $PidFile `
                -Force `
                -ErrorAction SilentlyContinue
        }

        return
    }

    $processId = $connection.OwningProcess
    $processInfo = Get-TaskFlowProcessInfo -ProcessId $processId

    if (-not $processInfo) {
        throw "Port $Port is occupied by PID $processId, but process information could not be read."
    }

    if (-not (Test-TaskFlowCommandLine -CommandLine $processInfo.CommandLine -ExpectedPath $ExpectedPath)) {
        throw @"
Port $Port is occupied by another process.

PID:
$processId

Command:
$($processInfo.CommandLine)

For safety, Restart-TaskFlow.ps1 did not stop it.
"@
    }

    Write-Host "Stopping $Label PID $processId..."

    if (-not (Stop-TaskFlowProcessById -ProcessId $processId)) {
        throw "$Label process PID $processId could not be stopped."
    }

    if ($PidFile) {
        Remove-Item `
            -LiteralPath $PidFile `
            -Force `
            -ErrorAction SilentlyContinue
    }

    Write-Host "$Label stopped." -ForegroundColor Green
}


function Remove-StrayTaskFlowServer {
    <#
        .SYNOPSIS
        清掉前幾輪失敗的 Restart 留下的主服務程序。

        .DESCRIPTION
        只停「命令列剛好是這個根目錄的 server\index.js」的程序，也就是這支腳本自己
        負責的那一個服務。data\worktrees\<task>\... 底下的 Task runtime 路徑不同，
        不會被誤判，也絕不「殺掉所有 node.exe」。
    #>

    $stray = Get-TaskFlowServerProcess -TaskRoot $taskRoot

    if (-not $stray -or $stray.Count -eq 0) { return }

    Write-Host "Found $($stray.Count) leftover TaskFlow main server process(es) from earlier runs." -ForegroundColor Yellow

    foreach ($process in $stray) {

        Write-Host "Stopping leftover TaskFlow main server PID $($process.ProcessId)..."

        if (-not (Stop-TaskFlowProcessById -ProcessId $process.ProcessId)) {
            throw "Leftover TaskFlow main server PID $($process.ProcessId) could not be stopped."
        }
    }
}


function Invoke-Npm {
    param(
        [Parameter(Mandatory)]
        [string[]]$Arguments,

        [Parameter(Mandatory)]
        [string]$FailureMessage
    )

    & npm.cmd @Arguments

    if ($LASTEXITCODE -ne 0) {
        throw "$FailureMessage Exit code: $LASTEXITCODE"
    }
}


# ------------------------------------------------------------
# 防止同時執行兩個 Restart
# ------------------------------------------------------------

$mutex = New-Object System.Threading.Mutex(
    $false,
    'Local\TaskFlowRestart'
)

$locked = $false


try {

    $locked = $mutex.WaitOne(30000)

    if (-not $locked) {
        throw 'Another TaskFlow restart is already running.'
    }


    # --------------------------------------------------------
    # 基本環境檢查
    # --------------------------------------------------------

    Write-Step 'Checking environment'

    if (-not (Test-Path -LiteralPath (Join-Path $taskRoot 'package.json'))) {
        throw "package.json was not found in $taskRoot"
    }

    if (-not (Test-Path -LiteralPath (Join-Path $taskRoot 'package-lock.json'))) {
        throw "package-lock.json was not found in $taskRoot"
    }

    if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
        throw 'node.exe was not found in PATH.'
    }

    if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
        throw 'npm.cmd was not found in PATH.'
    }

    $nodeVersion = & node.exe --version

    Write-Host "Node: $nodeVersion"
    Write-Host "Root: $taskRoot"
    Write-Host "Main server port: $TaskFlowMainPort"
    Write-Host "Service Guardian port: $TaskFlowGuardianPort"


    # --------------------------------------------------------
    # 停止舊服務
    # --------------------------------------------------------

    Write-Step 'Stopping TaskFlow server'

    Stop-ServiceOnPort `
        -Port $TaskFlowMainPort `
        -ExpectedPath $serverPath `
        -Label 'TaskFlow server' `
        -PidFile $serverPidFile

    Write-Step 'Stopping Service Guardian'

    Stop-ServiceOnPort `
        -Port $TaskFlowGuardianPort `
        -ExpectedPath $guardianPath `
        -Label 'Service Guardian' `
        -PidFile $guardianPidFile


    # --------------------------------------------------------
    # 清掉先前失敗留下的主服務程序
    # --------------------------------------------------------

    Write-Step 'Checking for leftover TaskFlow server processes'

    Remove-StrayTaskFlowServer

    Write-Host 'No TaskFlow main server process remains.' -ForegroundColor Green


    # --------------------------------------------------------
    # 安裝乾淨依賴
    # --------------------------------------------------------

    Write-Step 'Installing dependencies'

    Invoke-Npm `
        -Arguments @('ci') `
        -FailureMessage 'Dependency installation failed.'

    Write-Host 'Dependencies installed.' -ForegroundColor Green


    # --------------------------------------------------------
    # Setup
    # --------------------------------------------------------

    if (-not $NoSetup) {

        Write-Step 'Running TaskFlow setup'

        Invoke-Npm `
            -Arguments @('run', 'setup') `
            -FailureMessage 'TaskFlow setup failed.'

        Write-Host 'TaskFlow setup completed.' -ForegroundColor Green
    }
    else {
        Write-Step 'Skipping TaskFlow setup'
        Write-Host 'npm run setup was skipped because -NoSetup was specified.'
    }


    # --------------------------------------------------------
    # Build
    # --------------------------------------------------------

    Write-Step 'Building TaskFlow'

    Invoke-Npm `
        -Arguments @('run', 'build') `
        -FailureMessage 'TaskFlow build failed.'

    $distIndex = Join-Path $taskRoot 'dist\index.html'

    if (-not (Test-Path -LiteralPath $distIndex)) {
        throw "Build completed but dist\index.html was not found."
    }

    Write-Host 'TaskFlow build completed.' -ForegroundColor Green


    # --------------------------------------------------------
    # 啟動 TaskFlow Server
    # --------------------------------------------------------

    Write-Step 'Starting TaskFlow server'

    if (Get-TaskFlowPortOwner -Port $TaskFlowMainPort) {
        throw "Port $TaskFlowMainPort is still occupied; TaskFlow server was not started."
    }

    $nodePath = (Get-Command node.exe -ErrorAction Stop).Source

    $server = Start-Process `
        -FilePath $nodePath `
        -ArgumentList ('"' + $serverPath + '"') `
        -WorkingDirectory $taskRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $serverLog `
        -RedirectStandardError $serverErrorLog `
        -PassThru

    $startedServer = $server

    $server.Id |
        Set-Content `
            -LiteralPath $serverPidFile

    Write-Host "TaskFlow server PID: $($server.Id)"


    # --------------------------------------------------------
    # 等待 Health Check 並確認 Port Ownership
    # --------------------------------------------------------

    Write-Step 'Waiting for TaskFlow health check'

    $ready = $false
    $loggedPort = $null

    for ($attempt = 1; $attempt -le 40; $attempt++) {

        if ($server.HasExited) { break }

        # 服務啟動成功時會把自己的網址寫進 server.log。只要那個 Port 不是 4310，
        # 就是 startup failure——不必再等完整 40 次健康檢查。
        $loggedPort = Get-TaskFlowLoggedPort -LogPath $serverLog

        if ($loggedPort -and $loggedPort -ne $TaskFlowMainPort) { break }

        $owner = Get-TaskFlowPortOwner -Port $TaskFlowMainPort

        if ($owner -and $owner.OwningProcess -eq $server.Id -and (Test-TaskFlow)) {
            $ready = $true
            break
        }

        Write-Host "Waiting... $attempt/40"

        Start-Sleep -Milliseconds 500
    }


    if ($loggedPort -and $loggedPort -ne $TaskFlowMainPort) {

        throw @"
TaskFlow main server started on an unexpected port.

Expected:
$TaskFlowMainPort

Actual:
$loggedPort

$TaskFlowMainPort is TaskFlow infrastructure and must not be replaced by a runtime port.
Check whether a PORT / PREVIEW_PORT / BACKEND_PORT variable was inherited from a task
runtime, and whether .env still sets the generic PORT instead of TASKFLOW_PORT.
"@
    }


    if (-not $ready) {

        $errorTail = ''

        if (Test-Path -LiteralPath $serverErrorLog) {

            $errorTail = (
                Get-Content `
                    -LiteralPath $serverErrorLog `
                    -Tail 30 `
                    -ErrorAction SilentlyContinue
            ) -join [Environment]::NewLine
        }

        throw @"
TaskFlow failed to become healthy on port $TaskFlowMainPort.

Server error log:
$serverErrorLog

Last errors:
$errorTail
"@
    }

    Write-Host "TaskFlow health check passed on port $TaskFlowMainPort." -ForegroundColor Green


    # --------------------------------------------------------
    # 啟動 Guardian
    # --------------------------------------------------------

    Write-Step 'Starting Service Guardian'

    $guardianLauncher = Join-Path $taskRoot 'Start-Service-Guardian.ps1'

    if (-not (Test-Path -LiteralPath $guardianLauncher)) {
        throw 'Start-Service-Guardian.ps1 was not found.'
    }

    & $guardianLauncher


    # --------------------------------------------------------
    # 確認 Guardian 真的有起來，而且就是我們的 Guardian
    # --------------------------------------------------------

    $guardianOwner = $null

    for ($i = 0; $i -lt 20; $i++) {

        $guardianOwner = Get-TaskFlowPortOwner -Port $TaskFlowGuardianPort

        if ($guardianOwner) { break }

        Start-Sleep -Milliseconds 250
    }

    if (-not $guardianOwner) {
        throw @"
Service Guardian did not start on port $TaskFlowGuardianPort.

Check:

$taskRoot\data\service-guardian-error.log
"@
    }

    $guardianInfo = Get-TaskFlowProcessInfo -ProcessId $guardianOwner.OwningProcess

    if (-not (Test-TaskFlowCommandLine -CommandLine $guardianInfo.CommandLine -ExpectedPath $guardianPath)) {
        throw @"
Port $TaskFlowGuardianPort is held by a process that is not this TaskFlow Service Guardian.

PID:
$($guardianOwner.OwningProcess)

Command:
$($guardianInfo.CommandLine)
"@
    }

    Write-Host "Service Guardian started on port $TaskFlowGuardianPort." -ForegroundColor Green


    # --------------------------------------------------------
    # 最終 Port Ownership 驗收
    # --------------------------------------------------------

    Write-Step 'Verifying port ownership'

    $owner = Get-TaskFlowPortOwner -Port $TaskFlowMainPort

    if (-not $owner -or $owner.OwningProcess -ne $server.Id) {
        throw "Port $TaskFlowMainPort is not owned by the TaskFlow server started by this restart (PID $($server.Id))."
    }

    $savedPid = (Get-Content -LiteralPath $serverPidFile -Raw -ErrorAction SilentlyContinue).Trim()

    if ($savedPid -ne "$($server.Id)") {
        throw "data\server.pid ($savedPid) does not match the process listening on port $TaskFlowMainPort ($($server.Id))."
    }

    $instances = Get-TaskFlowServerProcess -TaskRoot $taskRoot

    if ($instances.Count -ne 1) {
        throw @"
Expected exactly one TaskFlow main server process, found $($instances.Count):

$(($instances | ForEach-Object { "$($_.ProcessId)  $($_.CommandLine)" }) -join [Environment]::NewLine)
"@
    }

    Write-Host "Port $TaskFlowMainPort -> PID $($server.Id) (data\server.pid matches)." -ForegroundColor Green


    # --------------------------------------------------------
    # 完成
    # --------------------------------------------------------

    Write-Step 'TaskFlow restart completed'

    Write-Host ''
    Write-Host "TaskFlow: $taskUrl" -ForegroundColor Green
    Write-Host "Server PID: $($server.Id)"
    Write-Host "Guardian: port $TaskFlowGuardianPort"
    Write-Host "Server log: $serverLog"
    Write-Host "Server error log: $serverErrorLog"
    Write-Host ''

    $startedServer = $null


    if (-not $NoBrowser) {
        Start-Process $taskUrl
    }

}
catch {

    Write-Host ''
    Write-Host 'TaskFlow restart failed.' -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red

    # 本輪啟動的主服務不能留在系統裡：失敗的 Restart 如果每次都留下一個 server\index.js，
    # 重試幾次之後就會有一堆互相搶 Port 的 instance。只停這一個 PID，不碰其他任何程序。
    if ($startedServer) {

        Write-Host ''
        Write-Host "Cleaning up the TaskFlow server started by this restart (PID $($startedServer.Id))..." -ForegroundColor Yellow

        if (Stop-TaskFlowProcessById -ProcessId $startedServer.Id) {
            Write-Host 'Cleanup completed; no TaskFlow server was left running by this restart.' -ForegroundColor Yellow
        }
        else {
            Write-Host "PID $($startedServer.Id) could not be stopped; stop it manually before retrying." -ForegroundColor Red
        }

        $savedPid = $null

        if (Test-Path -LiteralPath $serverPidFile) {
            $savedPid = (Get-Content -LiteralPath $serverPidFile -Raw -ErrorAction SilentlyContinue).Trim()
        }

        # server.pid 只能記錄「真的在聽 4310 的那一個主服務」，不能留下我們剛停掉的 PID。
        if ($savedPid -eq "$($startedServer.Id)") {
            Remove-Item `
                -LiteralPath $serverPidFile `
                -Force `
                -ErrorAction SilentlyContinue
        }
    }

    Write-Host ''

    exit 1
}
finally {

    if ($locked) {
        $mutex.ReleaseMutex()
    }

    $mutex.Dispose()
}
