# Scatti di prova di Atlante Celeste in Chrome headless (server avviato su 127.0.0.1:8765).
# Uso: python3 scatti.py <file_scenari.json> <cartella_uscita> [url]
# Esempi di scenari in questa cartella: andromeda.json (Via Lattea da lontano), nubi.json (Nubi di Magellano
# da 9 punti attorno alla Galassia, camera puntata sulle Nubi), ammassi.json (Pleiadi e Iadi da varie direzioni).
# In ogni scenario 'js' prepara la scena, 'dopo' (facoltativo) raccoglie dati dopo 'attesa' ms; P.proj(punto)
# dà la posizione attesa sullo schermo. Attenzione: le Nubi sono vicine al polo sud dell'eclittica, quindi
# per puntarci la camera serve cam.up = (1,0,0) (con (0,1,0) lookAt dà un orientamento a caso).
# Ogni scenario: {"nome": ..., "js": "<corpo di funzione async (a) => {...} che prepara la scena e può restituire dati>",
#                 "attesa": ms}
import asyncio, json, sys, pathlib
from playwright.async_api import async_playwright

PRE = r"""
window.__p = {
  a: () => window.atlante,
  by: (id) => window.atlante.universe.get(id),
  // camera in orbita attorno a un corpo: distanza (km), azimut ed elevazione (radianti, sistema della scena)
  orbit: (id, d, az, el) => { const a = window.atlante, rig = a.view.rig; rig.jumpTo(a.universe.get(id), d); rig.az = az; rig.el = el; },
  // proiezione sullo schermo (pixel CSS) di un punto della scena (km)
  proj: (p) => { const v = window.atlante.view, c = v.camera; const q = p.clone().sub(v.rig.camPos).applyMatrix4(c.matrixWorldInverse);
                 if (q.z >= 0) return null; q.applyMatrix4(c.projectionMatrix); return [ (q.x+1)/2*v.width, (1-q.y)/2*v.height ]; },
};
"""

async def main(spec_path, out_dir):
    scen = json.loads(pathlib.Path(spec_path).read_text())
    out = pathlib.Path(out_dir); out.mkdir(parents=True, exist_ok=True)
    res = {}
    async with async_playwright() as p:
        b = await p.chromium.launch(channel='chrome', args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width': 960, 'height': 640})
        logs = []
        pg.on('console', lambda m: logs.append(f'{m.type}: {m.text}') if m.type in ('error', 'warning') else None)
        pg.on('pageerror', lambda e: logs.append(f'pageerror: {e}'))
        await pg.goto(sys.argv[3] if len(sys.argv) > 3 else 'http://127.0.0.1:8765/')
        await pg.wait_for_function('window.atlante && window.atlante.view && window.atlante.view.galaxy && window.atlante.view.galaxy.ready', timeout=120000)
        await pg.wait_for_timeout(3000)
        await pg.evaluate(PRE)
        for s in scen:
            r = await pg.evaluate(f"async () => {{ const P = window.__p, a = P.a(); {s['js']} }}")
            await pg.wait_for_timeout(s.get('attesa', 4000))
            if s.get('dopo'):
                r = await pg.evaluate(f"async () => {{ const P = window.__p, a = P.a(); {s['dopo']} }}")
            await pg.screenshot(path=str(out / f"{s['nome']}.png"))
            res[s['nome']] = r
            print(s['nome'], json.dumps(r) if r is not None else '', flush=True)
        if logs:
            print('LOG:', *logs[:20], sep='\n  ')
        await b.close()
    (out / 'risultati.json').write_text(json.dumps(res, indent=1))

asyncio.run(main(sys.argv[1], sys.argv[2]))
