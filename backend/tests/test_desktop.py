"""Verifica del flusso dell'applicazione desktop senza aprire finestre vere.

Si sostituisce la libreria pywebview con un finto modulo che registra le
chiamate: così si controlla che il server parta, che la finestra carichi
l'indirizzo giusto quando il server è pronto e che chiudendo si spenga tutto.
"""

from __future__ import annotations

import sys
import threading
import time
import types

from atlante import desktop


class FakeServer:
    def __init__(self) -> None:
        self.started = False
        self.should_exit = False

    def run(self) -> None:
        time.sleep(0.2)
        self.started = True
        while not self.should_exit:
            time.sleep(0.02)


class FakeWindow:
    def __init__(self) -> None:
        self.urls: list[str] = []
        self.fullscreen = 0

    def load_url(self, url: str) -> None:
        self.urls.append(url)

    def load_html(self, html: str) -> None:
        self.urls.append("html")

    def toggle_fullscreen(self) -> None:
        self.fullscreen += 1


def fake_webview(fail_start: bool = False) -> tuple[types.ModuleType, dict]:
    rec: dict = {}
    mod = types.ModuleType("webview")
    mod.settings = {"OPEN_EXTERNAL_LINKS_IN_BROWSER": False}

    def create_window(title, url=None, html=None, js_api=None, **kw):
        w = FakeWindow()
        rec.update(title=title, url=url, html=html, js_api=js_api, kw=kw, window=w)
        return w

    def start(func=None, *args, **kw):
        rec["start_kw"] = kw
        if fail_start:
            raise RuntimeError("WebView2 assente")
        t = threading.Thread(target=func)
        t.start()
        t.join(5)

    mod.create_window = create_window
    mod.start = start
    return mod, rec


def test_desktop_carica_l_interfaccia_quando_il_server_e_pronto(monkeypatch):
    mod, rec = fake_webview()
    monkeypatch.setitem(sys.modules, "webview", mod)
    server = FakeServer()
    assert desktop.run_desktop(server, "http://127.0.0.1:8765") is True
    w = rec["window"]
    assert rec["title"] == "Atlante Celeste"
    assert rec["html"] and "Atlante Celeste" in rec["html"]  # schermata di avvio
    assert w.urls == ["http://127.0.0.1:8765"]
    assert server.should_exit is True  # finestra chiusa -> server spento
    assert rec["start_kw"]["private_mode"] is False  # preferenze conservate
    assert mod.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] is True
    # l'API per lo schermo intero è collegata alla finestra
    rec["js_api"].toggle_fullscreen()
    assert w.fullscreen == 1


def test_desktop_ripiega_sul_browser_se_la_finestra_non_parte(monkeypatch):
    mod, rec = fake_webview(fail_start=True)
    monkeypatch.setitem(sys.modules, "webview", mod)
    opened: list[str] = []
    monkeypatch.setattr(desktop.webbrowser, "open", lambda url: opened.append(url))
    server = FakeServer()

    def stop_later():
        time.sleep(0.6)
        server.should_exit = True

    threading.Thread(target=stop_later).start()
    assert desktop.run_desktop(server, "http://127.0.0.1:8765") is True
    assert opened == ["http://127.0.0.1:8765"]


def test_senza_pywebview_restituisce_false(monkeypatch):
    monkeypatch.setitem(sys.modules, "webview", None)  # import fallisce
    assert desktop.run_desktop(FakeServer(), "http://x") is False
