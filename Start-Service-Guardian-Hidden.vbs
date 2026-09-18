Option Explicit
Dim files, shell, root, command, result
Set files = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
root = files.GetParentFolderName(WScript.ScriptFullName)
command = """" & shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"" -NoProfile -WindowStyle Hidden -File """ & files.BuildPath(root, "Start-Service-Guardian.ps1") & """"
result = shell.Run(command, 0, True)
WScript.Quit result
