/**
 * Calendario degli eventi astronomici, calcolato sul momento (nessun dato da scaricare) e
 * per il luogo dell'osservatore: eclissi di Sole e di Luna con gli orari locali, opposizioni,
 * massime elongazioni di Mercurio e Venere, congiunzioni fra Luna e pianeti, transiti, fasi
 * lunari, superlune, equinozi e solstizi (con la durata del giorno), perielio e afelio, piogge
 * di meteore (con l'altezza del radiante), passaggi visibili della Stazione spaziale.
 * In più, il riepilogo "stasera": tramonto, buio, Luna e pianeti visibili.
 *
 * I calcoli usano Astronomy Engine di Don Cross (licenza MIT, https://github.com/cosinekitty/astronomy),
 * precisa al minuto d'arco, e satellite.js (SGP4) per i satelliti.
 * I passaggi ravvicinati degli asteroidi arrivano invece dal CNEOS della NASA (vedi api.ts).
 */

import { t as tr } from '../core/i18n';
import { locale } from '../core/i18n';
import * as A from 'astronomy-engine';
import {
  ecfToEci, ecfToLookAngles, eciToEcf, geodeticToEcf, gstime, json2satrec, jday, propagate, shadowFraction, sunPos, type SatRec,
} from 'satellite.js';
import { compass, DEFAULT_PLACE, fmtClock, fromPlace, type Place } from '../core/places';

export type { Place } from '../core/places';

export type EventKind =
  | 'eclissi-luna' | 'eclissi-sole' | 'opposizione' | 'elongazione' | 'transito' | 'congiunzione'
  | 'luna' | 'stagione' | 'apside' | 'meteore' | 'avvicinamento' | 'passaggio';

export type EventGroup = 'eclissi' | 'pianeti' | 'luna' | 'meteore' | 'asteroidi' | 'terra' | 'satelliti';

export interface AstroEvent {
  time: Date;
  kind: EventKind;
  group: EventGroup;
  title: string;
  detail: string;
  /** visibilità dal luogo dell'osservatore, se ha senso */
  local?: string;
  /** false: dal luogo dell'osservatore non si vede (la riga diventa grigia) */
  visible?: boolean;
  /** il corpo da inquadrare (ID del catalogo) */
  focus: string;
  /** un secondo corpo da mettere in evidenza (per esempio la cometa madre di uno sciame) */
  highlight?: string;
  /** designazione di un asteroide o di una cometa del JPL (passaggi ravvicinati) */
  sbdes?: string;
  /** numero NORAD di un satellite (passaggi della Stazione spaziale) */
  norad?: number;
  /** distanza della camera dal corpo inquadrato, km (se non indicata: inquadratura normale) */
  distanceKm?: number;
  /** 1 = da non perdere, 2 = interessante, 3 = di routine */
  importance: 1 | 2 | 3;
}

/** Riepilogo della notte (la prossima, o quella in corso) per il luogo dell'osservatore. */
export interface Tonight {
  /** la notte considerata: dal tramonto all'alba */
  sunset: Date | null;
  sunrise: Date | null;
  /** buio completo (Sole 18° sotto l'orizzonte), se c'è */
  darkFrom: Date | null;
  darkTo: Date | null;
  /** 'giorno' = il Sole non tramonta (estate polare), 'notte' = non sorge */
  polar: 'giorno' | 'notte' | null;
  moon: { phase: string; illum: number; rise: Date | null; set: Date | null };
  planets: { name: string; id: string; from: Date; to: Date; maxAlt: number; dir: string; mag: number }[];
}

/** Satellite di cui calcolare i passaggi visibili (elementi OMM di CelesTrak). */
export interface SatInput {
  norad: number;
  name: string;
  /** "della ISS", "del telescopio Hubble": per il titolo dell'evento */
  of: string;
  /** magnitudine "standard": a 1000 km di distanza, metà illuminato */
  stdMag: number;
  omm: Record<string, unknown>;
}

const DAY = 86400000;
const DEG = Math.PI / 180;

const PLANETS_IT: Record<string, string> = {
  Mercury: tr('Mercurio'), Venus: tr('Venere'), Mars: tr('Marte'), Jupiter: tr('Giove'), Saturn: tr('Saturno'), Uranus: tr('Urano'), Neptune: tr('Nettuno'),
};
const PLANET_ID: Record<string, string> = {
  Mercury: 'naif:199', Venus: 'naif:299', Mars: 'naif:499', Jupiter: 'naif:599', Saturn: 'naif:699', Uranus: 'naif:799', Neptune: 'naif:899',
};

// titoli interi: in altre lingue l'aggettivo cambia posto e forma
const ECL_MOON: Record<string, string> = {
  penumbral: tr('Eclissi penombrale di Luna'), partial: tr('Eclissi parziale di Luna'), total: tr('Eclissi totale di Luna'),
};
const ECL_SUN: Record<string, string> = {
  partial: tr('Eclissi parziale di Sole'), annular: tr('Eclissi anulare di Sole'), total: tr('Eclissi totale di Sole'),
};

function fmt(x: number, d = 1): string {
  return x.toLocaleString(locale(), { maximumFractionDigits: d, minimumFractionDigits: d });
}

/** Contesto del luogo: osservatore di Astronomy Engine, orari locali, preposizione. */
class Site {
  readonly obs: A.Observer;
  readonly from: string;
  readonly place: Place;
  constructor(place: Place) {
    this.place = place;
    this.obs = new A.Observer(place.lat, place.lon, place.elev ?? 0);
    this.from = fromPlace(place);
  }
  clock(d: Date | A.AstroTime): string {
    return fmtClock(d instanceof Date ? d : d.date, this.place.tz);
  }
  hor(body: A.Body, t: A.AstroTime): A.HorizontalCoordinates {
    const eq = A.Equator(body, t, this.obs, true, true);
    return A.Horizon(t, this.obs, eq.ra, eq.dec, 'normal');
  }
  alt(body: A.Body, t: A.AstroTime): number {
    return this.hor(body, t).altitude;
  }
  /** altezza di un punto fisso del cielo (ascensione retta in gradi, J2000) */
  altRaDec(raDeg: number, decDeg: number, t: A.AstroTime): number {
    return A.Horizon(t, this.obs, raDeg / 15, decDeg, 'normal').altitude;
  }
  get north(): boolean {
    return this.place.lat >= 0;
  }
}

