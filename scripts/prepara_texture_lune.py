"""Prepara le texture di lune, pianeti nani e asteroidi.

Fonte: le mappe del progetto open source Celestia (https://github.com/CelestiaProject/CelestiaContent),
costruite dalla comunità a partire dalle immagini delle sonde (Voyager, Galileo, Cassini, New Horizons,
Dawn, NEAR, Hayabusa, OSIRIS-REx, Rosetta, Juno...). Sono mappe globali in proiezione cilindrica
semplice con il meridiano zero al centro, la stessa convenzione delle texture dei pianeti, e le zone
mai fotografate sono già riempite in modo plausibile.

Ogni mappa ha la sua licenza (quasi tutte Creative Commons). Lo script le legge dai file `.license`
del repository e le scrive in `data/assets/textures/manifest.json`, insieme agli autori: il programma
le mostra nella scheda di ogni corpo.

Cosa fa lo script:
  1. scarica le mappe da una versione fissa del repository (così il risultato è sempre lo stesso);
  2. le riduce a 2048×1024 (1024×512 per i corpi più piccoli) e le salva in JPEG nel progetto;
  3. calcola un "guadagno" per i corpi molto scuri (Fobos, Bennu, Ryugu... riflettono il 4-9% della
     luce): il programma li schiarisce come farebbe una fotografia con un'esposizione più lunga,
     altrimenti apparirebbero quasi neri;
  4. segna le mappe in bianco e nero (molte sonde fotografavano con un solo filtro): il programma
     le tinge con il colore medio del corpo scritto nel catalogo (Amaltea, per esempio, è rossa).
Le versioni a 4096×2048 non vengono salvate nel progetto: se nelle impostazioni si attivano le
texture ad alta risoluzione, il server le scarica al primo uso.

Uso:  uv run --project backend --group dev python scripts/prepara_texture_lune.py
"""

from __future__ import annotations

import io
import json
import sys
from pathlib import Path

import httpx
import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "assets" / "textures"
REPO = "CelestiaProject/CelestiaContent"
COMMIT = "e6d05411f1ab8aecbd8d72173711ae37f228deaf"  # versione del 2026 usata per il progetto
RAW = f"https://raw.githubusercontent.com/{REPO}/{COMMIT}/"
USER_AGENT = "AtlanteCeleste/0.2 (simulatore astronomico personale; scripts/prepara_texture_lune.py)"

# luminosità media minima (sRGB 0-1) sotto la quale una mappa viene schiarita nel programma
TARGET_SRGB = 0.30
MAX_GAIN = 3.5

