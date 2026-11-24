"""JPL Small-Body Database: asteroidi e comete.

- sbdb.api        -> scheda di un singolo corpo (orbita, dati fisici, scoperta)
- sbdb_query.api  -> elementi orbitali in blocco (decine di migliaia di corpi)
- cad.api         -> passaggi ravvicinati alla Terra
Documentazione: https://ssd-api.jpl.nasa.gov/
"""

from __future__ import annotations

import math
from typing import Any

import array

from ..http import Http

SBDB = "https://ssd-api.jpl.nasa.gov/sbdb.api"
QUERY = "https://ssd-api.jpl.nasa.gov/sbdb_query.api"
CAD = "https://ssd-api.jpl.nasa.gov/cad.api"

BULK_FIELDS = ["spkid", "full_name", "pdes", "class", "e", "q", "i", "om", "w", "tp", "H", "M1"]

DEG = math.pi / 180.0


async def body(http: Http, sstr: str) -> dict[str, Any]:
    params = {"sstr": sstr, "phys-par": "1", "discovery": "1"}
    r = await http.get(SBDB, params)
    js = r.json()
    if "object" not in js:
        msg = js.get("message") or js.get("error") or "Oggetto non trovato nel Small-Body Database"
        return {"error": str(msg)}
    obj = js["object"]
    orbit = js.get("orbit") or {}
    elements = {e["name"]: _num(e.get("value")) for e in orbit.get("elements", []) if "name" in e}
    phys = {}
    for p in js.get("phys_par", []) or []:
        phys[p.get("name")] = {
            "value": p.get("value"),
            "units": p.get("units"),
            "title": p.get("title") or p.get("desc"),
            "ref": p.get("ref"),
        }
    out = {
        "spkid": obj.get("spkid"),
        "fullname": obj.get("fullname"),
        "kind": obj.get("kind"),
        "neo": obj.get("neo"),
        "pha": obj.get("pha"),
        "orbit_class": (obj.get("orbit_class") or {}).get("name"),
        "orbit_class_code": (obj.get("orbit_class") or {}).get("code"),
        "epoch_jd": _num(orbit.get("epoch")),
        "elements": elements,
        "moid_au": _num(orbit.get("moid")),
        "condition_code": orbit.get("condition_code"),
        "data_arc_days": _num(orbit.get("data_arc")),
        "n_obs_used": orbit.get("n_obs_used"),
        "first_obs": orbit.get("first_obs"),
        "last_obs": orbit.get("last_obs"),
        "phys": phys,
        "discovery": js.get("discovery"),
    }
    return out


async def close_approaches(http: Http, des: str, years_ahead: int = 100) -> list[dict[str, Any]]:
    params = {
        "des": des,
        "date-min": "now",
        "date-max": f"+{int(years_ahead * 365.25)}",
        "dist-max": "0.2",
        "sort": "date",
    }
    r = await http.get(CAD, params)
    js = r.json()
    fields = js.get("fields") or []
    out = []
    for row in js.get("data") or []:
        d = dict(zip(fields, row))
        out.append({
            "date": d.get("cd"),
            "jd": _num(d.get("jd")),
            "dist_au": _num(d.get("dist")),
            "dist_min_au": _num(d.get("dist_min")),
            "v_rel_kms": _num(d.get("v_rel")),
        })
    return out


def diameter_range_m(h: float | None) -> tuple[float, float] | None:
    """Diametro stimato dalla magnitudine assoluta H, per albedo fra 0,25 (chiaro) e 0,05 (scuro)."""
    if h is None:
        return None
    d = lambda p: 1329.0 / p ** 0.5 * 10 ** (-h / 5) * 1000  # noqa: E731 - km -> m
    return d(0.25), d(0.05)


def parse_approaches(js: dict[str, Any]) -> list[dict[str, Any]]:
    """Righe del CNEOS (cad.api) -> elenco leggibile, uno per passaggio."""
    fields = js.get("fields") or []
    out = []
    for row in js.get("data") or []:
        d = dict(zip(fields, row))
        h = _num(d.get("h"))
        dr = diameter_range_m(h)
        out.append({
            "des": d.get("des"),
            "name": (d.get("fullname") or d.get("des") or "").strip(),
            "date": d.get("cd"),
            "jd": _num(d.get("jd")),
            "dist_au": _num(d.get("dist")),
            "dist_min_au": _num(d.get("dist_min")),
            "v_rel_kms": _num(d.get("v_rel")),
            "h": h,
            "diameter_m": [round(dr[0]), round(dr[1])] if dr else None,
        })
    return out


async def upcoming_approaches(http: Http, days: int = 365, dist_max_au: float = 0.05) -> list[dict[str, Any]]:
    """Passaggi ravvicinati alla Terra di asteroidi e comete nei prossimi `days` giorni (CNEOS)."""
    params = {
        "date-min": "now",
        "date-max": f"+{int(days)}",
        "dist-max": f"{dist_max_au}",
        "sort": "date",
        "fullname": "true",
    }
    r = await http.get(CAD, params)
    return parse_approaches(r.json())


async def bulk(http: Http, params: dict[str, str]) -> dict[str, Any]:
    q = {"fields": ",".join(BULK_FIELDS), "full-prec": "1"}
    q.update(params)
    # le richieste grandi (centinaia di migliaia di righe) possono richiedere minuti
    r = await http.get(QUERY, q, timeout=600.0, retries=1)
    js = r.json()
    if "data" not in js:
        raise RuntimeError(js.get("message") or js.get("error") or "Risposta SBDB inattesa")
    return js


def pack_bulk(js: dict[str, Any]) -> tuple[dict[str, Any], dict[str, array.array]]:
    """Trasforma la risposta SBDB in colonne numeriche compatte per la GPU.

    Elementi eliocentrici, eclittica J2000: q [AU], e, i, Ω, ω [rad], tp [JD TDB].
    Si usa la coppia (q, e, tp) perché vale per ellissi, parabole e iperboli.
    """
    fields = js["fields"]
    idx = {f: i for i, f in enumerate(fields)}
    names: list[str] = []
    ids: list[int] = []
    pdes: list[str] = []
    classes: list[str] = []
    cols = {k: [] for k in ("q", "e", "i", "om", "w", "tp", "mag")}
    for row in js["data"]:
        try:
            q = float(row[idx["q"]])
            e = float(row[idx["e"]])
            inc = float(row[idx["i"]])
            om = float(row[idx["om"]])
            w = float(row[idx["w"]])
            tp = float(row[idx["tp"]])
        except (TypeError, ValueError):
            continue
        if not (q > 0 and e >= 0 and math.isfinite(tp)):
            continue
        mag = row[idx["H"]] if row[idx["H"]] not in (None, "") else row[idx["M1"]]
        try:
            magv = float(mag) if mag not in (None, "") else 99.0
        except ValueError:
            magv = 99.0
        cols["q"].append(q)
        cols["e"].append(e)
        cols["i"].append(inc * DEG)
        cols["om"].append(om * DEG)
        cols["w"].append(w * DEG)
        cols["tp"].append(tp)
        cols["mag"].append(magv)
        names.append((row[idx["full_name"]] or "").strip())
        ids.append(int(row[idx["spkid"]]))
        pdes.append(str(row[idx["pdes"]] or "").strip())
        classes.append(row[idx["class"]] or "")
    meta = {
        "count": len(ids),
        "names": names,
        "ids": ids,
        "pdes": pdes,
        "classes": classes,
    }
    arrays = {k: array.array("d", v) for k, v in cols.items()}
    return meta, arrays


def _num(v: Any) -> float | None:
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None
