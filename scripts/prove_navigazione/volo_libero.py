# Prova il volo libero fotogramma per fotogramma (server avviato, poi: python3 volo_libero.py).
import asyncio, json
from playwright.async_api import async_playwright
JS = r"""
() => {
  const a = window.atlante, rig = a.view.rig, U = a.universe, cam = rig.camera;
  const realNow = performance.now.bind(performance);
  let fake = realNow(); performance.now = () => fake;
  const by = (n) => [...U.bodies.values()].find(b => b.name === n);
  const fwd = () => { const v = cam.getWorldDirection(new cam.position.constructor()); return v; };
  const res = {};
  let maxTurn = 0, prevF = null, prevPos = null, maxJump = 0;
  const step = (track = true) => {
    fake += 1000/60; U.update(a.clock.jd, 1); rig.update(1/60);
    const f = cam.getWorldDirection(cam.position.clone());
    if (track && prevF) maxTurn = Math.max(maxTurn, f.angleTo(prevF));
    if (track && prevPos) maxJump = Math.max(maxJump, rig.camPos.distanceTo(prevPos) / Math.max(1, rig.gapKm));
    prevF = f.clone(); prevPos = rig.camPos.clone();
  };
  const key = (code, down) => rig.key(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key: code.replace('Key','').toLowerCase() }), down);
  try {
    const earth = U.earth, moon = by('Luna');
    rig.jumpTo(earth); for (let i = 0; i < 60; i++) step(false);
    // 1) passaggio al volo libero: nessun salto
    maxTurn = 0; maxJump = 0; prevF = null; prevPos = null; step();
    rig.startFree(); for (let i = 0; i < 30; i++) step();
    res.ingresso = { gira_max_gradi: +(maxTurn * 57.3).toFixed(4), salto_max: +maxJump.toFixed(4) };
    // 2) avanti per 6 s verso la Terra, poi Shift per altri 10 s: niente urto
    const d0 = rig.camPos.distanceTo(earth.scenePos);
    key('KeyW', true); for (let i = 0; i < 360; i++) step(); 
    const d1 = rig.camPos.distanceTo(earth.scenePos), v1 = rig.speedKmS;
    key('ShiftLeft', true); let dmin = 1e99; for (let i = 0; i < 600; i++) { step(); dmin = Math.min(dmin, rig.camPos.distanceTo(earth.scenePos)); }
    key('ShiftLeft', false); key('KeyW', false); for (let i = 0; i < 60; i++) step();
    res.avanti = { da_km: Math.round(d0), dopo6s_km: Math.round(d1), vel_kms: +v1.toFixed(1), minimo_dal_centro_km: +dmin.toFixed(2), raggio_terra: earth.radius, ancora: rig.target.name };
    // 3) verso la Luna: si parte dal lato della Luna, a 30.000 km dalla Terra
    const em = moon.scenePos.clone().sub(earth.scenePos).normalize();
    rig.jumpTo(earth, 30000); rig.az = Math.atan2(em.z, em.x); rig.el = Math.asin(em.y);
    for (let i = 0; i < 10; i++) step(false);
    const dir = moon.scenePos.clone().sub(rig.camPos).normalize();
    cam.up.set(0,1,0); cam.lookAt(dir); cam.updateMatrixWorld();
    rig.startFree();
    key('KeyW', true); let anc = [];
    for (let i = 0; i < 60*25; i++) { step(); if (rig.target.name !== (anc.at(-1)||{}).n) anc.push({n: rig.target.name, s: +(i/60).toFixed(1), km_luna: Math.round(rig.camPos.distanceTo(moon.scenePos))}); }
    key('KeyW', false); for (let i = 0; i < 60; i++) step();
    res.verso_luna = { ancore: anc, dist_centro_luna_km: Math.round(rig.camPos.distanceTo(moon.scenePos)), raggio_luna: moon.radius };
    // 4) tempo accelerato: la camera segue la sua ancora e non resta indietro
    const A = rig.target;
    const off0 = rig.camPos.clone().sub(A.scenePos);
    const jd0 = a.clock.jd;
    for (let i = 0; i < 60; i++) { fake += 16.7; U.update(jd0 + i * 0.01, 1); rig.update(1/60); }
    const off1 = rig.camPos.clone().sub(A.scenePos);
    res.segue_ancora = { ancora: A.name, scarto_km: +off1.distanceTo(off0).toFixed(3), spostamento_ancora_km: 'circa ' + Math.round(0.6*86400*1.0) };
    U.update(jd0, 1);
    // 5) dal volo libero a un corpo (Saturno): primo fotogramma identico, poi morbido
    for (let i = 0; i < 5; i++) step(false);
    maxTurn = 0; maxJump = 0;
    const sat = by('Saturno');
    a.flyTo(sat); step();
    const firstTurn = maxTurn;
    let n = 0; while (rig.flying && n < 2000) { step(); n++; }
    res.verso_saturno = { primo_fotogramma_gradi: +(firstTurn*57.3).toFixed(3), gira_max_gradi: +(maxTurn*57.3).toFixed(3), modo: rig.mode, secondi: +(n/60).toFixed(2) };
    // 6) uscita dal volo libero dopo essersi girati di 115°: la vista ruota con calma
    rig.startFree(); for (let i = 0; i < 5; i++) step(false);
    rig.freeQuat.multiply(new rig.freeQuat.constructor().setFromAxisAngle(new cam.up.constructor(0,1,0), 2.0));
    for (let i = 0; i < 5; i++) step(false);
    maxTurn = 0; prevF = null;
    step(false); rig.startOrbit(sat); let turns = [];
    for (let k = 0; k < 70; k++) { const f0 = cam.getWorldDirection(cam.position.clone()); step(false); turns.push(cam.getWorldDirection(cam.position.clone()).angleTo(f0) * 57.3); }
    res.uscita = { gira_max_gradi_per_fotogramma: +Math.max(...turns).toFixed(2), primo: +turns[0].toFixed(3), totale: +turns.reduce((x,y)=>x+y,0).toFixed(1), modo: rig.mode };
    // 7) velocità: rotella e +/−
    rig.startFree(); const m0 = rig.speedMul;
    rig.key(new KeyboardEvent('keydown', {key:'+', code:'Equal'}), true); rig.key(new KeyboardEvent('keydown', {key:'+', code:'Equal'}), true);
    res.piu = { prima: m0, dopo: rig.speedMul };
    rig.key(new KeyboardEvent('keydown', {key:'-', code:'Slash'}), true); rig.key(new KeyboardEvent('keydown', {key:'-', code:'Slash'}), true);
    rig.startOrbit(rig.target);
  } finally { performance.now = realNow; }
  return res;
}
"""
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel='chrome', args=['--use-angle=swiftshader','--enable-unsafe-swiftshader'])
        pg = await b.new_page(viewport={'width':900,'height':600})
        errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto('http://127.0.0.1:8765/'); await pg.wait_for_timeout(8000)
        r = await pg.evaluate(JS)
        for k,v in r.items(): print(k, v, flush=True)
        print(errs)
        await b.close()
asyncio.run(main())
