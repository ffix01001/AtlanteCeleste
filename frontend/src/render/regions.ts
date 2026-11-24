/**
 * Zone e confini del Sistema Solare: ciò che non è un corpo ma un luogo.
 *
 *   - zona abitabile: l'anello attorno al Sole dove l'acqua può restare liquida in superficie
 *     (da 0,95 a 1,67 UA: Kasting e collaboratori 1993, Kopparapu e collaboratori 2013);
 *   - fascia di Kuiper: fra 30 e 50 UA;
 *   - shock di terminazione (circa 90 UA) ed eliopausa (circa 120 UA): dove il vento solare
 *     rallenta e dove finisce, come misurato dalle sonde Voyager (2004-2007 e 2012-2018);
 *   - nube di Oort: da circa 2.000 a circa 100.000 UA (mai osservata direttamente);
 *   - punti di Lagrange del sistema Sole-Terra, dove una sonda resta ferma rispetto ai due.
 *
 * Eliopausa e nube di Oort non sono sfere perfette né hanno un bordo netto: i cerchi danno
 * l'ordine di grandezza. Tutto è relativo al Sole e si disegna con coordinate riferite alla camera.
 */

import { t } from '../core/i18n';
import { Color, DoubleSide, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, RingGeometry, Vector3 } from 'three';
import { M_ICRF_TO_SCENE } from '../core/frames';
import { AU_KM } from '../core/units';
import type { Body } from '../sim/body';
import { ThickLine } from './lines';

interface Ring { mesh: Mesh; outer: number; base: number; label: Mark }
interface Shell { line: ThickLine; r: number; label: Mark }
interface Mark { el: HTMLDivElement; pos: Vector3 }

const _v = new Vector3();
const _u = new Vector3();
const _t = new Vector3();
/** massa di Terra e Luna rispetto al totale con il Sole */
const MU_EARTH = 3.0404e-6;

export class RegionLayer {
  readonly group = new Group();
  private rings: Ring[] = [];
  private shells: Shell[] = [];
  private lagrange: Mark[] = [];

  constructor(private parent: HTMLElement) {
    this.rings.push(this.ring(0.95, 1.67, '#4fd18b', 0.035, t('Zona abitabile')));
    this.rings.push(this.ring(30, 50, '#6fa8ff', 0.035, t('Fascia di Kuiper · 30–50 UA')));
    this.shells.push(this.shell(90, '#7fd0ff', t('Shock di terminazione · circa 90 UA')));
    this.shells.push(this.shell(120, '#ffd27a', t('Eliopausa · circa 120 UA')));
    this.shells.push(this.shell(2000, '#b7c4e0', t('Nube di Oort interna · da circa 2.000 UA')));
    this.shells.push(this.shell(100000, '#b7c4e0', t('Nube di Oort · fino a circa 100.000 UA')));
    for (const name of ['L1', t('L2 · telescopio Webb'), 'L3', 'L4', 'L5']) this.lagrange.push(this.mark(name, 'lagr'));
    this.group.visible = false;
  }

  private mark(text: string, cls = ''): Mark {
    const el = document.createElement('div');
    el.className = `region-label ${cls}`.trim();
    el.textContent = text;
    el.hidden = true;
    this.parent.appendChild(el);
    return { el, pos: new Vector3() };
  }

  private ring(innerAu: number, outerAu: number, color: string, opacity: number, label: string): Ring {
    const mesh = new Mesh(
      new RingGeometry(innerAu * AU_KM, outerAu * AU_KM, 192, 1),
      new MeshBasicMaterial({ color: new Color(color), transparent: true, opacity, side: DoubleSide, depthWrite: false }),
    );
    // dal piano XY della geometria al piano dell'eclittica (XZ nella scena)
    mesh.rotation.x = -Math.PI / 2;
    mesh.renderOrder = -2;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    const m = this.mark(label);
    const r = ((innerAu + outerAu) / 2) * AU_KM;
    m.pos.set(r * Math.cos(2.4), 0, r * Math.sin(2.4));
    return { mesh, outer: outerAu * AU_KM, base: opacity, label: m };
  }

  private shell(rAu: number, color: string, label: string): Shell {
    const r = rAu * AU_KM, N = 128;
    const pts: number[] = [], al: number[] = [];
    // tre cerchi massimi: l'eclittica e due meridiani
    for (let k = 0; k < 3; k++) {
      if (k) { pts.push(0, 0, 0); al.push(-1); }
      for (let i = 0; i <= N; i++) {
        const a = (i / N) * Math.PI * 2, c = Math.cos(a) * r, s = Math.sin(a) * r;
        if (k === 0) pts.push(c, 0, s); else if (k === 1) pts.push(c, s, 0); else pts.push(0, c, s);
        al.push(k === 0 ? 1 : 0.55);
      }
    }
    const line = new ThickLine(pts.length / 3, new Color(color), 0, 1.0);
    line.setPoints(pts, al, pts.length / 3);
    line.mesh.renderOrder = -2;
    line.visible = false;
    this.group.add(line.mesh);
    const m = this.mark(label);
    // ogni guscio ha il nome in un punto diverso del cerchio: da lontano non si sovrappongono
    const ang = -0.7 + this.shells.length * 1.3;
    m.pos.set(r * Math.cos(ang), 0, r * Math.sin(ang));
    return { line, r, label: m };
  }

