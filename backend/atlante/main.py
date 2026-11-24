"""Server locale di Atlante Celeste (FastAPI).

Avvio:  uv run python -m atlante      (dalla cartella backend)
Poi aprire http://127.0.0.1:8765
"""

from __future__ import annotations

import asyncio
import json
import logging
import logging.handlers
import os
import struct
import threading
import time
import webbrowser
import zlib
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import __author__, __version__, binpack
from .cache import Cache
from .catalog import Catalog
from .config import CACHE_DIR, DATA_DIR, FRONTEND_DIST, LANG, LANG_FILE, LANGS, SATELLITE_GROUPS, SMALL_BODY_SETS, SNAPSHOT_DIR, lang_chain
from .ephemeris import CHUNK_DAYS, EphemerisService
from .http import Http
from .sources import celestrak, exoplanets, geocode, models, sbdb, textures, wikipedia
from .gaia_job import GaiaJob
from .stars import STARS_BIN, Stars
from .timeutil import J2000, jd_now_tdb

log = logging.getLogger("atlante")

OMM_KEYS = (
    "OBJECT_NAME", "OBJECT_ID", "EPOCH", "MEAN_MOTION", "ECCENTRICITY", "INCLINATION",
    "RA_OF_ASC_NODE", "ARG_OF_PERICENTER", "MEAN_ANOMALY", "EPHEMERIS_TYPE", "CLASSIFICATION_TYPE",
    "NORAD_CAT_ID", "ELEMENT_SET_NO", "REV_AT_EPOCH", "BSTAR", "MEAN_MOTION_DOT", "MEAN_MOTION_DDOT",
)


class State:
    http: Http
    cache: Cache
    catalog: Catalog
    ephem: EphemerisService
    stars: Stars
    gaia: GaiaJob
    satcat: dict[int, dict[str, Any]] | None = None
    satcat_loaded_at: float = 0.0
    satcat_task: asyncio.Task | None = None
    exo_task: asyncio.Task | None = None


S = State()


@asynccontextmanager
async def lifespan(app: FastAPI):
    S.http = Http()
    S.cache = Cache(CACHE_DIR / "cache.sqlite3")
    # le traiettorie delle sonde si riscaricano ogni 5 giorni con una chiave nuova: le copie
    # superate da più di un mese si tolgono (resta sempre l'ultima, per l'uso senza rete)
    try:
        removed = S.cache.purge_superseded("trail:v1:", 30 * 86400)
        if removed:
            log.info("Cache: tolte %d traiettorie superate", removed)
    except Exception as exc:  # la pulizia non deve mai impedire l'avvio
        log.warning("Pulizia della cache non riuscita: %s", exc)
    S.catalog = Catalog()
    S.ephem = EphemerisService(S.http, S.cache, S.catalog)
    S.stars = Stars()
    S.gaia = GaiaJob(before_swap=lambda: S.stars.reset("gaia"))
    # il catalogo SATCAT si prepara subito in sottofondo (di solito arriva dalla cache)
    S.satcat_task = asyncio.create_task(_satcat_load())
    # gli esopianeti (NASA Exoplanet Archive) entrano nel catalogo appena disponibili
    S.exo_task = asyncio.create_task(_exo_load())
    log.info("Atlante Celeste %s pronto", __version__)
    if os.environ.get("ATLANTE_OPEN_BROWSER") == "1":
        from .config import HOST, PORT

        url = f"http://{HOST}:{PORT}"
        threading.Timer(1.5, webbrowser.open, args=(url,)).start()
    yield
    await S.http.close()


app = FastAPI(title="Atlante Celeste", version=__version__, lifespan=lifespan)
# compressione al livello più leggero: il server parla solo con questo computer, quindi i byte
# risparmiati non contano, mentre al livello massimo (quello predefinito) comprimere asteroidi e
# satelliti teneva fermo il server per un paio di secondi a ogni avvio
app.add_middleware(GZipMiddleware, minimum_size=2048, compresslevel=1)


