"""Modelli 3D delle sonde: manifest coerente con i file e con il catalogo, nessun percorso arbitrario."""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from atlante.config import ASSET_MODELS_DIR, CATALOG_DIR
from atlante.main import app
from atlante.sources import models


def test_manifest_e_file():
    m = models.manifest()
    assert m["models"], "nessun modello"
    for key, e in m["models"].items():
        assert (ASSET_MODELS_DIR / e["file"]).is_file(), key
        assert e["credit"]["autori"] and e["credit"]["url"].startswith("https://"), key
        assert 0.5 < e["radius_m"] < 200, key
        att = e["attitude"]
        for k in ("primary", "secondary"):
            ax = att[k]["axis"]
            assert len(ax) == 3 and abs(sum(v * v for v in ax) - 1) < 1e-9, (key, k)
    for body, key in m["bodies"].items():
        assert key in m["models"], body


def test_corpi_del_catalogo():
    ids = set()
    for f in CATALOG_DIR.glob("*.json"):
        ids |= {b["id"] for b in json.loads(f.read_text(encoding="utf-8"))["bodies"]}
    for body in models.manifest()["bodies"]:
        if body.startswith("naif:"):
            assert body in ids, body


def test_endpoint():
    c = TestClient(app)
    m = c.get("/api/models/manifest").json()
    first = next(iter(m["models"].values()))
    r = c.get(f"/api/models/file/{first['file']}")
    assert r.status_code == 200 and r.content[:4] == b"glTF"
    for bad in ("../manifest.json", "manifest.json", "nonesiste.glb", "..%2Fmain.py"):
        assert c.get(f"/api/models/file/{bad}").status_code == 404, bad
