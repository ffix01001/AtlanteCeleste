/**
 * Stelle reali nella loro posizione 3D, caricate a "tasselli" (octree).
 *
 * Il catalogo (HYG oggi, Gaia DR3 domani: miliardi di stelle) è diviso dal
 * server in cubi annidati; ogni cubo contiene le stelle intrinsecamente più
 * luminose della sua zona, le più deboli stanno nei cubi figli. A ogni istante
 * si scaricano solo i tasselli che possono contenere stelle visibili dalla
 * posizione della camera (magnitudine apparente sotto il limite): da lontano
 * bastano pochi tasselli, avvicinandosi a una regione si aprono i suoi figli.
 * I tasselli che non servono più vengono liberati.
 *
 * La luminosità di ogni stella si calcola sulla GPU a partire dalla magnitudine
 * assoluta e dalla distanza dalla camera: se voli verso un'altra stella, il
 * cielo cambia davvero.
 */

import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Group, PerspectiveCamera, Points, ShaderMaterial, Vector3,
} from 'three';
import { parseAtbl } from '../data/atbl';
import { starNameTranslator } from '../data/names';
import { api, type StarIndex, type StarIndexNode, type StarName } from '../data/api';
import { M_ICRF_TO_SCENE, M_SCENE_TO_ICRF } from '../core/frames';
import { PC_KM } from '../core/units';

/**
 * Colore di una stella dal suo indice B−V (GLSL, usa l'uniform `saturation`): condiviso con gli
 * ammassi aperti disegnati stella per stella (render/opencluster.ts), così hanno gli stessi colori.
 */
export const STAR_COLOR_GLSL = /* glsl */ `
// colore di un corpo nero: temperatura dall'indice B−V (Ballesteros 2012), poi RGB (T. Helland)
vec3 starColor(float bv) {
  bv = clamp(bv, -0.4, 2.0);
  float T = 46.0 * (1.0 / (0.92 * bv + 1.7) + 1.0 / (0.92 * bv + 0.62));   // centinaia di kelvin
  vec3 c;
  if (T <= 66.0) {
    c = vec3(255.0, 99.4708 * log(T) - 161.1196, T <= 19.0 ? 0.0 : 138.5177 * log(T - 10.0) - 305.0448);
  } else {
    c = vec3(329.6987 * pow(T - 60.0, -0.1332), 288.1222 * pow(T - 60.0, -0.0755), 255.0);
  }
  c = clamp(c / 255.0, 0.0, 1.0);
  float l = (c.r + c.g + c.b) / 3.0;
  c = max(mix(vec3(l), c, saturation), 0.0);
  // il canale più forte vale 1: il colore resta pulito anche per le stelle deboli
  c /= max(max(c.r, max(c.g, c.b)), 0.001);
  // la formula dà colori "da schermo" (sRGB): la scena lavora in luce lineare
  c = pow(c, vec3(2.2));
  // stessa luminosità percepita a parità di magnitudine (una stella arancione di magnitudine 1
  // appare brillante quanto una bianca di magnitudine 1, solo di un altro colore)
  return c * (0.8 / max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 0.3));
}
`;

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float absmag;
attribute float ci;        // indice di colore B−V
uniform vec3 camHi;        // posizione della camera in parsec (scena, rispetto al Sole): parte "alta"...
uniform vec3 camLo;        // ... e resto, per non perdere precisione nella sottrazione
uniform float nearCut;     // più vicine di così (parsec) le disegna il livello calcolato sulla CPU
uniform float magLimit;    // magnitudine limite
uniform float pxScale;
uniform float layerFade;   // da distanze galattiche il catalogo cede il passo al modello della Via Lattea
uniform float saturation;  // 0,5 = come a occhio nudo; 1,35 = colori accentuati
varying vec3 vColor;
varying float vAlpha;

${STAR_COLOR_GLSL}
void main() {
  vec3 rel = (position - camHi) - camLo;
  float d0 = length(rel);
  float d = max(d0, 1e-6);
  float m = absmag + 5.0 * 0.30102999566 * log2(d / 10.0);
  float L = 0.4 * (magLimit - m);                 // log10 del flusso rispetto alla soglia
  vAlpha = clamp(0.12 + 0.42 * L, 0.12, 1.0) * layerFade;
  vColor = starColor(ci);
  gl_PointSize = (m > magLimit || layerFade < 0.01 || d0 < nearCut) ? 0.0 : clamp(1.0 + 1.5 * L, 1.0, 8.0) * pxScale;
  vec4 mv = viewMatrix * vec4(rel * ${PC_KM.toExponential(10)}, 1.0);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}`;

const FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vColor;
varying float vAlpha;
void main() {
  #include <logdepthbuf_fragment>
  vec2 c = gl_PointCoord - 0.5;
  float r2 = dot(c, c) * 4.0;
  if (r2 > 1.0) discard;
  float core = exp(-r2 * 4.0);
  gl_FragColor = vec4(vColor * vAlpha * (0.35 + 1.4 * core), 1.0);
}`;


