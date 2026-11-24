"""Prepara le fotografie di nebulose, ammassi e galassie.

Fonte: le immagini del cielo profondo distribuite con il planetario open source Stellarium
(https://github.com/Stellarium/stellarium, cartella nebulae/default), con i crediti dei singoli
astrofotografi e osservatori (ESO, NOIRLab...) scritti in textures.json. Ogni immagine ha già la
sua posizione esatta in cielo: per ogni angolo, ascensione retta e declinazione.

Lo script:
  1. scarica le immagini da una versione fissa del repository;
  2. le riproietta su un piano tangente al cielo centrato sull'oggetto, con il nord in alto
     e l'est a sinistra (come in una foto al telescopio), unendo i tasselli quando l'oggetto è
     diviso in più immagini (la Grande Nube di Magellano ne ha 16);
  3. salva un JPEG per oggetto in data/assets/dso/ e scrive manifest.json con centro,
     larghezza in gradi e crediti.

Nel programma la foto viene appoggiata nello spazio alla distanza dell'oggetto, con la stessa
larghezza angolare: vista dalla Terra coincide con il cielo vero.

Uso:  uv run --project backend --group dev python scripts/prepara_texture_cielo_profondo.py
"""

from __future__ import annotations

import io
import json
import math
import sys
from pathlib import Path

import httpx
import numpy as np
from PIL import Image, ImageChops, ImageFilter
from scipy import ndimage as ndi

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "assets" / "dso"
COMMIT = "bd2754eaa41457d78fb34945962c18e4725d0a3f"
RAW = f"https://raw.githubusercontent.com/Stellarium/stellarium/{COMMIT}/nebulae/default/"
USER_AGENT = "AtlanteCeleste/0.2 (simulatore astronomico personale; scripts/prepara_texture_cielo_profondo.py)"

# nome nel progetto -> immagini di Stellarium, centro (RA, Dec in gradi), lato lungo del risultato
OBJECTS: dict[str, dict] = {
    "m42": {"tiles": ["m42.png"], "center": (83.82208, -5.39111), "px": 1024},
    "m45": {"tiles": ["pleiades.png"], "center": (56.75, 24.1167), "px": 1024},
    "m16": {"tiles": ["m16.png"], "center": (274.7, -13.807), "px": 1024},
    "ngc3372": {"tiles": ["etaCarinae.png"], "center": (161.265, -59.8667), "px": 1024},
    "ngc5139": {"tiles": ["n5139.png"], "center": (201.697, -47.4795), "px": 512},
    "m31": {"tiles": ["m31.png"], "center": (10.6847, 41.269), "px": 1024},
    "lmc": {"tiles": [f"lmc_{i:02d}.png" for i in range(1, 17)], "center": (80.894, -69.756), "px": 2048},
    "smc": {"tiles": [f"smc29-{i}.png" for i in range(1, 5)], "center": (13.1867, -72.8286), "px": 1536},
    "m8": {"tiles": ["m8.png"], "center": (270.9042, -24.3867), "px": 1024},
    "m20": {"tiles": ["m20.png"], "center": (270.675, -22.97), "px": 512},
    "m13": {"tiles": ["m13.png"], "center": (250.4218, 36.4598), "px": 512},
    "m22": {"tiles": ["m22.png"], "center": (279.0997, -23.9048), "px": 512},
}

# la tela ha 1,5 pixel per ogni pixel delle foto originali (interpolazione bicubica: più morbida da vicino)
OVERSAMPLE = 1.5
MAX_PX = 2048

# livello del fondo cielo da togliere (le foto hanno un fondo appena grigio: nello spazio sarebbe un riquadro visibile)
BLACK = 6

