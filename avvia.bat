@echo off
rem ============================================================
rem  Atlante Celeste - avvio
rem  Doppio clic: si apre la finestra del programma.
rem    avvia.bat            finestra del programma (applicazione desktop)
rem    avvia.bat browser    interfaccia in una scheda del browser
rem  Per avviarlo senza la finestra nera usa "Atlante Celeste.vbs"
rem  (o il collegamento creato da crea_collegamento.bat).
rem ============================================================
setlocal
cd /d "%~dp0"
title Atlante Celeste

set "MODO=desktop"
set "SILENZIOSO="
for %%a in (%*) do (
  if /i "%%a"=="browser" set "MODO=browser"
  if /i "%%a"=="silenzioso" set "SILENZIOSO=1"
)

call :trova_uv
if defined UV goto :uv_ok

echo.
echo  Installo "uv", lo strumento che gestisce Python per il progetto...
echo.
winget install --id=astral-sh.uv -e --accept-source-agreements --accept-package-agreements
call :trova_uv
if defined UV goto :uv_ok
call :avviso "Non riesco a installare uv in automatico. Istruzioni: https://docs.astral.sh/uv/getting-started/installation/"
exit /b 1

:uv_ok
if exist "frontend\dist\index.html" goto :avvio
echo  Compilo l'interfaccia 3D, serve solo la prima volta...
pushd frontend
call npm install
if errorlevel 1 goto :errore
call npm run build
if errorlevel 1 goto :errore
popd

:avvio
echo.
echo  Atlante Celeste si avvia (http://127.0.0.1:8765)
echo  La prima volta prepara Python e scarica i dati da NASA/JPL e CelesTrak:
echo  ci vuole qualche minuto.
echo.
if /i "%MODO%"=="browser" goto :browser

rem --- applicazione desktop (finestra nativa WebView2) ---
"%UV%" run --directory backend --group desktop python -m atlante --desktop
if not errorlevel 1 goto :eof
echo.
echo  La finestra del programma non si e' aperta: provo con il browser.
echo  (dettagli in data\cache\atlante.log)

:browser
"%UV%" run --directory backend python -m atlante --browser
if errorlevel 1 call :avviso "Il server si e' fermato con un errore. I dettagli sono in data\cache\atlante.log"
goto :eof

:trova_uv
rem cerca uv nel PATH e nelle cartelle dove winget lo installa
rem (subito dopo l'installazione il PATH di questa finestra non e' ancora aggiornato)
set "UV="
for /f "delims=" %%i in ('where uv 2^>nul') do if not defined UV set "UV=%%i"
if not defined UV if exist "%LOCALAPPDATA%\Microsoft\WinGet\Links\uv.exe" set "UV=%LOCALAPPDATA%\Microsoft\WinGet\Links\uv.exe"
if not defined UV if exist "%ProgramFiles%\WinGet\Links\uv.exe" set "UV=%ProgramFiles%\WinGet\Links\uv.exe"
if not defined UV if exist "%USERPROFILE%\.local\bin\uv.exe" set "UV=%USERPROFILE%\.local\bin\uv.exe"
if not defined UV if exist "%LOCALAPPDATA%\Microsoft\WinGet\Packages" (
  for /r "%LOCALAPPDATA%\Microsoft\WinGet\Packages" %%f in (uv.exe) do if not defined UV if exist "%%f" set "UV=%%f"
)
if not defined UV if exist "%ProgramFiles%\WinGet\Packages" (
  for /r "%ProgramFiles%\WinGet\Packages" %%f in (uv.exe) do if not defined UV if exist "%%f" set "UV=%%f"
)
exit /b 0

:avviso
rem messaggio d'errore: in console, oppure in una finestrella se avviato senza console
set "MSG=%~1"
echo.
echo  %MSG%
if not defined SILENZIOSO (
  pause
  exit /b 0
)
rem in PowerShell un apostrofo dentro '...' si scrive due volte
set "MSG=%MSG:'=''%"
powershell -NoProfile -Command "Add-Type -AssemblyName PresentationFramework; [void][System.Windows.MessageBox]::Show('%MSG%', 'Atlante Celeste')"
exit /b 0

:errore
popd
call :avviso "Qualcosa e' andato storto durante la compilazione dell'interfaccia."
exit /b 1
