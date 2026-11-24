/** Linee delle orbite (orbita osculatrice calcolata dallo stato attuale) e scie delle sonde. */

import { Color, type Mesh, Vector3 } from 'three';
import type { Body } from '../sim/body';
import { M_ICRF_TO_SCENE } from '../core/frames';
import { AU_KM } from '../core/units';
import { orbitPoints, osculating, type Osculating } from '../ephem/kepler';
import { api } from '../data/api';
import { ThickLine } from './lines';
import { thinTrail } from './trailthin';
import type { FrameCtx } from './bodyvisual';

const N = 720;

/** numero di segmenti per un'orbita grande `px` pixel sullo schermo (a gradini, per non ricostruire spesso) */
function segmentsFor(px: number): number {
  if (px > 900) return 720;
  if (px > 400) return 480;
  if (px > 150) return 240;
  return 120;
}
const _r = new Vector3();
const _v = new Vector3();

export const KIND_COLORS: Record<string, string> = {
  star: '#fff1d6',
  planet: '#e9e6dc',
  dwarf: '#d9c7a8',
  moon: '#a9b6cc',
  asteroid: '#b8a48a',
  comet: '#86dbe0',
  spacecraft: '#b79cff',
  satellite: '#77b6ff',
  barycenter: '#888888',
  galaxy: '#f2e6cc',
  blackhole: '#ffb36b',
  nebula: '#ff9fb5',
  cluster: '#bcd0ff',
  arm: '#9fb8ff',
};

export class OrbitLine {
  readonly thick: ThickLine;
  /** l'oggetto da aggiungere alla scena */
  readonly line: Mesh;
  osc: Osculating | null = null;
  private frame = 0;
  pxSize = 0;
  /** opacità mostrata ora: segue con dolcezza quella voluta (niente scatti) */
  private shown = 0;

  constructor(readonly body: Body) {
    this.thick = new ThickLine(N + 1, new Color(KIND_COLORS[body.kind] ?? '#ffffff'), 0.4);
    this.line = this.thick.mesh;
  }

  update(ctx: FrameCtx, opts: { highlighted: boolean; force: boolean; enabled: boolean; bodyPx?: number }): void {
    const b = this.body;
    const parent = b.parent;
    const mu = b.muAroundParent;
    if (!opts.enabled || !b.valid || !parent || !parent.valid || mu <= 0) {
      this.line.visible = false;
      this.shown = 0;
      return;
    }
    this.line.position.subVectors(parent.scenePos, ctx.camPos);
    const dist = Math.max(this.line.position.length(), 1);
    // ottimizzazione: se l'orbita (con la forma già nota) sarebbe troppo piccola a schermo
    // per essere disegnata, non si ricalcola nulla
    if (this.osc && !opts.highlighted) {
      const size0 = this.osc.e < 1 ? this.osc.a : this.osc.q * 3;
      if ((size0 / dist) * ctx.pxPerRad < 6) {
        this.line.visible = false;
        this.shown = 0;
        return;
      }
    }
    if (opts.force || this.frame++ % 3 === 0 || !this.osc) {
      _r.copy(b.relPos).applyMatrix3(M_ICRF_TO_SCENE);
      _v.copy(b.relVel).applyMatrix3(M_ICRF_TO_SCENE);
      const osc = osculating(_r, _v, mu);
      // la geometria si ricostruisce solo se l'orbita o la posizione lungo l'orbita sono
      // cambiate in modo visibile (mezzo segmento della linea)
      // segmenti in proporzione alla grandezza sullo schermo: un'orbita di 50 pixel non ne ha
      // bisogno di 720 (e la scheda video lavora meno)
      const seg = osc ? segmentsFor(this.pxSizeOf(osc, dist, ctx.pxPerRad)) : N;
      if (osc && (this.needsRebuild(osc) || seg !== this.segments)) {
        this.segments = seg;
        const maxR = Math.max(60 * AU_KM, osc.q * 40);
        const { pts, alpha, count } = orbitPoints(osc, seg, maxR);
        this.thick.setPoints(pts, alpha, count);
        this.built = { a: osc.a, e: osc.e, nu: osc.nu, P: osc.P.clone(), W: osc.W.clone() };
      }
      this.osc = osc;
    }
    if (!this.osc) {
      this.line.visible = false;
      return;
    }
    // dimensione apparente dell'orbita: le orbite troppo piccole sullo schermo si nascondono
    const size = this.osc.e < 1 ? this.osc.a : this.osc.q * 3;
    this.pxSize = (size / dist) * ctx.pxPerRad;
    const fade = Math.min(1, Math.max(0, (this.pxSize - 6) / 30));
    const base = opts.highlighted ? 0.9 : this.body.kind === 'planet' ? 0.3 : 0.22;
    // vicino al corpo la sua orbita diventa una linea che lo attraversa: meglio nasconderla
    const near = Math.max(0, Math.min(1, ((opts.bodyPx ?? 0) - 12) / 30));
    // stelle S: a pochi raggi dal buco nero le loro orbite (grandi centinaia di UA) sarebbero
    // solo linee dritte che attraversano lo schermo
    const inside = this.body.data.sky_orbit ? Math.min(1, Math.max(0, (dist / (size * 0.02) - 1) / 2)) : 1;
    const target = (opts.highlighted ? base : base * fade) * (1 - near) * inside;
    // l'opacità insegue quella voluta in un paio di decimi di secondo: una linea non
    // compare né sparisce mai di colpo
    const k = 1 - Math.exp(-(ctx.dt ?? 1 / 60) / 0.12);
    this.shown += (target - this.shown) * k;
    if (Math.abs(target - this.shown) < 0.003) this.shown = target;
    this.thick.opacity = this.shown;
    this.thick.width = opts.highlighted ? 2.0 : 1.3;
    this.thick.glow = opts.highlighted ? 1 : 0;
    this.line.visible = this.shown > 0.004 && near < 0.99;
  }

