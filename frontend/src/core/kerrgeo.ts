/**
 * Raggi di luce attorno a un buco nero che ruota (Kerr), in coordinate di Kerr-Schild cartesiane.
 *
 * In queste coordinate (x, y, z con l'asse di rotazione lungo z, lunghezze in M = GM/c²) la metrica è
 *     g_{μν} = η_{μν} + f·l_μ·l_ν,     f = 2r³ / (r⁴ + a²z²),
 *     l_μ = (1, (r·x + a·y)/(r² + a²), (r·y − a·x)/(r² + a²), z/r),
 * dove r è la soluzione positiva di r⁴ − (x² + y² + z² − a²)·r² − a²z² = 0. Non ci sono le
 * singolarità ai poli delle coordinate sferiche, e l'orizzonte si attraversa senza problemi.
 * Il raggio segue le equazioni di Hamilton con H = ½ g^{μν} p_μ p_ν = ½(−p_t² + |p|²) − ½ f (l·p)²,
 * con l·p = −p_t + l_i p_i; p_t si conserva (è meno l'energia). Integrazione: Runge-Kutta 4.
 *
 * Seguire un raggio all'indietro nel tempo (dalla camera verso la sorgente, come serve alla
 * grafica) equivale a seguirlo in avanti attorno a un buco nero che ruota al contrario: basta
 * chiamare queste funzioni con −a. Le stesse formule sono riscritte in GLSL in render/blackhole.ts.
 */

import { LUT_K } from './blackhole';

export type Vec3 = [number, number, number];
export type Vec4 = [number, number, number, number];

/** raggio di Boyer-Lindquist del punto (x, y, z) */
export function ksRadius(a: number, x: number, y: number, z: number): number {
  const w = x * x + y * y + z * z - a * a;
  return Math.sqrt(0.5 * (w + Math.sqrt(w * w + 4 * a * a * z * z)));
}

/** f e l (parte spaziale) nel punto */
function fl(a: number, x: number, y: number, z: number): { f: number; l: Vec3 } {
  const r = Math.max(ksRadius(a, x, y, z), 1e-9);
  const r2 = r * r, d = r2 + a * a;
  return { f: (2 * r2 * r) / (r2 * r2 + a * a * z * z), l: [(r * x + a * y) / d, (r * y - a * x) / d, z / r] };
}

/** derivate di posizione e impulso lungo il raggio: out = [dx, dy, dz, dpx, dpy, dpz] */
function deriv(a: number, s: Float64Array, pt: number, out: Float64Array): void {
  const x = s[0], y = s[1], z = s[2], px = s[3], py = s[4], pz = s[5];
  const a2 = a * a;
  const w = x * x + y * y + z * z - a2;
  const D = Math.sqrt(w * w + 4 * a2 * z * z);
  const r2 = Math.max(0.5 * (w + D), 1e-18), r = Math.sqrt(r2);
  const d = r2 + a2;
  const G = r2 * r2 + a2 * z * z;
  const f = (2 * r2 * r) / G;
  const lx = (r * x + a * y) / d, ly = (r * y - a * x) / d, lz = z / r;
  const lp = -pt + lx * px + ly * py + lz * pz;
  const k = f * lp;
  out[0] = px - k * lx; out[1] = py - k * ly; out[2] = pz - k * lz;
  // gradiente di r
  const Ds = Math.max(D, 1e-18);
  const rx = (x * r) / Ds, ry = (y * r) / Ds, rz = (z * d) / (r * Ds);
  // gradiente di f
  const fr = (6 * r2 * G - 8 * r2 * r2 * r2) / (G * G);
  const fz = (-4 * r2 * r * a2 * z) / (G * G);
  // gradiente di S = l·p (parte spaziale)
  const Sr = (px * (x * d - (r * x + a * y) * 2 * r) + py * (y * d - (r * y - a * x) * 2 * r)) / (d * d) - (pz * z) / r2;
  const Sx = Sr * rx + (r * px - a * py) / d;
  const Sy = Sr * ry + (a * px + r * py) / d;
  const Sz = Sr * rz + pz / r;
  const h2 = 0.5 * lp * lp;
  out[3] = h2 * fr * rx + k * Sx;
  out[4] = h2 * fr * ry + k * Sy;
  out[5] = h2 * (fr * rz + fz) + k * Sz;
}

