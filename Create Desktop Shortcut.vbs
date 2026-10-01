Option Explicit
Dim shell, files, root, shortcut
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(WScript.ScriptFullName)
Set shortcut = shell.CreateShortcut(shell.SpecialFolders("Desktop") & "\Groovy.lnk")
shortcut.TargetPath = files.BuildPath(root, "Start Groovy.vbs")
shortcut.WorkingDirectory = root
shortcut.Description = "Groovy Offline Beauty Simulator"
shortcut.Save
MsgBox "Groovy shortcut created on your Desktop. Keep the project folder in its current location.", 64, "Groovy"
