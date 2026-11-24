/**
 * La Via Lattea vista da fuori (e da dentro): un modello a particelle.
 *
 * Il modello (generato in workers/galaxy.worker.ts) vive in un sistema con
 * origine in Sagittarius A* e assi galattici, in kpc; qui lo si colloca nella
 * scena con la stessa matematica di tutto il resto (origine mobile: alla GPU
 * arriva solo la posizione relativa alla camera).
 *
 * Due strati:
 *   - luce: nuvole di stelle con fusione additiva;
 *   - polveri: macchie che scuriscono ciò che sta dietro (fusione "moltiplicativa").
 * Vicino al Sole il modello si dissolve (entro qualche centinaio di parsec): lì
 * parlano le stelle vere del catalogo. Visto dal Sistema Solare, lo stesso
 * modello disegna in cielo la fascia della Via Lattea con le sue corsie scure.
 */

import {
  AdditiveBlending, BackSide, BufferAttribute, BufferGeometry, CubeCamera, CustomBlending, DataTexture, HalfFloatType, LinearFilter,
  Matrix3, Matrix4, Mesh, OneMinusSrcAlphaFactor, Points, RedFormat, Scene, ShaderMaterial, SphereGeometry, UnsignedByteType, Vector2,
  Vector3, WebGLCubeRenderTarget, ZeroFactor, AddEquation, type WebGLRenderer,
} from 'three';
import { GC_SCENE_KM, M_MODEL_TO_SCENE, SUN_IN_MODEL_KPC } from '../core/galactic';
import { PC_KM } from '../core/units';

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 color;
attribute float size;    // diametro della nuvola, parsec
attribute float lum;
uniform float pxPerRad;
uniform float pxScale;
uniform float maxPx;
uniform vec3 sunModel;   // il Sole nel sistema del modello (kpc)
uniform float fade0;     // raggio (kpc) attorno al Sole dove il modello sparisce del tutto
uniform float fade1;     // ... e dove torna pieno
uniform float intensity;
uniform float near;      // quanto lontano (in diametri) le nuvole vicine si dissolvono
uniform float pxSoft;    // le nuvole che appaiono più grandi di così (pixel) si attenuano
varying vec3 vColor;
varying float vA;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  // distanza senza traboccare: length() eleva al quadrato le coordinate in km, e oltre ~600 kpc
  // (da Andromeda: 765 kpc) il quadrato supera il massimo di un float32 (3,4·10³⁸). La distanza
  // diventava infinita, la luce di ogni nuvoletta zero, e la Via Lattea spariva del tutto
  float big = max(max(abs(mv.x), abs(mv.y)), abs(mv.z));
  float dist = max(big * length(mv.xyz / max(big, 1.0)), 1.0);
  float px = size * ${PC_KM.toExponential(8)} / dist * pxPerRad;
  float a = lum;
  a *= 1.0 - smoothstep(pxSoft, pxSoft * 3.0, px);
  // sotto un pixel si conserva il flusso (area), sopra il massimo si attenua
  if (px < 1.5) { a *= (px * px) / 2.25; px = 1.5; }
  if (px > maxPx) { a *= maxPx / px; px = maxPx; }
  a *= smoothstep(fade0, fade1, distance(position, sunModel));
  // le nuvole vicinissime alla camera diventerebbero grandi macchie: si dissolvono
  float sizeKm = size * ${PC_KM.toExponential(8)};
  a *= smoothstep(sizeKm * 1.5 * near, sizeKm * 6.0 * near, dist);
  vA = a * intensity;
  vColor = color;
  gl_PointSize = vA > 0.0005 ? px * pxScale : 0.0;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}`;

const FRAG_LIGHT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vColor;
varying float vA;
void main() {
  #include <logdepthbuf_fragment>
  vec2 c = gl_PointCoord - 0.5;
  float r2 = dot(c, c) * 4.0;
  if (r2 > 1.0) discard;
  float g = exp(-r2 * 3.2);
  gl_FragColor = vec4(vColor * g * vA, 1.0);
}`;

