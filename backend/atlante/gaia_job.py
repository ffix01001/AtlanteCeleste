"""Più stelle, dal programma: scarica Gaia DR3 dall'archivio ESA e prepara i tasselli.

È la stessa cosa che fanno scripts/gaia_scarica.py e scripts/build_star_tiles.py, ma in un
filo di esecuzione a parte, mentre il programma resta utilizzabile:
  1. il cielo è diviso in 192 zone; ogni zona è una richiesta all'archivio (due alla volta);
     le zone già scaricate restano su disco, quindi se si chiude il programma si riprende
     da dove si era arrivati;
  2. finite le zone, le stelle si uniscono a HYG e si dividono in tasselli in
     data/generated/stars/gaia.nuovo/, che alla fine prende il posto del catalogo "gaia"
     (l'eventuale versione precedente viene solo rinominata, mai cancellata).
"""

from __future__ import annotations

import gzip
import json
import logging
import shutil
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Callable

import httpx

from .config import DATA_DIR, GENERATED_DIR, USER_AGENT
from .sources.gaia import chunk_range, n_pixels, query, run_async

log = logging.getLogger(__name__)

SOURCES_DIR = DATA_DIR / "sources" / "gaia"
TILES_DIR = GENERATED_DIR / "stars"
CATALOG_ID = "gaia"

# scelte offerte nel pannello: magnitudine G limite -> stime (stelle, megabyte da scaricare, minuti)
CHOICES: dict[float, dict[str, Any]] = {
    11.0: {"stars": 1_300_000, "mb": 120, "minutes": [30, 90]},
    12.0: {"stars": 2_800_000, "mb": 260, "minutes": [60, 180]},
}
MIN_FREE_BYTES = 2 * 1024**3


