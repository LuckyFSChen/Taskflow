param([switch]$NoBrowser,[switch]$NoDialog)
$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
$taskUrl = 'http://127.0.0.1:4310'
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
        if (Get-NetTCPConnection -LocalPort 4310 -State Listen -ErrorAction SilentlyContinue) {
            throw 'Port 4310 is occupied but TaskFlow is not responding. No service was stopped.'
        }
        if (-not (Test-Path -LiteralPath (Join-Path $taskRoot 'dist/index.html'))) {
            throw 'TaskFlow build is missing. Run Start-TaskFlow.ps1 first.'
        }
        $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
        $serverPath = Join-Path $taskRoot 'server/index.js'
        $server = Start-Process -FilePath $nodePath -ArgumentList ('"' + $serverPath + '"') -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskRoot 'data/server.log') -RedirectStandardError (Join-Path $taskRoot 'data/server-error.log') -PassThru
        $server.Id | Set-Content -LiteralPath (Join-Path $taskRoot 'data/server.pid')
        $ready = $false
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            if (Test-TaskFlow) { $ready = $true; break }
            if ($server.HasExited) { break }
            Start-Sleep -Milliseconds 500
        }
        if (-not $ready) { throw 'TaskFlow could not start. See F:\TaskFlow\data\server-error.log.' }
    }
    & (Join-Path $taskRoot 'Start-Service-Guardian.ps1')
    if (-not $NoBrowser) { Start-Process $taskUrl }
} catch {
    if ($NoDialog) { Write-Error $_.Exception.Message -ErrorAction Continue; exit 1 }
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'TaskFlow') | Out-Null
    exit 1
} finally {
    if ($locked) { $guard.ReleaseMutex() }
    $guard.Dispose()
}
