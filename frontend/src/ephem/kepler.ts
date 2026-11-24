/**
 * Meccanica orbitale dei due corpi: equazione di Keplero (ellissi, parabole,
 * iperboli), passaggio elementi <-> vettori di stato, geometria delle orbite.
 */

import { Vector3 } from 'three';

const TWO_PI = Math.PI * 2;

/** Elementi "universali": valgono per ogni eccentricità. Angoli in radianti, tp in JD. */
export interface Conic {
  q: number;   // distanza al pericentro
  e: number;   // eccentricità
  i: number;   // inclinazione
  om: number;  // longitudine del nodo ascendente (Ω)
  w: number;   // argomento del pericentro (ω)
  tp: number;  // istante del passaggio al pericentro (JD TDB)
}

export function solveElliptic(M: number, e: number): number {
  M = M % TWO_PI;
  if (M > Math.PI) M -= TWO_PI;
  else if (M < -Math.PI) M += TWO_PI;
  let E = e < 0.8 ? M + e * Math.sin(M) : (M >= 0 ? Math.PI : -Math.PI);
  for (let k = 0; k < 60; k++) {
    const f = E - e * Math.sin(E) - M;
    const d = f / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-14) break;
  }
  return E;
}

export function solveHyperbolic(M: number, e: number): number {
  let H = Math.asinh(M / e);
  for (let k = 0; k < 80; k++) {
    const f = e * Math.sinh(H) - H - M;
    const d = f / (e * Math.cosh(H) - 1);
    H -= d;
    if (Math.abs(d) < 1e-13 * Math.max(1, Math.abs(H))) break;
  }
  return H;
}

/** Vettori P (verso il pericentro) e Q (90° più avanti) nel piano di riferimento. */
export function perifocalBasis(i: number, om: number, w: number, P = new Vector3(), Q = new Vector3()): [Vector3, Vector3] {
  const co = Math.cos(om), so = Math.sin(om), cw = Math.cos(w), sw = Math.sin(w), ci = Math.cos(i), si = Math.sin(i);
  P.set(co * cw - so * sw * ci, so * cw + co * sw * ci, sw * si);
  Q.set(-co * sw - so * cw * ci, -so * sw + co * cw * ci, cw * si);
  return [P, Q];
}

/**
 * Posizione (e velocità) all'istante jd nel piano di riferimento degli elementi.
 * mu nelle unità coerenti con q e con il giorno come unità di tempo
 * (per il Sole in UA: k² = 2,959e-4 UA³/giorno²).
 */
export function conicState(c: Conic, jd: number, mu: number, pos: Vector3, vel?: Vector3): void {
  const { q, e } = c;
  const dt = jd - c.tp;
  let xp: number, yp: number, vxp = 0, vyp = 0;
  if (e < 0.999999) {
    const a = q / (1 - e);
    const n = Math.sqrt(mu / (a * a * a));
    const E = solveElliptic(n * dt, e);
    const cE = Math.cos(E), sE = Math.sin(E), b = Math.sqrt(1 - e * e);
    xp = a * (cE - e);
    yp = a * b * sE;
    const r = a * (1 - e * cE);
    const k = Math.sqrt(mu * a) / r;
    vxp = -k * sE;
    vyp = k * b * cE;
  } else if (e > 1.000001) {
    const A = q / (e - 1); // = -a
    const n = Math.sqrt(mu / (A * A * A));
    const H = solveHyperbolic(n * dt, e);
    const ch = Math.cosh(H), sh = Math.sinh(H), b = Math.sqrt(e * e - 1);
    xp = A * (e - ch);
    yp = A * b * sh;
    const r = A * (e * ch - 1);
    const k = Math.sqrt(mu * A) / r;
    vxp = -k * sh;
    vyp = k * b * ch;
  } else {
    // parabola: equazione di Barker
    const Mp = Math.sqrt(mu / (2 * q * q * q)) * dt;
    const A = 1.5 * Mp;
    const Y = Math.cbrt(A + Math.sqrt(A * A + 1));
    const s = Y - 1 / Y;
    xp = q * (1 - s * s);
    yp = 2 * q * s;
    const h = Math.sqrt(2 * mu * q);
    const den = 1 + s * s;
    const sinNu = (2 * s) / den, cosNu = (1 - s * s) / den;
    vxp = (-mu / h) * sinNu;
    vyp = (mu / h) * (1 + cosNu);
  }
  const [P, Q] = perifocalBasis(c.i, c.om, c.w, _P, _Q);
  pos.set(xp * P.x + yp * Q.x, xp * P.y + yp * Q.y, xp * P.z + yp * Q.z);
  if (vel) vel.set(vxp * P.x + vyp * Q.x, vxp * P.y + vyp * Q.y, vxp * P.z + vyp * Q.z);
}
const _P = new Vector3();
const _Q = new Vector3();

