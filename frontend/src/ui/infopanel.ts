/** Pannello informativo del corpo selezionato: dati in tempo reale, caratteristiche, scheda. */

import { t } from '../core/i18n';
import { Matrix3, Vector3 } from 'three';
import { marked } from 'marked';
import type { Body } from '../sim/body';
import { SOURCE_LABEL } from '../sim/body';
import type { Universe } from '../sim/universe';
import { DEEP_KINDS } from '../data/types';
import { galacticLB } from '../core/galactic';
import { decimalSep, lang, locale } from '../core/i18n';
import { constellationNames } from '../data/names';
import { api, type DsoPhoto, type HrHistogram, type TextureCredit } from '../data/api';
import { MODELS, sunVisibility } from '../render/spacecraft';
import { sizeComparison } from './sizecompare';
import { starNature, tempToBv, tempToCss } from '../core/stellar';
import { hrDiagram } from './hrdiagram';
import { ORBIT_CLASS_IT } from '../data/classes';
import { M_ICRF_TO_ECL, raDec } from '../core/frames';
import {
  fmtDays, fmtDistance, fmtDMS, fmtDuration, fmtField, fmtIsoDate, fmtKm, fmtLightTime, fmtNum, fmtRA, fmtSci, fmtSig, fmtSpeed,
} from '../core/format';
import { fieldAt } from '../render/magnetosphere';
import { AU_KM, DEG, G_KM3_KG_S2, LUNAR_DISTANCE_KM, LY_KM, PC_KM } from '../core/units';
import { osculating } from '../ephem/kepler';
import { poleOf } from '../ephem/rotation';
import { seasonInfo, type SeasonInfo } from '../core/seasons';
import { Body as ABody, Equator, Horizon, MakeTime, Observer, SearchRiseSet, Seasons as earthSeasons } from 'astronomy-engine';
import { DEFAULT_PLACE, fmtClock, fromPlace, validTz, type Place } from '../core/places';
import { clear, h } from './dom';
import { kindLabel, OBJTYPE_IT, OPS_IT, OWNER_IT, SITE_IT } from './lexicon';

interface Row {
  label: string;
  value: HTMLElement;
  alt?: HTMLElement;
}

const _v = new Vector3();
const _w = new Vector3();
const _m = new Matrix3();
const _rs = new Vector3();
const _vs = new Vector3();
const _pl = new Vector3();

const SEASON_LABEL: Record<SeasonInfo['north'], string> = {
  primavera: t('primavera'), estate: t('estate'), autunno: t('autunno'), inverno: t('inverno'),
};

/** "11,2 volte la Terra", "metà della Terra", "un quarto della Terra"... */
function timesEarth(k: number): string {
  if (k >= 1.05) return t('{v0} volte la Terra', { v0: fmtSig(k, 3) });
  if (k > 0.95) return t('circa come la Terra');
  return t('{v0}% della Terra', { v0: fmtNum(k * 100, k < 0.1 ? 1 : 0) });
}

/** Il prossimo equinozio o solstizio della Terra dopo l'istante `ms`. */
function nextEarthSeason(ms: number): { name: string; next: string; date: Date } | null {
  const y = new Date(ms).getUTCFullYear();
  for (const yy of [y, y + 1]) {
    try {
      const s = earthSeasons(yy);
      const list: [string, string, Date][] = [
        [t('equinozio di marzo'), t('Prossimo equinozio'), s.mar_equinox.date], [t('solstizio di giugno'), t('Prossimo solstizio'), s.jun_solstice.date],
        [t('equinozio di settembre'), t('Prossimo equinozio'), s.sep_equinox.date], [t('solstizio di dicembre'), t('Prossimo solstizio'), s.dec_solstice.date],
      ];
      for (const [name, next, date] of list) if (date.getTime() > ms) return { name, next, date };
    } catch { /* fuori dall'intervallo del modello */ }
  }
  return null;
}

export class InfoPanel {
  readonly root: HTMLElement;
  private body: Body | null = null;
  private live: Record<string, Row> = {};
  private liveBox: HTMLElement;
  private orbitBox: HTMLElement;
  private seasonBox: HTMLElement;
  private seasonSection: HTMLElement;
  private staticBox: HTMLElement;
  private titleEl: HTMLElement;
  private subtitleEl: HTMLElement;
  private sourceEl: HTMLElement;
  private heroValue: HTMLElement;
  private heroAlt: HTMLElement;
  private heroLabel: HTMLElement;
  private lastOrbitUpdate = 0;
  private lastLive = 0;
  private token = 0;
  private surfaceBtn: HTMLButtonElement;
  private surfaceOn = false;
  private measureBtn: HTMLButtonElement;
  private favBtn: HTMLButtonElement;
  private measureEl: HTMLElement;
  /** misura delle distanze: corpo di partenza (null = nessuna misura in corso) */
  measureFrom: Body | null = null;
  onMeasure: (from: Body | null) => void = () => {};
  /** preferiti: per nome, così valgono anche per asteroidi, satelliti e stelle */
  isFavorite: (name: string) => boolean = () => false;
  onFavorite: (name: string) => void = () => {};
  onClose: () => void = () => {};
  onFly: (b: Body) => void = () => {};
  /** mostra la superficie sotto le nubi (Venere, Titano) o di nuovo l'atmosfera */
  onSurface: (b: Body, on: boolean) => void = () => {};
  /** luogo dell'osservatore: alba e tramonto nella scheda della Terra */
  observer: Place = DEFAULT_PLACE;
  private sunCache: { key: string; text: string } | null = null;
  /** autori e licenza di una texture */
  textureCredit: (name: string) => Promise<TextureCredit | null> = async () => null;
  /** crediti di una foto del cielo profondo */
  photoCredit: (name: string) => Promise<DsoPhoto | null> = async () => null;

  constructor(parent: HTMLElement, private universe: Universe) {
    this.titleEl = h('h2', { class: 'info-title' });
    this.subtitleEl = h('p', { class: 'info-subtitle' });
    this.heroLabel = h('div', { class: 'hero-label' });
    this.heroValue = h('div', { class: 'hero-value' });
    this.heroAlt = h('div', { class: 'hero-alt' });
    this.liveBox = h('div', { class: 'readouts' });
    this.orbitBox = h('div', { class: 'readouts' });
    this.seasonBox = h('div', { class: 'readouts' });
    this.seasonSection = h('section', { class: 'orbit-section season-section' }, h('h3', {}, t('Stagioni')), this.seasonBox);
    this.staticBox = h('div', { class: 'static' });
    this.sourceEl = h('p', { class: 'source-note' });
    const close = h('button', { class: 'icon-btn close', 'aria-label': t('Chiudi il pannello'), title: t('Chiudi (Esc)'), onclick: () => this.onClose() }, '×');
    const fly = h('button', { class: 'btn', onclick: () => this.body && this.onFly(this.body) }, t('Inquadra'));
    this.surfaceBtn = h('button', {
      class: 'btn',
      title: t('Le sonde e i radar hanno mappato anche ciò che le nubi nascondono'),
      onclick: () => {
        if (!this.body) return;
        this.surfaceOn = !this.surfaceOn;
        this.onSurface(this.body, this.surfaceOn);
        this.updateSurfaceLabel();
      },
    }) as HTMLButtonElement;
    this.measureBtn = h('button', {
      class: 'btn',
      title: t('Misura la distanza fra questo corpo e un altro: premi qui, poi seleziona l\'altro corpo'),
      onclick: () => {
        if (!this.body) return;
        this.onMeasure(this.measureFrom ? null : this.body);
        this.syncTools();
        this.update(true);
      },
    }) as HTMLButtonElement;
    this.favBtn = h('button', {
      class: 'btn', title: t('Aggiungi ai preferiti o togli: i preferiti compaiono aprendo la ricerca'),
      onclick: () => {
        if (!this.body) return;
        this.onFavorite(this.body.name);
        this.syncTools();
      },
    }) as HTMLButtonElement;
    this.measureEl = h('p', { class: 'measure-note' });
    this.measureEl.hidden = true;
    this.root = h('aside', { class: 'info panel', 'aria-live': 'polite' },
      h('header', { class: 'info-head' }, this.titleEl, close),
      this.subtitleEl,
      h('div', { class: 'info-actions' }, fly, this.surfaceBtn, this.measureBtn, this.favBtn),
      this.measureEl,
      h('section', { class: 'hero' }, this.heroLabel, this.heroValue, this.heroAlt),
      this.liveBox,
      this.sourceEl,
      h('section', { class: 'orbit-section' }, h('h3', {}, t('Orbita in questo istante')), this.orbitBox),
      this.seasonSection,
      this.staticBox,
    );
    this.root.hidden = true;
    parent.appendChild(this.root);
  }

