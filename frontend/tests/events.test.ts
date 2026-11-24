// Prove del calendario degli eventi (events/astroevents.ts) su date note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeEvents } from '../src/events/astroevents.ts';

const ev = computeEvents(new Date('2026-10-24T00:00:00Z'), new Date('2029-01-05T00:00:00Z'));
const find = (title: string, day: string) => ev.find((e) => e.title === title && e.time.toISOString().startsWith(day));

test('eclissi note', () => {
  assert.ok(find('Eclissi totale di Sole', '2027-08-02'), 'eclissi totale del 2 agosto 2027');
  const luna = find('Eclissi totale di Luna', '2028-12-31');
  assert.ok(luna, 'eclissi totale di Luna del 31 dicembre 2028');
  assert.match(luna!.local ?? '', /^Visibile/);
});

test('opposizioni e meteore', () => {
  assert.ok(find('Marte in opposizione', '2027-02-19'));
  const per = ev.find((e) => e.title === 'Massimo delle Perseidi' && e.time.getUTCFullYear() === 2027);
  assert.ok(per && per.time.getUTCMonth() === 7 && [12, 13].includes(per.time.getUTCDate()));
  assert.equal(per!.highlight, 'sb:109P');
});

test('ordine cronologico', () => {
  for (let i = 1; i < ev.length; i++) assert.ok(ev[i].time >= ev[i - 1].time);
});

import { readFileSync } from 'node:fs';
import { tonight } from '../src/events/astroevents.ts';

test('emisfero sud: le stagioni e la durata del giorno cambiano col luogo', () => {
  const syd = { name: 'Sydney', lat: -33.8688, lon: 151.2093, tz: 'Australia/Sydney' };
  const e = computeEvents(new Date('2026-12-01T00:00:00Z'), new Date('2027-01-01T00:00:00Z'), syd);
  const sol = e.find((x) => x.title === 'Solstizio di dicembre');
  assert.ok(sol);
  assert.match(sol!.detail, /emisfero sud: inizia l'estate/);
  // a Sydney il solstizio d'estate ha circa 14 ore e mezza di luce
  assert.match(sol!.local ?? '', /14 h \d+ min di luce/);
  // le Quadrantidi del 4 gennaio non sono visibili da Sydney: fuori intervallo qui, si controllano le Geminidi
  const gem = e.find((x) => x.title === 'Massimo delle Geminidi');
  assert.ok(gem && /\(2\d°\)/.test(gem.local ?? ''), gem?.local);
});

test('passaggi visibili della Stazione spaziale da Roma', () => {
  const omm = JSON.parse(readFileSync(new URL('./fixtures/iss-omm-2026-10-22.json', import.meta.url), 'utf8'));
  const sat = { norad: 25544, name: 'ISS', of: 'della ISS', stdMag: -1.8, omm };
  const e = computeEvents(new Date('2026-10-28T00:00:00Z'), new Date('2026-11-01T12:00:00Z'), undefined, [sat]).filter((x) => x.kind === 'passaggio');
  assert.ok(e.length >= 2, `passaggi trovati: ${e.length}`);
  // il 31 ottobre 2026 all'alba la ISS passa quasi sopra Roma
  const best = e.find((x) => x.time.toISOString().startsWith('2026-10-31'));
  assert.ok(best, 'passaggio del 31 ottobre');
  assert.match(best!.local ?? '', /alta fino a (7|8)\d°/);
  for (const x of e) assert.equal(x.norad, 25544);
});

test('stanotte: tramonto, Luna e pianeti per il luogo', () => {
  const n = tonight(Date.parse('2026-11-04T15:00:00Z'));
  assert.ok(n.sunset && n.sunrise && n.sunset < n.sunrise);
  assert.ok(n.planets.some((p) => p.name === 'Saturno'));
  // in Norvegia, oltre il Circolo polare, a dicembre il Sole non sorge
  const tromso = tonight(Date.parse('2026-12-21T11:00:00Z'), { name: 'Tromsø', lat: 69.6492, lon: 18.9553, tz: 'Europe/Oslo' });
  assert.equal(tromso.polar, 'notte');
});
