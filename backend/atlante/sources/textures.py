"""Texture dei corpi celesti.

Due provenienze:

* **pianeti, Sole e Luna**: Solar System Scope (https://www.solarsystemscope.com/textures/),
  licenza CC BY 4.0. Scaricate al primo utilizzo in data/textures/ e poi servite in locale.
* **lune, pianeti nani e asteroidi**: mappe del progetto Celestia, già incluse nel progetto in
  data/assets/textures/ (le prepara scripts/prepara_texture_lune.py). Ognuna ha la sua licenza,
  elencata in data/assets/textures/manifest.json. Se si chiede l'alta risoluzione, la versione
  grande (4096×2048) viene scaricata al primo uso da GitHub; se non si riesce, si usa quella inclusa.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from ..config import ASSET_DSO_DIR, ASSET_TEXTURES_DIR, TEXTURES_DIR
from ..http import Http

log = logging.getLogger(__name__)

BASE = "https://www.solarsystemscope.com/textures/download/"

# nome -> (estensione, risoluzioni disponibili)
MANIFEST: dict[str, tuple[str, tuple[str, ...]]] = {
    "sun": ("jpg", ("2k", "8k")),
    "mercury": ("jpg", ("2k", "8k")),
    "venus_surface": ("jpg", ("2k", "8k")),
    "venus_atmosphere": ("jpg", ("2k", "4k")),
    "earth_daymap": ("jpg", ("2k", "8k")),
    "earth_nightmap": ("jpg", ("2k", "8k")),
    "earth_clouds": ("jpg", ("2k", "8k")),
    "moon": ("jpg", ("2k", "8k")),
    "mars": ("jpg", ("2k", "8k")),
    "jupiter": ("jpg", ("2k", "8k")),
    "saturn": ("jpg", ("2k", "8k")),
    "saturn_ring_alpha": ("png", ("2k", "8k")),
    "uranus": ("jpg", ("2k",)),
    "neptune": ("jpg", ("2k",)),
}

_IMAGE_MAGIC = (b"\x89PNG", b"\xff\xd8\xff")

_local: dict[str, dict[str, Any]] | None = None


def local_manifest() -> dict[str, dict[str, Any]]:
    """Texture incluse nel progetto (lette una volta sola)."""
    global _local
    if _local is None:
        path = ASSET_TEXTURES_DIR / "manifest.json"
        try:
            _local = json.loads(path.read_text(encoding="utf-8")).get("textures", {})
        except (OSError, ValueError):
            _local = {}
    return _local


_dso: dict[str, dict[str, Any]] | None = None


def dso_manifest() -> dict[str, dict[str, Any]]:
    """Foto del cielo profondo incluse nel progetto (vedi scripts/prepara_texture_cielo_profondo.py)."""
    global _dso
    if _dso is None:
        try:
            _dso = json.loads((ASSET_DSO_DIR / "manifest.json").read_text(encoding="utf-8")).get("objects", {})
        except (OSError, ValueError):
            _dso = {}
    return _dso


def dso_path(name: str) -> Path | None:
    entry = dso_manifest().get(name)
    if entry is None:
        return None
    p = ASSET_DSO_DIR / entry["file"]
    return p if p.exists() else None


def credits() -> dict[str, dict[str, Any]]:
    """Per ogni texture inclusa: autori, licenza e "guadagno" di luminosità (vedi lo script)."""
    keys = ("gain", "grigia", "fonte", "url", "autori", "licenza", "licenza_url")
    out = {name: {k: e.get(k) for k in keys} for name, e in local_manifest().items()}
    # "hi": esiste una versione più grande di quella normale (la grafica la carica solo da vicino)
    for name, e in local_manifest().items():
        out[name]["hi"] = bool(e.get("hi_url"))
    ssm = {"fonte": "Solar System Scope", "url": "https://www.solarsystemscope.com/textures/",
           "autori": ["Solar System Scope / INOVE"], "licenza": "CC-BY-4.0",
           "licenza_url": "https://creativecommons.org/licenses/by/4.0/deed.it", "gain": 1.0}
    for name, (_ext, avail) in MANIFEST.items():
        out.setdefault(name, {**ssm, "hi": "8k" in avail})
    return out


def local_path(name: str, res: str) -> Path | None:
    if name not in MANIFEST:
        return None
    ext, avail = MANIFEST[name]
    if res not in avail:
        res = "2k" if "2k" in avail else avail[0]
    return TEXTURES_DIR / f"{res}_{name}.{ext}"


def _is_image(content: bytes, ctype: str) -> bool:
    return ctype.startswith("image/") or content.startswith(_IMAGE_MAGIC)


async def _download(http: Http, url: str, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    r = await http.get(url, retries=0)
    if not _is_image(r.content, r.headers.get("content-type", "")):
        raise RuntimeError(f"Il server non ha restituito un'immagine per {path.name}")
    tmp = path.with_suffix(path.suffix + ".part")
    tmp.write_bytes(r.content)
    tmp.replace(path)
    return path


async def ensure(http: Http, name: str, res: str) -> Path | None:
    entry = local_manifest().get(name)
    if entry is not None:
        base = ASSET_TEXTURES_DIR / entry["file"]
        hi_url = entry.get("hi_url")
        if res in ("4k", "8k") and hi_url:
            hi = TEXTURES_DIR / f"hi_{name}{Path(hi_url).suffix}"
            if hi.exists() and hi.stat().st_size > 1000:
                return hi
            try:
                return await _download(http, hi_url, hi)
            except Exception as exc:  # senza rete si usa la versione inclusa
                log.info("Texture %s in alta risoluzione non disponibile (%s): uso quella inclusa", name, exc)
        return base if base.exists() else None

    path = local_path(name, res)
    if path is None:
        return None
    if path.exists() and path.stat().st_size > 1000:
        return path
    try:
        return await _download(http, BASE + path.name, path)
    except Exception:
        # alta risoluzione non scaricabile (per esempio senza rete): meglio la versione
        # normale già presente che un pianeta senza mappa
        low = local_path(name, "2k")
        if low is not None and low != path:
            if low.exists() and low.stat().st_size > 1000:
                log.info("Texture %s a %s non disponibile: uso quella a 2k", name, res)
                return low
            return await _download(http, BASE + low.name, low)
        raise


def is_bundled(path: Path) -> bool:
    try:
        path.relative_to(ASSET_TEXTURES_DIR)
        return True
    except ValueError:
        return False
