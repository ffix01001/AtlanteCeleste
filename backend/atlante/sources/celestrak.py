"""CelesTrak: elementi orbitali (formato OMM/JSON) e catalogo dei satelliti terrestri.

Regola d'oro di CelesTrak: i dati si aggiornano ogni ~2 ore, quindi non vanno
scaricati più spesso (chi esagera viene bloccato). La cache lo garantisce.
"""

from __future__ import annotations

import csv
import io
from typing import Any

from ..http import Http

GP = "https://celestrak.org/NORAD/elements/gp.php"
SATCAT_CSV = "https://celestrak.org/pub/satcat.csv"


async def group(http: Http, name: str) -> list[dict[str, Any]]:
    r = await http.get(GP, {"GROUP": name, "FORMAT": "json"})
    data = r.json()
    if not isinstance(data, list):
        raise RuntimeError("Risposta CelesTrak inattesa")
    return data


async def satcat(http: Http) -> dict[int, dict[str, Any]]:
    # file grande (decine di migliaia di righe): tempo massimo più generoso
    r = await http.get(SATCAT_CSV, timeout=300)
    reader = csv.DictReader(io.StringIO(r.text))
    out: dict[int, dict[str, Any]] = {}
    for row in reader:
        try:
            norad = int(row.get("NORAD_CAT_ID") or 0)
        except ValueError:
            continue
        if not norad:
            continue
        out[norad] = {
            "name": row.get("OBJECT_NAME"),
            "cospar": row.get("OBJECT_ID"),
            "type": row.get("OBJECT_TYPE"),
            "status": row.get("OPS_STATUS_CODE"),
            "owner": row.get("OWNER"),
            "launch_date": row.get("LAUNCH_DATE"),
            "launch_site": row.get("LAUNCH_SITE"),
            "decay_date": row.get("DECAY_DATE") or None,
            "period_min": _f(row.get("PERIOD")),
            "inclination_deg": _f(row.get("INCLINATION")),
            "apogee_km": _f(row.get("APOGEE")),
            "perigee_km": _f(row.get("PERIGEE")),
            "rcs_m2": _f(row.get("RCS")),
            "orbit_center": row.get("ORBIT_CENTER"),
            "orbit_type": row.get("ORBIT_TYPE"),
        }
    return out


def _f(v: str | None) -> float | None:
    try:
        return float(v) if v not in (None, "") else None
    except ValueError:
        return None
