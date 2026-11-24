/**
 * Fisica vicino a un buco nero che non ruota (Schwarzschild), per Sagittarius A*.
 *
 * Distanze in raggi di Schwarzschild (rs = 2GM/c²), velocità in frazioni della velocità della luce.
 * Le grandezze sono quelle di un osservatore "fermo", che si tiene sospeso con i razzi a distanza
 * costante dal buco nero: è il punto di vista della camera dell'atlante.
 *
 * La rotazione di Sgr A* non è ancora misurata con certezza (le immagini dell'EHT e i lampi visti da
 * GRAVITY suggeriscono che ruoti, forse anche in fretta): qui, per semplicità, non ruota.
 */

export const C_KM_S = 299792.458;

/** Ritmo dell'orologio di chi sta fermo a r, rispetto a chi è lontano: dτ/dt = √(1 − 1/r). */
export function clockRate(r: number): number {
  return Math.sqrt(Math.max(0, 1 - 1 / r));
}

/** La luce che arriva da lontano, per chi sta fermo a r, ha la frequenza moltiplicata per questo (verso il blu). */
export function blueshift(r: number): number {
  return 1 / Math.max(clockRate(r), 1e-9);
}

/** Velocità di fuga misurata da chi sta fermo a r (frazione di c): √(1/r), la stessa formula di Newton. */
export function escapeSpeed(r: number): number {
  return Math.sqrt(Math.min(1, 1 / r));
}

/** Accelerazione dei razzi per restare fermi a r (m/s²): GM / (R² √(1 − rs/R)), con GM = rs·c²/2. */
export function hoverAccel(r: number, rsKm: number): number {
  const c = C_KM_S * 1000, rsM = rsKm * 1000;
  return (c * c) / (2 * rsM * r * r * Math.max(clockRate(r), 1e-9));
}

/**
 * Orbita circolare a r: velocità (misurata da chi sta fermo lì, in c), periodo per chi guarda da
 * lontano e per chi orbita (secondi). Sotto la sfera dei fotoni (1,5 rs) non esiste; fra 1,5 e 3 rs
 * esiste ma non è stabile (basta una spinta minima per cadere dentro o scappare).
 */
export function circularOrbit(r: number, rsKm: number): { speed: number; periodFar: number; periodOwn: number; stable: boolean } | null {
  if (r <= 1.5) return null;
  const periodFar = 2 * Math.PI * Math.sqrt(2 * r ** 3) * (rsKm / C_KM_S);
  return {
    speed: Math.min(1, Math.sqrt(0.5 / (r - 1))),
    periodFar,
    periodOwn: periodFar * Math.sqrt(Math.max(0, 1 - 1.5 / r)),
    stable: r >= 3,
  };
}

/** Marea: differenza di accelerazione fra i due capi di un corpo lungo `lengthM` metri, in direzione del buco nero (m/s²). */
export function tidalAccel(r: number, rsKm: number, lengthM: number): number {
  const c = C_KM_S * 1000, rsM = rsKm * 1000;
  return (c * c * lengthM) / (rsM * rsM * r ** 3);
}

/**
 * Raggio angolare dell'ombra per chi sta fermo a r (radianti): sin α = (3√3/2)·√(1 − 1/r) / r.
 * Alla sfera dei fotoni l'ombra copre metà cielo; più vicino ancora, quasi tutto.
 */
export function shadowRadius(r: number): number {
  const a = Math.asin(Math.min(1, (1.5 * Math.sqrt(3) * clockRate(r)) / r));
  return r >= 1.5 ? a : Math.PI - a;
}

// ------------------------------------------------------------------ lampi

/**
 * Lampi di Sgr A*. Quasi ogni giorno, nell'infrarosso e nei raggi X, Sgr A* si illumina per un'ora
 * o due. Lo strumento GRAVITY (ESO) ha visto, durante i lampi, una "macchia calda" di gas girare
 * attorno al buco nero a circa 8 raggi gravitazionali (4 rs), con un giro in 45-60 minuti, al 30%
 * della velocità della luce. Qui i lampi seguono un calendario pseudocasuale ma ripetibile (lo stesso
 * istante dà sempre lo stesso lampo): in media tre al giorno, ognuno di un'ora e mezza.
 */
export interface Flare {
  /** luminosità della macchia calda (0 = nessun lampo) */
  amp: number;
  /** posizione lungo l'orbita (radianti) */
  phase: number;
  /** frazione della durata del lampo già trascorsa (la macchia si allunga lungo l'orbita) */
  age: number;
}

export const HOTSPOT_R = 4.2;
const SLOT_S = 6 * 3600;
const FLARE_S = 90 * 60;
const RISE_S = 15 * 60;
const NONE: Flare = { amp: 0, phase: 0, age: 0 };