/** p_t (negativo: energia positiva) di un fotone con impulso spaziale p nel punto x */
export function nullEnergy(a: number, x: Vec3, p: Vec3): number {
  const { f, l } = fl(a, x[0], x[1], x[2]);
  const s = l[0] * p[0] + l[1] * p[1] + l[2] * p[2];
  const P2 = p[0] * p[0] + p[1] * p[1] + p[2] * p[2];
  return (f * s - Math.sqrt(f * f * s * s + (1 + f) * (P2 - f * s * s))) / (1 + f);
}

export interface TraceResult {
  /** 'escaped': uscito oltre rMax; 'captured': caduto oltre l'orizzonte; 'lost': troppi passi */
  fate: 'escaped' | 'captured' | 'lost';
  /** direzione finale del moto (versore), se è sfuggito */
  dir: Vec3;
  /** distanza minima raggiunta (raggio di Boyer-Lindquist) */
  rMin: number;
  steps: number;
}

const _s = new Float64Array(6), _t = new Float64Array(6);
const _k1 = new Float64Array(6), _k2 = new Float64Array(6), _k3 = new Float64Array(6), _k4 = new Float64Array(6);

/** Segue un fotone con impulso covariante (p, pt) da x0 finché sfugge oltre rMax o cade nel buco nero. */
export function traceMomentum(a: number, x0: Vec3, p0: Vec3, pt: number, rMax = 1000, maxSteps = 6000): TraceResult {
  const s = _s;
  s[0] = x0[0]; s[1] = x0[1]; s[2] = x0[2]; s[3] = p0[0]; s[4] = p0[1]; s[5] = p0[2];
  const rH = 1 + Math.sqrt(Math.max(0, 1 - a * a));
  let rMin = Infinity;
  for (let i = 0; i < maxSteps; i++) {
    const r = ksRadius(a, s[0], s[1], s[2]);
    if (r < rMin) rMin = r;
    if (r < rH * 1.01) return { fate: 'captured', dir: [0, 0, 0], rMin, steps: i };
    deriv(a, s, pt, _k1);
    if (r > rMax && s[0] * _k1[0] + s[1] * _k1[1] + s[2] * _k1[2] > 0) {
      const v = Math.hypot(_k1[0], _k1[1], _k1[2]);
      return { fate: 'escaped', dir: [_k1[0] / v, _k1[1] / v, _k1[2] / v], rMin, steps: i };
    }
    // passo: piccolo vicino al buco nero, lungo lontano (la velocità coordinata vale circa −p_t)
    const h = Math.min(0.05 * r, Math.max(0.02, 0.1 * (r - rH))) / Math.max(-pt, 1e-9);
    for (let j = 0; j < 6; j++) _t[j] = s[j] + 0.5 * h * _k1[j];
    deriv(a, _t, pt, _k2);
    for (let j = 0; j < 6; j++) _t[j] = s[j] + 0.5 * h * _k2[j];
    deriv(a, _t, pt, _k3);
    for (let j = 0; j < 6; j++) _t[j] = s[j] + h * _k3[j];
    deriv(a, _t, pt, _k4);
    for (let j = 0; j < 6; j++) s[j] += (h / 6) * (_k1[j] + 2 * _k2[j] + 2 * _k3[j] + _k4[j]);
  }
  return { fate: 'lost', dir: [0, 0, 0], rMin, steps: maxSteps };
}

/** Segue un fotone che parte da x0 nella direzione (coordinata) dir0. */
export function traceRay(a: number, x0: Vec3, dir0: Vec3, rMax = 1000, maxSteps = 6000): TraceResult {
  const n = Math.hypot(dir0[0], dir0[1], dir0[2]);
  const p: Vec3 = [dir0[0] / n, dir0[1] / n, dir0[2] / n];
  return traceMomentum(a, x0, p, nullEnergy(a, x0, p), rMax, maxSteps);
}

// ------------------------------------------------------------------ la camera

