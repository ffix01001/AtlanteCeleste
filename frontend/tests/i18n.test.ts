import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decimalSep, detectLang, lang, locale, setLanguage, t, tn } from '../src/core/i18n.ts';

test('italiano: la chiave è la scritta stessa', () => {
  setLanguage('it', { Orbite: 'Orbits' });
  assert.equal(lang(), 'it');
  assert.equal(t('Orbite'), 'Orbite');
  assert.equal(t('Distanza da {nome}', { nome: 'Marte' }), 'Distanza da Marte');
  assert.equal(tn(1, '{n} giorno', '{n} giorni'), '1 giorno');
  assert.equal(tn(12000, '{n} giorno', '{n} giorni'), '12.000 giorni');
  assert.equal(decimalSep(), ',');
});

test('traduzione, segnaposto e ripiego sull\'inglese', () => {
  setLanguage('de', { Orbite: 'Bahnen' }, { Orbite: 'Orbits', Stelle: 'Stars', 'Distanza da {nome}': 'Distance from {nome}' }, 'de-DE');
  assert.equal(t('Orbite'), 'Bahnen');
  assert.equal(t('Stelle'), 'Stars');                  // manca in tedesco: inglese
  assert.equal(t('Pianeti'), 'Pianeti');               // manca ovunque: italiano
  assert.equal(t('Distanza da {nome}', { nome: 'Mars' }), 'Distance from Mars');
  assert.equal(locale(), 'de-DE');
});

test('plurali secondo la lingua', () => {
  setLanguage('en', { '{n} giorni': { one: '{n} day', other: '{n} days' } }, {}, 'en-GB');
  assert.equal(tn(1, '{n} giorno', '{n} giorni'), '1 day');
  assert.equal(tn(3, '{n} giorno', '{n} giorni'), '3 days');
  assert.equal(decimalSep(), '.');
  setLanguage('fr', { '{n} giorni': '{n} jours' }, {}, 'fr-FR');
  assert.equal(tn(3, '{n} giorno', '{n} giorni'), '3 jours');
  setLanguage('it');
});

test('lingua del sistema', () => {
  assert.equal(detectLang(['de-AT', 'en']), 'de');
  assert.equal(detectLang(['pt-BR', 'es-MX']), 'es');
  assert.equal(detectLang(['ja-JP']), 'en');
  assert.equal(detectLang([]), 'en');
});
