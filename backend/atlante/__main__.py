"""Punto di avvio: `python -m atlante [--desktop | --browser | --server]`.

    --desktop   finestra nativa (predefinito in avvia.bat)
    --browser   interfaccia in una scheda del browser predefinito
    --server    solo il server dati (per lo sviluppo: npm run dev)

Qualsiasi errore all'avvio viene scritto anche in data/cache/atlante.log,
così si può capire cosa è successo anche se la finestra si chiude.
"""

import pathlib
import sys
import traceback

LOG = pathlib.Path(__file__).resolve().parent.parent.parent / "data" / "cache" / "atlante.log"

try:
    from .main import run

    args = set(sys.argv[1:])
    if "--desktop" in args:
        mode = "desktop"
    elif "--server" in args:
        mode = "server"
    elif "--browser" in args:
        mode = "browser"
    else:
        # compatibilità con le versioni precedenti: ATLANTE_OPEN_BROWSER=1 -> browser
        import os

        mode = "browser" if os.environ.get("ATLANTE_OPEN_BROWSER") == "1" else "server"
    run(mode)
except SystemExit:
    raise
except KeyboardInterrupt:
    sys.exit(0)
except BaseException:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as fh:
        fh.write("\n=== Errore all'avvio ===\n")
        traceback.print_exc(file=fh)
    traceback.print_exc()
    sys.exit(1)
