@echo off
rem ============================================================
rem  Atlante Celeste - crea il collegamento sul Desktop e nel menu Start
rem  Basta eseguirlo una volta (doppio clic).
rem ============================================================
setlocal
cd /d "%~dp0"
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\crea_collegamento.ps1"
if errorlevel 1 (
  echo.
  echo  Non sono riuscito a creare il collegamento.
) else (
  echo.
  echo  Fatto! Ora puoi aprire Atlante Celeste dall'icona sul Desktop.
)
echo.
pause