/** "alta 34° a sudest" */
function altDir(h: A.HorizontalCoordinates, fem = true): string {
  const p = { gradi: fmt(h.altitude, 0), dir: compass(h.azimuth) };
  return fem ? tr('alta {gradi}° a {dir}', p) : tr('alto {gradi}° a {dir}', p);
}

/** "da Roma" -> "Da Roma" */
function cap(x: string): string {
  return x.charAt(0).toUpperCase() + x.slice(1);
}

function durationHM(ms: number): string {
  const m = Math.round(ms / 60000);
  const hh = Math.floor(m / 60), mm = m % 60;
  return hh ? tr('{hh} h {mm} min', { hh, mm }) : `${mm} min`;
}

// ------------------------------------------------------------------ eclissi

function lunarEclipses(t0: Date, t1: Date, s: Site): AstroEvent[] {
  const out: AstroEvent[] = [];
  let e = A.SearchLunarEclipse(t0);
  while (e.peak.date < t1) {
    const parts: string[] = [];
    if (e.sd_total > 0) parts.push(tr('totalità di {v0} minuti', { v0: fmt(e.sd_total * 2, 0) }));
    else if (e.sd_partial > 0) parts.push(tr('fase parziale di {v0} minuti', { v0: fmt(e.sd_partial * 2, 0) }));
    if (e.kind === 'total') parts.push(tr('la Luna diventa color rame: è la luce di tutti i tramonti e le albe della Terra'));
    if (e.kind === 'partial') parts.push(tr('ombra sul {v0}% del disco', { v0: fmt(e.obscuration * 100, 0) }));
    if (e.kind === 'penumbral') parts.push(tr('la Luna si scurisce appena: difficile da notare'));
    // fasi visibili dal luogo
    const main = e.sd_partial > 0 ? e.sd_partial : e.sd_penum;
    const t1p = e.peak.AddDays(-main / 1440), t2p = e.peak.AddDays(main / 1440);
    const hPeak = s.hor(A.Body.Moon, e.peak);
    const a1 = s.alt(A.Body.Moon, t1p), a2 = s.alt(A.Body.Moon, t2p);
    let local: string, visible = true;
    const span = e.sd_partial > 0
      ? tr('fase parziale dalle {v0} alle {v1}', { v0: s.clock(t1p), v1: s.clock(t2p) }) + (e.sd_total > 0 ? tr(', totalità dalle {v0} alle {v1}', { v0: s.clock(e.peak.AddDays(-e.sd_total / 1440)), v1: s.clock(e.peak.AddDays(e.sd_total / 1440)) }) : '')
      : tr('dalle {v0} alle {v1}', { v0: s.clock(t1p), v1: s.clock(t2p) });
    if (hPeak.altitude > 0) {
      local = tr('Visibile {from}: {span}; al massimo ({v2}) la Luna è {v3}.', { from: s.from, span, v2: s.clock(e.peak), v3: altDir(hPeak) });
    } else if (a1 > 0 || a2 > 0) {
      const rise = a1 <= 0;
      local = rise ? tr('In parte visibile {from}: la Luna sorge durante l\'eclissi ({span}).', { from: s.from, span })
        : tr('In parte visibile {from}: la Luna tramonta durante l\'eclissi ({span}).', { from: s.from, span });
    } else {
      local = tr('Non visibile {from}: la Luna è sotto l\'orizzonte.', { from: s.from });
      visible = false;
    }
    out.push({
      time: e.peak.date, kind: 'eclissi-luna', group: 'eclissi',
      title: ECL_MOON[e.kind] ?? tr('Eclissi di Luna'),
      detail: parts.join('; ') + '.',
      local, visible,
      focus: 'naif:301',
      importance: e.kind === 'penumbral' ? 3 : visible ? 1 : 2,
    });
    e = A.NextLunarEclipse(e.peak);
  }
  return out;
}

/** Descrizione molto approssimata di dove cade un punto della Terra (per le eclissi di Sole). */
function whereOnEarth(lat: number, lon: number): string {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'O';
  return `${fmt(Math.abs(lat), 0)}° ${ns}, ${fmt(Math.abs(lon), 0)}° ${ew}`;
}

function solarEclipses(t0: Date, t1: Date, s: Site): AstroEvent[] {
  const out: AstroEvent[] = [];
  let e = A.SearchGlobalSolarEclipse(t0);
  while (e.peak.date < t1) {
    let detail = e.latitude !== undefined && e.longitude !== undefined
      ? tr('Massimo a {v0}.', { v0: whereOnEarth(e.latitude, e.longitude) })
      : tr('L\'ombra della Luna sfiora la Terra senza toccarla al centro: solo parziale.');
    if (e.kind === 'total') detail += tr(' La Luna copre tutto il Sole: per pochi minuti si vede la corona.');
    if (e.kind === 'annular') detail += tr(' La Luna è troppo lontana per coprire tutto il Sole: resta un anello di fuoco.');
    let local = tr('Non visibile {from}.', { from: s.from }), visible = false;
    try {
      const le = A.SearchLocalSolarEclipse(new Date(e.peak.date.getTime() - 2 * DAY), s.obs);
      const near = Math.abs(le.peak.time.date.getTime() - e.peak.date.getTime()) < 1.5 * DAY;
      const up = [le.partial_begin, le.peak, le.partial_end].some((x) => x.altitude > 0);
      if (near && up) {
        visible = true;
        const times = tr('dalle {v0} alle {v1}, massimo alle {v2}', { v0: s.clock(le.partial_begin.time), v1: s.clock(le.partial_end.time), v2: s.clock(le.peak.time) });
        const cover = tr('{v0}% del Sole coperto', { v0: fmt(le.obscuration * 100, 0) });
        const low = le.peak.altitude < 0 ? tr(' (al massimo il Sole è già sotto l\'orizzonte)') : tr(' con il Sole alto {v0}°', { v0: fmt(le.peak.altitude, 0) });
        if (le.kind === 'total' && le.total_begin && le.total_end) {
          local = tr('Totale {from}! Totalità dalle {v1} alle {v2}; {times}{low}.', { from: s.from, v1: s.clock(le.total_begin.time), v2: s.clock(le.total_end.time), times, low });
        } else if (le.kind === 'annular') {
          local = tr('Anulare {from}: {times}{low}.', { from: s.from, times, low });
        } else {
          local = tr('Parziale {from}: {times}, {cover}{low}. Solo con filtri solari adatti.', { from: s.from, times, cover, low });
        }
      }
    } catch { /* nessuna eclissi locale vicina */ }
    out.push({
      time: e.peak.date, kind: 'eclissi-sole', group: 'eclissi',
      title: ECL_SUN[e.kind] ?? tr('Eclissi di Sole'),
      detail, local, visible,
      // si guarda la Terra: sul disco si vede l'ombra della Luna
      focus: 'naif:399', distanceKm: 90000,
      importance: visible ? 1 : e.kind === 'partial' ? 3 : 2,
    });
    e = A.NextGlobalSolarEclipse(e.peak);
  }
  return out;
}

