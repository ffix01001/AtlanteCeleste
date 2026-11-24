"""Texture: quelle incluse nel progetto (lune, asteroidi) e quelle scaricate (pianeti)."""

from __future__ import annotations

import asyncio
import json

import pytest

from atlante.config import ASSET_TEXTURES_DIR, CATALOG_DIR
from atlante.sources import textures


class NoNetwork:
    """Finto client HTTP: ogni richiesta fallisce come se la rete mancasse."""

    def __init__(self) -> None:
        self.calls: list[str] = []

    async def get(self, url: str, **_: object):
        self.calls.append(url)
        raise OSError("rete non disponibile")


def test_manifest_e_file_inclusi():
    m = textures.local_manifest()
    assert len(m) >= 30
    for name, e in m.items():
        assert (ASSET_TEXTURES_DIR / e["file"]).is_file(), name
        assert e["licenza"], name
        assert e["autori"], name
        assert 1.0 <= e["gain"] <= 3.5


def test_ogni_texture_del_catalogo_esiste():
    known = set(textures.local_manifest()) | set(textures.MANIFEST)
    for f in sorted(CATALOG_DIR.glob("*.json")):
        for b in json.loads(f.read_text(encoding="utf-8"))["bodies"]:
            for key in ("texture", "texture_alt", "night_texture", "clouds_texture"):
                if b.get(key):
                    assert b[key] in known, f"{b['id']}: {key} = {b[key]}"
            if (b.get("rings") or {}).get("texture"):
                assert b["rings"]["texture"] in known


def test_inclusa_senza_rete():
    net = NoNetwork()
    p = asyncio.run(textures.ensure(net, "io", "2k"))
    assert p is not None and p.parent == ASSET_TEXTURES_DIR and textures.is_bundled(p)
    assert net.calls == []


def test_alta_risoluzione_ripiega_su_quella_inclusa(tmp_path, monkeypatch):
    monkeypatch.setattr(textures, "TEXTURES_DIR", tmp_path)
    net = NoNetwork()
    p = asyncio.run(textures.ensure(net, "europa", "8k"))
    assert net.calls and net.calls[0].startswith("https://raw.githubusercontent.com/")
    assert p == ASSET_TEXTURES_DIR / "europa.jpg"


def test_pianeti_richiedono_la_rete(tmp_path, monkeypatch):
    monkeypatch.setattr(textures, "TEXTURES_DIR", tmp_path)
    with pytest.raises(OSError):
        asyncio.run(textures.ensure(NoNetwork(), "jupiter", "2k"))
    assert asyncio.run(textures.ensure(NoNetwork(), "inesistente", "2k")) is None


def test_crediti():
    c = textures.credits()
    assert c["jupiter"]["fonte"] == "Solar System Scope"
    assert c["phobos"]["gain"] > 1.5          # Fobos è scurissimo: va schiarito
    assert c["amalthea"]["grigia"] is True     # mappa in bianco e nero, tinta dal catalogo
    # progetto libero: nessuna texture con licenza "solo uso non commerciale"
    assert c["pluto"]["fonte"] == "NASA" and c["uranus"]["licenza"] == "CC-BY-4.0"
    assert not [n for n, e in c.items() if "NC" in (e.get("licenza") or "")]


def test_foto_del_cielo_profondo():
    from fastapi.testclient import TestClient
    from atlante import main

    m = textures.dso_manifest()
    for name in ("m42", "m31", "lmc", "ngc5139"):
        assert name in m and m[name]["width_deg"] > 0 and m[name]["crediti"]
        assert textures.dso_path(name) is not None
    assert textures.dso_path("../manifest") is None
    with TestClient(main.app) as client:
        assert client.get("/api/dso/manifest").json()["objects"]["m42"]["file"] == "m42.jpg"
        r = client.get("/api/dso/image/m42")
        assert r.status_code == 200 and r.content[:3] == b"\xff\xd8\xff"
        assert client.get("/api/dso/image/inesistente").status_code == 404
