# ============================================================
#  Atlante Celeste - crea i collegamenti sul Desktop e nel menu Start
#  (con l'icona del programma). Si puo' rieseguire: li aggiorna.
# ============================================================
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$vbs = Join-Path $root 'Atlante Celeste.vbs'
$ico = Join-Path $root 'data\app\atlante.ico'
$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
$shell = New-Object -ComObject WScript.Shell

$destinazioni = @(
  [Environment]::GetFolderPath('Desktop'),
  [Environment]::GetFolderPath('Programs')
)
foreach ($cartella in $destinazioni) {
  if (-not $cartella) { continue }
  $lnk = $shell.CreateShortcut((Join-Path $cartella 'Atlante Celeste.lnk'))
  $lnk.TargetPath = $wscript
  $lnk.Arguments = '"' + $vbs + '"'
  $lnk.WorkingDirectory = $root
  $lnk.IconLocation = $ico + ',0'
  $lnk.Description = 'Atlante Celeste - il Sistema Solare in tempo reale'
  $lnk.Save()
  Write-Host ('  Collegamento creato in: ' + $cartella)
}
