/**
 * Riquadro «Vicino a Sagittarius A*»: che cosa succederebbe a chi stesse fermo dove si trova la
 * camera, sospeso con i razzi. Compare entro qualche migliaio di unità astronomiche dal buco nero.
 */

import { t } from '../core/i18n';
import { h } from './dom';
import { fmtDuration, fmtKm, fmtNum, fmtSci, fmtSig } from '../core/format';
import { loadPref, savePref } from '../core/events';
import { horizon, isco, photonOrbit } from '../core/kerr';
import { kerrCamera, ksRadius, staticAccel, staticEscapeSpeed } from '../core/kerrgeo';
import { AU_KM } from '../core/units';
import {
  FLARE_DURATION_S, C_KM_S, circularOrbit, clockRate, escapeSpeed, flareAt, hotspotPeriod, hoverAccel, nextFlare, shadowRadius,
  tidalAccel,
} from '../core/blackhole';

const G0 = 9.80665;

/** frazione della luce come percentuale leggibile */
function pctC(v: number): string {
  return v >= 0.995 ? t('la velocità della luce') : t('il {v0}% della velocità della luce', { v0: fmtSig(v * 100, v < 0.1 ? 2 : 3) });
}

/** durata in secondi in parole brevi */
function fmtSec(s: number): string {
  if (s < 90) return `${fmtNum(s, 0)} s`;
  return fmtDuration(s / 3600);
}

export class BlackHoleHud {
  readonly root: HTMLElement;
  private rows = new Map<string, HTMLElement>();
  private summary: HTMLElement;
  private details: HTMLElement;
  private toggle: HTMLButtonElement;
  private open = loadPref<boolean>('bhHudOpen', false);
  private spinInput: HTMLInputElement;
  private spinText: HTMLElement;
  /** chiamato quando si sposta il cursore della rotazione (a* fra 0 e 0,998) */
  onSpin: (a: number) => void = () => {};

  constructor(parent: HTMLElement) {
    const row = (k: string, label: string) => {
      const v = h('div', { class: 'bh-v' });
      this.rows.set(k, v);
      return h('div', { class: 'bh-row' }, h('div', { class: 'bh-k' }, label), v);
    };
    this.summary = h('div', { class: 'bh-sum' });
    this.spinText = h('span', { class: 'bh-spin-t' }, '');
    this.spinInput = h('input', {
      type: 'range', min: '0', max: '0.998', step: '0.002', class: 'bh-spin', 'aria-label': t('Rotazione del buco nero'),
      oninput: () => { this.showSpin(); this.onSpin(Number(this.spinInput.value)); },
    }) as HTMLInputElement;
    this.toggle = h('button', { class: 'btn small', onclick: () => this.setOpen(!this.open) }, '') as HTMLButtonElement;
    this.details = h('div', { class: 'bh-details' },
      h('p', { class: 'bh-note' }, t('Cosa proveresti stando fermo qui, sospeso con i razzi:')),
      h('div', { class: 'bh-row' },
        h('div', { class: 'bh-k' }, t('Rotazione del buco nero (non è ancora misurata con certezza: sceglila tu)')),
        h('div', { class: 'bh-spin-row' }, this.spinInput, this.spinText)),
      row('kerr', t('Con questa rotazione')),
      row('dist', t('Distanza dal centro')),
      row('clock', t('Il tuo orologio')),
      row('light', t('La luce delle stelle')),
      row('hover', t('Per restare fermo')),
      row('escape', t('Velocità di fuga')),
      row('orbit', t('Orbita circolare')),
      row('tide', t('Marea su un corpo di 2 m')),
      row('shadow', t('L\'ombra')),
      row('flare', t('Lampi')),
      // perché l'orologio cambia così poco finché non si è a un soffio dall'orizzonte
      h('p', { class: 'bh-note bh-foot' },
        t('Il tempo rallenta molto solo a ridosso dell\'orizzonte: fermo a 2 volte il suo raggio, 1 ora ne vale appena 1,4 per chi è lontano; ')
        + t('a 1,001 volte ne vale 32, e più vicino ancora cresce senza limite. Sotto l\'orizzonte non si può restare fermi: ')
        + t('per questo l\'atlante non ti fa entrare. (L\'«1 ora = 7 anni» dei film richiede un buco nero che ruota quasi al massimo.)')),
    );
    // di solito chiuso: due righe che non coprono la scena; «Dettagli» apre tutto il resto
    this.root = h('div', { class: 'bh-hud panel', role: 'status', 'aria-label': t('Vicino a Sagittarius A*') },
      h('div', { class: 'bh-head' }, h('span', { class: 'bh-title' }, t('Vicino a Sagittarius A*')), this.toggle),
      this.summary,
      this.details,
    );
    this.root.hidden = true;
    parent.appendChild(this.root);
    this.setOpen(this.open);
  }

