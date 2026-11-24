/**
 * Posizioni approssimate dei pianeti (E. M. Standish, JPL), valide 1800–2050
 * con errori di qualche minuto d'arco. Servono solo come ripiego immediato
 * finché non arrivano le effemeridi precise di JPL Horizons.
 */

import { Vector3 } from 'three';
import type { StandishElements } from '../data/types';
import { eclToIcrf } from '../core/frames';
import { J2000 } from '../core/time';
import { AU_KM, DEG } from '../core/units';
import { perifocalBasis, solveElliptic } from './kepler';

const _p = new Vector3();
const _P = new Vector3();
const _Q = new Vector3();

/** Posizione eliocentrica ICRF in km. */
export function standishPosition(el: StandishElements, jd: number, out: Vector3): Vector3 {
  const T = (jd - J2000) / 36525;
  const a = el.a[0] + el.a[1] * T;
  const e = el.e[0] + el.e[1] * T;
  const I = (el.i[0] + el.i[1] * T) * DEG;
  const L = el.L[0] + el.L[1] * T;
  const lp = el.lp[0] + el.lp[1] * T;
  const node = (el.node[0] + el.node[1] * T) * DEG;
  const w = lp * DEG - node;
  const M = (L - lp) * DEG;
  const E = solveElliptic(M, e);
  const xp = a * (Math.cos(E) - e);
  const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  perifocalBasis(I, node, w, _P, _Q);
  _p.set(xp * _P.x + yp * _Q.x, xp * _P.y + yp * _Q.y, xp * _P.z + yp * _Q.z).multiplyScalar(AU_KM);
  return eclToIcrf(_p.x, _p.y, _p.z, out);
}

/** Posizione e velocità (km, km/s) con differenze finite. */
export function standishState(el: StandishElements, jd: number, pos: Vector3, vel: Vector3): void {
  const h = 0.05; // giorni
  standishPosition(el, jd, pos);
  const a = standishPosition(el, jd - h, new Vector3());
  const b = standishPosition(el, jd + h, new Vector3());
  vel.subVectors(b, a).divideScalar(2 * h * 86400);
}
