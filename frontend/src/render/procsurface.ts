/**
 * Superficie "indicativa" per i corpi che nessuna sonda ha mai fotografato da vicino
 * (Sedna, Eris, Haumea, Makemake, Pallade, Igea, Nereide…): senza una mappa erano sfere di
 * un solo colore, piatte. Qui si genera una mappa plausibile, sempre uguale per lo stesso
 * corpo: variazioni di albedo (rumore frattale calcolato sulla sfera, quindi senza giunture
 * né poli pizzicati), macchie più scure o più chiare e, per i corpi rocciosi, crateri.
 * Il colore medio resta quello del catalogo. Non è una carta vera: la scheda lo dice.
 */

import { CanvasTexture, SRGBColorSpace } from 'three';

export type SurfaceStyle = 'ghiaccio' | 'roccia' | 'tholin' | 'gas';

function hash3(x: number, y: number, z: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647 + seed * 144665) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function noise3(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number) => hash3(xi + dx, yi + dy, zi + dz, seed);
  return l(
    l(l(c(0, 0, 0), c(1, 0, 0), u), l(c(0, 1, 0), c(1, 1, 0), u), v),
    l(l(c(0, 0, 1), c(1, 0, 1), u), l(c(0, 1, 1), c(1, 1, 1), u), v),
    w,
  );
}

function fbm(x: number, y: number, z: number, seed: number, oct: number): number {
  let s = 0, a = 0.5, f = 1;
  for (let k = 0; k < oct; k++) {
    s += a * noise3(x * f, y * f, z * f, seed + k * 17);
    f *= 2.03;
    a *= 0.5;
  }
  return s / (1 - Math.pow(0.5, oct));
}

function seedOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) % 100000;
}

/** Mappa equirettangolare (larghezza 2:1) per il corpo `id`, colore medio `hex` (sRGB). */
export function proceduralSurface(id: string, hex: string, style: SurfaceStyle, width = 1024): CanvasTexture {
  const W = width, H = width / 2;
  const seed = seedOf(id);
  const base = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  // crateri: centri e raggi (in radianti) estratti una volta sola
  const craters: [number, number, number, number][] = [];
  if (style === 'roccia') {
    let r = seed + 1;
    const rnd = () => ((r = Math.imul(r ^ (r >>> 15), 2246822507) + 0x6d2b79f5) >>> 0) / 4294967296;
    for (let k = 0; k < 90; k++) {
      const z = rnd() * 2 - 1, t = rnd() * Math.PI * 2, s = Math.sqrt(1 - z * z);
      craters.push([s * Math.cos(t), s * Math.sin(t), z, 0.03 + 0.18 * Math.pow(rnd(), 3)]);
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  const d = img.data;
  for (let j = 0; j < H; j++) {
    const lat = (0.5 - (j + 0.5) / H) * Math.PI;
    const cl = Math.cos(lat), sl = Math.sin(lat);
    for (let i = 0; i < W; i++) {
      const lon = ((i + 0.5) / W) * Math.PI * 2;
      const x = cl * Math.cos(lon), y = cl * Math.sin(lon), z = sl;
      let v: number, tint = 0;
      if (style === 'ghiaccio') {
        // ghiacci luminosi, appena venati, con qualche regione più scura e rossastra
        const n = fbm(x * 2.2, y * 2.2, z * 2.2, seed, 5);
        const fine = fbm(x * 9, y * 9, z * 9, seed + 7, 3);
        v = 0.86 + 0.22 * (n - 0.5) + 0.06 * (fine - 0.5);
        tint = Math.max(0, (0.42 - n) * 1.6);
      } else if (style === 'gas') {
        // giganti: fasce parallele all'equatore, appena ondulate
        const warp = fbm(x * 2, y * 2, z * 2, seed, 3) - 0.5;
        const band = fbm(0.3, 0.7, (z + warp * 0.1) * 7, seed + 5, 4);
        const fine = fbm(x * 10, y * 10, z * 28, seed + 9, 3);
        v = 0.84 + 0.44 * (band - 0.5) + 0.07 * (fine - 0.5);
        tint = Math.max(0, (band - 0.55) * 1.3);
      } else if (style === 'tholin') {
        // superficie rossa di tholin, con chiazze più chiare (ghiaccio) e più scure
        const n = fbm(x * 1.8, y * 1.8, z * 1.8, seed, 5);
        const fine = fbm(x * 8, y * 8, z * 8, seed + 3, 3);
        v = 0.9 + 0.35 * (n - 0.5) + 0.08 * (fine - 0.5);
        tint = Math.max(0, (n - 0.6) * 1.4);
      } else {
        const n = fbm(x * 3, y * 3, z * 3, seed, 5);
        v = 0.88 + 0.3 * (n - 0.5);
        for (const [cx, cy, cz, cr] of craters) {
          const dot = x * cx + y * cy + z * cz;
          if (dot < Math.cos(cr * 1.3)) continue;
          const a = Math.acos(Math.min(1, dot)) / cr;
          // fondo più scuro, bordo rialzato più chiaro
          v *= a < 1 ? 0.9 + 0.08 * a * a : 1 + 0.12 * Math.max(0, 1 - (a - 1) / 0.3);
        }
      }
      const k = (j * W + i) * 4;
      // "tint": verso il bianco (ghiaccio, tholin chiaro) o verso un rosso scuro
      const toward = style === 'tholin' || style === 'gas' ? [235, 225, 215] : [150, 95, 70];
      for (let c = 0; c < 3; c++) {
        const col = base[c] * (1 - tint) + toward[c] * tint;
        d[k + c] = Math.max(0, Math.min(255, col * v));
      }
      d[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}