# Trattamento di ogni foto, perché nello spazio non si veda il riquadro della foto:
#   kind     "nebula"/"galaxy"/"reflection": si tolgono le stelle puntiformi (quelle vere le disegna il
#            programma, e il campo di stelle della foto formava una macchia rettangolare);
#            "globular": le stelle sono l'oggetto, restano;
#   star_px  dimensione tipica delle stelle nella foto (pixel)
#   bg       quanta parte del fondo cielo togliere (0-1)
#   floor    quanto resta della nebulosità debole lontano dal corpo dell'oggetto (0-1)
TREAT: dict[str, dict] = {
    "m42": {"kind": "nebula", "star_px": 3.0, "bg": 0.55, "floor": 0.7},
    "m45": {"kind": "reflection", "star_px": 4.0, "bg": 0.9, "floor": 0.45},
    "m16": {"kind": "nebula", "star_px": 2.5, "bg": 0.7, "floor": 0.6},
    "ngc3372": {"kind": "nebula", "star_px": 2.5, "bg": 0.5, "floor": 0.75},
    "ngc5139": {"kind": "globular", "star_px": 2.0, "bg": 0.9, "floor": 0.3},
    "m31": {"kind": "galaxy", "star_px": 2.5, "bg": 0.85, "floor": 0.45},
    "lmc": {"kind": "globular", "star_px": 2.0, "bg": 0.6, "floor": 0.55},
    "smc": {"kind": "globular", "star_px": 2.0, "bg": 0.6, "floor": 0.55},
    "m8": {"kind": "nebula", "star_px": 3.0, "bg": 0.7, "floor": 0.6},
    "m20": {"kind": "nebula", "star_px": 2.0, "bg": 0.7, "floor": 0.6},
    "m13": {"kind": "globular", "star_px": 2.0, "bg": 0.9, "floor": 0.3},
    "m22": {"kind": "globular", "star_px": 2.0, "bg": 0.9, "floor": 0.3},
}


def lum(a):
    return 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]

def deband(a, strength=1.0):
    """Toglie i gradini delle immagini a 256 colori: sfocatura leggera solo dove l'immagine è liscia."""
    b = np.stack([ndi.gaussian_filter(a[..., c], 1.2) for c in range(3)], -1)
    L = lum(a)
    gx = ndi.sobel(ndi.gaussian_filter(L, 1.0), 0); gy = ndi.sobel(ndi.gaussian_filter(L, 1.0), 1)
    g = np.hypot(gx, gy)
    w = np.clip(1.0 - g / (np.percentile(g, 90) + 1e-6), 0, 1)[..., None] * strength
    return a * (1 - w) + b * w