// ------------------------------------------------------------------ pianeti

/** Quando e quanto in alto culmina un corpo nella notte vicina a t. */
function culmination(s: Site, body: A.Body, t: A.AstroTime): A.HourAngleEvent | null {
  try {
    return A.SearchHourAngle(body, s.obs, 0, t.AddDays(-0.5));
  } catch {
    return null;
  }
}

function oppositions(t0: Date, t1: Date, s: Site): AstroEvent[] {
  const out: AstroEvent[] = [];
  for (const name of ['Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'] as const) {
    const body = A.Body[name];
    let t = A.MakeTime(t0);
    for (let k = 0; k < 12; k++) {
      const opp = A.SearchRelativeLongitude(body, 0, t);
      if (opp.date >= t1) break;
      const dist = A.GeoVector(body, opp, true).Length();
      const mag = A.Illumination(body, opp).mag;
      const it = PLANETS_IT[name];
      const c = culmination(s, body, opp);
      let local: string | undefined, visible = true;
      if (c) {
        if (c.hor.altitude > 10) local = tr('{v0}: sorge al tramonto e verso le {v1} è {v2}.', { v0: cap(s.from), v1: s.clock(c.time), v2: altDir(c.hor, false) });
        else if (c.hor.altitude > 0) local = tr('{v0}: resta basso, al massimo {v1}° sull\'orizzonte.', { v0: cap(s.from), v1: fmt(c.hor.altitude, 0) });
        else { local = tr('Non sorge {from} in questo periodo.', { from: s.from }); visible = false; }
      }
      out.push({
        time: opp.date, kind: 'opposizione', group: 'pianeti',
        title: tr('{it} in opposizione', { it }),
        detail: tr('{it} è dalla parte opposta del Sole: visibile tutta la notte e alla minima distanza dell\'anno, ', { it })
          + tr('{v0} UA ({v1} milioni di km). Magnitudine {v2}.', { v0: fmt(dist, 2), v1: fmt(dist * 149.6, 0), v2: fmt(mag, 1) }),
        local, visible,
        focus: PLANET_ID[name],
        importance: name === 'Mars' || name === 'Jupiter' || name === 'Saturn' ? 1 : 3,
      });
      t = opp.AddDays(30);
    }
  }
  return out;
}

function elongations(t0: Date, t1: Date, s: Site): AstroEvent[] {
  const out: AstroEvent[] = [];
  for (const name of ['Mercury', 'Venus'] as const) {
    let t = A.MakeTime(t0);
    for (let k = 0; k < 20; k++) {
      const e = A.SearchMaxElongation(A.Body[name], t);
      if (e.time.date >= t1) break;
      const it = PLANETS_IT[name];
      const evening = e.visibility !== 'morning';
      const when = evening ? tr('alla sera, dopo il tramonto, a ovest') : tr('al mattino, prima dell\'alba, a est');
      // altezza mezz'ora abbondante dopo il tramonto (o prima dell'alba)
      let local: string | undefined, visible = true;
      try {
        const sunEv = evening
          ? A.SearchRiseSet(A.Body.Sun, s.obs, -1, e.time.AddDays(-0.6), 1.2)
          : A.SearchRiseSet(A.Body.Sun, s.obs, +1, e.time.AddDays(-0.6), 1.2);
        if (sunEv) {
          const tt = sunEv.AddDays((evening ? 40 : -40) / 1440);
          const hz = s.hor(A.Body[name], tt);
          if (hz.altitude > 3) local = tr('{v0}: alle {v1}, 40 minuti {v2}, è {v3}.', { v0: cap(s.from), v1: s.clock(tt), v2: evening ? tr('dopo il tramonto') : tr('prima dell\'alba'), v3: altDir(hz, false) });
          else { local = tr('{v0} resta troppo basso nel chiarore {v1}: {v2}°.', { v0: cap(s.from), v1: evening ? tr('del tramonto') : tr('dell\'alba'), v2: fmt(hz.altitude, 0) }); visible = false; }
        }
      } catch { /* niente tramonto (zone polari) */ }
      out.push({
        time: e.time.date, kind: 'elongazione', group: 'pianeti',
        title: tr('{it} alla massima distanza apparente dal Sole', { it }),
        detail: tr('{v0}° dal Sole: il momento migliore per vederlo, {when}.', { v0: fmt(e.elongation, 0), when }),
        local, visible,
        focus: PLANET_ID[name],
        importance: 2,
      });
      t = e.time.AddDays(10);
    }
  }
  return out;
}

function transits(t0: Date, t1: Date, s: Site): AstroEvent[] {
  const out: AstroEvent[] = [];
  for (const name of ['Mercury', 'Venus'] as const) {
    const tran = A.SearchTransit(A.Body[name], t0);
    if (tran.peak.date >= t1) continue;
    const h = (tran.finish.ut - tran.start.ut) * 24;
    const up = [tran.start, tran.peak, tran.finish].some((x) => s.alt(A.Body.Sun, x) > 0);
    out.push({
      time: tran.peak.date, kind: 'transito', group: 'pianeti',
      title: tr('Transito di {v0} davanti al Sole', { v0: PLANETS_IT[name] }),
      detail: tr('Un puntino nero attraversa il disco del Sole per {v0} ore. Da osservare solo con filtri solari adatti.', { v0: fmt(h, 1) }),
      local: up ? tr('Visibile {from}, dalle {v1} alle {v2} (in parte se il Sole sorge o tramonta).', { from: s.from, v1: s.clock(tran.start), v2: s.clock(tran.finish) }) : tr('Non visibile {from}: avviene di notte.', { from: s.from }),
      visible: up,
      focus: PLANET_ID[name],
      importance: 1,
    });
  }
  return out;
}

