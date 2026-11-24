/**
 * "Più stelle": scarica dal programma le stelle del satellite Gaia (ESA) e le prepara per la
 * mappa 3D, mentre si continua a usare il resto. Il lavoro lo fa il server (gaia_job.py);
 * qui si sceglie quante stelle, si segue l'avanzamento e alla fine si passa al nuovo catalogo.
 */

import { t, tn } from '../core/i18n';
import { api, type GaiaStatus } from '../data/api';
import { fmtNum } from '../core/format';
import { h } from './dom';

function minutes(m: [number, number]): string {
  const f = (x: number) => {
    if (x === 30) return t("mezz'ora");
    if (x < 60) return tn(x, '{n} minuto', '{n} minuti');
    const hh = Math.floor(x / 60), rest = x % 60;
    const base = tn(hh, "un'ora", '{n} ore');
    return rest === 30 ? t('{base} e mezza', { base }) : rest ? t('{ore} e {minuti}', { ore: base, minuti: tn(rest, '{n} minuto', '{n} minuti') }) : base;
  };
  return t('da {min} a {max}', { min: f(m[0]), max: f(m[1]) });
}

function eta(s: number): string {
  if (s < 90) return t('meno di due minuti');
  const m = Math.round(s / 60);
  if (m < 60) return t('circa {durata}', { durata: tn(m, '{n} minuto', '{n} minuti') });
  const hh = Math.floor(m / 60), mm = m % 60;
  const ore = tn(hh, '{n} ora', '{n} ore');
  return t('circa {durata}', { durata: mm >= 5 ? t('{ore} e {minuti}', { ore, minuti: tn(mm, '{n} minuto', '{n} minuti') }) : ore });
}

export class GaiaBox {
  readonly root: HTMLElement;
  private current: HTMLElement;
  private body: HTMLElement;
  private open = false;
  private timer: number | null = null;
  private choice = 11;
  private last: GaiaStatus | null = null;
  /** il catalogo in uso (etichetta, numero di stelle, magnitudine G massima se è Gaia) */
  catalogInfo: () => { id: string; label: string; total: number; gmax: number | null } = () => ({ id: '', label: '', total: 0, gmax: null });
  /** passa al catalogo appena preparato */
  onUseNew: () => Promise<void> = async () => {};

  constructor() {
    this.current = h('p', { class: 'muted small gaia-current' });
    const more = h('button', { class: 'btn gaia-open', type: 'button', title: t('Scarica dall\'archivio dell\'ESA milioni di stelle in più, con la loro distanza vera') },
      t('★ Aggiungi milioni di stelle dal satellite Gaia…')) as HTMLButtonElement;
    more.addEventListener('click', () => this.toggle());
    this.body = h('div', { class: 'gaia-box' });
    this.body.hidden = true;
    this.root = h('div', { class: 'gaia' }, this.current, more, this.body);
    this.refreshCurrent();
    // se un download era già in corso (ad esempio dopo aver ricaricato la pagina), si segue
    void this.poll();
  }

  refreshCurrent(): void {
    const c = this.catalogInfo();
    this.current.textContent = c.total ? t('Catalogo in uso: {label}, {v1} stelle', { label: c.label, v1: fmtNum(c.total, 0) }) : '';
  }

  /** stato del download (per il pulsante "Più stelle" in alto, che mostra l'avanzamento) */
  onStatus: (st: GaiaStatus | null) => void = () => {};

  private toggle(): void {
    this.open = !this.open;
    this.body.hidden = !this.open;
    if (this.open) void this.poll();
  }

