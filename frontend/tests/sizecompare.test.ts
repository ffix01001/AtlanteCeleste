import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareSentence, pickRef } from '../src/ui/sizecompare.ts';

test('pianeti accanto alla Terra, la Terra accanto alla Luna', () => {
  const jup = pickRef(139_820, 'planet', 'naif:599');
  assert.equal(jup.short, 'Terra');
  const s = compareSentence(139_820, jup);
  assert.match(s, /11 volte quello della Terra/);
  assert.match(s, /circa 1\.?321 Terre/);
  assert.equal(pickRef(12_742, 'planet', 'naif:399').short, 'Luna');
  assert.match(compareSentence(12_742, pickRef(12_742, 'planet', 'naif:399')), /Il diametro è 3,7 volte quello della Luna/);
  // il Sole accanto alla Terra (non a sé stesso)
  assert.match(compareSentence(1_391_400, pickRef(1_391_400, 'star', 'naif:10')), /109 volte quello della Terra\. Dentro ci starebbero circa 1,3 milioni di Terre\./);
  // il James Webb (21 m): come un campo da tennis
  assert.equal(compareSentence(0.021, pickRef(0.021, 'spacecraft', 'x')), 'È grande più o meno come un campo da tennis.');
});

test('corpi piccoli: termini di paragone di casa', () => {
  assert.equal(pickRef(946, 'dwarf', 'x').short, 'Italia (1200 km)');            // Cerere
  assert.equal(pickRef(0.49, 'asteroid', 'x').short, 'Torre Eiffel (330 m)');    // Bennu
  assert.match(compareSentence(0.49, pickRef(0.49, 'asteroid', 'x')), /Misura circa 1,5 volte la Torre Eiffel/);
  // la Stazione Spaziale (99 m): come un campo da calcio
  assert.equal(compareSentence(0.0992, pickRef(0.0992, 'satellite', 'x')), 'È grande più o meno come un campo da calcio.');
  // Mercurio è più piccolo della Terra
  assert.match(compareSentence(4_879, pickRef(4_879, 'planet', 'naif:199')), /La Terra è 2,6 volte più grande\. Per fare il volume della Terra ne servirebbero circa 17,8/);
});
