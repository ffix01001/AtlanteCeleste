import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { conicState, propagateUniversal } from '../src/ephem/kepler.ts';

const MU = 1.32712440018e11; // Sole, km^3/s^2

function check(e: number, q: number, days: number) {
  const c = { q, e, i: 0.3, om: 1.1, w: 2.2, tp: 2451545.0 };
  const muDay = MU * 86400 * 86400;
  const r0 = new Vector3(), v0 = new Vector3(), r1 = new Vector3(), v1 = new Vector3();
  conicState(c, 2451545.0 + 10, muDay, r0, v0);
  v0.multiplyScalar(1 / 86400);
  conicState(c, 2451545.0 + 10 + days, muDay, r1, v1);
  v1.multiplyScalar(1 / 86400);
  const rp = new Vector3(), vp = new Vector3();
  assert.ok(propagateUniversal(r0, v0, MU, days * 86400, rp, vp));
  const err = rp.distanceTo(r1) / r1.length();
  const verr = vp.distanceTo(v1) / v1.length();
  assert.ok(err < 1e-8, `posizione: errore relativo ${err} (e=${e}, ${days} giorni)`);
  assert.ok(verr < 1e-8, `velocità: errore relativo ${verr}`);
}

test('propagazione universale: ellisse, avanti e indietro, anche per molti giri', () => {
  check(0.0167, 1.471e8, 30);
  check(0.0167, 1.471e8, -30);
  check(0.2056, 4.6e7, 365 * 3);
  check(0.9, 1e8, 2000);
});

test('propagazione universale: iperbole e quasi-parabola', () => {
  check(1.5, 1.5e8, 200);
  check(1.5, 1.5e8, -200);
  check(3.0, 2e8, 50);
  check(3.7, 1.3e9, 20000);
});

test('propagazione universale: orbite quasi paraboliche su tempi lunghi (comete)', () => {
  for (const e of [0.9999, 0.99999, 1.00001, 1.0001, 1.002]) {
    for (const days of [10, 400, 4000, -4000]) check(e, 5e7, days);
  }
});

test('equazione di Keplero delle stelle S: converge anche vicino all\'apocentro', async () => {
  const { keplerE } = await import('../src/ephem/skyorbit.ts');
  for (const e of [0.0, 0.3, 0.8839, 0.9761, 0.995]) {
    for (let i = 0; i <= 2000; i++) {
      const M = -Math.PI + (i / 2000) * (2 * Math.PI - 1e-12);
      const E = keplerE(M, e);
      assert.ok(Math.abs(E - e * Math.sin(E) - M) < 1e-9, `e=${e} M=${M}`);
    }
  }
});
