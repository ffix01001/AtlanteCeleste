"""Prepara il catalogo stellare per la grafica 3D.

Ingresso:  catalogo HYG v4.1 (CSV, licenza CC BY-SA 4.0, github.com/astronexus/HYG-Database)
Uscita:    data/generated/stars_hyg.atbl       posizioni 3D (parsec, ICRS) + magnitudini + colore
           data/generated/stars_hyg_meta.json  nomi, tipo spettrale, costellazione, ...

Uso:  uv run --project backend python scripts/build_stars.py percorso/hygdata_v41.csv

Le stelle senza parallasse affidabile (dist >= 100000 nel catalogo) vengono
tenute solo se visibili a occhio nudo, posizionate a 500 pc e segnalate.
In futuro lo stesso formato ospiterà i "tasselli" del catalogo Gaia.
"""

from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))
from atlante import binpack  # noqa: E402

OUT_BIN = ROOT / "data" / "generated" / "stars_hyg.atbl"
OUT_META = ROOT / "data" / "generated" / "stars_hyg_meta.json"
NAMES_IT = json.loads((ROOT / "data" / "reference" / "stelle_nomi_it.json").read_text(encoding="utf-8"))

FALLBACK_DIST_PC = 500.0


def f(v: str, default: float | None = None) -> float | None:
    try:
        return float(v) if v != "" else default
    except ValueError:
        return default


def main(csv_path: str) -> None:
    xs, ys, zs, absm, mags, cis, flags = [], [], [], [], [], [], []
    meta_rows = []
    with open(csv_path, newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            if row["id"] == "0":  # il Sole: lo disegniamo a parte
                continue
            mag = f(row["mag"])
            dist = f(row["dist"])
            if mag is None or dist is None or dist <= 0:
                continue
            uncertain = dist >= 100000
            if uncertain:
                if mag > 6.5:
                    continue
                dist = FALLBACK_DIST_PC
            ra = f(row["rarad"])
            dec = f(row["decrad"])
            if ra is None or dec is None:
                continue
            x = dist * np.cos(dec) * np.cos(ra)
            y = dist * np.cos(dec) * np.sin(ra)
            z = dist * np.sin(dec)
            am = mag - 5 * np.log10(dist / 10.0)
            xs.append(x); ys.append(y); zs.append(z)
            absm.append(am); mags.append(mag)
            cis.append(f(row["ci"], 0.65))
            flags.append(1 if uncertain else 0)
            proper = row["proper"].strip()
            meta_rows.append([
                int(row["id"]),
                int(row["hip"]) if row["hip"] else None,
                int(row["hd"]) if row["hd"] else None,
                int(row["hr"]) if row["hr"] else None,
                row["gl"].strip() or None,
                proper or None,
                NAMES_IT.get(proper) if proper else None,
                row["bayer"].strip() or None,
                row["flam"].strip() or None,
                row["con"].strip() or None,
                row["spect"].strip() or None,
                round(dist, 4),
                mag,
                round(float(am), 3),
                f(row["lum"]),
                row["var"].strip() or None,
                bool(uncertain),
            ])

    order = np.argsort(np.asarray(mags))  # le più luminose per prime: utile per LOD e selezione
    cols = {
        "x": np.asarray(xs, dtype=np.float32)[order],
        "y": np.asarray(ys, dtype=np.float32)[order],
        "z": np.asarray(zs, dtype=np.float32)[order],
        "absmag": np.asarray(absm, dtype=np.float32)[order],
        "mag": np.asarray(mags, dtype=np.float32)[order],
        "ci": np.asarray(cis, dtype=np.float32)[order],
        "flags": np.asarray(flags, dtype=np.uint8)[order],
    }
    meta_rows = [meta_rows[i] for i in order]
    meta = {
        "catalog": "HYG v4.1",
        "license": "CC BY-SA 4.0 — David Nash, The HYG Database (astronexus)",
        "frame": "ICRS equatoriale, origine nel Sole, unità parsec",
        "count": len(meta_rows),
        "names": {str(i): (r[6] or r[5]) for i, r in enumerate(meta_rows) if r[5]},
    }
    OUT_BIN.parent.mkdir(parents=True, exist_ok=True)
    OUT_BIN.write_bytes(binpack.pack(meta, cols))
    fields = ["hyg_id", "hip", "hd", "hr", "gliese", "proper", "name_it", "bayer", "flamsteed", "con",
              "spect", "dist_pc", "mag", "absmag", "lum", "var", "dist_uncertain"]
    OUT_META.write_text(json.dumps({"fields": fields, "rows": meta_rows}, ensure_ascii=False, separators=(",", ":")),
                        encoding="utf-8")
    print(f"Stelle: {len(meta_rows)}  ->  {OUT_BIN} ({OUT_BIN.stat().st_size/1e6:.1f} MB), "
          f"{OUT_META} ({OUT_META.stat().st_size/1e6:.1f} MB)")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else str(ROOT / "data" / "sources" / "hygdata_v41.csv"))
