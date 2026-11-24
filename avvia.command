#!/bin/bash
# ============================================================
#  Atlante Celeste - avvio sul Mac
#  Doppio clic (o "bash avvia.command" nel Terminale): si apre la finestra del programma.
#    avvia.command            finestra del programma (applicazione desktop)
#    avvia.command browser    interfaccia in una scheda del browser
#  Per averlo fra le Applicazioni, con la sua icona: installa_mac.command
# ============================================================

cd "$(dirname "$0")" || exit 1

MODO=desktop
SILENZIOSO=
for a in "$@"; do
  case "$a" in
    browser) MODO=browser ;;
    silenzioso) SILENZIOSO=1 ;;
  esac
done

# messaggio d'errore: nel Terminale, oppure in una finestrella se avviato dall'icona
avviso() {
  echo
  echo "  $1"
  if [ -n "$SILENZIOSO" ]; then
    /usr/bin/osascript - "$1" >/dev/null 2>&1 <<'APPLESCRIPT'
on run argv
  display alert "Atlante Celeste" message (item 1 of argv) as critical
end run
APPLESCRIPT
  fi
}

# cerca uv nel PATH e dove lo mettono l'installatore ufficiale e Homebrew
# (un'app aperta dal Finder non vede il PATH del Terminale)
trova_uv() {
  UV=
  for c in "$(command -v uv 2>/dev/null)" "$HOME/.local/bin/uv" "$HOME/.cargo/bin/uv" /opt/homebrew/bin/uv /usr/local/bin/uv; do
    if [ -n "$c" ] && [ -x "$c" ]; then UV="$c"; return 0; fi
  done
  return 1
}

if ! trova_uv; then
  if [ -n "$SILENZIOSO" ]; then
    avviso "Manca uv, lo strumento che gestisce Python per il progetto. Avvia una volta installa_mac.command dal Terminale."
    exit 1
  fi
  echo
  echo "  Installo \"uv\", lo strumento che gestisce Python per il progetto..."
  echo
  if command -v brew >/dev/null 2>&1; then
    brew install uv
  else
    /usr/bin/curl -LsSf https://astral.sh/uv/install.sh | /bin/sh
  fi
  if ! trova_uv; then
    avviso "Non riesco a installare uv in automatico. Istruzioni: https://docs.astral.sh/uv/getting-started/installation/"
    exit 1
  fi
fi

if [ ! -f frontend/dist/index.html ]; then
  echo "  Compilo l'interfaccia 3D, serve solo la prima volta..."
  if ! command -v npm >/dev/null 2>&1; then
    avviso "Manca l'interfaccia compilata (frontend/dist) e per ricrearla serve Node.js (https://nodejs.org)."
    exit 1
  fi
  if ! (cd frontend && npm install && npm run build); then
    avviso "Qualcosa è andato storto durante la compilazione dell'interfaccia."
    exit 1
  fi
fi

echo
echo "  Atlante Celeste si avvia (http://127.0.0.1:8765)"
echo "  La prima volta prepara Python e scarica i dati da NASA/JPL e CelesTrak:"
echo "  ci vuole qualche minuto."
echo

if [ "$MODO" = desktop ]; then
  # finestra nativa (WebKit, lo stesso motore di Safari)
  if "$UV" run --directory backend --group desktop python -m atlante --desktop; then
    exit 0
  fi
  echo
  echo "  La finestra del programma non si è aperta: provo con il browser."
  echo "  (dettagli in data/cache/atlante.log)"
fi

if ! "$UV" run --directory backend python -m atlante --browser; then
  avviso "Il server si è fermato con un errore. I dettagli sono in data/cache/atlante.log"
  exit 1
fi
