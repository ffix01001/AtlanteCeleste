/**
 * Chioma e code di una cometa.
 *
 * Una cometa attiva ha due code distinte:
 *  - la coda di ioni (plasma): diritta, sempre opposta al Sole perché trascinata
 *    dal vento solare, sottile e azzurra (fluorescenza del CO+);
 *  - la coda di polveri: più larga, giallo-biancastra (luce solare riflessa),
 *    curva nel piano dell'orbita perché i granelli, spinti dalla pressione della
 *    luce, restano indietro rispetto al moto della cometa.
 * Lunghezza e luminosità crescono avvicinandosi al Sole (attività ~ 1/r²).
 *
 * Le code sono nastri sempre rivolti verso la camera, ricalcolati sulla CPU a
 * ogni fotogramma (poche decine di vertici). Quando la camera entra nella chioma
 * o si avvicina molto al nucleo, chioma e code si attenuano: dall'interno una
 * chioma è una nebbia tenue, non un muro di luce.
 */

import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Color, DoubleSide, Group, Mesh, PlaneGeometry, ShaderMaterial,
  Vector3,
} from 'three';
import type { Body } from '../sim/body';
import { M_ICRF_TO_SCENE as SCENE_FROM_ICRF } from '../core/frames';
import { AU_KM } from '../core/units';
import { glowMaterial } from './shaders';
import type { FrameCtx } from './bodyvisual';

const SEG = 48;