  /** ultima orbita usata per costruire la linea */
  private built: { a: number; e: number; nu: number; P: Vector3; W: Vector3 } | null = null;
  private segments = N;

  private pxSizeOf(o: Osculating, dist: number, pxPerRad: number): number {
    const size = o.e < 1 ? o.a : o.q * 3;
    return (size / dist) * pxPerRad;
  }

  private needsRebuild(o: Osculating): boolean {
    const p = this.built;
    if (!p) return true;
    let dnu = Math.abs(o.nu - p.nu);
    if (dnu > Math.PI) dnu = 2 * Math.PI - dnu;
    return dnu > Math.PI / this.segments
      || Math.abs(o.a / p.a - 1) > 2e-4
      || Math.abs(o.e - p.e) > 2e-4
      || o.P.dot(p.P) < 0.99999998
      || o.W.dot(p.W) < 0.99999998;
  }

  dispose(): void {
    this.thick.dispose();
  }
}

/**
 * Traiettoria storica di una sonda (dal lancio a oggi, più un tratto futuro).
 *
 * Due accorgimenti per le traiettorie lunghissime (Voyager 1 è a oltre 160 UA):
 * - i punti si mandano alla scheda video già riferiti alla camera (calcolati in doppia
 *   precisione): in virgola mobile a 32 bit, a miliardi di km dal Sole la posizione di un
 *   punto ha un errore di migliaia di km, e da vicino la linea "balla" e si spezza;
 * - si tengono solo i punti che servono a disegnarla con l'errore di mezzo pixel (vedi
 *   trailthin.ts): segmenti più corti di un pixel non coprono i pixel in modo continuo e la
 *   linea diventa una fila di puntini che sfarfallano quando la vista si muove.
 */
