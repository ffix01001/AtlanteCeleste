/**
 * Il cielo visto da terra: suolo e orizzonte, luce del giorno e del crepuscolo, punti cardinali
 * e i pianeti come "stelle" luminose.
 *
 * La camera sta nel luogo dell'osservatore (vedi CameraRig.startGround). Qui si disegna ciò che
 * dallo spazio non esiste:
 *   - il suolo: una mezza sfera scura sotto l'orizzonte, che nasconde tutto ciò che è tramontato;
 *   - il cielo diurno: un velo azzurro che copre le stelle quando il Sole è alto e sfuma al
 *     crepuscolo (si può spegnere, per vedere le stelle anche di giorno);
 *   - i pianeti a occhio nudo: da terra sono punti più piccoli di un pixel, quindi si disegnano
 *     come le stelle, con la luminosità della loro magnitudine apparente.
 */

import {
  AdditiveBlending, BackSide, BufferAttribute, BufferGeometry, Color, Group, Mesh, PerspectiveCamera, Points, ShaderMaterial,
  SphereGeometry, Vector3,
} from 'three';
import type { Body } from '../sim/body';
import { AU_KM } from '../core/units';
import type { CameraRig } from './camera';

const GROUND_V = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vDir;
void main() {
  vDir = mat3(modelMatrix) * position;
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;

const GROUND_F = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 up;
uniform float day;
varying vec3 vDir;
void main() {
  #include <logdepthbuf_fragment>
  float h = dot(normalize(vDir), up);
  // appena sotto l'orizzonte un filo di foschia, poi il suolo scuro
  float haze = exp(h * 30.0);
  vec3 night = vec3(0.004, 0.005, 0.007) + vec3(0.010, 0.013, 0.020) * haze;
  vec3 dayc = vec3(0.045, 0.055, 0.040) + vec3(0.20, 0.26, 0.32) * haze;
  gl_FragColor = vec4(mix(night, dayc, day), 1.0);
}`;

const SKY_F = /* glsl */ `
#include <common>
uniform vec3 up;
uniform vec3 sunDir;
uniform float strength;
varying vec3 vDir;
void main() {
  // sfondo: dietro a tutto (Luna e Sole restano davanti), ma sopra le stelle
  gl_FragDepth = 0.9999998;
  vec3 d = normalize(vDir);
  float h = dot(d, up);
  float sunAlt = dot(sunDir, up);
  // pieno giorno sopra l'orizzonte, buio alla fine del crepuscolo civile e oltre
  float day = smoothstep(-0.14, 0.06, sunAlt);
  float bright = 0.18 + 0.82 * smoothstep(-0.05, 0.35, sunAlt);
  vec3 zenith = vec3(0.07, 0.20, 0.52);
  vec3 horizon = vec3(0.42, 0.58, 0.80);
  vec3 sky = mix(horizon, zenith, pow(clamp(h, 0.0, 1.0), 0.42)) * bright;
  // alba e tramonto: arancio basso sull'orizzonte, dalla parte del Sole
  float tw = smoothstep(-0.30, -0.02, sunAlt) * (1.0 - smoothstep(0.02, 0.30, sunAlt));
  vec3 dh = normalize(d - up * h + 1e-5);
  vec3 sh = normalize(sunDir - up * sunAlt + 1e-5);
  float toward = pow(max(dot(dh, sh), 0.0), 2.5);
  float low = exp(-max(h, 0.0) * 5.0);
  vec3 glow = vec3(1.0, 0.42, 0.12) * tw * toward * low;
  // alone attorno al Sole
  float aur = pow(max(dot(d, sunDir), 0.0), 24.0) * 0.35 * day;
  vec3 col = sky * day + glow * 0.9 + vec3(1.0, 0.92, 0.78) * aur;
  float a = max(day * 0.985, clamp(tw * toward * low * 1.1, 0.0, 0.9));
  gl_FragColor = vec4(col, a * strength);
}`;

const PT_V = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float size;
attribute vec3 tint;
uniform float pxScale;
varying vec3 vTint;
void main() {
  vTint = tint;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = size * pxScale;
  #include <logdepthbuf_vertex>
}`;

const PT_F = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vTint;
void main() {
  #include <logdepthbuf_fragment>
  vec2 c = gl_PointCoord - 0.5;
  float r2 = dot(c, c) * 4.0;
  if (r2 > 1.0) discard;
  float core = exp(-r2 * 6.0);
  gl_FragColor = vec4(vTint * (core * 1.6 + 0.25 * (1.0 - r2)), 1.0);
}`;

/** Magnitudine assoluta H dei pianeti (a 1 UA dal Sole e dalla Terra, fase piena) e colore. */
const PLANETS: Record<string, [number, string]> = {
  'naif:199': [-0.6, '#d9d2c8'], 'naif:299': [-4.4, '#fff6dc'], 'naif:499': [-1.5, '#ffb38a'],
  'naif:599': [-9.4, '#fff0d0'], 'naif:699': [-8.9, '#f3e3b0'], 'naif:799': [-7.2, '#bfeeee'], 'naif:899': [-6.9, '#9db8ff'],
};

const CARDINALS: [string, number][] = [['N', 0], ['NE', 45], ['E', 90], ['SE', 135], ['S', 180], ['SO', 225], ['O', 270], ['NO', 315]];
const _d = new Vector3();
const _s = new Vector3();

export class GroundView {
  readonly group = new Group();
  private ground: Mesh;
  private sky: Mesh;
  private points: Points;
  private marks: HTMLDivElement[] = [];
  /** cielo azzurro di giorno (true) o stelle sempre visibili (false) */
  daylight = true;
  /** altezza del Sole sull'orizzonte, in gradi (per il riquadro) */
  sunAltDeg = 0;

  constructor(parent: HTMLElement) {
    this.ground = new Mesh(
      new SphereGeometry(1, 64, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
      new ShaderMaterial({ uniforms: { up: { value: new Vector3(0, 1, 0) }, day: { value: 0 } }, vertexShader: GROUND_V, fragmentShader: GROUND_F, side: BackSide }),
    );
    // cinquanta metri: più vicino di qualsiasi cosa in cielo, satelliti compresi
    this.ground.scale.setScalar(0.05);
    this.ground.frustumCulled = false;
    this.sky = new Mesh(
      new SphereGeometry(1, 48, 24),
      new ShaderMaterial({
        uniforms: { up: { value: new Vector3(0, 1, 0) }, sunDir: { value: new Vector3(1, 0, 0) }, strength: { value: 1 } },
        vertexShader: /* glsl */ `varying vec3 vDir; void main() { vDir = mat3(modelMatrix) * position; gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0); }`,
        fragmentShader: SKY_F, side: BackSide, transparent: true, depthWrite: false, depthTest: true,
      }),
    );
    this.sky.scale.setScalar(1000);
    this.sky.frustumCulled = false;
    // dopo stelle, corpi minori e satelliti (che di giorno spariscono), prima di orbite e bagliori
    this.sky.renderOrder = -3;
    const ids = Object.keys(PLANETS);
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(ids.length * 3), 3));
    geo.setAttribute('size', new BufferAttribute(new Float32Array(ids.length), 1));
    geo.setAttribute('tint', new BufferAttribute(Float32Array.from(ids.flatMap((id) => new Color(PLANETS[id][1]).toArray())), 3));
    this.points = new Points(geo, new ShaderMaterial({
      uniforms: { pxScale: { value: 1 } }, vertexShader: PT_V, fragmentShader: PT_F,
      blending: AdditiveBlending, transparent: true, depthWrite: false,
    }));
    this.points.frustumCulled = false;
    this.points.renderOrder = -8;
    this.group.add(this.ground, this.sky, this.points);
    this.group.visible = false;
    for (const [name] of CARDINALS) {
      const el = document.createElement('div');
      el.className = `cardinal${name.length === 1 ? ' main' : ''}`;
      el.textContent = name;
      el.hidden = true;
      parent.appendChild(el);
      this.marks.push(el);
    }
  }

  /** Il punto della scena è sopra l'orizzonte dell'osservatore? */
  static above(rig: CameraRig, scenePos: Vector3): boolean {
    return _d.subVectors(scenePos, rig.camPos).dot(rig.groundUp) > 0;
  }

  update(
    on: boolean, rig: CameraRig, camera: PerspectiveCamera, sun: Body, earth: Body, bodies: (id: string) => Body | undefined,
    pxScale: number, w: number, h: number,
  ): void {
    this.group.visible = on;
    if (!on) {
      for (const m of this.marks) m.hidden = true;
      return;
    }
    const up = rig.groundUp;
    this.ground.quaternion.setFromUnitVectors(_d.set(0, 1, 0), up);
    _s.subVectors(sun.scenePos, rig.camPos).normalize();
    const sunAlt = _s.dot(up);
    this.sunAltDeg = (Math.asin(Math.max(-1, Math.min(1, sunAlt))) * 180) / Math.PI;
    const day = this.daylight ? Math.min(1, Math.max(0, (sunAlt + 0.14) / 0.2)) : 0;
    const gu = (this.ground.material as ShaderMaterial).uniforms;
    gu.up.value.copy(up);
    gu.day.value = day;
    const su = (this.sky.material as ShaderMaterial).uniforms;
    su.up.value.copy(up);
    su.sunDir.value.copy(_s);
    this.sky.visible = this.daylight;

    // pianeti: magnitudine apparente da distanza dal Sole e dalla Terra (la fase si trascura)
    const pos = this.points.geometry.getAttribute('position') as BufferAttribute;
    const size = this.points.geometry.getAttribute('size') as BufferAttribute;
    let i = 0;
    for (const id of Object.keys(PLANETS)) {
      const b = bodies(id);
      let s = 0;
      if (b?.valid) {
        _d.subVectors(b.scenePos, rig.camPos);
        const delta = _d.length() / AU_KM, r = b.scenePos.distanceTo(sun.scenePos) / AU_KM;
        const mag = PLANETS[id][0] + 5 * Math.log10(Math.max(r * delta, 1e-6));
        // come le stelle più brillanti: da 1,5 pixel (magnitudine 6) a 9 (Venere)
        s = mag < 6.5 ? Math.min(9, Math.max(1.5, 3.2 - 1.15 * mag)) : 0;
        // quando il disco del pianeta si vede davvero (ingrandendo), il punto lascia il posto al disco
        const px = (b.radius / Math.max(_d.length(), 1)) * (h / 2 / Math.tan((camera.fov * Math.PI) / 360));
        if (px > 1.2) s = 0;
        // messo a distanza fissa nella sua direzione: nessun problema di precisione
        _d.normalize().multiplyScalar(1e6);
        pos.setXYZ(i, _d.x, _d.y, _d.z);
      }
      size.setX(i, s);
      i++;
    }
    pos.needsUpdate = size.needsUpdate = true;
    (this.points.material as ShaderMaterial).uniforms.pxScale.value = pxScale;
    void earth;

    // punti cardinali sull'orizzonte
    CARDINALS.forEach(([, az], k) => {
      const a = (az * Math.PI) / 180;
      _d.copy(rig.groundNorth).multiplyScalar(Math.cos(a)).addScaledVector(rig.groundEast, Math.sin(a));
      _d.applyMatrix4(camera.matrixWorldInverse);
      const el = this.marks[k];
      if (_d.z >= -1e-3) { el.hidden = true; return; }
      _d.applyMatrix4(camera.projectionMatrix);
      const x = (_d.x * 0.5 + 0.5) * w, y = (-_d.y * 0.5 + 0.5) * h;
      el.hidden = x < -30 || x > w + 30 || y < -30 || y > h + 30;
      if (!el.hidden) el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
    });
  }
}
