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

    return @(
        Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
            Where-Object {
                Test-TaskFlowCommandLine -CommandLine $_.CommandLine -ExpectedPath $expected
            }
    )
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


function Stop-TaskFlowProcessById {
    <#
        .SYNOPSIS
        停止一個明確指名的 PID 並確認它真的消失。

        .DESCRIPTION
        只停呼叫端指名的那一個程序：絕不「殺掉所有 node.exe」，那會連使用者自己的程式
        與其他任務的 worktree runtime 一起殺掉。
    #>
    param(
        [Parameter(Mandatory)]
        [int]$ProcessId,

        [int]$TimeoutSeconds = 10
    )

    if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return $true }

    Stop-Process `
        -Id $ProcessId `
        -Force `
        -ErrorAction SilentlyContinue

    Wait-Process `
        -Id $ProcessId `
        -Timeout $TimeoutSeconds `
        -ErrorAction SilentlyContinue

    return -not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}
