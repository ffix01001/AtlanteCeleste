"""Raccoglie i testi delle licenze delle librerie usate dal programma in LICENZE_TERZE_PARTI.txt.

Le licenze MIT, BSD e OFL chiedono che il loro testo accompagni ogni copia del software:
il programma compilato (frontend/dist) contiene il codice di three.js, Astronomy Engine,
satellite.js, marked e i caratteri Bodoni Moda e IBM Plex Sans; il server usa FastAPI,
Uvicorn, httpx, NumPy e le loro dipendenze.

Uso (dalla cartella del progetto, dopo `npm install` e `uv sync`):
    cd backend && uv run python ../scripts/genera_licenze.py
"""

from __future__ import annotations

import importlib.metadata as md
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "LICENZE_TERZE_PARTI.txt"
NODE = ROOT / "frontend" / "node_modules"
LICENSE_NAMES = ("LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "LICENSE-MIT", "OFL.txt", "COPYING")


def find_license(folder: Path) -> str | None:
    for name in LICENSE_NAMES:
        p = folder / name
        if p.exists():
            return p.read_text(encoding="utf-8", errors="replace").strip()
    return None


def license_in_header(js: Path) -> str | None:
    """Alcuni pacchetti (Astronomy Engine) hanno la licenza solo nel commento iniziale del codice."""
    if not js.exists():
        return None
    head = js.read_text(encoding="utf-8", errors="replace")[:4000]
    start = head.find("MIT License")
    if start < 0:
        return None
    end = head.find("*/", start)
    return head[start:end].strip() if end > 0 else None


def node_packages() -> list[tuple[str, str, str, str]]:
    pkg = json.loads((ROOT / "frontend" / "package.json").read_text(encoding="utf-8"))
    out = []
    for name in sorted(pkg.get("dependencies", {})):
        folder = NODE / name
        meta = json.loads((folder / "package.json").read_text(encoding="utf-8"))
        text = find_license(folder) or license_in_header(folder / (meta.get("main") or "index.js")) \
            or f"(testo della licenza non trovato: {meta.get('license')})"
        out.append((name, meta.get("version", "?"), meta.get("license", "?"), text))
    return out


def python_packages() -> list[tuple[str, str, str, str]]:
    # le librerie che il server usa davvero mentre il programma gira (non quelle per i test)
    wanted = ["fastapi", "starlette", "pydantic", "pydantic_core", "uvicorn", "httpx", "httpcore", "h11", "anyio",
              "idna", "certifi", "sniffio", "click", "numpy", "annotated-types", "typing_extensions", "pywebview"]
    out = []
    for name in wanted:
        try:
            dist = md.distribution(name)
        except md.PackageNotFoundError:
            continue
        lic = dist.metadata.get("License-Expression") or dist.metadata.get("License") or "?"
        lic = lic.splitlines()[0][:80]
        text = None
        for f in dist.files or []:
            if any(f.name.upper().startswith(n.split(".")[0]) for n in ("LICENSE", "LICENCE", "COPYING")):
                p = Path(f.locate())
                if p.exists():
                    text = p.read_text(encoding="utf-8", errors="replace").strip()
                    break
        out.append((dist.metadata["Name"], dist.version, lic, text or f"(testo non trovato; licenza: {lic})"))
    return out


def main() -> None:
    parts = [
        "LICENZE DEL SOFTWARE DI TERZE PARTI USATO DA ATLANTE CELESTE",
        "=" * 62,
        "",
        "Atlante Celeste è © Giovanni Frasca, software libero con licenza GNU GPL 3.0 o successiva (vedi LICENSE).",
        "Il programma contiene o usa le librerie seguenti, ognuna con la propria licenza, riportata qui",
        "per intero come quelle licenze richiedono. Crediti dei dati e delle immagini: CREDITI.md.",
        "",
    ]
    for title, items in (("Interfaccia (frontend/dist)", node_packages()), ("Server (backend)", python_packages())):
        parts += ["", title, "-" * len(title), ""]
        for name, ver, lic, text in items:
            parts += [f"### {name} {ver} — {lic}", "", text, "", ""]
    OUT.write_text("\n".join(parts), encoding="utf-8")
    print(f"Scritto {OUT} ({OUT.stat().st_size // 1024} kB)")


if __name__ == "__main__":
    main()
