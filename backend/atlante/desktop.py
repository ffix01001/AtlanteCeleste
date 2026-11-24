"""Atlante Celeste come applicazione desktop.

Apre una finestra nativa del sistema operativo (su Windows il motore WebView2,
lo stesso di Microsoft Edge; sul Mac WebKit, lo stesso di Safari; in entrambi i casi
con l'accelerazione della scheda video) invece di una scheda del browser. Il server dati gira nello stesso processo, in un thread
separato: chiudendo la finestra si chiude tutto.

Se la finestra nativa non è disponibile (libreria pywebview mancante, WebView2
assente, ...) si ripiega automaticamente sul browser predefinito.
"""

from __future__ import annotations

import logging
import sys
import threading
import time
import webbrowser

log = logging.getLogger("atlante.desktop")

SPLASH = """<!doctype html><html><head><meta charset="utf-8">
<style>
  html,body{margin:0;height:100%;background:#010208;color:#e9e6dc;font-family:Georgia,serif;}
  .c{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px}
  h1{font-weight:400;letter-spacing:.06em;margin:0;font-size:34px}
  p{margin:0;color:#8f8b82;font:14px system-ui,sans-serif}
  .o{width:64px;height:64px;position:relative}
  .o i{position:absolute;inset:26px;border-radius:50%;background:#e9e6dc}
  .o b{position:absolute;inset:4px;border:1.6px solid #c9a45c;border-radius:50%;transform:rotateX(68deg) rotate(-20deg);
       animation:r 3s linear infinite}
  @keyframes r{to{transform:rotateX(68deg) rotate(340deg)}}
</style></head><body><div class="c"><div class="o"><b></b><i></i></div>
<h1>Atlante Celeste</h1><p>Avvio del motore dati…</p></div></body></html>"""


# scritte della schermata d'avvio, nella lingua scelta l'ultima volta nell'interfaccia
SPLASH_TEXT = {
    "it": ("Avvio del motore dati…", "Il server non è partito: dettagli in data/cache/atlante.log"),
    "en": ("Starting the data engine…", "The server did not start: details in data/cache/atlante.log"),
    "es": ("Iniciando el motor de datos…", "El servidor no se ha iniciado: detalles en data/cache/atlante.log"),
    "de": ("Daten-Engine wird gestartet…", "Der Server ist nicht gestartet: Details in data/cache/atlante.log"),
    "fr": ("Démarrage du moteur de données…", "Le serveur n'a pas démarré : détails dans data/cache/atlante.log"),
}


def splash_lang() -> str:
    """Lingua della schermata d'avvio: l'ultima scelta nell'interfaccia, altrimenti quella del sistema."""
    from .config import LANG_FILE

    try:
        code = LANG_FILE.read_text(encoding="utf-8").strip()
        if code in SPLASH_TEXT:
            return code
    except OSError:
        pass
    import locale
    import os

    for raw in (os.environ.get("LC_ALL"), os.environ.get("LANG"), (locale.getlocale()[0] or "")):
        code = (raw or "").split("_")[0].split("-")[0].lower()
        if code in SPLASH_TEXT:
            return code
    return "en"


def splash(failed: bool = False) -> str:
    code = splash_lang()
    text = SPLASH_TEXT[code][1 if failed else 0]
    return SPLASH.replace("<html>", f'<html lang="{code}">').replace("Avvio del motore dati…", text)


class DesktopApi:
    """Funzioni chiamabili dalla pagina con window.pywebview.api.<nome>()."""

    def __init__(self) -> None:
        self._window = None  # attributo privato: pywebview espone solo quelli pubblici

    def toggle_fullscreen(self) -> bool:
        if self._window is not None:
            self._window.toggle_fullscreen()
        return True

    def info(self) -> dict:
        return {"desktop": True}


