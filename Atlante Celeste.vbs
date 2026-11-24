' ============================================================
'  Atlante Celeste - avvio senza la finestra nera della console
'  (e' il file a cui punta il collegamento sul desktop)
' ============================================================
Option Explicit
Dim fso, sh, root, pronto
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = root

' Al primo avvio (o se manca qualcosa) la console resta visibile:
' mostra l'installazione di Python e delle librerie.
pronto = fso.FolderExists(root & "\backend\.venv") And fso.FileExists(root & "\frontend\dist\index.html")
If pronto Then
  sh.Run "cmd /c """"" & root & "\avvia.bat"" silenzioso""", 0, False
Else
  sh.Run "cmd /c """"" & root & "\avvia.bat""""", 1, False
End If
