import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kerrCamera, kerrLut, traceRay, traceView } from '../src/core/kerrgeo.ts';
import { escapeAngle, shadowRadius } from '../src/core/blackhole.ts';
import { photonOrbit } from '../src/core/kerr.ts';

// parametro d'impatto critico nel piano equatoriale: ξ dell'orbita circolare dei fotoni
function critical(a: number, prograde: boolean): number {
  const r = photonOrbit(a, prograde);
  return Math.abs(-(r ** 3 - 3 * r * r + a * a * r + a * a) / (a * (r - 1)));
}
const D = 2000;

test('senza rotazione: deviazione di campo debole e cattura sotto √27', () => {
  const b = 100;
  const r = traceRay(0, [-D, b, 0], [1, 0, 0], D);
  assert.equal(r.fate, 'escaped');
  const dev = Math.atan2(-r.dir[1], r.dir[0]);
  const expect = 4 / b + (15 * Math.PI) / (4 * b * b); // in unità di M
  assert.ok(Math.abs(dev - expect) < 3e-3, `deviazione ${dev} invece di ${expect}`);
  assert.equal(traceRay(0, [-D, Math.sqrt(27) * 1.03, 0], [1, 0, 0], D).fate, 'escaped');
  assert.equal(traceRay(0, [-D, Math.sqrt(27) * 0.97, 0], [1, 0, 0], D).fate, 'captured');
});

test('a* = 0,9: il lato che gira con il buco nero passa molto più vicino', () => {
  const a = 0.9;
  const bp = critical(a, true), br = critical(a, false);
  assert.ok(bp < 3.3 && br > 6.5, `critici ${bp}, ${br}`);
  // un raggio a y = −b che va verso +x ha momento angolare +b attorno a z: progrado
  assert.equal(traceRay(a, [-D, -bp * 1.04, 0], [1, 0, 0], D).fate, 'escaped');
  assert.equal(traceRay(a, [-D, -bp * 0.96, 0], [1, 0, 0], D).fate, 'captured');
  assert.equal(traceRay(a, [-D, br * 1.04, 0], [1, 0, 0], D).fate, 'escaped');
  assert.equal(traceRay(a, [-D, br * 0.96, 0], [1, 0, 0], D).fate, 'captured');
  // fuori dal piano equatoriale: nessuna singolarità ai poli
  assert.equal(traceRay(a, [0.01, 0, D], [0, 0, -1], D).fate, 'captured');
  assert.equal(traceRay(a, [8, 0, D], [0, 0, -1], D).fate, 'escaped');
});

test('camera ferma senza rotazione: stessa ombra e stessa deviazione del calcolo di Schwarzschild', () => {
  for (const rRs of [1.6, 5, 22]) {
    const cam = kerrCamera(0, 2 * rRs * 0.6, 2 * rRs * 0.8);   // distanza in M = 2·rs
    const alpha = shadowRadius(rRs);
    assert.equal(traceView(cam, alpha * 0.985, 1.0, 800).fate, 'captured', `r=${rRs} dentro`);
    assert.equal(traceView(cam, alpha * 1.015, 1.0, 800).fate, 'escaped', `r=${rRs} fuori`);
    // un raggio a 2,5 volte il raggio dell'ombra: angolo finale attorno al buco nero come in escapeAngle
    const th = Math.min(alpha * 2.5, 2.8);
    const t = traceView(cam, th, 2.0, 3000);
    const want = escapeAngle(1 / rRs, Math.PI - th)!;
    const e1 = [-cam.c[0], -cam.c[1], -cam.c[2]];
    const got = t.dir[0] * e1[0] + t.dir[1] * e1[1] + t.dir[2] * e1[2];
    assert.ok(Math.abs(got - Math.cos(want)) < 4e-3, `r=${rRs}: cos ${got} invece di ${Math.cos(want)}`);
  }
});

test('tabella 2D: con la rotazione l\'ombra non è più rotonda né centrata', () => {
  const flat = kerrLut(0, 44, 0, 1.2, 8, 6);
  const spin = kerrLut(0.9, 44, 0, 1.2, 8, 6);
  const edges = (l: typeof flat) => Array.from({ length: l.nChi }, (_, j) => l.data[j * l.nT * 4 + 3]);
  const e0 = edges(flat), e1 = edges(spin);
  assert.ok(Math.max(...e0) - Math.min(...e0) < 2e-4);
  assert.ok(Math.abs(e0[0] - shadowRadius(22)) < 2e-4);
  // camera sull'equatore: χ = 90° e 270° sono i due lati (progrado e retrogrado)
  assert.ok(Math.abs(e1[2] - e1[6]) > 0.03, `lati ${e1[2]} e ${e1[6]}`);
  // e sopra e sotto l'ombra resta simmetrica
  assert.ok(Math.abs(e1[0] - e1[4]) < 2e-4);
});
