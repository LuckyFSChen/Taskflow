# TaskFlow Port Ownership 共用函式（對應 server/ports.js）。
#
# 4310／4311 是 TaskFlow 的基礎設施 Port，不是由誰配發的 runtime 資源。
# Task worktree／Preview／Browser Validation 的動態高位 Port 與這兩個完全隔離。

Set-Variable -Name TaskFlowMainPort -Value 4310 -Scope Script -Option ReadOnly -Force
Set-Variable -Name TaskFlowGuardianPort -Value 4311 -Scope Script -Option ReadOnly -Force


function Reset-TaskFlowPortEnvironment {
    <#
        .SYNOPSIS
        清掉從啟動環境繼承來的 runtime Port 變數，並釘上 TaskFlow 正式 Port。

        .DESCRIPTION
        PORT／PREVIEW_PORT／BACKEND_PORT 這些變數描述的是「某一個 runtime 自己的位置」。
        如果這支腳本是從一個 Task runtime（或在那個 runtime 裡工作的 AI CLI、或它開出來的
        終端機）啟動的，那些變數會被 Start-Process 一路傳給 server\index.js，主服務就會
        綁到隨機高位 Port——這正是 server.log 出現 60215 而 4310 沒有人監聽的成因。
    #>

    $runtimeVariables = @(
        'PORT',
        'HOST',
        'PREVIEW_PORT',
        'PREVIEW_URL',
        'BACKEND_PORT',
        'BACKEND_URL',
        'FRONTEND_PORT',
        'FRONTEND_URL'
    )

    foreach ($name in $runtimeVariables) {

        if (Test-Path -LiteralPath "Env:$name") {

            Write-Host "Ignoring inherited runtime variable $name=$((Get-Item -LiteralPath "Env:$name").Value)" -ForegroundColor DarkYellow

            Remove-Item `
                -LiteralPath "Env:$name" `
                -ErrorAction SilentlyContinue
        }
    }

    Get-ChildItem Env: |
        Where-Object { $_.Name -like 'TASKFLOW_SERVICE_*' } |
        ForEach-Object {
            Remove-Item -LiteralPath ('Env:' + $_.Name) -ErrorAction SilentlyContinue
        }

    $env:TASKFLOW_PORT = "$TaskFlowMainPort"
    $env:TASKFLOW_GUARDIAN_PORT = "$TaskFlowGuardianPort"
}


