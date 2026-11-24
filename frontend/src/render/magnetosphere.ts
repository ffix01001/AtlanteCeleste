/**
 * Linee del campo magnetico dei pianeti (Mercurio, Terra, Giove, Saturno, Urano, Nettuno).
 *
 * Il calcolo è in fieldmodel.ts; qui si orienta il dipolo come il pianeta in quell'istante (il
 * dipolo gira con il pianeta: quello di Urano e di Nettuno "barcolla" a ogni rotazione), si
 * ricalcolano le linee quando il pianeta o il Sole si sono spostati di qualche decimo di grado,
 * e si disegnano due insiemi: le linee chiuse (azzurre) e quelle aperte della coda (viola).
 * Si vedono solo per il pianeta selezionato o inquadrato.
 */

import { Color, Group, Vector3 } from 'three';
import type { Body } from '../sim/body';
import { M_ICRF_TO_SCENE } from '../core/frames';
import { ThickLine } from './lines';
import { PlanetField, StarField, bodyFixed, dipoleStrength, type V3 } from './fieldmodel';
import type { FrameCtx } from './bodyvisual';

const _a = new Vector3();
const _c = new Vector3();
const _s = new Vector3();

class Magnetosphere {
  readonly closed = new ThickLine(2048, new Color('#7ad7ff'), 0, 1.1);
  readonly open = new ThickLine(2048, new Color('#b49cff'), 0, 1.1);
  private builtAxis = new Vector3();
  private builtSun = new Vector3();
  private lastBuild = -1e9;
  private built = false;
  shown = 0;

  constructor(readonly body: Body) {
    // attorno a una stella le linee si disegnano dopo il suo alone, altrimenti ne verrebbero coperte
    const order = body.data.magnetic?.model === 'source_surface' ? 3 : -1;
    this.closed.mesh.renderOrder = order;
    this.open.mesh.renderOrder = order;
    this.closed.visible = this.open.visible = false;
  }

  /** Asse del dipolo, centro e direzione del Sole nel sistema della scena. */
  private geometry(sun: Body): void {
    const m = this.body.data.magnetic!;
    const a = bodyFixed(m.pole_lat, m.pole_lon);
    _a.set(a[0], a[1], a[2]).applyMatrix3(this.body.orient).applyMatrix3(M_ICRF_TO_SCENE).normalize();
    _c.set(m.offset_r[0], m.offset_r[1], m.offset_r[2]).applyMatrix3(this.body.orient).applyMatrix3(M_ICRF_TO_SCENE);
    if (m.flow === 'corotation' && this.body.relVel.lengthSq() > 0) {
      // il plasma che gira con il pianeta è più veloce della luna e la investe da dietro:
      // "controvento" è la direzione opposta al moto orbitale
      _s.copy(this.body.relVel).applyMatrix3(M_ICRF_TO_SCENE).negate().normalize();
    } else if (m.model === 'source_surface') {
      _s.copy(_a); // nessun vento esterno: la direzione non conta, purché resti ferma
    } else {
      _s.subVectors(sun.scenePos, this.body.scenePos).normalize();
    }
  }

  private rebuild(): void {
    const m = this.body.data.magnetic!;
    const f = m.model === 'source_surface'
      ? new StarField([_a.x, _a.y, _a.z] as V3, m.magnetopause_r)
      : new PlanetField({
        axis: [_a.x, _a.y, _a.z] as V3, sign: m.moment_north ? 1 : -1, center: [_c.x, _c.y, _c.z] as V3,
        sun: [_s.x, _s.y, _s.z] as V3, rmp: m.magnetopause_r,
      });
    const R = this.body.radius;
    const star = m.model === 'source_surface';
    const fill = (line: ThickLine, list: { pts: number[] }[], fadeTail: boolean) => {
      const pts: number[] = [], al: number[] = [];
      for (const l of list) {
        const n = l.pts.length / 3;
        if (pts.length) { pts.push(0, 0, 0); al.push(-1); } // separatore
        for (let i = 0; i < n; i++) {
          pts.push(l.pts[i * 3] * R, l.pts[i * 3 + 1] * R, l.pts[i * 3 + 2] * R);
          // le linee della coda sfumano verso il fondo; tutte un po' più chiare vicino al pianeta
          const t = i / Math.max(1, n - 1);
          // (quelle di una stella sfumano più piano: sono dritte e lunghe, si perderebbero subito)
          al.push(!fadeTail ? 0.9 : star ? 0.2 + 0.7 * (1 - t) : Math.max(0, 1 - t) ** 1.5 * 0.95 + 0.05 * (1 - t));
        }
      }
      line.setPoints(pts, al, pts.length / 3);
    };
    const lines = f instanceof StarField ? f.lines(6) : f.lines(8);
    fill(this.closed, lines.filter((l) => l.closed), false);
    fill(this.open, lines.filter((l) => !l.closed), true);
    this.builtAxis.copy(_a);
    this.builtSun.copy(_s);
    this.built = true;
  }

