// Prove della fisica delle stelle (core/stellar.ts) su stelle conosciute.
// Uso: npm test (dalla cartella frontend)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bvToTemp, parseSpectral, starNature } from '../src/core/stellar.ts';

const near = (x: number, target: number, tol: number) => Math.abs(x - target) / target <= tol;

test('il Sole', () => {
  const s = starNature(4.83, 0.65, 'G2V');
  assert.equal(s.name, 'nana gialla');
  assert.ok(near(s.temperatureK, 5772, 0.02));
  assert.ok(near(s.luminositySun, 1, 0.1));
  assert.ok(near(s.radiusSun, 1, 0.1));
  assert.ok(near(bvToTemp(0.65), 5772, 0.01));
});

test('giganti e supergiganti', () => {
  const betelgeuse = starNature(-5.47, 1.85, 'M2Ib');
  assert.equal(betelgeuse.name, 'supergigante rossa');
  assert.ok(betelgeuse.radiusSun > 300 && betelgeuse.radiusSun < 1200);
  const aldebaran = starNature(-0.64, 1.54, 'K5III');
  assert.equal(aldebaran.name, 'gigante rossa');
  assert.ok(aldebaran.radiusSun > 25 && aldebaran.radiusSun < 70);
  assert.equal(starNature(-7.0, -0.03, 'B8Ia').name, 'supergigante blu');
});

test('nane', () => {
  const siriusB = starNature(11.18, -0.03, 'DA2');
  assert.equal(siriusB.family, 'nana bianca');
  assert.ok(near(siriusB.temperatureK, 25200, 0.05));
  assert.ok(siriusB.radiusSun > 0.005 && siriusB.radiusSun < 0.015);
  const proxima = starNature(15.5, 1.82, 'M5.5Ve');
  assert.equal(proxima.name, 'nana rossa');
  assert.ok(proxima.radiusSun > 0.1 && proxima.radiusSun < 0.25);
});

test('senza classe spettrale: stima dal diagramma H-R', () => {
  assert.equal(starNature(0.5, 1.2, null).name, 'gigante rossa');
  assert.equal(starNature(12, 0.2, null).family, 'nana bianca');
  assert.equal(starNature(4.7, 0.66, null).name, 'nana gialla');
  assert.ok(starNature(4.7, 0.66, null).estimated);
});

test('sigle spettrali', () => {
  assert.deepEqual(parseSpectral('M1-2Ia-Iab')?.lum, 'Ia');
  assert.deepEqual(parseSpectral('F5IV-V')?.lum, 'IV');
  assert.deepEqual(parseSpectral('A1Vm')?.lum, 'V');
  assert.equal(parseSpectral('DA2')?.cls, 'D');
  assert.equal(parseSpectral('sdM4')?.lum, 'VI');
  assert.equal(parseSpectral('dM3')?.lum, 'V');
  assert.equal(parseSpectral(''), null);
});
