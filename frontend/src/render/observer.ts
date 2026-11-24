/**
 * "Tu sei qui": il luogo dell'osservatore segnato sulla Terra, quando la Terra è abbastanza
 * grande sullo schermo e il punto è sul lato rivolto verso la camera.
 */

import { PerspectiveCamera, Vector3 } from 'three';
import { M_ICRF_TO_SCENE } from '../core/frames';
import type { Place } from '../core/places';
import type { Body } from '../sim/body';

const _p = new Vector3();
const _n = new Vector3();
const _v = new Vector3();
const DEG = Math.PI / 180;

export class ObserverMarker {
  private el: HTMLDivElement;
  private nameEl: HTMLSpanElement;
  place: Place | null = null;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'observer-pin';
    const dot = document.createElement('span');
    dot.className = 'dot';
    this.nameEl = document.createElement('span');
    this.nameEl.className = 'name';
    this.el.append(dot, this.nameEl);
    this.el.hidden = true;
    parent.appendChild(this.el);
  }

  /** `earthPos`: centro della Terra nella scena, relativo alla camera (già ridotto); `scale`: raggio nella scena */
  update(earth: Body, earthPos: Vector3, scale: number, pxRadius: number, camera: PerspectiveCamera, w: number, h: number): void {
    const p = this.place;
    if (!p || !earth.valid || pxRadius < 22) {
      this.el.hidden = true;
      return;
    }
    // punto sulla superficie nel sistema solidale alla Terra (X = Greenwich, Z = polo nord), poi ICRF e scena
    const la = p.lat * DEG, lo = p.lon * DEG;
    _n.set(Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)).applyMatrix3(earth.orient).applyMatrix3(M_ICRF_TO_SCENE).normalize();
    _p.copy(_n).multiplyScalar(scale * 1.002).add(earthPos);
    // sul lato nascosto non si mostra (la normale guarda lontano dalla camera, che sta nell'origine)
    _v.copy(_p).normalize();
    if (_n.dot(_v) > -0.05) {
      this.el.hidden = true;
      return;
    }
    const v = _p.clone().applyMatrix4(camera.matrixWorldInverse);
    if (v.z > 0) {
      this.el.hidden = true;
      return;
    }
    v.applyMatrix4(camera.projectionMatrix);
    this.el.hidden = false;
    if (this.nameEl.textContent !== p.name) this.nameEl.textContent = p.name;
    this.el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px)`;
    this.el.style.opacity = String(Math.min(1, (pxRadius - 22) / 20));
  }
}