/**
 * La camera: un osservatore fermo (sospeso con i razzi) nel punto pos = (ρ, 0, z), fuori dall'ergosfera.
 * Il suo sistema di riferimento locale ha tre assi ortogonali costruiti a partire da:
 *   c  = la direzione verso il centro del buco nero,
 *   ea = l'asse di rotazione, tolta la parte lungo c (verso il «nord» sul cielo della camera),
 *   eb = c × ea.
 * Una direzione di vista è data da ψ (angolo da c) e χ (angolo attorno a c, da ea verso eb).
 * U ed E[k] sono i vettori covarianti (t, x, y, z) con cui si costruisce l'impulso del fotone:
 *   p_μ = U_μ + cosψ·E0_μ + sinψ·cosχ·E1_μ + sinψ·sinχ·E2_μ.
 */
export interface KerrCamera {
  a: number;
  pos: Vec3;
  c: Vec3; ea: Vec3; eb: Vec3;
  U: Vec4;
  E: [Vec4, Vec4, Vec4];
  /** frequenza della luce che arriva da lontano, rispetto a come parte (spostamento verso il blu) */
  blueshift: number;
}

export function kerrCamera(a: number, rho: number, z: number): KerrCamera {
  const pos: Vec3 = [rho, 0, z];
  const R = Math.hypot(rho, z);
  const c: Vec3 = [-rho / R, 0, -z / R];
  // asse z tolta la parte lungo c; al polo va bene l'asse x
  let ea: Vec3 = [-c[2] * c[0], 0, 1 - c[2] * c[2]];
  let n = Math.hypot(ea[0], ea[2]);
  if (n < 1e-6) { ea = [1, 0, 0]; n = 1; }
  ea = [ea[0] / n, 0, ea[2] / n];
  const eb: Vec3 = [c[1] * ea[2] - c[2] * ea[1], c[2] * ea[0] - c[0] * ea[2], c[0] * ea[1] - c[1] * ea[0]];
  const { f, l } = fl(a, rho, 0, z);
  const L: Vec4 = [1, l[0], l[1], l[2]];
  const dot = (u: Vec4, v: Vec4) => {
    const lu = L[0] * u[0] + L[1] * u[1] + L[2] * u[2] + L[3] * u[3];
    const lv = L[0] * v[0] + L[1] * v[1] + L[2] * v[2] + L[3] * v[3];
    return -u[0] * v[0] + u[1] * v[1] + u[2] * v[2] + u[3] * v[3] + f * lu * lv;
  };
  const lower = (u: Vec4): Vec4 => {
    const lu = L[0] * u[0] + L[1] * u[1] + L[2] * u[2] + L[3] * u[3];
    return [-u[0] + f * lu * L[0], u[1] + f * lu * L[1], u[2] + f * lu * L[2], u[3] + f * lu * L[3]];
  };
  // osservatore fermo: quadrivelocità lungo il tempo
  const u: Vec4 = [1 / Math.sqrt(Math.max(1 - f, 1e-12)), 0, 0, 0];
  const legs: Vec4[] = [];
  for (const v of [c, ea, eb]) {
    let e: Vec4 = [0, v[0], v[1], v[2]];
    const ku = dot(e, u); // u·u = −1
    e = [e[0] + ku * u[0], e[1] + ku * u[1], e[2] + ku * u[2], e[3] + ku * u[3]];
    for (const g of legs) {
      const kg = dot(e, g);
      e = [e[0] - kg * g[0], e[1] - kg * g[1], e[2] - kg * g[2], e[3] - kg * g[3]];
    }
    const m = Math.sqrt(dot(e, e));
    legs.push([e[0] / m, e[1] / m, e[2] / m, e[3] / m]);
  }
  return { a, pos, c, ea, eb, U: lower(u), E: [lower(legs[0]), lower(legs[1]), lower(legs[2])], blueshift: u[0] };
}

/** Il raggio che la camera vede nella direzione (ψ, χ), seguito fino in fondo. */
export function traceView(cam: KerrCamera, psi: number, chi: number, rMax: number): TraceResult {
  const n0 = Math.cos(psi), n1 = Math.sin(psi) * Math.cos(chi), n2 = Math.sin(psi) * Math.sin(chi);
  const p: Vec4 = [0, 0, 0, 0];
  for (let m = 0; m < 4; m++) p[m] = cam.U[m] + n0 * cam.E[0][m] + n1 * cam.E[1][m] + n2 * cam.E[2][m];
  return traceMomentum(cam.a, cam.pos, [p[1], p[2], p[3]], p[0], rMax);
}

