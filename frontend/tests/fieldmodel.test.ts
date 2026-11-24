import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlanetField, bodyFixed, dipoleStrength } from '../src/render/fieldmodel.ts';

const earth = () => new PlanetField({ axis: [0, 0, 1], sign: -1, center: [0, 0, 0], sun: [1, 0, 0], rmp: 10 });

function extent(pts: number[], i: number, f: (a: number, b: number) => number, start: number): number {
  let v = start;
  for (let k = i; k < pts.length; k += 3) v = f(v, pts[k]);
  return v;
}

test('Terra: linee chiuse e aperte, lato giorno schiacciato, coda dalla parte opposta al Sole', () => {
  const t0 = performance.now();
  const lines = earth().lines(8);
  const ms = performance.now() - t0;
  const closed = lines.filter((l) => l.closed), open = lines.filter((l) => !l.closed);
  assert.ok(closed.length >= 20, `linee chiuse: ${closed.length}`);
  assert.ok(open.length >= 12, `linee aperte: ${open.length}`);
  // nessuna linea va oltre la magnetopausa verso il Sole
  for (const l of lines) assert.ok(extent(l.pts, 0, Math.max, -1e9) <= 10.05, 'oltre la magnetopausa');
  // le linee aperte finiscono lontano nella coda
  const tailEnds = open.filter((l) => l.pts[l.pts.length - 3] < -20).length;
  assert.equal(tailEnds, open.length, `aperte nella coda: ${tailEnds} di ${open.length}`);
  // una linea chiusa a mezzanotte arriva più lontano di quella a mezzogiorno con lo stesso guscio
  assert.ok(ms < 400, `tempo di calcolo ${ms.toFixed(0)} ms`);
});

test('dipolo spostato e inclinato (Nettuno): il calcolo resta stabile', () => {
  const axis = bodyFixed(43.1, 0);
  const f = new PlanetField({ axis, sign: 1, center: [0.17, 0.46, -0.24], sun: [0, 0, 1], rmp: 26 });
  const lines = f.lines(8);
  assert.ok(lines.length > 30);
  for (const l of lines) for (const v of l.pts) assert.ok(Number.isFinite(v));
});

test('dipolo puntato verso il Sole (Urano al solstizio): niente NaN', () => {
  const f = new PlanetField({ axis: [1, 0, 0], sign: 1, center: [0, 0, -0.31], sun: [1, 0, 0], rmp: 18 });
  for (const l of f.lines(6)) for (const v of l.pts) assert.ok(Number.isFinite(v));
});

test('Sole: archi chiusi alle basse latitudini, linee aperte e dritte oltre la superficie sorgente', async () => {
  const { StarField } = await import('../src/render/fieldmodel.ts');
  const f = new StarField([0, 0, 1], 2.5);
  const lines = f.lines(6);
  const closed = lines.filter((l) => l.closed), open = lines.filter((l) => !l.closed);
  assert.ok(closed.length >= 18 && open.length >= 36, `chiuse ${closed.length}, aperte ${open.length}`);
  let pts = 0;
  for (const l of lines) {
    pts += l.pts.length / 3 + 1;
    const n = l.pts.length;
    const rEnd = Math.hypot(l.pts[n - 3], l.pts[n - 2], l.pts[n - 1]);
    let rMax = 0;
    for (let k = 0; k < n; k += 3) rMax = Math.max(rMax, Math.hypot(l.pts[k], l.pts[k + 1], l.pts[k + 2]));
    if (l.closed) {
      assert.ok(Math.abs(rEnd - 1) < 1e-6 && rMax < 2.5, `arco fino a ${rMax}`);
      // un arco torna nell'emisfero opposto
      assert.ok(l.pts[2] * l.pts[n - 1] < 0);
    } else {
      assert.ok(Math.abs(rEnd - 7.5) < 1e-6);
      // l'ultimo tratto è radiale
      const a = [l.pts[n - 9], l.pts[n - 8], l.pts[n - 7]], b = [l.pts[n - 3], l.pts[n - 2], l.pts[n - 1]];
      const cos = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b));
      assert.ok(cos > 1 - 1e-9);
    }
  }
  // il campo è senza divergenza (controllo numerico in un punto qualsiasi)
  const p = [1.3, 0.4, 0.9], h = 1e-4;
  let div = 0;
  for (let i = 0; i < 3; i++) {
    const a = [...p], b = [...p];
    a[i] += h; b[i] -= h;
    div += (f.field(a as [number, number, number])[i] - f.field(b as [number, number, number])[i]) / (2 * h);
  }
  assert.ok(Math.abs(div) < 1e-5, `divergenza ${div}`);
  assert.ok(pts < 4000, `punti: ${pts}`);
});

test('intensità del dipolo: doppia ai poli, cala come 1/r³, dipolo spostato', () => {
  const z: [number, number, number] = [0, 0, 1];
  const o: [number, number, number] = [0, 0, 0];
  assert.ok(Math.abs(dipoleStrength(29_400, z, o, [1, 0, 0]) - 29_400) < 1e-6);   // equatore
  assert.ok(Math.abs(dipoleStrength(29_400, z, o, [0, 0, 1]) - 58_800) < 1e-6);   // polo
  assert.ok(Math.abs(dipoleStrength(29_400, z, o, [0, 0, -2]) - 58_800 / 8) < 1e-6);
  // dipolo spostato verso nord (Mercurio): al polo nord il campo è più forte che al polo sud
  const c: [number, number, number] = [0, 0, 0.2];
  assert.ok(dipoleStrength(195, z, c, [0, 0, 1]) > dipoleStrength(195, z, c, [0, 0, -1]));
  assert.equal(dipoleStrength(195, z, c, c), Infinity);
});