@app.middleware("http")
async def only_from_atlante(request: Request, call_next):
    """Le richieste che cambiano qualcosa (POST) devono arrivare dal programma, che aggiunge
    l'intestazione X-Atlante. Una pagina web qualsiasi aperta nel browser non può aggiungerla
    senza il permesso del server (che non lo dà): così non può scrivere file né avviare download qui."""
    if request.method == "POST" and request.url.path.startswith("/api/") and request.headers.get("x-atlante") != "1":
        return JSONResponse({"detail": "Richiesta non valida"}, status_code=403)
    return await call_next(request)


@app.middleware("http")
async def no_stale_interface(request: Request, call_next):
    """L'interfaccia ha nomi di file fissi: il browser deve sempre ricontrollarli
    (risposta 304 se non sono cambiati), così dopo un aggiornamento vede subito la nuova versione."""
    response = await call_next(request)
    if not request.url.path.startswith("/api/"):
        response.headers.setdefault("Cache-Control", "no-cache")
    return response


# ---------------------------------------------------------------- generali
@app.post("/api/lang")
async def set_lang(request: Request) -> dict[str, Any]:
    """L'interfaccia comunica la lingua scelta: la schermata d'avvio la userà la prossima volta."""
    try:
        code = str((await request.json()).get("lang"))
    except Exception:
        raise HTTPException(400, "Dati non validi")
    if code not in LANGS:
        raise HTTPException(400, "Lingua non prevista")
    try:
        LANG_FILE.parent.mkdir(parents=True, exist_ok=True)
        if not LANG_FILE.exists() or LANG_FILE.read_text(encoding="utf-8").strip() != code:
            LANG_FILE.write_text(code, encoding="utf-8")
    except OSError:
        pass
    return {"ok": True}


@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "version": __version__,
        "jd_tdb": jd_now_tdb(),
        "chunk_days": CHUNK_DAYS,
        "j2000": J2000,
        "cache": S.cache.stats(),
        "bodies": len(S.catalog.order),
        "stars": S.stars.available(),
    }


async def _exo_load() -> None:
    async def produce() -> list[dict[str, Any]]:
        return await exoplanets.fetch(S.http)

    try:
        rows = await S.cache.fetch_json("exo:v1", 30 * 86400, produce)
        bodies = exoplanets.build_bodies(rows)
        S.catalog.set_extra(bodies)
        log.info("Esopianeti: %d corpi (stelle e pianeti)", len(bodies))
    except Exception as exc:
        log.warning("Esopianeti non disponibili: %s", exc)


@app.get("/api/catalog")
async def catalog(lang: str = LANG) -> dict[str, Any]:
    # al primo avvio gli esopianeti stanno ancora arrivando: si aspetta qualche secondo, non di più
    if S.exo_task is not None and not S.exo_task.done():
        try:
            await asyncio.wait_for(asyncio.shield(S.exo_task), 8.0)
        except Exception:
            pass
    return {"bodies": S.catalog.listing(lang), "chunk_days": CHUNK_DAYS, "j2000": J2000}


@app.post("/api/catalog/reload")
async def catalog_reload() -> dict[str, Any]:
    S.catalog.reload()
    return {"bodies": len(S.catalog.order)}


@app.get("/api/body/{body_id:path}")
async def body(body_id: str, lang: str = LANG) -> dict[str, Any]:
    b = S.catalog.get(body_id)
    if b is None:
        raise HTTPException(404, f"Corpo non presente nel catalogo: {body_id}")
    out = S.catalog.localized(b, lang)
    out["content_md"] = S.catalog.content(b, lang)
    out["content_lang"] = S.catalog.content_lang(b, lang)
    return out


# ---------------------------------------------------------------- effemeridi
@app.get("/api/ephem/{body_id:path}")
async def ephem(body_id: str, chunk: int = Query(...)) -> dict[str, Any]:
    return await S.ephem.chunk(body_id, chunk)


