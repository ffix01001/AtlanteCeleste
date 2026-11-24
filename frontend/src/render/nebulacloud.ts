/**
 * Nebulose in 3D, ricostruite dalla loro foto.
 *
 * La foto mostra la nebulosa come la vediamo dalla Terra: manca la profondità. Qui la si
 * "gonfia": si scelgono migliaia di punti della foto (più punti dove è più luminosa, nessuno
 * nelle corsie di polvere), ognuno diventa uno sbuffo di luce gaussiano del colore della foto, e
 * lo si sposta lungo la linea di vista seguendo una superficie ondulata generata dal programma
 * (le nebulose a emissione sono "bolle" e "pareti" di gas illuminate dalle stelle giovani).
 * Dalla Terra la somma degli sbuffi riproduce la foto; da un'altra parte o da dentro si vede
 * una nube in rilievo. La luce totale è la stessa della foto.
 *
 * Le galassie vicine (Nubi di Magellano) usano lo stesso metodo con una geometria diversa: invece
 * della parete ondulata, ogni punto della foto sta sul disco inclinato della galassia (inclinazione
 * e linea dei nodi misurate), più uno spessore. Così la nuvola ha la forma vera e, girandoci
 * attorno, resta ferma al suo posto rispetto alla Via Lattea.
 */

import { AdditiveBlending, BufferAttribute, BufferGeometry, Points, ShaderMaterial, type Vector3 } from 'three';
import type { PhotoMatte } from './photomatte';

const V = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 color;
attribute float sigma;     // raggio dello sbuffo (km, una deviazione standard)
uniform float pxPerRad;
uniform float pxScale;
uniform float intensity;
varying vec3 vC;
varying float vA;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  // gli oggetti lontani sono "rimpiccioliti" insieme alla loro distanza (scala del gruppo)
  float sg = sigma * length(modelMatrix[0].xyz);
  float dist = max(length(mv.xyz), 1e-9);
  float spx = sg / dist * pxPerRad;
  float a = intensity;
  // dentro uno sbuffo (o quasi) la sua luce si diluisce: niente macchie che coprono lo schermo
  a *= smoothstep(1.5, 5.0, dist / sg);
  // sotto un quarto di pixel la luce totale resta la stessa, concentrata in un punto
  if (spx < 0.25) { a *= (spx * spx) / 0.0625; spx = 0.25; }
  float size = min(6.0 * spx, 900.0);
  vC = color;
  vA = a;
  gl_PointSize = a > 1e-5 ? size * pxScale : 0.0;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}`;

const F = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vC;
varying float vA;
void main() {
  #include <logdepthbuf_fragment>
  vec2 q = (gl_PointCoord - 0.5) * 6.0;
  float r2 = dot(q, q);
  if (r2 > 9.0) discard;
  gl_FragColor = vec4(vC * vA * exp(-0.5 * r2), 1.0);
}`;

/** generatore pseudocasuale ripetibile (ogni nebulosa ha sempre la stessa forma) */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** rumore di valore 2D liscio (per la superficie ondulata) */
function smoothNoise(seed: number): (x: number, y: number) => number {
  const r = rng(seed);
  const N = 64, g = new Float32Array(N * N).map(() => r());
  const at = (i: number, j: number) => g[((j % N + N) % N) * N + ((i % N + N) % N)];
  const one = (x: number, y: number) => {
    const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    return (at(i, j) * (1 - sx) + at(i + 1, j) * sx) * (1 - sy) + (at(i, j + 1) * (1 - sx) + at(i + 1, j + 1) * sx) * sy;
  };
  return (x, y) => (one(x * 3, y * 3) * 0.6 + one(x * 7 + 11, y * 7 + 5) * 0.3 + one(x * 15 + 3, y * 15 + 17) * 0.1);
}

export interface CloudFrame {
  /** versori nella scena: est e nord sul cielo, e la direzione dal Sole verso la nebulosa */
  east: Vector3;
  north: Vector3;
  los: Vector3;
  /** grandezza della foto (km) e spostamento del suo centro (km, verso est e verso nord) */
  w: number;
  h: number;
  offE: number;
  offN: number;
  /**
   * disco inclinato (galassie): inclinazione e angolo di posizione della linea dei nodi (radianti,
   * dal nord verso est), spessore del disco lungo la sua perpendicolare (km, una deviazione standard).
   * Il lato vicino a noi è a "linea dei nodi − 90°".
   */
  disk?: { incl: number; nodesPa: number; thick: number };
  /** zone della foto da non usare (oggetti in primo piano, come 47 Tucanae): centro e raggio in km */
  mask?: { e: number; n: number; r: number }[];
  /**
   * grandezza tipica degli sbuffi come frazione della larghezza della foto (predefinita 1/150: gas morbido).
   * Le galassie, fatte di stelle, usano sbuffi più piccoli: stessa luce totale, ma grana più fitta e
   * più visibile da lontano (con sbuffi larghi la Piccola Nube vista di lato quasi spariva)
   */
  grain?: number;
}

export class NebulaCloud {
  readonly points: Points;
  private mat: ShaderMaterial;

