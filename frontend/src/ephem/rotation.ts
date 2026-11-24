/**
 * Orientamento dei corpi nello spazio (modelli IAU WGCCRE).
 *
 * Restituisce la matrice che porta dal sistema "solidale al corpo"
 * (X = meridiano zero, Z = polo nord) all'ICRF:
 *     R = Rz(α0 + 90°) · Rx(90° − δ0) · Rz(W)
 */

import { Matrix3, Vector3 } from 'three';
import type { RotationModel } from '../data/types';
import { OBLIQUITY, rotX, rotZ } from '../core/frames';
import { J2000 } from '../core/time';
import { DEG } from '../core/units';

const ECL_POLE_RA = 270;
const ECL_POLE_DEC = 90 - OBLIQUITY / DEG;

export function iauMatrix(raDeg: number, decDeg: number, wDeg: number, out = new Matrix3()): Matrix3 {
  out.copy(rotZ((raDeg + 90) * DEG)).multiply(rotX((90 - decDeg) * DEG)).multiply(rotZ(wDeg * DEG));
  return out;
}

/** Solo l'orientamento del polo (senza la rotazione W): serve per gli anelli. */
export function poleMatrix(model: RotationModel | undefined, jd: number, out = new Matrix3()): Matrix3 {
  const T = (jd - J2000) / 36525;
  if (model?.model === 'iau' && model.ra && model.dec) {
    return iauMatrix(model.ra[0] + model.ra[1] * T, model.dec[0] + model.dec[1] * T, 0, out);
  }
  return iauMatrix(ECL_POLE_RA, ECL_POLE_DEC, 0, out);
}

const _x = new Vector3();
const _y = new Vector3();
const _z = new Vector3();

/**
 * Calcola l'orientamento. Per la rotazione sincrona servono posizione e
 * velocità del corpo rispetto al pianeta (relPos, relVel).
 */
export function orientation(model: RotationModel | undefined, jd: number, relPos: Vector3, relVel: Vector3, out: Matrix3): Matrix3 {
  const d = jd - J2000;
  const T = d / 36525;
  switch (model?.model) {
    case 'iau': {
      const ra = (model.ra?.[0] ?? 0) + (model.ra?.[1] ?? 0) * T;
      const dec = (model.dec?.[0] ?? 90) + (model.dec?.[1] ?? 0) * T;
      const w = (model.w?.[0] ?? 0) + (model.w?.[1] ?? 0) * d;
      return iauMatrix(ra, dec, w % 360, out);
    }
    case 'sync': {
      // X verso il pianeta, Z lungo il momento angolare orbitale
      if (relPos.lengthSq() === 0) return out.identity();
      _x.copy(relPos).negate().normalize();
      _z.crossVectors(relPos, relVel);
      if (_z.lengthSq() === 0) return out.identity();
      _z.normalize();
      _y.crossVectors(_z, _x).normalize();
      _z.crossVectors(_x, _y);
      return out.set(_x.x, _y.x, _z.x, _x.y, _y.y, _z.y, _x.z, _y.z, _z.z);
    }
    case 'spin': {
      const p = model.period_h ?? 24;
      const w = ((360 * 24) / p) * d;
      return iauMatrix(ECL_POLE_RA, ECL_POLE_DEC, w % 360, out);
    }
    default:
      return out.identity();
  }
}

/** Polo nord del corpo (asse Z) in ICRF. */
export function poleOf(m: Matrix3, out = new Vector3()): Vector3 {
  const e = m.elements; // column-major
  return out.set(e[6], e[7], e[8]);
}
