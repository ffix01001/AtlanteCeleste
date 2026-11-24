/**
 * Linee "spesse" con i bordi sfumati, per orbite e traiettorie.
 *
 * Le linee normali di WebGL sono larghe un solo pixel fisico e senza antialiasing:
 * su uno schermo Retina diventano sottilissime e, quando la vista si muove di una
 * frazione di pixel, alcuni tratti si accendono e si spengono (il "lampeggio").
 * Qui ogni segmento è un rettangolo largo qualche pixel, costruito sullo schermo
 * nel vertex shader, con una sfumatura di un pixel sui bordi: la linea ha lo stesso
 * spessore apparente su ogni monitor e scorre in modo continuo.
 *
 * I punti stanno in un unico buffer [x, y, z, alfa] e ogni segmento legge il punto i
 * e il punto i+1 (stesso buffer, scostamento di un punto): nessun dato duplicato.
 */

import {
  BufferAttribute, Color, DoubleSide, Float32BufferAttribute, InstancedBufferGeometry, InstancedInterleavedBuffer,
  InterleavedBufferAttribute, Mesh, ShaderMaterial, Vector2, Vector4,
} from 'three';

/** Uniform condivise da tutte le linee (aggiornate da View al ridimensionamento). */
export const LINE_SHARED = {
  /** dimensione del disegno in pixel fisici */
  resolution: { value: new Vector2(1, 1) },
  /** pixel fisici per pixel CSS */
  pxRatio: { value: 1 },
};

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 instanceStart;
attribute vec3 instanceEnd;
attribute float instanceAlphaStart;
attribute float instanceAlphaEnd;
uniform vec2 resolution;
uniform float pxRatio;
uniform float widthCss;
uniform float glow;
varying float vA;
varying float vEdgeW;
varying float vW;
varying float vHalf;
void main() {
  vec4 s = modelViewMatrix * vec4(instanceStart, 1.0);
  vec4 e = modelViewMatrix * vec4(instanceEnd, 1.0);
  // alfa negativa = separatore: più linee nello stesso buffer, senza tratti di collegamento
  if (instanceAlphaStart < 0.0 || instanceAlphaEnd < 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vA = 0.0; vEdgeW = 0.0; vW = 1.0; vHalf = 0.0; return; }
  vA = position.y < 0.5 ? instanceAlphaStart : instanceAlphaEnd;
  // la parte del segmento dietro la camera si taglia su un piano appena davanti
  // (altrimenti la proiezione rovescia il punto e il rettangolo attraversa lo schermo).
  float zt = -1e-6 * max(1.0, min(abs(s.z), abs(e.z)));
  if (s.z > zt && e.z > zt) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vA = 0.0; vEdgeW = 0.0; vW = 1.0; vHalf = 0.0; return; }
  if (s.z > zt || e.z > zt) {
    // Il piano di taglio non può stare troppo vicino alla camera: in virgola mobile a 32 bit un
    // estremo a milioni di km ha un errore di decine di metri, e il punto tagliato finirebbe
    // dalla parte sbagliata (la linea sparisce). Uno scarto di 1/100000 delle coordinate è
    // sicuro e invisibile (quella parte è comunque fuori dallo schermo); non oltre metà strada
    // verso l'estremo che resta davanti.
    vec3 m3 = max(abs(s.xyz), abs(e.xyz));
    float zf = min(s.z, e.z);
    float zc = -min(max(1e-6, 1e-5 * max(m3.x, max(m3.y, m3.z))), -0.5 * zf);
    if (s.z > zc) s.xyz = mix(e.xyz, s.xyz, (zc - e.z) / (s.z - e.z));
    else e.xyz = mix(s.xyz, e.xyz, (zc - s.z) / (e.z - s.z));
  }
  vec4 cs = projectionMatrix * s;
  vec4 ce = projectionMatrix * e;
  vec2 half_res = resolution * 0.5;
  vec2 ps = cs.xy / cs.w * half_res;
  vec2 pe = ce.xy / ce.w * half_res;
  vec2 d = pe - ps;
  float len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  // spessore in pixel fisici, più un pixel per la sfumatura dei bordi
  float halfW = 0.5 * widthCss * pxRatio;
  float ext = halfW + 1.0 + glow * 3.0;
  vec4 c = position.y < 0.5 ? cs : ce;
  // (i segmenti non si allungano: dove si sovrapporrebbero l'alfa raddoppierebbe in tanti puntini)
  vec2 off = nrm * position.x * ext;
  c.xy += off / half_res * c.w;
  gl_Position = c;
  // distanza dal centro della linea, in pixel: deve variare in modo lineare sullo schermo.
  // WebGL interpola le varying "in prospettiva": se un estremo del segmento è vicinissimo alla
  // camera e l'altro lontanissimo, la sfumatura dei bordi si deforma e la linea diventa una
  // banda larga e sbiadita. Si passa valore × w e w: il loro rapporto si interpola lineare.
  vEdgeW = position.x * ext * c.w;
  vW = c.w;
  vHalf = halfW;
  #include <logdepthbuf_vertex>
}`;

const FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 color;
uniform float opacity;
uniform float glow;
// "buco" attorno al corpo della linea: x, y centro in pixel fisici, z raggio dove la linea sparisce,
// w raggio dove torna piena (w = 0: nessun buco). Così l'orbita o la scia non attraversano il corpo
uniform vec4 hole;
varying float vA;
varying float vEdgeW;
varying float vW;
varying float vHalf;
void main() {
  #include <logdepthbuf_fragment>
  float vEdge = vEdgeW / vW;
  // copertura del pixel: 1 al centro, sfuma a 0 nell'ultimo pixel del bordo
  float w = max(vHalf, 0.5);
  float cov = clamp(w + 0.5 - abs(vEdge), 0.0, 1.0);
  // linee più sottili di un pixel: si allarga a un pixel e si riduce l'intensità
  cov *= min(1.0, vHalf * 2.0);
  // un velo luminoso appena fuori dal bordo (solo per la linea evidenziata)
  float halo = glow * exp(-max(abs(vEdge) - w, 0.0) * 1.2) * 0.35;
  float a = opacity * (0.12 + 0.88 * vA * vA) * max(cov, halo);
  if (hole.w > 0.0) a *= smoothstep(hole.z, hole.w, distance(gl_FragCoord.xy, hole.xy));
  if (a < 0.002) discard;
  gl_FragColor = vec4(color, a);
}`;

