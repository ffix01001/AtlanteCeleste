/**
 * Stelle generate dal programma, per la Galassia oltre il catalogo.
 *
 * I cataloghi (HYG, Gaia) contengono le stelle vicine al Sole. Viaggiando lontano il cielo si
 * svuoterebbe: qui lo si riempie con stelle "plausibili", generate a celle attorno alla camera
 * con la densità del modello della Via Lattea (disco esponenziale, bracci per le stelle giovani,
 * bulge) e con colori e luminosità tipici. Ogni cella ha un seme fisso: tornando nello stesso
 * posto si ritrovano le stesse stelle. Vicino al Sole sfumano, lasciando il posto a quelle vere.
 *
 * Due gusci: celle da 50 pc fino a ~225 pc (stelle fino alla magnitudine assoluta +1,5) e celle
 * da 400 pc fino a ~1,8 kpc (solo giganti e supergiganti luminose).
 * Unità: kpc nel sistema del modello (origine in Sgr A*, piano galattico z = 0).
 */

import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, Group, Matrix4, Points, ShaderMaterial, Vector3 } from 'three';
import { GC_SCENE_KM, M_MODEL_TO_SCENE, SUN_IN_MODEL_KPC } from '../core/galactic';
import { PC_KM } from '../core/units';
import { tempToColor } from '../core/stellar';

