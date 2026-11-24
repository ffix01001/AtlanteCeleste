"""Wikipedia: lettura della risposta dell'API "action" e cache dei riassunti scaricati dal browser."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from atlante.sources import wikipedia


def test_parse_action_ok():
    js = {"query": {"pages": [{
        "title": "Giove (astronomia)", "extract": "Giove è il quinto pianeta...",
        "fullurl": "https://it.wikipedia.org/wiki/Giove_(astronomia)",
        "thumbnail": {"source": "https://upload.wikimedia.org/x.jpg"},
    }]}}
    out = wikipedia.parse_action(js, "Giove (astronomia)", "it")
    assert out["title"] == "Giove (astronomia)"
    assert out["extract"].startswith("Giove")
    assert out["url"].startswith("https://it.wikipedia.org/")
    assert out["thumbnail"].endswith("x.jpg")


def test_parse_action_voce_mancante_o_disambigua():
    with pytest.raises(LookupError):
        wikipedia.parse_action({"query": {"pages": [{"title": "X", "missing": True}]}}, "X", "it")
    with pytest.raises(LookupError):
        wikipedia.parse_action({"query": {"pages": [{"title": "Io", "extract": "...", "pageprops": {"disambiguation": ""}}]}}, "Io", "it")


def test_cache_dal_browser(tmp_path, monkeypatch):
    from atlante import cache as cache_mod
    from atlante import main

    with TestClient(main.app) as client:
        main.S.cache = cache_mod.Cache(tmp_path / "c.sqlite3")  # cache isolata per il test
        bad = client.post("/api/wiki/cache", headers={"X-Atlante": "1"}, json={"request_title": "X", "extract": "t", "url": "https://evil.example/"})
        assert bad.status_code == 400
        ok = client.post("/api/wiki/cache", headers={"X-Atlante": "1"}, json={
            "request_title": "Sedna (astronomia)", "title": "90377 Sedna", "extract": "Sedna è...",
            "url": "https://it.wikipedia.org/wiki/90377_Sedna", "lang": "it",
        })
        assert ok.status_code == 200
        r = client.get("/api/wiki", params={"title": "Sedna (astronomia)"})
        assert r.status_code == 200
        assert r.json()["title"] == "90377 Sedna"