function Get-TaskFlowPortOwner {
    param(
        [Parameter(Mandatory)]
        [int]$Port
    )

    return Get-NetTCPConnection `
        -LocalPort $Port `
        -State Listen `
        -ErrorAction SilentlyContinue |
        Select-Object -First 1
}


function Get-TaskFlowProcessInfo {
    param(
        [Parameter(Mandatory)]
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


function Test-TaskFlowCommandLine {
    <#
        .SYNOPSIS
        這個程序的命令列是不是「這個 TaskFlow 根目錄底下的那一支腳本」。

        .DESCRIPTION
        比對的是完整路徑，所以 data\worktrees\<task>\server\index.js 不會被誤判成主服務。
    #>
    param(
        [string]$CommandLine,

        [Parameter(Mandatory)]
        [string]$ExpectedPath
    )

    if (-not $CommandLine) { return $false }

    return ([string]$CommandLine).Replace('/', '\') -like ('*' + $ExpectedPath.Replace('/', '\') + '*')
}


function Get-TaskFlowServerProcess {
    <#
        .SYNOPSIS
        目前系統上所有「這個根目錄的」TaskFlow 主服務程序。
    #>
    param(
        [Parameter(Mandatory)]
        [string]$TaskRoot
    )

    $expected = (Join-Path $TaskRoot 'server\index.js')

    $found = @(
        Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
            Where-Object {
                Test-TaskFlowCommandLine -CommandLine $_.CommandLine -ExpectedPath $expected
            }
    )

    # 逗號是必要的：`return @(...)` 只有一個元素時會被 PowerShell 拆成單一物件，
    # 呼叫端的 .Count 就會是 $null，「到底有幾個主服務」這個問題會答錯。
    return ,$found
}


function Get-TaskFlowLoggedPort {
    <#
        .SYNOPSIS
        server.log 最後一次宣告的 Port。

        .DESCRIPTION
        主服務啟動成功時會寫一行 `TaskFlow: http://127.0.0.1:<port>`。
        只要那個 Port 不是 4310，就是 startup failure，不必再等完整 40 次健康檢查。
    #>
    param(
        [Parameter(Mandatory)]
        [string]$LogPath
    )

    if (-not (Test-Path -LiteralPath $LogPath)) { return $null }

    $line = Get-Content `
        -LiteralPath $LogPath `
        -Tail 20 `
        -ErrorAction SilentlyContinue |
        Where-Object { $_ -match 'TaskFlow:\s*https?://[^:/]+:(\d+)' } |
        Select-Object -Last 1

    if (-not $line) { return $null }

    if ($line -match 'TaskFlow:\s*https?://[^:/]+:(\d+)') {
        return [int]$Matches[1]
    }

    return $null
}


function Test-TaskFlowProcessAlive {
    <#
        .SYNOPSIS
        這個 PID 現在是不是「還活著、而且還是同一個程式」。

        .DESCRIPTION
        用 Win32_Process（CIM）而不是 Get-Process：Get-Process 有可能回傳一個已經結束、
        但控制代碼還被別人握著的程序物件，那會讓「停掉了沒有」永遠答錯。

        Windows 會很快重複使用 PID。給了 ExpectedPath 就順便比對命令列：
        PID 還在但已經換成別的程式，代表我們要停的那一個已經結束了——
        絕不能因此判定「停不掉」，更不能回頭去殺那個無辜的新程序。
    #>
    param(
        [Parameter(Mandatory)]
        [int]$ProcessId,

        [string]$ExpectedPath
    )

    $found = Get-TaskFlowProcessInfo -ProcessId $ProcessId

    if (-not $found) { return $false }

    if ($ExpectedPath -and -not (Test-TaskFlowCommandLine -CommandLine $found.CommandLine -ExpectedPath $ExpectedPath)) {
        return $false
    }

    return $true
}


function Stop-TaskFlowProcessById {
    <#
        .SYNOPSIS
        停止一個明確指名的 PID 並確認它真的消失。

        .DESCRIPTION
        只停呼叫端指名的那一個程序：絕不「殺掉所有 node.exe」，那會連使用者自己的程式
        與其他任務的 worktree runtime 一起殺掉。

        停不掉時把作業系統給的原因留在 $TaskFlowLastStopError，呼叫端才有東西可以報：
        「could not be stopped」而不說為什麼，等於要使用者自己猜。
    #>
    param(
        [Parameter(Mandatory)]
        [int]$ProcessId,

        [string]$ExpectedPath,

        [int]$TimeoutSeconds = 10
    )

    $script:TaskFlowLastStopError = $null

    if (-not (Test-TaskFlowProcessAlive -ProcessId $ProcessId -ExpectedPath $ExpectedPath)) { return $true }

    try {
        Stop-Process -Id $ProcessId -Force -ErrorAction Stop
    }
    catch {
        $script:TaskFlowLastStopError = $_.Exception.Message
    }

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)

    while ((Get-Date) -lt $deadline) {

        if (-not (Test-TaskFlowProcessAlive -ProcessId $ProcessId -ExpectedPath $ExpectedPath)) { return $true }

        Start-Sleep -Milliseconds 250
    }

    # 第二次嘗試：taskkill /T 連同子孫。Start-Process 起來的 node 底下可能還有孫程序，
    # 而 Stop-Process 只停最上面那一個。
    if (Get-Command taskkill.exe -ErrorAction SilentlyContinue) {

        $output = & taskkill.exe /PID $ProcessId /T /F 2>&1

        if ($LASTEXITCODE -ne 0) {
            $script:TaskFlowLastStopError = ($output | Out-String).Trim()
        }

        $deadline = (Get-Date).AddSeconds(5)

        while ((Get-Date) -lt $deadline) {

            if (-not (Test-TaskFlowProcessAlive -ProcessId $ProcessId -ExpectedPath $ExpectedPath)) { return $true }

            Start-Sleep -Milliseconds 250
        }
    }

    return (-not (Test-TaskFlowProcessAlive -ProcessId $ProcessId -ExpectedPath $ExpectedPath))
}


# ------------------------------------------------------------
# Service Guardian 的排程工作
# ------------------------------------------------------------
# Install-Service-Guardian.ps1 註冊的排程工作每一分鐘就會把 Guardian 重新拉起來。
# 重新啟動期間（npm ci／build 動輒數分鐘）那個排程會在半路生出新的 Guardian，
# 讓「停掉舊服務 → 啟動新服務」變成跟排程賽跑。所以重新啟動時先停用它，
# 結束時（含失敗）一定要恢復——這是使用者的自動復原機制，不能因為一次重啟就永久停用。

Set-Variable -Name TaskFlowGuardianTaskName -Value 'TaskFlow-ServiceGuardian' -Scope Script -Option ReadOnly -Force


function Suspend-TaskFlowGuardianSchedule {
    <#
        .SYNOPSIS
        停用 Guardian 排程工作。回傳「原本是啟用的、結束時要恢復」。
    #>

    if (-not (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue)) { return $false }

    try {
        $task = Get-ScheduledTask -TaskName $TaskFlowGuardianTaskName -ErrorAction SilentlyContinue

        if (-not $task -or $task.State -eq 'Disabled') { return $false }

        Disable-ScheduledTask -TaskName $TaskFlowGuardianTaskName -ErrorAction Stop | Out-Null

        Write-Host "Paused the $TaskFlowGuardianTaskName scheduled task for this restart."

        return $true
    }
    catch {
        # 停不掉排程不是重啟失敗的理由，但使用者要知道待會可能有一個 Guardian 半路冒出來。
        Write-Host "Could not pause the $TaskFlowGuardianTaskName scheduled task: $($_.Exception.Message)" -ForegroundColor DarkYellow
        return $false
    }
}


function Resume-TaskFlowGuardianSchedule {
    param([bool]$WasEnabled)

    if (-not $WasEnabled) { return }

    try {
        Enable-ScheduledTask -TaskName $TaskFlowGuardianTaskName -ErrorAction Stop | Out-Null
        Write-Host "Resumed the $TaskFlowGuardianTaskName scheduled task."
    }
    catch {
        Write-Host "The $TaskFlowGuardianTaskName scheduled task is still paused; re-enable it with: Enable-ScheduledTask -TaskName $TaskFlowGuardianTaskName" -ForegroundColor Red
    }
}
