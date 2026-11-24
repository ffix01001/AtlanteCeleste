/**
 * Decine di migliaia di asteroidi e comete calcolati sulla scheda video.
 *
 * Ogni punto porta con sé i propri elementi orbitali; il vertex shader risolve
 * l'equazione di Keplero a ogni fotogramma. La CPU non fa nulla: per questo
 * si possono mostrare anche centinaia di migliaia di corpi.
 */

import { BufferAttribute, BufferGeometry, Color, PerspectiveCamera, Points, ShaderMaterial, Vector2, Vector3 } from 'three';
import { parseAtbl } from '../data/atbl';
import { api } from '../data/api';
import { classGroup, GROUP_COLORS } from '../data/classes';
import { eclToScene } from '../core/frames';
import { AU_KM, K_GAUSS, MU_SUN_AU_DAY } from '../core/units';
import { conicState, perifocalBasis, type Conic } from '../ephem/kepler';

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 axisP;
attribute vec3 axisQ;
attribute vec2 qe;
attribute float dtp;
attribute float grp;
attribute float mag;
attribute float sg;
uniform float uT;
uniform vec3 camHi;
uniform vec3 camLo;
uniform float pxScale;
uniform vec3 colors[8];
uniform float sizeBoost;
// corpi selezionati o inquadrati: li disegna il loro corpo 3D, calcolato in doppia precisione
// (qui l'equazione di Keplero si risolve con circa 7 cifre: da vicino il punto starebbe a
// decine di km dall'asteroide vero)
uniform vec2 hideIdx;
varying vec3 vColor;
const float K = ${K_GAUSS.toFixed(11)};
const float AUKM = ${AU_KM.toFixed(1)};
void main() {
  if (gl_VertexID == int(hideIdx.x) || gl_VertexID == int(hideIdx.y)) {
    gl_PointSize = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float q = qe.x;
  float e = qe.y;
  float dt = uT - dtp;
  // comete radenti disintegrate al perielio: dopo quell'istante non esistono più
  if (sg > 0.5 && dt > 0.0) {
    gl_PointSize = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec2 xy;
  if (e < 0.999) {
    float a = q / (1.0 - e);
    float n = K / (a * sqrt(a));
    float M = mod(n * dt + PI, 2.0 * PI) - PI;
    float E = e < 0.8 ? M : (M >= 0.0 ? PI : -PI);
    for (int k = 0; k < 16; k++) {
      E -= (E - e * sin(E) - M) / (1.0 - e * cos(E));
    }
    xy = vec2(a * (cos(E) - e), a * sqrt(1.0 - e * e) * sin(E));
  } else if (e > 1.001) {
    float A = q / (e - 1.0);
    float n = K / (A * sqrt(A));
    float M = n * dt;
    float H = asinh(M / e);
    for (int k = 0; k < 20; k++) {
      H -= (e * sinh(H) - H - M) / (e * cosh(H) - 1.0);
    }
    xy = vec2(A * (e - cosh(H)), A * sqrt(e * e - 1.0) * sinh(H));
  } else {
    float Mp = sqrt(1.0 / (2.0 * q * q * q)) * K * dt;
    float B = 1.5 * Mp;
    float Y = pow(B + sqrt(B * B + 1.0), 1.0 / 3.0);
    float s = Y - 1.0 / Y;
    xy = vec2(q * (1.0 - s * s), 2.0 * q * s);
  }
  vec3 p = axisP * xy.x + axisQ * xy.y;
  vec3 rel = (p - camHi) - camLo;
  vec4 mv = viewMatrix * vec4(rel * AUKM, 1.0);
  gl_Position = projectionMatrix * mv;
  int g = int(grp + 0.5);
  vColor = colors[g];
  float s = g >= 6 ? 2.2 : clamp(2.7 - 0.14 * (mag - 8.0), 1.0, 3.0) + (g == 1 ? 0.6 : 0.0);
  gl_PointSize = s * pxScale * sizeBoost;
  #include <logdepthbuf_vertex>
}`;

const FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float opacity;
varying vec3 vColor;
void main() {
  #include <logdepthbuf_fragment>
  vec2 c = gl_PointCoord - 0.5;
  float r2 = dot(c, c) * 4.0;
  if (r2 > 1.0) discard;
  gl_FragColor = vec4(vColor, opacity * (1.0 - r2 * 0.6));
}`;

export interface SmallBodyRecord {
  id: string;       // sb:<designazione>
  name: string;
  cls: string;
  conic: Conic;
  mag: number;
  /** cometa radente disintegrata al perielio (vedi isDisintegratingSungrazer) */
  sungrazer: boolean;
}

/**
 * Comete radenti "usa e getta": le centinaia di frammenti del gruppo di Kreutz
 * scoperti da SOHO passano a meno di 4 raggi solari dal centro del Sole e si
 * disintegrano prima o durante il perielio. Le loro orbite sono parabole
 * calcolate su pochi giorni di osservazione (classe PAR): proseguirle dopo il
 * perielio creerebbe un ammasso di comete che non esistono più.
 */
export const SUNGRAZER_Q_AU = 0.0186;
export function isDisintegratingSungrazer(cls: string, q: number): boolean {
  return cls === 'PAR' && q < SUNGRAZER_Q_AU;
}

export class SmallBodySet {
  points: Points | null = null;
  private mat: ShaderMaterial | null = null;
  count = 0;
  ids: string[] = [];
  /** Elementi dei corpi esclusi perché già nel catalogo (o in un insieme precedente). */
  skipped = new Map<string, Conic>();
  names: string[] = [];
  classes: string[] = [];
  private el: Float64Array | null = null; // q e i om w tp per corpo
  mags: Float32Array | null = null;
  /** 1 = cometa radente che si disintegra al perielio */
  sungrazers: Uint8Array = new Uint8Array(0);
  tRef = 0;
  loading = false;
  error: string | null = null;
  label = '';

  constructor(readonly setId: string) {}

  async load(skip: Set<string>): Promise<void> {
    this.loading = true;
    try {
      const buf = await api.smallBodies(this.setId);
      const { meta, cols } = parseAtbl(buf);
      this.label = meta.label;
      const n0 = meta.count as number;
      const q = cols.q as Float64Array, e = cols.e as Float64Array, inc = cols.i as Float64Array;
      const om = cols.om as Float64Array, w = cols.w as Float64Array, tp = cols.tp as Float64Array;
      const mag = cols.mag as Float64Array;
      const keep: number[] = [];
      for (let i = 0; i < n0; i++) {
        const id = `sb:${meta.pdes?.[i] ?? meta.ids[i]}`;
        if (skip.has(id)) {
          // già presente (nel catalogo o in un altro insieme): non lo disegno di nuovo,
          // ma ne conservo gli elementi orbitali come ripiego per il corpo del catalogo
          this.skipped.set(id, { q: q[i], e: e[i], i: inc[i], om: om[i], w: w[i], tp: tp[i] });
          continue;
        }
        skip.add(id);
        keep.push(i);
      }
      const n = keep.length;
      this.tRef = Math.round(Date.now() / 86400000) + 2440587.5;
      const P = new Float32Array(n * 3), Q = new Float32Array(n * 3), QE = new Float32Array(n * 2);
      const DT = new Float32Array(n), G = new Float32Array(n), M = new Float32Array(n), SG = new Float32Array(n);
      this.sungrazers = new Uint8Array(n);
      this.el = new Float64Array(n * 6);
      const vp = new Vector3(), vq = new Vector3(), s = new Vector3();
      for (let k = 0; k < n; k++) {
        const i = keep[k];
        perifocalBasis(inc[i], om[i], w[i], vp, vq); // eclittica
        eclToScene(vp.x, vp.y, vp.z, s);
        P.set([s.x, s.y, s.z], k * 3);
        eclToScene(vq.x, vq.y, vq.z, s);
        Q.set([s.x, s.y, s.z], k * 3);
        QE[k * 2] = q[i];
        QE[k * 2 + 1] = e[i];
        DT[k] = tp[i] - this.tRef;
        const cls = meta.classes[i] as string;
        G[k] = classGroup(cls);
        M[k] = mag[i];
        if (isDisintegratingSungrazer(cls, q[i])) {
          SG[k] = 1;
          this.sungrazers[k] = 1;
        }
        this.el.set([q[i], e[i], inc[i], om[i], w[i], tp[i]], k * 6);
        this.ids.push(`sb:${meta.pdes?.[i] ?? meta.ids[i]}`);
        this.names.push(cleanName(meta.names[i] as string));
        this.classes.push(cls);
      }
      this.mags = M;
      const geo = new BufferGeometry();
      // "position" serve a three.js solo per contare i vertici
      geo.setAttribute('position', new BufferAttribute(new Float32Array(n * 3), 3));
      geo.setAttribute('axisP', new BufferAttribute(P, 3));
      geo.setAttribute('axisQ', new BufferAttribute(Q, 3));
      geo.setAttribute('qe', new BufferAttribute(QE, 2));
      geo.setAttribute('dtp', new BufferAttribute(DT, 1));
      geo.setAttribute('grp', new BufferAttribute(G, 1));
      geo.setAttribute('mag', new BufferAttribute(M, 1));
      geo.setAttribute('sg', new BufferAttribute(SG, 1));
      this.mat = new ShaderMaterial({
        uniforms: {
          uT: { value: 0 },
          camHi: { value: new Vector3() },
          camLo: { value: new Vector3() },
          pxScale: { value: 1 },
          sizeBoost: { value: 1 },
          hideIdx: { value: new Vector2(-1, -1) },
          opacity: { value: 0.75 },
          colors: { value: GROUP_COLORS.map((c) => new Color(c)) },
        },
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
      });
      this.points = new Points(geo, this.mat);
      this.points.frustumCulled = false;
      this.points.renderOrder = -5;
      this.count = n;
    } catch (err) {
      this.error = (err as Error).message;
    } finally {
      this.loading = false;
    }
  }

  update(jd: number, camRelSunKm: Vector3, pxScale: number, hideA = -1, hideB = -1): void {
    if (!this.mat) return;
    const u = this.mat.uniforms;
    (u.hideIdx.value as Vector2).set(hideA, hideB);
    u.uT.value = jd - this.tRef;
    // posizione della camera in UA, divisa in parte "alta" e "bassa" per non perdere precisione
    const x = camRelSunKm.x / AU_KM, y = camRelSunKm.y / AU_KM, z = camRelSunKm.z / AU_KM;
    const hx = Math.fround(x), hy = Math.fround(y), hz = Math.fround(z);
    u.camHi.value.set(hx, hy, hz);
    u.camLo.value.set(x - hx, y - hy, z - hz);
    u.pxScale.value = pxScale;
  }

  conic(i: number): Conic {
    const el = this.el!;
    return { q: el[i * 6], e: el[i * 6 + 1], i: el[i * 6 + 2], om: el[i * 6 + 3], w: el[i * 6 + 4], tp: el[i * 6 + 5] };
  }

  record(i: number): SmallBodyRecord {
    return {
      id: this.ids[i], name: this.names[i], cls: this.classes[i], conic: this.conic(i), mag: this.mags?.[i] ?? 99,
      sungrazer: this.sungrazers[i] === 1,
    };
  }

  /** Selezione col clic: ricalcola le posizioni in doppia precisione. */
  pick(x: number, y: number, jd: number, camera: PerspectiveCamera, camRelSunKm: Vector3, w: number, h: number, tol = 7): { index: number; dist: number } | null {
    if (!this.el || !this.points?.visible) return null;
    const p = new Vector3(), s = new Vector3();
    let best = -1, bestD = tol;
    const el = this.el;
    for (let i = 0; i < this.count; i++) {
      if (this.sungrazers[i] && jd > el[i * 6 + 5]) continue;
      conicState(this.conic(i), jd, MU_SUN_AU_DAY, p);
      eclToScene(p.x * AU_KM, p.y * AU_KM, p.z * AU_KM, s).sub(camRelSunKm);
      s.applyMatrix4(camera.matrixWorldInverse);
      if (s.z >= 0) continue;
      s.applyMatrix4(camera.projectionMatrix);
      const sx = (s.x * 0.5 + 0.5) * w, sy = (-s.y * 0.5 + 0.5) * h;
      const d = Math.hypot(sx - x, sy - y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best >= 0 ? { index: best, dist: bestD } : null;
  }
}

/** "433 Eros (A898 PA)" -> "433 Eros"; "1P/Halley" resta com'è. */
export function cleanName(full: string): string {
  const s = (full || '').trim();
  if (s.startsWith('(') && s.endsWith(')')) return s.slice(1, -1);
  const m = /^(.*?)\s*\([^)]*\)\s*$/.exec(s);
  if (m && m[1] && /\d/.test(m[1]) && /[A-Za-z]/.test(m[1])) return m[1];
  return s;
}