  get current(): Body | null {
    return this.body;
  }

  show(b: Body): void {
    if (this.body && this.surfaceOn) this.onSurface(this.body, false);
    this.body = b;
    this.token++;
    this.root.hidden = false;
    this.root.scrollTop = 0;
    this.titleEl.textContent = b.name;
    this.subtitleEl.textContent = kindLabel(b);
    this.syncTools();
    this.surfaceOn = false;
    this.surfaceBtn.hidden = !b.data.texture_alt;
    this.updateSurfaceLabel();
    this.buildLive(b);
    clear(this.orbitBox);
    this.lastOrbitUpdate = 0;
    clear(this.staticBox);
    (this.orbitBox.parentElement as HTMLElement).hidden = (b.kind === 'star' && !b.data.sky_orbit) || !b.parent || DEEP_KINDS.has(b.kind);
    clear(this.seasonBox);
    this.seasonSection.hidden = !((b.kind === 'planet' || b.kind === 'dwarf') && b.data.rotation?.model === 'iau' && b.parent?.id === 'naif:10');
    void this.loadStatic(b, this.token);
    this.update(true);
  }

  hide(): void {
    if (this.body && this.surfaceOn) this.onSurface(this.body, false);
    this.surfaceOn = false;
    this.body = null;
    this.root.hidden = true;
  }

  private updateSurfaceLabel(): void {
    this.surfaceBtn.textContent = this.surfaceOn ? t('Mostra le nubi') : t('Guarda sotto le nubi');
    this.surfaceBtn.setAttribute('aria-pressed', String(this.surfaceOn));
  }

  // ------------------------------------------------------------ dati in tempo reale
  private row(box: HTMLElement, key: string, label: string, withAlt = false): void {
    const value = h('dd', {});
    const alt = withAlt ? h('span', { class: 'alt' }) : undefined;
    const dd = alt ? h('div', { class: 'dd-wrap' }, value, alt) : value;
    box.append(h('div', { class: 'row' }, h('dt', {}, label), dd));
    this.live[key] = { label, value, alt };
  }

  private buildLive(b: Body): void {
    clear(this.liveBox);
    this.live = {};
    const isEarth = b.id === 'naif:399';
    const sat = b.kind === 'satellite';
    const star = !!b.extra.star;
    const box = h('dl', { class: 'grid' });
    this.liveBox.append(box);
    if (star) {
      this.heroLabel.textContent = t('Distanza dal Sole');
      this.row(box, 'camdist', t('Distanza dalla camera'), true);
      this.row(box, 'gl', t('Longitudine galattica'));
      this.row(box, 'gb', t('Latitudine galattica'));
      return;
    }
    if (DEEP_KINDS.has(b.kind)) {
      this.heroLabel.textContent = t('Distanza dalla Terra');
      this.row(box, 'sundist', t('Distanza dal Sole'), true);
      this.row(box, 'light', t('La sua luce, per arrivare qui, viaggia da'));
      this.row(box, 'ra', t('Ascensione retta (dalla Terra)'));
      this.row(box, 'dec', t('Declinazione (dalla Terra)'));
      this.row(box, 'gl', t('Longitudine galattica'));
      this.row(box, 'gb', t('Latitudine galattica'));
      this.row(box, 'camdist', t('Distanza dalla camera'), true);
      return;
    }
    this.heroLabel.textContent = sat ? t('Quota sulla superficie terrestre') : isEarth ? t('Distanza dal Sole') : t('Distanza dalla Terra');
    if (sat) {
      this.row(box, 'gvel', t('Velocità rispetto alla Terra'));
      this.row(box, 'sunlit', t('Luce del Sole'));
      this.row(box, 'lat', t('Latitudine'));
      this.row(box, 'lon', t('Longitudine'));
    }
    if (!isEarth && b.kind !== 'star') this.row(box, 'sundist', t('Distanza dal Sole'), true);
    if (!isEarth && !sat) this.row(box, 'light', t('La luce dalla Terra impiega'));
    this.row(box, 'hvel', t('Velocità rispetto al Sole'));
    if (b.parent && b.parent.kind !== 'star' && b.parent.kind !== 'barycenter' && !sat) {
      this.row(box, 'pvel', t('Velocità rispetto {v0}', { v0: b.parent.id === 'naif:399' ? t('alla Terra') : t('a {nome}', { nome: b.parent.name }) }));
    }
    if (!isEarth && b.kind !== 'star') {
      this.row(box, 'ra', t('Ascensione retta (dalla Terra)'));
      this.row(box, 'dec', t('Declinazione (dalla Terra)'));
    }
    if (b.data.magnetic?.b_eq_nt) this.row(box, 'bcam', t('Campo magnetico alla camera'));
    const xyz = h('dl', { class: 'grid xyz' });
    this.liveBox.append(h('h4', {}, t('Coordinate eliocentriche ICRF, in km')), xyz);
    this.row(xyz, 'x', 'X');
    this.row(xyz, 'y', 'Y');
    this.row(xyz, 'z', 'Z');
  }

  /** Pulsanti «Misura» e «Preferito»: testo secondo lo stato. */
  syncTools(): void {
    this.measureBtn.textContent = this.measureFrom ? t('Fine misura') : t('Misura da qui');
    this.measureBtn.classList.toggle('primary', !!this.measureFrom);
    const fav = !!this.body && this.isFavorite(this.body.name);
    this.favBtn.textContent = fav ? t('★ Preferito') : t('☆ Preferito');
    this.favBtn.setAttribute('aria-pressed', String(fav));
  }

  private updateMeasure(b: Body): void {
    const a = this.measureFrom;
    let text = '';
    if (a && a === b) text = t('Misura da {name}: ora seleziona un altro corpo (con un clic o dalla ricerca).', { name: a.name });
    else if (a && a.valid && b.valid) {
      const d = _v.subVectors(b.pos, a.pos).length();
      const dd = fmtDistance(d);
      text = t('Distanza da {name}: {main} ({alt}). La luce impiega {v3}.', { name: a.name, main: dd.main, alt: dd.alt, v3: fmtLightTime(d) });
    }
    this.measureEl.hidden = !text;
    if (text && this.measureEl.textContent !== text) this.measureEl.textContent = text;
  }

