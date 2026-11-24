/** Riquadro del volo libero: velocità, corpo più vicino e promemoria dei tasti. */

import { t } from '../core/i18n';
import { h } from './dom';
import { fmtDistance, fmtField, fmtLightTime, fmtNum, fmtSig } from '../core/format';
import { fieldAt } from '../render/magnetosphere';
import { C_KMS, LY_KM } from '../core/units';
import type { Vector3 } from 'three';
import type { CameraRig } from '../render/camera';

/** Velocità in una forma leggibile: m/s, km/s, volte la luce, anni luce al secondo. */
export function fmtFlightSpeed(kms: number): string {
  if (kms < 0.5) return `${fmtNum(kms * 1000, 0)} m/s`;
  if (kms < 0.5 * C_KMS) return `${fmtSig(kms, 3)} km/s`;
  if (kms < 0.1 * LY_KM) return t('{v0} volte la luce', { v0: fmtSig(kms / C_KMS, 3) });
  return t('{v0} anni luce al secondo', { v0: fmtSig(kms / LY_KM, 3) });
}

function fmtMul(m: number): string {
  if (m >= 1) return `×${fmtNum(m, 0)}`;
  return `÷${fmtNum(1 / m, 0)}`;
}

export class FlightHud {
  readonly root: HTMLElement;
  private speedEl: HTMLElement;
  private nearEl: HTMLElement;
  private sunEl: HTMLElement;
  private magEl: HTMLElement;
  private mulEl: HTMLElement;
  onExit: () => void = () => {};

  constructor(parent: HTMLElement) {
    this.speedEl = h('strong', { class: 'fh-speed' }, t('0 km/s'));
    this.mulEl = h('span', { class: 'fh-mul', title: t('Moltiplicatore di velocità (+ e −)') }, '×1');
    this.nearEl = h('span', { class: 'fh-near' }, '');
    this.sunEl = h('span', { class: 'fh-near fh-sun' }, '');
    this.magEl = h('span', { class: 'fh-near fh-mag' }, '');
    const k = (t: string) => h('kbd', {}, t);
    this.root = h('div', { class: 'flight-hud panel', role: 'status', 'aria-label': t('Volo libero') },
      h('div', { class: 'fh-row' },
        h('span', { class: 'fh-title' }, t('Volo libero')),
        this.speedEl, this.mulEl,
        h('button', { class: 'btn small', title: t('Torna a girare attorno al corpo più vicino (V)'), onclick: () => this.onExit() }, t('Esci')),
      ),
      this.nearEl,
      this.sunEl,
      this.magEl,
      h('div', { class: 'fh-keys' },
        h('span', {}, k('W'), k('A'), k('S'), k('D'), t(' muoviti')),
        h('span', {}, k('Q'), k('E'), t(' giù e su')),
        h('span', {}, k(t('Shift')), t(' più veloce')),
        h('span', {}, k('+'), k('−'), t(' velocità')),
        h('span', {}, k('Z'), k('C'), t(' ruota')),
        h('span', {}, k('R'), t(' raddrizza')),
        h('span', {}, t('trascina per guardarti intorno')),
      ),
    );
    this.root.hidden = true;
    parent.appendChild(this.root);
  }

  show(on: boolean): void {
    this.root.hidden = !on;
  }

  update(rig: CameraRig, sunPos?: Vector3): void {
    this.speedEl.textContent = fmtFlightSpeed(rig.speedKmS);
    this.mulEl.textContent = fmtMul(rig.speedMul);
    this.mulEl.classList.toggle('changed', rig.speedMul !== 1);
    const d = fmtDistance(rig.gapKm).main;
    this.nearEl.textContent = t('Vicino a: {name}, {d} dalla superficie più vicina', { name: rig.target.name, d });
    // dentro la magnetosfera del corpo più vicino: quanto è forte il suo campo qui
    const f = fieldAt(rig.target, rig.camPos);
    this.magEl.hidden = !f?.inside;
    if (f?.inside) this.magEl.textContent = t('Campo magnetico ({name}): {b}', { name: rig.target.name, b: fmtField(f.nT) });
    // per dare l'idea delle distanze: quanto ci mette la luce del Sole ad arrivare fin qui
    const fromSun = sunPos ? sunPos.distanceTo(rig.camPos) : 0;
    this.sunEl.hidden = fromSun < 1e6;
    if (fromSun >= 1e6) {
      this.sunEl.textContent = t('Dal Sole: {main}; la sua luce arriva qui in {v1}', { main: fmtDistance(fromSun).main, v1: fmtLightTime(fromSun) });
    }
  }
}
