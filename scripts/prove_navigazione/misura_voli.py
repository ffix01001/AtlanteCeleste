# Misura la morbidezza dei voli verso i corpi (server avviato, poi: python3 misura_voli.py nome_prova).
import asyncio, json, sys
from playwright.async_api import async_playwright
JS = r"""
(cases) => {
  const a = window.atlante, rig = a.view.rig, U = a.universe, cam = rig.camera;
  const realNow = performance.now.bind(performance);
  let fake = realNow();
  performance.now = () => fake;
  const byName = (n) => [...U.bodies.values()].find(b => b.name === n || b.id === n);
  const step = () => { fake += 1000/60; U.update(a.clock.jd, 1); rig.update(1/60); };
  const out = [];
  try {
  for (const c of cases) {
    const A = byName(c[0]), B = byName(c[1]), C = c[2] ? byName(c[2]) : null;
    rig.jumpTo(A); rig.az = 0.3; rig.el = 0.3;
    for (let i = 0; i < 90; i++) step();
    a.flyTo(B);
    const tanY = Math.tan(cam.fov * Math.PI / 360), tanX = tanY * cam.aspect;
    let n = 0, vis = 0, centeredAt = -1, prev = null, prevV = null, maxJerk = 0, maxSpeed = 0, maxLogJerk = 0, pl = null, pdl = null;
    let target = B, retargeted = false;
    while ((rig.flying || n < 5) && n < 2000) {
      if (C && !retargeted && n === 60) { a.flyTo(C); target = C; retargeted = true; prev = null; prevV = null; }
      step(); n++;
      const v = target.scenePos.clone().sub(rig.camPos).applyQuaternion(cam.quaternion.clone().invert());
      const x = v.x / -v.z, y = v.y / -v.z;
      const inView = v.z < 0 && Math.abs(x) < tanX && Math.abs(y) < tanY;
      if (inView) vis++;
      const dir = v.clone().normalize();
      if (prev) {
        const vel = dir.clone().sub(prev);
        maxSpeed = Math.max(maxSpeed, vel.length());
        if (prevV) maxJerk = Math.max(maxJerk, vel.clone().sub(prevV).length());
        prevV = vel;
      }
      prev = dir;
      if (centeredAt < 0 && v.z < 0 && Math.hypot(x, y) < 0.05 * tanY) centeredAt = n;
      const l = Math.log(rig.distance);
      if (pl !== null) { const dl = l - pl; if (pdl !== null) maxLogJerk = Math.max(maxLogJerk, Math.abs(dl - pdl)); pdl = dl; }
      pl = l;
    }
    out.push({ volo: c.join(' → '), fotogrammi: n, secondi: +(n/60).toFixed(2),
      visibile: +(vis / n).toFixed(3), centrato_al: +(centeredAt / n).toFixed(3),
      scatto_max_schermo: +maxJerk.toExponential(2), vel_max_schermo: +maxSpeed.toFixed(4), scatto_max_zoom: +maxLogJerk.toExponential(2),
      arrivo_km: Math.round(rig.camPos.distanceTo(target.scenePos)) });
  }
  } finally { performance.now = realNow; }
  return out;
}
"""
CASES = [["Sole","Terra"],["Terra","Luna"],["Terra","Saturno"],["Saturno","Galassia di Andromeda (M31)"],["Galassia di Andromeda (M31)","Terra"],["Marte","Fobos"],["Terra","Saturno","Giove"]]
async def main(tag):
    async with async_playwright() as p:
        b = await p.chromium.launch(channel='chrome', args=['--use-angle=swiftshader','--enable-unsafe-swiftshader'])
        pg = await b.new_page(viewport={'width':900,'height':600})
        errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto('http://127.0.0.1:8765/'); await pg.wait_for_timeout(8000)
        names = await pg.evaluate("() => [...window.atlante.universe.bodies.values()].filter(b=>/Androm|Fobos|Saturno|Giove/.test(b.name)).map(b=>b.name)")
        print(names, flush=True)
        r = await pg.evaluate(JS, CASES)
        json.dump(r, open(f'misura_{tag}.json','w'), indent=1, ensure_ascii=False)
        for x in r: print(x, flush=True)
        print(errs)
        await b.close()
asyncio.run(main(sys.argv[1]))
