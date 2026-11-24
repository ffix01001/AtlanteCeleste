"""Archivio del satellite Gaia (ESA): le stelle di Gaia DR3 con una distanza affidabile.

Il cielo è diviso in zone (pixel HEALPix: il numero `source_id` di Gaia contiene già la zona) e
ogni zona è una richiesta separata al servizio TAP dell'archivio ESA (lavoro asincrono, ADQL).
Lo usano scripts/gaia_scarica.py e il download dentro il programma (gaia_job.py).

Archivio: https://gea.esac.esa.int/archive/ — Licenza dei dati: ESA/Gaia/DPAC, CC BY-SA 3.0 IGO.
Cita: Gaia Collaboration, Vallenari et al. 2023, A&A 674, A1.
"""

from __future__ import annotations

import gzip
import time
from typing import Callable

import httpx

TAP = "https://gea.esac.esa.int/tap-server/tap"

# source_id = indice HEALPix di livello 12 × 2^35 + numero progressivo
SID_PER_HPX12 = 2 ** 35
HPX12_PIXELS = 12 * 4 ** 12


def chunk_range(pixel: int, level: int) -> tuple[int, int]:
    """Intervallo di source_id che cade nel pixel HEALPix `pixel` di livello `level`."""
    if not 0 <= level <= 12:
        raise ValueError("livello HEALPix fra 0 e 12")
    per = 4 ** (12 - level)
    lo = pixel * per * SID_PER_HPX12
    hi = (pixel + 1) * per * SID_PER_HPX12 - 1
    return lo, hi


def n_pixels(level: int) -> int:
    return 12 * 4 ** level


def query(gmax: float, lo: int, hi: int) -> str:
    return (
        "SELECT g.source_id, g.ra, g.dec, g.parallax, g.parallax_error, g.phot_g_mean_mag, g.bp_rp, "
        "h.original_ext_source_id AS hip "
        "FROM gaiadr3.gaia_source AS g "
        "LEFT OUTER JOIN gaiadr3.hipparcos2_best_neighbour AS h ON h.source_id = g.source_id "
        f"WHERE g.parallax_over_error >= 5 AND g.phot_g_mean_mag < {gmax:.2f} "
        f"AND g.source_id BETWEEN {lo} AND {hi}"
    )


def run_async(client: httpx.Client, adql: str, timeout_s: float = 1800,
              sleep: Callable[[float], None] = time.sleep, cancelled: Callable[[], bool] = lambda: False) -> bytes:
    """Lavoro asincrono TAP/UWS: invio, attesa del completamento, scaricamento del risultato."""
    r = client.post(f"{TAP}/async", data={
        "REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "PHASE": "RUN", "QUERY": adql,
    }, follow_redirects=False)
    if r.status_code not in (303, 302, 200, 201):
        raise RuntimeError(f"Archivio Gaia: risposta {r.status_code}: {r.text[:300]}")
    job = r.headers.get("location") or str(r.url)
    t0 = time.time()
    delay = 1.0
    while True:
        phase = client.get(f"{job}/phase").text.strip().upper()
        if phase == "COMPLETED":
            break
        if phase in ("ERROR", "ABORTED"):
            err = client.get(f"{job}/error").text[:500]
            raise RuntimeError(f"Il lavoro è terminato con {phase}: {err}")
        if time.time() - t0 > timeout_s:
            raise TimeoutError("L'archivio Gaia non ha finito in tempo")
        if cancelled():
            raise InterruptedError("interrotto")
        sleep(delay)
        delay = min(delay * 1.5, 10.0)
    res = client.get(f"{job}/results/result", follow_redirects=True, timeout=600)
    res.raise_for_status()
    data = res.content
    if data[:2] == b"\x1f\x8b":  # alcune risposte arrivano già compresse
        data = gzip.decompress(data)
    return data
