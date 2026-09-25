Option Explicit
Dim files, shell, root, command, result, mode
Set files = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
root = files.GetParentFolderName(WScript.ScriptFullName)
mode = "Ensure"
If WScript.Arguments.Count > 0 Then mode = WScript.Arguments(0)
If mode <> "Ensure" And mode <> "Restart" Then WScript.Quit 2
command = """" & shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & files.BuildPath(root, "Watch-LocalServices.ps1") & """ -Mode " & mode
result = shell.Run(command, 0, True)
WScript.Quit result
