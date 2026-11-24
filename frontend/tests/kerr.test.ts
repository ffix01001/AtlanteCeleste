import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ergosphere, frameDragOmega, horizon, isco, keplerOmega, photonOrbit, shadowEdge, zamoClockRate } from '../src/core/kerr.ts';

const near = (x: number, y: number, tol = 1e-9) => assert.ok(Math.abs(x - y) < tol, `${x} invece di ${y}`);

test('senza rotazione tornano i valori di Schwarzschild', () => {
  near(horizon(0), 2);
  near(isco(0), 6); near(isco(0, false), 6);
  near(photonOrbit(0), 3); near(photonOrbit(0, false), 3);
  near(frameDragOmega(0, 10, 1), 0);
  near(zamoClockRate(0, 4, 1.1), Math.sqrt(0.5));
  for (const [x, y] of shadowEdge(0, 1)) near(Math.hypot(x, y), Math.sqrt(27));
});

test('rotazione massima: orbite prograde sull\'orizzonte, retrograde lontane', () => {
  near(horizon(1), 1);
  near(isco(1), 1, 1e-6); near(isco(1, false), 9, 1e-9);
  near(photonOrbit(1), 1, 1e-9); near(photonOrbit(1, false), 4, 1e-9);
  near(ergosphere(1, Math.PI / 2), 2); near(ergosphere(0.9, 0), horizon(0.9));
});

test('a* = 0,9: valori noti', () => {
  near(isco(0.9), 2.3209, 1e-3);
  near(isco(0.9, false), 8.7174, 1e-3);
  near(horizon(0.9), 1.43589, 1e-4);
  assert.ok(keplerOmega(0.9, 4) > 0 && keplerOmega(0.9, 4, false) < 0);
  assert.ok(zamoClockRate(0.9, horizon(0.9) + 1e-9, 1) < 1e-3);
});

test('ombra vista dall\'equatore: a forma di D, spostata dal lato retrogrado', () => {
  const pts = shadowEdge(0.998, Math.PI / 2, 400);
  const xs = pts.map((p) => p[0]);
  const lo = Math.min(...xs), hi = Math.max(...xs);
  // per a → 1: da −2M (lato piatto) a +7M
  assert.ok(Math.abs(hi - 7) < 0.05, `massimo ${hi}`);
  assert.ok(Math.abs(lo + 2) < 0.15, `minimo ${lo}`);
  // dal polo resta un cerchio
  const pole = shadowEdge(0.9, 1e-4, 64).map((p) => Math.hypot(p[0], p[1]));
  assert.ok(Math.max(...pole) - Math.min(...pole) < 0.02);
});