interface Tile {
  node: StarIndexNode;
  children: Tile[];
  state: 'none' | 'loading' | 'ready' | 'error';
  points: Points | null;
  /** posizioni in parsec, coordinate di scena */
  pos: Float32Array | null;
  absmag: Float32Array | null;
  ci: Float32Array | null;
  idHi: Uint32Array | null;
  idLo: Uint32Array | null;
  count: number;
  lastNeeded: number;
  /** magnitudine apparente della stella più brillante vista dalla camera (priorità) */
  appMag: number;
}

const _ic = new Vector3();

export interface StarPick {
  id: string;
  /** posizione in parsec, coordinate di scena */
  pos: Vector3;
  absmag?: number;
  /** indice di colore B−V */
  ci?: number;
}

export interface StarNameEntry {
  id: string;
  name: string;
  pos: Vector3; // parsec, scena
  absmag: number;
}

/**
 * Le stelle più vicine alla camera si calcolano sulla CPU in doppia precisione. La scheda video
 * lavora con circa 7 cifre: per una stella a 100 parsec l'errore è di circa un'unità astronomica,
 * invisibile da lontano ma enorme quando si zooma sulla stella (il punto salterebbe qua e là).
 */
const NEAR_MAX = 16;

export class StarLayer {
  readonly group = new Group();
  /** stelle vicinissime alla camera, con posizioni calcolate sulla CPU (vedi NEAR_MAX) */
  readonly near: Points;
  private nearGeo: BufferGeometry;
  private nearCand: { t: Tile; i: number }[] = [];
  private nearScanAt = 0;
  private nearScanCam = new Vector3(Infinity, 0, 0);
  private nearScanR = 0;
  /** stella selezionata (id del catalogo): da vicino la disegna il suo corpo, non il catalogo */
  skipId: string | null = null;
  catalog = '';
  catalogLabel = '';
  /** stelle nel catalogo intero */
  total = 0;
  /** stelle caricate in questo momento */
  count = 0;
  tilesLoaded = 0;
  tilesTotal = 0;
  names: StarNameEntry[] = [];
  magLimit = 6.8;
  /** tetto di stelle in memoria (si liberano i tasselli inutili) */
  maxStars = 4_000_000;
  maxConcurrent = 4;
  private mat: ShaderMaterial;
  /** saturazione dei colori (0,5 come a occhio nudo, 1,35 accentuati): la usano anche gli ammassi aperti */
  get saturation(): number {
    return this.mat.uniforms.saturation.value as number;
  }
  private root: Tile | null = null;
  private all: Tile[] = [];
  private active = 0;
  private lastPlan = 0;
  private camIcrfPc = new Vector3();

