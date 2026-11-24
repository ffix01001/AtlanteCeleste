"""Wikipedia: riassunto della voce (usato per i corpi senza scheda curata).

Wikimedia chiede ai programmi un User-Agent descrittivo, con un recapito
(https://meta.wikimedia.org/wiki/User-Agent_policy): senza recapito alcune
richieste vengono rifiutate con "403 Forbidden". Il recapito si imposta con la
variabile d'ambiente ATLANTE_CONTACT (un indirizzo email o una pagina web).

Se il server viene comunque rifiutato, il browser scarica il riassunto da sé
(le API di Wikipedia accettano le richieste dei browser) e lo consegna al
server, che lo conserva in cache: vedi /api/wiki/cache in main.py.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

import httpx

from ..http import Http


async def summary(http: Http, title: str, lang: str = "it") -> dict[str, Any]:
    """Riassunto della voce: prima l'API REST, poi l'API "action" (più stabile)."""
    last: Exception | None = None
    try:
        return await _rest_summary(http, title, lang)
    except httpx.HTTPStatusError as exc:
        last = exc
    try:
        return await _action_summary(http, title, lang)
    except Exception as exc:  # noqa: BLE001 - si riporta l'errore più utile
        raise last or exc


async def _rest_summary(http: Http, title: str, lang: str) -> dict[str, Any]:
    url = f"https://{lang}.wikipedia.org/api/rest_v1/page/summary/{quote(title.replace(' ', '_'), safe='')}"
    r = await http.get(url, retries=0)
    js = r.json()
    if js.get("type") == "disambiguation":
        raise LookupError(f"«{title}» è una pagina di disambiguazione")
    return {
        "title": js.get("title"),
        "extract": js.get("extract"),
        "thumbnail": (js.get("thumbnail") or {}).get("source"),
        "url": ((js.get("content_urls") or {}).get("desktop") or {}).get("page"),
        "lang": lang,
    }


async def _action_summary(http: Http, title: str, lang: str) -> dict[str, Any]:
    params = {
        "action": "query",
        "format": "json",
        "formatversion": "2",
        "redirects": "1",
        "prop": "extracts|pageimages|info|pageprops",
        "exintro": "1",
        "explaintext": "1",
        "inprop": "url",
        "pithumbsize": "400",
        "titles": title,
    }
    r = await http.get(f"https://{lang}.wikipedia.org/w/api.php", params, retries=0)
    return parse_action(r.json(), title, lang)


def parse_action(js: dict[str, Any], title: str, lang: str) -> dict[str, Any]:
    pages = (js.get("query") or {}).get("pages") or []
    if not pages or pages[0].get("missing") or "extract" not in pages[0]:
        raise LookupError(f"Nessuna voce «{title}» su Wikipedia ({lang})")
    p = pages[0]
    if "disambiguation" in (p.get("pageprops") or {}):
        raise LookupError(f"«{title}» è una pagina di disambiguazione")
    return {
        "title": p.get("title"),
        "extract": p.get("extract"),
        "thumbnail": (p.get("thumbnail") or {}).get("source"),
        "url": p.get("fullurl"),
        "lang": lang,
    }
