' Chánh Điện Tịnh Tâm — Silent Background Service Starter
' Launches supervisor.mjs completely hidden (style 0 = no console window)

Option Explicit
Dim fso, shell, scriptDir, nodeExe, supervisorScript, cmd

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
supervisorScript = scriptDir & "\supervisor.mjs"

' Locate node.exe
If fso.FileExists("C:\Program Files\nodejs\node.exe") Then
    nodeExe = "C:\Program Files\nodejs\node.exe"
Else
    nodeExe = "node.exe"
End If

shell.CurrentDirectory = scriptDir
cmd = """" & nodeExe & """ """ & supervisorScript & """"

' Run style 0 = Hidden, bWaitOnReturn = False
shell.Run cmd, 0, False

Set shell = Nothing
Set fso = Nothing