const FRAG_DUST = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying float vA;
void main() {
  #include <logdepthbuf_fragment>
  vec2 c = gl_PointCoord - 0.5;
  float r2 = dot(c, c) * 4.0;
  if (r2 > 1.0) discard;
  float g = exp(-r2 * 2.5);
  gl_FragColor = vec4(0.0, 0.0, 0.0, clamp(g * vA, 0.0, 0.9));
}`;

export interface GalaxyParams {
  arms: unknown[];
  bar: unknown;
  disco: unknown;
}

function material(frag: string, dust: boolean): ShaderMaterial {
  const m = new ShaderMaterial({
    uniforms: {
      pxPerRad: { value: 1000 },
      pxScale: { value: 1 },
      maxPx: { value: 30 },
      sunModel: { value: SUN_IN_MODEL_KPC.clone() },
      fade0: { value: 0.25 },
      fade1: { value: 1.2 },
      intensity: { value: 1 },
      near: { value: 1 },
      pxSoft: { value: 1e9 },
    },
    vertexShader: VERT,
    fragmentShader: frag,
    transparent: true,
    depthWrite: false,
  });
  if (dust) {
    // le polveri restano anche più vicine al Sole: le nubi a poche centinaia di parsec disegnano le corsie scure
    m.uniforms.fade0.value = 0.08;
    m.uniforms.fade1.value = 0.35;
    // destinazione = destinazione × (1 − alfa): le polveri scuriscono ciò che è già stato disegnato
    m.blending = CustomBlending;
    m.blendEquation = AddEquation;
    m.blendSrc = ZeroFactor;
    m.blendDst = OneMinusSrcAlphaFactor;
  } else {
    m.blending = AdditiveBlending;
  }
  return m;
}

function geometry(o: { pos: Float32Array; col: Float32Array; size: Float32Array; lum: Float32Array; count: number }): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(o.pos, 3));
  g.setAttribute('color', new BufferAttribute(o.col, 3));
  g.setAttribute('size', new BufferAttribute(o.size, 1));
  g.setAttribute('lum', new BufferAttribute(o.lum, 1));
  g.setDrawRange(0, o.count);
  return g;
}

const _t = new Vector3();
/** raggio del disco stellare del modello (kpc), per sapere quanto è grande la Galassia sullo schermo */
const DISK_RADIUS_KPC = 15;
/** da lontanissimo restano comunque almeno queste nuvolette di luce */
const MIN_FAR_PARTICLES = 6000;

export class GalaxyLayer {
  light: Points | null = null;
  dust: Points | null = null;
  private lightMat = material(FRAG_LIGHT, false);
  private dustMat = material(FRAG_DUST, true);
  loading = false;
  ready = false;
  count = 0;
  dustCount = 0;
  /** particelle disegnate in questo fotogramma (da lontano solo una parte: vedi update) */
  drawn = 0;
  /** densità dei bracci sul piano (256 × 256, ±20 kpc), per la luce diffusa del cielo */
  armMap: Float32Array | null = null;
  /** 1 = la camera è dentro il disco: le nuvolette di luce si attenuano (le sostituisce GalaxySky) */
  insideDisk = 0;

  /** Genera il modello in un worker (qualche centinaio di millisecondi). */
  async load(params: GalaxyParams, nStars = 600_000, nDust = 110_000): Promise<void> {
    this.loading = true;
    try {
      const worker = new Worker(new URL('../workers/galaxy.worker.ts', import.meta.url), { type: 'module' });
      const res = await new Promise<any>((resolve, reject) => {
        worker.onmessage = (ev) => resolve(ev.data);
        worker.onerror = (ev) => reject(new Error(ev.message));
        worker.postMessage({ type: 'generate', ...params, nStars, nDust, seed: 1977 });
      });
      worker.terminate();
      this.light = new Points(geometry(res.stars), this.lightMat);
      this.dust = new Points(geometry(res.dust), this.dustMat);
      for (const p of [this.light, this.dust]) {
        p.frustumCulled = false;
        p.matrixAutoUpdate = false;
      }
      this.light.renderOrder = -20;
      this.dust.renderOrder = -19;
      this.count = res.stars.count;
      this.dustCount = res.dust.count;
      if (res.arms) this.armMap = res.arms as Float32Array;
      this.ready = true;
    } finally {
      this.loading = false;
    }
  }

  /**
   * sunScene: posizione del Sole (scena, km); camPos: camera (scena, km);
   * camFromSunKm: distanza della camera dal Sole (km).
   */
  /**
   * `pxRef`: pixel per radiante dello schermo, se si disegna altrove (nel cubo del cielo): le soglie
   * in pixel (nuvolette troppo grandi attenuate) restano così le stesse in gradi.
   */
  update(sunScene: Vector3, camPos: Vector3, pxPerRad: number, pxScale: number, visible: boolean, pxRef = pxPerRad): void {
    if (!this.light || !this.dust) return;
    this.light.visible = this.dust.visible = visible;
    if (!visible) return;
    // traslazione: Sgr A* rispetto alla camera (doppia precisione sulla CPU)
    _t.copy(GC_SCENE_KM).add(sunScene).sub(camPos);
    const e = M_MODEL_TO_SCENE.elements;
    const m = new Matrix4().set(
      e[0], e[3], e[6], _t.x,
      e[1], e[4], e[7], _t.y,
      e[2], e[5], e[8], _t.z,
      0, 0, 0, 1,
    );
    this.light.matrix.copy(m);
    this.dust.matrix.copy(m);
    this.light.matrixWorldNeedsUpdate = this.dust.matrixWorldNeedsUpdate = true;
    // intensità: da dentro la Galassia (anche vicino al centro) la luce va attenuata,
    // da fuori il disco intero deve risaltare
    const dGcKpc = _t.copy(camPos).sub(sunScene).sub(GC_SCENE_KM).length() / PC_KM / 1000;
    const k = Math.min(1, Math.max(0, (dGcKpc - 9) / 16)); // dentro il disco -> 0, oltre ~25 kpc dal centro -> 1
    const inside = 0.035, outside = 0.17;
    const k2px = pxPerRad / pxRef;
    for (const mat of [this.lightMat, this.dustMat]) {
      mat.uniforms.pxPerRad.value = pxPerRad;
      mat.uniforms.pxScale.value = pxScale;
      mat.uniforms.maxPx.value = 30 * k2px;
    }
    // nelle immediate vicinanze di Sagittarius A* il bagliore del bulge coprirebbe tutto
    // (il buco nero, le stelle S): lì il modello si attenua
    const core = 0.03 + 0.97 * Math.min(1, Math.max(0, (dGcKpc - 0.01) / 0.29));
    // dentro il disco la fascia la disegna la luce diffusa (GalaxySky): le nuvolette, che da qui
    // sembrano grani, restano più deboli e servono solo a dare un po' di tessitura
    const soft = 1 - 0.65 * this.insideDisk;
    // Da molto lontano (da Andromeda il disco è largo una trentina di pixel) ogni nuvoletta è
    // una frazione minuscola di pixel con una luce minuscola: lo shader scartava quelle sotto la
    // soglia (il 90% della luce) e il resto si sommava male nel buffer a mezza precisione, così
    // la Galassia spariva. Si disegnano allora solo le prime n particelle (l'ordine è mescolato
    // nel worker: sono un campione a caso), ognuna con la luce di N/n: la luce totale resta la
    // stessa. Bastano una ventina di nuvolette per pixel del disco.
    const diskPx = (DISK_RADIUS_KPC / Math.max(dGcKpc, 1e-6)) * pxPerRad;
    const want = 20 * Math.PI * diskPx * diskPx;
    const nLight = Math.round(Math.min(this.count, Math.max(MIN_FAR_PARTICLES, want)));
    const nDust = Math.round(Math.min(this.dustCount, Math.max(MIN_FAR_PARTICLES * 0.2, want * (this.dustCount / Math.max(1, this.count)))));
    this.light.geometry.setDrawRange(0, nLight);
    this.dust.geometry.setDrawRange(0, nDust);
    this.drawn = nLight + nDust;
    const gainL = this.count / Math.max(1, nLight), gainD = this.dustCount / Math.max(1, nDust);
    this.lightMat.uniforms.intensity.value = (inside + (outside - inside) * k) * core * soft * gainL;
    // da dentro, le nuvolette vicine sembrerebbero macchie sfocate: si dissolvono prima
    this.lightMat.uniforms.near.value = 1 + 2.5 * this.insideDisk;
    this.lightMat.uniforms.pxSoft.value = this.insideDisk > 0.5 ? 9 * k2px : 1e9;
    this.dustMat.uniforms.intensity.value = (0.45 + 0.25 * k) * core * (1 - 0.5 * this.insideDisk) * gainD;
  }
}

// ---------------------------------------------------------------- luce diffusa della Galassia
/*
 * Il cielo della Via Lattea, da qualunque punto: per ogni direzione si somma la luce di tutte le
 * stelle troppo lontane per vederle una a una (disco sottile e spesso, bracci con le stelle
 * giovani, barra e bulge), meno la polvere che la assorbe lungo il cammino. Da casa nostra esce
 * la fascia con le corsie scure e il bagliore verso il Sagittario; da fuori, il disco intero.
 * Unità: kpc, nel sistema del modello (origine in Sgr A*, piano galattico z = 0).
 */
const SKY_V = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vDir;
void main() {
  vDir = mat3(modelMatrix) * position;
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;

const SKY_F = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 camM;
uniform mat3 toModel;
uniform sampler2D arms;
uniform float intensity;
uniform vec2 barAxis;
uniform float skipNear;   // kpc: vicino alla camera le stelle si vedono una a una (catalogo)
varying vec3 vDir;

float armAt(vec2 xy) {
  vec2 uv = xy / 40.0 + 0.5;
  if (uv.x <= 0.0 || uv.y <= 0.0 || uv.x >= 1.0 || uv.y >= 1.0) return 0.0;
  return texture2D(arms, uv).r;
}
float rnd(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  // il cielo è lo sfondo: profondità massima, così pianeti e lune lo coprono (prima, senza
  // controllo della profondità, la fascia della Via Lattea si vedeva attraverso il lato in ombra
  // dei pianeti)
  gl_FragDepth = 0.9999999;
  vec3 d = normalize(toModel * normalize(vDir));
  const float ZMAX = 2.5, RMAX = 21.0;
  float t0 = 0.0, t1 = 80.0;
  if (abs(d.z) > 1e-6) {
    float ta = (ZMAX - camM.z) / d.z, tb = (-ZMAX - camM.z) / d.z;
    t0 = max(t0, min(ta, tb)); t1 = min(t1, max(ta, tb));
  } else if (abs(camM.z) > ZMAX) discard;
  vec2 o2 = camM.xy, d2 = d.xy;
  float a = dot(d2, d2), b = dot(o2, d2), c = dot(o2, o2) - RMAX * RMAX;
  float h = b * b - a * c;
  if (a < 1e-9) { if (c > 0.0) discard; }
  else if (h < 0.0) discard;
  else { h = sqrt(h); t0 = max(t0, (-b - h) / a); t1 = min(t1, (-b + h) / a); }
  t0 = max(t0, skipNear);
  if (t1 <= t0) discard;
  const int N = 44;
  // passi che crescono con la distanza (geometrici) se si parte da vicino, uguali se da lontano
  float geo = t0 < 1.0 ? 1.0 : 0.0;
  float q = log(t1 / t0) / float(N);
  float jit = rnd(gl_FragCoord.xy);
  vec3 L = vec3(0.0);
  float tau = 0.0;
  for (int i = 0; i < N; i++) {
    float s0 = float(i) + jit, s1 = float(i + 1) + jit;
    float ta = geo > 0.5 ? t0 * exp(q * s0) : mix(t0, t1, s0 / float(N + 1));
    float tb = geo > 0.5 ? t0 * exp(q * s1) : mix(t0, t1, s1 / float(N + 1));
    if (ta >= t1) break;
    tb = min(tb, t1);
    float dt = tb - ta;
    vec3 p = camM + d * (0.5 * (ta + tb));
    float R = length(p.xy), z = abs(p.z);
    float arm = armAt(p.xy);
    float thin = exp(-R / 2.6 - z / 0.3);
    float thick = 0.12 * exp(-R / 2.0 - z / 0.9);
    float young = arm * exp(-R / 5.0 - z / 0.1);
    vec2 bq = vec2(dot(p.xy, barAxis), dot(p.xy, vec2(-barAxis.y, barAxis.x)));
    float bulge = 1.6 * exp(-((bq.x * bq.x) / 2.6 + (bq.y * bq.y) / 0.36 + (p.z * p.z) / 0.2))
                + 2.5 * exp(-length(p) / 0.25);
    vec3 em = (thin + thick) * vec3(1.0, 0.86, 0.68) + young * vec3(0.62, 0.75, 1.0) * 1.6 + bulge * vec3(1.0, 0.78, 0.55);
    float dust = exp(-R / 3.5 - z / 0.09) * (0.35 + 1.8 * arm) * 7.0;
    L += em * exp(-tau) * dt;
    tau += dust * dt;
    if (tau > 12.0) break;
  }
  gl_FragColor = vec4(L * intensity, 1.0);
}`;