  update(ctx: FrameCtx, sun: Body, wanted: boolean, now: number): void {
    const b = this.body;
    const m = b.data.magnetic!;
    const k = 1 - Math.exp(-(ctx.dt ?? 1 / 60) / 0.25);
    let target = 0;
    if (wanted && b.valid) {
      const dist = b.scenePos.distanceTo(ctx.camPos);
      // grandezza della magnetosfera sullo schermo: compare quando è grande almeno un pollice
      const px = ((m.magnetopause_r * b.radius) / Math.max(dist, 1)) * ctx.pxPerRad;
      target = Math.min(1, Math.max(0, (px - 40) / 80));
    }
    this.shown += (target - this.shown) * k;
    if (Math.abs(target - this.shown) < 0.003) this.shown = target;
    const vis = this.shown > 0.004;
    this.closed.visible = this.open.visible = vis && this.built;
    if (!vis && !wanted) return;
    if (!b.valid || !sun.valid) return;
    this.geometry(sun);
    // si ricalcola quando dipolo o Sole si sono spostati di qualche decimo di grado (al massimo
    // una volta ogni 250 ms: con il tempo accelerato il pianeta gira in fretta)
    const moved = !this.built || _a.angleTo(this.builtAxis) > 0.006 || _s.angleTo(this.builtSun) > 0.006;
    if (moved && now - this.lastBuild > 250) {
      this.lastBuild = now;
      this.rebuild();
      this.closed.visible = this.open.visible = vis;
    }
    for (const l of [this.closed, this.open]) l.mesh.position.subVectors(b.scenePos, ctx.camPos);
    this.closed.opacity = 0.55 * this.shown;
    this.open.opacity = 0.42 * this.shown;
  }
}

export class MagnetosphereLayer {
  readonly group = new Group();
  private items = new Map<string, Magnetosphere>();

  /** Quanto è visibile ora il campo di un corpo (0 = nascosto, 1 = pieno). */
  shownFor(id: string): number {
    return this.items.get(id)?.shown ?? 0;
  }

  /** `focus`: corpi selezionati o inquadrati (solo per loro si disegna il campo). */
  update(ctx: FrameCtx, bodies: Iterable<Body>, sun: Body, focus: Set<string>, enabled: boolean): void {
    const now = performance.now();
    for (const b of bodies) {
      if (!b.data.magnetic) continue;
      let it = this.items.get(b.id);
      const wanted = enabled && focus.has(b.id);
      if (!it) {
        if (!wanted) continue;
        it = new Magnetosphere(b);
        this.items.set(b.id, it);
        this.group.add(it.closed.mesh, it.open.mesh);
      }
      it.update(ctx, sun, wanted, now);
    }
  }
}

const _fa = new Vector3();
const _fc = new Vector3();
const _fp = new Vector3();

/**
 * Intensità del campo magnetico di un corpo (in nanotesla) nel punto `at` della scena, con il
 * modello del dipolo. `inside` è falso oltre la magnetopausa (o, per il Sole, oltre la superficie
 * sorgente): lì il campo del corpo non conta più, domina quello trascinato dal vento solare.
 */
export function fieldAt(b: Body, at: Vector3): { nT: number; inside: boolean } | null {
  const m = b.data.magnetic;
  if (!m?.b_eq_nt || !b.valid || !(b.radius > 0)) return null;
  const a = bodyFixed(m.pole_lat, m.pole_lon);
  _fa.set(a[0], a[1], a[2]).applyMatrix3(b.orient).applyMatrix3(M_ICRF_TO_SCENE).normalize();
  _fc.set(m.offset_r[0], m.offset_r[1], m.offset_r[2]).applyMatrix3(b.orient).applyMatrix3(M_ICRF_TO_SCENE);
  _fp.subVectors(at, b.scenePos).divideScalar(b.radius);
  const nT = dipoleStrength(m.b_eq_nt, [_fa.x, _fa.y, _fa.z], [_fc.x, _fc.y, _fc.z], [_fp.x, _fp.y, _fp.z]);
  return { nT, inside: _fp.length() <= m.magnetopause_r };
}