// rettangolo di un segmento: x = lato (-1/+1), y = estremo (0 inizio, 1 fine)
const QUAD = [-1, 0, 0, 1, 0, 0, -1, 1, 0, -1, 1, 0, 1, 0, 0, 1, 1, 0];

export class ThickLine {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;
  private geo = new InstancedBufferGeometry();
  private buf: InstancedInterleavedBuffer;
  private data: Float32Array;
  /** numero di punti attualmente nella linea */
  count = 0;

  constructor(capacity: number, color: Color, opacity: number, widthCss = 1.3) {
    this.geo.setAttribute('position', new Float32BufferAttribute(QUAD, 3));
    this.data = new Float32Array(Math.max(2, capacity) * 4);
    this.buf = new InstancedInterleavedBuffer(this.data, 4, 1);
    this.bindAttributes();
    this.geo.instanceCount = 0;
    this.material = new ShaderMaterial({
      uniforms: {
        color: { value: color },
        opacity: { value: opacity },
        widthCss: { value: widthCss },
        glow: { value: 0 },
        hole: { value: new Vector4(0, 0, 0, 0) },
        resolution: LINE_SHARED.resolution,
        pxRatio: LINE_SHARED.pxRatio,
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      // il verso dei triangoli dipende dalla direzione del segmento sullo schermo
      side: DoubleSide,
    });
    this.mesh = new Mesh(this.geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;
  }

  private bindAttributes(): void {
    // ogni segmento legge il punto i (scostamento 0) e il punto i+1 (scostamento 4)
    this.geo.setAttribute('instanceStart', new InterleavedBufferAttribute(this.buf, 3, 0));
    this.geo.setAttribute('instanceAlphaStart', new InterleavedBufferAttribute(this.buf, 1, 3));
    this.geo.setAttribute('instanceEnd', new InterleavedBufferAttribute(this.buf, 3, 4));
    this.geo.setAttribute('instanceAlphaEnd', new InterleavedBufferAttribute(this.buf, 1, 7));
  }

  /** Sostituisce i punti: `pts` [x,y,z]*n, `alpha` n valori (oppure un valore fisso). */
  setPoints(pts: ArrayLike<number>, alpha: ArrayLike<number> | number, n: number): void {
    if (n * 4 > this.data.length) {
      this.data = new Float32Array(n * 4);
      this.buf = new InstancedInterleavedBuffer(this.data, 4, 1);
      this.bindAttributes();
    }
    const d = this.data;
    for (let i = 0; i < n; i++) {
      d[i * 4] = pts[i * 3];
      d[i * 4 + 1] = pts[i * 3 + 1];
      d[i * 4 + 2] = pts[i * 3 + 2];
      d[i * 4 + 3] = typeof alpha === 'number' ? alpha : alpha[i];
    }
    this.count = n;
    this.buf.needsUpdate = true;
    // l'ultimo segmento legge il punto n-1: n-1 segmenti
    this.geo.instanceCount = Math.max(0, n - 1);
  }

  /** Aggiorna solo le alfa (per esempio la scia di una sonda col passare del tempo). */
  setAlpha(alpha: ArrayLike<number>): void {
    const d = this.data;
    for (let i = 0; i < this.count; i++) d[i * 4 + 3] = alpha[i];
    this.buf.needsUpdate = true;
  }

  set opacity(v: number) {
    this.material.uniforms.opacity.value = v;
  }

  set width(css: number) {
    this.material.uniforms.widthCss.value = css;
  }

  set glow(v: number) {
    this.material.uniforms.glow.value = v;
  }

  /**
   * Buco attorno a un punto dello schermo (pixel fisici, origine in basso a sinistra come
   * gl_FragCoord): la linea sparisce entro r0 e torna piena a r1. Senza argomenti: niente buco.
   */
  setHole(cx = 0, cy = 0, r0 = 0, r1 = 0): void {
    (this.material.uniforms.hole.value as Vector4).set(cx, cy, r0, r1);
  }

  get visible(): boolean {
    return this.mesh.visible;
  }

  set visible(v: boolean) {
    this.mesh.visible = v;
  }

  dispose(): void {
    this.geo.dispose();
    this.material.dispose();
  }
}

/** Per i test: il buffer interleaved letto da un attributo. */
export function _attr(l: ThickLine, name: string): BufferAttribute | InterleavedBufferAttribute {
  return (l.mesh.geometry as InstancedBufferGeometry).getAttribute(name) as BufferAttribute | InterleavedBufferAttribute;
}