export class TrailLine {
  readonly thick: ThickLine;
  readonly line: Mesh;
  private jds: Float64Array | null = null;
  /** posizioni in coordinate di scena rispetto al centro (doppia precisione) */
  private src: Float64Array | null = null;
  private alphaBuf: Float32Array | null = null;
  private shown = 0;
  private lastAlphaJd = 0;
  /** distanza massima della traiettoria dal suo centro (km), per nasconderla quando è minuscola a schermo */
  private extent = 0;
  /** posizione della camera (rispetto al centro) quando la linea è stata ricostruita */
  private builtCam = new Vector3(Infinity, 0, 0);
  private builtNear = 0;
  private builtPx = 0;
  private dirty = true;
  private withNow = new Float64Array(0);
  private alphaNow = new Float32Array(0);
  /** posizione attuale della sonda rispetto al centro, se dentro l'intervallo della traiettoria */
  private nowJd = NaN;
  private nowPos = new Vector3();
  private outPts = new Float32Array(0);
  private outAlpha = new Float32Array(0);
  loading = false;
  loaded = false;
  failed = false;
  centerId = 'naif:10';

  constructor(readonly body: Body) {
    this.thick = new ThickLine(2, new Color(KIND_COLORS.spacecraft), 0.55, 1.3);
    this.line = this.thick.mesh;
    this.line.visible = false;
    const c = body.data.trail?.center ?? body.data.horizons?.center ?? '500@10';
    const m = /@(-?\d+)/.exec(c);
    this.centerId = m ? (m[1] === '0' ? 'ssb' : `naif:${m[1]}`) : 'naif:10';
  }

  /** una traiettoria alla volta: non deve rubare connessioni alle posizioni */
  private static queue: TrailLine[] = [];
  private static busy = false;
  private static next(): void {
    if (TrailLine.busy) return;
    const t = TrailLine.queue.shift();
    if (!t) return;
    TrailLine.busy = true;
    void t.fetch().finally(() => {
      TrailLine.busy = false;
      TrailLine.next();
    });
  }

  load(first = false): void {
    if (this.loaded) return;
    const q = TrailLine.queue;
    if (this.loading) {
      // la sonda selezionata passa davanti alle altre ancora in attesa
      const i = q.indexOf(this);
      if (first && i > 0) q.unshift(...q.splice(i, 1));
      return;
    }
    this.loading = true;
    if (first) q.unshift(this);
    else q.push(this);
    TrailLine.next();
  }