@app.get("/api/trail/{body_id:path}")
async def trail(body_id: str) -> dict[str, Any]:
    return await S.ephem.trail(body_id)


# ---------------------------------------------------------------- corpi minori
@app.get("/api/smallbodies")
async def smallbody_sets() -> dict[str, Any]:
    return {"sets": [{"id": k, "label": v["label"]} for k, v in SMALL_BODY_SETS.items()]}


@app.get("/api/smallbodies/{set_id}.bin")
async def smallbodies(set_id: str) -> Response:
    cfg = SMALL_BODY_SETS.get(set_id)
    if cfg is None:
        raise HTTPException(404, "Insieme sconosciuto")

    async def produce() -> bytes:
        js = await sbdb.bulk(S.http, cfg["params"])
        meta, cols = sbdb.pack_bulk(js)
        meta["set"] = set_id
        meta["label"] = cfg["label"]
        meta["source"] = "NASA/JPL Small-Body Database"
        meta["frame"] = "eclittica J2000, eliocentrico"
        meta["fetched_unix"] = time.time()
        return binpack.pack(meta, cols)

    try:
        entry = await S.cache.fetch(f"sbset:v2:{set_id}", cfg["ttl_days"] * 86400, produce)
    except Exception as exc:
        raise HTTPException(503, f"SBDB non raggiungibile: {exc}")
    return Response(entry.data, media_type="application/octet-stream")


@app.get("/api/sb/{des:path}")
async def small_body_details(des: str) -> dict[str, Any]:
    async def produce() -> dict[str, Any]:
        return await sbdb.body(S.http, des)

    try:
        info = await S.cache.fetch_json(f"sbdb:v1:{des}", 7 * 86400, produce)
    except Exception as exc:
        raise HTTPException(503, f"SBDB non raggiungibile: {exc}")
    if info.get("neo"):
        async def produce_ca() -> list[dict[str, Any]]:
            return await sbdb.close_approaches(S.http, des)

        try:
            info["close_approaches"] = await S.cache.fetch_json(f"cad:v1:{des}", 3 * 86400, produce_ca)
        except Exception:
            info["close_approaches"] = None
    return info


@app.get("/api/events/approaches")
async def upcoming_approaches(days: int = 365) -> dict[str, Any]:
    """Asteroidi e comete che passeranno vicino alla Terra (entro 0,05 UA, circa 20 distanze lunari)."""
    days = max(7, min(int(days), 3653))

    async def produce() -> list[dict[str, Any]]:
        return await sbdb.upcoming_approaches(S.http, days)

    try:
        items = await S.cache.fetch_json(f"cad:upcoming:v1:{days}", 12 * 3600, produce)
    except Exception as exc:
        raise HTTPException(503, f"CNEOS non raggiungibile: {exc}")
    return {"approaches": items, "source": "NASA/JPL CNEOS"}


@app.get("/api/geocode")
async def geocode_search(q: str = Query(..., min_length=2, max_length=80), lang: str = LANG) -> dict[str, Any]:
    """Luoghi con questo nome (coordinate, quota, fuso orario), per il luogo dell'osservatore."""
    name = " ".join(q.split())
    lang = lang_chain(lang)[0]

    async def produce() -> list[dict[str, Any]]:
        return await geocode.search(S.http, name, lang)

    try:
        items = await S.cache.fetch_json(f"geocode:v1:{lang}:{name.lower()}", 30 * 86400, produce)
    except Exception as exc:
        raise HTTPException(503, f"Ricerca dei luoghi non disponibile: {exc}")
    return {"places": items, "source": "Open-Meteo (dati GeoNames, CC BY 4.0)"}