  /** Chiamato a ogni fotogramma (si aggiorna ~10 volte al secondo). */
  update(force = false): void {
    const b = this.body;
    if (!b || this.root.hidden) return;
    const now = performance.now();
    if (!force && now - this.lastLive < 100) return;
    this.lastLive = now;
    this.updateMeasure(b);
    const U = this.universe;
    const set = (k: string, v: string, alt?: string) => {
      const r = this.live[k];
      if (!r) return;
      if (r.value.textContent !== v) r.value.textContent = v;
      if (r.alt && alt !== undefined && r.alt.textContent !== alt) r.alt.textContent = alt;
    };
    if (!b.valid && b.extra.endReason && b.extra.endJd !== undefined && this.universe.jd > b.extra.endJd) {
      this.heroValue.textContent = t('Non esiste più');
      this.heroAlt.textContent = b.extra.endReason;
      this.sourceEl.textContent = '';
      return;
    }
    if (!b.valid) {
      this.heroValue.textContent = t('In attesa dei dati');
      this.heroAlt.textContent = b.jpl?.lastError ? `JPL: ${b.jpl.lastError}` : t('La posizione arriverà da NASA/JPL fra pochi istanti.');
      this.sourceEl.textContent = '';
      return;
    }
    const sun = U.sun, earth = U.earth;
    const camKm = this.universe.cameraPos ? _w.subVectors(b.scenePos, this.universe.cameraPos).length() : NaN;
    const galLB = () => {
      const g = galacticLB(_v.subVectors(b.pos, sun.pos));
      set('gl', `${fmtNum(g.l, 3)}°`);
      set('gb', `${g.b >= 0 ? '+' : '−'}${fmtNum(Math.abs(g.b), 3)}°`);
    };
    if (b.extra.star) {
      const d = _v.subVectors(b.pos, sun.pos).length();
      const dd = fmtDistance(d);
      this.heroValue.textContent = dd.main;
      this.heroAlt.textContent = t('{alt}, cioè {v1}', { alt: dd.alt, v1: fmtKm(d) });
      if (Number.isFinite(camKm)) { const c = fmtDistance(camKm); set('camdist', c.main, c.alt); }
      galLB();
      this.sourceEl.textContent = SOURCE_LABEL[b.source];
      return;
    }
    if (DEEP_KINDS.has(b.kind)) {
      const dE = _v.subVectors(b.pos, earth.pos).length();
      const de = fmtDistance(dE);
      this.heroValue.textContent = de.main;
      this.heroAlt.textContent = de.alt;
      const ds = fmtDistance(_v.subVectors(b.pos, sun.pos).length());
      set('sundist', ds.main, ds.alt);
      set('light', fmtLightTime(dE));
      const rd = raDec(_v.subVectors(b.pos, earth.pos));
      set('ra', fmtRA(rd.ra));
      set('dec', fmtDMS(rd.dec));
      galLB();
      if (Number.isFinite(camKm)) { const c = fmtDistance(camKm); set('camdist', c.main, c.alt); }
      this.sourceEl.textContent = b.data.fixed?.model_kpc
        ? t('Posizione: modello della Via Lattea (Reid et al. 2019; distanza dal centro: GRAVITY 2021)')
        : t('Posizione: coordinate e distanza dalla letteratura scientifica (vedi la scheda)');
      return;
    }
    const fromEarth = _v.subVectors(b.pos, earth.pos);
    const dEarth = fromEarth.length();
    const fromSun = _w.subVectors(b.pos, sun.pos);
    const dSun = fromSun.length();
    if (b.kind === 'satellite') {
      const r = b.relPos.length();
      this.heroValue.textContent = fmtKm(r - 6371.0);
      this.heroAlt.textContent = t('a {v0} dal centro della Terra', { v0: fmtKm(r) });
    } else if (b.id === 'naif:399') {
      const dd = fmtDistance(dSun);
      this.heroValue.textContent = dd.main;
      this.heroAlt.textContent = t('{alt}; la luce del Sole arriva in {v1}', { alt: dd.alt, v1: fmtLightTime(dSun) });
    } else {
      const dd = fmtDistance(dEarth);
      this.heroValue.textContent = dd.main;
      this.heroAlt.textContent = dd.alt;
    }
    const ds = fmtDistance(dSun);
    set('sundist', ds.main, ds.alt);
    set('light', fmtLightTime(dEarth));
    set('hvel', fmtSpeed(_w.copy(b.vel).sub(sun.vel).length()));
    set('pvel', fmtSpeed(b.relVel.length()));
    const rd = raDec(fromEarth);
    set('ra', fmtRA(rd.ra));
    set('dec', fmtDMS(rd.dec));
    if (this.live.bcam && this.universe.cameraPos) {
      // il campo del corpo nel punto in cui si trova la camera (cala con il cubo della distanza)
      const f = fieldAt(b, this.universe.cameraPos);
      if (f) set('bcam', f.inside ? fmtField(f.nT) : b.data.magnetic?.model === 'source_surface' ? t('oltre la superficie sorgente') : t('fuori dalla magnetosfera'));
    }
    const helio = _w.subVectors(b.pos, sun.pos);
    set('x', fmtNum(helio.x, 0));
    set('y', fmtNum(helio.y, 0));
    set('z', fmtNum(helio.z, 0));
    if (b.kind === 'satellite') {
      const r = b.relPos.length();
      set('gvel', fmtSpeed(b.relVel.length()));
      // coordinate geografiche: si riporta il vettore nel sistema solidale alla Terra
      _m.copy(earth.orient).transpose();
      const f = _v.copy(b.relPos).applyMatrix3(_m);
      const lat = Math.asin(f.z / r) / DEG;
      const lon = Math.atan2(f.y, f.x) / DEG;
      set('lat', `${fmtNum(Math.abs(lat), 3)}° ${lat >= 0 ? 'N' : 'S'}`);
      // giorno o notte orbitale: quanto del disco del Sole si vede dal satellite
      const moon = earth.children.find((c) => c.id === 'naif:301');
      const lit = sunVisibility(b.scenePos, sun, moon ? [earth, moon] : [earth]);
      set('sunlit', lit > 0.995 ? t('piena (giorno orbitale)') : lit < 0.005 ? t('nell\'ombra della Terra (notte orbitale)')
        : t('in penombra ({v0}% del disco del Sole)', { v0: fmtNum(lit * 100, 0) }));
      set('lon', `${fmtNum(Math.abs(lon), 3)}° ${lon >= 0 ? 'E' : 'O'}`);
    }
    this.sourceEl.textContent = t('Posizione: {v0}', { v0: SOURCE_LABEL[b.source] });
    if (now - this.lastOrbitUpdate > 1000) {
      this.lastOrbitUpdate = now;
      this.updateOrbit(b);
      if (!this.seasonSection.hidden) this.updateSeasons(b);
    }
  }