// ------------------------------------------------------------------ tabella della deviazione

/**
 * Tabella 2D della deviazione della luce per una camera ferma a (ρ, z), seguendo i raggi all'indietro
 * (cioè con −a, vedi in testa al file). Per ognuna delle `nChi` direzioni χ attorno al centro:
 *  - il bordo dell'ombra ψ_bordo(χ), trovato per bisezione;
 *  - `nT` raggi fra il bordo e ψmax, fitti vicino al bordo (stessa legge della tabella 1D:
 *    ψ = bordo + (ψmax − bordo)·(e^{K·t} − 1)/(e^K − 1), t = (k + ½)/nT), con la direzione da cui
 *    arriva la luce (versore x, y, z).
 * data: nChi righe × nT colonne × 4 numeri (dx, dy, dz, ψ_bordo della riga).
 */
export interface KerrLut { nChi: number; nT: number; psiMax: number; data: Float32Array }

export function kerrLut(aSpin: number, rho: number, z: number, psiMax: number, nChi = 64, nT = 48): KerrLut {
  const cam = kerrCamera(-aSpin, rho, z);
  const R = Math.hypot(rho, z);
  const rMax = Math.max(400, 2.5 * R);
  const data = new Float32Array(nChi * nT * 4);
  const eK = Math.exp(LUT_K) - 1;
  for (let j = 0; j < nChi; j++) {
    const chi = (2 * Math.PI * j) / nChi;
    // bordo dell'ombra: verso il centro (ψ = 0) il raggio cade, a ψmax sfugge
    let lo = 0, hi = psiMax;
    for (let b = 0; b < 18; b++) {
      const mid = 0.5 * (lo + hi);
      if (traceView(cam, mid, chi, rMax).fate === 'escaped') hi = mid; else lo = mid;
    }
    const edge = hi;
    let last: Vec3 = [0, 0, 0];
    for (let k = nT - 1; k >= 0; k--) {
      const psi = edge + ((psiMax - edge) * (Math.exp((LUT_K * (k + 0.5)) / nT) - 1)) / eK;
      const t = traceView(cam, psi, chi, rMax);
      if (t.fate === 'escaped') last = t.dir;
      const o = (j * nT + k) * 4;
      data[o] = last[0]; data[o + 1] = last[1]; data[o + 2] = last[2]; data[o + 3] = edge;
    }
  }
  return { nChi, nT, psiMax, data };
}

/**
 * Accelerazione (in c²/M) che deve sentire chi sta fermo in (ρ, 0, z) per non cadere né farsi
 * trascinare: a_i = ½ ∂_i f / (1 − f), |a|² = |a|²_piatto − f (l·a)². Infinita sul bordo dell'ergosfera.
 */
export function staticAccel(a: number, rho: number, z: number): number {
  const { f, l } = fl(a, rho, 0, z);
  if (f >= 1) return Infinity;
  const h = 1e-5 * Math.max(1, Math.hypot(rho, z));
  const g: Vec3 = [
    (fl(a, rho + h, 0, z).f - fl(a, rho - h, 0, z).f) / (2 * h),
    (fl(a, rho, h, z).f - fl(a, rho, -h, z).f) / (2 * h),
    (fl(a, rho, 0, z + h).f - fl(a, rho, 0, z - h).f) / (2 * h),
  ];
  const k = 0.5 / (1 - f);
  const ax = k * g[0], ay = k * g[1], az = k * g[2];
  const la = l[0] * ax + l[1] * ay + l[2] * az;
  return Math.sqrt(Math.max(0, ax * ax + ay * ay + az * az - f * la * la));
}

/** Velocità di fuga (frazione di c) misurata da chi sta fermo in (ρ, 0, z): √f. */
export function staticEscapeSpeed(a: number, rho: number, z: number): number {
  return Math.sqrt(Math.min(1, fl(a, rho, 0, z).f));
}