# ---------------------------------------------------------------- satelliti terrestri
async def _satcat_load() -> None:
    async def produce() -> dict[str, Any]:
        t0 = time.time()
        cat = await celestrak.satcat(S.http)
        log.info("SATCAT scaricato: %d oggetti in %.0f s", len(cat), time.time() - t0)
        return {str(k): v for k, v in cat.items()}

    try:
        raw = await S.cache.fetch_json("celestrak:satcat:v1", 3 * 86400, produce)
        S.satcat = {int(k): v for k, v in raw.items()}
        S.satcat_loaded_at = time.time()
    except Exception as exc:
        log.warning("SATCAT non disponibile: %s", exc)
        S.satcat = S.satcat or {}
        S.satcat_loaded_at = time.time() - 3000  # nuovo tentativo fra ~10 minuti


async def _satcat(wait: float | None = None) -> dict[int, dict[str, Any]]:
    """Catalogo SATCAT (tipo, proprietario, lancio...).

    Il file è grande e CelesTrak a volte lo serve lentamente: lo si carica in
    sottofondo e, con `wait`, si aspetta al massimo quei secondi.
    """
    if S.satcat is not None and time.time() - S.satcat_loaded_at < 3600:
        return S.satcat
    task = S.satcat_task
    if task is None or task.done():
        task = S.satcat_task = asyncio.create_task(_satcat_load())
    try:
        if wait is None:
            await asyncio.shield(task)
        else:
            await asyncio.wait_for(asyncio.shield(task), wait)
    except asyncio.TimeoutError:
        pass
    return S.satcat or {}


@app.get("/api/satellites/{group}")
async def satellites(group: str) -> dict[str, Any]:
    if group not in SATELLITE_GROUPS:
        raise HTTPException(404, "Gruppo non previsto")

    async def produce() -> list[dict[str, Any]]:
        data = await celestrak.group(S.http, group)
        return [{k: d.get(k) for k in OMM_KEYS} for d in data]

    try:
        # 6 ore: CelesTrak aggiorna ogni ~2 ore e blocca chi scarica troppo spesso
        entry_list = await S.cache.fetch_json(f"celestrak:gp:v1:{group}", 6 * 3600, produce)
    except Exception as exc:
        raise HTTPException(503, f"CelesTrak non raggiungibile: {exc}")
    # la posizione dei satelliti non dipende dal SATCAT: non lo si aspetta a lungo
    cat = await _satcat(wait=3.0)
    for d in entry_list:
        info = cat.get(int(d.get("NORAD_CAT_ID") or 0))
        if info:
            d["_type"] = info.get("type")
            d["_owner"] = info.get("owner")
    return {"group": group, "count": len(entry_list), "satellites": entry_list, "source": "CelesTrak (GP/OMM)"}


@app.get("/api/satellite/{norad}")
async def satellite(norad: int) -> dict[str, Any]:
    cat = await _satcat(wait=45.0)
    if not cat:
        raise HTTPException(503, "Catalogo SATCAT in caricamento, riprova fra poco")
    info = cat.get(norad)
    if info is None:
        raise HTTPException(404, "Satellite non presente nel catalogo SATCAT")
    return info


# ---------------------------------------------------------------- Wikipedia
# titoli che il server non è riuscito a scaricare: non si riprova per un po'
# (il browser, intanto, prova da sé e consegna il risultato a /api/wiki/cache)
_wiki_failures: dict[str, float] = {}
WIKI_TTL = 30 * 86400


def _wiki_key(lang: str, title: str) -> str:
    return f"wiki:v1:{lang}:{title}"


@app.get("/api/wiki")
async def wiki(title: str, lang: str = LANG) -> dict[str, Any]:
    lang = lang_chain(lang)[0]                 # solo le Wikipedia delle lingue previste
    key = _wiki_key(lang, title)
    cached = S.cache.get(key, allow_stale=True)
    if cached is not None and (not cached.expired or time.time() - _wiki_failures.get(key, 0) < 6 * 3600):
        return json.loads(cached.data)
    if time.time() - _wiki_failures.get(key, 0) < 6 * 3600:
        raise HTTPException(404, "Voce non disponibile (nuovo tentativo più tardi)")

    async def produce() -> dict[str, Any]:
        return await wikipedia.summary(S.http, title, lang)

    try:
        return await S.cache.fetch_json(key, WIKI_TTL, produce)
    except Exception as exc:
        _wiki_failures[key] = time.time()
        log.info("Wikipedia non disponibile per «%s»: %s", title, exc)
        raise HTTPException(404, f"Voce non disponibile: {exc}")


