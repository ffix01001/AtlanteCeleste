/**
 * Nomi dei luoghi sulla superficie del corpo che si sta guardando: mari e crateri della Luna,
 * vulcani e canyon di Marte, i punti dove sono atterrate le missioni.
 * Compaiono quando il corpo è grande sullo schermo, prima i più importanti; quelli sul lato
 * nascosto non si mostrano. Con un clic sul nome si apre una didascalia che racconta il luogo.
 * Dati: data/reference/luoghi_superfici.json.
 */

import { locale, t } from '../core/i18n';
import { PerspectiveCamera, Vector3 } from 'three';
import { M_ICRF_TO_SCENE } from '../core/frames';
import type { Body } from '../sim/body';
import { api } from '../data/api';

type Row = [string, number, number, number, string, string?];
interface Spot { el: HTMLDivElement; n: Vector3; rank: number; row: Row; x: number; y: number }

const TYPE_IT: Record<string, string> = {
  mare: t('Mare'), cratere: t('Cratere'), monte: t('Monte o vulcano'), regione: t('Regione'), missione: t('Sito di atterraggio'),
};

function fmtCoord(lat: number, lon: number): string {
  // longitudine fra −180 e 180, come sugli atlanti
  const lo = ((lon + 540) % 360) - 180;
  const f = (v: number) => Math.abs(v).toLocaleString(locale(), { maximumFractionDigits: 1 });
  return `${f(lat)}° ${lat >= 0 ? t('N') : t('S')}, ${f(lo)}° ${lo >= 0 ? t('E') : t('O')}`;
}

const DEG = Math.PI / 180;
const _n = new Vector3();
const _p = new Vector3();
const _v = new Vector3();
/** raggio a schermo (pixel) oltre il quale compaiono i luoghi di importanza 1, 2 e 3 */
const MIN_PX = [70, 170, 380];

export class SurfacePlaces {
  private data: Record<string, Row[]> | null = null;
  private spots: Spot[] = [];
  private forBody: string | null = null;
  /** didascalia del luogo scelto con un clic */
  private card: HTMLDivElement;
  private cardFor: Spot | null = null;
  /** chiamato quando la didascalia si apre o si chiude (per ridisegnare la scena) */
  onChange: () => void = () => {};
  /** fin dove può arrivare la didascalia verso destra (per non coprire la scheda del corpo) */
  rightLimit: () => number = () => Infinity;