  /** Apre il riquadro (dal pulsante in alto) e lo porta in vista. */
  openBox(): void {
    if (!this.open) this.toggle();
    requestAnimationFrame(() => this.root.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }

  private schedule(ms: number): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.poll(), ms);
  }

  private async poll(): Promise<void> {
    let st: GaiaStatus;
    try {
      st = await api.gaiaStatus();
    } catch {
      if (this.open) this.render(null);
      return;
    }
    this.last = st;
    this.render(st);
    // si continua a controllare finché lavora (anche a pannello chiuso: a fine lavoro si avvisa)
    if (st.running) this.schedule(this.open ? 2000 : 6000);
  }

  private render(st: GaiaStatus | null): void {
    this.refreshCurrent();
    this.onStatus(st);
    const b = this.body;
    b.replaceChildren();
    if (!st) {
      b.append(h('p', { class: 'small' }, t('Il server non risponde.')));
      return;
    }
    const inUse = this.catalogInfo();
    const ready = st.catalog;
    b.append(h('p', { class: 'small' },
      t('Gaia, il satellite astrometrico dell\'ESA, ha misurato posizione, distanza e colore di quasi due miliardi di stelle. '),
      t('Il programma può scaricarne le più luminose (quelle con una distanza affidabile) dall\'archivio dell\'ESA e prepararle per la mappa 3D. '),
      t('Mentre scarica puoi continuare a usarlo; se lo chiudi, la volta dopo riprende da dove era arrivato.')));

    if (st.running) {
      const frac = st.state === 'building' ? 1 : (st.zones_done ?? 0) / Math.max(1, st.zones_total ?? 1);
      b.append(
        h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(frac * 100)) },
          h('span', { style: { width: `${(frac * 100).toFixed(1)}%` } })),
        h('p', { class: 'small' }, st.state === 'building' ? t('Preparo i tasselli del nuovo catalogo…')
          : t('Scarico le stelle: zona {fatte} di {totali}', { fatte: st.zones_done ?? 0, totali: st.zones_total ?? 0 }),
          st.rows ? t(' · {v0} stelle finora', { v0: fmtNum(st.rows, 0) }) : '',
          st.eta_s ? t(' · mancano {v0}', { v0: eta(st.eta_s) }) : ''),
      );
      const stop = h('button', { class: 'btn', type: 'button' }, t('Interrompi')) as HTMLButtonElement;
      stop.addEventListener('click', async () => {
        stop.disabled = true;
        try { this.render(await api.gaiaCancel()); } catch { /* riprova al prossimo controllo */ }
        this.schedule(1500);
      });
      b.append(stop);
      return;
    }

    if (st.state === 'error' && st.error) b.append(h('p', { class: 'small warn' }, st.error));
    if (st.state === 'cancelled' && st.message) b.append(h('p', { class: 'small muted' }, st.message));

    if (ready && inUse.id !== ready.id) {
      const use = h('button', { class: 'btn primary', type: 'button' }, t('Usa il nuovo catalogo')) as HTMLButtonElement;
      use.addEventListener('click', async () => {
        use.disabled = true;
        use.textContent = t('Carico le stelle…');
        await this.onUseNew();
        this.render(this.last);
      });
      b.append(h('p', { class: 'small' }, t('Pronto: {label}, {v1} stelle.', { label: ready.label, v1: fmtNum(ready.count, 0) })), use);
      return;
    }

    // scelta di quante stelle scaricare (solo quelle che aggiungono qualcosa al catalogo in uso)
    const have = inUse.gmax ?? 0;
    const opts = (st.choices ?? []).filter((c) => c.gmax > have);
    if (!opts.length) {
      b.append(h('p', { class: 'small muted' }, t('Hai già il catalogo più grande che il programma sa scaricare.')));
      return;
    }
    if (!opts.some((c) => c.gmax === this.choice)) this.choice = opts[0].gmax;
    const list = h('div', { class: 'gaia-choices' });
    for (const c of opts) {
      const r = h('input', { type: 'radio', name: 'gaia-gmax', value: String(c.gmax) }) as HTMLInputElement;
      r.checked = c.gmax === this.choice;
      r.addEventListener('change', () => { this.choice = c.gmax; });
      const resume = c.zones_on_disk > 0 ? t(' (già scaricate {zones_on_disk} zone su {v1})', { zones_on_disk: c.zones_on_disk, v1: st.zones_total ?? 192 }) : '';
      list.append(h('label', { class: 'toggle' }, r, h('span', {},
        t('circa {v0} milioni di stelle (fino alla magnitudine {gmax}) — circa {mb} MB, {v3}{resume}', { v0: fmtNum(c.stars / 1e6, 1), gmax: c.gmax, mb: c.mb, v3: minutes(c.minutes), resume }))));
    }
    const go = h('button', { class: 'btn primary', type: 'button' }, st.state === 'error' || st.state === 'cancelled' ? t('Riprendi') : t('Scarica')) as HTMLButtonElement;
    go.addEventListener('click', async () => {
      go.disabled = true;
      try {
        this.render(await api.gaiaStart(this.choice));
      } catch (e) {
        b.append(h('p', { class: 'small warn' }, t('Non riesco a cominciare: {message}', { message: (e as Error).message })));
      }
      this.schedule(1000);
    });
    b.append(list, go, h('p', { class: 'muted small' }, t('Dati: ESA/Gaia/DPAC, licenza CC BY-SA 3.0 IGO.')));
  }
}