@app.post("/api/wiki/cache")
async def wiki_store(request: Request) -> dict[str, Any]:
    """Il browser ha scaricato un riassunto da Wikipedia: lo si conserva per l'uso offline."""
    try:
        js = await request.json()
        title = str(js["request_title"])[:300]
        lang = lang_chain(str(js.get("lang") or LANG))[0]
        item = {k: js.get(k) for k in ("title", "extract", "thumbnail", "url")}
    except Exception:
        raise HTTPException(400, "Dati non validi")
    if not item.get("extract") or not str(item.get("url") or "").startswith(f"https://{lang}.wikipedia.org/"):
        raise HTTPException(400, "Dati non validi")
    item["extract"] = str(item["extract"])[:6000]
    item["lang"] = lang
    S.cache.put(_wiki_key(lang, title), json.dumps(item, separators=(",", ":")).encode(), WIKI_TTL)
    _wiki_failures.pop(_wiki_key(lang, title), None)
    return {"ok": True}


# ---------------------------------------------------------------- texture
_texture_failures: dict[str, float] = {}


@app.get("/api/textures/credits")
async def texture_credits() -> dict[str, Any]:
    """Autori e licenze delle texture (mostrati nella scheda di ogni corpo)."""
    return {"textures": textures.credits()}


@app.get("/api/dso/manifest")
async def dso_manifest() -> dict[str, Any]:
    """Foto di nebulose, ammassi e galassie: centro, larghezza in gradi, crediti."""
    return {"objects": textures.dso_manifest()}


@app.get("/api/dso/image/{name}")
async def dso_image(name: str) -> Response:
    path = textures.dso_path(name)
    if path is None:
        raise HTTPException(404, "Foto non disponibile")
    return FileResponse(path, headers={"Cache-Control": "no-cache"})


@app.get("/api/models/manifest")
async def models_manifest() -> dict[str, Any]:
    """Modelli 3D di sonde e satelliti: dimensioni, assetto, crediti e corpi che li usano."""
    return models.manifest()


@app.get("/api/models/file/{file}")
async def model_file(file: str) -> Response:
    path = models.model_path(file)
    if path is None:
        raise HTTPException(404, "Modello non disponibile")
    return FileResponse(path, media_type="model/gltf-binary", headers={"Cache-Control": "no-cache"})


@app.get("/api/texture/{name}")
async def texture(name: str, res: str = "2k") -> Response:
    key = f"{name}@{res}"
    if time.time() - _texture_failures.get(key, 0) < 600:
        raise HTTPException(404, "Texture non disponibile (nuovo tentativo fra qualche minuto)")
    try:
        path = await textures.ensure(S.http, name, res)
    except Exception as exc:
        _texture_failures[key] = time.time()
        raise HTTPException(404, f"Texture non disponibile: {exc}")
    if path is None:
        raise HTTPException(404, "Texture sconosciuta")
    # le texture incluse nel progetto possono cambiare con un aggiornamento: il browser ricontrolla
    cache = "no-cache" if textures.is_bundled(path) else "public, max-age=604800"
    return FileResponse(path, headers={"Cache-Control": cache})


