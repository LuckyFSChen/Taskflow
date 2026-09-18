param(
    [switch]$NoBrowser,
    [switch]$NoSetup
)

$ErrorActionPreference = 'Stop'

$taskRoot = $PSScriptRoot
$taskUrl = 'http://127.0.0.1:4310'

$serverPidFile = Join-Path $taskRoot 'data\server.pid'
$guardianPidFile = Join-Path $taskRoot 'data\service-guardian.pid'

$serverLog = Join-Path $taskRoot 'data\server.log'
$serverErrorLog = Join-Path $taskRoot 'data\server-error.log'

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


function Get-PortProcess {
    param(
        [int]$Port
    )

    return Get-NetTCPConnection `
        -LocalPort $Port `
        -State Listen `
        -ErrorAction SilentlyContinue |
        Select-Object -First 1
}


function Get-ProcessInfo {
    param(
        [int]$ProcessId
    )

    try {
        return Get-CimInstance `
            Win32_Process `
            -Filter "ProcessId = $ProcessId"
    }
    catch {
        return $null
    }
}


function Stop-TaskFlowProcess {
    Write-Step 'Stopping TaskFlow server'

    $connection = Get-PortProcess -Port 4310

    if (-not $connection) {
        Write-Host 'TaskFlow server is not currently listening on port 4310.'
        return
    }

    $processId = $connection.OwningProcess
    $processInfo = Get-ProcessInfo -ProcessId $processId

    if (-not $processInfo) {
        throw "Port 4310 is occupied by PID $processId, but process information could not be read."
    }

    $commandLine = [string]$processInfo.CommandLine
    $normalizedCommand = $commandLine.Replace('/', '\')
    $expectedServer = (
        Join-Path $taskRoot 'server\index.js'
    ).Replace('/', '\')

    if (
        $normalizedCommand -notlike "*$expectedServer*"
    ) {
        throw @"
Port 4310 is occupied by another process.

PID:
$processId

Command:
$commandLine

For safety, Restart-TaskFlow.ps1 did not stop it.
"@
    }

    Write-Host "Stopping TaskFlow PID $processId..."

    Stop-Process `
        -Id $processId `
        -ErrorAction Stop

    for ($i = 0; $i -lt 20; $i++) {

        if (-not (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
            break
        }

        Start-Sleep -Milliseconds 250
    }

    if (Get-Process -Id $processId -ErrorAction SilentlyContinue) {
        throw "TaskFlow process PID $processId could not be stopped."
    }

    Remove-Item `
        -LiteralPath $serverPidFile `
        -Force `
        -ErrorAction SilentlyContinue

    Write-Host 'TaskFlow server stopped.' -ForegroundColor Green
}


function Stop-Guardian {
    Write-Step 'Stopping Service Guardian'

    $connection = Get-PortProcess -Port 4311

    if (-not $connection) {
        Write-Host 'Service Guardian is not currently listening on port 4311.'

        Remove-Item `
            -LiteralPath $guardianPidFile `
            -Force `
            -ErrorAction SilentlyContinue

        return
    }

    $processId = $connection.OwningProcess
    $processInfo = Get-ProcessInfo -ProcessId $processId

    if (-not $processInfo) {
        throw "Port 4311 is occupied by PID $processId, but process information could not be read."
    }

    $commandLine = [string]$processInfo.CommandLine
    $normalizedCommand = $commandLine.Replace('/', '\')
    $expectedGuardian = (
        Join-Path $taskRoot 'server\service-guardian.js'
    ).Replace('/', '\')

    if (
        $normalizedCommand -notlike "*$expectedGuardian*"
    ) {
        throw @"
Port 4311 is occupied by another process.

PID:
$processId

Command:
$commandLine

For safety, Restart-TaskFlow.ps1 did not stop it.
"@
    }

    Write-Host "Stopping Service Guardian PID $processId..."

    Stop-Process `
        -Id $processId `
        -ErrorAction Stop

    for ($i = 0; $i -lt 20; $i++) {

        if (-not (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
            break
        }

        Start-Sleep -Milliseconds 250
    }

    if (Get-Process -Id $processId -ErrorAction SilentlyContinue) {
        throw "Service Guardian PID $processId could not be stopped."
    }

    Remove-Item `
        -LiteralPath $guardianPidFile `
        -Force `
        -ErrorAction SilentlyContinue

    Write-Host 'Service Guardian stopped.' -ForegroundColor Green
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


    # --------------------------------------------------------
    # 停止舊服務
    # --------------------------------------------------------

    Stop-TaskFlowProcess
    Stop-Guardian


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

    $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
    $serverPath = Join-Path $taskRoot 'server\index.js'

    $server = Start-Process `
        -FilePath $nodePath `
        -ArgumentList ('"' + $serverPath + '"') `
        -WorkingDirectory $taskRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $serverLog `
        -RedirectStandardError $serverErrorLog `
        -PassThru

    $server.Id |
        Set-Content `
            -LiteralPath $serverPidFile

    Write-Host "TaskFlow server PID: $($server.Id)"


    # --------------------------------------------------------
    # 等待 Health Check
    # --------------------------------------------------------

    Write-Step 'Waiting for TaskFlow health check'

    $ready = $false

    for ($attempt = 1; $attempt -le 40; $attempt++) {

        if (Test-TaskFlow) {
            $ready = $true
            break
        }

        if ($server.HasExited) {
            break
        }

        Write-Host "Waiting... $attempt/40"

        Start-Sleep -Milliseconds 500
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
TaskFlow failed to become healthy.

Server error log:
$serverErrorLog

Last errors:
$errorTail
"@
    }

    Write-Host 'TaskFlow health check passed.' -ForegroundColor Green


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
    # 確認 Guardian 真的有起來
    # --------------------------------------------------------

    $guardianReady = $false

    for ($i = 0; $i -lt 20; $i++) {

        if (Get-PortProcess -Port 4311) {
            $guardianReady = $true
            break
        }

        Start-Sleep -Milliseconds 250
    }

    if (-not $guardianReady) {
        throw @"
Service Guardian did not start.

Check:

$taskRoot\data\service-guardian-error.log
"@
    }

    Write-Host 'Service Guardian started.' -ForegroundColor Green


    # --------------------------------------------------------
    # 完成
    # --------------------------------------------------------

    Write-Step 'TaskFlow restart completed'

    Write-Host ''
    Write-Host "TaskFlow: $taskUrl" -ForegroundColor Green
    Write-Host "Server PID: $($server.Id)"
    Write-Host 'Guardian: port 4311'
    Write-Host "Server log: $serverLog"
    Write-Host "Server error log: $serverErrorLog"
    Write-Host ''


    if (-not $NoBrowser) {
        Start-Process $taskUrl
    }

}
catch {

    Write-Host ''
    Write-Host 'TaskFlow restart failed.' -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host ''

    exit 1
}
finally {

    if ($locked) {
        $mutex.ReleaseMutex()
    }

    $mutex.Dispose()
}