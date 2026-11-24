from atlante.sources import horizons
from atlante.timeutil import jd_from_horizons_date, jd_from_calendar

SAMPLE = """*******************************************************************************
Ephemeris / API_USER Fri Oct 23 09:00:00 2026 Pasadena, USA      / Horizons
*******************************************************************************
Target body name: Voyager 1 (spacecraft)          {source: Voyager_1_ST+refit2022_m}
Center body name: Sun (10)                        {source: DE441}
*******************************************************************************
            JDTDB,            Calendar Date (TDB),                      X,                      Y,                      Z,                     VX,                     VY,                     VZ,
**************************************************************************************************************************************************************************************************
$$SOE
2461336.500000000, A.D. 2026-Oct-23 00:00:00.0000, -4.815612345678901E+09, -2.049512345678901E+10,  1.482812345678901E+10, -2.059123456789012E+00, -1.360712345678901E+01,  9.832123456789012E+00,
2461337.500000000, A.D. 2026-Oct-24 00:00:00.0000, -4.815790000000000E+09, -2.049630000000000E+10,  1.482897000000000E+10, -2.059100000000000E+00, -1.360700000000000E+01,  9.832100000000000E+00,
$$EOE
"""

def test_parse():
    t = horizons.parse_vectors(SAMPLE)
    assert len(t.rows) == 2
    assert t.rows[0][0] == 2461336.5
    assert abs(t.rows[0][1] + 4.815612345678901e9) < 1
    assert t.target_name.startswith("Voyager 1")

def test_errors():
    e = horizons._classify_error('No ephemeris for target "Voyager 1 (spacecraft)" prior to A.D. 1977-SEP-05 14:10:50.0000 TDB')
    assert e.not_before is not None and abs(e.not_before - (jd_from_calendar(1977, 9, 5) + (14 + 10/60 + 50/3600)/24)) < 1e-6
    e = horizons._classify_error('No ephemeris for target "Juno" after A.D. 2025-SEP-16 00:00:00.0000 TDB')
    assert e.not_after is not None
    e = horizons._classify_error("    No matches found.")
    assert e.not_found

def test_steps():
    assert horizons.step_to_days("15 m") == 15 / 1440
    assert horizons.step_to_days("6 h") == 0.25
    assert horizons.step_to_days("2 d") == 2

def test_jd():
    assert jd_from_calendar(2000, 1, 1.5) == 2451545.0
    assert jd_from_horizons_date("2000-JAN-01 12:00") == 2451545.0
