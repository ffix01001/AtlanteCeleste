/**
 * Eclissi viste da un punto dello spazio: quanta parte del disco del Sole è coperta dai corpi
 * vicini (per la luce sui modelli delle sonde e per il "giorno o notte orbitale" dei satelliti).
 */

import { Vector3 } from 'three';

/** Quello che serve di un corpo: posizione nella scena e raggio (km). */
export interface Occluder {
  scenePos: Vector3;
  radius: number;
  valid: boolean;
}

const _a = new Vector3();
const _b = new Vector3();

/** Frazione del disco del Sole visibile da un punto, con i corpi che possono coprirlo. */
export function sunVisibility(p: Vector3, sun: Occluder, occluders: Occluder[]): number {
  const toSun = _a.subVectors(sun.scenePos, p);
  const dS = toSun.length();
  if (dS <= 0) return 1;
  toSun.divideScalar(dS);
  const rS = Math.asin(Math.min(1, sun.radius / dS));
  let frac = 1;
  for (const o of occluders) {
    if (!o.valid || o.radius <= 0) continue;
    const v = _b.subVectors(o.scenePos, p);
    const d = v.length();
    if (d <= o.radius) return 0;
    if (v.dot(toSun) <= 0) continue; // il corpo è dalla parte opposta al Sole
    const rO = Math.asin(Math.min(1, o.radius / d));
    const sep = Math.acos(Math.min(1, Math.max(-1, v.dot(toSun) / d)));
    frac *= 1 - diskOverlap(rS, rO, sep) / (Math.PI * rS * rS);
  }
  return Math.max(0, frac);
}

/** Area comune di due dischi di raggi r1, r2 con i centri a distanza d (piano tangente). */
export function diskOverlap(r1: number, r2: number, d: number): number {
  if (d >= r1 + r2) return 0;
  if (d <= Math.abs(r1 - r2)) return Math.PI * Math.min(r1, r2) ** 2;
  const a = r1 * r1 * Math.acos((d * d + r1 * r1 - r2 * r2) / (2 * d * r1));
  const b = r2 * r2 * Math.acos((d * d + r2 * r2 - r1 * r1) / (2 * d * r2));
  const c = 0.5 * Math.sqrt((-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2));
  return a + b - c;
}