  /** Stagioni dalla geometria vera: asse fisso nello spazio e posizione lungo l'orbita. */
  private updateSeasons(b: Body): void {
    const sun = this.universe.sun;
    const si = seasonInfo(poleOf(b.orient, _pl), _rs.subVectors(b.pos, sun.pos), _vs.subVectors(b.vel, sun.vel));
    clear(this.seasonBox);
    if (!si) return;
    const dl = h('dl', { class: 'grid' });
    const add = (k: string, v: string, wide = false) => dl.append(h('div', { class: wide ? 'row wide' : 'row' }, h('dt', {}, k), h('dd', {}, v)));
    add(t('Inclinazione dell\'asse'), `${fmtNum(si.obliquityDeg, 2)}°`);
    const lat = si.subsolarLatDeg;
    add(t('Sole allo zenit sopra'), t('{v0}° di latitudine {v1}', { v0: fmtNum(Math.abs(lat), 1), v1: lat >= 0 ? 'nord' : 'sud' }));
    if (si.weak) {
      add(t('Stagioni'), t('appena accennate: l\'asse è quasi perpendicolare all\'orbita'), true);
    } else {
      // a un grado da un equinozio o da un solstizio: la stagione sta cambiando
      const toEdge = Math.min(si.ls % 90, 90 - (si.ls % 90));
      const turning = toEdge < 1;
      const q = Math.round(si.ls / 90) % 4;
      const ORDER = ['primavera', 'estate', 'autunno', 'inverno'] as const;
      const WITH_ART: Record<string, string> = { primavera: t('la primavera'), estate: t('l\'estate'), autunno: t('l\'autunno'), inverno: t('l\'inverno') };
      add(t('Stagione'), turning
        ? t('{v0}: inizia {v1} a nord, {v2} a sud', { v0: q % 2 === 0 ? t('equinozio') : t('solstizio'), v1: WITH_ART[ORDER[q]], v2: WITH_ART[ORDER[(q + 2) % 4]] })
        : t('{v0} a nord, {v1} a sud', { v0: SEASON_LABEL[si.north], v1: SEASON_LABEL[si.south] }), true);
      add(t('Ai poli'), Math.abs(lat) < 0.3
        ? t('il Sole scorre lungo l\'orizzonte, a entrambi i poli')
        : lat > 0 ? t('giorno polare al polo nord, notte polare al polo sud') : t('giorno polare al polo sud, notte polare al polo nord'), true);
    }
    if (b.id === 'naif:499') add(t('Longitudine solare (Ls)'), `${fmtNum(si.ls, 1)}°`);
    if (b.id === 'naif:399') {
      const st = this.sunriseSunset(this.simMs());
      if (st) add(t('Sole {v0}', { v0: fromPlace(this.observer) }), st, true);
      const nx = nextEarthSeason(this.simMs());
      if (nx) {
        const d = nx.date;
        const tz = validTz(this.observer.tz);
        add(nx.next, t('{v0}, ore {v1}', { v0: d.toLocaleDateString(locale(), { day: 'numeric', month: 'long', year: 'numeric', timeZone: tz }), v1: fmtClock(d, tz) }));
      }
    }
    this.seasonBox.append(dl);
    const note = b.id === 'naif:799'
      ? t('Urano ruota quasi "sdraiato": a turno ogni polo resta al Sole per circa 42 anni e poi al buio per altri 42.')
      : si.weak
        ? t('Senza un asse inclinato i raggi del Sole arrivano sempre con lo stesso angolo: non c\'è un\'estate né un inverno.')
        : t('L\'asse resta puntato sempre nella stessa direzione dello spazio mentre il pianeta gira attorno al Sole: per metà dell\'orbita i raggi più diretti cadono sull\'emisfero nord, per l\'altra metà su quello sud. Sono le stagioni.');
    this.seasonBox.append(h('p', { class: 'muted small' }, note));
  }

  /** "sorge alle 6:49 e tramonta alle 16:59: 10 h 10 min di luce" per il giorno simulato */
  private sunriseSunset(ms: number): string | null {
    const p = this.observer;
    // inizio del giorno locale (approssimato dalla longitudine): basta per trovare alba e tramonto giusti
    const off = (p.lon / 15) * 3600000;
    const mid = Math.floor((ms + off) / 86400000) * 86400000 - off;
    const key = `${p.lat},${p.lon},${mid}`;
    if (this.sunCache?.key === key) return this.sunCache.text;
    let text: string | null = null;
    try {
      const obs = new Observer(p.lat, p.lon, p.elev ?? 0);
      const rise = SearchRiseSet(ABody.Sun, obs, +1, new Date(mid), 1);
      const set = rise ? SearchRiseSet(ABody.Sun, obs, -1, rise, 1) : null;
      if (rise && set && set.date.getTime() - mid < 1.5 * 86400000) {
        const m = Math.round((set.date.getTime() - rise.date.getTime()) / 60000);
        text = t('sorge alle {v0} e tramonta alle {v1}: {v2} h {v3} min di luce', { v0: fmtClock(rise.date, p.tz), v1: fmtClock(set.date, p.tz), v2: Math.floor(m / 60), v3: m % 60 });
      } else {
        // né alba né tramonto oggi: giorno o notte polare (si guarda il Sole a mezzogiorno)
        const noon = MakeTime(new Date(mid + 12 * 3600000));
        const eq = Equator(ABody.Sun, noon, obs, true, true);
        const alt = Horizon(noon, obs, eq.ra, eq.dec, 'normal').altitude;
        text = alt > 0 ? t('il Sole non tramonta (giorno polare)') : t('il Sole non sorge (notte polare)');
      }
    } catch {
      text = null;
    }
    this.sunCache = { key, text: text ?? '' };
    return text;
  }

  /** istante simulato (ms): dal giorno giuliano dell'universo */
  private simMs(): number {
    return (this.universe.jd - 2440587.5) * 86400000;
  }

  private updateOrbit(b: Body): void {
    const p = b.parent;
    if (!p || b.kind === 'star') return;
    const mu = b.muAroundParent;
    const o = mu > 0 ? osculating(b.relPos, b.relVel, mu) : null;
    clear(this.orbitBox);
    if (!o) {
      this.orbitBox.append(h('p', { class: 'muted' }, t('Orbita non calcolabile: manca la massa del corpo centrale.')));
      return;
    }
    const names = p.id === 'naif:10' ? [t('Perielio'), t('Afelio')] : p.id === 'naif:399' ? [t('Perigeo'), t('Apogeo')] : [t('Pericentro'), t('Apocentro')];
    const dl = h('dl', { class: 'grid' });
    const add = (k: string, v: string) => dl.append(h('div', { class: 'row' }, h('dt', {}, k), h('dd', {}, v)));
    const dist = (km: number) => (p.id === 'naif:10' ? `${fmtNum(km / AU_KM, km / AU_KM < 10 ? 4 : 2)} ${t('UA')}` : fmtKm(km));
    // inclinazione: rispetto all'eclittica per i corpi che orbitano il Sole, rispetto all'equatore del pianeta per le lune
    const W = o.W;
    let incl: number, ref: string;
    if (p.id === 'naif:10') {
      const we = _v.copy(W).applyMatrix3(M_ICRF_TO_ECL);
      incl = Math.acos(Math.max(-1, Math.min(1, we.z))) / DEG;
      ref = t('rispetto all\'eclittica');
    } else {
      const pole = poleOf(p.orient, _w);
      incl = Math.acos(Math.max(-1, Math.min(1, W.dot(pole)))) / DEG;
      ref = p.id === 'naif:399' ? t('rispetto all\'equatore terrestre') : t('rispetto all\'equatore di {name}', { name: p.name });
    }
    if (o.e < 1) add(t('Semiasse maggiore'), dist(o.a));
    add(t('Eccentricità'), fmtNum(o.e, o.e < 0.01 ? 5 : 4));
    add(t('Inclinazione {ref}', { ref }), `${fmtNum(incl, 3)}°`);
    add(names[0], dist(o.q));
    if (o.Q !== null) add(names[1], dist(o.Q));
    if (o.period) add(t('Periodo orbitale'), fmtDuration(o.period / 3600));
    if (o.e >= 1) add(t('Velocità d\'uscita (all\'infinito)'), fmtSpeed(Math.sqrt(-mu / o.a)));
    if (b.kind === 'satellite' && o.period) add(t('Giri al giorno'), fmtNum(86400 / o.period, 2));
    this.orbitBox.append(dl);
    this.orbitBox.append(h('p', { class: 'muted small' }, t('Orbita osculatrice: la conica che il corpo percorrerebbe se da ora agisse solo la gravità del corpo centrale.')));
  }