# nome della texture -> (percorso nel repository, lato lungo in pixel nel progetto)
SOURCES: dict[str, tuple[str, int]] = {
    # Marte
    "phobos": ("textures/hires/phobos.jpg", 1024),
    "deimos": ("textures/hires/deimos.jpg", 1024),
    # Giove
    "amalthea": ("textures/lores/amalthea.jpg", 1024),
    "io": ("textures/hires/io.png", 2048),
    "europa": ("textures/hires/europa.jpg", 2048),
    "ganymede": ("textures/hires/ganymede.jpg", 2048),
    "callisto": ("textures/hires/callisto.jpg", 2048),
    # Saturno
    "mimas": ("textures/hires/mimas.jpg", 2048),
    "enceladus": ("textures/hires/enceladus.jpg", 2048),
    "tethys": ("textures/hires/tethys.jpg", 2048),
    "dione": ("textures/hires/dione.jpg", 2048),
    "rhea": ("textures/hires/rhea.jpg", 2048),
    "titan_haze": ("textures/hires/titan-clouds.jpg", 2048),  # la foschia arancione: così appare da fuori
    "titan": ("textures/hires/titan.png", 2048),              # la superficie sotto la foschia
    "hyperion": ("textures/medres/hyperion.jpg", 2048),
    "iapetus": ("textures/hires/iapetus.jpg", 2048),
    "phoebe": ("textures/hires/phoebe.jpg", 1024),
    # Urano
    "miranda": ("textures/hires/miranda.jpg", 2048),
    "ariel": ("textures/hires/ariel.jpg", 2048),
    "umbriel": ("textures/medres/umbriel.jpg", 2048),
    "titania": ("textures/medres/titania.jpg", 2048),
    "oberon": ("textures/medres/oberon.jpg", 2048),
    # Nettuno (la mappa di Solar System Scope esiste solo a 2k e quasi senza dettagli).
    # Urano, Plutone e Caronte NON vengono da qui: in Celestia hanno licenza CC BY-NC-SA (solo uso
    # non commerciale), incompatibile con un progetto libero. Usano mappe di Solar System Scope e NASA,
    # preparate da scripts/prepara_texture_libere.py.
    "neptune": ("textures/hires/neptune.jpg", 4096),
    # Nettuno
    "triton": ("textures/hires/triton.jpg", 2048),
    "proteus": ("textures/lores/proteus.jpg", 1024),
    # Plutone
    "nix": ("textures/medres/nix.jpg", 1024),
    "hydra": ("textures/lores/hydra.jpg", 1024),
    # asteroidi e pianeti nani
    "ceres": ("textures/hires/ceres.jpg", 2048),
    "vesta": ("textures/hires/vesta.jpg", 2048),
    "lutetia": ("textures/medres/lutetia.jpg", 1024),
    "ida": ("textures/medres/ida.jpg", 1024),
    "eros": ("textures/hires/eros.jpg", 1024),
    "itokawa": ("textures/hires/itokawa.jpg", 1024),
    "ryugu": ("textures/hires/ryugu.jpg", 1024),
    "bennu": ("textures/hires/bennu.jpg", 1024),
    "arrokoth": ("textures/hires/arrokoth.jpg", 1024),
}

# Mappe senza un file .license nel repository: autori dal file README di Celestia.
# Il pacchetto nel suo insieme è distribuito con licenza GPL-2.0-or-later.
CREDITS_README: dict[str, list[str]] = {
    "europa": ["John van Vliet"],
    "callisto": ["Askaniy Anpilogov, da una mappa di John van Vliet"],
    "phoebe": ["da una mappa di John van Vliet"],
    "mimas": ["Paul Schenk (mappe a colori migliorati, NASA Photojournal)"],
    "enceladus": ["Paul Schenk (mappe a colori migliorati, NASA Photojournal)"],
    "tethys": ["Paul Schenk (mappe a colori migliorati, NASA Photojournal)"],
    "dione": ["Paul Schenk (mappe a colori migliorati, NASA Photojournal)"],
    "rhea": ["Paul Schenk (NASA Photojournal)", "Björn Jónsson (mappa di albedo)"],
    "iapetus": ["Paul Schenk (mappe a colori migliorati, NASA Photojournal)"],
    "ceres": ["NASA/JPL-Caltech/UCLA/MPS/DLR/IDA (sonda Dawn)", "SevenSpheres (zone mancanti)"],
    "vesta": ["NASA/JPL-Caltech/UCLA/MPS/DLR/IDA (sonda Dawn)", "USGS (topografia)"],
    "proteus": ["Astra-Planetshine"],
}

LICENSE_URLS = {
    "CC0-1.0": "https://creativecommons.org/publicdomain/zero/1.0/deed.it",
    "CC-BY-3.0": "https://creativecommons.org/licenses/by/3.0/deed.it",
    "CC-BY-4.0": "https://creativecommons.org/licenses/by/4.0/deed.it",
    "CC-BY-SA-4.0": "https://creativecommons.org/licenses/by-sa/4.0/deed.it",
    "GPL-2.0-or-later": "https://www.gnu.org/licenses/old-licenses/gpl-2.0.html",
}