/**
 * Il cielo calcolato si "fotografa" a 360° in un cubo di sei immagini, e lo schermo disegna
 * quella fotografia: un solo accesso a una texture per pixel invece di 44 passi di calcolo.
 * Si rifà solo quando la camera si è spostata abbastanza da cambiare il cielo (vedi
 * SKY_MOVE_FRACTION): nel Sistema Solare, cioè quasi sempre, mai.
 */
const SKY_CUBE_SIZE = 1024;
/** durante i voli veloci (un ricalcolo dopo l'altro) basta un cubo più piccolo; da fermi si rifà grande */
const SKY_CUBE_SIZE_FAST = 224;
/** si ricalcola quando lo spostamento supera questa frazione della distanza della luce più vicina */
const SKY_MOVE_FRACTION = 0.001;

const SKY_SHOW_V = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vDir;
void main() {
  vDir = mat3(modelMatrix) * position;
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;

const SKY_SHOW_F = /* glsl */ `
uniform samplerCube sky;
varying vec3 vDir;
void main() {
  // lo sfondo: profondità massima, come il cielo calcolato (pianeti e lune lo coprono)
  gl_FragDepth = 0.9999999;
  gl_FragColor = vec4(textureCube(sky, normalize(vDir)).rgb, 1.0);
}`;

export class GalaxySky {
  /** la sfera che calcola il cielo (si disegna solo dentro il cubo) */
  readonly mesh: Mesh;
  /** la sfera che mostra il cielo sullo schermo */
  readonly display: Mesh;
  private mat: ShaderMaterial;
  private cubeHi = new WebGLCubeRenderTarget(SKY_CUBE_SIZE, { type: HalfFloatType, generateMipmaps: false, minFilter: LinearFilter, magFilter: LinearFilter });
  private cubeLo = new WebGLCubeRenderTarget(SKY_CUBE_SIZE_FAST, { type: HalfFloatType, generateMipmaps: false, minFilter: LinearFilter, magFilter: LinearFilter });
  // la sfera del cielo sta a 1000 km, le nuvolette a migliaia di parsec: piano lontano come la vista
  private camHi = new CubeCamera(1, 1e21, this.cubeHi);
  private camLo = new CubeCamera(1, 1e21, this.cubeLo);
  private cubeScene = new Scene();
  private lastShotAt = -1e9;
  private camModel = new Vector3();
  /** il cielo mostrato viene dal cubo piccolo: appena la camera si ferma si rifà quello grande */
  private pendingHi = false;
  /** posizione (kpc, modello) e luminosità dell'ultimo cielo fotografato */
  private shotPos = new Vector3(Infinity, 0, 0);
  private shotIntensity = -1;
  /** quante volte è stato ricalcolato (per le prove) */
  shots = 0;
  renderer: WebGLRenderer | null = null;
  /**
   * Il modello a particelle della Galassia: da dentro il disco anche le sue nuvolette sono uno
   * sfondo fermo, e si fotografano nel cubo insieme al cielo (600.000 punti in meno a ogni
   * fotogramma). Da fuori restano dal vivo: lì la spirale è la protagonista.
   */
  galaxy: GalaxyLayer | null = null;
  /** le nuvolette sono nel cubo: la vista non le disegna */
  particlesBaked = false;
  ready = false;

  constructor() {
    this.mat = new ShaderMaterial({
      uniforms: {
        camM: { value: new Vector3() },
        toModel: { value: new Matrix3() },
        arms: { value: null as DataTexture | null },
        intensity: { value: 0 },
        barAxis: { value: new Vector2(Math.cos(27 * Math.PI / 180), -Math.sin(27 * Math.PI / 180)) },
        skipNear: { value: 0.05 },
      },
      vertexShader: SKY_V,
      fragmentShader: SKY_F,
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: BackSide,
    });
    this.mesh = new Mesh(new SphereGeometry(1, 48, 24), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.scale.setScalar(1000);
    // prima il cielo, poi le nuvolette di luce, infine le polveri che scuriscono entrambi
    this.mesh.renderOrder = -100;
    this.cubeScene.add(this.mesh);
    this.display = new Mesh(new SphereGeometry(1, 48, 24), new ShaderMaterial({
      uniforms: { sky: { value: this.cubeHi.texture } },
      vertexShader: SKY_SHOW_V,
      fragmentShader: SKY_SHOW_F,
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: BackSide,
    }));
    this.display.frustumCulled = false;
    this.display.renderOrder = -100;
    this.display.visible = false;
    // la sfera sta attorno alla camera (la scena è già centrata su di lei) e si disegna per prima,
    // senza profondità: può essere piccola. Con un raggio enorme (10¹⁸ km) la scheda video
    // interpolava male le direzioni dentro i triangoli e il cielo veniva a mattonelle
    this.display.scale.setScalar(1000);
    // rotazione scena -> modello (le colonne di M_MODEL_TO_SCENE, normalizzate)
    const m = M_MODEL_TO_SCENE.clone().multiplyScalar(1 / (1000 * PC_KM));
    (this.mat.uniforms.toModel.value as Matrix3).copy(m).transpose();
  }

  setArms(map: Float32Array, n: number): void {
    const data = new Uint8Array(n * n);
    for (let i = 0; i < n * n; i++) data[i] = Math.round(Math.min(1, Math.max(0, map[i])) * 255);
    const t = new DataTexture(data, n, n, RedFormat, UnsignedByteType);
    t.magFilter = LinearFilter;
    t.minFilter = LinearFilter;
    t.needsUpdate = true;
    this.mat.uniforms.arms.value = t;
    this.ready = true;
  }

  /** Posizione della camera nel modello e luminosità: un po' più forte da fuori, dove è tutto il disco. */
  update(sunScene: Vector3, camPos: Vector3, visible: boolean, pxPerRad = 600): number {
    this.display.visible = visible && this.ready;
    if (!this.display.visible) {
      this.particlesBaked = false;
      return 0;
    }
    // (vettore proprio: _t lo usa anche il modello a particelle, chiamato durante la fotografia)
    const v = this.camModel.copy(camPos).sub(sunScene).sub(GC_SCENE_KM).divideScalar(1000 * PC_KM)
      .applyMatrix3(this.mat.uniforms.toModel.value as Matrix3);
    // vicino al Sole il catalogo mostra le stelle una a una: la luce diffusa parte da più lontano
    const insideDisk = Math.abs(v.z) < 1.5 && Math.hypot(v.x, v.y) < 18;
    const skipNear = 0.05;
    // da fuori la forma del disco (i bracci) la disegnano le nuvolette del modello:
    // la luce diffusa si attenua allontanandosi, per non coprire il contrasto fra i bracci
    const far = Math.min(1, Math.max(0, (v.length() - 20) / 25));
    // a pochi parsec da Sagittarius A* il bagliore del bulge coprirebbe il buco nero e le stelle S
    const core = 0.03 + 0.97 * Math.min(1, Math.max(0, (v.length() - 0.01) / 0.29));
    const intensity = (insideDisk ? 0.3 : 0.3 - 0.2 * far * far * (3 - 2 * far)) * core;
    // la luce più vicina: a skipNear dentro il disco, al bordo del disco da fuori
    const outside = Math.max(Math.abs(v.z) - 2.5, Math.hypot(v.x, v.y) - 21, 0);
    const scale = Math.max(skipNear, outside);
    const moved = v.distanceTo(this.shotPos) > SKY_MOVE_FRACTION * scale;
    const dimmed = Math.abs(intensity - this.shotIntensity) > 0.01 * Math.max(intensity, 1e-6);
    const now = performance.now();
    // le nuvolette vanno nel cubo solo da dentro il disco (e quando il modello è pronto)
    const bakeWanted = insideDisk && !!this.galaxy?.ready;
    const ctx = { sunScene, camPos, pxPerRad };
    if ((moved || dimmed) && this.renderer) {
      // un ricalcolo dopo l'altro (volo veloce): cubo piccolo senza nuvolette, poi quello grande quando ci si ferma
      const fast = now - this.lastShotAt < 200;
      this.shoot(v, skipNear, intensity, fast, bakeWanted && !fast, ctx);
      this.lastShotAt = now;
      this.pendingHi = fast;
    } else if (this.renderer && ((this.pendingHi && now - this.lastShotAt > 250) || (bakeWanted !== this.particlesBaked && !this.pendingHi))) {
      // fermi dopo un volo, oppure il modello è appena arrivato (o si è usciti dal disco)
      this.shoot(v.copy(this.shotPos), skipNear, this.shotIntensity, false, bakeWanted, ctx);
      this.pendingHi = false;
    }
    return insideDisk ? 1 : 0;
  }

  /** Fotografa il cielo calcolato dal punto `v` (kpc, modello) nel cubo grande o in quello piccolo. */
  private shoot(v: Vector3, skipNear: number, intensity: number, small: boolean, bake: boolean,
    ctx: { sunScene: Vector3; camPos: Vector3; pxPerRad: number }): void {
    (this.mat.uniforms.camM.value as Vector3).copy(v);
    this.mat.uniforms.skipNear.value = skipNear;
    this.mat.uniforms.intensity.value = intensity;
    const g = this.galaxy;
    const pl = g?.light, pd = g?.dust;
    const parents = bake && pl && pd ? [pl.parent, pd.parent] : null;
    if (parents && g && pl && pd) {
      // le nuvolette, viste dalla camera, con i pixel del cubo; poi si rimettono nella scena
      const S = small ? SKY_CUBE_SIZE_FAST : SKY_CUBE_SIZE;
      g.insideDisk = 1;
      g.update(ctx.sunScene, ctx.camPos, S / 2, 1, true, ctx.pxPerRad);
      this.cubeScene.add(pl, pd);
    }
    (small ? this.camLo : this.camHi).update(this.renderer!, this.cubeScene);
    if (parents && pl && pd) {
      if (parents[0]) parents[0].add(pl); else this.cubeScene.remove(pl);
      if (parents[1]) parents[1].add(pd); else this.cubeScene.remove(pd);
    }
    this.particlesBaked = !!parents;
    (this.display.material as ShaderMaterial).uniforms.sky.value = (small ? this.cubeLo : this.cubeHi).texture;
    this.shotPos.copy(v);
    this.shotIntensity = intensity;
    this.shots++;
  }
}
