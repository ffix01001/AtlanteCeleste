/**
 * Orbite date "sul cielo", come le pubblicano gli astronomi per le stelle doppie e per le
 * stelle S attorno a Sagittarius A*: semiasse in secondi d'arco, angoli rispetto al piano del
 * cielo (Ω contato dal nord verso est), epoca del passaggio al pericentro e periodo in anni.
 *
 * Posizione con le formule di Thiele-Innes: componenti verso nord, verso est e lungo la linea
 * di vista (positiva in allontanamento), poi trasformate in ICRF attorno alla direzione del
 * corpo centrale. Fonte degli elementi delle stelle S: Gillessen et al. 2017, ApJ 837, 30.
 */

import { Vector3 } from 'three';
import { AU_KM } from '../core/units';

export interface SkyOrbit {
  a_arcsec: number;
  e: number;
  i_deg: number;
  Omega_deg: number;
  omega_deg: number;
  tp_year: number;
  period_y: number;
  /** distanza del sistema in parsec (1" a d pc corrisponde a d UA) */
  dist_pc: number;
}

const DEG = Math.PI / 180;
const YEAR_S = 365.25 * 86400;

/**
 * Equazione di Keplero E − e·sin E = M, con M in [−π, π).
 * Partenza di Danby (E₀ = M + 0,85·e·segno(sin M)): con la vecchia partenza fissa a π, vicino
 * all'apocentro (M ≈ −π) il metodo di Newton rimbalzava senza convergere e la stella (S2 nel 2026)
 * saltava da un punto all'altro dell'orbita. Se Newton esce dall'intervallo, si passa alla
 * bisezione, che converge sempre.
 */
export function keplerE(M: number, e: number): number {
  let lo = -Math.PI, hi = Math.PI;
  let E = M + 0.85 * e * Math.sign(Math.sin(M));
  for (let k = 0; k < 50; k++) {
    const f = E - e * Math.sin(E) - M;
    if (Math.abs(f) < 1e-13) return E;
    // f cresce con E: si restringe l'intervallo che contiene la soluzione
    if (f > 0) hi = Math.min(hi, E);
    else lo = Math.max(lo, E);
    let next = E - f / (1 - e * Math.cos(E));
    if (!(next > lo && next < hi)) next = 0.5 * (lo + hi);
    if (Math.abs(next - E) < 1e-14) return next;
    E = next;
  }
  return E;
}

/** Semiasse maggiore in km. */
export function skyOrbitAKm(o: SkyOrbit): number {
  return o.a_arcsec * o.dist_pc * AU_KM;
}

/** GM implicito nell'orbita (km³/s²): dalla terza legge di Keplero con a e periodo misurati. */
export function skyOrbitMu(o: SkyOrbit): number {
  const a = skyOrbitAKm(o);
  const T = o.period_y * YEAR_S;
  return (4 * Math.PI * Math.PI * a ** 3) / (T * T);
}

function position(o: SkyOrbit, year: number, ra: number, dec: number, out: Vector3): Vector3 {
  const M = (2 * Math.PI * (year - o.tp_year)) / o.period_y;
  const E = keplerE(((M % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI, o.e);
  const a = skyOrbitAKm(o);
  const r = a * (1 - o.e * Math.cos(E));
  const nu = 2 * Math.atan2(Math.sqrt(1 + o.e) * Math.sin(E / 2), Math.sqrt(1 - o.e) * Math.cos(E / 2));
  const u = o.omega_deg * DEG + nu;
  const W = o.Omega_deg * DEG, inc = o.i_deg * DEG;
  const north = r * (Math.cos(u) * Math.cos(W) - Math.sin(u) * Math.sin(W) * Math.cos(inc));
  const east = r * (Math.cos(u) * Math.sin(W) + Math.sin(u) * Math.cos(W) * Math.cos(inc));
  const away = r * Math.sin(u) * Math.sin(inc);
  const ca = Math.cos(ra), sa = Math.sin(ra), cd = Math.cos(dec), sd = Math.sin(dec);
  // versori in ICRF nella direzione (ra, dec): verso la sorgente, est, nord
  return out.set(
    away * cd * ca - east * sa - north * sd * ca,
    away * cd * sa + east * ca - north * sd * sa,
    away * sd + north * cd,
  );
}

const _a = new Vector3();
const _b = new Vector3();

/**
 * Posizione (km) e velocità (km/s) rispetto al corpo centrale, in ICRF.
 * @param raDeg, decDeg direzione del corpo centrale vista dalla Terra
 */
export function skyOrbitState(o: SkyOrbit, jdTdb: number, raDeg: number, decDeg: number, pos: Vector3, vel: Vector3): void {
  const year = 2000 + (jdTdb - 2451545.0) / 365.25;
  const ra = raDeg * DEG, dec = decDeg * DEG;
  position(o, year, ra, dec, pos);
  const dy = 0.5 / 365.25; // mezzo giorno
  position(o, year + dy, ra, dec, _a);
  position(o, year - dy, ra, dec, _b);
  vel.subVectors(_a, _b).divideScalar(2 * dy * YEAR_S);
}

/**
 * Versore perpendicolare al piano di un'orbita data sul cielo (inclinazione i, nodo Ω), orientato
 * secondo il verso del moto (regola della mano destra), in ICRF. Serve anche a orientare il gas che
 * gira attorno a Sagittarius A*.
 */
export function skyPlaneNormal(iDeg: number, OmegaDeg: number, raDeg: number, decDeg: number, out = new Vector3()): Vector3 {
  const o: SkyOrbit = { a_arcsec: 1, e: 0, i_deg: iDeg, Omega_deg: OmegaDeg, omega_deg: 0, tp_year: 0, period_y: 1, dist_pc: 1 };
  const ra = raDeg * DEG, dec = decDeg * DEG;
  position(o, 0, ra, dec, _a);
  position(o, 0.25, ra, dec, _b);
  return out.crossVectors(_a, _b).normalize();
}
