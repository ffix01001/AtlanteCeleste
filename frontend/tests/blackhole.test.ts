import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  blueshift, circularOrbit, clockRate, escapeSpeed, flareAt, hoverAccel, nextFlare, shadowRadius, tidalAccel, HOTSPOT_R,
} from '../src/core/blackhole.ts';

const RS_KM = 12690116; // Sgr A*, 4,3 milioni di masse solari

test('raggi notevoli: sfera dei fotoni e ultima orbita stabile', () => {
  assert.equal(circularOrbit(1.5, RS_KM), null);
  const isco = circularOrbit(3, RS_KM)!;
  assert.ok(isco.stable);
  // all'ultima orbita stabile il gas va a metà della velocità della luce
  assert.ok(Math.abs(isco.speed - 0.5) < 1e-12);
  assert.ok(!circularOrbit(2.5, RS_KM)!.stable);
});

test('ombra: metà cielo alla sfera dei fotoni, 2,6 rs visti da lontano', () => {
  assert.ok(Math.abs(shadowRadius(1.5) - Math.PI / 2) < 1e-6);
  const far = 1e6;
  assert.ok(Math.abs(shadowRadius(far) * far - 1.5 * Math.sqrt(3)) < 1e-3);
  assert.ok(shadowRadius(1.1) > Math.PI / 2);
});

test('orologi, luce e fuga', () => {
  assert.ok(Math.abs(clockRate(2) - Math.SQRT1_2) < 1e-12);
  assert.ok(Math.abs(blueshift(2) - Math.SQRT2) < 1e-12);
  assert.ok(Math.abs(escapeSpeed(4) - 0.5) < 1e-12);
  assert.equal(escapeSpeed(0.5), 1);
});

test('la macchia calda gira in circa 50 minuti (GRAVITY: 45-60)', () => {
  const T = circularOrbit(HOTSPOT_R, RS_KM)!.periodFar / 60;
  assert.ok(T > 45 && T < 60, `periodo ${T} min`);
});

test('marea all\'orizzonte di Sgr A*: innocua; per restare fermi: più di centomila g', () => {
  assert.ok(tidalAccel(1, RS_KM, 2) < 0.01);
  // GM/R² / √(1 − rs/R) con GM = rs c²/2: a 2 rs circa 1,25 milioni di m/s²
  const a = hoverAccel(2, RS_KM);
  assert.ok(a > 1.1e6 && a < 1.4e6, `accelerazione ${a}`);
});

test('lampi: ripetibili, circa tre al giorno, e il prossimo arriva', () => {
  const t0 = 8.4e8;
  let active = 0, starts = 0, prev = false;
  for (let t = t0; t < t0 + 10 * 86400; t += 60) {
    const on = flareAt(t, RS_KM).amp > 0;
    if (on) active++;
    if (on && !prev) starts++;
    prev = on;
  }
  assert.ok(starts >= 20 && starts <= 40, `lampi in 10 giorni: ${starts}`);
  assert.deepEqual(flareAt(t0 + 1234, RS_KM), flareAt(t0 + 1234, RS_KM));
  const nx = nextFlare(t0)!;
  assert.ok(nx > t0 && flareAt(nx + 60, RS_KM).amp > 0);
});

test('deviazione della luce: campo debole e bordo dell\'ombra', async () => {
  const { escapeAngle, deflectionLut, shadowRadius: alphaOf } = await import('../src/core/blackhole.ts');
  // camera lontanissima, raggio con parametro d'impatto b = 50 rs: deviazione ≈ 2/b + 15π/(16 b²)
  const r0 = 1e7, b = 50;
  const psi = Math.PI - Math.asin((b * Math.sqrt(1 - 1 / r0)) / r0);
  const dev = escapeAngle(1 / r0, psi)! - psi;
  const expect = 2 / b + (15 * Math.PI) / (16 * b * b);
  assert.ok(Math.abs(dev - expect) < 2e-4, `deviazione ${dev} invece di ${expect}`);
  // appena fuori dall'ombra il raggio sfugge, appena dentro cade
  for (const r of [3, 22, 400]) {
    const a = alphaOf(r);
    assert.notEqual(escapeAngle(1 / r, Math.PI - a * 1.002), null, `r=${r} fuori`);
    assert.equal(escapeAngle(1 / r, Math.PI - a * 0.998), null, `r=${r} dentro`);
  }
  // la tabella è ordinata: più si è lontani dal bordo, meno il raggio gira
  const lut = deflectionLut(22, 512);
  for (let k = 1; k < lut.length; k++) assert.ok(lut[k] <= lut[k - 1] + 1e-6);
});
