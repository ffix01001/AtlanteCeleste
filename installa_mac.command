#!/bin/bash
# ============================================================
#  Atlante Celeste - installazione sul Mac
#  Nel Terminale:  bash ~/Downloads/AtlanteCeleste/installa_mac.command
#
#   1. se il progetto è in Download, Scrivania o Documenti lo sposta in
#      ~/Progetti/AtlanteCeleste (fuori da iCloud e dalle cartelle protette)
#   2. installa uv (se manca) e prepara Python con le librerie
#   3. crea l'app "Atlante Celeste" fra le Applicazioni, con la sua icona
#   4. la apre
#  Si può rieseguire quando si vuole: aggiorna l'app (per esempio se sposti la cartella).
#  Non cancella nulla.
# ============================================================

SRC="$(cd "$(dirname "$0")" && pwd -P)" || exit 1
DEST="$HOME/Progetti/AtlanteCeleste"

echo
echo "  Atlante Celeste - installazione sul Mac"
echo

# --- 1. posizione del progetto ---------------------------------------------
ROOT="$SRC"
case "$SRC" in
  "$HOME/Downloads"/* | "$HOME/Desktop"/* | "$HOME/Documents"/* | "$HOME/Library/Mobile Documents"/*)
    if [ -e "$DEST" ]; then
      echo "  Esiste già $DEST: non tocco nulla e uso la cartella attuale:"
      echo "  $SRC"
    elif mkdir -p "$HOME/Progetti" && mv "$SRC" "$DEST"; then
      ROOT="$DEST"
      echo "  Ho spostato il progetto in $DEST"
    else
      echo "  Non sono riuscito a spostare il progetto: resto in $SRC"
    fi
    ;;
esac
cd "$ROOT" || exit 1

# i file scaricati da internet sono "in quarantena": il Mac chiederebbe conferma per ognuno
/usr/bin/xattr -dr com.apple.quarantine "$ROOT" 2>/dev/null
chmod +x "$ROOT/avvia.command" "$ROOT/installa_mac.command" 2>/dev/null

# --- 2. uv e Python --------------------------------------------------------
trova_uv() {
  UV=
  for c in "$(command -v uv 2>/dev/null)" "$HOME/.local/bin/uv" "$HOME/.cargo/bin/uv" /opt/homebrew/bin/uv /usr/local/bin/uv; do
    if [ -n "$c" ] && [ -x "$c" ]; then UV="$c"; return 0; fi
  done
  return 1
}

if ! trova_uv; then
  echo
  echo "  Installo \"uv\", lo strumento che gestisce Python per il progetto..."
  echo
  if command -v brew >/dev/null 2>&1; then
    brew install uv
  else
    /usr/bin/curl -LsSf https://astral.sh/uv/install.sh | /bin/sh
  fi
  if ! trova_uv; then
    echo
    echo "  Non riesco a installare uv in automatico."
    echo "  Istruzioni: https://docs.astral.sh/uv/getting-started/installation/"
    exit 1
  fi
fi

echo
echo "  Preparo Python e le librerie (la prima volta ci vuole qualche minuto)..."
echo
if ! "$UV" sync --directory "$ROOT/backend" --group desktop; then
  echo
  echo "  Qualcosa è andato storto preparando Python: riprova fra poco (serve internet)."
  exit 1
fi

# --- 3. l'app fra le Applicazioni ------------------------------------------
APPDIR=/Applications
[ -w "$APPDIR" ] || APPDIR="$HOME/Applications"
mkdir -p "$APPDIR"
APP="$APPDIR/Atlante Celeste.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Atlante Celeste</string>
  <key>CFBundleDisplayName</key><string>Atlante Celeste</string>
  <key>CFBundleIdentifier</key><string>local.atlanteceleste.avvio</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>AtlanteCeleste</string>
  <key>CFBundleIconFile</key><string>atlante</string>
  <!-- l'icona nel Dock è quella della finestra del programma, non di questo lanciatore -->
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

{
  echo '#!/bin/bash'
  echo '# Lanciatore di Atlante Celeste, creato da installa_mac.command'
  printf 'ROOT=%q\n' "$ROOT"
  cat <<'LAUNCHER'
if [ ! -f "$ROOT/avvia.command" ]; then
  /usr/bin/osascript - "$ROOT" >/dev/null 2>&1 <<'APPLESCRIPT'
on run argv
  display alert "Atlante Celeste" message ("Non trovo la cartella del progetto (" & item 1 of argv & "). Se l'hai spostata, riesegui installa_mac.command dalla nuova posizione.") as critical
end run
APPLESCRIPT
  exit 1
fi
# senza Python pronto si apre il Terminale, per vedere l'installazione
if [ ! -d "$ROOT/backend/.venv" ]; then
  /usr/bin/open -a Terminal "$ROOT/avvia.command"
  exit 0
fi
mkdir -p "$ROOT/data/cache"
exec /bin/bash "$ROOT/avvia.command" silenzioso >"$ROOT/data/cache/avvio.log" 2>&1
LAUNCHER
} > "$APP/Contents/MacOS/AtlanteCeleste"
chmod +x "$APP/Contents/MacOS/AtlanteCeleste"
cp "$ROOT/data/app/atlante.icns" "$APP/Contents/Resources/atlante.icns"
touch "$APP"
LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
[ -x "$LSREG" ] && "$LSREG" -f "$APP" >/dev/null 2>&1

echo
echo "  Fatto! Atlante Celeste è in $APPDIR (lo trovi anche con Spotlight o nel Launchpad)."
echo "  Per tenerlo nel Dock, trascina l'app dalla cartella Applicazioni al Dock."
echo

# --- 4. primo avvio --------------------------------------------------------
/usr/bin/open "$APP"
