param([switch]$Unattended)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$config = Get-Content (Join-Path $PSScriptRoot 'service-watchdog-config.json') -Raw | ConvertFrom-Json
$account = $config.serviceUser
if (!$account) { throw 'serviceUser is missing from service-watchdog-config.json.' }
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$launcher = Join-Path $PSScriptRoot 'Watch-LocalServices-Hidden.vbs'
$action = New-ScheduledTaskAction -Execute $wscript -Argument ('//B //NoLogo "' + $launcher + '" Ensure') -WorkingDirectory $taskRoot
$hourly = New-ScheduledTaskTrigger -Once -At (Get-Date).AddHours(1) -RepetitionInterval (New-TimeSpan -Hours 1)
$logon = New-ScheduledTaskTrigger -AtLogOn -User $account
$principal = New-ScheduledTaskPrincipal -UserId $account -LogonType Interactive -RunLevel Limited
if ($Unattended) {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $admin = New-Object System.Security.Principal.WindowsPrincipal($identity)
    if (!$admin.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Unattended installation requires Windows administrator approval.' }
    # No stored password; run as the same user at limited privilege in the background.
    $principal = New-ScheduledTaskPrincipal -UserId $account -LogonType S4U -RunLevel Limited
}
# No deadline: Scheduler must not terminate long-lived service children.
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'TaskFlow-idv-web-HourlyCheck' -Action $action -Trigger @($hourly,$logon) -Principal $principal -Settings $settings -Description 'Hourly: start missing TaskFlow 4310/Guardian 4311; check production idv-web HTTPS. Hidden window, no build or deployment.' -Force | Out-Null
if ($Unattended) {
    # A fixed inline action protects the system-level task from user-writable script changes.
    # Only this action gets SYSTEM rights; the Node applications retain limited user rights.
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $tunnelAction = New-ScheduledTaskAction -Execute $ps -Argument '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -Command "if ((Get-Service -Name Cloudflared -ErrorAction Stop).Status -eq ''Stopped'') { Start-Service -Name Cloudflared -ErrorAction Stop }"'
    $system = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount
    Register-ScheduledTask -TaskName 'TaskFlow-Tunnel-HourlyCheck' -Action $tunnelAction -Trigger @($hourly,(New-ScheduledTaskTrigger -AtStartup)) -Principal $system -Settings $settings -Description 'Start the existing Cloudflared Windows service only when stopped; no tunnel configuration changes.' -Force | Out-Null
    Start-ScheduledTask -TaskName 'TaskFlow-Tunnel-HourlyCheck'
}
$desktop = $config.desktopPath
if (!$desktop -or !(Test-Path -LiteralPath $desktop)) { throw 'Configured desktop directory was not found.' }
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut((Join-Path $desktop '重啟 TaskFlow 與檢查 idv-web.lnk'))
$link.TargetPath = $wscript
$link.Arguments = '//B //NoLogo "' + $launcher + '" Restart'
$link.WorkingDirectory = $taskRoot
$link.WindowStyle = 7
$link.Description = '隱藏視窗重啟 TaskFlow 4310／Guardian 4311，檢查 idv-web 正式站；不部署。結果：data\service-watchdog.log'
$link.IconLocation = (Join-Path $env:SystemRoot 'System32\shell32.dll') + ',238'
$link.Save()
Write-Output "Installed task: TaskFlow-idv-web-HourlyCheck"
Write-Output "Desktop shortcut: $($link.FullName)"
if ($Unattended) { Start-ScheduledTask -TaskName 'TaskFlow-idv-web-HourlyCheck' }
