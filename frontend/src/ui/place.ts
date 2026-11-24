/**
 * Il luogo dell'osservatore: da dove si guarda il cielo. Città incluse (anche senza rete),
 * ricerca in rete, posizione del computer o coordinate scritte a mano.
 */

import { locale, t } from '../core/i18n';
import { api } from '../data/api';
import { CITIES, DEFAULT_PLACE, fmtLatLon, searchCities, validTz, type Place } from '../core/places';
import { clear, h } from './dom';

const SYSTEM_TZ = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
})();

/** "ora di Roma", "ora di Tokyo (UTC+9)" */
export function tzNote(p: Place): string {
  const tz = validTz(p.tz);
  if (!tz) return t('ora del computer');
  if (tz === SYSTEM_TZ) return t('ora locale');
  try {
    const parts = new Intl.DateTimeFormat(locale(), { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(new Date());
    const off = parts.find((x) => x.type === 'timeZoneName')?.value ?? '';
    return t('ora del luogo{v0}', { v0: off ? ` (${off.replace('GMT', 'UTC')})` : '' });
  } catch {
    return t('ora del luogo');
  }
}

export class PlacePicker {
  readonly root: HTMLElement;
  private label: HTMLElement;
  private coords: HTMLElement;
  private edit: HTMLElement;
  private input: HTMLInputElement;
  private results: HTMLElement;
  private msg: HTMLElement;
  private abort: AbortController | null = null;
  private timer = 0;
  onChange: (p: Place) => void = () => {};

  constructor(private place: Place) {
    this.label = h('b', { class: 'place-name' });
    this.coords = h('span', { class: 'place-coords muted' });
    const change = h('button', { class: 'link-btn', onclick: () => this.open(!this.edit.hidden ? false : true) }, t('Cambia'));
    this.input = h('input', { type: 'search', class: 'place-search', placeholder: t('Cerca una città o un paese…'), 'aria-label': t('Cerca un luogo'), autocomplete: 'off' }) as HTMLInputElement;
    this.input.addEventListener('input', () => this.search());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') (this.results.querySelector('button') as HTMLButtonElement | null)?.click();
      if (e.key === 'Escape') this.open(false);
      e.stopPropagation();
    });
    this.results = h('ul', { class: 'place-results' });
    this.msg = h('p', { class: 'muted small place-msg' });
    const lat = h('input', { type: 'number', step: '0.0001', min: '-90', max: '90', placeholder: t('latitudine (es. 41,90)'), 'aria-label': t('Latitudine') }) as HTMLInputElement;
    const lon = h('input', { type: 'number', step: '0.0001', min: '-180', max: '180', placeholder: t('longitudine (es. 12,50)'), 'aria-label': t('Longitudine') }) as HTMLInputElement;
    for (const i of [lat, lon]) i.addEventListener('keydown', (e) => e.stopPropagation());
    const setCoords = h('button', {
      class: 'btn small', onclick: () => {
        const la = Number(lat.value.replace(',', '.')), lo = Number(lon.value.replace(',', '.'));
        if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) {
          this.msg.textContent = t('Coordinate non valide: latitudine fra -90 e 90, longitudine fra -180 e 180 (est positiva).');
          return;
        }
        this.choose({ name: `${Math.abs(la).toFixed(2)}° ${la >= 0 ? t('N') : t('S')}, ${Math.abs(lo).toFixed(2)}° ${lo >= 0 ? t('E') : t('O')}`, lat: la, lon: lo, tz: SYSTEM_TZ, elev: 0 });
      },
    }, t('Usa queste coordinate'));
    const geo = h('button', { class: 'btn small', onclick: () => this.locate() }, t('Usa la mia posizione'));
    this.edit = h('div', { class: 'place-edit' },
      this.input, this.results,
      h('div', { class: 'place-actions' }, geo),
      h('details', { class: 'place-manual' }, h('summary', {}, t('Coordinate esatte')), h('div', { class: 'place-ll' }, lat, lon, setCoords)),
      this.msg,
      h('p', { class: 'muted small' }, t('Ricerca in rete: Open-Meteo, con i dati di GeoNames (CC BY 4.0).')));
    this.edit.hidden = true;
    this.root = h('div', { class: 'place' },
      h('div', { class: 'place-row' }, h('span', { class: 'pin', 'aria-hidden': 'true' }), h('span', {}, t('Cielo visto da '), this.label), change),
      this.coords,
      this.edit);
    this.render();
  }

  get current(): Place {
    return this.place;
  }

  private render(): void {
    this.label.textContent = this.place.name;
    this.coords.textContent = t('{v0}{v1} · orari: {v2}', { v0: this.place.where ? `${this.place.where} · ` : '', v1: fmtLatLon(this.place), v2: tzNote(this.place) });
  }

  open(on: boolean): void {
    this.edit.hidden = !on;
    if (on) {
      this.input.value = '';
      this.msg.textContent = '';
      this.showList(CITIES.slice(0, 0));
      setTimeout(() => this.input.focus(), 0);
    }
  }

  private showList(list: Place[], extra = ''): void {
    clear(this.results);
    for (const p of list) {
      const b = h('button', { class: 'place-item', onclick: () => this.choose(p) },
        h('span', {}, p.name), p.where ? h('span', { class: 'muted' }, ` — ${p.where}`) : null);
      this.results.append(h('li', {}, b));
    }
    if (extra) this.results.append(h('li', { class: 'muted small' }, extra));
  }

  private search(): void {
    const q = this.input.value.trim();
    const local = searchCities(q, 6);
    this.showList(local);
    window.clearTimeout(this.timer);
    this.abort?.abort();
    if (q.length < 2) return;
    this.timer = window.setTimeout(() => {
      const ac = (this.abort = new AbortController());
      api.geocode(q, ac.signal).then((r) => {
        if (ac.signal.aborted) return;
        const seen = new Set(local.map((p) => `${p.name}|${p.lat.toFixed(2)}|${p.lon.toFixed(2)}`));
        const more = r.places.filter((p) => !seen.has(`${p.name}|${p.lat.toFixed(2)}|${p.lon.toFixed(2)}`));
        this.showList([...local, ...more].slice(0, 10), local.length || more.length ? '' : t('Nessun luogo con questo nome.'));
      }).catch(() => {
        if (ac.signal.aborted) return;
        this.showList(local, local.length ? t('Ricerca in rete non disponibile: solo le città incluse.') : t('Nessuna città inclusa con questo nome, e la ricerca in rete non è disponibile.'));
      });
    }, 350);
  }

  private locate(): void {
    if (!navigator.geolocation) {
      this.msg.textContent = t('Questo sistema non fornisce la posizione: cerca la tua città qui sopra.');
      return;
    }
    this.msg.textContent = t('Chiedo la posizione al sistema…');
    navigator.geolocation.getCurrentPosition((pos) => {
      this.choose({ name: t('La mia posizione'), lat: pos.coords.latitude, lon: pos.coords.longitude, elev: pos.coords.altitude ?? 0, tz: SYSTEM_TZ });
    }, () => {
      this.msg.textContent = t('Posizione non disponibile (permesso negato o servizio spento): cerca la tua città qui sopra.');
    }, { timeout: 15000, maximumAge: 600000 });
  }

  private choose(p: Place): void {
    this.place = { ...p, tz: validTz(p.tz) ?? SYSTEM_TZ };
    this.render();
    this.open(false);
    this.onChange(this.place);
  }

  set(p: Place): void {
    this.place = p ?? DEFAULT_PLACE;
    this.render();
  }
}
