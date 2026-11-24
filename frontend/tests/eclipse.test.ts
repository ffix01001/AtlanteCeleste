import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { diskOverlap, sunVisibility } from '../src/core/eclipse.ts';

const AU = 149597870.7;
const sun = { scenePos: new Vector3(0, 0, 0), radius: 695700, valid: true };
const earth = { scenePos: new Vector3(AU, 0, 0), radius: 6378, valid: true };

test('area comune di due dischi', () => {
  assert.equal(diskOverlap(1, 1, 2.5), 0);
  assert.ok(Math.abs(diskOverlap(1, 2, 0.5) - Math.PI) < 1e-12); // il piccolo tutto dentro il grande
  // due dischi uguali a distanza pari al raggio: 2π/3 − √3/2
  assert.ok(Math.abs(diskOverlap(1, 1, 1) - (2 * Math.PI / 3 - Math.sqrt(3) / 2)) < 1e-12);
});

test('stazione in orbita bassa: di giorno al Sole, di notte nell\'ombra', () => {
  const r = 6378 + 420;
  const day = new Vector3(AU - r, 0, 0);    // fra la Terra e il Sole
  const night = new Vector3(AU + r, 0, 0);  // dietro la Terra
  assert.equal(sunVisibility(day, sun, [earth]), 1);
  assert.equal(sunVisibility(night, sun, [earth]), 0);
  // sopra un polo, a 90° dal Sole: la Terra non copre il Sole
  assert.equal(sunVisibility(new Vector3(AU, r, 0), sun, [earth]), 1);
});

test('al bordo dell\'ombra la luce cala con continuità (penombra)', () => {
  const r = 6378 + 420;
  // angolo (visto dal centro della Terra) a cui il Sole tocca il bordo terrestre
  const edge = Math.PI / 2 + Math.acos(6378 / r);
  let last = 1;
  const values = [];
  for (let k = -6; k <= 6; k++) {
    const a = edge + k * 0.001;
    const p = new Vector3(AU - r * Math.cos(a), r * Math.sin(a), 0);
    const v = sunVisibility(p, sun, [earth]);
    values.push(v);
    assert.ok(v <= last + 1e-9, `la luce non deve aumentare entrando nell'ombra (${values})`);
    last = v;
  }
  assert.ok(values[0] > 0.99 && values[values.length - 1] < 0.01);
  assert.ok(values.some((v) => v > 0.05 && v < 0.95), 'manca la penombra');
});
