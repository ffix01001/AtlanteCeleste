/**
 * Fisica di un buco nero che ruota (Kerr), per Sagittarius A*.
 *
 * Qui le lunghezze sono in unità di M = GM/c² (mezzo raggio di Schwarzschild: rs = 2M) e lo spin
 * è a = a* fra 0 (non ruota) e 1 (rotazione massima). Coordinate di Boyer-Lindquist (r, θ dal polo).
 * Chi usa i raggi di Schwarzschild moltiplica o divide per 2 (vedi RS_PER_M).
 * Formule: Bardeen, Press e Teukolsky 1972 (ApJ 178, 347); Bardeen 1973 (bordo dell'ombra).
 */

export const RS_PER_M = 0.5;

/** Orizzonte degli eventi esterno: r+ = 1 + √(1 − a²). */
export function horizon(a: number): number {
  return 1 + Math.sqrt(Math.max(0, 1 - a * a));
}

/** Bordo dell'ergosfera alla colatitudine θ: dentro, nessuno può restare fermo rispetto alle stelle lontane. */
export function ergosphere(a: number, theta: number): number {
  const c = Math.cos(theta);
  return 1 + Math.sqrt(Math.max(0, 1 - a * a * c * c));
}

/** Ultima orbita circolare stabile nel piano equatoriale; prograde = nello stesso verso della rotazione. */
export function isco(a: number, prograde = true): number {
  const z1 = 1 + Math.cbrt(1 - a * a) * (Math.cbrt(1 + a) + Math.cbrt(1 - a));
  const z2 = Math.sqrt(3 * a * a + z1 * z1);
  const s = Math.sqrt(Math.max(0, (3 - z1) * (3 + z1 + 2 * z2)));
  return 3 + z2 + (prograde ? -s : s);
}

/** Orbita circolare dei fotoni nel piano equatoriale. */
export function photonOrbit(a: number, prograde = true): number {
  return 2 * (1 + Math.cos((2 / 3) * Math.acos(prograde ? -a : a)));
}

/** Velocità angolare (vista da lontano, in c³/GM) di un'orbita circolare equatoriale a r. */
export function keplerOmega(a: number, r: number, prograde = true): number {
  return prograde ? 1 / (r ** 1.5 + a) : -1 / (r ** 1.5 - a);
}

function metricParts(a: number, r: number, theta: number): { delta: number; sigma: number; A: number } {
  const c = Math.cos(theta), s = Math.sin(theta);
  const delta = r * r - 2 * r + a * a;
  const sigma = r * r + a * a * c * c;
  const A = (r * r + a * a) ** 2 - a * a * delta * s * s;
  return { delta, sigma, A };
}

/** Trascinamento dello spazio: velocità angolare con cui gira chi non ha momento angolare (ZAMO). */
export function frameDragOmega(a: number, r: number, theta: number): number {
  return (2 * a * r) / metricParts(a, r, theta).A;
}

/** Ritmo dell'orologio dello ZAMO rispetto a chi è lontano: dτ/dt = √(ΔΣ/A). Zero all'orizzonte. */
export function zamoClockRate(a: number, r: number, theta: number): number {
  const { delta, sigma, A } = metricParts(a, r, theta);
  return Math.sqrt(Math.max(0, (delta * sigma) / A));
}

/**
 * Bordo dell'ombra visto da molto lontano, da una direzione inclinata di `incl` rispetto all'asse.
 * Punti (α, β) in unità di M sul cielo: α perpendicolare all'asse di rotazione proiettato (il lato
 * α < 0 è quello dove lo spazio gira verso l'osservatore), β lungo l'asse. Il bordo è fatto dalle
 * orbite sferiche dei fotoni di raggio r: ξ = L/E, η = Q/E², poi α = −ξ/sin i, β = ±√(η + a²cos²i − ξ²cot²i).
 * Con a = 0 è un cerchio di raggio √27.
 */
export function shadowEdge(a: number, incl: number, n = 128): [number, number][] {
  const pts: [number, number][] = [];
  if (a < 1e-6) {
    const R = Math.sqrt(27);
    for (let k = 0; k < 2 * n; k++) pts.push([R * Math.cos((Math.PI * k) / n), R * Math.sin((Math.PI * k) / n)]);
    return pts;
  }
  const si = Math.max(Math.sin(incl), 1e-6), ci = Math.cos(incl);
  const r1 = photonOrbit(a, true), r2 = photonOrbit(a, false);
  const top: [number, number][] = [];
  for (let k = 0; k <= n; k++) {
    const r = r1 + ((r2 - r1) * k) / n;
    const xi = -(r * r * r - 3 * r * r + a * a * r + a * a) / (a * (r - 1));
    const eta = (-(r ** 3) * (r ** 3 - 6 * r * r + 9 * r - 4 * a * a)) / (a * a * (r - 1) ** 2);
    const b2 = eta + a * a * ci * ci - (xi * xi * ci * ci) / (si * si);
    if (b2 < 0) continue; // quest'orbita non si vede da questa inclinazione
    top.push([-xi / si, Math.sqrt(b2)]);
  }
  for (const p of top) pts.push(p);
  for (let k = top.length - 1; k >= 0; k--) pts.push([top[k][0], -top[k][1]]);
  return pts;
}