  constructor() {
    this.mat = new ShaderMaterial({
      uniforms: {
        camHi: { value: new Vector3() }, camLo: { value: new Vector3() }, nearCut: { value: 0 },
        magLimit: { value: this.magLimit }, pxScale: { value: 1 }, layerFade: { value: 1 }, saturation: { value: 1.35 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.group.renderOrder = -10;
    // livello di precisione: posizioni già riferite alla camera (camHi = camLo = 0)
    const u = this.mat.uniforms;
    this.nearGeo = new BufferGeometry();
    this.nearGeo.setAttribute('position', new BufferAttribute(new Float32Array(NEAR_MAX * 3), 3));
    this.nearGeo.setAttribute('absmag', new BufferAttribute(new Float32Array(NEAR_MAX), 1));
    this.nearGeo.setAttribute('ci', new BufferAttribute(new Float32Array(NEAR_MAX), 1));
    this.nearGeo.setDrawRange(0, 0);
    this.near = new Points(this.nearGeo, new ShaderMaterial({
      uniforms: {
        camHi: { value: new Vector3() }, camLo: { value: new Vector3() }, nearCut: { value: -1 },
        magLimit: u.magLimit, pxScale: u.pxScale, layerFade: u.layerFade, saturation: u.saturation,
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    }));
    this.near.frustumCulled = false;
    this.near.renderOrder = -10;
    this.group.add(this.near);
  }

  /** cambia a ogni ricaricamento: i tasselli in arrivo dal catalogo precedente si scartano */
  private generation = 0;
  /** magnitudine G fino a cui arriva il catalogo (Gaia), se nota */
  gmax: number | null = null;

  /** Ricarica il catalogo predefinito del server (dopo aver scaricato le stelle di Gaia). */
  async reload(): Promise<void> {
    this.generation++;
    this.nearCand.length = 0;
    for (const t of this.all) {
      if (t.points) {
        this.group.remove(t.points);
        t.points.geometry.dispose();
      }
    }
    this.all = [];
    this.root = null;
    this.count = 0;
    this.tilesLoaded = 0;
    this.tilesTotal = 0;
    this.names = [];
    await this.load();
  }

  async load(): Promise<void> {
    const cats = await api.starCatalogs();
    const cat = cats.default;
    if (!cat) throw new Error('Nessun catalogo stellare');
    const index = await api.starIndex(cat);
    this.catalog = cat;
    this.catalogLabel = index.label ?? cat;
    this.total = index.count;
    this.gmax = typeof (index as { gmax?: number }).gmax === 'number' ? (index as { gmax?: number }).gmax! : null;
    this.buildTree(index);
    void Promise.all([api.starNames(cat), starNameTranslator()]).then(([list, tr]) => {
      this.names = list.map((n: StarName) => ({
        id: n.id, name: tr(n.name), pos: new Vector3(n.p[0], n.p[1], n.p[2]).applyMatrix3(M_ICRF_TO_SCENE), absmag: n.m,
      }));
    }).catch(() => {});
  }

  private buildTree(index: StarIndex): void {
    const byId = new Map<string, Tile>();
    for (const node of index.nodes) {
      const t: Tile = {
        node, children: [], state: 'none', points: null, pos: null, absmag: null, ci: null, idHi: null, idLo: null, count: 0,
        lastNeeded: 0, appMag: 99,
      };
      byId.set(node.id, t);
      this.all.push(t);
    }
    for (const t of this.all) t.children = t.node.k.map((k) => byId.get(k)!).filter(Boolean);
    this.root = byId.get('r') ?? this.all[0] ?? null;
    this.tilesTotal = this.all.length;
  }

  update(camPosKm: Vector3, pxScale: number): void {
    // posizione della camera in parsec, divisa in parte "alta" (quella che la scheda video
    // rappresenta esattamente) e resto: la sottrazione nello shader perde molto meno
    const cx = camPosKm.x / PC_KM, cy = camPosKm.y / PC_KM, cz = camPosKm.z / PC_KM;
    const hx = Math.fround(cx), hy = Math.fround(cy), hz = Math.fround(cz);
    this.mat.uniforms.camHi.value.set(hx, hy, hz);
    this.mat.uniforms.camLo.value.set(cx - hx, cy - hy, cz - hz);
    this.updateNear(cx, cy, cz);
    // il catalogo copre i dintorni del Sole: visto da migliaia di parsec diventerebbe un
    // grumo di punti (ognuno largo almeno un pixel) sovrapposti. Lì parla il modello galattico.
    const dPc = camPosKm.length() / PC_KM;
    const fade = Math.min(1, Math.max(0, (5000 - dPc) / 3500));
    this.mat.uniforms.layerFade.value = fade;
    if (fade <= 0) return;
    this.mat.uniforms.magLimit.value = this.magLimit;
    this.mat.uniforms.pxScale.value = pxScale;
    const now = performance.now();
    if (this.root && now - this.lastPlan > 250) {
      this.lastPlan = now;
      this.camIcrfPc.copy(camPosKm).applyMatrix3(M_SCENE_TO_ICRF).divideScalar(PC_KM);
      this.plan(now);
    }
  }

  /**
   * Stelle a meno di qualche centesimo di parsec dalla camera (di solito nessuna, o quella su cui
   * si è zoomato): si tolgono dal disegno della scheda video (nearCut) e si disegnano con le
   * posizioni riferite alla camera calcolate qui, in doppia precisione. La stella selezionata non
   * si disegna affatto: da vicino la mostra il suo corpo, con il colore e la grandezza veri.
   */
  private updateNear(cx: number, cy: number, cz: number): void {
    // raggio entro cui l'errore della scheda video si vedrebbe (cresce con la distanza dal Sole)
    const R = Math.max(0.01, Math.hypot(cx, cy, cz) * 3e-4);
    this.mat.uniforms.nearCut.value = R;
    const now = performance.now();
    const moved = Math.hypot(cx - this.nearScanCam.x, cy - this.nearScanCam.y, cz - this.nearScanCam.z);
    if (moved > this.nearScanR * 0.25 || now - this.nearScanAt > 500) {
      // nuova ricerca, un po' più larga, così fra una ricerca e l'altra non sfugge nessuna stella
      this.nearScanAt = now;
      this.nearScanCam.set(cx, cy, cz);
      this.nearScanR = R;
      const S = R * 1.6, S2 = S * S;
      const ic = _ic.set(cx, cy, cz).applyMatrix3(M_SCENE_TO_ICRF);
      const cand = this.nearCand;
      cand.length = 0;
      for (const t of this.all) {
        if (t.state !== 'ready' || !t.pos) continue;
        const nd = t.node;
        if (Math.abs(ic.x - nd.c[0]) > nd.h + S || Math.abs(ic.y - nd.c[1]) > nd.h + S || Math.abs(ic.z - nd.c[2]) > nd.h + S) continue;
        const p = t.pos;
        for (let i = 0; i < t.count; i++) {
          const dx = p[i * 3] - cx;
          if (dx > S || dx < -S) continue;
          const dy = p[i * 3 + 1] - cy, dz = p[i * 3 + 2] - cz;
          if (dx * dx + dy * dy + dz * dz < S2) cand.push({ t, i });
        }
      }
    }
    const P = this.nearGeo.getAttribute('position') as BufferAttribute;
    const A = this.nearGeo.getAttribute('absmag') as BufferAttribute;
    const C = this.nearGeo.getAttribute('ci') as BufferAttribute;
    let n = 0;
    for (const { t, i } of this.nearCand) {
      if (n >= NEAR_MAX) break;
      const p = t.pos;
      if (!p || !t.absmag || !t.ci) continue; // tassello liberato nel frattempo
      // stesso valore che usa la scheda video (float32), ma sottratto in doppia precisione
      const dx = p[i * 3] - cx, dy = p[i * 3 + 1] - cy, dz = p[i * 3 + 2] - cz;
      if (dx * dx + dy * dy + dz * dz >= R * R) continue;
      if (this.skipId !== null && this.idOf(t, i) === this.skipId) continue;
      P.setXYZ(n, dx, dy, dz);
      A.setX(n, t.absmag[i]);
      C.setX(n, t.ci[i]);
      n++;
    }
    if (n) P.needsUpdate = A.needsUpdate = C.needsUpdate = true;
    this.nearGeo.setDrawRange(0, n);
  }

  private idOf(t: Tile, i: number): string {
    return BigInt.asIntN(64, (BigInt(t.idHi![i]) << 32n) | BigInt(t.idLo![i])).toString();
  }

  /** Quali tasselli servono adesso? Si scende nell'albero finché le stelle restano visibili. */
  private plan(now: number): void {
    const want: Tile[] = [];
    const visit = (t: Tile, depth: number) => {
      t.appMag = this.apparentMag(t);
      if (depth > 0 && t.appMag > this.magLimit + 0.3) return;
      t.lastNeeded = now;
      want.push(t);
      for (const c of t.children) visit(c, depth + 1);
    };
    visit(this.root!, 0);
    // carica per primi i tasselli con le stelle più brillanti a schermo
    want.sort((a, b) => a.appMag - b.appMag);
    for (const t of want) {
      if (this.active >= this.maxConcurrent) break;
      if (t.state === 'none' && this.count + t.node.n <= this.maxStars) void this.fetch(t);
    }
    // libera i tasselli che non servono da un po' (mai la radice)
    for (const t of this.all) {
      if (t === this.root || t.state !== 'ready') continue;
      if (now - t.lastNeeded > 15000 || (this.count > this.maxStars && now - t.lastNeeded > 1000)) this.release(t);
    }
  }

  /** Magnitudine apparente della stella più brillante del tassello, vista dalla camera. */
  private apparentMag(t: Tile): number {
    const n = t.node;
    const c = this.camIcrfPc;
    const dx = Math.max(Math.abs(c.x - n.c[0]) - n.h, 0);
    const dy = Math.max(Math.abs(c.y - n.c[1]) - n.h, 0);
    const dz = Math.max(Math.abs(c.z - n.c[2]) - n.h, 0);
    const d = Math.max(Math.hypot(dx, dy, dz), 1e-3);
    return n.m + 5 * Math.log10(d / 10);
  }

  private async fetch(t: Tile): Promise<void> {
    t.state = 'loading';
    this.active++;
    const gen = this.generation;
    try {
      const buf = await api.starTile(this.catalog, t.node.id);
      if (gen !== this.generation) return;
      const { cols } = parseAtbl(buf);
      const n = (cols.x as Float32Array).length;
      const x = cols.x as Float32Array, y = cols.y as Float32Array, z = cols.z as Float32Array;
      const ci = cols.ci as Float32Array;
      const pos = new Float32Array(n * 3);
      const v = new Vector3();
      for (let i = 0; i < n; i++) {
        v.set(x[i], y[i], z[i]).applyMatrix3(M_ICRF_TO_SCENE);
        pos[i * 3] = v.x;
        pos[i * 3 + 1] = v.y;
        pos[i * 3 + 2] = v.z;
      }
      const geo = new BufferGeometry();
      geo.setAttribute('position', new BufferAttribute(pos, 3));
      geo.setAttribute('absmag', new BufferAttribute(cols.absmag as Float32Array, 1));
      geo.setAttribute('ci', new BufferAttribute(ci, 1));
      const pts = new Points(geo, this.mat);
      pts.frustumCulled = false;
      pts.renderOrder = -10;
      t.points = pts;
      t.pos = pos;
      t.absmag = cols.absmag as Float32Array;
      t.ci = ci;
      t.idHi = cols.id_hi as Uint32Array;
      t.idLo = cols.id_lo as Uint32Array;
      t.count = n;
      t.state = 'ready';
      this.count += n;
      this.tilesLoaded++;
      this.group.add(pts);
    } catch {
      t.state = 'error';
    } finally {
      this.active--;
    }
  }

  private release(t: Tile): void {
    if (t.points) {
      this.group.remove(t.points);
      t.points.geometry.dispose();
    }
    this.count -= t.count;
    this.tilesLoaded--;
    t.points = null;
    t.pos = t.absmag = t.ci = null;
    t.idHi = t.idLo = null;
    t.count = 0;
    t.state = 'none';
  }

  /** Stella più vicina al punto cliccato (solo quelle visibili). */
  pick(x: number, y: number, camera: PerspectiveCamera, camPosKm: Vector3, w: number, h: number, tol = 8): StarPick | null {
    const cam = camPosKm.clone().divideScalar(PC_KM);
    const v = new Vector3();
    let best: { t: Tile; i: number } | null = null;
    let bestScore = Infinity;
    for (const t of this.all) {
      if (t.state !== 'ready' || !t.pos || !t.absmag) continue;
      const p = t.pos;
      for (let i = 0; i < t.count; i++) {
        v.set(p[i * 3] - cam.x, p[i * 3 + 1] - cam.y, p[i * 3 + 2] - cam.z);
        const d = v.length();
        const m = t.absmag[i] + 5 * Math.log10(d / 10);
        if (m > this.magLimit) continue;
        v.applyMatrix4(camera.matrixWorldInverse);
        if (v.z >= 0) continue;
        v.applyMatrix4(camera.projectionMatrix);
        const sx = (v.x * 0.5 + 0.5) * w, sy = (-v.y * 0.5 + 0.5) * h;
        const dd = Math.hypot(sx - x, sy - y);
        if (dd > tol) continue;
        const score = dd + m * 1.5; // a parità di distanza, preferisce la più luminosa
        if (score < bestScore) {
          bestScore = score;
          best = { t, i };
        }
      }
    }
    if (!best) return null;
    const { t, i } = best;
    const id = this.idOf(t, i);
    return { id, pos: new Vector3(t.pos![i * 3], t.pos![i * 3 + 1], t.pos![i * 3 + 2]), absmag: t.absmag![i], ci: t.ci?.[i] };
  }

  nameOf(id: string): string | undefined {
    return this.names.find((n) => n.id === id)?.name;
  }

  /** true = colori accentuati (si riconosce il tipo di stella), false = come a occhio nudo */
  set vividColors(on: boolean) {
    this.mat.uniforms.saturation.value = on ? 1.35 : 0.5;
  }

  set visible(v: boolean) {
    this.group.visible = v;
  }
}