/** Separazione angolare (gradi) fra due corpi visti dal centro della Terra. */
function separation(a: A.Body, b: A.Body, t: A.AstroTime): number {
  const va = A.GeoVector(a, t, true), vb = A.GeoVector(b, t, true);
  return A.AngleBetween(va, vb);
}

/** Minimi della separazione sotto `maxDeg`, campionando ogni `stepDays` e raffinando. */
function closeApproaches(a: A.Body, b: A.Body, t0: Date, t1: Date, stepDays: number, maxDeg: number): { t: A.AstroTime; sep: number }[] {
  const out: { t: A.AstroTime; sep: number }[] = [];
  let ta = A.MakeTime(t0);
  let sa = separation(a, b, ta);
  let tb = ta.AddDays(stepDays);
  let sb = separation(a, b, tb);
  while (tb.date < t1) {
    const tc = tb.AddDays(stepDays);
    const sc = separation(a, b, tc);
    if (sb <= sa && sb <= sc && sb < maxDeg * 1.6) {
      // ricerca per sezione aurea sul minimo, fino a una decina di minuti
      let lo = ta.ut, hi = tc.ut;
      const g = (Math.sqrt(5) - 1) / 2;
      let x1 = hi - g * (hi - lo), x2 = lo + g * (hi - lo);
      let f1 = separation(a, b, A.MakeTime(x1 + 0)), f2 = separation(a, b, A.MakeTime(x2 + 0));
      // MakeTime accetta un numero di giorni da J2000 (UT)
      for (let k = 0; k < 40 && hi - lo > 0.005; k++) {
        if (f1 < f2) { hi = x2; x2 = x1; f2 = f1; x1 = hi - g * (hi - lo); f1 = separation(a, b, A.MakeTime(x1)); }
        else { lo = x1; x1 = x2; f1 = f2; x2 = lo + g * (hi - lo); f2 = separation(a, b, A.MakeTime(x2)); }
      }
      const tm = A.MakeTime((lo + hi) / 2);
      const sm = separation(a, b, tm);
      if (sm < maxDeg) out.push({ t: tm, sep: sm });
    }
    ta = tb; sa = sb; tb = tc; sb = sc;
  }
  return out;
}

/** Il momento migliore della notte per vedere un corpo (Sole sotto -6°, corpo più alto possibile). */
function bestNightView(s: Site, body: A.Body, t: A.AstroTime): { t: A.AstroTime; h: A.HorizontalCoordinates } | null {
  let best: { t: A.AstroTime; h: A.HorizontalCoordinates } | null = null;
  for (let k = -16; k <= 16; k++) {
    const tt = t.AddDays(k / 48);
    if (s.alt(A.Body.Sun, tt) > -6) continue;
    const h = s.hor(body, tt);
    if (h.altitude > 8 && (!best || h.altitude > best.h.altitude)) best = { t: tt, h };
  }
  return best;
}