  /** rotazione mostrata dal cursore */
  set spin(a: number) {
    this.spinInput.value = String(a);
    this.showSpin();
  }

  private showSpin(): void {
    const a = Number(this.spinInput.value);
    this.spinText.textContent = a < 0.001 ? 'ferma' : t('{v0}% del massimo', { v0: fmtNum(a * 100, a > 0.99 ? 1 : 0) });
  }

  private setOpen(on: boolean): void {
    this.open = on;
    this.details.hidden = !on;
    this.summary.hidden = on;
    this.toggle.textContent = on ? t('Riduci') : t('Dettagli');
    this.toggle.setAttribute('aria-expanded', String(on));
    savePref('bhHudOpen', on);
  }

  private set(k: string, text: string): void {
    const el = this.rows.get(k);
    if (el && el.textContent !== text) el.textContent = text;
  }

  /** r: distanza della camera dal buco nero in raggi di Schwarzschild (null: riquadro nascosto). */
  update(r: number | null, rsKm: number, tSec: number, camM: [number, number] | null = null): void {
    this.root.hidden = r === null;
    if (r === null) return;
    const km = r * rsKm;
    const a = Number(this.spinInput.value);
    // con la rotazione, l'orologio di chi sta fermo dipende anche da dove si trova rispetto all'asse
    let kRate = clockRate(r);
    if (a > 0.001 && camM) {
      const g = kerrCamera(a, camM[0], camM[1]).blueshift;
      if (Number.isFinite(g) && g > 0) kRate = 1 / g;
    }
    if (!this.open) {
      const f = 1 / kRate;
      const txt = t('{v0} volte il raggio dell\'orizzonte · 1 ora qui = {v1} lontano da qui', { v0: fmtSig(r, r < 10 ? 3 : 4), v1: f < 1.0005 ? t('1 ora') : fmtDuration(f) });
      if (this.summary.textContent !== txt) this.summary.textContent = txt;
      return;
    }
    this.set('dist', t('{v0} volte il raggio dell\'orizzonte ({v1})', { v0: fmtSig(r, r < 10 ? 3 : 4), v1: km < 0.1 * AU_KM ? fmtKm(km) : `${fmtSig(km / AU_KM, 4)} UA` }));
    const far = 1 / kRate;
    {
      // lunghezze di Kerr in M = mezzo raggio di Schwarzschild; il tempo M vale rs/(2c)
      const tM = rsKm / 2 / 299792.458;
      const ri = isco(a, true), rp = photonOrbit(a, true);
      this.set('kerr', a < 0.001 ? t('nessuna: orizzonte a 1 raggio, ultima orbita stabile del gas a 3 raggi')
        : t('orizzonte a {v0} raggi, ultima orbita stabile a {v1} raggi (un giro in {v2}), ', { v0: fmtSig(horizon(a) / 2, 3), v1: fmtSig(ri / 2, 3), v2: fmtSec(2 * Math.PI * (ri ** 1.5 + a) * tM) })
          + t('la luce può girare in tondo a {v0} raggi. Attorno all\'equatore, fino a 1 raggio, c\'è l\'ergosfera: lì lo spazio è trascinato in tondo e nessuno può restare fermo.', { v0: fmtSig(rp / 2, 3) }));
    }
    this.set('clock', far < 1.0005 ? t('va quasi come lontano da qui')
      : t('1 ora qui = {v0} per chi è lontano', { v0: fmtDuration(far) }));
    const g = 1 / kRate;
    this.set('light', g < 1.0005 ? t('arriva quasi come da lontano')
      : t('arriva più blu e più intensa: frequenza ×{v0}, luminosità ×{v1}', { v0: fmtSig(g, 3), v1: fmtSig(Math.min(g ** 4, 1e6), 3) }));
    const kerr = a > 0.001 && camM !== null;
    // con la rotazione: accelerazione in c²/M, con M = mezzo raggio di Schwarzschild
    const acc = kerr ? (staticAccel(a, camM[0], camM[1]) * (C_KM_S * 1000) ** 2) / (rsKm * 500) : hoverAccel(r, rsKm);
    this.set('hover', t('razzi accesi a {v0}', { v0: acc / G0 < 0.01 ? `${fmtSig(acc, 2)} m/s²` : `${fmtSig(acc / G0, 3)} g` }));
    this.set('escape', pctC(kerr ? staticEscapeSpeed(a, camM[0], camM[1]) : escapeSpeed(r)));
    if (kerr) {
      // orbita nel piano dell'equatore, nel verso della rotazione, alla distanza della camera
      const rM = ksRadius(a, camM[0], 0, camM[1]);
      const T = 2 * Math.PI * (rM ** 1.5 + a) * (rsKm / 2 / C_KM_S);
      this.set('orbit', rM <= photonOrbit(a, true) ? t('impossibile: qui nemmeno la luce può girare in tondo')
        : t('{v0}un giro in {v1}, sull\'equatore e nel verso della rotazione', { v0: rM >= isco(a, true) ? '' : t('instabile (sotto l\'ultima orbita stabile): '), v1: fmtSec(T) }));
    } else {
      const o = circularOrbit(r, rsKm);
      this.set('orbit', !o ? t('impossibile: qui nemmeno la luce può girare in tondo')
        : t('{v0}un giro in {v1} a {v2}', { v0: o.stable ? '' : t('instabile (sotto 3 volte l\'orizzonte): '), v1: fmtSec(o.periodFar), v2: pctC(o.speed) }));
    }
    const tide = tidalAccel(r, rsKm, 2);
    this.set('tide', t('{accel} m/s² fra testa e piedi', { accel: fmtSci(tide, 2) })
      + (tide < 0.1 ? t(': innocua (un buco nero così grande non "spaghettifica")') : tide < 50 ? t(': si sente') : t(': letale')));
    const sh = (shadowRadius(r) * 180) / Math.PI;
    const circa = kerr ? t(' (circa: con la rotazione non è rotonda)') : '';
    this.set('shadow', sh > 90 ? t('copre più di metà del cielo: resta un cerchio di {v0}° di stelle alle tue spalle', { v0: fmtSig(2 * (180 - sh), 3) })
      : t('è larga {v0}°{circa} (la Luna piena, dalla Terra, è larga mezzo grado)', { v0: fmtSig(2 * sh, 3), circa }));
    const fl = flareAt(tSec, rsKm, a);
    const per = hotspotPeriod(rsKm, a);
    if (fl.amp > 0) {
      this.set('flare', t('in corso da {v0}: una macchia di gas caldo gira attorno al buco nero in {v1}', { v0: fmtSec(fl.age * FLARE_DURATION_S), v1: fmtSec(per) }));
    } else {
      const nx = nextFlare(tSec);
      this.set('flare', nx === null ? t('nessuno nei prossimi giorni') : t('il prossimo fra {v0} (di solito tre o quattro al giorno)', { v0: fmtSec(nx - tSec) }));
    }
  }
}