# ---------------------------------------------------------------- fotografie della scena
@app.post("/api/snapshot")
async def snapshot(request: Request) -> dict[str, Any]:
    """Salva nella cartella «immagini» la fotografia della scena inviata dal programma (PNG)."""
    # l'intestazione personalizzata impedisce a una pagina web qualsiasi di scrivere file qui
    if request.headers.get("x-atlante") != "1":
        raise HTTPException(403, "Richiesta non valida")
    data = await request.body()
    if len(data) > 60_000_000 or not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise HTTPException(400, "Immagine non valida")
    SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y-%m-%d_%H-%M-%S")
    path = SNAPSHOT_DIR / f"atlante_{stamp}.png"
    n = 2
    while path.exists():
        path = SNAPSHOT_DIR / f"atlante_{stamp}_{n}.png"
        n += 1
    await asyncio.to_thread(path.write_bytes, _png_with_author(data))
    return {"ok": True, "file": path.name, "folder": str(SNAPSHOT_DIR)}


def _png_with_author(data: bytes) -> bytes:
    """Aggiunge alla foto, dopo l'intestazione PNG, i campi di testo «Author», «Copyright» e
    «Software» (si leggono nelle proprietà del file con molti programmi di immagini)."""
    def chunk(key: str, value: str) -> bytes:
        body = b"tEXt" + key.encode("latin-1") + b"\0" + value.encode("latin-1", "replace")
        return struct.pack(">I", len(body) - 4) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)
    ihdr_end = 8 + 8 + 13 + 4   # firma PNG + lunghezza/tipo + dati IHDR + CRC
    if data[12:16] != b"IHDR":
        return data
    extra = (chunk("Author", __author__) + chunk("Copyright", "(c) 2026 Giovanni Frasca. Tutti i diritti riservati.")
             + chunk("Software", f"Atlante Celeste {__version__} - Giovanni Frasca"))
    return data[:ihdr_end] + extra + data[ihdr_end:]


# ---------------------------------------------------------------- dati di riferimento
@app.get("/api/reference/{name}")
async def reference(name: str, lang: str = LANG) -> Response:
    """Dati di riferimento. Per i file con versioni per lingua (nome_<lingua>.json) si dà
    quella della lingua chiesta, se c'è (altrimenti inglese, poi italiano)."""
    if not name.replace("_", "").isalnum():
        raise HTTPException(400, "Nome non valido")
    ref = DATA_DIR / "reference"
    base = name[:-3] if name.endswith("_it") else name
    candidates = [ref / (f"{name}.json" if code == "it" else f"{base}_{code}.json") for code in lang_chain(lang)]
    path = next((p for p in candidates if p.exists()), None)
    if path is None:
        raise HTTPException(404, "Dati di riferimento non trovati")
    return FileResponse(path, media_type="application/json")


# ---------------------------------------------------------------- stelle
@app.get("/api/stars/gaia")
async def gaia_status() -> dict[str, Any]:
    """Download delle stelle di Gaia: a che punto è, scelte disponibili, catalogo già pronto."""
    return S.gaia.status()


@app.post("/api/stars/gaia/start")
async def gaia_start(gmax: float = Query(11.0)) -> dict[str, Any]:
    try:
        return S.gaia.start(gmax)
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@app.post("/api/stars/gaia/cancel")
async def gaia_cancel() -> dict[str, Any]:
    return S.gaia.cancel()


@app.get("/api/stars/catalogs")
async def star_catalogs() -> dict[str, Any]:
    return {"catalogs": S.stars.catalogs(), "default": S.stars.default_catalog()}


@app.get("/api/stars/{cat}/index.json")
async def star_index(cat: str) -> Response:
    p = S.stars.path(cat, "index.json")
    if p is None:
        raise HTTPException(404, "Catalogo stellare non trovato (eseguire scripts/build_star_tiles.py)")
    return FileResponse(p, media_type="application/json")


@app.get("/api/stars/{cat}/names.json")
async def star_names(cat: str) -> Response:
    p = S.stars.path(cat, "names.json")
    if p is None:
        raise HTTPException(404, "Nomi non disponibili")
    return FileResponse(p, media_type="application/json")


@app.get("/api/stars/{cat}/hr.json")
async def star_hr(cat: str) -> dict[str, Any]:
    """Diagramma di Hertzsprung-Russell del catalogo (conteggi per colore e magnitudine)."""
    out = await asyncio.to_thread(S.stars.hr, cat)
    if out is None:
        raise HTTPException(404, "Catalogo non disponibile")
    return out


