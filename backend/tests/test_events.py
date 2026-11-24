"""Passaggi ravvicinati (CNEOS): lettura della risposta e stima del diametro."""

from __future__ import annotations

from atlante.sources import sbdb


def test_parse_approaches():
    js = {
        "count": "1",
        "fields": ["des", "orbit_id", "jd", "cd", "dist", "dist_min", "dist_max", "v_rel", "v_inf", "t_sigma_f", "h", "fullname"],
        "data": [["99942", "220", "2462240.407", "2029-Apr-13 21:46", "0.000254", "0.000254", "0.000254",
                  "7.42", "5.84", "< 00:01", "19.09", "    99942 Apophis (2004 MN4)"]],
    }
    out = sbdb.parse_approaches(js)
    assert len(out) == 1
    a = out[0]
    assert a["des"] == "99942"
    assert a["name"] == "99942 Apophis (2004 MN4)"
    assert a["date"] == "2029-Apr-13 21:46"
    assert abs(a["dist_au"] - 0.000254) < 1e-9
    lo, hi = a["diameter_m"]
    assert 250 < lo < 450 and 600 < hi < 1000   # Apophis misura circa 340 m (albedo alto, 0,35)


def test_diametro_mancante():
    assert sbdb.diameter_range_m(None) is None
    assert sbdb.parse_approaches({"fields": ["des"], "data": [["X"]]})[0]["diameter_m"] is None
