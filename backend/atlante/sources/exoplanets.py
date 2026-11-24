"""Esopianeti: i sistemi planetari più vicini al Sole e alcuni dei più famosi.

Fonte: NASA Exoplanet Archive (https://exoplanetarchive.ipac.caltech.edu), tabella
"Planetary Systems Composite Parameters" (pscomppars), interrogata con il servizio TAP.
Dai dati dell'archivio si costruiscono corpi nello stesso formato del catalogo: la stella
(posizione fissa in cielo, alla sua distanza) e i pianeti su orbite circolari con il periodo
misurato. L'orientamento delle orbite nello spazio non è noto quasi mai: si disegnano tutte
nel piano dell'eclittica, e la scheda lo dice.
"""

from __future__ import annotations

import math
import re
from typing import Any

from ..http import Http

URL = "https://exoplanetarchive.ipac.caltech.edu/TAP/sync"

# entro questa distanza si prendono tutti i sistemi noti; più lontano, solo quelli famosi
NEAR_PC = 10.0
FAMOUS = (
    "TRAPPIST-1", "51 Peg", "Kepler-186", "Kepler-452", "HD 209458", "55 Cnc", "K2-18", "Kepler-16",
    "HD 189733", "WASP-12", "Kepler-22", "PSR B1257+12", "bet Pic", "HR 8799", "TOI-700", "WASP-39",
    "Kepler-11", "ups And", "47 UMa",
)
COLUMNS = (
    "pl_name,hostname,sy_dist,ra,dec,pl_orbper,pl_orbsmax,pl_rade,pl_bmasse,pl_eqt,pl_orbeccen,"
    "disc_year,disc_facility,discoverymethod,st_teff,st_rad,st_mass,st_spectype,sy_vmag"
)

# nomi con cui queste stelle sono conosciute in italiano (e altri nomi per la ricerca)
NAMES: dict[str, tuple[str, tuple[str, ...]]] = {
    "Proxima Cen": ("Proxima Centauri", ()),
    "Barnard's star": ("Stella di Barnard", ("Barnard",)),
    "eps Eri": ("Epsilon Eridani", ("Ran",)),
    "tau Cet": ("Tau Ceti", ()),
    "eps Ind A": ("Epsilon Indi A", ()),
    "Teegarden's Star": ("Stella di Teegarden", ("Teegarden",)),
    "Kapteyn": ("Stella di Kapteyn", ()),
    "51 Peg": ("51 Pegasi", ("Helvetios",)),
    "55 Cnc": ("55 Cancri", ("Copernicus",)),
    "ups And": ("Upsilon Andromedae", ()),
    "47 UMa": ("47 Ursae Majoris", ()),
    "bet Pic": ("Beta Pictoris", ()),
    "HD 62509": ("Polluce", ("Pollux", "Beta Geminorum")),
    "61 Vir": ("61 Virginis", ()),
    "AU Mic": ("AU Microscopii", ()),
}

METHODS = {
    "Radial Velocity": "velocità radiali (la stella oscilla avanti e indietro)",
    "Transit": "transiti (il pianeta passa davanti alla stella e ne attenua la luce)",
    "Imaging": "immagine diretta",
    "Astrometry": "astrometria (la stella si sposta in cielo)",
    "Microlensing": "microlente gravitazionale",
    "Pulsar Timing": "ritardi nei segnali della pulsar",
    "Transit Timing Variations": "variazioni nei tempi dei transiti",
    "Eclipse Timing Variations": "variazioni nei tempi delle eclissi",
}

R_SUN_KM = 695700.0
R_EARTH_KM = 6371.0
M_SUN_KG = 1.98847e30
M_EARTH_KG = 5.9722e24
GM_SUN_KM3_S2 = 132712440041.94
AU_KM = 149597870.7


def query() -> str:
    names = ",".join("'" + n + "'" for n in FAMOUS)
    return f"select {COLUMNS} from pscomppars where sy_dist < {NEAR_PC} or hostname in ({names}) order by sy_dist"


