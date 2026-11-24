/** Riquadro del cielo visto da terra: dove si è, verso dove si guarda, com'è il cielo. */

import { t } from '../core/i18n';
import { h } from './dom';
import { fmtNum } from '../core/format';
import type { CameraRig } from '../render/camera';

const WINDS = [t('nord'), t('nord-est'), t('est'), t('sud-est'), t('sud'), t('sud-ovest'), t('ovest'), t('nord-ovest')];

function skyState(sunAltDeg: number): string {
  if (sunAltDeg > 0) return t('giorno, Sole a {v0}° sull\'orizzonte', { v0: fmtNum(sunAltDeg, 0) });
  if (sunAltDeg > -6) return t('crepuscolo: il Sole è appena sotto l\'orizzonte');
  if (sunAltDeg > -18) return t('crepuscolo: il cielo non è ancora del tutto buio');
  return t('notte');
}

export class GroundHud {
  readonly root: HTMLElement;
  private placeEl: HTMLElement;
  private lookEl: HTMLElement;
  private skyEl: HTMLElement;
  private day: HTMLInputElement;
  onExit: () => void = () => {};
  onDaylight: (on: boolean) => void = () => {};

  constructor(parent: HTMLElement, daylight: boolean) {
    this.placeEl = h('strong', { class: 'fh-speed' }, '');
    this.lookEl = h('span', { class: 'fh-near' }, '');
    this.skyEl = h('span', { class: 'fh-near fh-sun' }, '');
    this.day = h('input', { type: 'checkbox' });
    this.day.checked = daylight;
    this.day.addEventListener('change', () => this.onDaylight(this.day.checked));
    const k = (t: string) => h('kbd', {}, t);
    this.root = h('div', { class: 'flight-hud panel', role: 'status', 'aria-label': t('Cielo visto da terra') },
      h('div', { class: 'fh-row' },
        h('span', { class: 'fh-title' }, t('Cielo da')),
        this.placeEl,
        h('button', { class: 'btn small', title: t('Torna nello spazio (T)'), onclick: () => this.onExit() }, t('Esci')),
      ),
      this.lookEl,
      this.skyEl,
      h('label', { class: 'toggle', title: t('Senza la luce del giorno le stelle si vedono anche con il Sole alto') }, this.day, h('span', {}, t('Luce del giorno'))),
      h('div', { class: 'fh-keys' },
        h('span', {}, t('trascina per guardarti intorno')),
        h('span', {}, t('rotella per ingrandire')),
        h('span', {}, k('F'), t(' guarda il corpo selezionato')),
        h('span', {}, k('T'), ' esci'),
        h('span', {}, t('il luogo si cambia in Eventi')),
      ),
    );
    this.root.hidden = true;
    parent.appendChild(this.root);
  }

  show(on: boolean): void {
    this.root.hidden = !on;
  }

  update(rig: CameraRig, placeName: string, sunAltDeg: number): void {
    if (this.placeEl.textContent !== placeName) this.placeEl.textContent = placeName;
    let az = ((rig.gAz * 180) / Math.PI) % 360;
    if (az < 0) az += 360;
    const alt = (rig.gAlt * 180) / Math.PI;
    const wind = WINDS[Math.round(az / 45) % 8];
    const where = alt > 80 ? t('verso lo zenit') : t('verso {wind} ({v1}°), {v2} l\'orizzonte', { wind, v1: fmtNum(az, 0), v2: alt >= 0 ? t('{v0}° sopra', { v0: fmtNum(alt, 0) }) : t('{v0}° sotto', { v0: fmtNum(-alt, 0) }) });
    const fov = rig.fov;
    this.lookEl.textContent = t('Guardi {where}. Campo visivo: {v1}°', { where, v1: fmtNum(fov, fov < 10 ? 1 : 0) });
    this.skyEl.textContent = t('Adesso: {v0}', { v0: skyState(sunAltDeg) });
  }
}
