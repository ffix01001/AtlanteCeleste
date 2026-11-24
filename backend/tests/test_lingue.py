"""Lingue: catalogo tradotto, schede e dati di riferimento con ripiego inglese -> italiano."""

import json

from fastapi.testclient import TestClient

from atlante.catalog import Catalog
from atlante.config import lang_chain


def test_catena_delle_lingue():
    assert lang_chain("de") == ["de", "en", "it"]
    assert lang_chain("en") == ["en", "it"]
    assert lang_chain("it") == ["it", "en"]
    assert lang_chain("xx") == ["en", "it"]        # lingua sconosciuta: inglese
    assert lang_chain(None) == ["en", "it"]


def _catalogo(tmp_path):
    cat, content, i18n = tmp_path / "catalog", tmp_path / "content", tmp_path / "i18n"
    for d in (cat, content / "it", content / "en", i18n):
        d.mkdir(parents=True)
    bodies = [
        {"id": "ssb", "name": "Baricentro", "kind": "barycenter", "parent": None},
        {"id": "naif:10", "slug": "sole", "name": "Sole", "kind": "star", "parent": "ssb", "wiki": "Sole",
         "phys": {"spectral": "nana gialla", "mass_kg": 2e30}},
        {"id": "naif:499", "slug": "marte", "name": "Marte", "kind": "planet", "parent": "naif:10", "wiki": "Marte (astronomia)"},
    ]
    (cat / "a.json").write_text(json.dumps({"bodies": bodies}), encoding="utf-8")
    (content / "it" / "sole.md").write_text("# Sole", encoding="utf-8")
    (content / "it" / "marte.md").write_text("# Marte", encoding="utf-8")
    (content / "en" / "sole.md").write_text("# Sun", encoding="utf-8")
    (i18n / "en.json").write_text(json.dumps({"bodies": {
        "naif:10": {"name": "Sun", "wiki": "Sun", "phys": {"spectral": "yellow dwarf"}},
        "naif:499": {"name": "Mars", "wiki": "Mars"},
    }}), encoding="utf-8")
    (i18n / "fr.json").write_text(json.dumps({"bodies": {}, "values": {"Baricentro": "Barycentre", "Sole": "Soleil"}}), encoding="utf-8")
    (i18n / "de.json").write_text(json.dumps({"bodies": {"naif:10": {"name": "Sonne"}}}), encoding="utf-8")
    return Catalog(cat, content, i18n)


def test_catalogo_tradotto(tmp_path):
    c = _catalogo(tmp_path)
    it = {b["id"]: b for b in c.listing("it")}
    assert it["naif:10"]["name"] == "Sole" and it["naif:10"]["wiki_lang"] == "it"
    en = {b["id"]: b for b in c.listing("en")}
    assert en["naif:10"]["name"] == "Sun" and en["naif:10"]["wiki"] == "Sun" and en["naif:10"]["wiki_lang"] == "en"
    assert en["naif:10"]["phys"] == {"spectral": "yellow dwarf", "mass_kg": 2e30}   # i campi annidati si fondono
    assert "Sole" in en["naif:10"]["aliases"]                                     # il nome italiano si trova ancora
    de = {b["id"]: b for b in c.listing("de")}
    assert de["naif:10"]["name"] == "Sonne"                   # dal tedesco
    assert de["naif:10"]["wiki"] == "Sun" and de["naif:10"]["wiki_lang"] == "en"   # voce inglese come ripiego
    assert de["naif:499"]["name"] == "Mars"                   # manca in tedesco: inglese
    assert c.bodies["naif:10"]["name"] == "Sole"              # l'originale non cambia
    fr = {b["id"]: b for b in c.listing("fr")}
    assert fr["ssb"]["name"] == "Barycentre"                   # testi interi tradotti per qualsiasi corpo
    assert fr["naif:10"]["name"] == "Sun"                      # (qui c'è già la traduzione inglese per id)


def test_schede_con_ripiego(tmp_path):
    c = _catalogo(tmp_path)
    sole, marte = c.bodies["naif:10"], c.bodies["naif:499"]
    assert c.content(sole, "it") == "# Sole"
    assert c.content(sole, "de") == "# Sun" and c.content_lang(sole, "de") == "en"
    assert c.content(marte, "fr") == "# Marte" and c.content_lang(marte, "fr") == "it"


def test_riferimenti_per_lingua(tmp_path, monkeypatch):
    from atlante import main

    ref = tmp_path / "reference"
    ref.mkdir()
    (ref / "costellazioni_it.json").write_text('{"Ori": "Orione"}', encoding="utf-8")
    (ref / "costellazioni_en.json").write_text('{"Ori": "Orion"}', encoding="utf-8")
    (ref / "luoghi.json").write_text('{"x": "it"}', encoding="utf-8")
    (ref / "luoghi_es.json").write_text('{"x": "es"}', encoding="utf-8")
    monkeypatch.setattr(main, "DATA_DIR", tmp_path)
    with TestClient(main.app) as cl:
        assert cl.get("/api/reference/costellazioni_it?lang=it").json() == {"Ori": "Orione"}
        assert cl.get("/api/reference/costellazioni_it?lang=de").json() == {"Ori": "Orion"}
        assert cl.get("/api/reference/luoghi?lang=it").json() == {"x": "it"}
        assert cl.get("/api/reference/luoghi?lang=es").json() == {"x": "es"}
        assert cl.get("/api/reference/luoghi?lang=fr").json() == {"x": "it"}


def test_lingua_della_schermata_d_avvio(tmp_path, monkeypatch):
    from atlante import config, desktop, main

    f = tmp_path / "lingua.txt"
    monkeypatch.setattr(config, "LANG_FILE", f)
    monkeypatch.setattr(main, "LANG_FILE", f)
    monkeypatch.setenv("LANG", "de_DE.UTF-8")
    monkeypatch.delenv("LC_ALL", raising=False)
    assert desktop.splash_lang() == "de"                  # nessuna scelta: lingua del sistema
    with TestClient(main.app) as cl:
        assert cl.post("/api/lang", json={"lang": "fr"}).status_code == 403          # senza intestazione
        assert cl.post("/api/lang", json={"lang": "xx"}, headers={"X-Atlante": "1"}).status_code == 400
        assert cl.post("/api/lang", json={"lang": "fr"}, headers={"X-Atlante": "1"}).json() == {"ok": True}
    assert f.read_text() == "fr"
    page = desktop.splash()
    assert 'lang="fr"' in page and "Démarrage du moteur" in page
