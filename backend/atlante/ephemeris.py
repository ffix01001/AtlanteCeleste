"""Servizio effemeridi: divide il tempo in "blocchi" fissi e li mette in cache.

Ogni blocco copre CHUNK_DAYS giorni a partire da J2000. Il browser chiede il
blocco che contiene l'istante simulato e interpola (Hermite cubica, usando
posizione e velocità) per avere posizioni continue a 60 fps.
Grazie ai blocchi fissi si può viaggiare nel tempo: ogni blocco scaricato
resta in cache e non si richiede più a JPL.
"""

from __future__ import annotations

import json
import logging
import math
from typing import Any

from .cache import Cache
from .catalog import Catalog
from .http import Http
from .sources import horizons
from .timeutil import J2000, jd_from_iso_date, jd_now_tdb

log = logging.getLogger("atlante.ephemeris")

CHUNK_DAYS = 32.0
SUN_CENTER = "500@10"


def chunk_bounds(idx: int) -> tuple[float, float]:
    start = J2000 + idx * CHUNK_DAYS
    return start, start + CHUNK_DAYS


def small_body_horizons(pdes: str, kind_hint: str | None = None) -> dict[str, Any]:
    """Configurazione Horizons per un corpo minore non presente nel catalogo."""
    cmds: list[str] = []
    is_comet = kind_hint == "comet" or pdes.endswith("P") or pdes[:2] in ("C/", "P/", "D/", "X/", "I/") or pdes.endswith("I")
    if is_comet:
        cmds += [f"DES={pdes};CAP;NOFRAG;", f"DES={pdes};CAP;", f"DES={pdes};"]
    elif pdes.isdigit():
        cmds += [f"{pdes};", f"DES={pdes};"]
    else:
        cmds += [f"DES={pdes};"]
    return {"command": cmds, "center": SUN_CENTER, "step": "1 d"}


class EphemerisService:
    def __init__(self, http: Http, cache: Cache, catalog: Catalog):
        self.http = http
        self.cache = cache
        self.catalog = catalog

    def horizons_config(self, body_id: str) -> dict[str, Any] | None:
        b = self.catalog.get(body_id)
        if b is not None:
            return b.get("horizons")
        if body_id.startswith("sb:"):
            return small_body_horizons(body_id[3:])
        return None

    async def chunk(self, body_id: str, idx: int) -> dict[str, Any]:
        hz = self.horizons_config(body_id)
        if hz is None:
            return {"id": body_id, "chunk": idx, "rows": [], "error": "Nessuna effemeride JPL configurata"}
        start, stop = chunk_bounds(idx)
        step = hz.get("step", "1 d")
        center = hz.get("center", SUN_CENTER)
        key = f"hz:v1:{body_id}:{center}:{step}:{idx}"
        now = jd_now_tdb()
        # I blocchi passati sono stabili; quelli presenti/futuri si aggiornano (le previsioni migliorano)
        ttl_days = 180 if stop < now - 60 else 5

        async def produce() -> dict[str, Any]:
            return await self._fetch(body_id, hz, center, start, stop, step)

        try:
            res = await self.cache.fetch_json(key, ttl_days * 86400, produce)
        except horizons.HorizonsError as exc:
            return {"id": body_id, "chunk": idx, "rows": [], "error": str(exc)}
        except Exception as exc:  # rete assente e nessun dato in cache
            log.warning("Effemeride %s blocco %d non disponibile: %s", body_id, idx, exc)
            return {"id": body_id, "chunk": idx, "rows": [], "error": f"Rete non disponibile: {exc}", "transient": True}
        res = dict(res)
        res.update({"id": body_id, "chunk": idx})
        return res

    async def _fetch(self, body_id: str, hz: dict, center: str, start: float, stop: float, step: str) -> dict[str, Any]:
        commands = hz["command"] if isinstance(hz["command"], list) else [hz["command"]]
        last: Exception | None = None
        for cmd in commands:
            s, t = start, stop
            for _attempt in range(3):
                try:
                    table = await horizons.vectors(self.http, cmd, center, s, t, step)
                    flat: list[float] = []
                    for row in table.rows:
                        flat.extend(row)
                    return {
                        "center": center,
                        "start": start,
                        "stop": stop,
                        "step_days": horizons.step_to_days(step),
                        "rows": flat,
                        "target": table.target_name,
                        "command": cmd,
                        "source": "NASA/JPL Horizons",
                    }
                except horizons.HorizonsError as exc:
                    last = exc
                    if exc.not_before is not None or exc.not_after is not None:
                        eps = 2.0 / 1440.0
                        s2 = max(s, (exc.not_before or s) + eps)
                        t2 = min(t, (exc.not_after or t) - eps)
                        if t2 - s2 < 1e-3:
                            return {
                                "center": center, "start": start, "stop": stop, "rows": [],
                                "available": {"not_before": exc.not_before, "not_after": exc.not_after},
                                "source": "NASA/JPL Horizons",
                            }
                        s, t = s2, t2
                        continue
                    break  # oggetto non trovato / altro errore: provo il comando successivo
        raise last or horizons.HorizonsError("Errore sconosciuto")

    async def trail(self, body_id: str) -> dict[str, Any]:
        """Traiettoria lunga e a bassa risoluzione (per disegnare il percorso delle sonde)."""
        b = self.catalog.get(body_id)
        if not b or "trail" not in b:
            return {"id": body_id, "rows": [], "error": "Nessuna traiettoria configurata"}
        tr = b["trail"]
        hz = b["horizons"]
        cfg = {"command": tr.get("command", hz["command"]), "center": tr.get("center", hz.get("center", SUN_CENTER))}
        start = jd_from_iso_date(tr["start"])
        now = jd_now_tdb()
        stop = jd_from_iso_date(tr["stop"]) if "stop" in tr else now + tr.get("future_days", 365)
        step = tr.get("step", "5 d")
        # chiave stabile per ~5 giorni: le traiettorie future vengono aggiornate da JPL
        bucket = math.floor(now / 5)
        family = f"trail:v1:{body_id}:{cfg['center']}:{step}:{start:.1f}:"
        key = f"{family}{bucket}"

        async def produce() -> dict[str, Any]:
            return await self._fetch(body_id, cfg, cfg["center"], start, stop, step)

        try:
            res = await self.cache.fetch_json(key, 6 * 86400, produce)
        except Exception as exc:
            # la chiave cambia ogni 5 giorni: senza rete si mostra l'ultima traiettoria scaricata
            old = self.cache.latest(family)
            if old is None:
                return {"id": body_id, "rows": [], "error": str(exc)}
            log.warning("Traiettoria di %s: uso l'ultima scaricata (%s)", body_id, exc)
            res = json.loads(old.data)
        res = dict(res)
        res["id"] = body_id
        return res
