@echo off
rem ============================================================
rem  Atlante Celeste - modalita' sviluppo
rem  Avvia il server dati e l'interfaccia con ricarica automatica:
rem  ogni modifica al codice in frontend\src si vede subito nel browser.
rem  Indirizzo: http://localhost:5173
rem ============================================================
setlocal
cd /d "%~dp0"
start "Atlante Celeste - server dati" cmd /k "uv run --directory backend python -m atlante"
pushd frontend
if not exist node_modules call npm install
start "" cmd /c "timeout /t 5 /nobreak >nul & start http://localhost:5173"
call npm run dev
popd
