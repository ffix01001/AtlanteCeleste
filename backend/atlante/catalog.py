"""Catalogo dei corpi: legge i file JSON in data/catalog e le schede Markdown.

Convenzione degli identificativi (stabili e univoci, pensati per crescere):
    ssb             baricentro del Sistema Solare (radice dell'albero)
    naif:<id>       corpi con codice NAIF/SPICE (Sole 10, Terra 399, Luna 301, sonde negative...)
    sb:<pdes>       corpi minori del JPL SBDB per designazione primaria (sb:1, sb:1P, sb:C/1995 O1)
    norad:<id>      satelliti artificiali terrestri (catalogo NORAD)
    hyg:<id>        stelle del catalogo HYG (in futuro gaia:<source_id>)
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from .config import CATALOG_DIR, CATALOG_I18N_DIR, CONTENT_DIR, lang_chain

log = logging.getLogger("atlante.catalog")

REQUIRED = ("id", "name", "kind", "parent")


class Catalog:
    def __init__(self, catalog_dir: Path = CATALOG_DIR, content_dir: Path = CONTENT_DIR, i18n_dir: Path = CATALOG_I18N_DIR):
        self.catalog_dir = catalog_dir
        self.content_dir = content_dir
        self.i18n_dir = i18n_dir
        # traduzioni dei campi: lingua -> id del corpo -> campi tradotti (anche annidati)
        self.i18n: dict[str, dict[str, dict[str, Any]]] = {}
        # traduzioni di testi interi, per qualsiasi corpo (servono ai corpi costruiti dal programma,
        # come gli esopianeti): lingua -> testo italiano -> traduzione
        self.i18n_values: dict[str, dict[str, str]] = {}
        self.bodies: dict[str, dict[str, Any]] = {}
        self.order: list[str] = []
        # corpi aggiunti dal programma oltre ai file JSON (per esempio gli esopianeti scaricati)
        self.extra: list[dict[str, Any]] = []
        self.reload()

    def set_extra(self, bodies: list[dict[str, Any]]) -> None:
        """Corpi in più, costruiti dal programma: si aggiungono dopo quelli dei file (che vincono)."""
        self.extra = bodies
        self.reload()

    def reload(self) -> None:
        self.i18n = {}
        self.i18n_values = {}
        bodies: dict[str, dict[str, Any]] = {}
        order: list[str] = []
        for path in sorted(self.catalog_dir.rglob("*.json")):
            try:
                doc = json.loads(path.read_text(encoding="utf-8"))
            except json.JSONDecodeError as exc:
                log.error("JSON non valido in %s: %s", path, exc)
                continue
            for b in doc.get("bodies", []):
                missing = [k for k in REQUIRED if k not in b]
                if missing:
                    log.error("%s: corpo senza %s -> %s", path.name, missing, b.get("id"))
                    continue
                if b["id"] in bodies:
                    log.error("ID duplicato %s in %s", b["id"], path.name)
                    continue
                b.setdefault("source_file", path.relative_to(self.catalog_dir).as_posix())
                bodies[b["id"]] = b
                order.append(b["id"])
        for b in self.extra:
            if any(k not in b for k in REQUIRED) or b["id"] in bodies or b["parent"] not in bodies:
                continue
            b.setdefault("source_file", "(scaricato)")
            bodies[b["id"]] = b
            order.append(b["id"])
        # verifica dell'albero: ogni padre deve esistere
        for bid in order:
            p = bodies[bid]["parent"]
            if p is not None and p not in bodies:
                log.error("Il corpo %s ha un padre sconosciuto: %s", bid, p)
        self.bodies, self.order = bodies, order
        log.info("Catalogo caricato: %d corpi", len(order))

    def get(self, body_id: str) -> dict[str, Any] | None:
        return self.bodies.get(body_id)

    def listing(self, lang: str) -> list[dict[str, Any]]:
        out = []
        for bid in self.order:
            b = self.localized(self.bodies[bid], lang)
            b["has_content"] = self.content_path(b, lang) is not None
            out.append(b)
        return out

    def translations(self, lang: str) -> dict[str, dict[str, Any]]:
        """Traduzioni del catalogo per una lingua (data/catalog_i18n/<lingua>.json)."""
        if lang not in self.i18n:
            path = self.i18n_dir / f"{lang}.json"
            tr: dict[str, dict[str, Any]] = {}
            values: dict[str, str] = {}
            if lang != "it" and path.exists():
                try:
                    doc = json.loads(path.read_text(encoding="utf-8"))
                    tr = {k: v for k, v in doc.get("bodies", {}).items() if isinstance(v, dict)}
                    values = {k: v for k, v in doc.get("values", {}).items() if isinstance(v, str)}
                except json.JSONDecodeError as exc:
                    log.error("JSON non valido in %s: %s", path, exc)
            self.i18n[lang] = tr
            self.i18n_values[lang] = values
        return self.i18n[lang]

    def localized(self, body: dict[str, Any], lang: str) -> dict[str, Any]:
        """Copia del corpo con i campi nella lingua chiesta (se manca: inglese, poi italiano).

        "wiki_lang" dice in quale Wikipedia cercare la voce indicata da "wiki".
        Il nome italiano resta fra gli alias, così la ricerca lo trova comunque.
        """
        out = dict(body)
        if body.get("wiki"):
            out["wiki_lang"] = "it"
        full = lang_chain(lang)
        chain = full[: full.index("it")]         # l'italiano è la base: dopo non serve altro
        values: dict[str, str] = {}
        for code in reversed(chain):            # l'ultima applicata (la lingua chiesta) vince
            tr = self.translations(code).get(body["id"])
            values.update(self.i18n_values.get(code, {}))
            if not tr:
                continue
            _merge(out, tr)
            if tr.get("wiki"):
                out["wiki_lang"] = code
        if values:
            out = _replace_values(out, values)
        if out["name"] != body["name"]:
            out["aliases"] = [*body.get("aliases", []), body["name"]]
        return out

    def content_path(self, body: dict[str, Any], lang: str) -> Path | None:
        slug = body.get("content") or body.get("slug")
        if not slug:
            return None
        for code in lang_chain(lang):
            p = self.content_dir / code / f"{slug}.md"
            if p.exists():
                return p
        return None

    def content(self, body: dict[str, Any], lang: str) -> str | None:
        p = self.content_path(body, lang)
        return p.read_text(encoding="utf-8") if p else None

    def content_lang(self, body: dict[str, Any], lang: str) -> str | None:
        p = self.content_path(body, lang)
        return p.parent.name if p else None


def _replace_values(o: Any, values: dict[str, str]) -> Any:
    """Sostituisce i testi che hanno una traduzione intera (anche dentro dizionari e liste)."""
    if isinstance(o, str):
        return values.get(o, o)
    if isinstance(o, dict):
        return {k: (v if k in ("id", "parent", "slug", "content", "texture", "kind") else _replace_values(v, values)) for k, v in o.items()}
    if isinstance(o, list):
        return [_replace_values(v, values) for v in o]
    return o


def _merge(dst: dict[str, Any], src: dict[str, Any]) -> None:
    """Fonde le traduzioni nei campi del corpo: i dizionari annidati si fondono, il resto si sostituisce."""
    for k, v in src.items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            dst[k] = dict(dst[k])
            _merge(dst[k], v)
        else:
            dst[k] = v
