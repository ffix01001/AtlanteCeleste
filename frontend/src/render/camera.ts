/**
 * Camera con "origine mobile", in due modalità.
 *
 * - Orbita: la camera ruota attorno a un bersaglio (un corpo) a una certa distanza.
 * - Volo libero: la camera si muove come un'astronave (W A S D, Q/E, mouse per guardarsi
 *   intorno). La velocità dipende dalla distanza dalla superficie più vicina, così si può
 *   sfiorare un asteroide e un attimo dopo attraversare la Galassia. La posizione è tenuta
 *   rispetto al corpo più vicino (l'"ancora"): se la Terra corre lungo l'orbita, la camera
 *   la segue e non resta indietro.
 *
 * La posizione è tenuta in doppia precisione sulla CPU; alla GPU arrivano solo coordinate
 * relative alla camera, così non si perde precisione né sulla superficie di un asteroide
 * né ai confini del Sistema Solare.
 */

import { DEEP_KINDS } from '../data/types';
import { Matrix4, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import type { Body } from '../sim/body';
import { AU_KM } from '../core/units';
import { M_ICRF_TO_SCENE } from '../core/frames';
import { cruiseSpeed, flightDuration, follow, smoother, zoomPath, type ZoomPath } from './camerapath';

export type CamMode = 'orbit' | 'free' | 'ground';

/** Dove si trova l'osservatore sulla superficie (gradi, metri). */
export interface GroundSpot { lat: number; lon: number; elev?: number }

interface Flight {
  from: Body;
  fromOffset: Vector3;   // punto osservato all'inizio, relativo al corpo di partenza
  to: Body;
  path: ZoomPath;
  d1: number;
  az0: number;
  az1: number;
  el0: number;
  el1: number;
  t: number;             // avanzamento 0..1
  dur: number;           // secondi
  zoom: number;          // zoom chiesto con la rotella durante il volo (moltiplica la distanza)
  zoomCur: number;
  dAz: number;           // rotazioni fatte con il mouse durante il volo
  dEl: number;
}

/** Tasti del volo libero (posizione fisica del tasto, vale con ogni tastiera) → asse e verso. */
const MOVE_KEYS: Record<string, [0 | 1 | 2, 1 | -1]> = {
  KeyW: [2, -1], ArrowUp: [2, -1],
  KeyS: [2, 1], ArrowDown: [2, 1],
  KeyA: [0, -1], ArrowLeft: [0, -1],
  KeyD: [0, 1], ArrowRight: [0, 1],
  KeyE: [1, 1], KeyQ: [1, -1],
};
const ROLL_KEYS: Record<string, 1 | -1> = { KeyZ: 1, KeyC: -1 };
/** tipi di corpo a cui la camera libera si "aggancia" quando ci passa vicino */
const ANCHOR_KINDS = new Set(['star', 'planet', 'dwarf', 'moon', 'asteroid', 'comet', 'spacecraft', 'blackhole']);
/** oggetti estesi in cui si entra: non fermano la camera */
const ENTERABLE = new Set(['galaxy', 'nebula', 'cluster', 'arm']);

interface FlightState { look: Vector3; dist: number; az: number; el: number }

const _q = new Quaternion();
const _v = new Vector3();
const _w = new Vector3();
const _g = new Vector3();
const _m = new Matrix4();
const X = new Vector3(1, 0, 0);
const Y = new Vector3(0, 1, 0);
const Z = new Vector3(0, 0, 1);

export class CameraRig {
  target: Body;
  distance: number;
  private goalDistance: number;
  az = 0.6;
  el = 0.35;
  /** velocità di rotazione (radianti ogni 1/60 di secondo) */
  private vAz = 0;
  private vEl = 0;
  /** posizione della camera e punto osservato (scena, km rispetto al baricentro) */
  readonly camPos = new Vector3();
  readonly lookPos = new Vector3();
  private flight: Flight | null = null;
  /** volo precedente, se si è cambiata destinazione a metà strada: sfuma nel nuovo */
  private prevFlight: Flight | null = null;
  private xfade = 1;
  private readonly st0: FlightState = { look: new Vector3(), dist: 1, az: 0, el: 0 };
  private readonly st1: FlightState = { look: new Vector3(), dist: 1, az: 0, el: 0 };
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private pinchDist = 0;
  onUserInput: () => void = () => {};
  onModeChange: (mode: CamMode) => void = () => {};

  // ---- volo libero
  mode: CamMode = 'orbit';
  /** corpi da considerare per la velocità, l'aggancio e gli urti */
  bodies: () => Iterable<Body> = () => [];
  /** moltiplicatore di velocità scelto con + e − */
  speedMul = 1;
  /** velocità attuale (km/s) e distanza dalla superficie più vicina (km), per il riquadro */
  speedKmS = 0;
  gapKm = 0;
  private readonly freeQuat = new Quaternion();
  private readonly freeOffset = new Vector3();   // camera rispetto all'ancora (this.target)
  private readonly vNorm = new Vector3();         // velocità nel riferimento della camera, in "distanze dalla superficie al secondo"
  private keys = new Set<string>();
  private rollVel = 0;
  private yawVel = 0;
  private pitchVel = 0;
  /** passaggio morbido dell'orientamento (cambio di modalità) */
  private blend: { from: Quaternion; t: number; dur: number } | null = null;

  // ---- cielo visto da terra
  /** luogo dell'osservatore (si può cambiare mentre si guarda) */
  groundSpot: GroundSpot = { lat: 0, lon: 0 };
  /** direzione dello sguardo: azimut da nord verso est e altezza sull'orizzonte (radianti) */
  gAz = Math.PI;
  gAlt = 0.35;
  private gAzGoal: number | null = null;
  private gAltGoal = 0;
  /** assi del luogo nella scena: zenit, nord ed est (aggiornati a ogni fotogramma) */
  readonly groundUp = new Vector3(0, 1, 0);
  readonly groundNorth = new Vector3(0, 0, -1);
  readonly groundEast = new Vector3(1, 0, 0);
  /** campo visivo verticale desiderato (gradi): da terra la rotella ingrandisce come un binocolo */
  private fovGoal = 50;

  constructor(readonly camera: PerspectiveCamera, private dom: HTMLElement, target: Body, distance: number) {
    this.target = target;
    this.distance = this.goalDistance = distance;
    this.bindInput();
  }

  get flying(): boolean {
    return this.flight !== null;
  }

  minDistance(b: Body = this.target): number {
    // nelle galassie, nei bracci e nelle nebulose si può entrare
    if (ENTERABLE.has(b.kind)) return b.radius * 0.001;
    // sonde con il modello 3D: ci si avvicina fino a sfiorarlo
    const model = b.extra.modelRadiusKm as number | undefined;
    if (model) return model * 1.3;
    if (b.radius > 0) return b.radius * 1.12 + 0.01;
    return 0.05;
  }

  /** Quanto vicino si può arrivare in volo libero (più che in orbita: si sfiora la superficie). */
  private freeMin(b: Body): number {
    const model = b.extra.modelRadiusKm as number | undefined;
    if (model) return model * 1.1;
    if (b.radius > 0) return b.radius * 1.0015 + 0.005;
    return 0.02;
  }

  /** Distanza "comoda" per inquadrare un corpo. */
  static framingDistance(b: Body): number {
    if (b.kind === 'barycenter') return 8 * AU_KM;
    if (b.kind === 'galaxy') return b.radius * (b.id === 'gal:mw' ? 2.6 : 3.2);
    if (b.kind === 'blackhole') return b.radius * 22; // l'ombra e l'anello di luce
    if (b.kind === 'nebula' || b.kind === 'cluster') return b.radius * 4;
    if (b.kind === 'arm') return b.radius * 9;
    // con il modello 3D si arriva abbastanza vicino da vederlo bene
    const model = b.extra.modelRadiusKm as number | undefined;
    if (model) return model * 3.1;
    if (b.kind === 'spacecraft') return 2e6;
    if (b.kind === 'satellite') return 2.2e4;
    if (b.radius <= 0) return 1e5;
    const k = b.kind === 'star' ? 8 : b.radius < 50 ? 12 : 4.2;
    return b.radius * k;
  }

  // ------------------------------------------------------------------ cambi di modalità

  /**
   * Cielo visto da terra: la camera si mette nel luogo dell'osservatore, sulla superficie del
   * corpo (la Terra), e guarda il cielo. Si gira lo sguardo trascinando; la rotella ingrandisce.
   */
  startGround(body: Body, spot: GroundSpot): void {
    this.flight = this.prevFlight = null;
    this.blend = null;
    this.vAz = this.vEl = 0;
    this.keys.clear();
    this.target = body;
    this.groundSpot = spot;
    this.gAz = Math.PI; // verso sud, dove passano Sole, Luna e pianeti (dall'emisfero nord)
    this.gAlt = 0.35;
    this.gAzGoal = null;
    this.fovGoal = 60;
    const was = this.mode;
    this.mode = 'ground';
    if (was !== 'ground') this.onModeChange('ground');
  }

  /** Lascia il suolo e torna a girare attorno al corpo, allontanandosi con calma. */
  leaveGround(): void {
    if (this.mode !== 'ground') return;
    this.fovGoal = 50;
    this.startOrbit(this.target);
    this.goalDistance = CameraRig.framingDistance(this.target);
  }

  /** Da terra: gira lo sguardo verso un punto della scena (un corpo). False se è sotto l'orizzonte. */
  groundLookAt(scenePos: Vector3): boolean {
    const d = _v.subVectors(scenePos, this.camPos);
    if (d.lengthSq() === 0) return false;
    d.normalize();
    const alt = Math.asin(Math.max(-1, Math.min(1, d.dot(this.groundUp))));
    this.gAzGoal = Math.atan2(d.dot(this.groundEast), d.dot(this.groundNorth));
    this.gAltGoal = Math.max(-0.1, Math.min(1.5, alt));
    return alt > 0;
  }

  /** Campo visivo verticale attuale, in gradi. */
  get fov(): number {
    return this.camera.fov;
  }

  private updateGround(dt: number): void {
    const b = this.target;
    const D = Math.PI / 180;
    const la = this.groundSpot.lat * D, lo = this.groundSpot.lon * D;
    const cl = Math.cos(la), sl = Math.sin(la), co = Math.cos(lo), so = Math.sin(lo);
    // ellissoide del corpo: la verticale del luogo non passa per il centro
    const a = b.radii[0] || b.radius, c = b.radii[2] || b.radius;
    const e2 = 1 - (c * c) / (a * a);
    const N = a / Math.sqrt(1 - e2 * sl * sl);
    const h = (this.groundSpot.elev ?? 0) / 1000 + 0.002; // gli occhi a due metri dal suolo
    const toScene = (v: Vector3) => v.applyMatrix3(b.orient).applyMatrix3(M_ICRF_TO_SCENE);
    toScene(this.groundUp.set(cl * co, cl * so, sl)).normalize();
    toScene(this.groundNorth.set(-sl * co, -sl * so, cl)).normalize();
    toScene(this.groundEast.set(-so, co, 0)).normalize();
    toScene(this.camPos.set((N + h) * cl * co, (N + h) * cl * so, (N * (1 - e2) + h) * sl)).add(b.scenePos);
    // sguardo che si gira con calma verso un corpo scelto
    if (this.gAzGoal !== null) {
      let dAz = this.gAzGoal - this.gAz;
      while (dAz > Math.PI) dAz -= 2 * Math.PI;
      while (dAz < -Math.PI) dAz += 2 * Math.PI;
      const k = 1 - Math.exp(-dt / 0.35);
      this.gAz += dAz * k;
      this.gAlt += (this.gAltGoal - this.gAlt) * k;
      if (Math.abs(dAz) + Math.abs(this.gAltGoal - this.gAlt) < 1e-4) this.gAzGoal = null;
    }
    this.gAlt = Math.max(-0.35, Math.min(1.553, this.gAlt));
    const ca = Math.cos(this.gAlt), sa = Math.sin(this.gAlt), cz = Math.cos(this.gAz), sz = Math.sin(this.gAz);
    const dir = _v.copy(this.groundNorth).multiplyScalar(ca * cz).addScaledVector(this.groundEast, ca * sz).addScaledVector(this.groundUp, sa);
    const right = _w.copy(this.groundNorth).multiplyScalar(-sz).addScaledVector(this.groundEast, cz);
    const up = _g.copy(this.groundNorth).multiplyScalar(-sa * cz).addScaledVector(this.groundEast, -sa * sz).addScaledVector(this.groundUp, ca);
    this.lookPos.copy(this.camPos).add(dir);
    this.camera.quaternion.setFromRotationMatrix(_m.makeBasis(right, up, dir.negate()));
    this.distance = this.goalDistance = Math.max(this.camPos.distanceTo(b.scenePos), 1);
    this.speedKmS = 0;
  }

  /** Passa al volo libero restando esattamente dove si è, con lo stesso sguardo. */
  startFree(): void {
    if (this.mode === 'free') return;
    if (this.mode === 'ground') this.fovGoal = 50;
    this.flight = this.prevFlight = null;
    this.blend = null;
    this.freeQuat.copy(this.camera.quaternion);
    this.freeOffset.subVectors(this.camPos, this.target.scenePos);
    this.vNorm.set(0, 0, 0);
    this.keys.clear();
    this.yawVel = this.pitchVel = this.rollVel = 0;
    this.vAz = this.vEl = 0;
    this.mode = 'free';
    this.onModeChange('free');
  }

  /**
   * Torna all'orbita attorno a un corpo, dalla posizione attuale: lo sguardo ruota con calma
   * verso il corpo invece di scattare.
   */
  startOrbit(b: Body = this.target): void {
    const wasFree = this.mode !== 'orbit';
    const q = this.camera.quaternion.clone();
    this.mode = 'orbit';
    this.flight = this.prevFlight = null;
    this.target = b;
    const off = _v.subVectors(this.camPos, b.scenePos);
    const d = Math.max(off.length(), this.minDistance(b));
    if (off.lengthSq() > 0) {
      this.az = Math.atan2(off.z, off.x);
      this.el = Math.asin(Math.max(-0.9999, Math.min(0.9999, off.y / off.length())));
    }
    this.distance = this.goalDistance = d;
    this.vAz = this.vEl = 0;
    this.blend = { from: q, t: 0, dur: 0.9 };
    if (wasFree) this.onModeChange('orbit');
  }

  /**
   * Dal volo libero a un volo verso un corpo: lo stato dell'orbita viene costruito in modo che
   * il primo fotogramma sia identico a quello attuale (il punto osservato sta davanti alla camera).
   */
  private freeToOrbitLooking(b: Body): void {
    const q = this.camera.quaternion.clone();
    const fwd = _v.set(0, 0, -1).applyQuaternion(q);
    const D = Math.max(b.scenePos.distanceTo(this.camPos), 1e-3);
    this.lookPos.copy(this.camPos).addScaledVector(fwd, D);
    this.distance = this.goalDistance = D;
    this.az = Math.atan2(-fwd.z, -fwd.x);
    this.el = Math.asin(Math.max(-0.9999, Math.min(0.9999, -fwd.y)));
    this.mode = 'orbit';
    this.vAz = this.vEl = 0;
    // l'eventuale rollio del volo libero si raddrizza nella prima parte del viaggio
    this.blend = { from: q, t: 0, dur: 0.7 };
    this.onModeChange('orbit');
  }

  flyTo(b: Body, distance = CameraRig.framingDistance(b), sunScenePos?: Vector3): void {
    if (this.mode === 'ground') this.leaveGround();
    if (this.mode === 'free') this.freeToOrbitLooking(b);
    const fromOffset = this.lookPos.clone().sub(this.target.scenePos);
    const u1 = b.scenePos.distanceTo(this.lookPos);
    const d0 = Math.max(this.distance, 1e-6);
    const d1 = Math.max(distance, this.minDistance(b));
    // si arriva dal lato illuminato dal Sole (angolo di fase di circa 50°)
    let az1 = this.az, el1 = this.el;
    if (sunScenePos && b.kind !== 'star' && b.kind !== 'barycenter') {
      const toSun = sunScenePos.clone().sub(b.scenePos);
      if (toSun.lengthSq() > 0) {
        const sunAz = Math.atan2(toSun.z, toSun.x);
        if (DEEP_KINDS.has(b.kind) && b.kind !== 'arm' && b.id !== 'gal:mw') {
          // nebulose, ammassi, galassie: si arriva dalla parte del Sole, cioè come li vediamo dalla Terra
          az1 = sunAz;
          el1 = Math.asin(Math.max(-0.999, Math.min(0.999, toSun.y / toSun.length())));
        } else {
          // di solito con un angolo di fase di circa 50°; alcune sonde si guardano meglio di lato
          const ap = b.extra.approach as { phase: number; elev: number } | undefined;
          az1 = sunAz - (ap?.phase ?? 0.85);
          el1 = ap?.elev ?? 0.32;
        }
      }
    }
    // percorso angolare più breve
    while (az1 - this.az > Math.PI) az1 -= 2 * Math.PI;
    while (az1 - this.az < -Math.PI) az1 += 2 * Math.PI;
    // cambio di destinazione a metà volo: il volo vecchio continua ancora un attimo e sfuma
    // nel nuovo, così la camera non frena di colpo
    this.prevFlight = this.flight && this.flight.t < 1 ? this.flight : null;
    this.xfade = this.prevFlight ? 0 : 1;
    const path = zoomPath(u1, d0, d1);
    // più si gira attorno al corpo, più tempo serve per non far girare la testa
    const turn = Math.hypot(az1 - this.az, el1 - this.el);
    this.flight = {
      from: this.target, fromOffset, to: b, path, d1, az0: this.az, az1, el0: this.el, el1,
      t: 0, dur: flightDuration(path.S + turn * 0.8), zoom: 1, zoomCur: 1, dAz: 0, dEl: 0,
    };
    this.target = b;
    this.goalDistance = d1;
  }

  /** Cambia bersaglio senza animazione. */
  jumpTo(b: Body, distance = CameraRig.framingDistance(b)): void {
    this.flight = this.prevFlight = null;
    this.blend = null;
    if (this.mode !== 'orbit') {
      this.fovGoal = 50;
      this.mode = 'orbit';
      this.onModeChange('orbit');
    }
    this.target = b;
    this.distance = this.goalDistance = Math.max(distance, this.minDistance(b));
  }

  zoom(factor: number): void {
    if (this.mode === 'ground') {
      // da terra non ci si avvicina: si stringe il campo visivo, come con un binocolo o un telescopio
      this.fovGoal = Math.min(100, Math.max(0.5, this.fovGoal * factor));
      return;
    }
    if (this.mode === 'free') {
      // in volo libero rotella e pizzico spingono avanti o indietro
      this.vNorm.z += Math.log(factor) * 5;
      return;
    }
    if (this.flight) {
      // durante un volo la rotella cambia la distanza d'arrivo senza interrompere il percorso
      this.flight.zoom = Math.min(Math.max(this.flight.zoom * factor, this.minDistance(this.flight.to) / this.flight.d1), 3e19 / this.flight.d1);
      return;
    }
    // fino a ~3 milioni di anni luce: si vede anche la galassia di Andromeda
    this.goalDistance = Math.min(Math.max(this.goalDistance * factor, this.minDistance()), 3e19);
  }

  // ------------------------------------------------------------------ tastiera del volo libero

  /** Tasti premuti o rilasciati. Restituisce true se il tasto è del volo libero (e quindi usato). */
  key(e: KeyboardEvent, down: boolean): boolean {
    const c = e.code;
    if (!down) {
      const had = this.keys.delete(c);
      return had && this.mode === 'free';
    }
    if (this.mode !== 'free') return false;
    if (c in MOVE_KEYS || c in ROLL_KEYS || c === 'ShiftLeft' || c === 'ShiftRight') {
      this.keys.add(c);
      return true;
    }
    if (e.key === '+' || c === 'NumpadAdd' || c === 'BracketRight') { this.speedMul = Math.min(64, this.speedMul * 2); return true; }
    if (e.key === '-' || c === 'NumpadSubtract' || c === 'BracketLeft') { this.speedMul = Math.max(1 / 64, this.speedMul / 2); return true; }
    if (c === 'KeyR') { this.levelHorizon(); return true; }
    return false;
  }

  /** Raddrizza la camera: l'alto torna verso il nord dell'eclittica, con un passaggio morbido. */
  private levelHorizon(): void {
    const fwd = _v.set(0, 0, -1).applyQuaternion(this.freeQuat);
    if (Math.abs(fwd.y) > 0.999) return;
    const from = this.freeQuat.clone();
    const m = new PerspectiveCamera();
    m.up.set(0, 1, 0);
    m.lookAt(fwd);
    this.freeQuat.copy(m.quaternion);
    this.blend = { from, t: 0, dur: 0.6 };
  }

  // ------------------------------------------------------------------ fotogramma

  update(dt: number): void {
    dt = Math.min(0.1, Math.max(0, dt));
    if (this.mode === 'free') this.updateFree(dt);
    else if (this.mode === 'ground') this.updateGround(dt);
    else this.updateOrbit(dt);
    if (Math.abs(this.camera.fov - this.fovGoal) > 1e-3) {
      const k = 1 - Math.exp(-dt / 0.12);
      this.camera.fov += (this.fovGoal - this.camera.fov) * k;
      if (Math.abs(this.camera.fov - this.fovGoal) < 0.01) this.camera.fov = this.fovGoal;
      this.camera.updateProjectionMatrix();
    }
    if (this.blend) {
      const b = this.blend;
      b.t = Math.min(1, b.t + dt / b.dur);
      _q.copy(this.camera.quaternion);
      this.camera.quaternion.slerpQuaternions(b.from, _q, smoother(b.t));
      if (b.t >= 1) this.blend = null;
    }
    this.camera.position.set(0, 0, 0);
    this.camera.updateMatrixWorld();
  }

  private updateOrbit(dt: number): void {
    // inerzia della rotazione (indipendente dai fotogrammi al secondo)
    if (!this.dragging) {
      const n = dt * 60;
      if (this.flight) {
        for (const f of [this.flight, this.prevFlight]) if (f) { f.dAz += this.vAz * n; f.dEl += this.vEl * n; }
      } else {
        this.az += this.vAz * n;
        this.el += this.vEl * n;
      }
      const k = Math.pow(0.0025, dt);
      this.vAz *= k;
      this.vEl *= k;
    }
    this.el = Math.max(-1.5605, Math.min(1.5605, this.el));
    const min = this.minDistance();
    if (this.goalDistance < min) this.goalDistance = min;

    if (this.flight) {
      const f = this.flight;
      const st = this.evalFlight(f, dt, this.st1);
      if (this.prevFlight) {
        const p = this.evalFlight(this.prevFlight, dt, this.st0);
        this.xfade = Math.min(1, this.xfade + dt / 0.7);
        const k = smoother(this.xfade);
        st.look.lerpVectors(p.look, st.look, k);
        st.dist = Math.exp(Math.log(p.dist) * (1 - k) + Math.log(st.dist) * k);
        st.az = p.az + (st.az - p.az) * k;
        st.el = p.el + (st.el - p.el) * k;
        if (this.xfade >= 1) this.prevFlight = null;
      }
      this.lookPos.copy(st.look);
      this.distance = st.dist;
      this.az = st.az;
      this.el = Math.max(-1.5605, Math.min(1.5605, st.el));
      if (f.t >= 1 && !this.prevFlight) {
        this.flight = null;
        this.distance = f.d1 * f.zoomCur;
        this.goalDistance = Math.max(f.d1 * f.zoom, this.minDistance());
      }
    } else {
      this.lookPos.copy(this.target.scenePos);
      // zoom morbido (interpolazione logaritmica)
      const k = follow(dt, 0.11);
      this.distance = Math.exp(Math.log(this.distance) + (Math.log(this.goalDistance) - Math.log(this.distance)) * k);
    }
    const ce = Math.cos(this.el);
    const off = _w.set(ce * Math.cos(this.az), Math.sin(this.el), ce * Math.sin(this.az)).multiplyScalar(this.distance);
    this.camPos.copy(this.lookPos).add(off);
    this.camera.position.set(0, 0, 0);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(-off.x, -off.y, -off.z);
  }

  /** Avanza un volo di dt secondi e ne calcola lo stato (punto osservato, distanza, angoli). */
  private evalFlight(f: Flight, dt: number, out: FlightState): FlightState {
    f.t = Math.min(1, f.t + dt / f.dur);
    const e = smoother(f.t);
    const s = e * f.path.S;
    // il punto di partenza segue il corpo di partenza; l'eventuale scarto iniziale svanisce piano
    _v.copy(f.from.scenePos).addScaledVector(f.fromOffset, 1 - e);
    // nella prima metà si conta dalla partenza, nella seconda dall'arrivo: i numeri piccoli
    // restano piccoli e la vista non trema nemmeno dopo un viaggio da un'altra galassia
    const u = f.path.u(s);
    if (u < 0.5) out.look.copy(_v).lerp(f.to.scenePos, u);
    else out.look.subVectors(_v, f.to.scenePos).multiplyScalar(f.path.v(s)).add(f.to.scenePos);
    f.zoomCur += (f.zoom - f.zoomCur) * follow(dt, 0.15);
    out.dist = f.path.w(s) * f.zoomCur;
    out.az = f.az0 + (f.az1 - f.az0) * e + f.dAz;
    out.el = f.el0 + (f.el1 - f.el0) * e + f.dEl;
    return out;
  }

  private updateFree(dt: number): void {
    // ---- rotazione: trascinamento con inerzia, rollio con Z e C
    const q = this.freeQuat;
    if (!this.dragging) {
      const n = dt * 60;
      if (this.yawVel || this.pitchVel) {
        q.multiply(_q.setFromAxisAngle(Y, this.yawVel * n));
        q.multiply(_q.setFromAxisAngle(X, this.pitchVel * n));
      }
      const k = Math.pow(0.0025, dt);
      this.yawVel *= k;
      this.pitchVel *= k;
    }
    let rollWant = 0;
    for (const c of this.keys) rollWant += ROLL_KEYS[c] ?? 0;
    this.rollVel += (rollWant * 1.1 - this.rollVel) * follow(dt, 0.15);
    if (Math.abs(this.rollVel) > 1e-5) q.multiply(_q.setFromAxisAngle(Z, this.rollVel * dt));
    q.normalize();

    // ---- dove siamo: distanza dalla superficie più vicina e corpo a cui agganciarsi
    const camAbs = _v.copy(this.target.scenePos).add(this.freeOffset);
    let gap = Infinity, anchor: Body | null = null, anchorGap = Infinity, targetGap = Infinity;
    for (const b of this.bodies()) {
      if (!b.valid || b.kind === 'barycenter') continue;
      const d = b.scenePos.distanceTo(camAbs);
      let g: number;
      if (ENTERABLE.has(b.kind)) {
        if (d < b.radius) continue; // dentro una galassia o una nebulosa: non conta
        g = d - b.radius;
      } else {
        const model = b.extra.modelRadiusKm as number | undefined;
        g = d - (b.radius > 0 ? b.radius : model ?? 0);
      }
      if (g < gap) gap = g;
      if (b === this.target) targetGap = g;
      if (ANCHOR_KINDS.has(b.kind) && g < anchorGap) { anchorGap = g; anchor = b; }
    }
    if (!Number.isFinite(gap)) gap = camAbs.length();
    gap = Math.max(gap, 0.005);
    this.gapKm = gap;

    // ---- movimento: i tasti danno la direzione, la velocità si adatta da sola
    const want = _w.set(0, 0, 0);
    let boost = false;
    for (const c of this.keys) {
      const m = MOVE_KEYS[c];
      if (m) want.setComponent(m[0], want.getComponent(m[0]) + m[1]);
      if (c === 'ShiftLeft' || c === 'ShiftRight') boost = true;
    }
    if (want.lengthSq() > 1) want.normalize();
    this.vNorm.lerp(want, follow(dt, 0.22));
    const unit = cruiseSpeed(gap, this.speedMul, boost);
    const step = _w.copy(this.vNorm).applyQuaternion(q).multiplyScalar(unit * dt);
    // mai più di 9/10 della distanza dalla superficie in un fotogramma: niente attraversamenti
    const sl = step.length();
    if (sl > 0.9 * gap) step.multiplyScalar((0.9 * gap) / sl);
    this.speedKmS = dt > 0 ? step.length() / dt : 0;
    camAbs.add(step);

    // ---- aggancio al corpo più vicino (con un margine, per non saltare avanti e indietro)
    if (anchor && anchor !== this.target && anchorGap < 0.7 * targetGap) this.target = anchor;

    // ---- niente urti con i corpi solidi
    for (const b of this.bodies()) {
      if (!b.valid || ENTERABLE.has(b.kind) || b.kind === 'barycenter') continue;
      const min = this.freeMin(b);
      const off = camAbs.clone().sub(b.scenePos);
      const d = off.length();
      if (d < min && d > 0) camAbs.copy(b.scenePos).addScaledVector(off, min / d);
    }

    this.freeOffset.subVectors(camAbs, this.target.scenePos);
    this.camPos.copy(camAbs);
    this.lookPos.copy(camAbs).add(_w.set(0, 0, -1).applyQuaternion(q).multiplyScalar(gap));
    this.distance = this.target.scenePos.distanceTo(camAbs);
    this.camera.quaternion.copy(q);
  }

  // ------------------------------------------------------------------ mouse, trackpad, touch

  private bindInput(): void {
    const el = this.dom;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.button !== 2) return;
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.vAz = this.vEl = 0;
      this.yawVel = this.pitchVel = 0;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      if (this.mode === 'ground') {
        // si "afferra" il cielo: trascinando a destra lo sguardo va a sinistra
        const radPerPx = (this.camera.fov * Math.PI) / 180 / Math.max(1, el.clientHeight);
        this.gAzGoal = null;
        this.gAz -= (dx * radPerPx) / Math.max(0.2, Math.cos(this.gAlt));
        this.gAlt += dy * radPerPx;
      } else if (this.mode === 'free') {
        // si "afferra" il cielo: il punto sotto il mouse lo segue
        const radPerPx = (this.camera.fov * Math.PI) / 180 / Math.max(1, el.clientHeight);
        this.yawVel = dx * radPerPx;
        this.pitchVel = dy * radPerPx;
        this.freeQuat.multiply(_q.setFromAxisAngle(Y, this.yawVel));
        this.freeQuat.multiply(_q.setFromAxisAngle(X, this.pitchVel));
      } else {
        const s = 0.0045;
        this.vAz = dx * s;
        this.vEl = dy * s;
        if (this.flight) {
          for (const f of [this.flight, this.prevFlight]) if (f) { f.dAz += this.vAz; f.dEl += this.vEl; }
        } else {
          this.az += this.vAz;
          this.el += this.vEl;
        }
      }
      if (Math.abs(dx) + Math.abs(dy) > 0) this.onUserInput();
    });
    const end = (e: PointerEvent) => {
      this.dragging = false;
      try { el.releasePointerCapture(e.pointerId); } catch { /* già rilasciato */ }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    let gestureScale = 1;
    let gestureOn = false;
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey && gestureOn) return; // il pizzico arriva già dagli eventi "gesture"
      let delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      // pizzico sul trackpad (Mac, touchpad di precisione): rotella con Ctrl e scatti piccoli
      if (e.ctrlKey) delta *= 5;
      delta = Math.max(-300, Math.min(300, delta));
      this.zoom(Math.pow(1.0018, delta));
      this.onUserInput();
    }, { passive: false });
    // pizzico sul trackpad nella finestra del Mac (WebKit manda eventi "gesture")
    el.addEventListener('gesturestart', (e) => {
      e.preventDefault();
      gestureOn = true;
      gestureScale = (e as unknown as { scale?: number }).scale || 1;
    });
    el.addEventListener('gesturechange', (e) => {
      e.preventDefault();
      const s = (e as unknown as { scale?: number }).scale;
      if (s && s > 0) {
        this.zoom(gestureScale / s);
        gestureScale = s;
        this.onUserInput();
      }
    });
    el.addEventListener('gestureend', () => { gestureOn = false; });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    // pizzico su touch
    el.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        this.pinchDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      }
    }, { passive: true });
    el.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2 && this.pinchDist > 0) {
        const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        this.zoom(this.pinchDist / d);
        this.pinchDist = d;
      }
    }, { passive: true });
    // un tasto rilasciato fuori dalla finestra non deve lasciare la camera in movimento
    window.addEventListener('keyup', (e) => this.key(e, false));
    window.addEventListener('blur', () => this.keys.clear());
  }
}
