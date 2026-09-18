$ErrorActionPreference='Stop'
$account=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$launcher=Join-Path $PSScriptRoot 'Start-Service-Guardian.ps1'
$hiddenLauncher=Join-Path $PSScriptRoot 'Start-Service-Guardian-Hidden.vbs'
$action=New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\wscript.exe') -Argument ('//B //NoLogo "'+$hiddenLauncher+'"') -WorkingDirectory $PSScriptRoot
$repeat=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$logon=New-ScheduledTaskTrigger -AtLogOn -User $account
$principal=New-ScheduledTaskPrincipal -UserId $account -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'TaskFlow-ServiceGuardian' -Action $action -Trigger @($repeat,$logon) -Principal $principal -Settings $settings -Description 'Keep the local TaskFlow LINE recovery guardian running.' -Force | Out-Null
& $launcher
