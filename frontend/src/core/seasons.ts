/**
 * Stagioni di un pianeta, ricavate dalla geometria vera: la direzione dell'asse di rotazione
 * (che resta fissa nello spazio) e la posizione del pianeta lungo l'orbita.
 *
 * - inclinazione dell'asse: angolo fra l'asse e la perpendicolare all'orbita;
 * - latitudine subsolare: dove il Sole è allo zenit (oscilla fra ±inclinazione in un anno);
 * - longitudine solare Ls: 0° all'equinozio di primavera dell'emisfero nord, 90° al solstizio
 *   d'estate, 180° all'equinozio d'autunno, 270° al solstizio d'inverno (è la misura usata
 *   per Marte; per la Terra coincide con la longitudine eclittica del Sole).
 */

import { Vector3 } from 'three';

export type SeasonName = 'primavera' | 'estate' | 'autunno' | 'inverno';
const NAMES: SeasonName[] = ['primavera', 'estate', 'autunno', 'inverno'];

export interface SeasonInfo {
  obliquityDeg: number;
  subsolarLatDeg: number;
  /** longitudine solare, gradi in [0, 360) */
  ls: number;
  north: SeasonName;
  south: SeasonName;
  /** stagioni appena percettibili (asse quasi perpendicolare all'orbita) */
  weak: boolean;
}

const _n = new Vector3();
const _p = new Vector3();
const _s = new Vector3();
const _pp = new Vector3();
const _e = new Vector3();

const clamp1 = (x: number) => Math.max(-1, Math.min(1, x));

/**
 * `pole`: polo nord del pianeta (ICRF); `relSun`, `velSun`: posizione e velocità del pianeta
 * rispetto al Sole (ICRF). Restituisce null se l'orbita non è definita.
 */
export function seasonInfo(pole: Vector3, relSun: Vector3, velSun: Vector3): SeasonInfo | null {
  _n.crossVectors(relSun, velSun);
  if (_n.lengthSq() === 0 || relSun.lengthSq() === 0) return null;
  _n.normalize();
  _p.copy(pole).normalize();
  _s.copy(relSun).negate().normalize();
  const obliquity = Math.acos(clamp1(_p.dot(_n)));
  const subsolar = Math.asin(clamp1(_p.dot(_s)));
  // proiezione dell'asse sul piano dell'orbita: lì cade il solstizio d'estate del nord (Ls = 90°)
  _pp.copy(_p).addScaledVector(_n, -_p.dot(_n));
  let ls = 0;
  if (_pp.lengthSq() > 1e-12) {
    _pp.normalize();
    _e.crossVectors(_pp, _n); // Ls = 0: equinozio di primavera del nord
    ls = (Math.atan2(_s.dot(_pp), _s.dot(_e)) * 180) / Math.PI;
    if (ls < 0) ls += 360;
  }
  const q = Math.min(3, Math.floor(ls / 90));
  const sinObl = Math.abs(Math.sin(obliquity));
  return {
    obliquityDeg: (obliquity * 180) / Math.PI,
    subsolarLatDeg: (subsolar * 180) / Math.PI,
    ls,
    north: NAMES[q],
    south: NAMES[(q + 2) % 4],
    weak: sinObl < 0.07,
  };
}