  // ------------------------------------------------------------ dati statici e schede
  private section(title: string, ...content: (Node | string)[]): HTMLElement {
    const s = h('section', { class: 'block' }, h('h3', {}, title), ...content);
    this.staticBox.append(s);
    return s;
  }

  private dl(rows: [string, string | null | undefined][]): HTMLElement {
    const dl = h('dl', { class: 'grid facts' });
    for (const [k, v] of rows) {
      if (v === null || v === undefined || v === '') continue;
      dl.append(h('div', { class: 'row' }, h('dt', {}, k), h('dd', {}, v)));
    }
    return dl;
  }

  private async loadStatic(b: Body, token: number): Promise<void> {
    if (b.extra.star) return this.loadStar(b, token);
    if (b.kind === 'satellite') return this.loadSatellite(b, token);
    if (b.kind !== 'spacecraft') this.physSection(b);
    else {
      this.missionSection(b);
      this.modelSizeSection(b);
    }

    let hasContent = false;
    if (!b.dynamic && b.data.has_content) {
      try {
        const full = await api.body(b.id);
        if (token !== this.token) return;
        if (full.content_md) {
          const html = await marked.parse(full.content_md);
          if (token !== this.token) return;
          const art = h('article', { class: 'prose', html });
          this.staticBox.append(art);
          hasContent = true;
        }
      } catch { /* scheda non disponibile */ }
    }
    if (b.data.sbdb || b.dynamic) {
      const des = b.data.sbdb ?? b.id.replace(/^sb:/, '');
      try {
        const sb = await api.smallBody(des);
        if (token !== this.token) return;
        this.sbdbSection(sb);
      } catch { /* SBDB non raggiungibile */ }
    }
    if (!hasContent) await this.wikiSection(b.data.wiki ?? b.name, token, b.data.wiki ? b.data.wiki_lang : undefined);
    else if (b.data.wiki) this.wikiLink(b.data.wiki, b.data.wiki_lang);
    await this.textureNote(b, token);
  }

  /** In fondo alla scheda: chi ha realizzato la mappa della superficie e con quale licenza. */
  private async textureNote(b: Body, token: number): Promise<void> {
    const names = [b.data.texture, b.data.texture_alt].filter((n): n is string => !!n);
    const lines: HTMLElement[] = [];
    for (const [i, name] of names.entries()) {
      const c = await this.textureCredit(name);
      if (token !== this.token) return;
      if (!c) continue;
      const what = names.length > 1 ? (i === 0 ? t('Mappa (come appare da fuori)') : t('Mappa della superficie')) : t('Mappa della superficie');
      const who = (c.autori ?? []).join('; ');
      const lic = c.licenza
        ? (c.licenza_url ? h('a', { class: 'link', href: c.licenza_url, target: '_blank', rel: 'noopener' }, licenseLabel(c.licenza)) : licenseLabel(c.licenza))
        : '';
      const src = c.url ? h('a', { class: 'link', href: c.url, target: '_blank', rel: 'noopener' }, c.fonte ?? 'fonte') : (c.fonte ?? '');
      lines.push(h('p', {}, `${what}: ${who}${who ? ' — ' : ''}`, src, lic ? t(', licenza ') : '', lic));
    }
    if (b.data.photo) {
      const ph = await this.photoCredit(b.data.photo);
      if (token !== this.token) return;
      if (ph) {
        const who = ph.crediti.map((c) => (c.url ? h('a', { class: 'link', href: c.url, target: '_blank', rel: 'noopener' }, c.autore) : c.autore));
        const parts: (Node | string)[] = [t('Foto: ')];
        who.forEach((w, i) => parts.push(...(i ? ['; ', w] : [w])));
        parts.push(t(' — dalla raccolta di '), h('a', { class: 'link', href: ph.url, target: '_blank', rel: 'noopener' }, ph.fonte),
          t('. Vista dalla Terra coincide con il cielo vero; da altre direzioni si vede il modello 3D.'));
        lines.push(h('p', {}, ...parts));
      }
    }
    const model = b.extra.modelKey ? MODELS.spec(b.extra.modelKey as string) : null;
    if (model) {
      const c = model.credit;
      const link = (text: string, url: string) => h('a', { class: 'link', href: url, target: '_blank', rel: 'noopener' }, text);
      if (model.procedural) {
        lines.push(h('p', {}, t('Modello 3D semplificato, costruito sulle dimensioni vere della sonda ('), link(c.fonte, c.url), ').',
          model.note ? ` ${model.note}` : ''));
      } else {
        lines.push(h('p', {}, t('Modello 3D: {autori} — ', { autori: c.autori }), link(c.fonte, c.url), ', ', link(c.licenza, c.licenza_url), '.',
          model.note ? ` ${model.note}` : ''));
      }
    }
    if (lines.length) this.staticBox.append(h('div', { class: 'credits muted small' }, ...lines));
  }