  private async fetch(): Promise<void> {
    try {
      const res = await api.trail(this.body.id);
      const rows = res.rows ?? [];
      const n = Math.floor(rows.length / 7);
      if (n < 2) {
        this.failed = true;
        return;
      }
      const pos = new Float64Array(n * 3);
      this.jds = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        _r.set(rows[i * 7 + 1], rows[i * 7 + 2], rows[i * 7 + 3]).applyMatrix3(M_ICRF_TO_SCENE);
        pos[i * 3] = _r.x;
        pos[i * 3 + 1] = _r.y;
        pos[i * 3 + 2] = _r.z;
        this.jds[i] = rows[i * 7];
        this.extent = Math.max(this.extent, _r.length());
      }
      this.src = pos;
      this.alphaBuf = new Float32Array(n).fill(0.5);
      // un posto in più: la posizione attuale della sonda, inserita fra i due punti vicini
      // (così la linea passa esattamente per la sonda anche vista da pochi metri)
      this.withNow = new Float64Array((n + 1) * 3);
      this.alphaNow = new Float32Array(n + 1);
      this.outPts = new Float32Array((n + 1) * 3);
      this.outAlpha = new Float32Array(n + 1);
      this.dirty = true;
      this.loaded = true;
    } catch {
      this.failed = true;
    } finally {
      this.loading = false;
    }
  }

  /**
   * Ricostruisce la linea vista dalla camera `cam` (rispetto al centro): punti riferiti alla
   * camera, tenendo solo quelli che si discostano dalla linea semplificata più di `tolPx` pixel.
   * Restituisce il numero di punti tenuti.
   */
  rebuild(cam: Vector3, pxPerRad: number, tolPx = 0.5): number {
    let src = this.src;
    let al: ArrayLike<number> | null = this.alphaBuf;
    const jds = this.jds;
    if (!src || !al || !jds) return 0;
    const n = jds.length;
    if (Number.isFinite(this.nowJd) && this.nowJd > jds[0] && this.nowJd < jds[n - 1]) {
      // primo punto successivo a "adesso"
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (jds[mid] <= this.nowJd) lo = mid;
        else hi = mid;
      }
      const w = this.withNow, wa = this.alphaNow;
      w.set(src.subarray(0, hi * 3), 0);
      w[hi * 3] = this.nowPos.x;
      w[hi * 3 + 1] = this.nowPos.y;
      w[hi * 3 + 2] = this.nowPos.z;
      w.set(src.subarray(hi * 3), hi * 3 + 3);
      wa.set(this.alphaBuf!.subarray(0, hi), 0);
      wa[hi] = this.alphaBuf![lo];
      wa.set(this.alphaBuf!.subarray(hi), hi + 1);
      src = w;
      al = wa;
    }
    const { count: k, near } = thinTrail(src, al, cam.x, cam.y, cam.z, tolPx / Math.max(pxPerRad, 1e-9),
      this.outPts, this.outAlpha);
    this.thick.setPoints(this.outPts, this.outAlpha, k);
    this.builtCam.copy(cam);
    this.builtNear = near;
    this.builtPx = pxPerRad;
    this.dirty = false;
    return k;
  }

  update(ctx: FrameCtx, center: Body | undefined, enabled: boolean, highlighted: boolean): void {
    if (!enabled) {
      this.line.visible = false;
      this.shown = 0;
      return;
    }
    if (!this.loaded) {
      // si scarica solo quando la sonda ha già una posizione (evita richieste inutili all'avvio)
      if (this.body.valid && !this.failed) this.load(highlighted);
      this.line.visible = false;
      return;
    }
    if (!center || !center.valid) {
      this.line.visible = false;
      return;
    }
    // camera rispetto al centro della traiettoria
    const cam = _v.subVectors(ctx.camPos, center.scenePos);
    const b = this.body;
    if (b.valid) {
      const np = _r.subVectors(b.scenePos, center.scenePos);
      // la sonda si è spostata in modo visibile rispetto a quando è stata costruita la linea?
      if (!Number.isFinite(this.nowJd) || np.distanceTo(this.nowPos) > this.builtNear * 0.002) this.dirty = true;
      this.nowPos.copy(np);
      this.nowJd = ctx.jd;
    } else {
      this.nowJd = NaN;
    }
    // da distanze galattiche la traiettoria è un punto: inutile (e rischioso) disegnarla
    const px = (this.extent / Math.max(cam.length(), 1)) * ctx.pxPerRad;
    // sotto i 4 pixel la traiettoria sfuma via (e non si disegna più sotto i 2)
    const fade = Math.min(1, Math.max(0, (px - 2) / 6));
    const target = (highlighted ? 0.9 : 0.45) * fade;
    const k = 1 - Math.exp(-(ctx.dt ?? 1 / 60) / 0.12);
    this.shown += (target - this.shown) * k;
    if (Math.abs(target - this.shown) < 0.003) this.shown = target;
    this.line.visible = this.shown > 0.004;
    if (!this.line.visible) return;
    this.thick.opacity = this.shown;
    this.thick.width = highlighted ? 2.0 : 1.3;
    this.thick.glow = highlighted ? 1 : 0;
    if (this.jds && this.alphaBuf && Math.abs(ctx.jd - this.lastAlphaJd) > 0.5) {
      this.lastAlphaJd = ctx.jd;
      const a = this.alphaBuf;
      const t0 = this.jds[0];
      const span = Math.max(ctx.jd - t0, 1);
      for (let i = 0; i < this.jds.length; i++) {
        const t = this.jds[i];
        a[i] = t <= ctx.jd ? 0.25 + 0.75 * ((t - t0) / span) : 0.3;
      }
      this.dirty = true;
    }
    // si ricostruisce quando la camera si è spostata in modo apprezzabile rispetto alla
    // distanza dal punto più vicino della traiettoria (o quando cambia lo zoom dello schermo)
    const moved = cam.distanceTo(this.builtCam);
    const pxr = ctx.pxPerRad * ctx.pxScale;
    if (this.dirty || !(moved < this.builtNear * 0.003) || Math.abs(pxr / this.builtPx - 1) > 0.05) {
      this.rebuild(cam, pxr);
    }
    // i punti sono riferiti alla camera di quando è stata costruita la linea
    this.line.position.subVectors(this.builtCam, cam);
  }
}