def parse_license(text: str) -> tuple[list[str], str | None]:
    authors, lic = [], None
    for line in text.splitlines():
        if line.startswith("SPDX-FileCopyrightText:"):
            authors.append(line.split(":", 1)[1].strip())
        elif line.startswith("SPDX-License-Identifier:"):
            lic = line.split(":", 1)[1].strip()
    return authors, lic


def srgb_to_linear(a: np.ndarray) -> np.ndarray:
    return np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)


def mean_linear(img: Image.Image) -> float:
    """Luminosità media della superficie (pesata per l'area: i poli occupano poco spazio sulla sfera)."""
    small = np.asarray(img.convert("RGB").resize((256, 128), Image.Resampling.BOX), dtype=np.float64) / 255
    lin = srgb_to_linear(small).mean(axis=2)
    lat = (np.arange(128) + 0.5) / 128 * np.pi - np.pi / 2
    w = np.cos(lat)[:, None] * np.ones((1, 256))
    return float((lin * w).sum() / w.sum())


def main() -> None:
    only = set(sys.argv[1:])
    OUT.mkdir(parents=True, exist_ok=True)
    manifest_path = OUT / "manifest.json"
    old = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}
    textures: dict[str, dict] = dict(old.get("textures", {}))
    target_lin = float(srgb_to_linear(np.array(TARGET_SRGB)))

    with httpx.Client(timeout=120, follow_redirects=True, headers={"User-Agent": USER_AGENT}) as client:
        for name, (path, side) in SOURCES.items():
            if only and name not in only:
                continue
            r = client.get(RAW + path)
            if r.status_code != 200:
                print(f"{name:12s} non disponibile ({r.status_code})", file=sys.stderr)
                continue
            img = Image.open(io.BytesIO(r.content))
            img.load()
            src_size = img.size
            # niente trasparenza: la mappa di Io ha un canale alfa usato da Celestia per i riflessi
            rgb = img.convert("RGB")
            w = min(side, rgb.width)
            out = rgb.resize((w, w // 2), Image.Resampling.LANCZOS) if rgb.width != w else rgb
            dest = OUT / f"{name}.jpg"
            out.save(dest, quality=90, optimize=True, progressive=True)

            lic_r = client.get(RAW + path + ".license")
            if lic_r.status_code == 200:
                authors, lic = parse_license(lic_r.text)
            else:
                authors, lic = CREDITS_README.get(name, []), "GPL-2.0-or-later"
            m = mean_linear(out)
            gain = min(MAX_GAIN, max(1.0, target_lin / max(m, 1e-4)))
            entry = {
                "file": dest.name,
                "size": [out.width, out.height],
                "gain": round(gain, 2),
                # mappa in bianco e nero: il programma la tinge con il colore medio del corpo
                "grigia": img.mode in ("L", "LA", "I", "I;16"),
                "fonte": "Celestia",
                "url": f"https://github.com/{REPO}/blob/{COMMIT}/{path}",
                "autori": authors,
                "licenza": lic,
                "licenza_url": LICENSE_URLS.get(lic or ""),
            }
            if src_size[0] > out.width:
                entry["hi_url"] = RAW + path  # versione grande, scaricata al primo uso se richiesta
                entry["hi_size"] = list(src_size)
            textures[name] = entry
            kb = dest.stat().st_size / 1024
            print(f"{name:12s} {src_size[0]}x{src_size[1]} -> {out.width}x{out.height}  {kb:6.0f} kB  "
                  f"guadagno {gain:4.2f}  {lic}")

    manifest = {
        "_descrizione": "Texture incluse nel progetto. Generato da scripts/prepara_texture_lune.py: non modificare a mano.",
        "fonte": {"nome": "Celestia", "repository": f"https://github.com/{REPO}", "commit": COMMIT},
        "textures": dict(sorted(textures.items())),
    }
    tmp = manifest_path.with_suffix(".tmp")
    tmp.write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    tmp.replace(manifest_path)
    print(f"Scritto {manifest_path.relative_to(ROOT)} ({len(textures)} texture)")


if __name__ == "__main__":
    main()
