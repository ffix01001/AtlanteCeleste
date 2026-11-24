"""Modelli 3D di sonde e satelliti (glTF binari), inclusi nel progetto in data/assets/models/.

Li prepara scripts/modelli_3d/prepara.mjs a partire dalla raccolta NASA 3D Resources:
manifest.json dice, per ogni modello, dimensioni, assetto nello spazio e crediti, e quali corpi
del catalogo (o satelliti, per numero NORAD) lo usano.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from ..config import ASSET_MODELS_DIR

_manifest: dict[str, Any] | None = None
_SAFE = re.compile(r"^[a-z0-9_-]+\.glb$")


def manifest() -> dict[str, Any]:
    global _manifest
    if _manifest is None:
        try:
            data = json.loads((ASSET_MODELS_DIR / "manifest.json").read_text(encoding="utf-8"))
            _manifest = {"models": data.get("models", {}), "bodies": data.get("bodies", {})}
        except (OSError, ValueError):
            _manifest = {"models": {}, "bodies": {}}
    return _manifest


def model_path(file: str) -> Path | None:
    """Percorso di un modello elencato nel manifest (nessun altro file è raggiungibile)."""
    if not _SAFE.match(file):
        return None
    if not any(m.get("file") == file for m in manifest()["models"].values()):
        return None
    p = ASSET_MODELS_DIR / file
    return p if p.is_file() else None
