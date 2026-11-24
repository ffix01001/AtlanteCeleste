/**
 * Etichette e marcatori in HTML sovrapposti alla scena 3D.
 * I corpi lontani sono più piccoli di un pixel: il marcatore li rende sempre
 * visibili e cliccabili. Le etichette che si sovrapporrebbero vengono nascoste
 * dando priorità ai corpi più importanti.
 */

import { PerspectiveCamera, Vector3 } from 'three';
import type { Body } from '../sim/body';
import { KIND_COLORS } from './orbits';

interface Item {
  body: Body;
  el: HTMLDivElement;
  w: number;
  shown: boolean;
  x: number;
  y: number;
  onScreen: boolean;
  px: number;
  dist: number;
  /** ultimo spostamento e ultime classi scritti nella pagina */
  tf: string;
  flags: number;
}

const _v = new Vector3();

export class LabelLayer {
  readonly root: HTMLDivElement;
  private items = new Map<string, Item>();
  private reticle: HTMLDivElement;
  private reticleFor: string | null = null;
  onPick: (b: Body, dbl: boolean) => void = () => {};
  showNames = true;
  /** zone occupate dall'interfaccia (pannelli): lì le etichette non si disegnano */
  blockers: () => DOMRect[] = () => [];

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'labels';
    parent.appendChild(this.root);
    this.reticle = document.createElement('div');
    this.reticle.className = 'reticle';
    this.root.appendChild(this.reticle);
  }

  ensure(b: Body): void {
    if (this.items.has(b.id) || b.kind === 'barycenter') return;
    const el = document.createElement('div');
    el.className = `label kind-${b.kind}`;
    el.style.setProperty('--kc', KIND_COLORS[b.kind] ?? '#fff');
    const dot = document.createElement('span');
    dot.className = 'dot';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = b.name;
    el.append(dot, name);
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.onPick(b, false);
    });
    el.addEventListener('dblclick', (ev) => {
      ev.stopPropagation();
      this.onPick(b, true);
    });
    el.style.display = 'none';
    this.root.appendChild(el);
    this.items.set(b.id, { body: b, el, w: 0, shown: false, x: 0, y: 0, onScreen: false, px: 0, dist: 0, tf: '', flags: -1 });
  }

  remove(id: string): void {
    const it = this.items.get(id);
    if (it) {
      it.el.remove();
      this.items.delete(id);
    }
  }

  /** dischi dei corpi grandi sullo schermo nell'ultimo fotogramma: coprono ciò che sta dietro */
  private discs: { x: number; y: number; px: number; dist: number }[] = [];
  private blockAt = -1e9;
  private blockBoxes: number[] = [];
  private reticleKey = '';

  /**
   * Il punto dello schermo (x, y) è coperto da un corpo più vicino di `dist` km?
   * Serve agli altri nomi (costellazioni, zone, punti di Lagrange): non devono comparire
   * sopra il disco di un pianeta che li nasconde.
   */
  covered = (x: number, y: number, dist = Infinity): boolean => {
    for (const d of this.discs) {
      if (dist > d.dist && Math.hypot(x - d.x, y - d.y) < d.px) return true;
    }
    return false;
  };

  /** Posizione a schermo dell'ultimo fotogramma (per la selezione col clic). */
  screenOf(id: string): { x: number; y: number; px: number } | null {
    const it = this.items.get(id);
    return it && it.onScreen ? { x: it.x, y: it.y, px: it.px } : null;
  }

  update(
    camera: PerspectiveCamera, width: number, height: number, camPos: Vector3,
    pxPerRad: number, visible: (b: Body) => boolean, selectedId: string | null,
  ): void {
    const list: Item[] = [];
    for (const it of this.items.values()) {
      const b = it.body;
      it.onScreen = false;
      if (!b.valid || !visible(b)) continue;
      _v.subVectors(b.scenePos, camPos);
      const dist = _v.length();
      _v.applyMatrix4(camera.matrixWorldInverse);
      if (_v.z >= 0) continue; // dietro la camera
      _v.applyMatrix4(camera.projectionMatrix);
      const x = (_v.x * 0.5 + 0.5) * width;
      const y = (-_v.y * 0.5 + 0.5) * height;
      if (x < -50 || x > width + 50 || y < -50 || y > height + 50) continue;
      it.x = x;
      it.y = y;
      // sonde con il modello 3D caricato: conta la sua grandezza; un buco nero si vede grande quanto
      // la sua ombra, circa 2,6 volte l'orizzonte degli eventi (√27/2): lì va il mirino
      // satelliti e sonde senza modello 3D si vedono solo come un punto: il nome resta accanto al punto
      const pointOnly = (b.kind === 'satellite' || b.kind === 'spacecraft') && b.extra.visRadiusKm === undefined && b.extra.modelRadiusKm === undefined;
      const r = pointOnly ? 0 : (b.extra.visRadiusKm as number | undefined) ?? (b.kind === 'blackhole' ? b.radius * 2.6 : b.radius);
      it.px = dist > 0 ? (r / dist) * pxPerRad : 0;
      it.dist = dist;
      it.onScreen = true;
      list.push(it);
    }
    // corpi nascosti dietro un pianeta (o una sonda) più vicino: niente etichetta
    const occluders = list.filter((it) => it.px > 6).sort((a, b) => b.px - a.px).slice(0, 12);
    this.discs = occluders.map((o) => ({ x: o.x, y: o.y, px: o.px, dist: o.dist }));
    const hiddenBehind = new Set<Item>();
    if (occluders.length) {
      for (const it of list) {
        if (it.body.id === selectedId) continue;
        for (const o of occluders) {
          if (o === it || it.dist <= o.dist) continue;
          if (Math.hypot(it.x - o.x, it.y - o.y) < o.px * 0.97) {
            hiddenBehind.add(it);
            it.onScreen = false; // né etichetta né clic: il corpo davanti lo copre
            break;
          }
        }
      }
    }
    // le lune troppo vicine al pianeta sullo schermo spariscono (salvo selezione)
    const visibleItems = list.filter((it) => {
      if (hiddenBehind.has(it)) return false;
      const p = it.body.parent;
      if (it.body.id === selectedId || !p || p.kind === 'star' || p.kind === 'barycenter') return true;
      const ps = this.items.get(p.id);
      if (!ps || !ps.onScreen) return true;
      const sep = Math.hypot(it.x - ps.x, it.y - ps.y);
      return sep > Math.max(14, ps.px * 1.6);
    });
    visibleItems.sort((a, b) => {
      if (a.body.id === selectedId) return -1;
      if (b.body.id === selectedId) return 1;
      return a.body.rank - b.body.rank;
    });
    // i riquadri dei pannelli si misurano quattro volte al secondo, non a ogni fotogramma: chiedere
    // le misure al browser mentre si spostano le etichette lo costringe a rifare l'impaginazione
    const now = performance.now();
    if (now - this.blockAt > 250) {
      this.blockAt = now;
      this.blockBoxes.length = 0;
      for (const r of this.blockers()) this.blockBoxes.push(r.left, r.top, r.right, r.bottom);
    }
    const boxes: number[] = this.blockBoxes.slice();
    const shownNow = new Set<Item>();
    for (const it of visibleItems) {
      const disk = it.px > 3;
      const lx = disk ? it.x + it.px + 4 : it.x - 4;
      const w = it.w || 90;
      const box = [lx, it.y - 9, lx + w + 12, it.y + 9];
      let overlap = false;
      {
        for (let k = 0; k < boxes.length; k += 4) {
          if (box[0] < boxes[k + 2] && box[2] > boxes[k] && box[1] < boxes[k + 3] && box[3] > boxes[k + 1]) {
            overlap = true;
            break;
          }
        }
      }
      if (overlap) continue;
      boxes.push(box[0], box[1], box[2], box[3]);
      shownNow.add(it);
      if (!it.shown) {
        it.el.style.display = '';
        it.shown = true;
        if (!it.w) it.w = it.el.offsetWidth;
      }
      // si tocca la pagina solo quando qualcosa cambia davvero (a camera ferma: mai)
      const isSel = it.body.id === selectedId;
      const noname = !this.showNames && !isSel;
      const flags = (disk ? 1 : 0) | (isSel ? 2 : 0) | (noname ? 4 : 0);
      if (flags !== it.flags) {
        it.flags = flags;
        it.el.classList.toggle('disk', disk);
        it.el.classList.toggle('selected', isSel);
        it.el.classList.toggle('noname', noname);
      }
      const tx = disk ? it.x + it.px + 2 : it.x;
      const tf = `translate3d(${tx.toFixed(1)}px, ${it.y.toFixed(1)}px, 0)`;
      if (tf !== it.tf) {
        it.tf = tf;
        it.el.style.transform = tf;
      }
    }
    for (const it of this.items.values()) {
      if (it.shown && !shownNow.has(it)) {
        it.el.style.display = 'none';
        it.shown = false;
      }
    }
    // mirino della selezione
    const sel = selectedId ? this.items.get(selectedId) : undefined;
    if (sel && sel.onScreen) {
      const r = Math.max(9, sel.px + 7);
      // il mirino serve a ritrovare un corpo piccolo: quando il corpo è grande sullo schermo
      // sparisce piano piano (da 20 a 60 pixel di raggio), così non resta un anello attorno al disco
      const fade = Math.max(0, Math.min(1, (60 - sel.px) / 40));
      const key = `${fade.toFixed(3)}|${r.toFixed(1)}|${sel.x.toFixed(1)}|${sel.y.toFixed(1)}`;
      if (key !== this.reticleKey) {
        this.reticleKey = key;
        this.reticle.style.opacity = fade.toFixed(3);
        this.reticle.style.display = fade > 0 ? '' : 'none';
        this.reticle.style.width = this.reticle.style.height = `${2 * r}px`;
        this.reticle.style.transform = `translate3d(${(sel.x - r).toFixed(1)}px, ${(sel.y - r).toFixed(1)}px, 0)`;
      }
      if (this.reticleFor !== selectedId) {
        this.reticleFor = selectedId;
        this.reticle.classList.remove('arrive');
        void this.reticle.offsetWidth; // riavvia l'animazione
        this.reticle.classList.add('arrive');
      }
    } else {
      if (this.reticleKey !== 'off') {
        this.reticleKey = 'off';
        this.reticle.style.display = 'none';
      }
      if (!selectedId) this.reticleFor = null;
    }
  }

  /** Corpo più vicino a un punto dello schermo (entro tol pixel). */
  pick(x: number, y: number, tol = 12): Body | null {
    let best: Item | null = null;
    let bestD = tol;
    for (const it of this.items.values()) {
      if (!it.onScreen) continue;
      const d = Math.hypot(it.x - x, it.y - y) - it.px;
      if (d < bestD) {
        bestD = d;
        best = it;
      }
    }
    return best?.body ?? null;
  }
}