def _identita_mac(sul_thread_principale: bool = True) -> None:
    """Sul Mac: nome e icona di Atlante Celeste nel Dock e nella barra dei menu.

    Senza, comparirebbero quelli di Python (il programma gira dentro l'interprete).
    Su Windows e Linux non fa nulla; qualsiasi errore è solo estetico e viene ignorato.
    """
    if sys.platform != "darwin":
        return

    def applica() -> None:
        try:
            from AppKit import NSApplication, NSImage  # da pyobjc, installato insieme a pywebview
            from Foundation import NSBundle, NSProcessInfo

            from .config import DATA_DIR

            info = NSBundle.mainBundle().infoDictionary()
            if info is not None:
                info["CFBundleName"] = "Atlante Celeste"
            NSProcessInfo.processInfo().setProcessName_("Atlante Celeste")
            icona = DATA_DIR / "app" / "atlante-512.png"
            if icona.exists():
                img = NSImage.alloc().initWithContentsOfFile_(str(icona))
                if img is not None:
                    NSApplication.sharedApplication().setApplicationIconImage_(img)
        except Exception as exc:  # pragma: no cover - solo estetica
            log.debug("Icona e nome sul Mac non impostati: %s", exc)

    if sul_thread_principale:
        applica()
        return
    try:
        from PyObjCTools import AppHelper

        AppHelper.callAfter(applica)
    except Exception as exc:  # pragma: no cover
        log.debug("Icona sul Mac non aggiornata: %s", exc)


def run_desktop(server, url: str) -> bool:
    """Apre la finestra. Restituisce False se la finestra nativa non è disponibile.

    `server` è un uvicorn.Server già configurato (non ancora avviato).
    """
    try:
        import webview  # pywebview
    except Exception as exc:  # libreria assente o non installabile su questo sistema
        log.warning("Finestra nativa non disponibile (%s): uso il browser", exc)
        return False

    thread = threading.Thread(target=server.run, name="atlante-server", daemon=True)
    thread.start()

    _identita_mac()
    api = DesktopApi()
    window = webview.create_window(
        "Atlante Celeste",
        html=splash(),
        js_api=api,
        width=1600,
        height=960,
        min_size=(960, 600),
        background_color="#010208",
        maximized=True,
        text_select=True,
    )
    api._window = window

    def when_ready() -> None:
        # sul Mac l'icona si riapplica a finestra aperta (all'avvio il sistema può reimpostarla)
        _identita_mac(sul_thread_principale=False)
        # si attende che il server risponda, poi si carica l'interfaccia
        t0 = time.time()
        while not getattr(server, "started", False):
            if not thread.is_alive():
                log.error("Il server si è fermato durante l'avvio: vedi i messaggi precedenti")
                window.load_html(splash(failed=True))
                return
            if time.time() - t0 > 120:
                log.error("Il server non risponde dopo 2 minuti")
                return
            time.sleep(0.1)
        window.load_url(url)

    from .config import CACHE_DIR

    try:
        webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = True
        webview.start(
            when_ready,
            private_mode=False,  # conserva le preferenze (livelli, magnitudine...) fra un avvio e l'altro
            storage_path=str(CACHE_DIR / "finestra"),
        )
    except Exception as exc:
        # il server è già partito in questo processo: si apre il browser e si resta in ascolto
        log.exception("La finestra nativa non si è aperta (%s): uso il browser", exc)
        t0 = time.time()
        while thread.is_alive() and not getattr(server, "started", False) and time.time() - t0 < 120:
            time.sleep(0.1)
        if getattr(server, "started", False):
            webbrowser.open(url)
            try:
                thread.join()
            except KeyboardInterrupt:
                pass
        server.should_exit = True
        return True
    server.should_exit = True  # finestra chiusa: si spegne anche il server
    thread.join(timeout=8)
    return True


def run_window_only(url: str) -> bool:
    """Il server è già in funzione (un'altra istanza): si apre solo una finestra."""
    try:
        import webview
    except Exception:
        return False
    from .config import CACHE_DIR

    _identita_mac()
    api = DesktopApi()
    window = webview.create_window(
        "Atlante Celeste", url, js_api=api, width=1600, height=960, min_size=(960, 600),
        background_color="#010208", maximized=True, text_select=True,
    )
    api._window = window
    try:
        webview.start(private_mode=False, storage_path=str(CACHE_DIR / "finestra"))
    except Exception:
        log.exception("La finestra nativa non si è aperta")
        return False
    return True
