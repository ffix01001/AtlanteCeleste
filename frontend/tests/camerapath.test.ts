import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cruiseSpeed, flightDuration, smoother, zoomPath } from '../src/render/camerapath.ts';

const AU = 149597870.7;

function checkEnds(u1: number, w0: number, w1: number): void {
  const p = zoomPath(u1, w0, w1);
  assert.ok(Number.isFinite(p.S) && p.S >= 0, `S finito (${p.S})`);
  assert.ok(Math.abs(p.u(0)) < 1e-9);
  assert.ok(Math.abs(p.u(p.S) - 1) < 1e-12);
  assert.ok(Math.abs(p.w(0) / w0 - 1) < 1e-9);
  assert.ok(Math.abs(p.w(p.S) / w1 - 1) < 1e-9);
  // continuo e monotono in u, niente NaN lungo il percorso
  let prevU = 0;
  for (let i = 0; i <= 400; i++) {
    const s = (p.S * i) / 400;
    const u = p.u(s), w = p.w(s);
    assert.ok(Number.isFinite(u) && Number.isFinite(w) && w > 0, `valori validi a s=${s}`);
    assert.ok(u >= prevU - 1e-9, 'u non torna indietro');
    prevU = u;
  }
  // u + v = 1 lungo tutto il percorso
  for (let i = 0; i <= 50; i++) {
    const s = (p.S * i) / 50;
    assert.ok(Math.abs(p.u(s) + p.v(s) - 1) < 1e-9, `u + v = 1 a s=${s}`);
  }
  // continuità vicino agli estremi (niente scatti nell'ultimo fotogramma)
  const eps = p.S * 1e-4;
  assert.ok(Math.abs(p.u(p.S - eps) - 1) < 1e-2);
  assert.ok(Math.abs(p.w(p.S - eps) / w1 - 1) < 1e-2);
}

test('Terra → Luna', () => checkEnds(384400, 27000, 7300));
test('dal Sole (3,2 UA) a un asteroide di 1 km', () => checkEnds(2.7 * AU, 3.2 * AU, 12));
test('da un satellite ad Andromeda (rapporti enormi)', () => checkEnds(2.4e19, 2.2e4, 3e18));
test('solo zoom, stesso punto', () => {
  const p = zoomPath(0, 1e6, 1e3);
  assert.ok(Math.abs(p.w(p.S) - 1e3) < 1e-6);
  assert.equal(p.u(p.S / 2), 1);
});

test('nei salti lunghi la camera si allontana a metà strada', () => {
  const p = zoomPath(5 * AU, 30000, 30000);
  const mid = p.w(p.S / 2);
  assert.ok(mid > 1e6, `a metà la vista si allarga (${mid})`);
});

test('durata e dolcezza', () => {
  assert.ok(flightDuration(0) >= 0.9 && flightDuration(1e9) <= 4.5);
  assert.equal(smoother(0), 0);
  assert.equal(smoother(1), 1);
  assert.ok(Math.abs(smoother(0.5) - 0.5) < 1e-12);
  // velocità nulla agli estremi
  assert.ok(smoother(1e-3) < 1e-8);
});

test('velocità del volo: proporzionale alla distanza dalla superficie', () => {
  assert.equal(cruiseSpeed(1000, 1, false), 1000);
  assert.equal(cruiseSpeed(1000, 2, true), 10000);
  assert.ok(cruiseSpeed(0, 1, false) > 0);
});

test('arrivo da Andromeda: 1 − u preciso al chilometro', () => {
  const u1 = 2.4e19, w1 = 26758;
  const p = zoomPath(u1, 3e18, w1);
  // nell'ultimo istante il punto osservato dista dalla Terra meno della distanza della camera
  for (const f of [0.999, 0.9999, 0.99999]) {
    const s = p.S * f;
    const rest = p.v(s) * u1;
    assert.ok(Number.isFinite(rest) && rest >= 0);
    // il resto cala in modo regolare (niente salti di migliaia di km)
    const rest2 = p.v(s + p.S * 1e-6) * u1;
    assert.ok(rest2 <= rest, 'il resto diminuisce');
  }
  assert.ok(p.v(p.S * (1 - 1e-9)) * u1 < w1, 'alla fine il corpo è già al centro');
});
