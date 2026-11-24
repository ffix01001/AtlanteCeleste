"""Cache: ultima voce di una famiglia di chiavi e pulizia delle copie superate."""

import asyncio
import time

from atlante.cache import Cache
from atlante.catalog import Catalog
from atlante.ephemeris import EphemerisService


def _age(cache: Cache, key: str, fetched_ago: float, expired_ago: float) -> None:
    now = time.time()
    cache._conn.execute("UPDATE kv SET fetched=?, expires=? WHERE key=?", (now - fetched_ago, now - expired_ago, key))


def test_latest_prende_la_piu_recente_anche_scaduta(tmp_path):
    c = Cache(tmp_path / "c.sqlite3")
    c.put("trail:v1:a:500@10:5 d:1.0:100", b"vecchia", 10)
    c.put("trail:v1:a:500@10:5 d:1.0:101", b"nuova", 10)
    c.put("trail:v1:b:500@10:5 d:1.0:101", b"altra", 10)
    _age(c, "trail:v1:a:500@10:5 d:1.0:100", 900, 800)
    _age(c, "trail:v1:a:500@10:5 d:1.0:101", 500, 400)
    e = c.latest("trail:v1:a:500@10:5 d:1.0:")
    assert e is not None and e.data == b"nuova" and e.expired
    assert c.latest("trail:v1:zzz:") is None


def test_purge_toglie_solo_le_copie_superate(tmp_path):
    c = Cache(tmp_path / "c.sqlite3")
    day = 86400
    c.put("trail:v1:a:500@10:5 d:1.0:100", b"1", 10)   # superata e scaduta da tempo: via
    c.put("trail:v1:a:500@10:5 d:1.0:101", b"2", 10)   # l'ultima della famiglia: resta anche se scaduta
    c.put("trail:v1:b:500@10:5 d:1.0:100", b"3", 10)   # unica della sua famiglia: resta
    c.put("trail:v1:c:500@10:5 d:1.0:100", b"4", 10)   # superata ma scaduta da poco: resta
    c.put("trail:v1:c:500@10:5 d:1.0:101", b"5", 10)
    c.put("hz:v1:naif:399:500@10:1 d:100", b"6", 10)   # altro prefisso: non si tocca
    _age(c, "trail:v1:a:500@10:5 d:1.0:100", 80 * day, 70 * day)
    _age(c, "trail:v1:a:500@10:5 d:1.0:101", 60 * day, 50 * day)
    _age(c, "trail:v1:b:500@10:5 d:1.0:100", 80 * day, 70 * day)
    _age(c, "trail:v1:c:500@10:5 d:1.0:100", 12 * day, 6 * day)
    _age(c, "hz:v1:naif:399:500@10:1 d:100", 400 * day, 200 * day)
    assert c.purge_superseded("trail:v1:", 30 * day) == 1
    assert c.get("trail:v1:a:500@10:5 d:1.0:100", allow_stale=True) is None
    for key in ("trail:v1:a:500@10:5 d:1.0:101", "trail:v1:b:500@10:5 d:1.0:100", "trail:v1:c:500@10:5 d:1.0:100",
                "trail:v1:c:500@10:5 d:1.0:101", "hz:v1:naif:399:500@10:1 d:100"):
        assert c.get(key, allow_stale=True) is not None, key


class _NoNet:
    async def get(self, *a, **kw):
        raise OSError("rete assente")


def test_traiettoria_senza_rete_usa_l_ultima_scaricata(tmp_path):
    cat = Catalog()
    body = next(b for b in cat.listing("it") if "trail" in b)
    cache = Cache(tmp_path / "c.sqlite3")
    svc = EphemerisService(_NoNet(), cache, cat)
    # nessuna copia: errore, nessuna riga
    out = asyncio.run(svc.trail(body["id"]))
    assert out["rows"] == [] and out["error"]
    # una copia di qualche settimana fa (chiave con un altro numero finale): si usa quella
    import json
    from atlante.ephemeris import SUN_CENTER
    from atlante.timeutil import jd_from_iso_date
    tr, hz = body["trail"], body["horizons"]
    center = tr.get("center", hz.get("center", SUN_CENTER))
    family = f"trail:v1:{body['id']}:{center}:{tr.get('step', '5 d')}:{jd_from_iso_date(tr['start']):.1f}:"
    cache.put(family + "1", json.dumps({"rows": [1, 2, 3, 4, 5, 6, 7], "center": center}).encode(), 10)
    _age(cache, family + "1", 40 * 86400, 34 * 86400)
    out = asyncio.run(svc.trail(body["id"]))
    assert out["rows"] == [1, 2, 3, 4, 5, 6, 7] and out["id"] == body["id"] and "error" not in out
