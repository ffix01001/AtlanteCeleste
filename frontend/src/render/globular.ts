/**
 * Ammasso globulare disegnato stella per stella, per poterci entrare dentro.
 *
 * Le stelle seguono il profilo di Plummer (denso al centro, rado ai bordi), con il raggio
 * di metà luce misurato dell'ammasso. La popolazione è quella tipica di un ammasso antico:
 * tantissime nane gialle e arancioni deboli, qualche gigante rossa brillante e le stelle
 * azzurre del "ramo orizzontale". Il generatore è deterministico: lo stesso ammasso ha sempre
 * le stesse stelle.
 *
 * Coordinate in parsec rispetto al centro: il gruppo dell'oggetto le scala in km.
 */

import { AdditiveBlending, BufferAttribute, BufferGeometry, Points, ShaderMaterial } from 'three';
import { PC_KM } from '../core/units';

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 color;
attribute float lum;
uniform float pxPerRad;
uniform float pxScale;
uniform float intensity;
uniform float halo;     // parsec
varying vec3 vColor;
varying float vA;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  // alone di ogni stella: \`halo\` parsec visti dalla sua distanza vera. La scena lontana è
  // rimpicciolita (scala del gruppo): le distanze si misurano nella stessa scala.
  // Sotto il pixel e mezzo si conserva il flusso.
  float kmPerPc = length(modelMatrix[0].xyz);
  float dist = max(length(mv.xyz), 1e-6);
  float px = min(halo * kmPerPc / dist * pxPerRad, 14.0);
  float a = lum;
  if (px < 1.5) { a *= (px * px) / 2.25; px = 1.5; }
  vA = a * intensity;
  vColor = color;
  gl_PointSize = vA > 0.0004 ? px * pxScale : 0.0;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}`;

const FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vColor;
varying float vA;
void main() {
  #include <logdepthbuf_fragment>
  vec2 c = gl_PointCoord - 0.5;
  float r2 = dot(c, c) * 4.0;
  if (r2 > 1.0) discard;
  float g = exp(-r2 * 5.0);
  gl_FragColor = vec4(vColor * g * min(vA, 1.2), 1.0);
}`;

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** Popolazione di un ammasso antico: [frazione, colore lineare, luminosità relativa] */
const POPULATION: [number, [number, number, number], number][] = [
  [0.015, [1.0, 0.42, 0.16], 1.0],   // giganti rosse
  [0.03, [0.55, 0.66, 1.0], 0.55],   // ramo orizzontale (azzurre)
  [0.08, [1.0, 0.78, 0.5], 0.22],    // subgiganti e punto di svolta
  [1.0, [1.0, 0.7, 0.45], 0.05],     // nane gialle e arancioni
];

/**
 * Ammasso stellare nucleare attorno a Sagittarius A*: soprattutto giganti rosse e stelle
 * antiche, ma anche stelle giovanissime e azzurre (le stelle S, le supergiganti dei dischi
 * di stelle giovani). Tutto appare più arrossato: la luce attraversa molta polvere.
 */
const POPULATION_NSC: [number, [number, number, number], number][] = [
  [0.03, [1.0, 0.36, 0.12], 1.0],    // giganti rosse
  [0.012, [0.62, 0.72, 1.0], 1.6],   // giovani supergiganti azzurre
  [0.1, [1.0, 0.62, 0.36], 0.25],
  [1.0, [1.0, 0.58, 0.34], 0.06],
];

export class GlobularCluster {
  readonly points: Points;
  private mat: ShaderMaterial;
  private rhPc: number;
  /** alone delle stelle viste da dentro (parsec): le stelle disegnate sono poche rispetto a
   *  quelle vere (decine di migliaia contro milioni), e ognuna ha un alone più grande di una
   *  stella vera. Nell'ammasso nucleare, densissimo, basta piccolo; nei globulari serve più grande */
  private haloIn: number;
  /** luminosità vista da dentro (gli ammassi globulari sono più radi: un po' più di luce) */
  private gainIn: number;

  constructor(rhPc: number, count: number, seed: number, kind: 'antico' | 'nucleare' = 'antico') {
    const pop = kind === 'nucleare' ? POPULATION_NSC : POPULATION;
    this.rhPc = rhPc;
    this.haloIn = kind === 'nucleare' ? 0.013 : 0.12;
    this.gainIn = kind === 'nucleare' ? 1 : 2.5;
    const rand = rng(seed * 2654435761);
    const a = rhPc / 1.305; // raggio di Plummer
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const lum = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      // raggio dalla distribuzione cumulativa di Plummer, tagliato a 15 a
      let r = 0;
      do {
        const u = Math.max(rand(), 1e-9);
        r = a / Math.sqrt(Math.pow(u, -2 / 3) - 1);
      } while (r > 15 * a);
      const z = rand() * 2 - 1;
      const t = rand() * Math.PI * 2;
      const s = Math.sqrt(1 - z * z);
      pos[i * 3] = r * s * Math.cos(t);
      pos[i * 3 + 1] = r * s * Math.sin(t);
      pos[i * 3 + 2] = r * z;
      const p = rand();
      let acc = 0;
      for (const [frac, c, l] of pop) {
        acc += frac;
        if (p <= acc) {
          const v = 0.85 + 0.3 * rand();
          col.set(c, i * 3);
          lum[i] = l * v;
          break;
        }
      }
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('color', new BufferAttribute(col, 3));
    g.setAttribute('lum', new BufferAttribute(lum, 1));
    this.mat = new ShaderMaterial({
      uniforms: { pxPerRad: { value: 1000 }, pxScale: { value: 1 }, intensity: { value: 1 }, halo: { value: 0.05 } },
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
  }

  /**
   * `rhPx`: raggio di metà luce dell'ammasso sullo schermo (pixel CSS).
   * Da fuori, decine di migliaia di stelle si sommano negli stessi pixel del nucleo: senza
   * correzione il centro diventa una macchia bianca bruciata e il bagliore la allarga ancora.
   * Quando l'ammasso è piccolo sullo schermo la luce di ogni stella si attenua in proporzione
   * all'affollamento (la luminosità del nucleo resta quella di un ammasso vero, non un faro);
   * da dentro, dove le stelle sono separate, si vedono con la loro luce piena.
   */
  update(pxPerRad: number, pxScale: number, intensity: number, rhPx = 1e9, inside = 0): void {
    this.mat.uniforms.pxPerRad.value = pxPerRad;
    this.mat.uniforms.pxScale.value = pxScale;
    // da fuori: tutte le stelle con lo stesso alone sullo schermo (fino a 14 px); la luce totale cala
    // con il quadrato della distanza (prima un minimo fisso faceva restare gli ammassi lontanissimi
    // dei fari bianchi), e quando l'ammasso è più piccolo dell'alone anche l'alone si rimpicciolisce
    const crowd = Math.min(1, (rhPx / 130) ** 2);
    const starPx = Math.min(14, Math.max(1.5, rhPx));
    const dPc = (this.rhPc * pxPerRad) / Math.max(rhPx, 1e-9);
    const haloOut = (starPx * dPc) / pxPerRad;
    // entrando si passa con continuità all'alone "da dentro", dove conta la distanza di ogni stella
    this.mat.uniforms.halo.value = haloOut + (this.haloIn - haloOut) * inside;
    this.mat.uniforms.intensity.value = intensity * 0.3 * (crowd * (14 / starPx) ** 2 * (1 - inside) + this.gainIn * inside);
    this.points.visible = intensity > 0.002;
  }
}