  private physSection(b: Body): void {
    const ph = b.data.phys ?? {};
    const R = ph.radius_km ?? (b.radius > 0 ? b.radius : undefined);
    const M = ph.mass_kg;
    const gm = ph.gm_km3s2 ?? (M ? M * G_KM3_KG_S2 : undefined);
    const vol = R ? (4 / 3) * Math.PI * R ** 3 : undefined;
    const solid = !DEEP_KINDS.has(b.kind);
    const density = ph.density_gcm3 ?? (solid && M && vol ? (M * 1000) / (vol * 1e15) : undefined);
    const gravity = ph.gravity_ms2 ?? (solid && gm && R ? (gm / (R * R)) * 1000 : undefined);
    const escape = ph.escape_kms ?? (solid && gm && R ? Math.sqrt((2 * gm) / R) : undefined);
    const earthM = 5.9722e24, sunM = 1.98847e30;
    const bh = b.kind === 'blackhole';
    const deep = DEEP_KINDS.has(b.kind);
    const rows: [string, string | undefined][] = [
      [bh ? t('Raggio dell\'orizzonte degli eventi') : t('Raggio medio'),
        R && !deep ? `${fmtKm(R)}${R > 1000 && b.id !== 'naif:399' ? ` (${timesEarth(R / 6371.0)})` : ''}`
          : R && bh ? t('{v0} ({v1} UA)', { v0: fmtKm(R), v1: fmtSig(R / AU_KM, 3) }) : undefined],
      [t('Dimensioni'), ph.dimensions],
      [t('Massa'), M ? (M > 1e29 ? fmtSolarMasses(M / sunM) : `${fmtSci(M, 4)} kg${M > 1e21 && b.id !== 'naif:399' ? ` (${fmtSig(M / earthM, 3)} ${Math.abs(M / earthM - 1) < 0.005 ? t('massa terrestre') : t('masse terrestri')})` : ''}`) : undefined],
      [t('Classificazione'), ph.morphology],
      [t('Densità media'), density ? `${fmtNum(density, 3)} g/cm³` : undefined],
      [t('Gravità alla superficie'), gravity ? `${fmtSig(gravity, 3)} m/s² (${fmtSig(gravity / 9.80665, 3)} g)` : undefined],
      [t('Velocità di fuga'), escape ? `${fmtSig(escape, 3)} km/s` : undefined],
      [t('Rotazione (periodo siderale)'), ph.rotation_h !== undefined ? fmtDuration(ph.rotation_h) : undefined],
      [t('Durata del giorno solare'), ph.solar_day_h !== undefined ? fmtDuration(ph.solar_day_h) : undefined],
      [t('Inclinazione dell\'asse'), ph.obliquity_deg !== undefined ? `${fmtNum(ph.obliquity_deg, 2)}°` : undefined],
      [t('Temperatura media'), ph.temp_c !== undefined ? `${fmtNum(ph.temp_c, 0)} °C` : undefined],
      [t('Escursione termica'), ph.temp_range_c ? t('da {v0} a {v1} °C', { v0: fmtNum(ph.temp_range_c[0], 0), v1: fmtNum(ph.temp_range_c[1], 0) }) : undefined],
      [t('Temperatura superficiale'), ph.temp_surface_k ? `${fmtNum(ph.temp_surface_k, 0)} K (${fmtNum(ph.temp_surface_k - 273.15, 0)} °C)` : undefined],
      [t('Temperatura del nucleo'), ph.temp_core_k ? t('circa {v0} milioni di K', { v0: fmtSig(ph.temp_core_k / 1e6, 3) }) : undefined],
      [t('Pressione al suolo'), ph.pressure_bar !== undefined && ph.pressure_bar > 0 ? `${fmtSig(ph.pressure_bar, 3)} bar` : undefined],
      [t('Albedo'), ph.albedo !== undefined ? String(ph.albedo).replace('.', decimalSep()) : undefined],
      [t('Luminosità'), ph.luminosity_w ? `${fmtSci(ph.luminosity_w, 4)} W` : undefined],
      [t('Tipo spettrale'), ph.spectral],
      [t('Età'), ph.age_gyr ? t('{v0} miliardi di anni', { v0: fmtNum(ph.age_gyr, 1) }) : undefined],
      [t('Lune conosciute'), ph.moons !== undefined ? (ph.moons_note ?? String(ph.moons)) : undefined],
      [t('Periodo orbitale'), ph.period_y ? t('circa {v0} anni', { v0: fmtNum(ph.period_y, ph.period_y < 10 ? 1 : 0) }) : undefined],
      [t('Eccentricità'), ph.eccentricity ? fmtNum(ph.eccentricity, 2) : undefined],
    ];
    if (rows.some(([, v]) => v)) this.section(t('Caratteristiche fisiche'), this.dl(rows));
    const mag = b.data.magnetic;
    if (mag) {
      // inclinazione dell'asse magnetico rispetto a quello di rotazione e spostamento del centro
      const tilt = 90 - mag.pole_lat;
      const off = Math.hypot(...mag.offset_r);
      const offKm = off * (R ?? b.radius);
      const star = mag.model === 'source_surface';
      const edge = t('circa {v0} raggi ({v1})', { v0: fmtNum(mag.magnetopause_r, mag.magnetopause_r < 5 ? 2 : 0), v1: fmtKm(mag.magnetopause_r * (R ?? b.radius)) });
      const bEq = mag.b_eq_nt;
      const EARTH_EQ_NT = 29_400;   // dipolo terrestre all'equatore (IGRF-14)
      const FRIDGE_NT = 5e6;        // una calamita da frigorifero, circa 5 mT
      const ratio = bEq ? bEq / EARTH_EQ_NT : 0;
      const strength: [string, string | undefined][] = !bEq ? [] : star ? [
        [t('Intensità ai poli'), t('circa {v0}, molto variabile; nelle macchie solari fino a circa 0,3 T', { v0: fmtField(2 * bEq) })],
      ] : [
        [t('Intensità alla superficie'), t('circa {eq} all\'equatore, {pole} ai poli', { eq: fmtField(bEq), pole: fmtField(2 * bEq) })],
        b.id === 'naif:399'
          ? [t('Per confronto'), t('una calamita da frigorifero fa circa 5 mT: {v0} volte di più', { v0: fmtNum(FRIDGE_NT / bEq, 0) })]
          : [t('Rispetto alla Terra'), ratio >= 1.5 ? t('circa {v0} volte più intenso', { v0: fmtSig(ratio, 2) })
            : ratio > 0.67 ? t('più o meno come quello della Terra') : t('circa {v0} volte più debole', { v0: fmtSig(1 / ratio, 2) })],
      ];
      this.section(t('Campo magnetico'), this.dl(star ? [
        ...strength,
        [t('Forma'), t('un grande dipolo, come una calamita, vicino al minimo dell\'attività; al massimo diventa un groviglio')],
        [t('Polarità'), t('si inverte a ogni ciclo, circa ogni 11 anni')],
        [t('Superficie sorgente'), t('{edge}: oltre, il vento solare trascina via le linee', { edge })],
      ] : [
        ...strength,
        [t('Asse magnetico'), tilt < 0.5 ? t('quasi allineato all\'asse di rotazione') : t('inclinato di {v0}° rispetto all\'asse di rotazione', { v0: fmtNum(tilt, tilt < 20 ? 1 : 0) })],
        [t('Centro del campo'), off < 0.005 ? t('al centro del corpo') : t('spostato di {v0} raggi ({v1}) dal centro', { v0: fmtNum(off, 2), v1: fmtKm(offKm) })],
        [t('Polarità'), mag.moment_north ? t('una bussola punterebbe verso sud (al contrario della Terra di oggi)') : t('una bussola punterebbe verso nord, come sulla Terra')],
        [mag.flow === 'corotation' ? t('Magnetopausa (lato da cui arriva il plasma di Giove)') : t('Magnetopausa (lato del Sole)'), edge],
      ]), h('p', { class: 'muted small' },
        star ? t('Linee azzurre: archi chiusi, tornano sul Sole. Viola: aperte, portate via dal vento solare. Tasto M per nasconderle. ')
          : mag.flow === 'corotation' ? t('Linee azzurre: chiuse, tornano sulla luna. Viola: aperte, stirate nella direzione in cui scorre il plasma di Giove. Tasto M per nasconderle. ')
            : t('Linee azzurre: chiuse, tornano sul pianeta. Viola: aperte, nella coda opposta al Sole. Tasto M per nasconderle. '),
        mag.lon_known === false ? t('La direzione del polo magnetico attorno all\'asse è indicativa: il periodo di rotazione non è noto con abbastanza precisione da sapere dove si trova oggi. ') : '',
        t('Fonte: {src}.', { src: mag.src }),
        mag.b_src ? t(' Intensità: {src}.', { src: mag.b_src }) : ''));
    } else if (b.data.field_note) {
      this.section(t('Campo magnetico'), h('p', { class: 'small' }, b.data.field_note));
    }
    const rings = b.data.rings;
    if (rings?.src) {
      this.section(t('Anelli'), this.dl([
        [t('Estensione'), t('da {v0} a {v1} dal centro', { v0: fmtKm(rings.inner_km), v1: fmtKm(rings.outer_km) })],
      ]), h('p', { class: 'muted small' }, `${rings.src}.`));
    }
    if (R && !deep && b.kind !== 'barycenter') this.sizeSection(b, 2 * R, false);
    const d = ph.discovery;
    if (d) {
      this.section(t('Scoperta'), this.dl([
        [t('Scopritore'), d.by],
        [t('Data'), d.date ? fmtIsoDate(d.date) : undefined],
        [t('Luogo'), d.place],
        [t('Metodo'), d.method],
      ]));
    }
  }

