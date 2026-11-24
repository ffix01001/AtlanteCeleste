"""Scarica le stelle del catalogo Gaia DR3 (ESA) per Atlante Celeste.

Gaia ha misurato posizione, distanza (parallasse) e colore di quasi due
miliardi di stelle. Questo script ne scarica la parte più utile per una mappa
3D: le stelle più luminose di una certa magnitudine con una distanza affidabile
(parallasse almeno 5 volte più grande del suo errore, cioè errore sotto il 20%).

Il cielo viene diviso in zone (pixel HEALPix: il numero `source_id` di Gaia
contiene già la zona) e ogni zona è una richiesta separata all'archivio ESA.
Le zone già scaricate vengono saltate: se lo script si interrompe, basta
rilanciarlo e riprende da dove era rimasto.

Lo stesso download si può avviare dal programma (pannello Livelli, "Più stelle"); la logica
comune è in backend/atlante/sources/gaia.py.

Uso (dalla cartella del progetto):
  uv run --project backend --group dev python scripts/gaia_scarica.py --prova
  uv run --project backend --group dev python scripts/gaia_scarica.py --gmax 12
poi
  uv run --project backend --group dev python scripts/build_star_tiles.py --gaia data/sources/gaia

Quante stelle (indicativo):  G < 11 ≈ 1,5 milioni,  G < 12 ≈ 3 milioni,
G < 13 ≈ 7 milioni,  G < 14 ≈ 16 milioni. Più stelle = più tempo e più memoria.

Archivio: https://gea.esac.esa.int/archive/ (servizio TAP, linguaggio ADQL).
Licenza dei dati: ESA/Gaia/DPAC, CC BY-SA 3.0 IGO. Cita: Gaia Collaboration,
Vallenari et al. 2023, A&A 674, A1.
"""

from __future__ import annotations

import argparse
import gzip
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))
from atlante.sources.gaia import chunk_range, n_pixels, query, run_async  # noqa: E402

OUT = ROOT / "data" / "sources" / "gaia"
USER_AGENT = "AtlanteCeleste/0.2 (simulatore astronomico personale; scripts/gaia_scarica.py)"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--gmax", type=float, default=12.0, help="magnitudine G massima (predefinito 12)")
    ap.add_argument("--livello", type=int, default=2, help="livello HEALPix delle zone (2 = 192 zone)")
    ap.add_argument("--prova", action="store_true", help="prova veloce: 2 zone e solo stelle G < 8")
    ap.add_argument("--uscita", type=Path, default=OUT, help="cartella dei file scaricati")
    a = ap.parse_args()

    gmax = 8.0 if a.prova else a.gmax
    pixels = list(range(n_pixels(a.livello)))
    if a.prova:
        pixels = pixels[:2]
    out = a.uscita / ("prova" if a.prova else f"G{gmax:g}")
    out.mkdir(parents=True, exist_ok=True)
    print(f"Gaia DR3, stelle con G < {gmax:g} e distanza affidabile: {len(pixels)} zone -> {out}")

    headers = {"User-Agent": USER_AGENT}
    done = 0
    total_rows = 0
    with httpx.Client(headers=headers, timeout=httpx.Timeout(120.0, connect=30.0)) as client:
        for p in pixels:
            dest = out / f"zona_{a.livello}_{p:05d}.csv.gz"
            if dest.exists() and dest.stat().st_size > 0:
                done += 1
                continue
            lo, hi = chunk_range(p, a.livello)
            for attempt in range(4):
                try:
                    data = run_async(client, query(gmax, lo, hi))
                    break
                except Exception as exc:  # rete, archivio occupato, ...
                    if attempt == 3:
                        print(f"  zona {p}: non riuscita ({exc}). Rilancia lo script più tardi per riprendere.")
                        sys.exit(1)
                    wait = 15 * (attempt + 1)
                    print(f"  zona {p}: errore ({exc}), nuovo tentativo fra {wait} s")
                    time.sleep(wait)
            rows = max(0, data.count(b"\n") - 1)
            total_rows += rows
            tmp = dest.with_suffix(".tmp")
            tmp.write_bytes(gzip.compress(data))
            tmp.replace(dest)
            done += 1
            print(f"  zona {p + 1:>4}/{len(pixels)}: {rows:>8} stelle   (totale in questa sessione: {total_rows})")
    print(f"Fatto: {done} zone. Ora genera i tasselli:")
    print(f"  uv run --project backend --group dev python scripts/build_star_tiles.py --gaia \"{out}\"")


if __name__ == "__main__":
    main()
