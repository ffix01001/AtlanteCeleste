"""Esopianeti: dalle righe del NASA Exoplanet Archive ai corpi del catalogo."""

import math

from atlante.catalog import Catalog
from atlante.sources import exoplanets

# righe vere dell'archivio (novembre 2026), accorciate
ROWS = [
    {"pl_name": "Proxima Cen b", "hostname": "Proxima Cen", "sy_dist": 1.30119, "ra": 217.3934657, "dec": -62.6761821,
     "pl_orbper": 11.18465, "pl_orbsmax": 0.04848, "pl_rade": 1.02, "pl_bmasse": 1.055, "pl_eqt": 218, "pl_orbeccen": 0,
     "disc_year": 2016, "disc_facility": "European Southern Observatory", "discoverymethod": "Radial Velocity",
     "st_teff": 2900, "st_rad": 0.141, "st_mass": 0.1221, "st_spectype": "M5.5 V", "sy_vmag": 11.01},
    {"pl_name": "TRAPPIST-1 e", "hostname": "TRAPPIST-1", "sy_dist": 12.42988881, "ra": 346.6263919, "dec": -5.0434618,
     "pl_orbper": 6.101013, "pl_orbsmax": 0.02925, "pl_rade": 0.92, "pl_bmasse": 0.692, "pl_eqt": 249.7, "pl_orbeccen": 0.0051,
     "disc_year": 2017, "disc_facility": "Multiple Observatories", "discoverymethod": "Transit",
     "st_teff": 2566, "st_rad": 0.1192, "st_mass": 0.0898, "st_spectype": "M8.0 V", "sy_vmag": 17.02},
    {"pl_name": "PSR B1257+12 c", "hostname": "PSR B1257+12", "sy_dist": 600, "ra": 195.0149029, "dec": 12.6823534,
     "pl_orbper": 66.5419, "pl_orbsmax": 0.36, "pl_rade": 1.91, "pl_bmasse": 4.3, "pl_eqt": None, "pl_orbeccen": 0.0186,
     "disc_year": 1992, "disc_facility": "Arecibo Observatory", "discoverymethod": "Pulsar Timing",
     "st_teff": None, "st_rad": None, "st_mass": 1.4, "st_spectype": None, "sy_vmag": None},
    {"pl_name": "senza periodo né distanza", "hostname": "X", "sy_dist": 5, "ra": 1, "dec": 1, "st_mass": 1},
    {"pl_name": "senza posizione", "hostname": "Y", "sy_dist": None},
]


def test_build_bodies():
    bodies = exoplanets.build_bodies(ROWS)
    by_id = {b["id"]: b for b in bodies}
    assert [b["kind"] for b in bodies] == ["star", "planet", "star", "planet", "star", "planet"]
    star, planet = by_id["exo:proxima-cen"], by_id["exo:proxima-cen-b"]
    assert star["name"] == "Proxima Centauri" and "Proxima Cen" in star["aliases"]
    assert planet["name"] == "Proxima Centauri b" and planet["parent"] == star["id"]
    # l'orbita rispetta la terza legge di Keplero e viene vicina al valore dell'archivio (0,0485 UA)
    a_au = planet["mean_orbit"]["a_km"] / exoplanets.AU_KM
    assert abs(a_au - 0.0485) < 0.001
    gm = exoplanets.GM_SUN_KM3_S2 * 0.1221
    p = 2 * math.pi * math.sqrt(planet["mean_orbit"]["a_km"] ** 3 / gm) / 86400
    assert abs(p - 11.18465) < 1e-6
    # nana rossa: magnitudine assoluta alta, colore caldo
    assert 15 < star["absmag"] < 16 and star["color"].startswith("#ff")
    assert planet["phys"]["discovery"] == {
        "by": "European Southern Observatory", "date": "2016",
        "method": "velocità radiali (la stella oscilla avanti e indietro)",
    }
    assert planet["rotation"] == {"model": "sync"} and planet["surface"] == "roccia"
    # la pulsar non ha temperatura né raggio nell'archivio: valori di ripiego, nessun errore
    psr = by_id["exo:psr-b1257-12"]
    assert psr["radius_km"] == 12.0 and "texture" not in psr and psr["phys"]["spectral"].startswith("pulsar")
    assert by_id["exo:psr-b1257-12-c"]["rotation"]["model"] == "spin"


def test_catalog_extra_non_sovrascrive(tmp_path):
    cat = Catalog()
    n = len(cat.order)
    extra = exoplanets.build_bodies(ROWS) + [{"id": "naif:399", "name": "falsa Terra", "kind": "planet", "parent": "naif:10"},
                                             {"id": "exo:orfano", "name": "x", "kind": "planet", "parent": "exo:non-esiste"}]
    cat.set_extra(extra)
    assert len(cat.order) == n + 6
    assert cat.get("naif:399")["name"] == "Terra"
    assert cat.get("exo:orfano") is None
    listed = {b["id"]: b for b in cat.listing("it")}
    assert listed["exo:trappist-1-e"]["parent"] == "exo:trappist-1"
    cat.reload()
    assert cat.get("exo:trappist-1") is not None


def test_query_valida():
    q = exoplanets.query()
    assert "pscomppars" in q and "sy_dist < 10" in q and "'TRAPPIST-1'" in q
