"""Prepara le texture libere di Urano, Plutone e Caronte.

In Celestia queste tre mappe hanno licenza CC BY-NC-SA (solo uso non commerciale), incompatibile con
un progetto libero: Atlante Celeste usa invece mappe che si possono ridistribuire senza limiti.

  - Urano: Solar System Scope (INOVE), 2k_uranus.jpg, licenza CC BY 4.0
    https://www.solarsystemscope.com/textures/download/2k_uranus.jpg
  - Plutone: NASA/JHUAPL/SwRI, mappa globale a colori di New Horizons (PIA11707)
    https://images-assets.nasa.gov/image/PIA11707/PIA11707~large.jpg
  - Caronte: NASA/JHUAPL/SwRI, mosaico globale di New Horizons (PIA21860, figura 1, in bianco e nero)
    https://assets.science.nasa.gov/content/dam/science/psd/photojournal/pia/pia21/pia21860/figures/PIA21860_fig1_full.jpg

Cosa fa lo script, dopo aver scaricato a mano i tre file in una cartella:
  1. Plutone: la mappa NASA ha 180° di longitudine al centro; la sposta di mezzo giro, così il
     meridiano zero è al centro come in tutte le altre texture;
  2. Plutone e Caronte: New Horizons ha visto solo un emisfero. Le zone mai fotografate (nere, vicino
     al polo sud) si riempiono con il colore medio della superficie, sfumato verso il bordo;
  3. Caronte: la mappa è in bianco e nero; si aggiunge, in modo indicativo, il colore rossastro della
     calotta polare nord (Mordor Macula), visto nelle immagini a colori di New Horizons;
  4. scrive i file in data/assets/textures e aggiorna manifest.json.

Uso:  uv run --project backend --group dev python scripts/prepara_texture_libere.py CARTELLA
      (la cartella deve contenere 2k_uranus.jpg, PIA11707~large.jpg e PIA21860_fig1_full.jpg)
"""

from __future__ import annotations

import json
import sys
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

Image.MAX_IMAGE_PIXELS = None

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "assets" / "textures"

NASA_CREDIT = "NASA/Johns Hopkins University Applied Physics Laboratory/Southwest Research Institute"
ENTRIES = {
    "uranus": {
        "fonte": "Solar System Scope",
        "url": "https://www.solarsystemscope.com/textures/",
        "autori": ["Solar System Scope (INOVE), su dati NASA"],
        "licenza": "CC-BY-4.0",
        "licenza_url": "https://creativecommons.org/licenses/by/4.0/deed.it",
        "grigia": False,
    },
    "pluto": {
        "fonte": "NASA",
        "url": "https://science.nasa.gov/image-detail/amf-pia11707/",
        "autori": [f"{NASA_CREDIT} (PIA11707)", "zone mai fotografate riempite da Atlante Celeste"],
        "licenza": "NASA",
        "licenza_url": "https://www.nasa.gov/nasa-brand-center/images-and-media/",
        "grigia": False,
    },
    "charon": {
        "fonte": "NASA",
        "url": "https://science.nasa.gov/photojournal/charons-surface-in-detail/",
        "autori": [f"{NASA_CREDIT} (PIA21860)",
                   "zone mai fotografate e colore della calotta nord aggiunti da Atlante Celeste"],
        "licenza": "NASA",
        "licenza_url": "https://www.nasa.gov/nasa-brand-center/images-and-media/",
        "grigia": False,
    },
}


def south_mask(a: np.ndarray, thr: int = 12) -> np.ndarray:
    """Zone nere collegate al bordo sud: le parti mai fotografate (non le ombre dentro la mappa)."""
    h, w, _ = a.shape
    miss = a.sum(axis=2) < thr * 3
    lab = np.zeros_like(miss)
    q: deque[tuple[int, int]] = deque()
    for x in range(w):
        if miss[h - 1, x]:
            lab[h - 1, x] = True
            q.append((h - 1, x))
    while q:
        y, x = q.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            yy, xx = y + dy, (x + dx) % w
            if 0 <= yy < h and miss[yy, xx] and not lab[yy, xx]:
                lab[yy, xx] = True
                q.append((yy, xx))
    return lab


def fill_unseen(img: Image.Image, grow: float = 0.008, feather: float = 0.03) -> Image.Image:
    a = np.asarray(img.convert("RGB"), dtype=np.float32)
    h = a.shape[0]
    miss = south_mask(a)
    # il bordo della zona fotografata è spesso scuro o sbavato: si allarga un poco la zona da riempire
    g = int(grow * h)
    grown = Image.fromarray((miss * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(2 * g + 1))
    miss = np.asarray(grown) > 127
    color = a[~miss].reshape(-1, 3).mean(axis=0)
    alpha = np.asarray(grown.filter(ImageFilter.GaussianBlur(int(feather * h))), dtype=np.float32)[..., None] / 255
    alpha = np.maximum(alpha, miss[..., None].astype(np.float32))
    res = a * (1 - alpha) + color * alpha
    return Image.fromarray(res.clip(0, 255).astype(np.uint8))


def save(name: str, img: Image.Image) -> None:
    dest = OUT / f"{name}.jpg"
    img.save(dest, quality=90, optimize=True, progressive=True)
    print(f"{name:8s} {img.width}x{img.height}  {dest.stat().st_size / 1024:6.0f} kB")


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    src = Path(sys.argv[1])

    save("uranus", Image.open(src / "2k_uranus.jpg").convert("RGB"))

    p = Image.open(src / "PIA11707~large.jpg").convert("RGB")
    p = Image.fromarray(np.roll(np.asarray(p), p.width // 2, axis=1))
    save("pluto", fill_unseen(p))

    c = Image.open(src / "PIA21860_fig1_full.jpg").convert("L")
    c = fill_unseen(c.resize((2048, 1024), Image.Resampling.LANCZOS).convert("RGB"))
    a = np.asarray(c, dtype=np.float32)
    lat = 90 - (np.arange(a.shape[0]) + 0.5) / a.shape[0] * 180
    t = np.clip((lat - 58) / 14, 0, 1)[:, None, None]  # calotta rossastra sopra circa 65° nord
    a = a * (1 - t) + a * np.array([1.12, 0.92, 0.78], dtype=np.float32) * t
    save("charon", Image.fromarray(a.clip(0, 255).astype(np.uint8)))

    manifest_path = OUT / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    for name, extra in ENTRIES.items():
        with Image.open(OUT / f"{name}.jpg") as im:
            size = [im.width, im.height]
        old = manifest["textures"].get(name, {})
        manifest["textures"][name] = {"file": f"{name}.jpg", "size": size, "gain": old.get("gain", 1.0), **extra}
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"Aggiornato {manifest_path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