function hash01(k: number, salt: number): number {
  let x = (Math.imul(k | 0, 374761393) + Math.imul(salt, 668265263)) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** inizio (s) del lampo della fascia di sei ore k, o null se in quella fascia non ce n'è */
function flareStart(k: number): number | null {
  if (hash01(k, 1) > 0.75) return null;
  return k * SLOT_S + hash01(k, 2) * (SLOT_S - FLARE_S);
}

/** Il lampo in corso all'istante tSec (secondi di tempo della simulazione). */
export function flareAt(tSec: number, rsKm: number, spin = 0): Flare {
  const k = Math.floor(tSec / SLOT_S);
  const t0 = flareStart(k);
  if (t0 === null) return NONE;
  const dt = tSec - t0;
  if (dt < 0 || dt > FLARE_S) return NONE;
  const peak = 0.6 + 1.4 * hash01(k, 3);
  const fadeOut = Math.min(1, (FLARE_S - dt) / (10 * 60));
  const amp = dt < RISE_S
    ? peak * Math.sin((0.5 * Math.PI * dt) / RISE_S) ** 2
    : peak * Math.exp(-(dt - RISE_S) / (30 * 60)) * fadeOut;
  const T = hotspotPeriod(rsKm, spin);
  return { amp, phase: 2 * Math.PI * (hash01(k, 4) + dt / T), age: dt / FLARE_S };
}

/**
 * Periodo dell'orbita della macchia calda (s), nel verso della rotazione del buco nero:
 * T = 2π (r^{3/2} + a) in unità di GM/c³, con r in GM/c². Senza rotazione è quello di circularOrbit.
 */
export function hotspotPeriod(rsKm: number, spin = 0): number {
  return 2 * Math.PI * ((2 * HOTSPOT_R) ** 1.5 + spin) * (rsKm / 2 / C_KM_S);
}

/** Inizio del prossimo lampo dopo tSec (secondi), cercando nei due giorni seguenti. */
export function nextFlare(tSec: number): number | null {
  const k0 = Math.floor(tSec / SLOT_S);
  for (let k = k0; k < k0 + 8; k++) {
    const t0 = flareStart(k);
    if (t0 !== null && t0 > tSec) return t0;
  }
  return null;
}

/** Durata di un lampo (s). */
export const FLARE_DURATION_S = FLARE_S;

// ------------------------------------------------------------------ deviazione della luce

/**
 * Raggio di luce che parte da chi sta fermo a r0 = 1/u0, con un angolo ψ dalla direzione "verso
 * fuori" (opposta al buco nero): di quanto gira attorno al buco nero prima di sfuggire? Restituisce
 * l'angolo polare finale φ∞ (attorno al buco nero, contato dalla direzione della camera), o null
 * se il raggio cade nel buco nero. Senza gravità sarebbe φ∞ = ψ.
 * Equazione delle orbite della luce: d²u/dφ² = −u + 3/2·u², integrata con Runge-Kutta; oltre
 * 10.000 rs, in uscita, il pochissimo che resta della deviazione si stima con la formula del campo
 * debole (più vicino quella formula, nelle coordinate di Schwarzschild, sbaglierebbe di parecchio).
 */
export function escapeAngle(u0: number, psi: number, maxSteps = 4000): number | null {
  const sp = Math.max(Math.sin(psi), 1e-15), cp = Math.cos(psi);
  const lapse0 = Math.sqrt(Math.max(1 - u0, 1e-15));
  let u = u0, up = (-u0 * lapse0 * cp) / sp, phi = 0;
  const f = (x: number) => -x + 1.5 * x * x;
  for (let i = 0; i < maxSteps; i++) {
    if (up <= 0 && u < 1e-4) {
      const bb = 1 / Math.sqrt(Math.max(up * up + u * u * (1 - u), 1e-300));
      const bu = Math.min(bb * u, 1);
      return phi + Math.atan2(u, -up) + (1 - Math.sqrt(1 - bu * bu)) / bb;
    }
    const h = Math.min(0.04, (0.2 * u) / Math.max(Math.abs(up), 1e-300));
    const k1u = up, k1p = f(u);
    const k2u = up + 0.5 * h * k1p, k2p = f(u + 0.5 * h * k1u);
    const k3u = up + 0.5 * h * k2p, k3p = f(u + 0.5 * h * k2u);
    const k4u = up + h * k3p, k4p = f(u + h * k3u);
    u += (h / 6) * (k1u + 2 * k2u + 2 * k3u + k4u);
    up += (h / 6) * (k1p + 2 * k2p + 2 * k3p + k4p);
    phi += h;
    if (u >= 1) return null;
    if (u <= 0) return phi;
  }
  return null;
}

/**
 * Tabella della deviazione per chi sta fermo a r0: per un raggio che parte a un angolo θ dalla
 * direzione del buco nero (θ > raggio dell'ombra α), l'angolo φ∞ di escapeAngle. I campioni sono
 * fitti vicino al bordo dell'ombra, dove la deviazione cresce senza limite:
 *     θ = α + (π − α)·(e^{K·t} − 1)/(e^K − 1),   t = (k + ½)/n.
 * Basta un'unica tabella per tutta l'immagine: per simmetria il raggio resta nel piano che contiene
 * il buco nero, e la deviazione dipende solo da θ.
 */
export const LUT_K = 8;

export function deflectionLut(r0: number, n: number, out = new Float32Array(n)): Float32Array {
  const alpha = shadowRadius(r0);
  const span = Math.PI - alpha, eK = Math.exp(LUT_K) - 1;
  let last = 0;
  for (let k = n - 1; k >= 0; k--) {
    const th = alpha + (span * (Math.exp((LUT_K * (k + 0.5)) / n) - 1)) / eK;
    const v = escapeAngle(1 / r0, Math.PI - th);
    // vicinissimo al bordo i giri attorno al buco nero diventano troppi: si tiene il valore accanto
    out[k] = v ?? last;
    last = out[k];
  }
  return out;
}
