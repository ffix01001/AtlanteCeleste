/**
 * Sfumatura delle foto del cielo profondo (nebulose, ammassi, galassie).
 *
 * Le foto hanno il fondo nero, ma il loro contenuto (stelle di campo, gas debole, la "nuvola" di
 * stelle delle Nubi di Magellano) arriva fin quasi ai bordi: con una sfumatura rettangolare, nello
 * spazio si vedeva il riquadro della foto. Qui la sfumatura è "organica":
 *  - il bordo è arrotondato e irregolare: un'ellisse inscritta nella foto, deformata da un rumore lento;
 *  - verso il bordo resta soprattutto la luce che fa parte dell'oggetto (dove la foto sfocata è
 *    luminosa): il fondo di stelle sparse e il gas più debole sfumano prima, le strutture luminose dopo.
 * La stessa maschera serve alla foto piatta (shader) e alla nube 3D ricostruita dalla foto.
 */

import { ClampToEdgeWrapping, DataTexture, LinearFilter, RedFormat, UnsignedByteType } from 'three';

export interface PhotoMatte {
  W: number;
  H: number;
  /** maschera 0..1, W×H, riga 0 = in alto nella foto */
  data: Float32Array;
  /** pixel della foto ridotta a W×H (RGBA, riga 0 in alto) */
  px: Uint8ClampedArray;
  /** la maschera come texture, per gli shader (stesso orientamento della foto) */
  tex: DataTexture;
}

/** larghezza della foto ridotta su cui si calcola la maschera */
export const MATTE_W = 256;

export function matteHeight(width: number, height: number): number {
  return Math.max(16, Math.round((MATTE_W * height) / Math.max(1, width)));
}

/** generatore pseudocasuale ripetibile */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** rumore di valore 2D liscio, periodico su una griglia 32×32 */
function valueNoise(seed: number): (x: number, y: number) => number {
  const r = rng(seed);
  const N = 32, g = new Float32Array(N * N).map(() => r());
  const at = (i: number, j: number) => g[(((j % N) + N) % N) * N + (((i % N) + N) % N)];
  return (x, y) => {
    const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    return (at(i, j) * (1 - sx) + at(i + 1, j) * sx) * (1 - sy) + (at(i, j + 1) * (1 - sx) + at(i + 1, j + 1) * sx) * sy;
  };
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** sfocatura a scatola, separabile, con i bordi ripetuti (tre passate ≈ gaussiana) */
function boxBlur(src: Float32Array, W: number, H: number, r: number): Float32Array {
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
  const k = 2 * r + 1;
  for (let j = 0; j < H; j++) {
    const row = j * W;
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += src[row + Math.min(W - 1, Math.max(0, i))];
    for (let i = 0; i < W; i++) {
      tmp[row + i] = acc / k;
      acc += src[row + Math.min(W - 1, i + r + 1)] - src[row + Math.max(0, i - r)];
    }
  }
  for (let i = 0; i < W; i++) {
    let acc = 0;
    for (let j = -r; j <= r; j++) acc += tmp[Math.min(H - 1, Math.max(0, j)) * W + i];
    for (let j = 0; j < H; j++) {
      out[j * W + i] = acc / k;
      acc += tmp[Math.min(H - 1, j + r + 1) * W + i] - tmp[Math.max(0, j - r) * W + i];
    }
  }
  return out;
}

/** Maschera di sfumatura di una foto. `seed` cambia la forma del bordo da una foto all'altra. */
export function makePhotoMatte(img: CanvasImageSource & { width: number; height: number }, seed: number): PhotoMatte {
  const W = MATTE_W, H = matteHeight(img.width, img.height);
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, W, H);
  const px = ctx.getImageData(0, 0, W, H).data;
  // luminosità lineare di ogni pixel
  const lut = new Float32Array(256).map((_, c) => Math.pow(c / 255, 2.2));
  let Y: Float32Array = new Float32Array(W * H);
  for (let i = 0, k = 0; i < W * H; i++, k += 4) {
    Y[i] = 0.2126 * lut[px[k]] + 0.7152 * lut[px[k + 1]] + 0.0722 * lut[px[k + 2]];
  }
  // dove l'oggetto c'è davvero: la foto sfocata (una stella isolata, sfocata, quasi sparisce)
  const r = Math.max(2, Math.round(W / 48));
  for (let p = 0; p < 3; p++) Y = boxBlur(Y, W, H, r);
  const sorted = Float32Array.from(Y).sort();
  const ref = Math.max(sorted[Math.floor(sorted.length * 0.995)], 1e-6);
  const n1 = valueNoise(seed), n2 = valueNoise(seed * 31 + 7);
  const data = new Float32Array(W * H);
  const texData = new Uint8Array(W * H);
  for (let j = 0; j < H; j++) {
    const v = ((j + 0.5) / H) * 2 - 1;
    for (let i = 0; i < W; i++) {
      const u = ((i + 0.5) / W) * 2 - 1;
      // bordo arrotondato e irregolare (qualche "lobo" largo e qualche dettaglio più fine)
      const x = (u + 1) * 0.5, y = (v + 1) * 0.5;
      const n = n1(x * 4, y * 4) * 0.6 + n2(x * 9, y * 9) * 0.4;
      const rr = Math.hypot(u, v) + 0.25 * (n - 0.5);
      const round = 1 - smooth(0.5, 1.0, rr);
      // mai luce sui bordi veri della foto
      const guard = (1 - smooth(0.9, 1, Math.abs(u))) * (1 - smooth(0.9, 1, Math.abs(v)));
      // verso il bordo resta solo la luce dell'oggetto
      const content = smooth(0.002, 0.05, Y[j * W + i] / ref);
      const outer = smooth(0.3, 0.85, rr);
      const m = round * guard * (1 - outer * (1 - content));
      data[j * W + i] = m;
      // la texture ha la riga 0 in basso, come le foto caricate da three.js (flipY)
      texData[(H - 1 - j) * W + i] = Math.round(m * 255);
    }
  }
  const tex = new DataTexture(texData, W, H, RedFormat, UnsignedByteType);
  tex.magFilter = tex.minFilter = LinearFilter;
  tex.wrapS = tex.wrapT = ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return { W, H, data, px, tex };
}
