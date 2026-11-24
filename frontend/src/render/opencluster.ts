/**
 * Ammasso aperto disegnato stella per stella (Pleiadi, Iadi).
 *
 * La foto di un ammasso vale solo "come dalla Terra": prima, girandoci attorno, le Pleiadi
 * sparivano (la foto si spegneva fuori dalla direzione della Terra e non c'era niente al suo
 * posto), e le Iadi non avevano proprio niente. Qui le stelle seguono il profilo di Plummer con il
 * raggio di metà massa misurato, tagliato al raggio mareale, con una popolazione tipica dell'età
 * dell'ammasso (magnitudine assoluta e indice di colore B−V). Ogni stella si disegna come quelle
 * del catalogo (render/stars.ts): luminosità dalla magnitudine apparente vista dalla camera, stessi
 * colori, stesso limite di magnitudine. Il generatore è deterministico: lo stesso ammasso ha
 * sempre le stesse stelle.
 *
 * È un modello: le posizioni delle singole stelle sono inventate (con la distribuzione giusta).
 * Per questo dalla direzione della Terra si spegne e lasciano il posto la foto e le stelle vere
 * del catalogo, che descrivono l'ammasso come lo vediamo davvero.
 *
 * Coordinate in parsec rispetto al centro: il gruppo dell'oggetto le scala in km.
 */

import { AdditiveBlending, BufferAttribute, BufferGeometry, Points, ShaderMaterial } from 'three';
import { PC_KM } from '../core/units';
import { STAR_COLOR_GLSL } from './stars';

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float absmag;
attribute float ci;        // indice di colore B−V
uniform float magLimit;
uniform float pxScale;
uniform float intensity;   // 0 = spento (dalla Terra vale la foto), 1 = pieno
uniform float saturation;
varying vec3 vColor;
varying float vAlpha;
${STAR_COLOR_GLSL}
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  // distanza in parsec: la scena lontana è rimpicciolita (scala del gruppo), il rapporto resta giusto
  float d = max(length(mv.xyz) / length(modelMatrix[0].xyz), 1e-6);
  float m = absmag + 5.0 * 0.30102999566 * log2(d / 10.0);
  // troppo debole: fuori dallo schermo. Una dimensione 0 non basta, la scheda video la porta a 1 pixel:
  // da lontano tutte le stelle dell'ammasso finivano sullo stesso pixel e facevano un bagliore
  if (m > magLimit || intensity < 0.01) {
    vAlpha = 0.0;
    vColor = vec3(0.0);
    gl_PointSize = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float L = 0.4 * (magLimit - m);
  vAlpha = clamp(0.12 + 0.42 * L, 0.12, 1.0) * intensity;
  vColor = starColor(ci);
  gl_PointSize = clamp(1.0 + 1.5 * L, 1.0, 8.0) * pxScale;
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

/** [frazione delle stelle, magnitudine assoluta V min e max, B−V min e max] */
type Kind = [number, number, number, number, number];

/**
 * Popolazioni (frazioni approssimate, dalle funzioni di luminosità tipiche):
 *  - giovane (Pleiadi, ~110 milioni di anni): poche stelle B azzurre molto luminose, nessuna gigante;
 *  - intermedia (Iadi, ~640 milioni di anni): le B sono già morte, restano le A bianche e
 *    quattro giganti arancioni.
 * Le nane K e M, deboli, sono la maggioranza in entrambe.
 */
const POPULATIONS: Record<string, Kind[]> = {
  giovane: [
    [0.010, -2.6, -0.3, -0.12, -0.03],  // B
    [0.040, 0.0, 2.2, 0.0, 0.3],        // A
    [0.072, 2.3, 4.0, 0.3, 0.55],       // F
    [0.096, 4.0, 6.0, 0.55, 0.85],      // G
    [0.224, 6.0, 8.5, 0.85, 1.4],       // K
    [1.0, 8.5, 13.0, 1.4, 1.8],         // M
  ],
  intermedia: [
    [0.011, 0.2, 0.5, 0.95, 1.02],      // giganti arancioni
    [0.055, 0.8, 2.5, 0.05, 0.3],       // A
    [0.11, 2.5, 4.0, 0.3, 0.55],        // F
    [0.14, 4.0, 6.0, 0.55, 0.85],       // G
    [0.27, 6.0, 8.5, 0.85, 1.4],        // K
    [1.0, 8.5, 13.0, 1.4, 1.8],         // M
  ],
};

export interface OpenClusterSpec {
  /** raggio di metà massa (parsec) */
  rh_pc: number;
  /** raggio mareale (parsec): oltre, le stelle non sono più legate all'ammasso */
  rt_pc: number;
  stars: number;
  pop: 'giovane' | 'intermedia';
}

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

export class OpenCluster {
  readonly points: Points;
  private mat: ShaderMaterial;
  readonly rhPc: number;

  constructor(spec: OpenClusterSpec, seed: number) {
    this.rhPc = spec.rh_pc;
    const pop = POPULATIONS[spec.pop] ?? POPULATIONS.giovane;
    const rand = rng(seed * 2654435761 + 11);
    const a = spec.rh_pc / 1.305; // raggio di Plummer
    const n = Math.max(1, Math.round(spec.stars));
    const pos = new Float32Array(n * 3), absmag = new Float32Array(n), ci = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      do {
        const u = Math.max(rand(), 1e-9);
        r = a / Math.sqrt(Math.pow(u, -2 / 3) - 1);
      } while (r > spec.rt_pc);
      const z = rand() * 2 - 1, t = rand() * Math.PI * 2, s = Math.sqrt(1 - z * z);
      pos[i * 3] = r * s * Math.cos(t);
      pos[i * 3 + 1] = r * s * Math.sin(t);
      pos[i * 3 + 2] = r * z;
      const p = rand();
      let acc = 0;
      for (const [frac, m0, m1, c0, c1] of pop) {
        acc += frac;
        if (p <= acc || frac >= 1) {
          const k = rand();
          absmag[i] = m0 + (m1 - m0) * k;
          // nella sequenza principale le stelle più deboli sono anche più rosse
          ci[i] = c0 + (c1 - c0) * Math.min(1, Math.max(0, k + (rand() - 0.5) * 0.2));
          break;
        }
      }
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('absmag', new BufferAttribute(absmag, 1));
    g.setAttribute('ci', new BufferAttribute(ci, 1));
    this.mat = new ShaderMaterial({
      uniforms: { magLimit: { value: 6.8 }, pxScale: { value: 1 }, intensity: { value: 0 }, saturation: { value: 1.35 } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.points = new Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.scale.setScalar(PC_KM); // parsec -> km
    this.points.renderOrder = 2;
    this.points.visible = false;
  }

  update(pxScale: number, intensity: number, magLimit: number, saturation: number): void {
    const u = this.mat.uniforms;
    u.pxScale.value = pxScale;
    u.intensity.value = intensity;
    u.magLimit.value = magLimit;
    u.saturation.value = saturation;
    this.points.visible = intensity > 0.01;
  }
}
