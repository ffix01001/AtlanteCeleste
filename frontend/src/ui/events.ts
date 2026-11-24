/**
 * Pannello degli eventi: cosa succede in cielo nei prossimi mesi (o anni), a partire dalla
 * data della simulazione e visto dal luogo dell'osservatore. In cima, il riepilogo della
 * notte: tramonto, buio, Luna e pianeti visibili. Ogni evento ha il pulsante "Vai": porta il
 * tempo a quel momento e la camera sul corpo giusto (la Luna color rame in un'eclissi,
 * l'ombra della Luna sulla Terra in un'eclissi di Sole, Marte all'opposizione, la Stazione
 * spaziale durante un suo passaggio...).
 *
 * I calcoli girano in un worker: per cinque anni servono fino a un paio di secondi.
 */

import { t, tn } from '../core/i18n';
import { exportLanguage, locale } from '../core/i18n';
import { api, type CloseApproach } from '../data/api';
import type { AstroEvent, EventGroup, SatInput, Tonight } from '../events/astroevents';
import { DEFAULT_PLACE, fmtClock, fmtWhenFull, fromPlace, localParts, type Place } from '../core/places';
import { PlacePicker, tzNote } from './place';
import { clear, h } from './dom';

const GROUPS: [EventGroup, string][] = [
  ['eclissi', t('Eclissi')], ['pianeti', t('Pianeti')], ['meteore', t('Meteore')], ['satelliti', t('Stazioni spaziali')],
  ['asteroidi', t('Asteroidi')], ['luna', t('Luna')], ['terra', t('Stagioni')],
];

const LD_KM = 384400;
const AU_KM = 149597870.7;

// nomi dei mesi nella lingua scelta (in italiano: gennaio, febbraio, ...)
const MONTHS = Array.from({ length: 12 }, (_, i) =>
  new Intl.DateTimeFormat(locale(), { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2000, i, 15))));