  constructor(private parent: HTMLElement) {
    this.card = document.createElement('div');
    this.card.className = 'place-card panel';
    this.card.hidden = true;
    this.card.setAttribute('role', 'dialog');
    parent.appendChild(this.card);
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.closeCard(); });
    // un clic altrove (sulla scena) chiude la didascalia
    window.addEventListener('pointerdown', (e) => {
      const t = e.target as HTMLElement | null;
      if (this.cardFor && t && !t.closest('.place-card') && !t.closest('.place-label')) this.closeCard();
    }, true);
  }

  closeCard(): void {
    if (!this.cardFor) return;
    this.cardFor.el.classList.remove('open');
    this.cardFor = null;
    this.card.hidden = true;
    this.onChange();
  }

  private openCard(s: Spot): void {
    if (this.cardFor === s) { this.closeCard(); return; }
    this.cardFor?.el.classList.remove('open');
    this.cardFor = s;
    s.el.classList.add('open');
    const [name, lat, lon, , type, text] = s.row;
    this.card.replaceChildren();
    const mk = (tag: string, cls: string, txt: string) => {
      const e = document.createElement(tag);
      e.className = cls;
      e.textContent = txt;
      return e;
    };
    const close = mk('button', 'place-card-close', '×');
    close.setAttribute('aria-label', t('Chiudi'));
    close.addEventListener('click', () => this.closeCard());
    this.card.append(close, mk('div', 'place-card-title', name),
      mk('div', 'place-card-meta', `${TYPE_IT[type] ?? type} · ${fmtCoord(lat, lon)}`));
    if (text) this.card.append(mk('p', 'place-card-text', text));
    this.card.hidden = false;
    this.onChange();
  }

  async load(): Promise<void> {
    // (si chiede sempre al server se il file è cambiato: altrimenti il browser terrebbe la copia vecchia)
    const r = await fetch(api.referenceUrl('luoghi_superfici'), { cache: 'no-cache' });
    if (!r.ok) throw new Error(`${r.status}`);
    this.data = (await r.json()).luoghi as Record<string, Row[]>;
  }

  /** Il corpo ha luoghi con un nome? */
  has(id: string): boolean {
    return !!this.data?.[id];
  }

  private build(id: string): void {
    this.closeCard();
    for (const s of this.spots) s.el.remove();
    this.spots = [];
    this.forBody = id;
    const rows = [...(this.data?.[id] ?? [])].sort((a, b) => a[3] - b[3]);
    for (const row of rows) {
      const [name, lat, lon, rank, type] = row;
      const el = document.createElement('div');
      el.className = `place-label t-${type}`;
      const dot = document.createElement('span');
      dot.className = 'dot';
      el.append(dot, document.createTextNode(name));
      el.hidden = true;
      el.title = t('Clic per saperne di più');
      this.parent.appendChild(el);
      const la = lat * DEG, lo = lon * DEG;
      const spot: Spot = { el, n: new Vector3(Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)), rank, row, x: 0, y: 0 };
      el.addEventListener('click', (e) => { e.stopPropagation(); this.openCard(spot); });
      this.spots.push(spot);
    }
  }

  /**
   * `body`: il corpo guardato (null = nessuno); `center`: il suo centro rispetto alla camera;
   * `radius`: il suo raggio nella scena; `pxRadius`: quanto è grande sullo schermo.
   */
  update(body: Body | null, center: Vector3, radius: number, pxRadius: number, camera: PerspectiveCamera, w: number, h: number): void {
    const id = body && this.data?.[body.id] && pxRadius >= MIN_PX[0] ? body.id : null;
    if (id !== this.forBody) {
      if (id) this.build(id);
      else {
        this.closeCard();
        for (const s of this.spots) s.el.remove();
        this.spots = [];
        this.forBody = null;
      }
    }
    if (!id || !body) return;
    const taken: number[] = [];
    // il luogo con la didascalia aperta resta visibile e ha la precedenza sugli altri
    const order = this.cardFor ? [this.cardFor, ...this.spots.filter((s) => s !== this.cardFor)] : this.spots;
    for (const s of order) {
      let vis = pxRadius >= MIN_PX[s.rank - 1] || s === this.cardFor;
      if (vis) {
        // dal sistema solidale al corpo (X = meridiano zero, Z = polo nord) alla scena
        _n.copy(s.n).applyMatrix3(body.orient).applyMatrix3(M_ICRF_TO_SCENE).normalize();
        _p.copy(_n).multiplyScalar(radius * 1.001).add(center);
        // sul lato nascosto o proprio sul bordo non si mostra
        if (_n.dot(_v.copy(_p).normalize()) > -0.12) vis = false;
      }
      if (vis) {
        _v.copy(_p).applyMatrix4(camera.matrixWorldInverse);
        if (_v.z >= 0) vis = false;
        else {
          _v.applyMatrix4(camera.projectionMatrix);
          const x = (_v.x * 0.5 + 0.5) * w, y = (-_v.y * 0.5 + 0.5) * h;
          if (x < 0 || x > w || y < 0 || y > h) vis = false;
          else {
            // i nomi non si sovrappongono: vince il più importante (sono già in ordine)
            for (let k = 0; k < taken.length; k += 2) {
              if (Math.abs(taken[k] - x) < 120 && Math.abs(taken[k + 1] - y) < 15) { vis = false; break; }
            }
            if (vis) {
              taken.push(x, y);
              s.x = x; s.y = y;
              s.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
            }
          }
        }
      }
      if (s.el.hidden === vis) s.el.hidden = !vis;
    }
    const c = this.cardFor;
    if (c) {
      // sparito dietro il corpo o fuori dallo schermo: la didascalia si chiude
      if (c.el.hidden) this.closeCard();
      else {
        // sotto il nome; se non c'è posto, sopra. Sempre dentro lo schermo
        const cw = this.card.offsetWidth, ch = this.card.offsetHeight;
        const x = Math.max(8, Math.min(c.x - 12, Math.min(w, this.rightLimit()) - cw - 8));
        const y = c.y + 14 + ch > h - 90 ? Math.max(8, c.y - 14 - ch) : c.y + 14;
        this.card.style.transform = `translate3d(${x.toFixed(0)}px, ${y.toFixed(0)}px, 0)`;
      }
    }
  }
}
