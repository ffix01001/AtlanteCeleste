"""Cache persistente su SQLite con scadenza (TTL).

Ogni risposta delle fonti esterne viene salvata qui. Se in seguito la rete
non è disponibile, il programma usa i dati scaduti invece di fallire:
così funziona anche offline dopo il primo avvio.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable

log = logging.getLogger("atlante.cache")


@dataclass
class Entry:
    data: bytes
    fetched: float
    expired: bool


class Cache:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute(
            "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, fetched REAL, expires REAL, data BLOB)"
        )
        self._lock = threading.Lock()
        self._inflight: dict[str, asyncio.Lock] = {}

    # --- accesso grezzo -------------------------------------------------
    def get(self, key: str, *, allow_stale: bool = False) -> Entry | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT fetched, expires, data FROM kv WHERE key=?", (key,)
            ).fetchone()
        if row is None:
            return None
        fetched, expires, data = row
        expired = expires < time.time()
        if expired and not allow_stale:
            return None
        return Entry(bytes(data), fetched, expired)

    def put(self, key: str, data: bytes, ttl_seconds: float) -> None:
        now = time.time()
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO kv (key, fetched, expires, data) VALUES (?,?,?,?)",
                (key, now, now + ttl_seconds, data),
            )

    def latest(self, prefix: str) -> Entry | None:
        """La voce scaricata più di recente fra quelle la cui chiave comincia con `prefix`
        (anche scaduta): serve quando la chiave cambia nel tempo e manca la rete."""
        with self._lock:
            row = self._conn.execute(
                "SELECT fetched, expires, data FROM kv WHERE key >= ? AND key < ? ORDER BY fetched DESC LIMIT 1",
                (prefix, prefix + "\uffff"),
            ).fetchone()
        if row is None:
            return None
        fetched, expires, data = row
        return Entry(bytes(data), fetched, expires < time.time())

    def purge_superseded(self, prefix: str, grace_seconds: float) -> int:
        """Toglie le voci con questo prefisso scadute da più di `grace_seconds`, quando ne esiste
        una più recente della stessa famiglia (stessa chiave, a parte il numero finale).
        Restituisce quante ne ha tolte."""
        with self._lock:
            cur = self._conn.execute(
                "DELETE FROM kv WHERE key >= ? AND key < ? AND expires < ? AND fetched < ("
                " SELECT MAX(k2.fetched) FROM kv k2"
                " WHERE k2.key >= ? AND k2.key < ?"
                " AND rtrim(k2.key, '0123456789') = rtrim(kv.key, '0123456789'))",
                (prefix, prefix + "\uffff", time.time() - grace_seconds, prefix, prefix + "\uffff"),
            )
            return cur.rowcount

    def stats(self) -> dict[str, Any]:
        with self._lock:
            n, size = self._conn.execute("SELECT COUNT(*), COALESCE(SUM(LENGTH(data)),0) FROM kv").fetchone()
        return {"entries": n, "bytes": size}

    # --- recupero con "single flight" e ripiego sui dati scaduti ---------
    async def fetch(
        self,
        key: str,
        ttl_seconds: float,
        producer: Callable[[], Awaitable[bytes]],
        *,
        stale_ok: bool = True,
    ) -> Entry:
        entry = self.get(key)
        if entry is not None:
            return entry
        lock = self._inflight.setdefault(key, asyncio.Lock())
        async with lock:
            entry = self.get(key)
            if entry is not None:
                return entry
            try:
                data = await producer()
            except Exception as exc:  # rete assente, servizio giù, ecc.
                stale = self.get(key, allow_stale=True)
                if stale is not None and stale_ok:
                    log.warning("Uso dati in cache scaduti per %s (%s)", key, exc)
                    return stale
                raise
            finally:
                self._inflight.pop(key, None)
            self.put(key, data, ttl_seconds)
            return Entry(data, time.time(), False)

    async def fetch_json(self, key: str, ttl_seconds: float, producer: Callable[[], Awaitable[Any]], **kw) -> Any:
        async def _p() -> bytes:
            return json.dumps(await producer(), separators=(",", ":")).encode()

        entry = await self.fetch(key, ttl_seconds, _p, **kw)
        return json.loads(entry.data)