def background(a, scale):
    """Fondo cielo: minimo locale su grande scala, poi sfocato (si toglie ciò che varia lentamente)."""
    s = max(8, int(scale))
    small = a[::4, ::4]
    mins = np.stack([ndi.minimum_filter(small[..., c], size=max(3, s // 4)) for c in range(3)], -1)
    bg = np.stack([ndi.gaussian_filter(mins[..., c], max(2, s // 8)) for c in range(3)], -1)
    bg = np.repeat(np.repeat(bg, 4, 0), 4, 1)[: a.shape[0], : a.shape[1]]
    return bg

def remove_stars(a, star_px, k=4.0, max_area_px=None):
    """Toglie le stelle puntiformi (le stelle vere le disegna il programma): residui piccoli e compatti
    rispetto alla mediana locale vengono sostituiti dalla mediana stessa."""
    L = lum(a)
    size = int(star_px * 2) | 1
    med = ndi.median_filter(L, size=size)
    R = L - med
    mad = np.median(np.abs(R - np.median(R))) * 1.4826 + 1e-6
    cand = R > max(k * mad, 3.0)
    lab, n = ndi.label(cand)
    if n == 0:
        return a, np.zeros_like(L, bool)
    areas = ndi.sum(np.ones_like(L), lab, index=np.arange(1, n + 1))
    max_area = max_area_px if max_area_px else (star_px * 1.6) ** 2 * 3.2
    keep = np.zeros(n + 1, bool)
    keep[1:] = areas <= max_area
    mask = keep[lab]
    mask = ndi.binary_dilation(mask, iterations=max(1, int(round(star_px * 0.35))))
    medc = np.stack([ndi.median_filter(a[..., c], size=size + 2) for c in range(3)], -1)
    # bordo morbido della sostituzione
    soft = ndi.gaussian_filter(mask.astype(np.float32), 1.0)[..., None]
    out = a * (1 - soft) + medc * soft
    return out, mask

def footprint(a, feather_frac=0.06):
    """Dove la foto ha dati (le zone nere fuori dall'inquadratura originale no): bordo sfumato."""
    L = lum(a)
    fp = L > 1.5
    fp = ndi.binary_closing(fp, iterations=3)
    fp = ndi.binary_fill_holes(fp)
    d = ndi.distance_transform_edt(fp)
    f = max(4.0, feather_frac * min(a.shape[:2]))
    t = np.clip(d / f, 0, 1)
    return t * t * (3 - 2 * t)

def shape_alpha(a, blur_px, lo_q=0.55, hi_q=0.92, border=0.07, floor=0.18):
    """Maschera che segue la forma dell'oggetto: luminanza molto sfocata, soglie sui quantili,
    e in più un bordo che va a zero (così il rettangolo della foto non si vede mai)."""
    L = lum(a)
    B = ndi.gaussian_filter(L, blur_px)
    pos = B[B > 0.5]
    lo = np.quantile(pos, lo_q) if pos.size else 1
    hi = max(np.quantile(pos, hi_q) if pos.size else 2, lo + 1)
    t = np.clip((B - lo) / (hi - lo), 0, 1)
    m = t * t * (3 - 2 * t)
    h, w = L.shape
    yy, xx = np.mgrid[0:h, 0:w]
    dx = np.minimum(xx, w - 1 - xx) / (border * w)
    dy = np.minimum(yy, h - 1 - yy) / (border * h)
    e = np.clip(np.minimum(dx, dy), 0, 1)
    e = e * e * (3 - 2 * e)
    # anche dove la maschera è bassa resta un po' di nebulosità debole
    return np.clip(floor + (1 - floor) * m, 0, 1) * e

def process(img, kind, star_px, bg_frac=0.9, floor=0.18, stars=True, k=4.0, palette=False):
    a = np.asarray(img.convert('RGB'), np.float32)
    h, w = a.shape[:2]
    fp = footprint(a)
    if palette or kind != 'globular':
        a = deband(a, 0.9 if palette else 0.4)
    bg = background(a, scale=min(h, w) / 6)
    a = np.clip(a - bg * bg_frac, 0, 255)
    mask = None
    if stars and kind in ('nebula', 'galaxy', 'reflection'):
        a, mask = remove_stars(a, star_px, k=k)
    al = shape_alpha(a, blur_px=min(h, w) / 30 if kind != 'globular' else min(h, w) / 18, floor=floor) * fp
    out = a * al[..., None]
    return out, al, mask



def tangent(ra: float, dec: float, ra0: float, dec0: float) -> tuple[float, float]:
    """Proiezione gnomonica: (xi verso est, eta verso nord) in gradi sul piano tangente al centro."""
    a, d, a0, d0 = map(math.radians, (ra, dec, ra0, dec0))
    cosc = math.sin(d0) * math.sin(d) + math.cos(d0) * math.cos(d) * math.cos(a - a0)
    xi = math.cos(d) * math.sin(a - a0) / cosc
    eta = (math.cos(d0) * math.sin(d) - math.sin(d0) * math.cos(d) * math.cos(a - a0)) / cosc
    return math.degrees(xi), math.degrees(eta)


def perspective_coeffs(dst: list[tuple[float, float]], src: list[tuple[float, float]]) -> list[float]:
    """Coefficienti per Image.transform(PERSPECTIVE): punto di arrivo -> punto di partenza."""
    rows, rhs = [], []
    for (x, y), (u, v) in zip(dst, src):
        rows.append([x, y, 1, 0, 0, 0, -u * x, -u * y]); rhs.append(u)
        rows.append([0, 0, 0, x, y, 1, -v * x, -v * y]); rhs.append(v)
    return list(np.linalg.solve(np.array(rows, float), np.array(rhs, float)))


def main() -> None:
    only = set(sys.argv[1:])
    OUT.mkdir(parents=True, exist_ok=True)
    with httpx.Client(timeout=120, follow_redirects=True, headers={"User-Agent": USER_AGENT}) as client:
        r = client.get(RAW + "textures.json")
        r.raise_for_status()
        meta = json.loads(r.text, strict=False)  # il file contiene qualche carattere di controllo
        by_name = {t["imageUrl"]: t for t in meta["subTiles"]}
        manifest_path = OUT / "manifest.json"
        old = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}
        items: dict[str, dict] = dict(old.get("objects", {}))

        for name, spec in OBJECTS.items():
            if only and name not in only:
                continue
            ra0, dec0 = spec["center"]
            tiles = []
            palette = False
            for fn in spec["tiles"]:
                t = by_name[fn]
                raw = Image.open(io.BytesIO(client.get(RAW + fn).content))
                palette = palette or raw.mode == "P"  # immagini a 256 colori: vanno tolti i gradini
                img = raw.convert("RGB")
                corners = [tangent(ra, dec, ra0, dec0) for ra, dec in t["worldCoords"][0]]
                tiles.append((img, corners, t))
            # estensione complessiva sul piano tangente (est = xi positivo, a sinistra nella foto):
            # la tela abbraccia esattamente i tasselli (prima era centrata sull'oggetto e per M42
            # sprecava due terzi dei pixel); lo scostamento del centro va nel manifest
            xs = [c[0] for _, cs, _ in tiles for c in cs]
            ys = [c[1] for _, cs, _ in tiles for c in cs]
            x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
            # risoluzione nativa: gradi per pixel del tassello più fine, poi un po' di sovracampionamento
            native = min(
                math.dist(cs[0], cs[1]) / img.size[0] for img, cs, _ in tiles
            )
            scale = native / OVERSAMPLE
            if max(x1 - x0, y1 - y0) / scale > MAX_PX:
                scale = max(x1 - x0, y1 - y0) / MAX_PX
            W = int(round((x1 - x0) / scale))
            H = int(round((y1 - y0) / scale))
            xc, yc = (x0 + x1) / 2, (y0 + y1) / 2
            canvas = Image.new("RGB", (W, H))
            for img, cs, _ in tiles:
                w, h = img.size
                # angoli della texture in Stellarium: (0,0) in basso a sinistra, poi in senso antiorario
                src = [(0, h), (w, h), (w, 0), (0, 0)]
                dst = [((x1 - xi) / scale, (y1 - eta) / scale) for xi, eta in cs]
                coeffs = perspective_coeffs(dst, src)
                warped = img.transform((W, H), Image.Transform.PERSPECTIVE, coeffs, Image.Resampling.BICUBIC)
                canvas = ImageChops.lighter(canvas, warped)
            a = np.asarray(canvas, dtype=np.float32)
            a = np.clip((a - BLACK) * (255.0 / (255 - BLACK)), 0, 255)
            tr = TREAT.get(name, {"kind": "nebula", "star_px": 2.5, "bg": 0.8, "floor": 0.5})
            a, _alpha, _stars = process(Image.fromarray(a.astype(np.uint8)), tr["kind"], tr["star_px"], bg_frac=tr["bg"],
                                        floor=tr["floor"], palette=palette)
            # luminosità uniforme fra le foto: le parti più brillanti (99,5° percentile) arrivano
            # a circa 235 (alcune foto, come quella della Piccola Nube, sono molto scure)
            lum = a.mean(axis=2)
            hi = float(np.percentile(lum[lum > 8], 99.5)) if (lum > 8).any() else 255.0
            gain = min(2.5, max(1.0, 235.0 / max(hi, 1.0)))
            a = np.clip(a * gain, 0, 255)
            out = Image.fromarray(a.astype(np.uint8)).filter(ImageFilter.UnsharpMask(radius=1.4, percent=35, threshold=3))
            dest = OUT / f"{name}.jpg"
            out.save(dest, quality=90, optimize=True, progressive=True)
            credits = []
            for _, _, t in tiles:
                c = t.get("imageCredits") or {}
                who = c.get("short") or c.get("Short")
                if who and who not in [x["autore"] for x in credits]:
                    credits.append({"autore": who, "url": c.get("infoUrl")})
            items[name] = {
                "file": dest.name,
                "size": [out.size[0], out.size[1]],
                "center": [ra0, dec0],
                "width_deg": round(W * scale, 5),
                "height_deg": round(H * scale, 5),
                # centro della foto rispetto all'oggetto, sul piano del cielo (gradi verso est e verso nord)
                "offset_deg": [round(xc, 5), round(yc, 5)],
                "crediti": credits,
                "fonte": "Stellarium",
                "url": f"https://github.com/Stellarium/stellarium/tree/{COMMIT}/nebulae/default",
            }
            print(f"{name:8s} {len(tiles):2d} immagini -> {W}x{H}, {W * scale:.2f}° x {H * scale:.2f}°  guadagno {gain:.2f}  "
                  f"{dest.stat().st_size / 1024:.0f} kB  {', '.join(c['autore'] for c in credits)}")

    manifest = {
        "_descrizione": "Foto del cielo profondo. Generato da scripts/prepara_texture_cielo_profondo.py: non modificare a mano.",
        "fonte": {"nome": "Stellarium", "repository": "https://github.com/Stellarium/stellarium", "commit": COMMIT,
                  "licenza": "distribuite con Stellarium (GPL-2.0-or-later); diritti dei singoli autori indicati nei crediti"},
        "objects": dict(sorted(items.items())),
    }
    tmp = manifest_path.with_suffix(".tmp")
    tmp.write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    tmp.replace(manifest_path)


if __name__ == "__main__":
    main()
