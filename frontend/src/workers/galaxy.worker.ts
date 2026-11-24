/// <reference lib="webworker" />
/**
 * Generatore del modello della Via Lattea (in un thread separato: sono
 * centinaia di migliaia di punti).
 *
 * Non sono stelle vere: sono "nuvole di stelle" distribuite secondo un modello
 * fisico della Galassia, per mostrarne la forma dove i cataloghi non arrivano.
 *   - bulge a forma di arachide e barra lunga ~5 kpc, inclinata di ~27° sulla
 *     linea Sole-centro (stelle vecchie, giallo-arancio);
 *   - disco sottile e disco spesso esponenziali (lunghezza di scala 2,6 kpc);
 *   - bracci a spirale: i tracciati di Reid et al. 2019 (stelle giovani,
 *     azzurre, e regioni di idrogeno ionizzato, rosa);
 *   - polveri: corsie scure lungo il bordo interno dei bracci e nel piano.
 * Tutto è generato con un generatore pseudo-casuale con seme fisso: la
 * Galassia ha sempre la stessa forma.
 */

interface Arm {
  id: string;
  major: boolean;
  points: [number, number][]; // [beta (gradi), R (kpc)]
  measured?: [number, number][]; // tratti osservati; il resto è un prolungamento
}

interface Params {
  arms: Arm[];
  bar: { semi_lunghezza_kpc: number; angolo_deg: number };
  disco: { scala_radiale_kpc: number; spessore_sottile_kpc: number; spessore_spesso_kpc: number };
  nStars: number;
  nDust: number;
  seed: number;
}

const DEG = Math.PI / 180;

