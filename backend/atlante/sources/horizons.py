"""NASA/JPL Horizons: vettori di stato (posizione + velocità) di qualsiasi corpo.

Documentazione: https://ssd-api.jpl.nasa.gov/doc/horizons.html
Sistema di riferimento richiesto: ICRF, piano dell'equatore (REF_PLANE=FRAME),
unità km e km/s. È lo stesso sistema usato dal catalogo stellare Gaia.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass

from ..http import Http
from ..timeutil import jd_from_horizons_date

log = logging.getLogger("atlante.horizons")

API = "https://ssd.jpl.nasa.gov/api/horizons.api"


class HorizonsError(Exception):
    def __init__(self, message: str, *, not_before: float | None = None, not_after: float | None = None,
                 not_found: bool = False):
        super().__init__(message)
        self.not_before = not_before
        self.not_after = not_after
        self.not_found = not_found


@dataclass
class VectorTable:
    rows: list[tuple[float, float, float, float, float, float, float]]  # jd, x, y, z, vx, vy, vz
    target_name: str | None


def _q(v: str) -> str:
    return f"'{v}'"


async def vectors(http: Http, command: str, center: str, start_jd: float, stop_jd: float, step: str) -> VectorTable:
    params = {
        "format": "json",
        "COMMAND": _q(command),
        "OBJ_DATA": _q("NO"),
        "MAKE_EPHEM": _q("YES"),
        "EPHEM_TYPE": _q("VECTORS"),
        "CENTER": _q(center),
        "START_TIME": _q(f"JD {start_jd:.6f}"),
        "STOP_TIME": _q(f"JD {stop_jd:.6f}"),
        "STEP_SIZE": _q(step),
        "VEC_TABLE": _q("2"),
        "REF_SYSTEM": _q("ICRF"),
        "REF_PLANE": _q("FRAME"),
        "OUT_UNITS": _q("KM-S"),
        "VEC_CORR": _q("NONE"),
        "CSV_FORMAT": _q("YES"),
        "VEC_LABELS": _q("NO"),
    }
    r = await http.get(API, params)
    try:
        js = r.json()
    except ValueError:
        raise HorizonsError(f"Risposta non JSON da Horizons: {r.text[:200]}")
    if "error" in js:
        raise _classify_error(str(js["error"]))
    return parse_vectors(js.get("result", ""))


_DATE = r"(\d{4}-[A-Z]{3}-\d{2}(?:\s+\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?)"


def _classify_error(text: str) -> HorizonsError:
    up = text.upper()
    m_prior = re.search(r"PRIOR TO A\.D\.\s*" + _DATE, up)
    m_after = re.search(r"AFTER A\.D\.\s*" + _DATE, up)
    if m_prior or m_after:
        return HorizonsError(
            "Effemeride non disponibile per l'intervallo richiesto",
            not_before=jd_from_horizons_date(m_prior[1]) if m_prior else None,
            not_after=jd_from_horizons_date(m_after[1]) if m_after else None,
        )
    if "NO MATCHES FOUND" in up or "NO SUCH RECORD" in up or "UNKNOWN TARGET" in up:
        return HorizonsError("Oggetto non trovato su Horizons", not_found=True)
    if "MATCHING SMALL-BODIES" in up or "MULTIPLE MAJOR-BODIES" in up or "AMBIGUOUS" in up:
        return HorizonsError("Nome ambiguo su Horizons", not_found=True)
    # Messaggio generico: tengo solo le prime righe significative
    lines = [ln.strip() for ln in text.splitlines() if ln.strip() and not ln.startswith("*")]
    return HorizonsError(" | ".join(lines[:4])[:400] or "Errore Horizons")


def parse_vectors(text: str) -> VectorTable:
    if "$$SOE" not in text:
        raise _classify_error(text)
    name = None
    m = re.search(r"Target body name:\s*(.+?)\s{2,}", text)
    if m:
        name = m[1].strip()
    body = text.split("$$SOE", 1)[1].split("$$EOE", 1)[0]
    rows = []
    for line in body.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 8:
            continue
        try:
            jd = float(parts[0])
            x, y, z, vx, vy, vz = (float(p) for p in parts[2:8])
        except ValueError:
            continue
        rows.append((jd, x, y, z, vx, vy, vz))
    if not rows:
        raise HorizonsError("Nessun dato nella risposta di Horizons")
    return VectorTable(rows, name)


def step_to_days(step: str) -> float:
    m = re.match(r"\s*(\d+(?:\.\d+)?)\s*([a-zA-Z]*)", step)
    if not m:
        raise ValueError(step)
    v = float(m[1])
    unit = (m[2] or "d").lower()
    if unit.startswith("m") and not unit.startswith("mo"):
        return v / 1440.0
    if unit.startswith("h"):
        return v / 24.0
    if unit.startswith("d"):
        return v
    if unit.startswith("y"):
        return v * 365.25
    raise ValueError(step)