  /** "Quanto è grande?": in scala, accanto a qualcosa di familiare. */
  private sizeSection(b: Body, D: number, isModel: boolean): void {
    const color = b.id === 'naif:399' ? '#5d8ed8' : b.kind === 'star' ? (b.data.color ?? '#ffd27a') : (b.data.color ?? '#9a9a9a');
    const el = sizeComparison({ name: b.name, D, color, kind: b.kind, id: b.id, isModel });
    if (el) this.section(t('Quanto è grande?'), el);
  }

  /** Sonde e satelliti con il modello 3D: la loro lunghezza massima, accanto a un autobus o a un campo. */
  private modelSizeSection(b: Body): void {
    const key = b.extra.modelKey as string | undefined;
    const spec = key ? MODELS.spec(key) : null;
    if (spec) this.sizeSection(b, Math.max(...spec.size_m) / 1000, true);
  }

  private missionSection(b: Body): void {
    const ph = b.data.phys ?? {};
    this.section(t('Missione'), this.dl([
      [t('Agenzia'), ph.agency],
      [t('Stato'), ph.status],
      [t('Lancio'), ph.launch?.date ? fmtIsoDate(ph.launch.date) : undefined],
      [t('Vettore'), ph.launch?.vehicle],
      [t('Base di lancio'), ph.launch?.site],
      [t('Massa al lancio'), ph.mass_launch_kg ? `${fmtNum(ph.mass_launch_kg, 0)} kg` : undefined],
    ]));
  }

  private sbdbSection(sb: Record<string, any>): void {
    if (sb.error) return;
    const phys = sb.phys ?? {};
    const pv = (k: string) => (phys[k]?.value ?? null) as string | null;
    const diam = pv('diameter');
    const rows: [string, string | null | undefined][] = [
      [t('Designazione completa'), sb.fullname],
      [t('Classe orbitale'), sb.orbit_class_code ? ORBIT_CLASS_IT[sb.orbit_class_code] ?? sb.orbit_class : sb.orbit_class],
      [t('Potenzialmente pericoloso (PHA)'), sb.pha === true ? t('Sì') : sb.pha === false ? t('No') : null],
      [t('Diametro stimato'), diam ? `${fmtNum(parseFloat(diam), parseFloat(diam) < 10 ? 2 : 0)} km` : null],
      [t('Albedo'), pv('albedo')?.replace('.', decimalSep())],
      [t('Periodo di rotazione'), pv('rot_per') ? fmtDuration(parseFloat(pv('rot_per')!)) : null],
      [t('Magnitudine assoluta (H)'), pv('H')?.replace('.', decimalSep())],
      [t('Distanza minima dall\'orbita terrestre (MOID)'), sb.moid_au ? t('{v0} UA ({v1})', { v0: fmtSig(sb.moid_au, 4), v1: fmtKm(sb.moid_au * AU_KM) }) : null],
      [t('Osservazioni usate per l\'orbita'), sb.n_obs_used ? String(sb.n_obs_used) : null],
      [t('Arco osservativo'), sb.data_arc_days ? fmtDays(sb.data_arc_days) : null],
    ];
    this.section(t('Dal JPL Small-Body Database'), this.dl(rows));
    const disc = sb.discovery;
    if (disc && (disc.who || disc.date)) {
      this.section(t('Scoperta (JPL)'), this.dl([
        [t('Scopritore'), disc.who],
        [t('Data'), disc.date],
        [t('Luogo'), disc.location ?? disc.site],
      ]));
    }
    const ca = sb.close_approaches as any[] | undefined;
    if (ca && ca.length) {
      const tbl = h('table', { class: 'ca' },
        h('thead', {}, h('tr', {}, h('th', {}, t('Data')), h('th', {}, t('Distanza')), h('th', {}, t('Velocità')))),
        h('tbody', {}, ...ca.slice(0, 12).map((r) => h('tr', {},
          h('td', {}, String(r.date ?? '').replace(/ \d\d:\d\d$/, '')),
          h('td', {}, r.dist_au ? t('{v0} distanze lunari', { v0: fmtSig((r.dist_au * AU_KM) / LUNAR_DISTANCE_KM, 3) }) : '—'),
          h('td', {}, r.v_rel_kms ? fmtSpeed(r.v_rel_kms) : '—'),
        ))),
      );
      this.section(t('Prossimi passaggi vicino alla Terra'), tbl, h('p', { class: 'muted small' }, t('Entro 0,2 UA, nei prossimi 100 anni. Una distanza lunare = 384.400 km.')));
    }
  }

  /** Riassunto di Wikipedia; wikiLang è la lingua della voce indicata (se manca: quella dell'interfaccia). */
  private async wikiSection(title: string, token: number, wikiLang?: string): Promise<void> {
    try {
      const w = await api.wiki(title, wikiLang);
      if (token !== this.token || !w.extract) return;
      const s = this.section(t('Da Wikipedia'), h('p', { class: 'prose-p' }, w.extract));
      if (w.url) s.append(h('a', { class: 'link', href: w.url, target: '_blank', rel: 'noopener' }, t('Leggi la voce completa su Wikipedia')));
    } catch { /* nessuna voce */ }
  }