  /** dato dalla vista: il punto dello schermo è coperto da un corpo più vicino di `dist`? */
  covered: (x: number, y: number, dist: number) => boolean = () => false;

  private place(m: Mark, rel: Vector3, show: boolean, camera: PerspectiveCamera, w: number, h: number, opacity = 1): void {
    let vis = show;
    if (vis) {
      const dist = rel.length();
      _v.copy(rel).applyMatrix4(camera.matrixWorldInverse);
      if (_v.z >= 0) vis = false;
      else {
        _v.applyMatrix4(camera.projectionMatrix);
        const x = (_v.x * 0.5 + 0.5) * w, y = (-_v.y * 0.5 + 0.5) * h;
        if (x < -20 || x > w + 20 || y < -20 || y > h + 20 || this.covered(x, y, dist)) vis = false;
        else {
          m.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
          m.el.style.opacity = opacity.toFixed(2);
        }
      }
    }
    if (m.el.hidden === vis) m.el.hidden = !vis;
  }

  /** `sunRel`: il Sole rispetto alla camera (scena, km). */
  update(on: boolean, names: boolean, sunRel: Vector3, sun: Body, earth: Body, camera: PerspectiveCamera, w: number, h: number, pxPerRad: number): void {
    this.group.visible = on;
    const dist = Math.max(sunRel.length(), 1);
    if (on) this.group.position.copy(sunRel);
    // grandezza sullo schermo: compaiono quando sono abbastanza grandi, spariscono quando ci si è dentro
    const fade = (rKm: number, lo = 30, hi = 5000) => {
      const px = (rKm / dist) * pxPerRad;
      return Math.min(1, Math.max(0, (px - lo) / lo)) * Math.min(1, Math.max(0, (hi - px) / (hi * 0.4)));
    };
    for (const r of this.rings) {
      // (visti da dentro o di taglio da vicino sarebbero un velo colorato su mezzo schermo)
      const f = on ? fade(r.outer, 40, 700) : 0;
      r.mesh.visible = f > 0.01;
      (r.mesh.material as MeshBasicMaterial).opacity = r.base * f;
      this.place(r.label, _u.copy(r.label.pos).add(sunRel), names && f > 0.5, camera, w, h, 0.8 * f);
    }
    for (const s of this.shells) {
      const f = on ? fade(s.r, 60, 4000) : 0;
      s.line.visible = f > 0.01;
      s.line.opacity = 0.4 * f;
      this.place(s.label, _u.copy(s.label.pos).add(sunRel), names && f > 0.4, camera, w, h, 0.85 * f);
    }
    // punti di Lagrange Sole-Terra
    const ok = on && names && earth.valid && sun.valid;
    if (!ok) {
      for (const m of this.lagrange) if (!m.el.hidden) m.el.hidden = true;
      return;
    }
    const e = _t.subVectors(earth.scenePos, sun.scenePos);
    const r = e.length();
    const u = e.clone().divideScalar(r);
    // direzione del moto della Terra, perpendicolare alla congiungente con il Sole
    const tan = new Vector3().subVectors(earth.vel, sun.vel).applyMatrix3(M_ICRF_TO_SCENE);
    tan.addScaledVector(u, -tan.dot(u)).normalize();
    const k = Math.cbrt(MU_EARTH / 3);
    const pts = [
      u.clone().multiplyScalar(r * (1 - k)), u.clone().multiplyScalar(r * (1 + k)), u.clone().multiplyScalar(-r * (1 + (5 * MU_EARTH) / 12)),
      u.clone().multiplyScalar(r * 0.5).addScaledVector(tan, r * Math.sqrt(3) / 2), u.clone().multiplyScalar(r * 0.5).addScaledVector(tan, -r * Math.sqrt(3) / 2),
    ];
    const earthDist = Math.max(_v.copy(e).add(sunRel).length(), 1);
    const nearPx = ((r * k) / earthDist) * pxPerRad;   // L1 e L2 visti dalla camera: distanza dalla Terra in pixel
    const farPx = (r / dist) * pxPerRad;
    pts.forEach((p, i) => {
      const show = i < 2 ? nearPx > 22 && nearPx < 4000 : farPx > 140 && farPx < 20000;
      this.place(this.lagrange[i], p.add(sunRel), show, camera, w, h, 0.9);
    });
  }
}
