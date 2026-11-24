import test from 'node:test';
import assert from 'node:assert/strict';
import { earthRotationJd, jdTdbToUnixMs, tdbMinusUtc, unixMsToJdTdb } from '../src/core/time';

test('TDB − UTC: valori noti dei secondi intercalari', () => {
  assert.equal(tdbMinusUtc(Date.UTC(2026, 10, 11)), 69.184);
  assert.equal(tdbMinusUtc(Date.UTC(2017, 0, 1)), 69.184);
  assert.equal(tdbMinusUtc(Date.UTC(2016, 11, 31, 23, 59, 59)), 68.184);
  assert.equal(tdbMinusUtc(Date.UTC(2000, 0, 1)), 64.184);
  assert.equal(tdbMinusUtc(Date.UTC(1972, 0, 1)), 42.184);
});

test('TDB − UTC: passato e futuro seguono le ricostruzioni storiche', () => {
  // valori della NASA (Espenak e Meeus): ~120 s nel 1600, ~9 s nel 1700, ~-3 s nel 1900
  assert.ok(Math.abs(tdbMinusUtc(Date.UTC(1600, 0, 1)) - 120) < 5);
  assert.ok(Math.abs(tdbMinusUtc(Date.UTC(1700, 0, 1)) - 9) < 3);
  assert.ok(Math.abs(tdbMinusUtc(Date.UTC(1900, 0, 1)) + 3) < 2);
  const f = tdbMinusUtc(Date.UTC(2500, 0, 1));
  assert.ok(f > 1200 && f < 1700, String(f));
});

test('TDB − UTC: nessun salto ai raccordi', () => {
  for (const t of [Date.UTC(1972, 0, 1), Date.UTC(2030, 0, 1), Date.UTC(2100, 0, 1)]) {
    assert.ok(Math.abs(tdbMinusUtc(t + 1) - tdbMinusUtc(t - 1)) < 0.1, new Date(t).toISOString());
  }
});

test('conversione andata e ritorno entro il millisecondo', () => {
  for (const y of [1600, 1750, 1899, 1971, 1972, 1999, 2026, 2029, 2031, 2099, 2101, 2499]) {
    const ms = Date.UTC(y, 5, 15, 12, 34, 56);
    // un Giorno Giuliano in doppia precisione distingue circa 0,04 ms
    assert.ok(Math.abs(jdTdbToUnixMs(unixMsToJdTdb(ms)) - ms) < 1, String(y));
  }
});

test('rotazione della Terra: segue l\'ora civile in ogni epoca', () => {
  for (const y of [1600, 1900, 2026, 2400]) {
    const ms = Date.UTC(y, 2, 20, 12);
    const expected = 2440587.5 + (ms / 1000 + 69.184) / 86400;
    assert.ok(Math.abs(earthRotationJd(unixMsToJdTdb(ms)) - expected) * 86400 < 0.01, String(y));
  }
});