  private wikiLink(title: string, wikiLang = 'it'): void {
    const url = `https://${/^[a-z]{2}$/.test(wikiLang) ? wikiLang : 'it'}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
    this.staticBox.append(h('p', { class: 'more' }, h('a', { class: 'link', href: url, target: '_blank', rel: 'noopener' }, t('Approfondisci su Wikipedia'))));
  }

  private async loadSatellite(b: Body, token: number): Promise<void> {
    const o = b.extra.omm;
    const rows: [string, string | undefined][] = [
      [t('Numero NORAD'), String(o.NORAD_CAT_ID)],
      [t('Designazione internazionale (COSPAR)'), o.OBJECT_ID],
      [t('Inclinazione'), `${fmtNum(o.INCLINATION, 2)}°`],
      [t('Rivoluzioni al giorno'), fmtNum(o.MEAN_MOTION, 3)],
      [t('Epoca degli elementi'), new Date(o.EPOCH + (o.EPOCH.endsWith('Z') ? '' : 'Z')).toLocaleString(locale())],
    ];
    this.section(t('Elementi orbitali (CelesTrak)'), this.dl(rows));
    this.modelSizeSection(b);
    try {
      const s = await api.satellite(o.NORAD_CAT_ID);
      if (token !== this.token) return;
      this.section(t('Catalogo SATCAT'), this.dl([
        [t('Tipo di oggetto'), s.type ? OBJTYPE_IT[s.type] ?? s.type : undefined],
        [t('Stato'), s.status ? OPS_IT[s.status] ?? s.status : undefined],
        [t('Proprietario'), s.owner ? OWNER_IT[s.owner] ?? s.owner : undefined],
        [t('Data di lancio'), s.launch_date ? fmtIsoDate(s.launch_date) : undefined],
        [t('Base di lancio'), s.launch_site ? SITE_IT[s.launch_site] ?? s.launch_site : undefined],
        [t('Apogeo'), s.apogee_km ? `${fmtNum(s.apogee_km, 0)} km` : undefined],
        [t('Perigeo'), s.perigee_km ? `${fmtNum(s.perigee_km, 0)} km` : undefined],
        [t('Periodo'), s.period_min ? `${fmtNum(s.period_min, 1)} min` : undefined],
        [t('Sezione radar (RCS)'), s.rcs_m2 ? `${fmtNum(s.rcs_m2, 2)} m²` : undefined],
      ]));
    } catch { /* SATCAT non disponibile */ }
    if (/^ISS \(/.test(o.OBJECT_NAME)) await this.wikiSection(t('Stazione Spaziale Internazionale'), token);
    else if (/TIANGONG|TIANHE|^CSS/.test(o.OBJECT_NAME)) await this.wikiSection(t('Stazione spaziale Tiangong'), token);
    else if (/HST|HUBBLE/.test(o.OBJECT_NAME)) await this.wikiSection(t('Telescopio spaziale Hubble'), token);
    if (token === this.token) await this.textureNote(b, token);
  }

  /** Che tipo di stella è: nome comune, spiegazione, temperatura, luminosità, raggio, diagramma H-R. */
  private async starNatureSection(b: Body, s: Record<string, any>, catalog: string, token: number): Promise<void> {
    const absmag = typeof s.absmag === 'number' ? s.absmag : (b.extra.absmag as number | undefined);
    if (absmag === undefined) return;
    const ci = b.extra.ci as number | undefined;
    const nat = starNature(absmag, ci ?? null, s.spect ?? null);
    const css = tempToCss(nat.temperatureK);
    const title = nat.name.charAt(0).toUpperCase() + nat.name.slice(1);
    const head = h('p', { class: 'star-kind' }, h('span', { class: 'kind-dot', style: { background: css, boxShadow: `0 0 10px ${css}` } }), title);
    const sec = this.section(t('Che stella è'), head,
      h('p', { class: 'prose-p' }, nat.note),
      this.dl([
        [t('Temperatura della superficie'), t('circa {v0} K', { v0: fmtNum(Math.round(nat.temperatureK / 50) * 50, 0) })],
        [t('Luminosità totale'), fmtStarLum(nat.luminositySun)],
        [t('Raggio'), fmtStarRadius(nat.radiusSun)],
      ]),
      h('p', { class: 'muted small' }, nat.estimated
        ? t('Tipo stimato dal colore e dalla luminosità: il catalogo non riporta la classe spettrale.')
        : t('Dalla classe spettrale {v0}. Temperatura e raggio sono stime da relazioni medie.', { v0: nat.spectral?.raw ?? '' })),
    );
    hrCache ??= api.starHr(catalog).catch(() => null);
    const hist = await hrCache;
    if (token !== this.token || !hist) return;
    const bv = ci !== undefined && Number.isFinite(ci) ? ci : tempToBv(nat.temperatureK);
    const fig = h('figure', { class: 'hr' },
      hrDiagram(hist, { bv, mag: absmag, label: b.name.length > 22 ? t('questa stella') : b.name }),
      h('figcaption', { class: 'muted small' },
        t('Diagramma di Hertzsprung-Russell: {v0} stelle del catalogo secondo colore e luminosità. ', { v0: fmtNum(hist.total, 0) })
        + t('Non si spargono a caso: si raccolgono in famiglie che raccontano le fasi della vita di una stella.')));
    sec.append(fig);
  }

  private async loadStar(b: Body, token: number): Promise<void> {
    try {
      const { catalog, id } = b.extra.star as { catalog: string; id: string };
      const s = await api.starInfo(catalog, id);
      if (token !== this.token) return;
      await this.starNatureSection(b, s, catalog, token);
      if (token !== this.token) return;
      const con = s.con ? (await constellations())[s.con] ?? s.con : undefined;
      const ids = [
        s.hip ? `HIP ${s.hip}` : null, s.hd ? `HD ${s.hd}` : null, s.hr ? `HR ${s.hr}` : null, s.gliese,
        s.gaia_dr3 ? t('Gaia DR3 {gaia_dr3}', { gaia_dr3: s.gaia_dr3 }) : null,
      ].filter(Boolean).join(', ');
      this.section(t('Stella'), this.dl([
        [t('Costellazione'), con],
        [t('Magnitudine apparente (dalla Terra)'), s.mag !== undefined ? fmtNum(s.mag, 2) : undefined],
        [t('Magnitudine G di Gaia (dalla Terra)'), s.mag_g !== undefined ? fmtNum(s.mag_g, 2) : undefined],
        [t('Parallasse'), s.plx_mas !== undefined ? t('{v0} millesimi di secondo d\'arco', { v0: fmtSig(s.plx_mas, 4) }) : undefined],
        [t('Magnitudine assoluta'), fmtNum(s.absmag, 2)],
        [t('Luminosità nel visibile'), s.lum ? t('{v0} volte il Sole', { v0: fmtSig(s.lum, 3) }) : undefined],
        [t('Tipo spettrale'), s.spect ?? undefined],
        [t('Distanza'), s.dist_uncertain ? t('incerta (parallasse non affidabile)') : t('{v0} anni luce', { v0: fmtSig((s.dist_pc * PC_KM) / LY_KM, 4) })],
        [t('Variabile'), s.var ?? undefined],
        [t('Nei cataloghi'), ids || undefined],
      ]));
      if (b.radius > 0) this.sizeSection(b, 2 * b.radius, false);
      const title = s.proper ?? null;
      // in italiano la voce ha il nome italiano; nelle altre lingue il nome proprio IAU
      if (title) await this.wikiSection(lang() === 'it' ? s.name_it ?? title : title, token);
    } catch { /* dati non disponibili */ }
  }
}

const R_SUN_KM = 695700;
const AU_PER_RSUN = R_SUN_KM / AU_KM;

/** Il raggio di una stella detto in modo che si capisca. */
function fmtStarRadius(rSun: number): string {
  if (rSun < 0.05) {
    const km = rSun * R_SUN_KM;
    return t('circa {v0} ({v1} della Terra)', { v0: fmtKm(Math.round(km / 100) * 100), v1: km < 9000 ? t('poco meno') : km < 16000 ? t('più o meno') : t('un po\' più') });
  }
  const au = rSun * AU_PER_RSUN;
  const orbit = au > 5.2 ? t('più grande dell\'orbita di Giove') : au > 1.52 ? t('più grande dell\'orbita di Marte')
    : au > 1.0 ? t('più grande dell\'orbita della Terra') : au > 0.72 ? t('più grande dell\'orbita di Venere')
      : au > 0.39 ? t('più grande dell\'orbita di Mercurio') : null;
  return t('{v0} volte il Sole{v1}', { v0: fmtSig(rSun, rSun < 10 ? 2 : 3), v1: orbit ? t(' ({v0} UA: {orbit})', { v0: fmtSig(au, 2), orbit }) : '' });
}

function fmtStarLum(l: number): string {
  if (l >= 1e4) return t('{v0} mila volte il Sole', { v0: fmtSig(l / 1000, 3) });
  if (l >= 0.1) return t('{v0} volte il Sole', { v0: fmtSig(l, 3) });
  return t('1/{v0} del Sole', { v0: fmtSig(1 / l, 2) });
}

let hrCache: Promise<HrHistogram | null> | null = null;

function fmtSolarMasses(x: number): string {
  if (x >= 1e9) return t('{v0} miliardi di masse solari', { v0: fmtSig(x / 1e9, 4) });
  if (x >= 1e6) return t('{v0} milioni di masse solari', { v0: fmtSig(x / 1e6, 4) });
  return t('{v0} masse solari', { v0: fmtSig(x, 4) });
}

/** "CC-BY-SA-4.0" -> "CC BY-SA 4.0" (come la scrive Creative Commons) */
function licenseLabel(spdx: string): string {
  const m = /^CC-(.+)-(\d\.\d)$/.exec(spdx);
  if (m) return `CC ${m[1]} ${m[2]}`;
  if (spdx === 'CC0-1.0') return t('CC0 (pubblico dominio)');
  if (spdx.startsWith('GPL-2.0')) return t('GNU GPL 2.0 o successiva');
  if (spdx === 'NASA') return t('materiale NASA, uso libero');
  return spdx;
}

const constellations = constellationNames;