function conjunctions(t0: Date, t1: Date, s: Site): AstroEvent[] {
  const out: AstroEvent[] = [];
  const add = (a: A.Body, b: A.Body, aIt: string, bIt: string, focus: string, highlight: string, t: A.AstroTime, sep: number, moon: boolean) => {
    // vicino al Sole non si vede nulla
    const elong = A.AngleFromSun(moon ? b : a, t);
    if (elong < 15) return;
    const best = bestNightView(s, moon ? b : a, t);
    const sepTxt = sep < 1 ? tr('{v0} primi d\'arco (meno di due lune piene)', { v0: fmt(sep * 60, 0) }) : `${fmt(sep, 1)}°`;
    const local = best
      ? tr('{v0}: verso le {v1}, {v2}.', { v0: cap(s.from), v1: s.clock(best.t), v2: best.h.altitude > 0 ? tr('{v0}° sopra l\'orizzonte a {v1}', { v0: fmt(best.h.altitude, 0), v1: compass(best.h.azimuth) }) : '' })
      : tr('{v0} la coppia è troppo bassa o nel chiarore del Sole.', { v0: cap(s.from) });
    const mag = Math.min(A.Illumination(a, t).mag, A.Illumination(b, t).mag);
    out.push({
      time: t.date, kind: 'congiunzione', group: moon ? 'luna' : 'pianeti',
      title: moon ? tr('La Luna accanto a {bIt}', { bIt }) : tr('{aIt} e {bIt} vicini', { aIt, bIt }),
      detail: tr('Si vedono a {sepTxt} l\'uno dall\'altro: un bello spettacolo anche a occhio nudo{v1}. ', { sepTxt, v1: mag < 0 ? tr(', con un astro molto brillante') : '' })
        + tr('Sono vicini solo in prospettiva: in realtà li separano milioni di km.'),
      local, visible: !!best,
      focus, highlight,
      importance: sep < 1 && best ? 2 : 3,
    });
  };
  const pl = ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn'] as const;
  for (const p of ['Venus', 'Mars', 'Jupiter', 'Saturn'] as const) {
    for (const c of closeApproaches(A.Body.Moon, A.Body[p], t0, t1, 0.25, 2.5)) {
      add(A.Body.Moon, A.Body[p], tr('Luna'), PLANETS_IT[p], PLANET_ID[p], 'naif:301', c.t, c.sep, true);
    }
  }
  for (let i = 0; i < pl.length; i++) {
    for (let j = i + 1; j < pl.length; j++) {
      const a = pl[i], b = pl[j];
      for (const c of closeApproaches(A.Body[a], A.Body[b], t0, t1, 1, 1.5)) {
        // si inquadra il più luminoso
        const ma = A.Illumination(A.Body[a], c.t).mag, mb = A.Illumination(A.Body[b], c.t).mag;
        const [f, g] = ma <= mb ? [a, b] : [b, a];
        add(A.Body[f], A.Body[g], PLANETS_IT[f], PLANETS_IT[g], PLANET_ID[f], PLANET_ID[g], c.t, c.sep, false);
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ Luna e Terra

function moonPhases(t0: Date, t1: Date, s: Site): AstroEvent[] {
  const out: AstroEvent[] = [];
  let q = A.SearchMoonQuarter(t0);
  while (q.time.date < t1) {
    if (q.quarter === 0 || q.quarter === 2) {
      const full = q.quarter === 2;
      const distKm = A.GeoVector(A.Body.Moon, q.time, false).Length() * A.KM_PER_AU;
      const superMoon = full && distKm < 361000;
      const microMoon = full && distKm > 404000;
      let local: string | undefined;
      if (full) {
        try {
          const rise = A.SearchRiseSet(A.Body.Moon, s.obs, +1, q.time.AddDays(-0.7), 1.4);
          if (rise) local = tr('{v0} sorge alle {v1} {v2}, a {v3}.', { v0: cap(s.from), v1: s.clock(rise), v2: rise.date < q.time.date ? tr('della sera prima') : '', v3: compass(s.hor(A.Body.Moon, rise).azimuth) }).replace(' ,', ',');
        } catch { /* zone polari */ }
      }
      out.push({
        time: q.time.date, kind: 'luna', group: 'luna',
        title: full ? (superMoon ? tr('Superluna') : microMoon ? tr('Luna piena (la più piccola dell\'anno)') : tr('Luna piena')) : tr('Luna nuova'),
        detail: full
          ? tr('Distanza dalla Terra {v0} mila km{v1}.', { v0: fmt(distKm / 1000, 0), v1: superMoon ? tr(': appare circa il 14% più grande e il 30% più luminosa di una luna piena all\'apogeo') : '' })
          : tr('Notti senza Luna: le migliori per osservare galassie, nebulose e la Via Lattea.'),
        local,
        focus: 'naif:301',
        importance: superMoon ? 2 : 3,
      });
    }
    q = A.NextMoonQuarter(q);
  }
  return out;
}

/** Durata del giorno (dall'alba al tramonto) nel giorno che contiene t, al luogo dato. */
export function dayLength(s: Site, t: A.AstroTime): { rise: A.AstroTime | null; set: A.AstroTime | null; ms: number | null; polar: 'giorno' | 'notte' | null } {
  // mezzogiorno vero vicino a t
  const noon = culmination(s, A.Body.Sun, t.AddDays(0.5));
  const ref = noon ? noon.time : t;
  const rise = A.SearchRiseSet(A.Body.Sun, s.obs, +1, ref.AddDays(-0.75), 0.75);
  const set = A.SearchRiseSet(A.Body.Sun, s.obs, -1, ref, 0.75);
  if (rise && set) return { rise, set, ms: set.date.getTime() - rise.date.getTime(), polar: null };
  const up = s.alt(A.Body.Sun, ref) > 0;
  return { rise, set, ms: null, polar: up ? 'giorno' : 'notte' };
}

function seasons(t0: Date, t1: Date, s: Site): AstroEvent[] {
  const out: AstroEvent[] = [];
  const N = s.north;
  for (let y = t0.getUTCFullYear(); y <= t1.getUTCFullYear(); y++) {
    const ss = A.Seasons(y);
    const items: [A.AstroTime, string, string][] = [
      [ss.mar_equinox, tr('Equinozio di marzo'), N
        ? tr('Inizia la primavera astronomica nell\'emisfero nord (e l\'autunno in quello sud): giorno e notte durano quasi uguali ovunque.')
        : tr('Inizia l\'autunno astronomico nell\'emisfero sud (e la primavera in quello nord): giorno e notte durano quasi uguali ovunque.')],
      [ss.jun_solstice, tr('Solstizio di giugno'), N
        ? tr('Il giorno più lungo dell\'anno nell\'emisfero nord: il Sole raggiunge il Tropico del Cancro. Inizia l\'estate.')
        : tr('Il giorno più corto dell\'anno nell\'emisfero sud: inizia l\'inverno. Il Sole è allo zenit sul Tropico del Cancro.')],
      [ss.sep_equinox, tr('Equinozio di settembre'), N
        ? tr('Inizia l\'autunno astronomico nell\'emisfero nord (e la primavera in quello sud).')
        : tr('Inizia la primavera astronomica nell\'emisfero sud (e l\'autunno in quello nord).')],
      [ss.dec_solstice, tr('Solstizio di dicembre'), N
        ? tr('Il giorno più corto dell\'anno nell\'emisfero nord: il Sole raggiunge il Tropico del Capricorno. Inizia l\'inverno.')
        : tr('Il giorno più lungo dell\'anno nell\'emisfero sud: inizia l\'estate. Il Sole è allo zenit sul Tropico del Capricorno.')],
    ];
    for (const [t, title, detail] of items) {
      if (t.date >= t0 && t.date < t1) {
        let local: string | undefined;
        try {
          const d = dayLength(s, t);
          local = d.ms !== null
            ? tr('{v0}: il Sole sorge alle {v1} e tramonta alle {v2}, {v3} di luce.', { v0: cap(s.from), v1: s.clock(d.rise!), v2: s.clock(d.set!), v3: durationHM(d.ms) })
            : d.polar === 'giorno' ? tr('{v0} il Sole non tramonta: giorno polare.', { v0: cap(s.from) }) : tr('{v0} il Sole non sorge: notte polare.', { v0: cap(s.from) });
        } catch { /* */ }
        out.push({ time: t.date, kind: 'stagione', group: 'terra', title, detail, local, focus: 'naif:399', distanceKm: 60000, importance: 3 });
      }
    }
  }
  return out;
}

function earthApsides(t0: Date, t1: Date, s: Site): AstroEvent[] {
  const out: AstroEvent[] = [];
  let a = A.SearchPlanetApsis(A.Body.Earth, t0);
  while (a.time.date < t1) {
    const peri = a.kind === A.ApsisKind.Pericenter;
    const winterHere = peri === s.north;
    out.push({
      time: a.time.date, kind: 'apside', group: 'terra',
      title: peri ? tr('La Terra al perielio') : tr('La Terra all\'afelio'),
      detail: tr('{v0}: {v1} milioni di km. ', { v0: peri ? tr('Il punto più vicino al Sole') : tr('Il punto più lontano dal Sole'), v1: fmt(a.dist_km / 1e6, 2) })
        + (winterHere ? tr('Curiosità: {from} è inverno. Le stagioni dipendono dall\'inclinazione dell\'asse, non dalla distanza.', { from: s.from })
          : tr('Curiosità: {from} è estate. Le stagioni dipendono dall\'inclinazione dell\'asse, non dalla distanza.', { from: s.from })),
      focus: 'naif:399', distanceKm: 60000,
      importance: 3,
    });
    a = A.NextPlanetApsis(A.Body.Earth, a);
  }
  return out;
}

// ------------------------------------------------------------------ meteore

interface Shower {
  name: string;
  /** longitudine eclittica del Sole al massimo (J2000, gradi) */
  lambda: number;
  zhr: number;
  /** costellazione del radiante, con la preposizione ("nei Gemelli") */
  radiant: string;
  /** coordinate del radiante al massimo (J2000, gradi) */
  ra: number;
  dec: number;
  speedKms: number;
  parent: string;
  parentId?: string;
}

/** Principali sciami dell'anno (International Meteor Organization, Meteor Shower Calendar). */
const SHOWERS: Shower[] = [
  { name: tr('Quadrantidi'), lambda: 283.15, zhr: 80, radiant: tr('nel Boote'), ra: 230, dec: 49, speedKms: 41, parent: tr('l\'asteroide 2003 EH1, forse una cometa spenta') },
  { name: tr('Liridi'), lambda: 32.32, zhr: 18, radiant: tr('nella Lira'), ra: 272, dec: 33, speedKms: 49, parent: tr('la cometa C/1861 G1 Thatcher') },
  { name: tr('Eta Aquaridi'), lambda: 45.5, zhr: 50, radiant: tr('nell\'Acquario'), ra: 338, dec: -1, speedKms: 66, parent: tr('la cometa di Halley'), parentId: 'sb:1P' },
  { name: tr('Delta Aquaridi Sud'), lambda: 127, zhr: 25, radiant: tr('nell\'Acquario'), ra: 340, dec: -16, speedKms: 41, parent: tr('probabilmente la cometa 96P/Machholz') },
  { name: tr('Perseidi'), lambda: 140.0, zhr: 100, radiant: tr('nel Perseo'), ra: 48, dec: 58, speedKms: 59, parent: tr('la cometa 109P/Swift-Tuttle'), parentId: 'sb:109P' },
  { name: tr('Draconidi'), lambda: 195.4, zhr: 10, radiant: tr('nel Dragone'), ra: 262, dec: 54, speedKms: 20, parent: tr('la cometa 21P/Giacobini-Zinner') },
  { name: tr('Orionidi'), lambda: 208, zhr: 20, radiant: tr('in Orione'), ra: 95, dec: 16, speedKms: 66, parent: tr('la cometa di Halley'), parentId: 'sb:1P' },
  { name: tr('Tauridi del Nord'), lambda: 230, zhr: 5, radiant: tr('nel Toro'), ra: 58, dec: 22, speedKms: 29, parent: tr('la cometa 2P/Encke'), parentId: 'sb:2P' },
  { name: tr('Leonidi'), lambda: 235.27, zhr: 15, radiant: tr('nel Leone'), ra: 152, dec: 22, speedKms: 70, parent: tr('la cometa 55P/Tempel-Tuttle'), parentId: 'sb:55P' },
  { name: tr('Geminidi'), lambda: 262.2, zhr: 150, radiant: tr('nei Gemelli'), ra: 112, dec: 33, speedKms: 35, parent: tr('l\'asteroide 3200 Phaethon') },
  { name: tr('Ursidi'), lambda: 270.7, zhr: 10, radiant: tr('nell\'Orsa Minore'), ra: 217, dec: 76, speedKms: 33, parent: tr('la cometa 8P/Tuttle') },
];

function meteorShowers(t0: Date, t1: Date, s: Site): AstroEvent[] {
  const out: AstroEvent[] = [];
  for (let y = t0.getUTCFullYear(); y <= t1.getUTCFullYear(); y++) {
    const eq = A.Seasons(y).mar_equinox;
    for (const sh of SHOWERS) {
      // longitudine dell'equinozio della data (precessione: 50,3" all'anno)
      const lam = (sh.lambda + 0.013969 * (y - 2000) + 360) % 360;
      const guess = eq.AddDays(lam / 0.98565 - 6);
      const t = A.SearchSunLongitude(lam, guess, 12);
      if (!t || t.date < t0 || t.date >= t1) continue;
      const moon = A.Illumination(A.Body.Moon, t).phase_fraction;
      const moonTxt = moon > 0.6 ? tr('Luna illuminata al {v0}%: disturba.', { v0: fmt(moon * 100, 0) }) : moon < 0.25 ? tr('Luna quasi assente: condizioni ottime.') : tr('Luna al {v0}%.', { v0: fmt(moon * 100, 0) });
      // nella notte del massimo: quando il radiante è più alto con il cielo buio
      let best: { t: A.AstroTime; alt: number } | null = null;
      for (let k = -24; k <= 24; k++) {
        const tt = t.AddDays(k / 48);
        if (s.alt(A.Body.Sun, tt) > -12) continue;
        const alt = s.altRaDec(sh.ra, sh.dec, tt);
        if (!best || alt > best.alt) best = { t: tt, alt };
      }
      let local: string, visible = true;
      if (best && best.alt > 10) {
        // frequenza vista: ZHR per il seno dell'altezza del radiante, meno con la Luna
        const rate = Math.round(sh.zhr * Math.sin(best.alt * DEG) * (moon > 0.6 ? 0.45 : moon > 0.3 ? 0.7 : 1));
        local = tr('{v0}: radiante più alto verso le {v1} ({v2}°): sotto un cielo buio, lontano dalle luci, fino a {v3} meteore all\'ora circa.', { v0: cap(s.from), v1: s.clock(best.t), v2: fmt(best.alt, 0), v3: Math.max(1, rate) });
      } else {
        local = tr('{v0} il radiante resta basso o sotto l\'orizzonte: se ne vedranno poche.', { v0: cap(s.from) });
        visible = false;
      }
      out.push({
        time: t.date, kind: 'meteore', group: 'meteore',
        title: tr('Massimo delle {name}', { name: sh.name }),
        detail: tr('Fino a circa {zhr} meteore all\'ora sotto un cielo perfetto, dal radiante {radiant}, a {speedKms} km/s. ', { zhr: sh.zhr, radiant: sh.radiant, speedKms: sh.speedKms })
          + tr('Sono i detriti lasciati da {parent}: la Terra attraversa la loro scia. {moonTxt}', { parent: sh.parent, moonTxt }),
        local, visible,
        focus: 'naif:399', highlight: sh.parentId, distanceKm: 6e7,
        importance: sh.zhr >= 50 && visible ? (moon > 0.6 ? 2 : 1) : 3,
      });
    }
  }
  return out;
}

// ------------------------------------------------------------------ satelliti

/**
 * Passaggi visibili di un satellite: sopra 10° d'altezza, con l'osservatore al buio
 * (Sole sotto -6°) e il satellite ancora illuminato dal Sole. Gli elementi orbitali
 * valgono per pochi giorni: si calcolano al massimo 10 giorni dall'epoca degli elementi.
 */
function satellitePasses(sat: SatInput, t0: Date, t1: Date, s: Site): AstroEvent[] {
  let rec: SatRec;
  try {
    rec = json2satrec(sat.omm as never);
  } catch {
    return [];
  }
  const epochMs = Date.parse(String(sat.omm.EPOCH) + (String(sat.omm.EPOCH).endsWith('Z') ? '' : 'Z'));
  const from = Math.max(t0.getTime(), epochMs - 3 * DAY);
  const to = Math.min(t1.getTime(), epochMs + 10 * DAY, t0.getTime() + 12 * DAY);
  if (!(to > from)) return [];
  const gd = { longitude: s.place.lon * DEG, latitude: s.place.lat * DEG, height: (s.place.elev ?? 0) / 1000 };
  const obsEcf = geodeticToEcf(gd as never);
  const look = (ms: number) => {
    const d = new Date(ms);
    const pv = propagate(rec, d);
    if (!pv || typeof pv.position !== 'object') return null;
    const g = gstime(d);
    const ecf = eciToEcf(pv.position, g);
    const la = ecfToLookAngles(gd as never, ecf);
    const o = ecfToEci(obsEcf, g);
    return { el: la.elevation / DEG, az: la.azimuth / DEG, range: la.rangeSat, eci: pv.position, obs: { x: o.x, y: o.y, z: o.z } };
  };
  const out: AstroEvent[] = [];
  const STEP = 30000;
  let prevUp = false;
  let passStart = 0;
  for (let ms = from; ms <= to; ms += STEP) {
    const l = look(ms);
    const up = !!l && l.el > 0;
    if (up && !prevUp) passStart = ms;
    if (!up && prevUp) {
      const ev = describePass(sat, passStart - STEP, ms, look, s);
      if (ev) out.push(ev);
    }
    prevUp = up;
  }
  return out;
}

type Look = { el: number; az: number; range: number; eci: { x: number; y: number; z: number }; obs: { x: number; y: number; z: number } };

function describePass(sat: SatInput, a: number, b: number, look: (ms: number) => Look | null, s: Site): AstroEvent | null {
  // campioni ogni 5 secondi: parte visibile (alto > 10°, osservatore al buio, satellite al sole)
  let vis: { ms: number; el: number; az: number; mag: number }[] = [];
  let maxEl = 0;
  for (let ms = a; ms <= b; ms += 5000) {
    const l = look(ms);
    if (!l) continue;
    maxEl = Math.max(maxEl, l.el);
    if (l.el < 10) continue;
    const t = A.MakeTime(new Date(ms));
    if (s.alt(A.Body.Sun, t) > -6) continue;
    const sp = sunPos(jday(new Date(ms)));
    if (shadowFraction(sp.rsun, l.eci as never) > 0.5) continue;
    // magnitudine: distanza e angolo di fase (sfera che diffonde la luce)
    const sun = sp.rsun;
    const sl = Math.hypot(sun.x, sun.y, sun.z);
    const su = { x: sun.x / sl, y: sun.y / sl, z: sun.z / sl };
    // direzione satellite -> osservatore
    const dx = l.obs.x - l.eci.x, dy = l.obs.y - l.eci.y, dz = l.obs.z - l.eci.z;
    const dl = Math.hypot(dx, dy, dz);
    const ob = { x: dx / dl, y: dy / dl, z: dz / dl };
    const cosPh = Math.max(-1, Math.min(1, su.x * ob.x + su.y * ob.y + su.z * ob.z));
    const ph = Math.acos(cosPh);
    const F = (Math.sin(ph) + (Math.PI - ph) * Math.cos(ph)) / Math.PI;
    const mag = sat.stdMag + 5 * Math.log10(l.range / 1000) - 2.5 * Math.log10(Math.max(F, 1e-3) * Math.PI);
    vis.push({ ms, el: l.el, az: l.az, mag });
  }
  if (vis.length < 3 || maxEl < 10) return null;
  // un passaggio può entrare nell'ombra della Terra: si tiene il tratto visibile più lungo
  const runs: typeof vis[] = [];
  let cur: typeof vis = [];
  for (const v of vis) {
    if (cur.length && v.ms - cur[cur.length - 1].ms > 6000) { runs.push(cur); cur = []; }
    cur.push(v);
  }
  if (cur.length) runs.push(cur);
  vis = runs.sort((x, y) => y.length - x.length)[0];
  const first = vis[0], last = vis[vis.length - 1];
  const top = vis.reduce((m, v) => (v.el > m.el ? v : m), vis[0]);
  const mag = vis.reduce((m, v) => Math.min(m, v.mag), 99);
  const durS = (last.ms - first.ms) / 1000;
  // solo i passaggi che valgono la pena: almeno un minuto, ben alti o molto luminosi
  if (durS < 60 || !(top.el >= 30 || mag <= -2)) return null;
  const overhead = top.el > 75 ? tr(' (quasi sopra la testa)') : '';
  const shadow = last.el > 15 ? tr(' Poi entra nell\'ombra della Terra e svanisce a metà cielo.') : '';
  const brightTxt = mag < -3 ? tr('più brillante di qualsiasi stella') : mag < -1.5 ? tr('luminosa come le stelle più brillanti') : mag < 1 ? tr('ben visibile a occhio nudo') : 'debole';
  return {
    time: new Date(top.ms), kind: 'passaggio', group: 'satelliti',
    title: tr('Passaggio visibile {of}', { of: sat.of }),
    detail: tr('Un punto luminoso che attraversa il cielo in {v0}, senza lampeggiare.{shadow}', { v0: durS < 90 ? tr('{n} secondi', { n: Math.round(durS) }) : tr('{n} minuti', { n: fmt(durS / 60, 0) }), shadow }),
    local: tr('{v0}: dalle {v1} (a {v2}) alle {v3} (a {v4}), ', { v0: cap(s.from), v1: s.clock(new Date(first.ms)), v2: compass(first.az), v3: s.clock(new Date(last.ms)), v4: compass(last.az) })
      + tr('alta fino a {v0}°{overhead} alle {v2}. Magnitudine {v3}: {brightTxt}.', { v0: fmt(top.el, 0), overhead, v2: s.clock(new Date(top.ms)), v3: fmt(mag, 1), brightTxt }),
    visible: true,
    focus: 'naif:399', norad: sat.norad,
    importance: top.el > 50 && mag < -2.5 ? 2 : 3,
  };
}

// ------------------------------------------------------------------ stasera

const PHASE_IT = (deg: number, illum: number): string => {
  if (illum < 0.03) return tr('Luna nuova');
  if (illum > 0.97) return tr('Luna piena');
  const waxing = deg < 180;
  if (Math.abs(illum - 0.5) < 0.06) return waxing ? tr('primo quarto') : tr('ultimo quarto');
  return illum < 0.5 ? (waxing ? tr('falce crescente') : tr('falce calante')) : (waxing ? tr('gibbosa crescente') : tr('gibbosa calante'));
};

export function tonight(ms: number, place: Place = DEFAULT_PLACE): Tonight {
  const s = new Site(place);
  const t = A.MakeTime(new Date(ms));
  // se è già notte, la notte in corso; altrimenti la prossima
  const night = s.alt(A.Body.Sun, t) < -0.833;
  const sunset = night ? A.SearchRiseSet(A.Body.Sun, s.obs, -1, t.AddDays(-1), 1) : A.SearchRiseSet(A.Body.Sun, s.obs, -1, t, 1);
  const startT = sunset ?? t;
  const sunrise = A.SearchRiseSet(A.Body.Sun, s.obs, +1, startT, 1.2);
  let polar: Tonight['polar'] = null;
  if (!sunset || !sunrise) polar = s.alt(A.Body.Sun, t) > 0 ? 'giorno' : 'notte';
  const darkFrom = sunset ? A.SearchAltitude(A.Body.Sun, s.obs, -1, sunset, 0.6, -18) : null;
  const darkTo = darkFrom ? A.SearchAltitude(A.Body.Sun, s.obs, +1, darkFrom, 0.8, -18) : null;
  const illum = A.Illumination(A.Body.Moon, startT).phase_fraction;
  const phase = PHASE_IT(A.MoonPhase(startT), illum);
  const moonRise = A.SearchRiseSet(A.Body.Moon, s.obs, +1, startT.AddDays(-0.2), 1);
  const moonSet = A.SearchRiseSet(A.Body.Moon, s.obs, -1, startT.AddDays(-0.2), 1);
  const planets: Tonight['planets'] = [];
  const endT = sunrise ?? startT.AddDays(0.5);
  const steps = Math.max(4, Math.round((endT.ut - startT.ut) * 96)); // ogni quarto d'ora
  for (const name of ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn'] as const) {
    const body = A.Body[name];
    let from: A.AstroTime | null = null, to: A.AstroTime | null = null, maxAlt = -90, maxAz = 0;
    for (let k = 0; k <= steps; k++) {
      const tt = A.MakeTime(startT.ut + ((endT.ut - startT.ut) * k) / steps);
      if (s.alt(A.Body.Sun, tt) > -6) continue;
      const h = s.hor(body, tt);
      if (h.altitude > 8) {
        if (!from) from = tt;
        to = tt;
        if (h.altitude > maxAlt) { maxAlt = h.altitude; maxAz = h.azimuth; }
      }
    }
    if (from && to) {
      planets.push({ name: PLANETS_IT[name], id: PLANET_ID[name], from: from.date, to: to.date, maxAlt, dir: compass(maxAz), mag: A.Illumination(body, from).mag });
    }
  }
  return {
    sunset: sunset?.date ?? null, sunrise: sunrise?.date ?? null,
    darkFrom: darkFrom?.date ?? null, darkTo: darkTo?.date ?? null, polar,
    moon: { phase, illum, rise: moonRise?.date ?? null, set: moonSet?.date ?? null },
    planets,
  };
}

// ------------------------------------------------------------------ tutto insieme

export function computeEvents(t0: Date, t1: Date, place: Place = DEFAULT_PLACE, sats: SatInput[] = []): AstroEvent[] {
  const s = new Site(place);
  const all: AstroEvent[] = [];
  const safe = (f: () => AstroEvent[]) => {
    try {
      all.push(...f());
    } catch (e) {
      console.warn(tr('Eventi: calcolo non riuscito'), e);
    }
  };
  safe(() => lunarEclipses(t0, t1, s));
  safe(() => solarEclipses(t0, t1, s));
  safe(() => oppositions(t0, t1, s));
  safe(() => elongations(t0, t1, s));
  safe(() => transits(t0, t1, s));
  safe(() => conjunctions(t0, t1, s));
  safe(() => moonPhases(t0, t1, s));
  safe(() => seasons(t0, t1, s));
  safe(() => earthApsides(t0, t1, s));
  safe(() => meteorShowers(t0, t1, s));
  for (const sat of sats) safe(() => satellitePasses(sat, t0, t1, s));
  return all.sort((a, b) => a.time.getTime() - b.time.getTime());
}

/** per il pannello: lo stesso Site, così gli orari della Terra combaciano con quelli degli eventi */
export function siteFor(place: Place): Site {
  return new Site(place);
}
export type { Site };

/** Alba e tramonto del giorno che contiene `ms` (per la scheda della Terra). */
export function sunTimes(ms: number, place: Place): { rise: Date | null; set: Date | null; ms: number | null; polar: 'giorno' | 'notte' | null } {
  const s = new Site(place);
  // dall'inizio del giorno locale approssimato (longitudine / 15 ore)
  const localMid = Math.floor((ms + (place.lon / 15) * 3600000) / DAY) * DAY - (place.lon / 15) * 3600000;
  const d = dayLength(s, A.MakeTime(new Date(localMid)));
  return { rise: d.rise?.date ?? null, set: d.set?.date ?? null, ms: d.ms, polar: d.polar };
}

