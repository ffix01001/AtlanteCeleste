"""Tasselli stellari: octree ordinato per luminosità, unione Gaia + HYG, intervalli HEALPix di Gaia."""

from __future__ import annotations

import gzip
import json
import sqlite3
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[2]


sys.path.insert(0, str(ROOT / "backend"))
from atlante import startiles as bst  # noqa: E402
from atlante.sources import gaia  # noqa: E402


def fake_stars(n: int, seed: int = 1):
    rng = np.random.default_rng(seed)
    s = bst.Stars(n)
    s.x[:] = rng.normal(0, 200, n)
    s.y[:] = rng.normal(0, 200, n)
    s.z[:] = rng.normal(0, 50, n)
    s.absmag[:] = rng.uniform(-5, 15, n)
    s.ci[:] = 0.6
    s.ids[:] = np.arange(1, n + 1)
    s.info = [{"hip": None} for _ in range(n)]
    return s


def test_octree_ordinato_per_luminosita():
    s = fake_stars(30000)
    root = bst.build_octree(s, cap=1000)
    nodes = list(bst.walk(root))
    # ogni stella sta in un solo tassello
    all_idx = np.concatenate([n.idx for n in nodes])
    assert len(all_idx) == len(s) and len(set(all_idx.tolist())) == len(s)
    for n in nodes:
        assert len(n.idx) <= 1000
        # nessuna stella dei figli è più luminosa della più debole del padre
        if n.children and len(n.idx):
            weakest_parent = s.absmag[n.idx].max()
            for c in n.children:
                assert s.absmag[c.idx].min() >= weakest_parent - 1e-6
        # le stelle stanno dentro il cubo del tassello
        if len(n.idx):
            assert np.all(np.abs(s.x[n.idx] - n.cx) <= n.h + 1e-6)


def test_scrittura_indice_e_info(tmp_path):
    s = fake_stars(5000)
    s.info[0] = {"proper": "Prova", "name_it": "Stella di prova", "hip": 12}
    root = bst.build_octree(s, cap=800)
    bst.write(s, root, tmp_path / "x", {"id": "x", "label": "test"})
    idx = json.loads((tmp_path / "x" / "index.json").read_text(encoding="utf-8"))
    assert idx["count"] == 5000 and idx["nodes"][0]["id"] == "r"
    names = json.loads((tmp_path / "x" / "names.json").read_text(encoding="utf-8"))
    assert names[0]["name"] == "Stella di prova"
    db = sqlite3.connect(tmp_path / "x" / "info.sqlite")
    row = json.loads(db.execute("SELECT data FROM stars WHERE id='1'").fetchone()[0])
    assert row["proper"] == "Prova" and "x" in row
    # il tassello si rilegge con il lettore ATBL del server
    sys.path.insert(0, str(ROOT / "backend"))
    from atlante import binpack
    meta, cols = binpack.unpack((tmp_path / "x" / "tiles" / "r.atbl").read_bytes())
    assert meta["count"] == len(cols["x"]) <= 800


def test_gaia_csv_e_unione_con_hyg(tmp_path):
    csv = (
        "source_id,ra,dec,parallax,parallax_error,phot_g_mean_mag,bp_rp,hip\n"
        "4472832130942575872,269.452,4.693,546.97,0.04,8.19,2.83,87937\n"   # stella di Barnard
        "5853498713190525696,217.392,-62.676,768.07,0.05,8.98,3.80,70890\n"  # Proxima Centauri
        "1,10.0,10.0,-1.0,0.5,12.0,1.0,\n"                                   # parallasse negativa: scartata
    )
    folder = tmp_path / "gaia"
    folder.mkdir()
    (folder / "zona_2_00000.csv.gz").write_bytes(gzip.compress(csv.encode()))
    hyg = fake_stars(10)
    hyg.info = [{"hip": None} for _ in range(10)]
    hyg.info[3] = {"hip": 70890, "proper": "Proxima Centauri", "name_it": "Proxima Centauri", "con": "Cen"}
    s = bst.load_gaia(folder, hyg)
    # 2 stelle Gaia + 9 HYG (Proxima è già in Gaia e non si duplica)
    assert len(s) == 11
    d = 1000 / 768.07
    assert abs(np.hypot(np.hypot(s.x[1], s.y[1]), s.z[1]) - d) < 1e-6
    info = s.info_of(1)
    assert info["name_it"] == "Proxima Centauri" and info["gaia_dr3"] == "5853498713190525696"
    assert s.ids[2] < 0  # le stelle HYG hanno id negativo


def test_intervalli_healpix():
    lo, hi = gaia.chunk_range(0, 2)
    assert lo == 0 and hi == 4 ** 10 * 2 ** 35 - 1
    # le zone coprono tutti i source_id senza sovrapporsi
    last = -1
    for p in range(gaia.n_pixels(1)):
        a, b = gaia.chunk_range(p, 1)
        assert a == last + 1
        last = b
    assert last == gaia.HPX12_PIXELS * gaia.SID_PER_HPX12 - 1
    q = gaia.query(12, 0, 100)
    assert "parallax_over_error >= 5" in q and "phot_g_mean_mag < 12.00" in q and "hipparcos2_best_neighbour" in q


def test_diagramma_hr(tmp_path):
    from atlante.stars import Stars

    s = fake_stars(5000)
    s.ci[:2500] = 1.2          # metà con un colore misurato
    s.ci[2500:] = 0.65         # metà senza colore (valore segnaposto degli script): da escludere
    root = bst.build_octree(s, cap=1000)
    bst.write(s, root, tmp_path / "x", {"id": "x", "label": "test"})
    hr = Stars(tmp_path).hr("x")
    assert hr["total"] == sum(hr["counts"])
    # magnitudini fuori dal riquadro (-9...17) escluse; nessuna stella "senza colore"
    assert 2400 <= hr["total"] <= 2500
    b0, b1, nb = hr["bv"]
    col = int((1.2 - b0) / (b1 - b0) * nb)
    assert sum(hr["counts"][j * nb + col] for j in range(hr["mag"][2])) == hr["total"]
    assert (tmp_path / "x" / "hr.json").exists()   # salvato per le volte successive
    assert Stars(tmp_path).hr("x") == hr
