/** Satelliti artificiali attorno alla Terra (CelesTrak + SGP4 in un worker). */

import { t } from '../core/i18n';
import { BufferAttribute, BufferGeometry, Color, Matrix3, PerspectiveCamera, Points, ShaderMaterial, Vector3 } from 'three';
import { json2satrec, type SatRec } from 'satellite.js';
import { sgp4At } from '../ephem/sgp4at';
import { api } from '../data/api';
import type { OMM } from '../data/types';
import { M_ICRF_TO_SCENE, precessionDateToJ2000 } from '../core/frames';
import { J2000, jdTdbToUnixMs, unixMsToJdTdb } from '../core/time';

export const SAT_CATEGORIES = [
  { label: t('Stazioni spaziali'), color: '#ffd27a' },
  { label: 'Starlink', color: '#8aa4c8' },
  { label: t('Altre megacostellazioni'), color: '#5fc9b8' },
  { label: t('Navigazione (GPS, Galileo, GLONASS, BeiDou)'), color: '#9bd46e' },
  { label: t('Geostazionari'), color: '#ff9f6b' },
  { label: t('Altri satelliti'), color: '#d7e3ff' },
];

const _v = new Vector3();
const _m3 = new Matrix3();

export function satCategory(o: OMM): number {
  const n = (o.OBJECT_NAME || '').toUpperCase();
  if (/^ISS \(|ZARYA|TIANHE|TIANGONG|^CSS \(|WENTIAN|MENGTIAN/.test(n)) return 0;
  if (n.startsWith('STARLINK')) return 1;
  if (/^(ONEWEB|KUIPER|QIANFAN|GUOWANG|SPACESAIL|HULIANWANG)/.test(n)) return 2;
  if (/(NAVSTAR|^GPS |GALILEO|GSAT0|GLONASS|BEIDOU|IRNSS|^NVS-|^QZS)/.test(n)) return 3;
  if (Math.abs(o.MEAN_MOTION - 1.0027) < 0.012 && o.ECCENTRICITY < 0.02) return 4;
  return 5;
}

/**
 * Ogni quanto (millisecondi di tempo simulato) si ricalcolano tutti i satelliti con SGP4.
 * Fra un calcolo e l'altro la scheda video li fa avanzare con velocità e accelerazione di
 * gravità (sviluppo al secondo ordine): in 5 s l'errore resta sotto il metro, invisibile a
 * più di una decina di km. I satelliti più vicini alla camera li calcola invece la CPU, con
 * SGP4 a ogni fotogramma (vedi NEAR_KM): così da vicino non saltano.
 */
const REFRESH_SIM_MS = 5000;
/** con il tempo molto accelerato le posizioni non si prolungano: si ricalcolano al massimo ogni 0,1 s reali */
const REFRESH_FAST_REAL_MS = 100;
/**
 * Entro questa distanza dalla camera (km) un satellite si calcola sulla CPU in doppia precisione.
 * La scheda video lavora con circa 7 cifre: a 7000 km dal centro della Terra l'errore è di un
 * metro (a 42.000 km, l'orbita geostazionaria, di qualche metro). Visto da 15 metri, come quando
 * si zooma su un satellite, quel metro diventa un salto di decine di pixel.
 */
const NEAR_KM = 12;
const NEAR_MAX = 32;
const GM_EARTH = 398600.4418;

const GM_EARTH_GLSL = GM_EARTH.toFixed(4);

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 velocity;
attribute float cat;
attribute float okf;
uniform float dt;
uniform float pxScale;
uniform float nearCut;
uniform vec3 colors[6];
uniform float catMask[6];
varying vec3 vColor;
void main() {
  // posizione e velocità dell'ultimo calcolo, più l'accelerazione di gravità (curvatura dell'orbita)
  float r = max(length(position), 1.0);
  vec3 acc = position * (-${GM_EARTH_GLSL} / (r * r * r));
  vec3 p = position + velocity * dt + acc * (0.5 * dt * dt);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  int c = int(cat + 0.5);
  vColor = colors[c];
  float show = okf * catMask[c];
  // vicinissimi alla camera li disegna il livello calcolato sulla CPU
  if (length(mv.xyz) < nearCut) show = 0.0;
  gl_PointSize = show > 0.5 ? (c == 0 ? 5.0 : (c == 1 ? 1.8 : 2.4)) * pxScale : 0.0;
  #include <logdepthbuf_vertex>
}`;

const FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vColor;
void main() {
  #include <logdepthbuf_fragment>
  vec2 c = gl_PointCoord - 0.5;
  float r2 = dot(c, c) * 4.0;
  if (r2 > 1.0) discard;
  gl_FragColor = vec4(vColor, 0.95 - r2 * 0.5);
}`;

export class SatelliteLayer {
  points: Points | null = null;
  /** satelliti vicinissimi alla camera, con posizioni calcolate sulla CPU in doppia precisione */
  nearPoints: Points | null = null;
  private nearGeo: BufferGeometry | null = null;
  private satrecs = new Map<number, SatRec | null>();
  private nearCand: { i: number; d: number }[] = [];
  private lastRequestReal = 0;
  private mat: ShaderMaterial | null = null;
  private geo: BufferGeometry | null = null;
  private worker: Worker | null = null;
  omms: OMM[] = [];
  categories: Uint8Array = new Uint8Array(0);
  count = 0;
  private busy = false;
  private seq = 0;
  private batchMs = 0;
  private lastPos: Float32Array | null = null;
  private lastVel: Float32Array | null = null;
  private lastOk: Uint8Array | null = null;
  loading = false;
  error: string | null = null;
  medianEpochMs = 0;
  catMask = [1, 1, 1, 1, 1, 1];

  async load(): Promise<void> {
    this.loading = true;
    try {
      const res = await api.satellites('active');
      this.omms = res.satellites.filter((o) => o && o.MEAN_MOTION > 0);
      const n = this.omms.length;
      this.categories = new Uint8Array(n);
      const epochs: number[] = [];
      for (let i = 0; i < n; i++) {
        this.categories[i] = satCategory(this.omms[i]);
        const t = Date.parse(this.omms[i].EPOCH + (this.omms[i].EPOCH.endsWith('Z') ? '' : 'Z'));
        if (Number.isFinite(t)) epochs.push(t);
      }
      epochs.sort((a, b) => a - b);
      this.medianEpochMs = epochs[Math.floor(epochs.length / 2)] ?? Date.now();
      this.geo = new BufferGeometry();
      this.geo.setAttribute('position', new BufferAttribute(new Float32Array(n * 3), 3));
      this.geo.setAttribute('velocity', new BufferAttribute(new Float32Array(n * 3), 3));
      this.geo.setAttribute('okf', new BufferAttribute(new Float32Array(n), 1));
      this.geo.setAttribute('cat', new BufferAttribute(Float32Array.from(this.categories), 1));
      this.mat = new ShaderMaterial({
        uniforms: {
          dt: { value: 0 },
          pxScale: { value: 1 },
          colors: { value: SAT_CATEGORIES.map((c) => new Color(c.color)) },
          catMask: { value: this.catMask },
          nearCut: { value: NEAR_KM },
        },
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
      });
      this.points = new Points(this.geo, this.mat);
      this.points.frustumCulled = false;
      this.points.renderOrder = -4;
      // livello di precisione: stesso disegno, posizioni già riferite alla camera (niente da prolungare)
      this.nearGeo = new BufferGeometry();
      this.nearGeo.setAttribute('position', new BufferAttribute(new Float32Array(NEAR_MAX * 3), 3));
      this.nearGeo.setAttribute('velocity', new BufferAttribute(new Float32Array(NEAR_MAX * 3), 3));
      this.nearGeo.setAttribute('okf', new BufferAttribute(new Float32Array(NEAR_MAX), 1));
      this.nearGeo.setAttribute('cat', new BufferAttribute(new Float32Array(NEAR_MAX), 1));
      this.nearGeo.setDrawRange(0, 0);
      const u = this.mat.uniforms;
      const nearMat = new ShaderMaterial({
        uniforms: { dt: { value: 0 }, pxScale: u.pxScale, colors: u.colors, catMask: u.catMask, nearCut: { value: -1 } },
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
      });
      this.nearPoints = new Points(this.nearGeo, nearMat);
      this.nearPoints.frustumCulled = false;
      this.nearPoints.renderOrder = -4;
      this.count = n;
      this.worker = new Worker(new URL('../workers/sgp4.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (ev) => this.onWorker(ev.data);
      this.worker.postMessage({ type: 'init', omms: this.omms });
    } catch (err) {
      this.error = (err as Error).message;
    } finally {
      this.loading = false;
    }
  }

  private onWorker(m: any): void {
    if (m.type === 'ready') {
      this.busy = false;
      return;
    }
    if (m.type === 'result' && this.geo) {
      this.busy = false;
      this.batchMs = m.unixMs;
      this.lastPos = m.pos;
      this.lastVel = m.vel;
      this.lastOk = m.ok;
      (this.geo.attributes.position as BufferAttribute).copyArray(m.pos).needsUpdate = true;
      (this.geo.attributes.velocity as BufferAttribute).copyArray(m.vel).needsUpdate = true;
      const okf = this.geo.attributes.okf as BufferAttribute;
      const arr = okf.array as Float32Array;
      for (let i = 0; i < m.ok.length; i++) arr[i] = m.ok[i];
      okf.needsUpdate = true;
    }
  }

  /** Gli elementi SGP4 sono affidabili solo per qualche settimana attorno alla loro epoca. */
  validAt(simMs: number): boolean {
    return this.count > 0 && Math.abs(simMs - this.medianEpochMs) < 30 * 86400000;
  }

  /** `jd`: l'istante dei corpi della simulazione (il satellite selezionato si calcola da lì: stesso istante, stessa posizione) */
  update(simMs: number, rate: number, earthRelCam: Vector3, pxScale: number, visible: boolean, jd = unixMsToJdTdb(simMs)): void {
    if (!this.points || !this.mat) return;
    const show = visible && this.validAt(simMs);
    this.points.visible = show && this.lastPos !== null;
    if (this.nearPoints) this.nearPoints.visible = this.points.visible;
    if (!show) return;
    const fast = Math.abs(rate) > 600;
    const nowReal = performance.now();
    const stale = this.lastPos === null
      || (fast ? nowReal - this.lastRequestReal >= REFRESH_FAST_REAL_MS && simMs !== this.batchMs
        : Math.abs(simMs - this.batchMs) >= REFRESH_SIM_MS);
    if (!this.busy && this.worker && stale) {
      this.busy = true;
      this.lastRequestReal = nowReal;
      const T = (unixMsToJdTdb(simMs) - J2000) / 36525;
      const m = M_ICRF_TO_SCENE.clone().multiply(precessionDateToJ2000(T)).transpose();
      this.worker.postMessage({ type: 'propagate', unixMs: simMs, matrix: Array.from(m.elements), seq: ++this.seq });
    }
    this.points.position.copy(earthRelCam);
    let dt = (simMs - this.batchMs) / 1000;
    if (fast || Math.abs(dt) > 300) dt = 0;
    this.mat.uniforms.dt.value = dt;
    this.mat.uniforms.pxScale.value = pxScale;
    this.updateNear(jd, dt, earthRelCam);
  }

  /**
   * I satelliti a meno di NEAR_KM dalla camera: si trovano con le posizioni dell'ultimo calcolo,
   * poi si ricalcolano con SGP4 sulla CPU per l'istante esatto, riferiti alla camera in doppia
   * precisione. Di solito è uno solo (quello su cui si è zoomato) o nessuno.
   */
  private updateNear(jd: number, dt: number, earthRelCam: Vector3): void {
    const geo = this.nearGeo;
    if (!geo || !this.lastPos || !this.lastVel || !this.lastOk || !this.mat) return;
    const pos = this.lastPos, vel = this.lastVel, ok = this.lastOk;
    // la camera rispetto al centro della Terra
    const cx = -earthRelCam.x, cy = -earthRelCam.y, cz = -earthRelCam.z;
    const R = NEAR_KM + 1;
    const R2 = R * R;
    const cand = this.nearCand;
    cand.length = 0;
    // scarto rapido: nessun satellite attivo sta oltre 500.000 km dal centro della Terra
    if (cx * cx + cy * cy + cz * cz < 5e5 * 5e5) {
      for (let i = 0; i < this.count; i++) {
        if (!ok[i] || !this.catMask[this.categories[i]]) continue;
        const dx = pos[i * 3] + vel[i * 3] * dt - cx;
        if (dx > R || dx < -R) continue;
        const dy = pos[i * 3 + 1] + vel[i * 3 + 1] * dt - cy;
        if (dy > R || dy < -R) continue;
        const dz = pos[i * 3 + 2] + vel[i * 3 + 2] * dt - cz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < R2) cand.push({ i, d: Math.sqrt(d2) });
      }
    }
    if (cand.length > NEAR_MAX) {
      cand.sort((a, b) => a.d - b.d);
      cand.length = NEAR_MAX;
    }
    // se sono più di NEAR_MAX, quelli oltre li disegna (quasi altrettanto bene) la scheda video
    this.mat.uniforms.nearCut.value = cand.length >= NEAR_MAX ? Math.min(NEAR_KM, cand[NEAR_MAX - 1].d) : NEAR_KM;
    let n = 0;
    if (cand.length) {
      // esattamente come il corpo del satellite selezionato (sim/body.ts): stesso istante, stesse trasformazioni
      const unixMs = jdTdbToUnixMs(jd);
      const T = (jd - J2000) / 36525;
      const m = _m3.copy(M_ICRF_TO_SCENE).multiply(precessionDateToJ2000(T));
      const P = geo.getAttribute('position') as BufferAttribute;
      const O = geo.getAttribute('okf') as BufferAttribute;
      const C = geo.getAttribute('cat') as BufferAttribute;
      for (const { i } of cand) {
        let rec = this.satrecs.get(i);
        if (rec === undefined) {
          try {
            rec = json2satrec(this.omms[i] as any);
          } catch {
            rec = null;
          }
          this.satrecs.set(i, rec);
        }
        if (!rec) continue;
        const pv = sgp4At(rec, unixMs);
        if (!pv || typeof pv.position !== 'object') continue;
        _v.set(pv.position.x, pv.position.y, pv.position.z).applyMatrix3(m).add(earthRelCam);
        P.setXYZ(n, _v.x, _v.y, _v.z);
        O.setX(n, 1);
        C.setX(n, this.categories[i]);
        n++;
      }
      P.needsUpdate = O.needsUpdate = C.needsUpdate = true;
    }
    geo.setDrawRange(0, n);
  }

  pick(x: number, y: number, simMs: number, camera: PerspectiveCamera, earthRelCam: Vector3, w: number, h: number, tol = 7): number | null {
    if (!this.points?.visible || !this.lastPos || !this.lastVel || !this.lastOk) return null;
    const dt = (simMs - this.batchMs) / 1000;
    const v = new Vector3();
    let best = -1, bestD = tol;
    for (let i = 0; i < this.count; i++) {
      if (!this.lastOk[i] || !this.catMask[this.categories[i]]) continue;
      v.set(
        this.lastPos[i * 3] + this.lastVel[i * 3] * dt,
        this.lastPos[i * 3 + 1] + this.lastVel[i * 3 + 1] * dt,
        this.lastPos[i * 3 + 2] + this.lastVel[i * 3 + 2] * dt,
      ).add(earthRelCam);
      v.applyMatrix4(camera.matrixWorldInverse);
      if (v.z >= 0) continue;
      v.applyMatrix4(camera.projectionMatrix);
      const sx = (v.x * 0.5 + 0.5) * w, sy = (-v.y * 0.5 + 0.5) * h;
      const d = Math.hypot(sx - x, sy - y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best >= 0 ? best : null;
  }
}