  /** `photo`: la foto ridotta e la sua maschera di sfumatura (la stessa della foto piatta) */
  constructor(photo: PhotoMatte, f: CloudFrame, seed: number, count = 12000) {
    const { W, H, px } = photo;
    // colori lineari e luminosità di ogni pixel; i bordi sfumano come nella foto
    const lin = (c: number) => Math.pow(c / 255, 2.2);
    const lum = new Float32Array(W * H);
    let total = 0;
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const k = (j * W + i) * 4;
        let edge = photo.data[j * W + i];
        if (f.mask) {
          const eKm = -((i + 0.5) / W - 0.5) * f.w + f.offE, nKm = (0.5 - (j + 0.5) / H) * f.h + f.offN;
          for (const m of f.mask) edge *= smooth(0.8, 1.2, Math.hypot(eKm - m.e, nKm - m.n) / m.r);
        }
        const l = (0.2126 * lin(px[k]) + 0.7152 * lin(px[k + 1]) + 0.0722 * lin(px[k + 2])) * edge;
        lum[j * W + i] = l;
        total += l;
      }
    }
    // si sceglie un pixel con probabilità proporzionale alla luminosità (somma cumulativa)
    const cdf = new Float64Array(W * H);
    let acc = 0;
    for (let i = 0; i < W * H; i++) { acc += Math.max(lum[i] - 0.004, 0); cdf[i] = acc; }
    const r = rng(seed * 7919 + 13);
    const gauss = () => Math.sqrt(-2 * Math.log(Math.max(r(), 1e-12))) * Math.cos(2 * Math.PI * r());
    const wave = smoothNoise(seed + 1);
    const pos = new Float32Array(count * 3), col = new Float32Array(count * 3), sig = new Float32Array(count);
    const depthScale = 0.28 * Math.max(f.w, f.h);
    // disco inclinato: un punto spostato sul cielo verso il lato vicino (di x km) è più vicino a noi di
    // x·tan(i); lo spessore lungo la perpendicolare al disco diventa, lungo la linea di vista, spessore / cos(i)
    // (così dalla Terra ogni sbuffo resta esattamente nel punto della foto da cui viene)
    const dk = f.disk;
    const nearE = dk ? Math.sin(dk.nodesPa - Math.PI / 2) : 0, nearN = dk ? Math.cos(dk.nodesPa - Math.PI / 2) : 0;
    const tanI = dk ? Math.tan(dk.incl) : 0, losThick = dk ? dk.thick / Math.max(Math.cos(dk.incl), 0.2) : 0;
    let sumArea = 0;
    let n = 0;
    for (; n < count && acc > 0; n++) {
      const u = r() * acc;
      let lo = 0, hi = W * H - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (cdf[m] < u) lo = m + 1; else hi = m; }
      const i = lo % W, j = Math.floor(lo / W);
      const uu = (i + r()) / W, vv = 1 - (j + r()) / H;
      const eKm = -(uu - 0.5) * f.w + f.offE, nKm = (vv - 0.5) * f.h + f.offN;
      // profondità: il disco inclinato (galassie) oppure una parete ondulata più un po' di spessore (nebulose)
      const dKm = dk
        ? -tanI * (eKm * nearE + nKm * nearN) + gauss() * losThick
        : depthScale * ((wave(uu, vv) - 0.5) * 2.2 + gauss() * 0.25);
      pos[n * 3] = f.east.x * eKm + f.north.x * nKm + f.los.x * dKm;
      pos[n * 3 + 1] = f.east.y * eKm + f.north.y * nKm + f.los.y * dKm;
      pos[n * 3 + 2] = f.east.z * eKm + f.north.z * nKm + f.los.z * dKm;
      const k = lo * 4, l = Math.max(lum[lo], 1e-6);
      col[n * 3] = lin(px[k]) / l; col[n * 3 + 1] = lin(px[k + 1]) / l; col[n * 3 + 2] = lin(px[k + 2]) / l;
      const s = f.w * (f.grain ?? 1 / 150) * Math.exp(0.5 * gauss());
      sig[n] = s;
      sumArea += 2 * Math.PI * s * s;
    }
    // stessa luce totale della foto: Σ pixel × area di un pixel = E × Σ area degli sbuffi
    const pixArea = (f.w / W) * (f.h / H);
    const E = sumArea > 0 ? (total * pixArea) / sumArea : 0;
    for (let i = 0; i < n * 3; i++) col[i] *= E;
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('color', new BufferAttribute(col, 3));
    g.setAttribute('sigma', new BufferAttribute(sig, 1));
    g.setDrawRange(0, n);
    this.mat = new ShaderMaterial({
      uniforms: { pxPerRad: { value: 1 }, pxScale: { value: 1 }, intensity: { value: 0 } },
      vertexShader: V,
      fragmentShader: F,
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    this.points = new Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    this.points.visible = false;
  }

  /**
   * Una galassia che, vista dalla camera, sta dietro il disco della Via Lattea si disegna prima delle
   * polveri della Via Lattea, che così la oscurano: con la luce che si somma e basta non si capirebbe
   * chi sta davanti, e girando la visuale sembrerebbe scivolare dentro la Galassia.
   */
  setBehindGalaxy(behind: boolean): void {
    this.points.renderOrder = behind ? -21 : 2;
  }

  update(pxPerRad: number, pxScale: number, intensity: number): void {
    this.mat.uniforms.pxPerRad.value = pxPerRad;
    this.mat.uniforms.pxScale.value = pxScale;
    this.mat.uniforms.intensity.value = intensity;
    this.points.visible = intensity > 0.002;
  }
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