// ------------------------------------------------------------ casualità riproducibile
let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
function seed(n: number): void {
  s0 = n ^ 0x9e3779b9; s1 = n * 31 + 7; s2 = n * 1013904223 + 1; s3 = 0x6d2b79f5;
  for (let i = 0; i < 20; i++) rnd();
}
function rnd(): number {
  // xoshiro128**
  const r = Math.imul(rotl(Math.imul(s1, 5), 7), 9);
  const t = s1 << 9;
  s2 ^= s0; s3 ^= s1; s1 ^= s2; s0 ^= s3; s2 ^= t; s3 = rotl(s3, 11);
  return (r >>> 0) / 4294967296;
}
function rotl(x: number, k: number): number {
  return (x << k) | (x >>> (32 - k));
}
function gauss(): number {
  const u = Math.max(rnd(), 1e-12), v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
/** distribuzione sech² (profilo verticale di un disco autogravitante), scala h */
function sech2(h: number): number {
  const u = rnd() * 2 - 1;
  return h * Math.atanh(Math.max(-0.999999, Math.min(0.999999, u)));
}
/** raggio da densità superficiale esponenziale R·e^(−R/h) (somma di due esponenziali) */
function expDiskR(h: number): number {
  return -h * Math.log(Math.max(rnd() * rnd(), 1e-12));
}

// ------------------------------------------------------------ bracci
interface ArmCurve {
  arm: Arm;
  b0: number;
  b1: number;
  len: number; // lunghezza approssimata (kpc), per distribuire i punti
}

function armR(arm: Arm, beta: number): number {
  const p = arm.points;
  if (beta <= p[0][0]) return p[0][1];
  for (let i = 0; i < p.length - 1; i++) {
    const [b0, r0] = p[i], [b1, r1] = p[i + 1];
    if (beta <= b1) {
      const t = (beta - b0) / (b1 - b0);
      return Math.exp(Math.log(r0) * (1 - t) + Math.log(r1) * t);
    }
  }
  return p[p.length - 1][1];
}

function armXY(arm: Arm, beta: number): [number, number] {
  const R = armR(arm, beta);
  return [-R * Math.cos(beta * DEG), R * Math.sin(beta * DEG)];
}

/** larghezza dei bracci (Reid et al. 2019): w = 336 + 36 (R − 8,15) pc */
function armWidth(R: number): number {
  return Math.max(0.12, 0.336 + 0.036 * (R - 8.15));
}

function curves(arms: Arm[]): ArmCurve[] {
  return arms.map((arm) => {
    const b0 = arm.points[0][0], b1 = arm.points[arm.points.length - 1][0];
    let len = 0;
    let [px, py] = armXY(arm, b0);
    for (let b = b0 + 2; b <= b1; b += 2) {
      const [x, y] = armXY(arm, b);
      len += Math.hypot(x - px, y - py);
      px = x; py = y;
    }
    return { arm, b0, b1, len };
  });
}

/** quanto è "sicuro" un tratto di braccio: 1 dove è stato misurato, meno dove è prolungato */
function measuredWeight(arm: Arm, beta: number): number {
  if (!arm.measured || !arm.measured.length) return 1;
  let d = Infinity;
  for (const [a, b] of arm.measured) {
    if (beta >= a && beta <= b) return 1;
    d = Math.min(d, Math.abs(beta - a), Math.abs(beta - b));
  }
  return 0.35 + 0.65 * Math.exp(-d / 40);
}

/** punto a caso lungo un braccio (uniforme in lunghezza; i tratti prolungati sono più radi) */
function sampleArm(cs: ArmCurve[], wMajor: number): { x: number; y: number; R: number; nx: number; ny: number; c: ArmCurve } {
  const tot = cs.reduce((a, c) => a + c.len * (c.arm.major ? wMajor : 0.35), 0);
  let c = cs[0];
  let beta = 0;
  for (let tries = 0; tries < 50; tries++) {
    let u = rnd() * tot;
    for (const cc of cs) {
      const w = cc.len * (cc.arm.major ? wMajor : 0.35);
      if (u < w) { c = cc; break; }
      u -= w;
    }
    beta = c.b0 + (c.b1 - c.b0) * rnd();
    if (rnd() < measuredWeight(c.arm, beta)) break;
  }
  const [x, y] = armXY(c.arm, beta);
  const [x2, y2] = armXY(c.arm, beta + 0.5);
  const tx = x2 - x, ty = y2 - y;
  const tl = Math.hypot(tx, ty) || 1;
  // normale "verso l'esterno" nel piano
  let nx = ty / tl, ny = -tx / tl;
  if (nx * x + ny * y < 0) { nx = -nx; ny = -ny; }
  return { x, y, R: Math.hypot(x, y), nx, ny, c };
}

/** densità dei bracci in un punto del piano (0..1), per modulare il disco */
function armDensity(cs: ArmCurve[], x: number, y: number): number {
  const R = Math.hypot(x, y);
  if (R < 0.5) return 0;
  // β del punto: x = −R cos β, y = R sin β
  const phiBeta = Math.atan2(y, -x) / DEG;
  let best = 0;
  for (const c of cs) {
    // il braccio può avvolgersi più volte: si provano β, β ± 360
    for (let k = -2; k <= 2; k++) {
      const b = phiBeta + 360 * k;
      if (b < c.b0 || b > c.b1) continue;
      const Ra = armR(c.arm, b);
      const w = armWidth(Ra);
      const d = (R - Ra) / w;
      const v = Math.exp(-d * d) * (c.arm.major ? 1 : 0.55) * measuredWeight(c.arm, b);
      if (v > best) best = v;
    }
  }
  return best;
}

// ------------------------------------------------------------ generazione
interface Out {
  pos: Float32Array;   // kpc (modello)
  col: Float32Array;   // rgb lineare
  size: Float32Array;  // pc
  lum: Float32Array;   // luminosità relativa
  count: number;
}

function alloc(n: number): Out {
  return { pos: new Float32Array(n * 3), col: new Float32Array(n * 3), size: new Float32Array(n), lum: new Float32Array(n), count: 0 };
}

function push(o: Out, x: number, y: number, z: number, r: number, g: number, b: number, size: number, lum: number): void {
  const i = o.count++;
  o.pos[i * 3] = x; o.pos[i * 3 + 1] = y; o.pos[i * 3 + 2] = z;
  o.col[i * 3] = r; o.col[i * 3 + 1] = g; o.col[i * 3 + 2] = b;
  o.size[i] = size;
  o.lum[i] = lum;
}

function generate(p: Params): { stars: Out; dust: Out } {
  seed(p.seed);
  const cs = curves(p.arms);
  const N = p.nStars;
  const stars = alloc(N);
  const bar = p.bar;
  const ca = Math.cos(bar.angolo_deg * DEG), sa = Math.sin(bar.angolo_deg * DEG);
  // asse della barra: dal centro verso l'estremo vicino (lato del Sole, longitudini positive)
  const bx = -ca, by = sa;
  const hR = p.disco.scala_radiale_kpc;

  const nBulge = Math.floor(N * 0.16);
  const nBar = Math.floor(N * 0.08);
  const nArm = Math.floor(N * 0.30);
  const nDisk = N - nBulge - nBar - nArm;

  // bulge "a forma di arachide": triassiale, allungato lungo la barra
  for (let i = 0; i < nBulge; i++) {
    const a = gauss() * 0.75, b = gauss() * 0.42, c = gauss() * 0.32;
    // effetto "scatola/arachide": più spesso alle estremità
    const zc = c * (1 + 0.6 * Math.min(1, Math.abs(a) / 1.2));
    const x = a * bx - b * by, y = a * by + b * bx;
    const t = 0.85 + 0.15 * rnd();
    push(stars, x, y, zc, 1.0 * t, 0.78 * t, 0.55 * t, 26 + 20 * rnd(), 0.32);
  }
  // barra lunga e sottile
  for (let i = 0; i < nBar; i++) {
    let a = gauss() * bar.semi_lunghezza_kpc * 0.45;
    if (Math.abs(a) > bar.semi_lunghezza_kpc) a *= 0.5;
    const b = gauss() * 0.35, c = sech2(0.12);
    const x = a * bx - b * by, y = a * by + b * bx;
    const t = 0.8 + 0.2 * rnd();
    push(stars, x, y, c, 1.0 * t, 0.8 * t, 0.6 * t, 24 + 16 * rnd(), 0.4);
  }
  // disco (sottile + spesso), modulato dai bracci
  let made = 0, guard = 0;
  while (made < nDisk && guard++ < nDisk * 30) {
    const thick = rnd() < 0.12;
    const R = expDiskR(thick ? 2.0 : hR);
    if (R > 17 || R < 0.3) continue;
    const ph = rnd() * 2 * Math.PI;
    const x = R * Math.cos(ph), y = R * Math.sin(ph);
    // al centro domina la barra: il disco ha un "buco" morbido
    const hole = Math.min(1, Math.max(0, (R - 1.5) / 2.0));
    const arm = armDensity(cs, x, y);
    if (rnd() > hole * (0.45 + 0.55 * arm)) continue;
    const z = sech2(thick ? p.disco.spessore_spesso_kpc * 0.5 : p.disco.spessore_sottile_kpc * 0.5 * (1 + R / 20));
    // colore: più caldo verso il centro, più azzurro nei bracci
    const young = arm * (thick ? 0.2 : 0.75);
    const warm = Math.max(0, 1 - R / 9);
    const r = 1.0 - 0.25 * young, g = 0.86 + 0.06 * young - 0.08 * warm, b = 0.72 + 0.28 * young - 0.18 * warm;
    const fade = R > 12 ? Math.exp(-(R - 12) / 2.5) : 1; // il bordo del disco sfuma
    push(stars, x, y, z, r, g, b, 30 + 25 * rnd(), (0.8 + 0.5 * young) * fade);
    made++;
  }
  // stelle giovani e regioni HII lungo i bracci
  for (let i = 0; i < nArm; i++) {
    const a = sampleArm(cs, 1);
    const w = armWidth(a.R);
    const off = gauss() * w * 0.5;
    const along = gauss() * 0.08;
    const x = a.x + a.nx * off - a.ny * along, y = a.y + a.ny * off + a.nx * along;
    const z = gauss() * 0.06;
    const fade = a.R > 13 ? Math.exp(-(a.R - 13) / 2) : 1;
    if (rnd() < 0.035) {
      // regione di formazione stellare (idrogeno ionizzato, emissione H-alfa)
      const t = 0.8 + 0.4 * rnd();
      push(stars, x, y, z, 1.0 * t, 0.42 * t, 0.55 * t, 45 + 70 * rnd(), 2.2 * fade);
    } else {
      const t = 0.8 + 0.2 * rnd();
      push(stars, x, y, z, 0.68 * t, 0.8 * t, 1.0 * t, 18 + 18 * rnd(), 1.3 * fade);
    }
  }

  // polveri: nubi a chiazze lungo il bordo interno dei bracci, più uno strato tenue nel piano.
  // Ogni nube è un gruppo di macchie attorno a un centro: così, vista dal Sole, la
  // fascia della Via Lattea è attraversata da corsie scure irregolari (come la "Fenditura del Cigno")
  const ND = p.nDust;
  const dust = alloc(ND);
  const nCloudParticles = Math.floor(ND * 0.7);
  let k = 0;
  while (k < nCloudParticles) {
    const a = sampleArm(cs, 1);
    const w = armWidth(a.R);
    const off = -0.45 * w + gauss() * w * 0.3; // bordo interno del braccio
    const cx = a.x + a.nx * off, cy = a.y + a.ny * off;
    const cz = gauss() * 0.09;
    const cloudR = 0.05 + 0.25 * rnd() * rnd();         // 50–300 pc
    const members = 6 + Math.floor(rnd() * 40);
    const opacity = 0.1 + 0.4 * rnd() * rnd();
    const fade = a.R > 12 ? Math.exp(-(a.R - 12) / 2) : 1;
    for (let m = 0; m < members && k < nCloudParticles; m++, k++) {
      push(dust, cx + gauss() * cloudR, cy + gauss() * cloudR, cz + gauss() * cloudR * 0.6,
        0, 0, 0, 40 + 90 * rnd(), opacity * fade);
    }
  }
  for (let i = nCloudParticles; i < ND; i++) {
    const R = 2.2 + expDiskR(3.2);
    if (R > 15) { i--; continue; }
    const ph = rnd() * 2 * Math.PI;
    push(dust, R * Math.cos(ph), R * Math.sin(ph), gauss() * 0.1, 0, 0, 0, 80 + 140 * rnd(), 0.05);
  }
  // in fondo, così le posizioni restano quelle di sempre (cambia solo l'ordine)
  shuffle(stars);
  shuffle(dust);
  return { stars, dust };
}

/**
 * Mescola l'ordine delle particelle (Fisher–Yates, sempre lo stesso con lo stesso seme): così le
 * prime n sono un campione a caso di tutta la Galassia. Da molto lontano se ne disegna solo una
 * parte, ognuna con più luce (render/galaxy.ts): prima le particelle uscivano a blocchi
 * (bulge, barra, disco, bracci) e un gruppo iniziale avrebbe mostrato solo il centro.
 */
function shuffle(o: Out): void {
  const { pos, col, size, lum } = o;
  for (let i = o.count - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    for (let c = 0; c < 3; c++) {
      let t = pos[i * 3 + c]; pos[i * 3 + c] = pos[j * 3 + c]; pos[j * 3 + c] = t;
      t = col[i * 3 + c]; col[i * 3 + c] = col[j * 3 + c]; col[j * 3 + c] = t;
    }
    let t = size[i]; size[i] = size[j]; size[j] = t;
    t = lum[i]; lum[i] = lum[j]; lum[j] = t;
  }
}

/** Mappa della densità dei bracci sul piano (x, y in [−20, 20] kpc), per la luce del cielo. */
export const ARM_MAP_N = 256;
function armMap(arms: Arm[]): Float32Array {
  const cs = curves(arms);
  const N = ARM_MAP_N, out = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = ((i + 0.5) / N - 0.5) * 40, y = ((j + 0.5) / N - 0.5) * 40;
      out[j * N + i] = armDensity(cs, x, y);
    }
  }
  return out;
}

self.onmessage = (ev: MessageEvent) => {
  const m = ev.data as Params & { type: string };
  if (m.type !== 'generate') return;
  const t0 = performance.now();
  const { stars, dust } = generate(m);
  const arms = armMap(m.arms);
  (self as unknown as Worker).postMessage(
    { type: 'done', stars, dust, arms, ms: performance.now() - t0 },
    [stars.pos.buffer, stars.col.buffer, stars.size.buffer, stars.lum.buffer, dust.pos.buffer, dust.col.buffer, dust.size.buffer, dust.lum.buffer, arms.buffer],
  );
};