/** Orbita osculatrice ricavata da posizione e velocità (frame qualsiasi). */
export interface Osculating {
  e: number;
  a: number;          // negativo per le iperboli
  q: number;          // pericentro
  Q: number | null;   // apocentro (null se aperta)
  p: number;          // semilato retto
  period: number | null; // secondi (se mu in km^3/s^2)
  nu: number;         // anomalia vera attuale
  P: Vector3;         // direzione del pericentro
  Qv: Vector3;        // perpendicolare nel piano
  W: Vector3;         // normale al piano (momento angolare)
  h: number;
}

export function osculating(r: Vector3, v: Vector3, mu: number): Osculating | null {
  const rl = r.length();
  if (rl === 0 || mu <= 0) return null;
  const hVec = new Vector3().crossVectors(r, v);
  const h = hVec.length();
  if (h === 0) return null;
  const v2 = v.lengthSq();
  const rv = r.dot(v);
  const eVec = r.clone().multiplyScalar(v2 - mu / rl).addScaledVector(v, -rv).multiplyScalar(1 / mu);
  const e = eVec.length();
  const energy = v2 / 2 - mu / rl;
  const a = Math.abs(energy) > 1e-20 ? -mu / (2 * energy) : Infinity;
  const p = (h * h) / mu;
  const W = hVec.clone().divideScalar(h);
  const P = e > 1e-8 ? eVec.clone().divideScalar(e) : r.clone().divideScalar(rl);
  const Qv = new Vector3().crossVectors(W, P);
  const nu = Math.atan2(r.dot(Qv), r.dot(P));
  const q = p / (1 + e);
  const Q = e < 1 ? p / (1 - e) : null;
  const period = e < 1 ? TWO_PI * Math.sqrt((a * a * a) / mu) : null;
  return { e, a, q, Q, p, period, nu, P, Qv, W, h };
}

/**
 * Punti dell'orbita (relativi al corpo centrale) + "alpha" per la scia che sfuma.
 * Si parte dalla posizione attuale e si va all'indietro di un giro.
 */
export function orbitPoints(o: Osculating, n: number, maxR: number): { pts: Float32Array; alpha: Float32Array; count: number } {
  const pts = new Float32Array((n + 1) * 3);
  const alpha = new Float32Array(n + 1);
  let count = 0;
  const push = (x: number, y: number, al: number) => {
    pts[count * 3] = x * o.P.x + y * o.Qv.x;
    pts[count * 3 + 1] = x * o.P.y + y * o.Qv.y;
    pts[count * 3 + 2] = x * o.P.z + y * o.Qv.z;
    alpha[count] = al;
    count++;
  };
  const e = o.e;
  if (e < 0.99999) {
    const a = o.a;
    const b = a * Math.sqrt(1 - e * e);
    const E0 = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(o.nu / 2), Math.sqrt(1 + e) * Math.cos(o.nu / 2));
    for (let k = 0; k <= n; k++) {
      const E = E0 - (TWO_PI * k) / n;
      push(a * (Math.cos(E) - e), b * Math.sin(E), 1 - k / n);
    }
  } else if (e > 1.00001) {
    const A = o.p / (e * e - 1);
    const b = A * Math.sqrt(e * e - 1);
    // limite: r = A(e·coshH − 1) <= maxR
    const Hmax = Math.acosh(Math.max(1.0001, (maxR / A + 1) / e));
    const Hnow = 2 * Math.atanh(Math.sqrt((e - 1) / (e + 1)) * Math.tan(o.nu / 2));
    for (let k = 0; k <= n; k++) {
      const H = -Hmax + (2 * Hmax * k) / n;
      const d = Math.abs(H - Hnow) / (2 * Hmax);
      push(A * (e - Math.cosh(H)), b * Math.sinh(H), Math.max(0.15, 1 - d * 1.5));
    }
  } else {
    const q = o.q;
    const smax = Math.sqrt(Math.max(maxR / q - 1, 1));
    const sNow = Math.tan(o.nu / 2);
    for (let k = 0; k <= n; k++) {
      const s = -smax + (2 * smax * k) / n;
      const d = Math.abs(s - sNow) / (2 * smax);
      push(q * (1 - s * s), 2 * q * s, Math.max(0.15, 1 - d * 1.5));
    }
  }
  return { pts, alpha, count };
}

