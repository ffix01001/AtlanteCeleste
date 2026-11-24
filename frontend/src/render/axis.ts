/**
 * Asse di rotazione ed equatore del corpo selezionato.
 *
 * L'asse resta fisso nello spazio (a parte la lentissima precessione) mentre il pianeta
 * gira attorno al Sole: è questo a produrre le stagioni. Vederlo aiuta a capirlo.
 * Le lettere N e S sono etichette HTML sopra la scena, alle estremità dell'asse.
 */

import { Color, Group, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { M_ICRF_TO_SCENE } from '../core/frames';
import { poleOf } from '../ephem/rotation';
import type { Body } from '../sim/body';
import { ThickLine } from './lines';

const SEG = 160;
const _pole = new Vector3();
const _z = new Vector3(0, 0, 1);
const _q = new Quaternion();
const _tip = new Vector3();

export class AxisGizmo {
  readonly group = new Group();
  private axisN: ThickLine;
  private axisS: ThickLine;
  private equator: ThickLine;
  private labelN: HTMLDivElement;
  private labelS: HTMLDivElement;
  private shown = 0;

  constructor(labelParent: HTMLElement) {
    // dal centro a 1,6 raggi: la parte dentro il pianeta è nascosta dalla sfera
    this.axisN = new ThickLine(2, new Color('#ffe2a8'), 0.9, 1.6);
    this.axisN.setPoints([0, 0, 0, 0, 0, 1.6], [1, 1], 2);
    this.axisS = new ThickLine(2, new Color('#a9c8ff'), 0.6, 1.6);
    this.axisS.setPoints([0, 0, 0, 0, 0, -1.6], [1, 1], 2);
    const pts: number[] = [];
    for (let i = 0; i <= SEG; i++) {
      const a = (i / SEG) * Math.PI * 2;
      pts.push(Math.cos(a) * 1.004, Math.sin(a) * 1.004, 0);
    }
    this.equator = new ThickLine(SEG + 1, new Color('#ffe2a8'), 0.35, 1.2);
    this.equator.setPoints(pts, 1, SEG + 1);
    for (const l of [this.axisN, this.axisS, this.equator]) {
      l.mesh.renderOrder = 3;
      this.group.add(l.mesh);
    }
    this.group.visible = false;
    const mk = (t: string) => {
      const el = document.createElement('div');
      el.className = 'axis-label';
      el.textContent = t;
      el.hidden = true;
      labelParent.appendChild(el);
      return el;
    };
    this.labelN = mk('N');
    this.labelS = mk('S');
  }

  /**
   * `pos`: centro del corpo nella scena, relativo alla camera (già "ridotto" se lontano);
   * `scale`: raggio del corpo nelle stesse unità; `pxRadius`: raggio sullo schermo.
   */
  update(b: Body | null, pos: Vector3, scale: number, pxRadius: number, enabled: boolean, dt: number,
    camera: PerspectiveCamera, width: number, height: number): void {
    const ok = enabled && !!b && b.valid && b.data.rotation?.model === 'iau' && b.radius > 0;
    // compare quando il corpo è grande almeno qualche decina di pixel
    const target = ok ? Math.min(1, Math.max(0, (pxRadius - 18) / 30)) : 0;
    const k = 1 - Math.exp(-dt / 0.15);
    this.shown += (target - this.shown) * k;
    if (Math.abs(target - this.shown) < 0.004) this.shown = target;
    const vis = this.shown > 0.01 && !!b;
    this.group.visible = vis;
    this.labelN.hidden = this.labelS.hidden = !vis;
    if (!vis || !b) return;
    poleOf(b.orient, _pole).applyMatrix3(M_ICRF_TO_SCENE).normalize();
    _q.setFromUnitVectors(_z, _pole);
    this.group.position.copy(pos);
    this.group.quaternion.copy(_q);
    this.group.scale.setScalar(scale);
    this.axisN.opacity = 0.9 * this.shown;
    this.axisS.opacity = 0.6 * this.shown;
    this.equator.opacity = 0.32 * this.shown;
    this.place(this.labelN, _tip.copy(_pole).multiplyScalar(1.75 * scale).add(pos), camera, width, height);
    this.place(this.labelS, _tip.copy(_pole).multiplyScalar(-1.75 * scale).add(pos), camera, width, height);
    this.labelN.style.opacity = this.labelS.style.opacity = String(this.shown);
  }

  private place(el: HTMLDivElement, p: Vector3, camera: PerspectiveCamera, w: number, h: number): void {
    const v = p.clone().applyMatrix4(camera.matrixWorldInverse);
    if (v.z > 0) {
      el.hidden = true;
      return;
    }
    v.applyMatrix4(camera.projectionMatrix);
    el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -50%)`;
  }
}
