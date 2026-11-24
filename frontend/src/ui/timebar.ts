/** Controlli del tempo: pausa, velocità, salto a una data, ritorno al presente. */

import { t } from '../core/i18n';
import type { SimClock } from '../core/time';
import { fmtDate } from '../core/format';
import { h } from './dom';

export const RATES = [1, 60, 600, 3600, 21600, 86400, 604800, 2629800, 31557600];

export function rateLabel(r: number): string {
  const a = Math.abs(r);
  const back = r < 0 ? t('indietro, ') : '';
  const map: [number, string][] = [
    [1, t('tempo reale')], [60, t('1 minuto al secondo')], [600, t('10 minuti al secondo')], [3600, t('1 ora al secondo')],
    [21600, t('6 ore al secondo')], [86400, t('1 giorno al secondo')], [604800, t('1 settimana al secondo')],
    [2629800, t('1 mese al secondo')], [31557600, t('1 anno al secondo')],
  ];
  const m = map.find(([v]) => v === a);
  if (m) return r === 1 ? m[1] : `${back}${m[1]}`;
  return t('{back}{a}× tempo reale', { back, a });
}

export class TimeBar {
  readonly root: HTMLElement;
  private dateEl: HTMLElement;
  private timeEl: HTMLElement;
  private zoneEl: HTMLElement;
  private rateEl: HTMLElement;
  private playBtn: HTMLButtonElement;
  private nowBtn: HTMLButtonElement;
  private picker: HTMLInputElement;
  utc = false;

  constructor(parent: HTMLElement, private clock: SimClock) {
    this.dateEl = h('span', { class: 't-date' });
    this.timeEl = h('span', { class: 't-time' });
    this.zoneEl = h('button', { class: 't-zone', title: t('Passa da ora locale a UTC'), onclick: () => { this.utc = !this.utc; this.render(); } });
    this.rateEl = h('span', { class: 't-rate' });
    this.playBtn = h('button', { class: 'icon-btn', 'aria-label': t('Pausa'), title: t('Pausa / riprendi (spazio)'), onclick: () => clock.togglePause() });
    this.nowBtn = h('button', { class: 'btn now', title: t('Torna all\'istante presente (N)'), onclick: () => clock.setLive() }, t('Adesso'));
    this.picker = h('input', { type: 'datetime-local', class: 't-picker', step: '1', 'aria-label': t('Vai a una data') });
    this.picker.addEventListener('change', () => {
      const v = this.picker.value;
      if (!v) return;
      const ms = this.utc ? Date.parse(v + 'Z') : new Date(v).getTime();
      if (Number.isFinite(ms)) clock.setTime(ms);
    });
    const dateBtn = h('button', { class: 't-datebtn', title: t('Scegli una data'), onclick: () => this.openPicker() }, this.dateEl, this.timeEl);
    this.root = h('div', { class: 'timebar panel' },
      h('div', { class: 't-controls' },
        h('button', { class: 'icon-btn', 'aria-label': t('Più lento o indietro'), title: t('Più lento / indietro (,)'), onclick: () => this.step(-1) }, '‹‹'),
        this.playBtn,
        h('button', { class: 'icon-btn', 'aria-label': t('Più veloce'), title: t('Più veloce (.)'), onclick: () => this.step(1) }, '››'),
      ),
      h('div', { class: 't-clock' }, dateBtn, this.zoneEl, this.picker),
      h('div', { class: 't-right' }, this.rateEl, this.nowBtn),
    );
    parent.appendChild(this.root);
    clock.onChange(() => this.render());
    this.render();
  }

  private openPicker(): void {
    const d = new Date(this.clock.simMs);
    const pad = (n: number) => String(n).padStart(2, '0');
    const get = this.utc
      ? [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()]
      : [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()];
    this.picker.value = `${String(get[0]).padStart(4, '0')}-${pad(get[1])}-${pad(get[2])}T${pad(get[3])}:${pad(get[4])}:${pad(get[5])}`;
    try {
      this.picker.showPicker();
    } catch {
      this.picker.focus();
    }
  }

  /** Passo successivo/precedente nella scala delle velocità (sotto lo zero si va indietro). */
  step(dir: 1 | -1): void {
    const r = this.clock.rate;
    const signed = [...RATES.map((x) => -x).reverse(), ...RATES];
    let i = signed.indexOf(r);
    if (i < 0) i = signed.indexOf(1);
    i = Math.max(0, Math.min(signed.length - 1, i + dir));
    this.clock.setRate(signed[i]);
  }

  render(): void {
    const c = this.clock;
    this.playBtn.textContent = c.paused ? '▶' : '❚❚';
    this.playBtn.setAttribute('aria-label', c.paused ? t('Riprendi') : t('Pausa'));
    this.rateEl.textContent = c.paused ? t('in pausa') : rateLabel(c.rate);
    this.nowBtn.classList.toggle('is-live', c.live && !c.paused);
    this.nowBtn.textContent = c.live && !c.paused ? t('In diretta') : t('Adesso');
    this.zoneEl.textContent = this.utc ? 'UTC' : t('ora locale');
    this.tick();
  }

  tick(): void {
    const { date, time } = fmtDate(this.clock.simMs, this.utc);
    if (this.dateEl.textContent !== date) this.dateEl.textContent = date;
    if (this.timeEl.textContent !== time) this.timeEl.textContent = time;
  }
}