// ------------------------------------------------------------------ propagazione universale

function stumpffC(z: number): number {
  if (z > 1e-6) return (1 - Math.cos(Math.sqrt(z))) / z;
  if (z < -1e-6) return (Math.cosh(Math.sqrt(-z)) - 1) / -z;
  return 1 / 2 - z / 24 + (z * z) / 720;
}

function stumpffS(z: number): number {
  if (z > 1e-6) {
    const s = Math.sqrt(z);
    return (s - Math.sin(s)) / (s * s * s);
  }
  if (z < -1e-6) {
    const s = Math.sqrt(-z);
    return (Math.sinh(s) - s) / (s * s * s);
  }
  return 1 / 6 - z / 120 + (z * z) / 5040;
}

/**
 * Problema dei due corpi con le variabili universali (vale per ellissi, parabole e
 * iperboli): dallo stato (r0, v0) allo stato dopo dt secondi. Unità coerenti con mu
 * (km, km/s, km³/s²). Restituisce false se l'iterazione non converge.
 */
export function propagateUniversal(r0: Vector3, v0: Vector3, mu: number, dt: number, rOut: Vector3, vOut: Vector3): boolean {
  const r0m = r0.length();
  if (!(r0m > 0) || !(mu > 0) || !Number.isFinite(dt)) return false;
  if (dt === 0) {
    rOut.copy(r0);
    vOut.copy(v0);
    return true;
  }
  const sqmu = Math.sqrt(mu);
  const k1 = r0.dot(v0) / sqmu;            // r0·v0/√μ
  const alpha = 2 / r0m - v0.lengthSq() / mu; // 1/a
  const k2 = 1 - alpha * r0m;
  // F(χ) = 0 è l'equazione di Keplero universale; F cresce sempre con χ (dF/dχ = r > 0):
  // si tiene un intervallo che contiene la radice e si usa Newton finché resta dentro,
  // altrimenti si dimezza l'intervallo. Così converge sempre, anche per orbite quasi
  // paraboliche e intervalli di tempo lunghi.
  const target = sqmu * dt;
  const evalF = (chi: number): [number, number] => {
    const chi2 = chi * chi;
    const z = alpha * chi2;
    const C = stumpffC(z), S = stumpffS(z);
    const F = k1 * chi2 * C + k2 * chi2 * chi * S + r0m * chi - target;
    const r = chi2 * C + k1 * chi * (1 - z * S) + r0m * (1 - z * C);
    return [F, r];
  };
  const sgn = dt > 0 ? 1 : -1;
  let lo = 0, hi = sgn * Math.max(1e-12, Math.abs(target) / r0m);
  // allarga l'intervallo finché contiene la radice
  for (let k = 0; k < 200; k++) {
    const [F] = evalF(hi);
    if (!Number.isFinite(F) || F * sgn > 0) break;
    lo = hi;
    hi *= 2;
  }
  if (sgn < 0) [lo, hi] = [hi, lo];
  let chi = alpha > 1e-12 ? sqmu * dt * alpha : (lo + hi) / 2;
  if (!(chi > lo && chi < hi)) chi = (lo + hi) / 2;
  let ok = false;
  for (let it = 0; it < 200; it++) {
    const [F, r] = evalF(chi);
    if (!Number.isFinite(F)) {
      hi = chi;
      chi = (lo + hi) / 2;
      continue;
    }
    if (F < 0) lo = chi;
    else hi = chi;
    let next = chi - F / r;
    if (!(next > lo && next < hi) || !Number.isFinite(next)) next = (lo + hi) / 2;
    const step = Math.abs(next - chi);
    chi = next;
    if (step < 1e-12 * Math.max(1, Math.abs(chi)) || hi - lo < 1e-14 * Math.max(1, Math.abs(chi))) {
      ok = true;
      break;
    }
  }
  if (!ok || !Number.isFinite(chi)) return false;
  const chi2 = chi * chi;
  const z = alpha * chi2;
  const C = stumpffC(z), S = stumpffS(z);
  const f = 1 - (chi2 / r0m) * C;
  const g = dt - (chi2 * chi / sqmu) * S;
  rOut.copy(r0).multiplyScalar(f).addScaledVector(v0, g);
  const rm = rOut.length();
  const fdot = (sqmu / (rm * r0m)) * (alpha * chi2 * chi * S - chi);
  const gdot = 1 - (chi2 / rm) * C;
  vOut.copy(r0).multiplyScalar(fdot).addScaledVector(v0, gdot);
  return Number.isFinite(rm) && Number.isFinite(vOut.x);
}