/** "2026-Nov-03 14:22" (CNEOS, tempo dinamico ≈ UTC) -> Date */
function parseCneosDate(s: string): Date | null {
  const m = /^(\d{4})-(\w{3})-(\d{2}) (\d{2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(m[2]);
  if (mon < 0) return null;
  return new Date(Date.UTC(+m[1], mon, +m[3], +m[4], +m[5]));
}

function approachEvent(a: CloseApproach): AstroEvent | null {
  const when = a.date ? parseCneosDate(a.date) : null;
  if (!when || a.dist_au === null) return null;
  const km = a.dist_au * AU_KM;
  const ld = km / LD_KM;
  const size = a.diameter_m
    ? (a.diameter_m[1] >= 1000
      ? t('Diametro stimato fra {v0} e {v1} km.', { v0: (a.diameter_m[0] / 1000).toLocaleString(locale(), { maximumFractionDigits: 1 }), v1: (a.diameter_m[1] / 1000).toLocaleString(locale(), { maximumFractionDigits: 1 }) })
      : t('Diametro stimato fra {v0} e {v1} metri.', { v0: a.diameter_m[0], v1: a.diameter_m[1] }))
    : '';
  const near = ld < 1 ? t(' Più vicino della Luna!') : '';
  return {
    time: when, kind: 'avvicinamento', group: 'asteroidi',
    title: t('{name} passa vicino alla Terra', { name: a.name }),
    detail: t('A {v0} distanze lunari ', { v0: ld.toLocaleString(locale(), { maximumFractionDigits: ld < 10 ? 1 : 0 }) })
      + t('({v0} mila km), a {v1} km/s. {size}{near}', { v0: Math.round(km / 1000).toLocaleString(locale()), v1: (a.v_rel_kms ?? 0).toLocaleString(locale(), { maximumFractionDigits: 1 }), size, near }),
    focus: 'naif:399', sbdes: a.des ?? undefined,
    importance: ld < 1 || (a.diameter_m && a.diameter_m[0] > 300) ? 1 : ld < 5 ? 2 : 3,
  };
}

interface WorkerReply {
  id: number;
  events?: AstroEvent[];
  tonight?: Tonight | null;
  error?: string;
}

export class EventsPanel {
  readonly root: HTMLElement;
  private list: HTMLElement;
  private note: HTMLElement;
  private night: HTMLElement;
  private foot: HTMLElement;
  private picker: PlacePicker;
  private rangeYears = 1;
  private enabled = new Set<EventGroup>(['eclissi', 'pianeti', 'meteore', 'satelliti', 'asteroidi']);
  private events: AstroEvent[] = [];
  private approaches: AstroEvent[] = [];
  private approachNote = '';
  private tonightInfo: Tonight | null = null;
  private computedFor = 0;
  private computedYears = 0;
  private computedPlace = '';
  private worker: Worker | null = null;
  private reqId = 0;
  /** porta la simulazione all'evento */
  onGo: (ev: AstroEvent) => void = () => {};
  /** il luogo è cambiato (da salvare nelle impostazioni) */
  onPlace: (p: Place) => void = () => {};
  /** data della simulazione (ms) */
  simTime: () => number = () => Date.now();
  /** satelliti di cui calcolare i passaggi (elementi orbitali di CelesTrak) */
  satellites: () => SatInput[] = () => [];

  constructor(parent: HTMLElement, place: Place = DEFAULT_PLACE) {
    this.list = h('div', { class: 'ev-list' });
    this.note = h('p', { class: 'muted small ev-note' });
    this.night = h('section', { class: 'ev-night' });
    this.foot = h('p', { class: 'muted small ev-foot' });
    this.picker = new PlacePicker(place);
    this.picker.onChange = (p) => {
      this.onPlace(p);
      this.refresh(true);
    };
    const close = h('button', { class: 'icon-btn close', 'aria-label': t('Chiudi'), title: t('Chiudi (E)'), onclick: () => this.toggle(false) }, '×');
    const rangeBtns = [1, 5].map((y) => {
      const b = h('button', { class: 'chip', 'aria-pressed': String(y === this.rangeYears), onclick: () => this.setRange(y, rangeBtns) }, y === 1 ? t('12 mesi') : t('5 anni'));
      return b;
    });
    const chips = GROUPS.map(([g, label]) => {
      const b = h('button', { class: 'chip', 'aria-pressed': String(this.enabled.has(g)) }, label);
      b.addEventListener('click', () => {
        if (this.enabled.has(g)) this.enabled.delete(g); else this.enabled.add(g);
        b.setAttribute('aria-pressed', String(this.enabled.has(g)));
        this.render();
      });
      return b;
    });
    this.root = h('aside', { class: 'events panel', role: 'dialog', 'aria-label': t('Eventi astronomici') },
      h('header', { class: 'ev-head' }, h('h2', {}, t('Eventi in cielo')), close),
      this.picker.root,
      this.night,
      h('div', { class: 'chips' }, ...rangeBtns),
      h('div', { class: 'chips' }, ...chips),
      this.note,
      this.list,
      this.foot,
    );
    this.root.hidden = true;
    parent.appendChild(this.root);
  }

  get open(): boolean {
    return !this.root.hidden;
  }

  get place(): Place {
    return this.picker.current;
  }

  toggle(force?: boolean): void {
    this.root.hidden = force === undefined ? !this.root.hidden : !force;
    if (!this.root.hidden) this.refresh();
  }

  private setRange(y: number, btns: HTMLElement[]): void {
    this.rangeYears = y;
    btns.forEach((b, i) => b.setAttribute('aria-pressed', String([1, 5][i] === y)));
    this.refresh();
  }

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    try {
      this.worker = new Worker(new URL('../workers/events.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<WorkerReply>) => this.onReply(e.data);
      // il worker scrive le descrizioni degli eventi: gli serve la lingua scelta
      this.worker.postMessage({ i18n: exportLanguage() });
      this.worker.onerror = () => {
        this.worker = null;
      };
    } catch {
      this.worker = null;
    }
    return this.worker;
  }

  private onReply(r: WorkerReply): void {
    if (r.id !== this.reqId) return; // risposta superata
    if (r.error || !r.events) {
      this.list.replaceChildren(h('p', { class: 'muted' }, t('Calcolo degli eventi non riuscito.')));
      return;
    }
    // le date attraversano il worker come Date (clonazione strutturata)
    this.events = r.events;
    this.tonightInfo = r.tonight ?? null;
    this.render();
  }

  /** Ricalcola se la data della simulazione è cambiata di più di qualche ora, o il luogo. */
  private refresh(force = false): void {
    const now = this.simTime();
    const place = this.place;
    const key = `${place.lat.toFixed(3)},${place.lon.toFixed(3)},${place.tz}`;
    if (!force && Math.abs(now - this.computedFor) < 3 * 3600000 && this.computedYears === this.rangeYears && this.computedPlace === key) {
      this.render();
      return;
    }
    this.computedFor = now;
    this.computedYears = this.rangeYears;
    this.computedPlace = key;
    const t0 = now;
    const t1 = now + this.rangeYears * 365.25 * 86400000;
    this.list.replaceChildren(h('p', { class: 'muted' }, t('Calcolo in corso…')));
    const id = ++this.reqId;
    const sats = this.satellites();
    const w = this.ensureWorker();
    if (w) {
      w.postMessage({ id, t0, t1, place, sats, nowMs: now });
    } else {
      // senza worker: nel thread principale (lo stesso codice)
      void import('../events/astroevents').then(({ computeEvents, tonight }) => {
        setTimeout(() => {
          let night: Tonight | null = null;
          try { night = tonight(now, place); } catch { /* */ }
          this.onReply({ id, events: computeEvents(new Date(t0), new Date(t1), place, sats), tonight: night });
        }, 30);
      }).catch(() => this.list.replaceChildren(h('p', { class: 'muted' }, t('Calcolo degli eventi non riuscito.'))));
    }
    this.approaches = [];
    this.approachNote = t('Passaggi ravvicinati: caricamento…');
    const days = Math.round(this.rangeYears * 365.25);
    api.closeApproaches(days).then((r) => {
      this.approaches = r.approaches.map(approachEvent).filter((e): e is AstroEvent => !!e && e.time.getTime() >= now);
      this.approachNote = '';
      this.render();
    }).catch(() => {
      this.approachNote = t('Passaggi ravvicinati degli asteroidi non disponibili: serve la connessione a internet (NASA/JPL CNEOS).');
      this.render();
    });
  }

  private renderNight(): void {
    clear(this.night);
    const n = this.tonightInfo;
    if (!n) {
      this.night.hidden = true;
      return;
    }
    this.night.hidden = false;
    const tz = this.place.tz;
    const c = (d: Date | null) => (d ? fmtClock(d, tz) : '—');
    const title = n.polar === 'giorno' ? t('Oggi il Sole non tramonta') : n.polar === 'notte' ? t('Oggi il Sole non sorge') : t('Stanotte');
    const lines: HTMLElement[] = [];
    if (!n.polar) {
      lines.push(h('li', {}, h('b', {}, t('Sole')), t(' tramonta alle {v0}, sorge alle {v1}', { v0: c(n.sunset), v1: c(n.sunrise) })
        + (n.darkFrom && n.darkTo ? t('; buio completo dalle {v0} alle {v1}', { v0: c(n.darkFrom), v1: c(n.darkTo) }) : t('; il cielo non diventa mai del tutto buio'))));
    }
    const m = n.moon;
    const moonTimes = [m.rise ? t('sorge alle {v0}', { v0: c(m.rise) }) : '', m.set ? t('tramonta alle {v0}', { v0: c(m.set) }) : ''].filter(Boolean).join(', ');
    lines.push(h('li', {}, h('b', {}, t('Luna')), t(' {phase}, illuminata al {v1}%{v2}', { phase: m.phase, v1: Math.round(m.illum * 100), v2: moonTimes ? `; ${moonTimes}` : '' })));
    if (n.planets.length) {
      for (const p of n.planets) {
        const mag = p.mag.toLocaleString(locale(), { maximumFractionDigits: 1, minimumFractionDigits: 1 });
        lines.push(h('li', {}, h('b', {}, p.name),
          t(' dalle {v0} alle {v1}, alto fino a {v2}° verso {dir} (magnitudine {mag})', { v0: c(p.from), v1: c(p.to), v2: Math.round(p.maxAlt), dir: p.dir, mag })));
      }
    } else {
      lines.push(h('li', { class: 'muted' }, t('Nessun pianeta luminoso ben visibile stanotte.')));
    }
    const passes = this.events.filter((e) => e.group === 'satelliti' && n.sunset && n.sunrise && e.time >= n.sunset && e.time <= n.sunrise);
    if (passes.length) lines.push(h('li', {}, h('b', {}, t('Stazione spaziale')), t(' {v0}: vedi l\'elenco qui sotto', { v0: tn(passes.length, 'un passaggio visibile', '{n} passaggi visibili') })));
    this.night.append(h('h3', {}, `${title} ${fromPlace(this.place)}`), h('ul', { class: 'night-list' }, ...lines));
  }

  private render(): void {
    const tz = this.place.tz;
    this.renderNight();
    this.foot.textContent = t('Visibilità e orari {v0} ({v1}). Calcoli: Astronomy Engine (D. Cross), satellite.js (SGP4); passaggi ravvicinati: NASA/JPL CNEOS; meteore: International Meteor Organization.', { v0: fromPlace(this.place), v1: tzNote(this.place) });
    const all = [...this.events, ...this.approaches]
      .filter((e) => this.enabled.has(e.group))
      .filter((e) => this.rangeYears === 1 || e.importance <= 2 || e.group === 'eclissi')
      .sort((a, b) => a.time.getTime() - b.time.getTime());
    this.note.textContent = this.enabled.has('asteroidi') ? this.approachNote : '';
    this.note.hidden = !this.note.textContent;
    clear(this.list);
    if (!all.length) {
      this.list.append(h('p', { class: 'muted' }, t('Nessun evento con questi filtri.')));
      return;
    }
    let month = '';
    let ul: HTMLElement | null = null;
    for (const ev of all) {
      const lp = localParts(ev.time, tz);
      const m = `${MONTHS[lp.month]} ${lp.year}`;
      if (m !== month) {
        month = m;
        this.list.append(h('h3', { class: 'ev-month' }, m));
        ul = h('ul', { class: 'ev-items' });
        this.list.append(ul);
      }
      const go = h('button', { class: 'btn small', title: t('Porta il tempo a questo momento e inquadra'), onclick: () => this.onGo(ev) }, t('Vai'));
      ul!.append(h('li', { class: `ev imp${ev.importance}${ev.visible === false ? ' unseen' : ''}` },
        h('div', { class: 'ev-date', 'aria-hidden': 'true' }, h('b', {}, lp.day), h('span', {}, lp.mon)),
        h('div', { class: 'ev-body' },
          h('div', { class: 'ev-title' }, ev.title),
          h('div', { class: 'ev-when' }, fmtWhenFull(ev.time, tz)),
          h('div', { class: 'ev-detail' }, ev.detail),
          ev.local ? h('div', { class: `ev-local${ev.visible === false ? ' no' : ''}` }, ev.local) : null),
        go));
    }
  }
}
