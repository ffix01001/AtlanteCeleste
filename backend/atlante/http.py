"""Client HTTP condiviso, con limiti di concorrenza per ogni servizio.

I servizi pubblici (JPL, CelesTrak) chiedono di non essere bombardati:
qui si decide quante richieste parallele fare verso ciascuno.
"""

from __future__ import annotations

import asyncio
import logging
import os
from urllib.parse import urlparse

import httpx

from .config import USER_AGENT

log = logging.getLogger("atlante.http")

# ATLANTE_OFFLINE=1: nessuna richiesta in rete, solo i dati già in cache (per le prove
# senza connessione: altrimenti ogni richiesta aspetterebbe i tentativi e le pause)
OFFLINE = os.environ.get("ATLANTE_OFFLINE") == "1"

_LIMITS = {
    "ssd.jpl.nasa.gov": 2,
    "ssd-api.jpl.nasa.gov": 2,
    "celestrak.org": 1,
    "it.wikipedia.org": 2,
    "en.wikipedia.org": 2,
    "www.solarsystemscope.com": 2,
}


class Http:
    def __init__(self) -> None:
        self.client = httpx.AsyncClient(
            timeout=httpx.Timeout(90.0, connect=20.0),
            headers={"User-Agent": USER_AGENT},
            follow_redirects=True,
        )
        self._sems: dict[str, asyncio.Semaphore] = {}

    def _sem(self, url: str) -> asyncio.Semaphore:
        host = urlparse(url).hostname or ""
        if host not in self._sems:
            self._sems[host] = asyncio.Semaphore(_LIMITS.get(host, 4))
        return self._sems[host]

    async def get(self, url: str, params: dict | None = None, *, retries: int = 2, timeout: float | None = None) -> httpx.Response:
        if OFFLINE:
            raise httpx.ConnectError("modalità senza rete (ATLANTE_OFFLINE=1)")
        last: Exception | None = None
        for attempt in range(retries + 1):
            try:
                async with self._sem(url):
                    r = await self.client.get(url, params=params, timeout=timeout if timeout else httpx.USE_CLIENT_DEFAULT)
                if r.status_code in (429, 500, 502, 503, 504) and attempt < retries:
                    await asyncio.sleep(2.0 * (attempt + 1))
                    continue
                r.raise_for_status()
                return r
            except (httpx.TransportError, httpx.HTTPStatusError) as exc:
                last = exc
                if isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code < 500 and exc.response.status_code != 429:
                    raise
                if attempt < retries:
                    await asyncio.sleep(2.0 * (attempt + 1))
        assert last is not None
        raise last

    async def close(self) -> None:
        await self.client.aclose()
