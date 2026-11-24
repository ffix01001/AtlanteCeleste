"""Fotografie della scena: il server le salva solo se arrivano dal programma e sono PNG."""

from fastapi.testclient import TestClient

from atlante import main

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


def test_snapshot(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "SNAPSHOT_DIR", tmp_path / "immagini")
    with TestClient(main.app) as client:
        # senza l'intestazione del programma (una pagina web qualsiasi): rifiutata
        assert client.post("/api/snapshot", content=PNG).status_code == 403
        # non è un PNG: rifiutata
        assert client.post("/api/snapshot", content=b"ciao", headers={"X-Atlante": "1"}).status_code == 400
        r = client.post("/api/snapshot", content=PNG, headers={"X-Atlante": "1"})
        assert r.status_code == 200
        name = r.json()["file"]
        assert name.startswith("atlante_") and name.endswith(".png")
        assert (tmp_path / "immagini" / name).read_bytes() == PNG
        # due foto nello stesso secondo non si sovrascrivono
        r2 = client.post("/api/snapshot", content=PNG, headers={"X-Atlante": "1"})
        assert len(list((tmp_path / "immagini").iterdir())) == 2 and r2.json()["file"] != name


def _tiny_png() -> bytes:
    """PNG vero di 1×1 pixel, scritto a mano."""
    import struct
    import zlib

    def chunk(kind: bytes, body: bytes) -> bytes:
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(b"\x00\x00\x00\x00")) + chunk(b"IEND", b"")


def test_snapshot_firmata(tmp_path, monkeypatch):
    """Le foto salvate portano il nome dell'autore del programma nei campi di testo del PNG."""
    monkeypatch.setattr(main, "SNAPSHOT_DIR", tmp_path / "immagini")
    png = _tiny_png()
    with TestClient(main.app) as client:
        r = client.post("/api/snapshot", content=png, headers={"X-Atlante": "1"})
        saved = (tmp_path / "immagini" / r.json()["file"]).read_bytes()
    assert b"tEXtAuthor\x00Giovanni Frasca" in saved
    assert saved.startswith(png[:33]) and saved.endswith(png[33:])


def test_post_solo_dal_programma():
    """Le richieste che cambiano qualcosa, senza l'intestazione del programma, sono rifiutate."""
    with TestClient(main.app) as client:
        assert client.post("/api/stars/gaia/cancel").status_code == 403
        assert client.post("/api/catalog/reload").status_code == 403
        assert client.post("/api/catalog/reload", headers={"X-Atlante": "1"}).status_code == 200
