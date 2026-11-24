/** L'insieme dei corpi, organizzati ad albero e aggiornati a ogni fotogramma. */

import type { Vector3 } from 'three';
import type { CatalogBody } from '../data/types';
import { Emitter } from '../core/events';
import { chunkIndex, EphemerisLoader, JplEphemeris } from '../ephem/jpl';
import { Body } from './body';

export class Universe {
  readonly bodies = new Map<string, Body>();
  readonly aliases = new Map<string, string>();
  ordered: Body[] = [];
  root!: Body;
  sun!: Body;
  earth!: Body;
  readonly loader = new EphemerisLoader();
  readonly changed = new Emitter<void>();

  /** corpi "importanti" in questo momento (bersaglio della camera, selezione, ...) */
  focusIds = new Set<string>();
  jd = 0;
  rateDaysPerSec = 0;
  /** posizione della camera (scena, km): la aggiorna la grafica, serve al pannello informativo */
  cameraPos: Vector3 | null = null;

  constructor(catalog: CatalogBody[]) {
    for (const c of catalog) this.add(new Body(c), false);
    this.reorder();
    this.root = this.ordered.find((b) => b.parent === null)!;
    this.sun = this.bodies.get('naif:10')!;
    this.earth = this.bodies.get('naif:399')!;
    this.loader.isRelevant = (id, idx) => this.isChunkRelevant(id, idx);
  }

  private add(b: Body, reorder = true): void {
    this.bodies.set(b.id, b);
    for (const a of b.data.aliases ?? []) this.aliases.set(a, b.id);
    if (b.data.horizons) b.jpl = new JplEphemeris(b.id, this.loader);
    if (reorder) this.reorder();
  }

  addDynamic(b: Body): void {
    b.dynamic = true;
    this.add(b);
    this.changed.emit();
  }

  removeDynamic(b: Body): void {
    if (!b.dynamic) return;
    this.bodies.delete(b.id);
    this.reorder();
    this.changed.emit();
  }

  get(id: string): Body | undefined {
    return this.bodies.get(id) ?? this.bodies.get(this.aliases.get(id) ?? '');
  }

  /** Ricostruisce l'albero e l'ordine (prima i padri, poi i figli). */
  private reorder(): void {
    for (const b of this.bodies.values()) b.children = [];
    for (const b of this.bodies.values()) {
      const pid = b.data.parent;
      b.parent = pid ? this.bodies.get(pid) ?? null : null;
      b.parent?.children.push(b);
    }
    const out: Body[] = [];
    const visit = (b: Body) => {
      out.push(b);
      for (const c of b.children) visit(c);
    };
    for (const b of this.bodies.values()) if (!b.parent) visit(b);
    this.ordered = out;
  }

  priorityOf(b: Body): number {
    if (this.focusIds.has(b.id)) return 0;
    if (b.parent && this.focusIds.has(b.parent.id)) return 1;
    return 2 + b.rank * 2 + (b.kind === 'spacecraft' ? 1 : 0);
  }

  private isImportant(b: Body): boolean {
    return b.rank <= 1 || this.focusIds.has(b.id) || (b.parent !== null && this.focusIds.has(b.parent.id));
  }

  private isChunkRelevant(id: string, idx: number): boolean {
    const b = this.bodies.get(id);
    if (!b) return false;
    const cur = chunkIndex(this.jd);
    if (Math.abs(idx - cur) > 1) return false;
    // durante i viaggi veloci nel tempo si chiedono solo i corpi importanti
    if (Math.abs(this.rateDaysPerSec) > 4 && !this.isImportant(b)) return false;
    return true;
  }

  update(jd: number, rateSimSecPerSec: number): void {
    this.jd = jd;
    this.rateDaysPerSec = rateSimSecPerSec / 86400;
    this.loader.direction = Math.sign(rateSimSecPerSec);
    for (const b of this.ordered) {
      if (b.isRoot) {
        b.valid = true;
        b.finalize(jd);
        continue;
      }
      const parentOk = b.parent!.valid;
      const ok = parentOk && b.computeRel(jd, this.priorityOf(b));
      b.valid = ok;
      if (ok) b.finalize(jd);
    }
  }

  /** Statistiche per la barra di stato. */
  jplStats(): { withData: number; total: number } {
    let withData = 0, total = 0;
    for (const b of this.bodies.values()) {
      if (!b.jpl || b.jpl.unavailable) continue;
      total++;
      if (b.jpl.hasDataAt(this.jd)) withData++;
    }
    return { withData, total };
  }
}