@app.get("/api/stars/{cat}/tile/{tile}.atbl")
async def star_tile(cat: str, tile: str) -> Response:
    p = S.stars.tile_path(cat, tile)
    if p is None:
        raise HTTPException(404, "Tassello non trovato")
    # i tasselli cambiano solo rigenerando il catalogo: il browser li può tenere un giorno
    return FileResponse(p, media_type="application/octet-stream", headers={"Cache-Control": "public, max-age=86400"})


@app.get("/api/stars/{cat}/info/{star_id}")
async def star_info(cat: str, star_id: str) -> dict[str, Any]:
    info = S.stars.info(cat, star_id)
    if info is None:
        raise HTTPException(404, "Stella non trovata")
    return info


# formato precedente (un solo file): resta per compatibilità
@app.get("/api/stars.bin")
async def stars_bin() -> Response:
    if not STARS_BIN.exists():
        raise HTTPException(404, "Catalogo stellare non generato (eseguire scripts/build_stars.py)")
    return FileResponse(STARS_BIN, media_type="application/octet-stream")


@app.get("/api/star/{index}")
async def star(index: int) -> dict[str, Any]:
    info = S.stars.legacy_info(index)
    if info is None:
        raise HTTPException(404, "Stella non trovata")
    return info


# ---------------------------------------------------------------- interfaccia
if (FRONTEND_DIST / "index.html").exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str, request: Request) -> Response:
        if path.startswith("api/"):
            raise HTTPException(404, "Indirizzo API sconosciuto")
        candidate = (FRONTEND_DIST / path).resolve()
        if path and candidate.is_file() and FRONTEND_DIST.resolve() in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(FRONTEND_DIST / "index.html")
else:
    @app.get("/", include_in_schema=False)
    async def no_frontend() -> HTMLResponse:
        return HTMLResponse(
            "<h1>Atlante Celeste</h1><p>Il server dati funziona, ma l'interfaccia non è ancora stata compilata. "
            "Esegui <code>npm run build</code> nella cartella <code>frontend</code>.</p>"
        )


def run(mode: str = "browser") -> None:
    """Avvia il server. mode: "browser" (apre una scheda), "desktop" (finestra nativa), "server" (solo server)."""
    import socket

    import uvicorn

    from .config import HOST, PORT

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    fmt = "%(asctime)s %(levelname)s %(name)s: %(message)s"
    logging.basicConfig(
        level=logging.INFO,
        format=fmt,
        handlers=[
            logging.StreamHandler(),
            # il registro non cresce all'infinito: oltre 2 MB si ricomincia, tenendo i due precedenti
            logging.handlers.RotatingFileHandler(
                CACHE_DIR / "atlante.log", maxBytes=2_000_000, backupCount=2, encoding="utf-8"
            ),
        ],
    )
    url = f"http://{HOST}:{PORT}"
    # se la porta è già occupata (programma già aperto), si apre solo l'interfaccia
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        already = s.connect_ex((HOST, PORT)) == 0
    if already:
        log.warning("La porta %d è già in uso: Atlante Celeste è forse già avviato.", PORT)
        if mode == "desktop":
            from .desktop import run_window_only

            if run_window_only(url):
                return
        if mode != "server":
            webbrowser.open(url)
        return

    config = uvicorn.Config(app, host=HOST, port=PORT, log_level="info", log_config=None)
    server = uvicorn.Server(config)
    if mode == "desktop":
        from .desktop import run_desktop

        os.environ.pop("ATLANTE_OPEN_BROWSER", None)
        if run_desktop(server, url):
            return
        # finestra nativa non disponibile: si continua con il browser
        mode = "browser"
    if mode == "browser":
        os.environ["ATLANTE_OPEN_BROWSER"] = "1"
    server.run()