async def fetch(http: Http) -> list[dict[str, Any]]:
    r = await http.get(URL, params={"query": query(), "format": "json"}, retries=1, timeout=60)
    rows = r.json()
    if not isinstance(rows, list):
        raise RuntimeError("Risposta inattesa dal NASA Exoplanet Archive")
    return rows


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def _num(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def teff_color(teff: float | None) -> str:
    """Colore di un corpo nero a quella temperatura (approssimazione di Tanner Helland)."""
    if teff is None:
        return "#bcd0ff"
    t = max(1000.0, min(40000.0, teff)) / 100.0
    if t <= 66:
        r = 255.0
        g = 99.4708025861 * math.log(t) - 161.1195681661
        b = 0.0 if t <= 19 else 138.5177312231 * math.log(t - 10) - 305.0447927307
    else:
        r = 329.698727446 * (t - 60) ** -0.1332047592
        g = 288.1221695283 * (t - 60) ** -0.0755148492
        b = 255.0
    c = [int(max(0, min(255, round(x)))) for x in (r, g, b)]
    return "#{:02x}{:02x}{:02x}".format(*c)


def planet_look(radius_e: float, eqt_k: float | None) -> tuple[str, str, str]:
    """Colore, tipo di superficie e descrizione di un pianeta, dal raggio e dalla temperatura."""
    hot = eqt_k is not None and eqt_k > 1000
    if radius_e < 1.6:
        if eqt_k is not None and eqt_k > 700:
            return "#8a5a48", "roccia", "pianeta roccioso rovente"
        return "#a08a78", "roccia", "pianeta roccioso"
    if radius_e < 4:
        return "#9cc4d8", "gas", "super-Terra o mini-Nettuno"
    if radius_e < 8:
        return "#6f9fe0", "gas", "gigante di ghiaccio, simile a Nettuno"
    if hot:
        return "#d98a5a", "gas", "gigante gassoso rovente («Giove caldo»)"
    return "#d8c09a", "gas", "gigante gassoso"


def estimate_radius_e(mass_e: float) -> float:
    """Raggio (in raggi terrestri) stimato dalla massa, quando non è stato misurato."""
    if mass_e < 2:
        return mass_e ** 0.279
    if mass_e < 100:
        return 0.808 * mass_e ** 0.589
    return 12.0


def build_bodies(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Dalle righe dell'archivio ai corpi del catalogo: prima ogni stella, poi i suoi pianeti."""
    out: list[dict[str, Any]] = []
    stars: dict[str, dict[str, Any]] = {}
    seen: set[str] = set()
    for r in rows:
        host, pl = r.get("hostname"), r.get("pl_name")
        dist, ra, dec = _num(r.get("sy_dist")), _num(r.get("ra")), _num(r.get("dec"))
        if not host or not pl or dist is None or ra is None or dec is None or dist <= 0:
            continue
        st_mass = _num(r.get("st_mass"))
        period, a_au = _num(r.get("pl_orbper")), _num(r.get("pl_orbsmax"))
        gm = GM_SUN_KM3_S2 * st_mass if st_mass and st_mass > 0 else None
        # orbita circolare coerente con la terza legge di Keplero (periodo misurato e massa della stella)
        if period and period > 0 and gm:
            a_km = (gm * (period * 86400.0) ** 2 / (4 * math.pi ** 2)) ** (1 / 3)
        elif a_au and a_au > 0 and gm:
            a_km = a_au * AU_KM
            period = 2 * math.pi * math.sqrt(a_km ** 3 / gm) / 86400.0
        else:
            continue
        pid = f"exo:{slug(pl)}"
        if pid in seen:
            continue
        seen.add(pid)
        it_name, aliases = NAMES.get(host, (host, ()))
        sid = f"exo:{slug(host)}"
        if host not in stars:
            teff, st_rad, vmag = _num(r.get("st_teff")), _num(r.get("st_rad")), _num(r.get("sy_vmag"))
            pulsar = host.startswith("PSR")
            if st_rad is None:
                st_rad = 12.0 / R_SUN_KM if pulsar else (st_mass or 0.3) ** 0.8
            if vmag is not None:
                absmag = vmag - 5 * math.log10(dist / 10)
            elif teff:
                absmag = 4.83 - 2.5 * math.log10(max(st_rad ** 2 * (teff / 5772) ** 4, 1e-9))
            else:
                absmag = 20.0
            phys: dict[str, Any] = {"radius_km": round(st_rad * R_SUN_KM, 1)}
            if st_mass:
                phys["mass_kg"] = st_mass * M_SUN_KG
            if teff:
                phys["temp_surface_k"] = round(teff)
            spect = r.get("st_spectype")
            if pulsar:
                phys["spectral"] = "pulsar (stella di neutroni)"
            elif spect:
                phys["spectral"] = str(spect)
            star = {
                "id": sid, "name": it_name, "kind": "star", "parent": "naif:10", "rank": 3, "exo": True,
                "radius_km": phys["radius_km"], "color": teff_color(teff), "absmag": round(absmag, 2),
                "fixed": {"ra_deg": ra, "dec_deg": dec, "dist_pc": dist},
                "content": "esopianeti", "aliases": sorted({host, *aliases} - {it_name}),
                # il nome compare solo avvicinandosi al sistema: dal Sistema solare le stelle vicine
                # con pianeti (deboli nane rosse, per lo più) riempirebbero il cielo di nomi
                "show": {"from": "self", "max_pc": 1.0},
                "phys": phys,
            }
            if not pulsar:
                star["texture"] = "sun"
            stars[host] = star
            out.append(star)
        mass_e, rad_e = _num(r.get("pl_bmasse")), _num(r.get("pl_rade"))
        if rad_e is None:
            rad_e = estimate_radius_e(mass_e) if mass_e else 1.0
        eqt = _num(r.get("pl_eqt"))
        color, surface, kind_it = planet_look(rad_e, eqt)
        phys = {"radius_km": round(rad_e * R_EARTH_KM, 1), "period_y": period / 365.25, "morphology": kind_it}
        if mass_e:
            phys["mass_kg"] = mass_e * M_EARTH_KG
        if eqt is not None:
            phys["temp_c"] = round(eqt - 273.15)
        ecc = _num(r.get("pl_orbeccen"))
        if ecc:
            phys["eccentricity"] = ecc
        year, fac, method = r.get("disc_year"), r.get("disc_facility"), r.get("discoverymethod")
        if year or fac:
            phys["discovery"] = {
                "by": fac or None,
                "date": str(int(year)) if year else None,
                "method": METHODS.get(str(method), str(method)) if method else None,
            }
        out.append({
            "id": pid, "name": pl.replace(host, it_name, 1) if pl.startswith(host) else pl,
            "kind": "planet", "parent": sid, "rank": 3, "exo": True,
            "radius_km": phys["radius_km"], "color": color, "surface": surface,
            # vicinissimo alla stella un pianeta le mostra sempre la stessa faccia
            "rotation": {"model": "sync"} if period < 30 else {"model": "spin", "period_h": 20},
            "mean_orbit": {"a_km": a_km, "period_d": period, "i_deg": 0, "plane": "ecliptic"},
            "content": "esopianeti", "aliases": [pl] if not pl.startswith(it_name) else [],
            "show": {"from": "self", "max_pc": 0.003},
            "phys": phys,
        })
    return out