const V = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 color;
attribute float absmag;
uniform vec3 sunM;      // il Sole nel modello (kpc)
uniform float magLimit;
uniform float pxScale;
uniform float intensity;
varying vec3 vC;
varying float vA;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float dPc = max(length(mv.xyz) / ${PC_KM.toExponential(8)}, 1e-3);
  float m = absmag + 5.0 * log(dPc / 10.0) / log(10.0);
  // flusso rispetto al limite: le stelle sotto il limite si spengono piano
  float f = pow(10.0, -0.4 * (m - magLimit));
  float a = clamp(f, 0.0, 6.0) * intensity;
  // vicino al Sole ci sono le stelle vere del catalogo
  a *= smoothstep(0.3, 0.7, distance(position, sunM));
  vC = color;
  vA = a;
  gl_PointSize = a > 0.01 ? clamp(1.6 + 1.4 * log(1.0 + f), 1.6, 6.0) * pxScale : 0.0;
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
  vec2 q = gl_PointCoord - 0.5;
  float g = exp(-dot(q, q) * 14.0);
  gl_FragColor = vec4(vC * g * min(vA, 1.5), 1.0);
}`;

/** densità relativa (1 vicino al Sole) */
function density(x: number, y: number, z: number, arm: number, young: boolean): number {
  const R = Math.hypot(x, y);
  if (R > 20) return 0;
  const disk = Math.exp(-(R - 8.275) / 2.6) * Math.exp(-(Math.abs(z) - 0.02) / (young ? 0.1 : 0.3));
  const bulge = 4 * Math.exp(-(x * x + y * y) / 2.0 - (z * z) / 0.3);
  return young ? disk * (0.15 + 1.6 * arm) : disk + bulge;
}

function hashSeed(i: number, j: number, k: number, s: number): number {
  let h = (i * 73856093) ^ (j * 19349663) ^ (k * 83492791) ^ (s * 2654435761);
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

function rng(seed: number): () => number {
  let s = seed || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

interface Shell {
  cell: number;     // kpc
  reach: number;    // celle per lato attorno alla camera
  perCell: number;  // stelle per cella vicino al Sole
  young: number;    // frazione di stelle giovani (seguono i bracci)
  mag: [number, number]; // magnitudine assoluta: da, a
  salt: number;
  max: number;      // stelle al massimo
  every: number;    // si rigenera dopo questo spostamento (kpc)
}

const SHELLS: Shell[] = [
  { cell: 0.05, reach: 4, perCell: 25, young: 0.5, mag: [-1.5, 1.5], salt: 1, max: 60000, every: 0.05 },
  { cell: 0.4, reach: 4, perCell: 19, young: 0.7, mag: [-7, -3.5], salt: 2, max: 20000, every: 0.2 },
];

/** Un guscio: le sue stelle e il punto in cui sono state generate. */
class ShellPoints {
  readonly points: Points;
  readonly geo = new BufferGeometry();
  builtAt = new Vector3(1e9, 0, 0);
  readonly pos: Float32Array;
  readonly col: Float32Array;
  readonly mag: Float32Array;
  readonly sh: Shell;

  constructor(sh: Shell, mat: ShaderMaterial) {
    this.sh = sh;
    this.pos = new Float32Array(sh.max * 3);
    this.col = new Float32Array(sh.max * 3);
    this.mag = new Float32Array(sh.max);
    this.geo.setAttribute('position', new BufferAttribute(this.pos, 3));
    this.geo.setAttribute('color', new BufferAttribute(this.col, 3));
    this.geo.setAttribute('absmag', new BufferAttribute(this.mag, 1));
    this.geo.setDrawRange(0, 0);
    this.points = new Points(this.geo, mat);
    this.points.frustumCulled = false;
    this.points.matrixAutoUpdate = false;
    this.points.renderOrder = -9;
  }
}

export class ProceduralStars {
  /** il gruppo da aggiungere alla scena */
  readonly points = new Group();
  private mat: ShaderMaterial;
  private shells: ShellPoints[];
  private arms: Float32Array | null = null;
  private readonly _m = new Matrix4();
  private readonly _rot = M_MODEL_TO_SCENE.clone().multiplyScalar(1 / (1000 * PC_KM)).transpose();

  constructor() {
    this.mat = new ShaderMaterial({
      uniforms: {
        sunM: { value: SUN_IN_MODEL_KPC.clone() }, magLimit: { value: 6.5 }, pxScale: { value: 1 }, intensity: { value: 1 },
      },
      vertexShader: V,
      fragmentShader: F,
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    this.shells = SHELLS.map((sh) => new ShellPoints(sh, this.mat));
    for (const s of this.shells) this.points.add(s.points);
    this.points.matrixAutoUpdate = false;
    this.points.visible = false;
  }

  setArms(map: Float32Array): void {
    this.arms = map;
    for (const s of this.shells) s.builtAt.set(1e9, 0, 0);
  }

  private armAt(x: number, y: number): number {
    const a = this.arms;
    if (!a) return 0.3;
    const i = Math.floor((x / 40 + 0.5) * 256), j = Math.floor((y / 40 + 0.5) * 256);
    if (i < 0 || j < 0 || i > 255 || j > 255) return 0;
    return a[j * 256 + i];
  }

  private rebuild(sp: ShellPoints, c: Vector3): void {
    const sh = sp.sh;
    const ci = Math.floor(c.x / sh.cell), cj = Math.floor(c.y / sh.cell), ck = Math.floor(c.z / sh.cell);
    const side = 2 * sh.reach + 1;
    // prima passata: quante stelle vorrebbe ogni cella
    const old = new Float32Array(side * side * side), young = new Float32Array(side * side * side);
    let total = 0;
    for (let k = 0, q = 0; k < side; k++) for (let j = 0; j < side; j++) for (let i = 0; i < side; i++, q++) {
      const x0 = (ci - sh.reach + i + 0.5) * sh.cell, y0 = (cj - sh.reach + j + 0.5) * sh.cell, z0 = (ck - sh.reach + k + 0.5) * sh.cell;
      const arm = this.armAt(x0, y0);
      old[q] = sh.perCell * (1 - sh.young) * density(x0, y0, z0, arm, false);
      young[q] = sh.perCell * sh.young * density(x0, y0, z0, arm, true);
      total += Math.min(old[q] + young[q], 400);
    }
    // se sono troppe (verso il centro) se ne tengono meno ovunque, senza tagliare una parte di cielo
    const scale = Math.min(1, (sh.max - 1) / Math.max(total, 1));
    let n = 0;
    const tmp = new Color();
    for (let k = 0, q = 0; k < side; k++) for (let j = 0; j < side; j++) for (let i = 0; i < side; i++, q++) {
      const I = ci - sh.reach + i, J = cj - sh.reach + j, K = ck - sh.reach + k;
      const r = rng(hashSeed(I, J, K, sh.salt));
      const want = Math.min(old[q] + young[q], 400) * scale;
      if (want <= 0) continue;
      // numero di stelle: valore atteso, con la parte frazionaria estratta a sorte
      const count = Math.floor(want) + (r() < want - Math.floor(want) ? 1 : 0);
      const pYoung = young[q] / Math.max(old[q] + young[q], 1e-9);
      for (let s = 0; s < count && n < sh.max; s++, n++) {
        const youngStar = r() < pYoung;
        sp.pos[n * 3] = (I + r()) * sh.cell;
        sp.pos[n * 3 + 1] = (J + r()) * sh.cell;
        sp.pos[n * 3 + 2] = (K + r()) * sh.cell;
        // più stelle deboli che brillanti (funzione di luminosità approssimata)
        const u = r();
        sp.mag[n] = sh.mag[1] - (sh.mag[1] - sh.mag[0]) * (1 - Math.pow(u, 0.35));
        // giovani: blu-bianche; vecchie luminose: giganti gialle e rosse
        const T = youngStar ? 9000 + 22000 * r() * r() : 3400 + 2600 * r();
        tempToColor(T, tmp);
        sp.col[n * 3] = tmp.r; sp.col[n * 3 + 1] = tmp.g; sp.col[n * 3 + 2] = tmp.b;
      }
    }
    for (const name of ['position', 'color', 'absmag']) {
      const a = sp.geo.getAttribute(name) as BufferAttribute;
      a.clearUpdateRanges();
      a.addUpdateRange(0, n * a.itemSize);
      a.needsUpdate = true;
    }
    sp.geo.setDrawRange(0, n);
    sp.builtAt.copy(c);
  }

  /** Aggiorna per il fotogramma; restituisce il numero di stelle generate. */
  update(sunScene: Vector3, camPos: Vector3, pxScale: number, magLimit: number, visible: boolean): number {
    const _t = new Vector3().copy(GC_SCENE_KM).add(sunScene).sub(camPos);
    const e = M_MODEL_TO_SCENE.elements;
    this._m.set(e[0], e[3], e[6], _t.x, e[1], e[4], e[7], _t.y, e[2], e[5], e[8], _t.z, 0, 0, 0, 1);
    for (const s of this.shells) {
      s.points.matrix.copy(this._m);
      s.points.matrixWorldNeedsUpdate = true;
    }
    // camera nel modello (kpc)
    const c = _t.negate().divideScalar(1000 * PC_KM).applyMatrix3(this._rot);
    const fromSun = c.distanceTo(SUN_IN_MODEL_KPC);
    this.points.visible = visible && fromSun > 0.25 && c.length() < 25;
    if (!this.points.visible) return 0;
    // ogni guscio si rigenera quando ci si è spostati di circa una sua cella (pochi millisecondi);
    // al più uno per fotogramma, così i costi non si sommano
    for (const s of this.shells) {
      if (c.distanceTo(s.builtAt) > s.sh.every) { this.rebuild(s, c); break; }
    }
    this.mat.uniforms.pxScale.value = pxScale;
    this.mat.uniforms.magLimit.value = magLimit;
    this.mat.uniforms.intensity.value = Math.min(1, (fromSun - 0.25) / 0.3);
    return this.shells.reduce((n, s) => n + s.geo.drawRange.count, 0);
  }

  /** Per le prove: l'ultima matrice modello -> scena. */
  get matrix(): Matrix4 {
    return this._m;
  }
}
