from atlante.sources import geocode


def test_parse_open_meteo():
    js = {
        "results": [
            {"name": "Frascati", "latitude": 41.80864, "longitude": 12.67538, "elevation": 322.0,
             "timezone": "Europe/Rome", "country": "Italia", "admin1": "Lazio"},
            {"name": "senza coordinate"},
            {"name": "Frascati", "latitude": "x", "longitude": 1},
        ]
    }
    out = geocode.parse(js)
    assert len(out) == 1
    p = out[0]
    assert p["name"] == "Frascati" and p["tz"] == "Europe/Rome" and p["where"] == "Lazio, Italia"
    assert abs(p["lat"] - 41.80864) < 1e-6 and p["elev"] == 322


def test_parse_vuoto():
    assert geocode.parse({}) == []
    assert geocode.parse({"results": None}) == []
