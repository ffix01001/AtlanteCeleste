"""Download di Gaia dal programma: archivio finto (TAP asincrono), ripresa, tasselli, interruzione."""

from __future__ import annotations

import json
import re
import shutil

import httpx

from atlante.config import GENERATED_DIR
from atlante.gaia_job import GaiaJob
from atlante.sources.gaia import SID_PER_HPX12

CHOICES = {8.0: {"stars": 10, "mb": 1, "minutes": [1, 2]}}


class FakeArchive:
    """Servizio TAP asincrono finto: ogni zona restituisce qualche stella con il source_id giusto."""

    def __init__(self, fail_zones: set[int] | None = None, per_zone: int = 3) -> None:
        self.jobs: dict[str, str] = {}
        self.posts = 0
        self.fail_zones = fail_zones or set()
        self.per_zone = per_zone

    def handler(self, req: httpx.Request) -> httpx.Response:
        url = str(req.url)
        if req.method == "POST" and url.endswith("/async"):
            self.posts += 1
            q = dict(httpx.QueryParams(req.content.decode()))["QUERY"]
            lo, hi = map(int, re.search(r"BETWEEN (\d+) AND (\d+)", q).groups())
            jid = f"j{len(self.jobs)}"
            self.jobs[jid] = f"{lo},{hi}"
            return httpx.Response(303, headers={"location": f"https://gea.esac.esa.int/tap-server/tap/async/{jid}"})
        m = re.search(r"/async/(j\d+)/(phase|results/result|error)$", url)
        assert m, url
        jid, what = m.groups()
        lo, hi = map(int, self.jobs[jid].split(","))
        zone = lo // (SID_PER_HPX12 * 4 ** 12)  # zone di livello 0
        if what == "phase":
            return httpx.Response(200, text="ERROR" if zone in self.fail_zones else "COMPLETED")
        if what == "error":
            return httpx.Response(200, text="zona non disponibile")
        rows = ["source_id,ra,dec,parallax,parallax_error,phot_g_mean_mag,bp_rp,hip"]
        for k in range(self.per_zone):
            rows.append(f"{lo + k + 1},{(zone * 30 + k) % 360},{-60 + zone * 10},{5 + k},0.1,{7 + k * 0.3},0.9,")
        return httpx.Response(200, text="\n".join(rows) + "\n")


def make_job(tmp_path, archive: FakeArchive) -> GaiaJob:
    gen = tmp_path / "generated"
    gen.mkdir()
    for f in ("stars_hyg.atbl", "stars_hyg_meta.json"):
        shutil.copy(GENERATED_DIR / f, gen / f)
    return GaiaJob(
        sources_dir=tmp_path / "sources" / "gaia", tiles_dir=gen / "stars", gen_dir=gen,
        client_factory=lambda: httpx.Client(transport=httpx.MockTransport(archive.handler)),
        level=0, workers=2, sleep=lambda s: None, choices=CHOICES,
    )


def test_scarica_e_prepara_il_catalogo(tmp_path):
    arch = FakeArchive()
    job = make_job(tmp_path, arch)
    swapped = []
    job.before_swap = lambda: swapped.append(1)
    st = job.start(8.0)
    assert st["running"]
    job.wait(120)
    st = job.status()
    assert st["state"] == "done", st
    assert st["zones_done"] == st["zones_total"] == 12 and arch.posts == 12 and swapped
    idx = json.loads((tmp_path / "generated" / "stars" / "gaia" / "index.json").read_text(encoding="utf-8"))
    assert idx["gmax"] == 8.0 and idx["count"] > 12 * 3  # le stelle di Gaia più quelle di HYG
    assert st["catalog"]["count"] == idx["count"]
    # una seconda volta non si scarica nulla: le zone sono già su disco, il catalogo vecchio si mette da parte
    job.start(8.0)
    job.wait(120)
    assert job.status()["state"] == "done" and arch.posts == 12
    assert (tmp_path / "generated" / "stars" / "gaia.precedente" / "index.json").exists()


def test_errore_e_ripresa(tmp_path):
    arch = FakeArchive(fail_zones={5})
    job = make_job(tmp_path, arch)
    job.start(8.0)
    job.wait(120)
    st = job.status()
    assert st["state"] == "error" and st["error"]
    assert not (tmp_path / "generated" / "stars" / "gaia").exists()
    have = st["choices"][0]["zones_on_disk"]
    assert 0 < have < 12
    # l'archivio torna a funzionare: si riprende senza riscaricare le zone già pronte
    arch.fail_zones = set()
    before = arch.posts
    job.start(8.0)
    job.wait(120)
    assert job.status()["state"] == "done"
    assert arch.posts - before == 12 - have


def test_interruzione(tmp_path):
    arch = FakeArchive()
    job = make_job(tmp_path, arch)
    job.cancel()           # nessun effetto se non sta lavorando
    job._cancel.set()
    job._run(8.0)          # interrotto subito
    assert job.status()["state"] == "cancelled"


def test_scelta_non_prevista(tmp_path):
    job = make_job(tmp_path, FakeArchive())
    try:
        job.start(15.0)
    except ValueError:
        pass
    else:
        raise AssertionError("doveva rifiutare G < 15")
