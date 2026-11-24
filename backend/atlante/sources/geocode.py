"""Ricerca dei luoghi per nome (per il luogo dell'osservatore).

Servizio: Open-Meteo Geocoding API (https://open-meteo.com/en/docs/geocoding-api), gratuito
e senza chiave, con i dati di GeoNames (CC BY 4.0). Restituisce coordinate, quota e fuso
orario: esattamente ciò che serve per calcolare orari e visibilità degli eventi.
"""

from __future__ import annotations

from typing import Any

from ..http import Http

URL = "https://geocoding-api.open-meteo.com/v1/search"


def parse(js: dict[str, Any]) -> list[dict[str, Any]]:
    """Dalla risposta di Open-Meteo ai luoghi nel formato del programma."""
    out: list[dict[str, Any]] = []
    for r in js.get("results") or []:
        try:
            lat = float(r["latitude"])
            lon = float(r["longitude"])
        except (KeyError, TypeError, ValueError):
            continue
        where = ", ".join(x for x in (r.get("admin1"), r.get("country")) if x)
        out.append({
            "name": r.get("name") or "",
            "lat": round(lat, 5),
            "lon": round(lon, 5),
            "elev": round(float(r.get("elevation") or 0.0)),
            "tz": r.get("timezone") or None,
            "where": where or None,
        })
    return out


async def search(http: Http, name: str, lang: str = "it", count: int = 8) -> list[dict[str, Any]]:
    r = await http.get(URL, params={"name": name, "count": count, "language": lang, "format": "json"}, retries=1, timeout=15)
    return parse(r.json())