class GaiaJob:
    def __init__(
        self,
        sources_dir: Path = SOURCES_DIR,
        tiles_dir: Path = TILES_DIR,
        gen_dir: Path = GENERATED_DIR,
        client_factory: Callable[[], httpx.Client] | None = None,
        level: int = 2,
        workers: int = 2,
        sleep: Callable[[float], None] = time.sleep,
        on_ready: Callable[[], None] = lambda: None,
        before_swap: Callable[[], None] = lambda: None,
        choices: dict[float, dict[str, Any]] = CHOICES,
    ) -> None:
        self.sources_dir = sources_dir
        self.tiles_dir = tiles_dir
        self.gen_dir = gen_dir
        self.client_factory = client_factory or (lambda: httpx.Client(
            headers={"User-Agent": USER_AGENT}, timeout=httpx.Timeout(120.0, connect=30.0)))
        self.level = level
        self.workers = workers
        self.sleep = sleep
        self.on_ready = on_ready
        self.before_swap = before_swap
        self.choices = choices
        self._lock = threading.Lock()
        self._cancel = threading.Event()
        self._thread: threading.Thread | None = None
        self.state = "idle"        # idle | downloading | building | done | error | cancelled
        self.gmax: float | None = None
        self.zones_done = 0
        self.zones_total = n_pixels(level)
        self.rows = 0
        self.message = ""
        self.error: str | None = None
        self.started: float | None = None
        self.finished: float | None = None

    # ------------------------------------------------------------------ stato
    def folder(self, gmax: float) -> Path:
        return self.sources_dir / f"G{gmax:g}"

    def _zones_on_disk(self, gmax: float) -> int:
        f = self.folder(gmax)
        return len(list(f.glob(f"zona_{self.level}_*.csv.gz"))) if f.exists() else 0

    def catalog(self) -> dict[str, Any] | None:
        """Il catalogo Gaia già pronto (se c'è): etichetta, numero di stelle, magnitudine limite."""
        idx = self.tiles_dir / CATALOG_ID / "index.json"
        if not idx.exists():
            return None
        try:
            # l'indice comincia con le informazioni generali: basta leggere l'inizio
            head = json.loads(idx.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        return {"id": CATALOG_ID, "label": head.get("label"), "count": head.get("count"), "gmax": head.get("gmax")}

    def status(self) -> dict[str, Any]:
        with self._lock:
            out = {
                "state": self.state, "gmax": self.gmax, "zones_done": self.zones_done, "zones_total": self.zones_total,
                "rows": self.rows, "message": self.message, "error": self.error,
                "started": self.started, "finished": self.finished,
            }
        out["running"] = self.state in ("downloading", "building")
        out["choices"] = [{"gmax": g, **c, "zones_on_disk": self._zones_on_disk(g)} for g, c in self.choices.items()]
        out["catalog"] = self.catalog()
        if out["running"] and self.started and self.zones_done:
            # stima del tempo che manca (solo per lo scaricamento, la parte lunga)
            el = time.time() - self.started
            fresh = max(1, self.zones_done - self._resumed)
            out["eta_s"] = round(el / fresh * (self.zones_total - self.zones_done)) if self.state == "downloading" else None
        return out

    # ---------------------------------------------------------------- comandi
    def start(self, gmax: float) -> dict[str, Any]:
        if gmax not in self.choices:
            raise ValueError(f"magnitudine non prevista: {gmax}")
        with self._lock:
            if self._thread and self._thread.is_alive():
                return self.status_unlocked()
            free = shutil.disk_usage(self.sources_dir.parent if self.sources_dir.parent.exists() else DATA_DIR).free
            if free < MIN_FREE_BYTES:
                self.state, self.error = "error", f"Spazio su disco insufficiente: servono almeno {MIN_FREE_BYTES // 1024**3} GB liberi."
                return self.status_unlocked()
            self._cancel.clear()
            self.state, self.gmax, self.error, self.message = "downloading", gmax, None, "Mi collego all'archivio di Gaia…"
            self.zones_done, self.rows, self.started, self.finished = 0, 0, time.time(), None
            self._resumed = 0
            self._thread = threading.Thread(target=self._run, args=(gmax,), name="gaia-download", daemon=True)
            self._thread.start()
        return self.status()

    def status_unlocked(self) -> dict[str, Any]:
        return {"state": self.state, "gmax": self.gmax, "error": self.error, "running": self.state in ("downloading", "building")}

    def cancel(self) -> dict[str, Any]:
        self._cancel.set()
        return self.status()

    def wait(self, timeout: float | None = None) -> None:
        t = self._thread
        if t:
            t.join(timeout)

    # ------------------------------------------------------------------ lavoro
    _resumed = 0

    def _set(self, **kw: Any) -> None:
        with self._lock:
            for k, v in kw.items():
                setattr(self, k, v)

    def _run(self, gmax: float) -> None:
        try:
            if __import__("os").environ.get("ATLANTE_OFFLINE") == "1":
                raise ConnectionError("modalità senza rete (ATLANTE_OFFLINE=1)")
            self._download(gmax)
            self._set(state="building", message="Preparo i tasselli del nuovo catalogo…")
            self._build(gmax)
            self._set(state="done", message="Pronto.", finished=time.time())
            self.on_ready()
        except InterruptedError:
            self._set(state="cancelled", message="Interrotto: le zone già scaricate restano, si può riprendere.", finished=time.time())
        except Exception as exc:  # rete, archivio, disco...
            log.exception("download di Gaia non riuscito")
            self._set(state="error", error=_friendly(exc), finished=time.time())

    def _download(self, gmax: float) -> None:
        out = self.folder(gmax)
        out.mkdir(parents=True, exist_ok=True)
        todo = []
        done = 0
        for p in range(n_pixels(self.level)):
            dest = out / f"zona_{self.level}_{p:05d}.csv.gz"
            if dest.exists() and dest.stat().st_size > 0:
                done += 1
            else:
                todo.append(p)
        self._resumed = done
        self._set(zones_done=done, message=f"Scarico le stelle: zona {done} di {self.zones_total}")
        if not todo:
            return
        with self.client_factory() as client, ThreadPoolExecutor(self.workers) as pool:
            futures = {pool.submit(self._zone, client, gmax, p, out): p for p in todo}
            try:
                for fut in as_completed(futures):
                    rows = fut.result()
                    with self._lock:
                        self.zones_done += 1
                        self.rows += rows
                        self.message = f"Scarico le stelle: zona {self.zones_done} di {self.zones_total}"
            except BaseException:
                self._cancel.set()  # gli altri lavori si fermano al prossimo controllo
                raise

    def _zone(self, client: httpx.Client, gmax: float, p: int, out: Path) -> int:
        dest = out / f"zona_{self.level}_{p:05d}.csv.gz"
        lo, hi = chunk_range(p, self.level)
        for attempt in range(4):
            if self._cancel.is_set():
                raise InterruptedError("interrotto")
            try:
                data = run_async(client, query(gmax, lo, hi), sleep=self.sleep, cancelled=self._cancel.is_set)
                break
            except InterruptedError:
                raise
            except Exception:
                if attempt == 3:
                    raise
                self.sleep(15 * (attempt + 1))
        tmp = dest.with_suffix(".tmp")
        tmp.write_bytes(gzip.compress(data))
        tmp.replace(dest)
        return max(0, data.count(b"\n") - 1)

    def _build(self, gmax: float) -> None:
        from .startiles import build_octree, load_gaia, load_hyg, write  # numpy solo quando serve

        def progress(msg: str) -> None:
            if self._cancel.is_set():
                raise InterruptedError("interrotto")
            self._set(message=f"Preparo i tasselli: {msg}")

        hyg = load_hyg(self.gen_dir)
        stars = load_gaia(self.folder(gmax), hyg, progress)
        root = build_octree(stars)
        tmp = self.tiles_dir / f"{CATALOG_ID}.nuovo"
        cat = {"id": CATALOG_ID, "label": f"Gaia DR3 (fino a G {gmax:g}) + HYG", "gmax": gmax,
               "license": "Gaia DR3: ESA/Gaia/DPAC (CC BY-SA 3.0 IGO); HYG v4.1: CC BY-SA 4.0"}
        write(stars, root, tmp, cat, progress)
        final = self.tiles_dir / CATALOG_ID
        # il server chiude i file del catalogo vecchio (su Windows non si potrebbe rinominarlo)
        self.before_swap()
        if final.exists():
            # la versione precedente si mette da parte (non si cancella nulla)
            k = 1
            old = self.tiles_dir / f"{CATALOG_ID}.precedente"
            while old.exists():
                k += 1
                old = self.tiles_dir / f"{CATALOG_ID}.precedente-{k}"
            _rename(final, old)
        _rename(tmp, final)
        self._set(rows=len(stars))


def _rename(a: Path, b: Path) -> None:
    # un file appena servito al browser può restare aperto per un attimo (Windows): si riprova
    for attempt in range(10):
        try:
            a.rename(b)
            return
        except PermissionError:
            if attempt == 9:
                raise
            time.sleep(0.5)


def _friendly(exc: BaseException) -> str:
    if isinstance(exc, (httpx.ConnectError, httpx.ConnectTimeout, ConnectionError)):
        return "Non riesco a raggiungere l'archivio di Gaia (ESA): controlla la connessione e riprova. Le zone già scaricate restano."
    if isinstance(exc, (httpx.ReadTimeout, TimeoutError)):
        return "L'archivio di Gaia è lento a rispondere in questo momento: riprova più tardi, si riprende da dove si era arrivati."
    if isinstance(exc, OSError):
        return f"Errore nello scrivere i file: {exc}"
    return f"Qualcosa non è andato: {exc}"
