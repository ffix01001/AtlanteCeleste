"""Percorsi e impostazioni globali.

Tutto ciò che può cambiare tra un'installazione e l'altra si imposta qui
oppure con variabili d'ambiente (ATLANTE_*), così il codice resta pulito.
"""

from __future__ import annotations

import os
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
ROOT_DIR = BACKEND_DIR.parent

DATA_DIR = ROOT_DIR / "data"
CATALOG_DIR = DATA_DIR / "catalog"          # dati strutturati dei corpi (JSON)
CONTENT_DIR = DATA_DIR / "content"          # schede testuali (Markdown, per lingua)
CATALOG_I18N_DIR = DATA_DIR / "catalog_i18n"  # traduzioni dei campi del catalogo (una per lingua)
GENERATED_DIR = DATA_DIR / "generated"      # file binari prodotti dagli script (stelle, ...)
TEXTURES_DIR = DATA_DIR / "textures"        # texture scaricate al primo uso
ASSET_TEXTURES_DIR = DATA_DIR / "assets" / "textures"  # texture incluse nel progetto (lune, asteroidi)
ASSET_DSO_DIR = DATA_DIR / "assets" / "dso"            # foto di nebulose, ammassi e galassie
ASSET_MODELS_DIR = DATA_DIR / "assets" / "models"      # modelli 3D di sonde e satelliti
CACHE_DIR = DATA_DIR / "cache"              # cache delle risposte delle fonti esterne
FRONTEND_DIST = ROOT_DIR / "frontend" / "dist"
SNAPSHOT_DIR = ROOT_DIR / "immagini"         # fotografie della scena salvate dal programma (tasto P)

HOST = os.environ.get("ATLANTE_HOST", "127.0.0.1")
PORT = int(os.environ.get("ATLANTE_PORT", "8765"))
LANG = os.environ.get("ATLANTE_LANG", "it")

# Lingue dell'interfaccia. L'italiano è la lingua di partenza: se manca una traduzione
# si ripiega sull'inglese e poi sull'italiano.
LANGS = ("it", "en", "es", "de", "fr")


LANG_FILE = CACHE_DIR / "lingua.txt"          # ultima lingua scelta nell'interfaccia (per la schermata d'avvio)


def lang_chain(lang: str | None) -> list[str]:
    """Lingue da provare in ordine, per esempio "de" -> ["de", "en", "it"]."""
    first = lang if lang in LANGS else "en"
    out: list[str] = []
    for code in (first, "en", "it"):
        if code not in out:
            out.append(code)
    return out

# Identificazione educata verso i servizi pubblici (JPL, CelesTrak, Wikipedia).
# Wikimedia chiede anche un recapito: se vuoi, imposta ATLANTE_CONTACT con la
# tua email o una pagina web (resta solo nelle richieste ai servizi pubblici).
CONTACT = os.environ.get("ATLANTE_CONTACT", "").strip()
USER_AGENT = (
    "AtlanteCeleste/1.0 (planetario 3D, software libero"
    + (f"; {CONTACT}" if CONTACT else "")
    + ") python-httpx"
)

# Insiemi di corpi minori scaricati dal JPL Small-Body Database.
# Si possono allargare liberamente: la grafica li calcola sulla GPU.
SMALL_BODY_SETS: dict[str, dict] = {
    "comete": {
        "label": "Comete",
        "params": {"sb-kind": "c"},
        "ttl_days": 3,
    },
    "neo": {
        "label": "Asteroidi near-Earth (NEO)",
        "params": {"sb-kind": "a", "sb-group": "neo"},
        "ttl_days": 3,
    },
    "principali": {
        "label": "Asteroidi numerati (H < 16)",
        "params": {"sb-kind": "a", "sb-ns": "n", "sb-cdata": '{"AND":["H|LT|16"]}'},
        "ttl_days": 14,
    },
    "tno": {
        "label": "Oggetti transnettuniani",
        "params": {"sb-kind": "a", "sb-class": "TNO"},
        "ttl_days": 14,
    },
}

# Gruppi di satelliti terrestri (CelesTrak). "active" = tutti quelli operativi.
SATELLITE_GROUPS = ("active",)