const RIBBON_V = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec2 st;        // s = lungo la coda (0 nucleo, 1 punta), t = attraverso (-1..1)
varying vec2 vSt;
void main() {
  vSt = st;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;

const RIBBON_F = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 color;
uniform float intensity;
uniform float sharp;      // 1 = profilo stretto (ioni), 0 = morbido (polveri)
varying vec2 vSt;
void main() {
  #include <logdepthbuf_fragment>
  float s = vSt.x;
  float t = vSt.y;
  float across = exp(-t * t * mix(2.2, 5.0, sharp));
  float along = pow(clamp(1.0 - s, 0.0, 1.0), mix(1.3, 0.9, sharp)) * smoothstep(0.0, 0.04, s + 0.01);
  // filamenti leggeri nella coda di ioni
  float fil = 1.0 + sharp * 0.35 * sin(t * 9.0 + s * 3.0) * (0.5 + 0.5 * sin(s * 17.0));
  gl_FragColor = vec4(color * across * along * fil * intensity, 1.0);
}`;

function ribbonMaterial(color: Color, sharp: number): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { color: { value: color }, intensity: { value: 1 }, sharp: { value: sharp } },
    vertexShader: RIBBON_V,
    fragmentShader: RIBBON_F,
    blending: AdditiveBlending,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
  });
}

class Ribbon {
  readonly mesh: Mesh;
  readonly mat: ShaderMaterial;
  private pos = new Float32Array((SEG + 1) * 2 * 3);

  constructor(color: Color, sharp: number) {
    const geo = new BufferGeometry();
    const st = new Float32Array((SEG + 1) * 2 * 2);
    const idx: number[] = [];
    for (let i = 0; i <= SEG; i++) {
      const s = i / SEG;
      st.set([s, -1, s, 1], i * 4);
      if (i < SEG) {
        const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
        idx.push(a, b, c, b, d, c);
      }
    }
    geo.setAttribute('position', new BufferAttribute(this.pos, 3));
    geo.setAttribute('st', new BufferAttribute(st, 2));
    geo.setIndex(idx);
    this.mat = ribbonMaterial(color, sharp);
    this.mesh = new Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
  }

  /**
   * points: centro della coda per s = 0..1 (relativo al nucleo), widths: larghezza piena.
   * toCam: direzione verso la camera (dal nucleo), per orientare il nastro.
   */
  set(points: Vector3[], widths: number[], toCam: Vector3): void {
    const t = new Vector3(), side = new Vector3();
    for (let i = 0; i <= SEG; i++) {
      const p = points[i];
      const q = points[Math.min(i + 1, SEG)];
      const o = points[Math.max(i - 1, 0)];
      t.subVectors(q, o).normalize();
      side.crossVectors(t, toCam);
      if (side.lengthSq() < 1e-12) side.set(0, 1, 0).cross(t);
      side.normalize().multiplyScalar(widths[i] / 2);
      this.pos[i * 6] = p.x - side.x;
      this.pos[i * 6 + 1] = p.y - side.y;
      this.pos[i * 6 + 2] = p.z - side.z;
      this.pos[i * 6 + 3] = p.x + side.x;
      this.pos[i * 6 + 4] = p.y + side.y;
      this.pos[i * 6 + 5] = p.z + side.z;
    }
    const attr = this.mesh.geometry.attributes.position as BufferAttribute;
    attr.needsUpdate = true;
    this.mesh.geometry.computeBoundingSphere();
  }
}

const _anti = new Vector3();
const _vel = new Vector3();
const _perp = new Vector3();
const _toCam = new Vector3();

export class CometVisual {
  readonly group = new Group();
  private coma: Mesh;
  private ion = new Ribbon(new Color(0.42, 0.66, 1.0), 1);
  private dust = new Ribbon(new Color(1.0, 0.9, 0.72), 0);
  private ionPts = Array.from({ length: SEG + 1 }, () => new Vector3());
  private dustPts = Array.from({ length: SEG + 1 }, () => new Vector3());
  private ionW = new Array<number>(SEG + 1).fill(0);
  private dustW = new Array<number>(SEG + 1).fill(0);
  /** attività attuale (0 = spenta, 1 = piena), utile al pannello informativo */
  activity = 0;

  constructor(private body: Body) {
    this.coma = new Mesh(new PlaneGeometry(2, 2), glowMaterial(new Color(0.62, 0.86, 0.95), 0.6));
    this.coma.renderOrder = 3;
    this.group.add(this.coma, this.ion.mesh, this.dust.mesh);
  }

  /** groupPos: posizione del nucleo relativa alla camera; distance: |groupPos|. */
  update(ctx: FrameCtx, groupPos: Vector3, distance: number): void {
    const b = this.body;
    const helio = _anti.subVectors(b.scenePos, ctx.sun.scenePos);
    const rKm = helio.length();
    const r = rKm / AU_KM;
    // l'attività si accende fra 5 e 1,5 UA (sublimazione di CO2 e poi dell'acqua)
    const act = b.data.inactive ? 0 : Math.max(0, Math.min(1, (5 - r) / 3.5));
    this.activity = act;
    this.group.visible = act > 0.01;
    if (!this.group.visible) return;
    helio.divideScalar(rKm); // direzione anti-solare
    _toCam.copy(groupPos).negate().normalize();

    // --- chioma: ~1e5 km, più estesa vicino al Sole
    const comaKm = 4e4 * act * (1 + 2 / Math.max(r, 0.3));
    const minVisual = (3 / ctx.pxPerRad) * distance; // almeno qualche pixel da lontano
    const comaR = Math.max(comaKm, minVisual);
    this.coma.scale.setScalar(comaR);
    this.coma.quaternion.copy(ctx.camera.quaternion);
    // dentro la chioma la luce si attenua (si vede il nucleo nella nebbia)
    const inside = Math.min(1, Math.max(0, (distance / comaKm - 0.08) / 0.6));
    (this.coma.material as ShaderMaterial).uniforms.intensity.value = 0.5 * act * inside;

    // --- code: lunghezze tipiche di decine di milioni di km vicino al Sole
    const boost = 1 / Math.max(r * r, 0.08);
    const lenIon = Math.min(1.5e8, 1.4e7 * boost) * act;
    const lenDust = Math.min(9e7, 0.9e7 * boost) * act;
    // velocità eliocentrica: la coda di polveri resta indietro rispetto al moto
    _vel.copy(b.vel).sub(ctx.sun.vel);
    if (_vel.lengthSq() === 0) _vel.set(1, 0, 0);
    // (le velocità sono in ICRF; la scena è solo ruotata: serve la direzione in scena)
    _vel.applyMatrix3(SCENE_FROM_ICRF);
    _perp.copy(_vel).addScaledVector(helio, -_vel.dot(helio));
    if (_perp.lengthSq() < 1e-12) _perp.set(0, 1, 0).cross(helio);
    _perp.normalize();
    for (let i = 0; i <= SEG; i++) {
      const s = i / SEG;
      this.ionPts[i].copy(helio).multiplyScalar(lenIon * s);
      this.ionW[i] = lenIon * (0.012 + 0.05 * s);
      // sindine approssimata: s lungo l'asse anti-solare, ritardo quadratico all'indietro
      this.dustPts[i].copy(helio).multiplyScalar(lenDust * s).addScaledVector(_perp, -0.55 * lenDust * s * s);
      this.dustW[i] = lenDust * (0.03 + 0.22 * s);
    }
    this.ion.set(this.ionPts, this.ionW, _toCam);
    this.dust.set(this.dustPts, this.dustW, _toCam);
    // vicinissimi al nucleo le code (viste di taglio o da dentro) si attenuano
    const near = Math.min(1, Math.max(0, (distance / Math.max(comaKm, 1) - 0.3) / 2));
    this.ion.mat.uniforms.intensity.value = 0.42 * act * near;
    this.dust.mat.uniforms.intensity.value = 0.5 * act * near;
  }
}
