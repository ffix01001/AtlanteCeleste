/**
 * Sistemi di riferimento.
 *
 * Dati:   ICRF (≈ equatoriale J2000), origine nel baricentro del Sistema Solare, km.
 *         È lo stesso sistema del catalogo Gaia: stelle e pianeti convivono senza conversioni.
 * Scena:  per la grafica si ruota l'ICRF in modo che il piano dell'eclittica sia
 *         "orizzontale" (asse Y della scena = polo nord dell'eclittica). È solo una
 *         rotazione di visualizzazione: i dati restano in ICRF.
 */

import { Matrix3, Vector3 } from 'three';
import { ARCSEC, DEG } from './units';

/** Obliquità dell'eclittica J2000 usata da JPL (84381,448″). */
export const OBLIQUITY = 84381.448 * ARCSEC;
const ce = Math.cos(OBLIQUITY);
const se = Math.sin(OBLIQUITY);

/** ICRF -> scena. Riga per riga: x_s = x; y_s = -sinε·y + cosε·z; z_s = -cosε·y - sinε·z */
export const M_ICRF_TO_SCENE = new Matrix3().set(
  1, 0, 0,
  0, -se, ce,
  0, -ce, -se,
);
export const M_SCENE_TO_ICRF = M_ICRF_TO_SCENE.clone().transpose();

/** ICRF -> eclittica J2000 */
export const M_ICRF_TO_ECL = new Matrix3().set(
  1, 0, 0,
  0, ce, se,
  0, -se, ce,
);
export const M_ECL_TO_ICRF = M_ICRF_TO_ECL.clone().transpose();

/** Polo nord dell'eclittica espresso in ICRF. */
export const ECLIPTIC_POLE_ICRF = new Vector3(0, -se, ce);

export function icrfToScene(v: Vector3, out = new Vector3()): Vector3 {
  return out.copy(v).applyMatrix3(M_ICRF_TO_SCENE);
}

export function sceneToIcrf(v: Vector3, out = new Vector3()): Vector3 {
  return out.copy(v).applyMatrix3(M_SCENE_TO_ICRF);
}

/** Coordinate eclittiche -> scena (rotazione fissa). */
export function eclToScene(x: number, y: number, z: number, out = new Vector3()): Vector3 {
  return out.set(x, z, -y);
}

export function eclToIcrf(x: number, y: number, z: number, out = new Vector3()): Vector3 {
  return out.set(x, ce * y - se * z, se * y + ce * z);
}

/**
 * Precessione (IAU 1976, Lieske): matrice che porta dall'equatore/equinozio medio
 * della data all'ICRF/J2000. Serve per i satelliti terrestri (SGP4 lavora nel
 * sistema TEME "della data").
 */
export function precessionDateToJ2000(T: number): Matrix3 {
  const zeta = (2306.2181 * T + 0.30188 * T * T + 0.017998 * T ** 3) * ARCSEC;
  const z = (2306.2181 * T + 1.09468 * T * T + 0.018203 * T ** 3) * ARCSEC;
  const theta = (2004.3109 * T - 0.42665 * T * T - 0.041833 * T ** 3) * ARCSEC;
  // P (J2000 -> data) = R3(-z) · R2(theta) · R3(-zeta)
  const r3 = (a: number) => new Matrix3().set(Math.cos(a), Math.sin(a), 0, -Math.sin(a), Math.cos(a), 0, 0, 0, 1);
  const r2 = (a: number) => new Matrix3().set(Math.cos(a), 0, -Math.sin(a), 0, 1, 0, Math.sin(a), 0, Math.cos(a));
  const P = r3(-z).multiply(r2(theta)).multiply(r3(-zeta));
  return P.transpose();
}

/** Rotazione attiva attorno a Z / X (per i modelli di rotazione IAU). */
export function rotZ(a: number): Matrix3 {
  const c = Math.cos(a), s = Math.sin(a);
  return new Matrix3().set(c, -s, 0, s, c, 0, 0, 0, 1);
}
export function rotX(a: number): Matrix3 {
  const c = Math.cos(a), s = Math.sin(a);
  return new Matrix3().set(1, 0, 0, 0, c, -s, 0, s, c);
}

/** Ascensione retta e declinazione (gradi) di un vettore ICRF. */
export function raDec(v: Vector3): { ra: number; dec: number } {
  const r = v.length();
  const ra = (Math.atan2(v.y, v.x) / DEG + 360) % 360;
  const dec = Math.asin(Math.max(-1, Math.min(1, v.z / r))) / DEG;
  return { ra, dec };
}
