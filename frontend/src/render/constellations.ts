/**
 * Figure delle costellazioni: le linee fra le stelle e i nomi, come sugli atlanti del cielo.
 *
 * Le costellazioni sono disegni fatti dalla Terra: valgono finché si resta nel Sistema Solare
 * (le stelle sono così lontane che da Nettuno il cielo è lo stesso). Allontanandosi verso le
 * stelle le figure si deformano e qui, semplicemente, sfumano via.
 * Dati: d3-celestial di Olaf Frohn (vedi data/reference/costellazioni_linee.json).
 */

import { Color, PerspectiveCamera, Vector3 } from 'three';
import { M_ICRF_TO_SCENE } from '../core/frames';
import { unitFromRaDec } from '../core/galactic';
import { ThickLine } from './lines';
import { api } from '../data/api';
import { constellationNames } from '../data/names';

interface Figure { nome_it: string; centro: [number, number]; rango: number; linee: [number, number][][] }

/** distanza a cui si disegnano le linee: oltre i pianeti, molto prima delle stelle (circa un terzo di parsec) */
const R_KM = 1e13;
const _v = new Vector3();

export class ConstellationLayer {
  readonly line = new ThickLine(1200, new Color('#6f93cc'), 0, 1.0);
  private labels: { el: HTMLDivElement; dir: Vector3; rank: number }[] = [];
  ready = false;

  constructor(private parent: HTMLElement) {
    this.line.mesh.renderOrder = -8;
    this.line.visible = false;
  }

  async load(): Promise<void> {
    const [r, names] = await Promise.all([fetch(api.referenceUrl('costellazioni_linee')), constellationNames()]);
    if (!r.ok) throw new Error(`${r.status}`);
    const figures = (await r.json()).figure as Record<string, Figure>;
    const pts: number[] = [], al: number[] = [];
    for (const [abbr, f] of Object.entries(figures)) {
      for (const seg of f.linee) {
        if (pts.length) { pts.push(0, 0, 0); al.push(-1); } // separatore
        for (const [ra, dec] of seg) {
          unitFromRaDec(ra, dec, _v).applyMatrix3(M_ICRF_TO_SCENE).multiplyScalar(R_KM);
          pts.push(_v.x, _v.y, _v.z);
          al.push(1);
        }
      }
      const el = document.createElement('div');
      el.className = 'const-label';
      el.textContent = names[abbr] ?? f.nome_it;
      el.hidden = true;
      this.parent.appendChild(el);
      this.labels.push({ el, dir: unitFromRaDec(f.centro[0], f.centro[1]).applyMatrix3(M_ICRF_TO_SCENE), rank: f.rango });
    }
    this.line.setPoints(pts, al, pts.length / 3);
    this.ready = true;
  }

  /**
   * `sunRel`: il Sole rispetto alla camera; `fromSunPc`: distanza della camera dal Sole;
   * `up`: zenit dell'osservatore se si guarda da terra (i nomi sotto l'orizzonte si nascondono).
   */
  update(
    on: boolean, names: boolean, sunRel: Vector3, fromSunPc: number, camera: PerspectiveCamera, w: number, h: number,
    pxPerRad: number, up: Vector3 | null, covered: (x: number, y: number) => boolean = () => false,
  ): void {
    // dentro il Sistema Solare piene; spariscono entro un decimo di parsec
    const t = Math.min(1, Math.max(0, (0.08 - fromSunPc) / 0.06));
    const show = on && this.ready && t > 0.01;
    this.line.visible = show;
    if (show) {
      this.line.mesh.position.copy(sunRel);
      // da terra un po' più marcate: lì sono la guida per orientarsi
      this.line.opacity = (up ? 0.5 : 0.3) * t;
    }
    for (const l of this.labels) {
      let vis = show && names && (l.rank === 1 || pxPerRad > (l.rank === 2 ? 520 : 900));
      if (vis && up && l.dir.dot(up) < 0.03) vis = false;
      if (vis) {
        _v.copy(l.dir).applyMatrix4(camera.matrixWorldInverse);
        if (_v.z >= 0) vis = false;
        else {
          _v.applyMatrix4(camera.projectionMatrix);
          const x = (_v.x * 0.5 + 0.5) * w, y = (-_v.y * 0.5 + 0.5) * h;
          // fuori dallo schermo, o dietro il disco di un pianeta
          if (x < -60 || x > w + 60 || y < -20 || y > h + 20 || covered(x, y)) vis = false;
          else {
            l.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%)`;
            l.el.style.opacity = (0.75 * t).toFixed(2);
          }
        }
      }
      if (l.el.hidden === vis) l.el.hidden = !vis;
    }
  }
}
