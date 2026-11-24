"""Divide un catalogo stellare in "tasselli" (octree) per caricarlo a pezzi.

La logica è in backend/atlante/startiles.py (la usa anche il programma, quando scarica Gaia
da solo dal pannello dei livelli); questo script la richiama dalla riga di comando.

Ingressi gestiti:
  --hyg   data/generated/stars_hyg.atbl + stars_hyg_meta.json (già nel progetto)
  --gaia  file CSV prodotti da scripts/gaia_scarica.py (si uniscono a HYG)

Uscita: data/generated/stars/<catalogo>/  (index.json, tiles/, names.json, info.sqlite)

Uso:
  uv run --project backend --group dev python scripts/build_star_tiles.py --hyg
  uv run --project backend --group dev python scripts/build_star_tiles.py --gaia data/sources/gaia --nome gaia
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))
from atlante.startiles import build_octree, load_gaia, load_hyg, write  # noqa: E402

GEN = ROOT / "data" / "generated"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--hyg", action="store_true", help="usa il catalogo HYG già presente nel progetto")
    ap.add_argument("--gaia", type=Path, help="cartella con i CSV di Gaia DR3 (da gaia_scarica.py)")
    ap.add_argument("--nome", default=None, help="nome del catalogo in uscita (predefinito: hyg o gaia)")
    a = ap.parse_args()
    if not a.hyg and not a.gaia:
        ap.error("indica --hyg oppure --gaia")
    hyg = load_hyg()
    if a.gaia:
        stars = load_gaia(a.gaia, hyg)
        cat = {"id": a.nome or "gaia", "label": "Gaia DR3 + HYG",
               "license": "Gaia DR3: ESA/Gaia/DPAC (CC BY-SA 3.0 IGO); HYG v4.1: CC BY-SA 4.0"}
    else:
        stars = hyg
        cat = {"id": a.nome or "hyg", "label": "HYG v4.1",
               "license": "CC BY-SA 4.0 — David Nash, The HYG Database (astronexus)"}
    root = build_octree(stars)
    write(stars, root, GEN / "stars" / cat["id"], cat)


if __name__ == "__main__":
    main()
