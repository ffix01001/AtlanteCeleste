/// <reference lib="webworker" />
/**
 * Calcolo degli eventi in un thread separato: per cinque anni e con i passaggi dei
 * satelliti servono fino a un paio di secondi, e l'interfaccia non deve fermarsi.
 */

import type { SatInput } from '../events/astroevents';
import type { Place } from '../core/places';
import { importLanguage, type LanguagePack } from '../core/i18n';

// il modulo degli eventi si carica solo dopo aver ricevuto la lingua: alcune sue tabelle
// (nomi dei pianeti, titoli delle eclissi, sciami) si traducono appena caricate
let events: Promise<typeof import('../events/astroevents')> | null = null;

interface Req {
  id: number;
  t0: number;
  t1: number;
  place: Place;
  sats: SatInput[];
  nowMs: number;
}

self.onmessage = async (ev: MessageEvent<Req | { i18n: LanguagePack }>) => {
  if ('i18n' in ev.data) {
    importLanguage(ev.data.i18n);
    events ??= import('../events/astroevents');
    return;
  }
  const m = ev.data;
  try {
    events ??= import('../events/astroevents');
    const { computeEvents, tonight } = await events;
    const list = computeEvents(new Date(m.t0), new Date(m.t1), m.place, m.sats);
    let night = null;
    try {
      night = tonight(m.nowMs, m.place);
    } catch { /* zone polari estreme: nessun riepilogo */ }
    (self as unknown as Worker).postMessage({ id: m.id, events: list, tonight: night });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id: m.id, error: String(err) });
  }
};
