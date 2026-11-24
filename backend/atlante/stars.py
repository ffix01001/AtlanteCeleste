"""Stelle: cataloghi divisi in tasselli (octree) da scripts/build_star_tiles.py.

Ogni catalogo sta in data/generated/stars/<id>/:
    index.json      albero dei tasselli
    tiles/*.atbl    posizioni 3D (parsec, ICRS, origine nel Sole) + magnitudine assoluta + colore
    names.json      stelle con un nome proprio (per la ricerca)
    info.sqlite     dati descrittivi di ogni stella, consultati su richiesta

Se c'è il catalogo "gaia" (generato da scripts/gaia_scarica.py + build_star_tiles.py)
si usa quello, altrimenti "hyg" (sempre presente).

Il vecchio formato a file unico (stars_hyg.atbl + stars_hyg_meta.json) resta
come ingresso dello script dei tasselli.
"""

from __future__ import annotations

import json
import re
import sqlite3
import threading
from functools import cached_property
from pathlib import Path
from typing import Any

from .config import GENERATED_DIR

STARS_BIN = GENERATED_DIR / "stars_hyg.atbl"
STARS_META = GENERATED_DIR / "stars_hyg_meta.json"
TILES_DIR = GENERATED_DIR / "stars"
PREFERRED = ("gaia", "hyg")

MISSING_CI = 0.65  # colore usato dagli script per le stelle senza indice di colore

_TILE_ID = re.compile(r"^r[0-7]{0,24}$")
_CAT_ID = re.compile(r"^[a-z0-9_-]{1,32}$")


class Stars:
    def __init__(self, tiles_dir: Path = TILES_DIR) -> None:
        self.tiles_dir = tiles_dir
        self._db: dict[str, sqlite3.Connection] = {}
        self._lock = threading.Lock()

    # ------------------------------------------------------------ cataloghi a tasselli
    def catalogs(self) -> list[dict[str, Any]]:
        out = []
        if self.tiles_dir.exists():
            for d in sorted(self.tiles_dir.iterdir()):
                idx = d / "index.json"
                if d.is_dir() and idx.exists():
                    try:
                        head = json.loads(idx.read_text(encoding="utf-8"))
                    except (OSError, json.JSONDecodeError):
                        continue
                    out.append({"id": d.name, "label": head.get("label", d.name), "count": head.get("count"),
                                "license": head.get("license")})
        return out

    def reset(self, cat: str | None = None) -> None:
        """Chiude i file aperti di un catalogo (o di tutti): serve prima di sostituirlo."""
        with self._lock:
            for k in list(self._db):
                if cat is None or k == cat:
                    self._db.pop(k).close()

    def default_catalog(self) -> str | None:
        ids = [c["id"] for c in self.catalogs()]
        for p in PREFERRED:
            if p in ids:
                return p
        return ids[0] if ids else None

    def path(self, cat: str, *parts: str) -> Path | None:
        if not _CAT_ID.match(cat):
            return None
        p = self.tiles_dir.joinpath(cat, *parts)
        return p if p.exists() else None

    def tile_path(self, cat: str, tile: str) -> Path | None:
        if not _TILE_ID.match(tile):
            return None
        return self.path(cat, "tiles", f"{tile}.atbl")

    def info(self, cat: str, star_id: str) -> dict[str, Any] | None:
        db_path = self.path(cat, "info.sqlite")
        if db_path is None or not re.match(r"^-?\d{1,20}$", star_id):
            return None
        with self._lock:
            db = self._db.get(cat)
            if db is None:
                db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, check_same_thread=False)
                self._db[cat] = db
            row = db.execute("SELECT data FROM stars WHERE id=?", (star_id,)).fetchone()
        if row is None:
            return None
        out = json.loads(row[0])
        out["id"] = star_id
        out["catalog"] = cat
        return out

    # ------------------------------------------------------------ diagramma H-R
    HR_BV = (-0.5, 2.3, 70)    # indice di colore B−V: da, a, colonne
    HR_MAG = (-9.0, 17.0, 65)  # magnitudine assoluta: da, a, righe

    def hr(self, cat: str) -> dict[str, Any] | None:
        """Quante stelle del catalogo cadono in ogni casella del diagramma di Hertzsprung-Russell.

        Si calcola una volta (leggendo tutti i tasselli) e si salva accanto al catalogo.
        """
        index = self.path(cat, "index.json")
        if index is None:
            return None
        cache = index.parent / "hr.json"
        if cache.exists() and cache.stat().st_mtime >= index.stat().st_mtime:
            try:
                return json.loads(cache.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                pass
        from .binpack import unpack

        b0, b1, nb = self.HR_BV
        m0, m1, nm = self.HR_MAG
        counts = [0] * (nb * nm)
        total = 0
        for tile in sorted((index.parent / "tiles").glob("*.atbl")):
            _, cols = unpack(tile.read_bytes())
            for bv, mag in zip(cols["ci"], cols["absmag"]):
                # valori mancanti: NaN, oppure 0,65 (il colore del Sole che gli script mettono
                # alle stelle senza misura di colore: formerebbero una falsa colonna nel diagramma)
                if bv != bv or mag != mag or abs(bv - MISSING_CI) < 1e-6:
                    continue
                i = int((bv - b0) / (b1 - b0) * nb)
                j = int((mag - m0) / (m1 - m0) * nm)
                if 0 <= i < nb and 0 <= j < nm:
                    counts[j * nb + i] += 1
                    total += 1
        out = {"bv": [b0, b1, nb], "mag": [m0, m1, nm], "counts": counts, "total": total}
        tmp = cache.with_suffix(".tmp")
        try:
            tmp.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
            tmp.replace(cache)
        except OSError:
            pass  # cartella in sola lettura: lo si ricalcola la prossima volta
        return out

    # ------------------------------------------------------------ formato precedente (compatibilità)
    @cached_property
    def meta(self) -> dict[str, Any]:
        if not STARS_META.exists():
            return {"fields": [], "rows": []}
        return json.loads(STARS_META.read_text(encoding="utf-8"))

    def available(self) -> bool:
        return STARS_BIN.exists() or self.default_catalog() is not None

    def legacy_info(self, index: int) -> dict[str, Any] | None:
        rows = self.meta.get("rows", [])
        if not 0 <= index < len(rows):
            return None
        return dict(zip(self.meta["fields"], rows[index]))
