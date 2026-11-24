/**
 * Effemeridi JPL Horizons a blocchi + interpolazione di Hermite.
 *
 * Il server divide il tempo in blocchi fissi (32 giorni da J2000). Ogni blocco
 * contiene posizioni e velocità campionate a passo costante; tra un campione e
 * l'altro si usa un polinomio di Hermite cubico che rispetta sia le posizioni
 * sia le velocità: l'errore è di pochi km anche per le lune più veloci.
 */

import { t } from '../core/i18n';
import { Vector3 } from 'three';
import { api } from '../data/api';
import type { EphemChunk } from '../data/types';
import { J2000 } from '../core/time';

export let CHUNK_DAYS = 32;
export function setChunkDays(d: number): void {
  CHUNK_DAYS = d;
}

export function chunkIndex(jd: number): number {
  return Math.floor((jd - J2000) / CHUNK_DAYS);
}

class ChunkTable {
  readonly rows: Float64Array;
  readonly n: number;
  readonly t0: number;
  readonly t1: number;
  constructor(flat: number[]) {
    this.rows = Float64Array.from(flat);
    this.n = this.rows.length / 7;
    this.t0 = this.rows[0];
    this.t1 = this.rows[(this.n - 1) * 7];
  }

  sample(jd: number, pos: Vector3, vel: Vector3): boolean {
    if (this.n < 2 || jd < this.t0 || jd > this.t1) return false;
    const r = this.rows;
    // stima diretta dell'indice (passo costante) e correzione
    let i = Math.floor(((jd - this.t0) / (this.t1 - this.t0)) * (this.n - 1));
    i = Math.max(0, Math.min(this.n - 2, i));
    while (i > 0 && r[i * 7] > jd) i--;
    while (i < this.n - 2 && r[(i + 1) * 7] < jd) i++;
    const a = i * 7, b = a + 7;
    const ta = r[a], tb = r[b];
    const h = tb - ta;
    const s = h > 0 ? (jd - ta) / h : 0;
    const dt = h * 86400; // secondi: le velocità sono in km/s
    const s2 = s * s, s3 = s2 * s;
    const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
    const d00 = 6 * s2 - 6 * s, d10 = 3 * s2 - 4 * s + 1, d01 = -6 * s2 + 6 * s, d11 = 3 * s2 - 2 * s;
    pos.set(
      h00 * r[a + 1] + h10 * dt * r[a + 4] + h01 * r[b + 1] + h11 * dt * r[b + 4],
      h00 * r[a + 2] + h10 * dt * r[a + 5] + h01 * r[b + 2] + h11 * dt * r[b + 5],
      h00 * r[a + 3] + h10 * dt * r[a + 6] + h01 * r[b + 3] + h11 * dt * r[b + 6],
    );
    vel.set(
      (d00 * r[a + 1] + d10 * dt * r[a + 4] + d01 * r[b + 1] + d11 * dt * r[b + 4]) / dt,
      (d00 * r[a + 2] + d10 * dt * r[a + 5] + d01 * r[b + 2] + d11 * dt * r[b + 5]) / dt,
      (d00 * r[a + 3] + d10 * dt * r[a + 6] + d01 * r[b + 3] + d11 * dt * r[b + 6]) / dt,
    );
    return true;
  }
}

type ChunkState = ChunkTable | 'loading' | 'empty' | 'error';

export class JplEphemeris {
  readonly chunks = new Map<number, ChunkState>();
  notBefore: number | null = null;
  notAfter: number | null = null;
  lastError: string | null = null;
  /** true quando JPL non conosce questo oggetto: inutile riprovare */
  unavailable = false;

  constructor(readonly bodyId: string, private loader: EphemerisLoader) {}

  inRange(jd: number): boolean {
    if (this.unavailable) return false;
    if (this.notBefore !== null && jd < this.notBefore) return false;
    if (this.notAfter !== null && jd > this.notAfter) return false;
    return true;
  }

  sample(jd: number, pos: Vector3, vel: Vector3, priority: number): boolean {
    if (!this.inRange(jd)) return false;
    const idx = chunkIndex(jd);
    const st = this.chunks.get(idx);
    if (st === undefined) {
      this.loader.request(this, idx, priority);
    } else if (st instanceof ChunkTable) {
      // precarica il blocco vicino quando ci si avvicina al bordo
      const frac = (jd - (J2000 + idx * CHUNK_DAYS)) / CHUNK_DAYS;
      // (solo nella direzione in cui scorre il tempo: all'avvio non serve il blocco precedente)
      const dir = this.loader.direction;
      if (dir >= 0 && frac > 0.8 && !this.chunks.has(idx + 1)) this.loader.request(this, idx + 1, priority + 1);
      if (dir <= 0 && frac < 0.2 && !this.chunks.has(idx - 1)) this.loader.request(this, idx - 1, priority + 1);
      if (st.sample(jd, pos, vel)) return true;
      // fuori dal blocco (copertura parziale): prova i vicini
      const other = this.chunks.get(jd < st.t0 ? idx - 1 : idx + 1);
      if (other instanceof ChunkTable) return other.sample(jd, pos, vel);
    }
    return false;
  }

  hasDataAt(jd: number): boolean {
    const st = this.chunks.get(chunkIndex(jd));
    return st instanceof ChunkTable;
  }

  accept(idx: number, res: EphemChunk): void {
    if (res.rows && res.rows.length >= 14) {
      this.chunks.set(idx, new ChunkTable(res.rows));
      this.lastError = null;
    } else if (res.available) {
      this.chunks.set(idx, 'empty');
      if (res.available.not_before) this.notBefore = Math.max(this.notBefore ?? -Infinity, res.available.not_before);
      if (res.available.not_after) this.notAfter = Math.min(this.notAfter ?? Infinity, res.available.not_after);
    } else {
      if (res.transient) this.chunks.delete(idx);
      else this.chunks.set(idx, 'error');
      this.lastError = res.error ?? t('Errore sconosciuto');
      if (res.error && /non trovato|ambiguo|Nessuna effemeride/i.test(res.error)) this.unavailable = true;
    }
    this.prune(idx);
  }

  private prune(center: number): void {
    if (this.chunks.size <= 10) return;
    const keys = [...this.chunks.keys()].sort((a, b) => Math.abs(b - center) - Math.abs(a - center));
    for (const k of keys.slice(0, this.chunks.size - 10)) {
      const st = this.chunks.get(k);
      if (st !== 'loading') this.chunks.delete(k);
    }
  }
}

interface Job {
  eph: JplEphemeris;
  idx: number;
  priority: number;
}

/** Coda delle richieste al server, con priorità e scarto delle richieste superate. */
export class EphemerisLoader {
  private queue: Job[] = [];
  private active = 0;
  maxActive = 3;
  loaded = 0;
  failed = 0;
  lastError: string | null = null;
  networkDown = false;
  /** verso in cui scorre il tempo simulato: 1 avanti, -1 indietro, 0 in pausa */
  direction = 1;
  /** restituisce false se il blocco non serve più (es. il tempo è andato avanti) */
  isRelevant: (bodyId: string, idx: number) => boolean = () => true;
  onLoaded: () => void = () => {};

  get pending(): number {
    return this.queue.length + this.active;
  }

  request(eph: JplEphemeris, idx: number, priority: number): void {
    if (eph.chunks.has(idx)) return;
    eph.chunks.set(idx, 'loading');
    this.queue.push({ eph, idx, priority });
    this.pump();
  }

  private pump(): void {
    while (this.active < this.maxActive && this.queue.length) {
      this.queue.sort((a, b) => a.priority - b.priority);
      const job = this.queue.shift()!;
      if (!this.isRelevant(job.eph.bodyId, job.idx)) {
        job.eph.chunks.delete(job.idx);
        continue;
      }
      this.active++;
      api.ephem(job.eph.bodyId, job.idx)
        .then((res) => {
          job.eph.accept(job.idx, res);
          if (res.rows?.length) {
            this.loaded++;
            this.networkDown = false;
          } else if (res.error) {
            this.failed++;
            this.lastError = res.error;
            if (res.transient) this.networkDown = true;
          }
        })
        .catch((err: Error) => {
          job.eph.chunks.delete(job.idx);
          this.failed++;
          this.lastError = err.message;
          this.networkDown = true;
        })
        .finally(() => {
          this.active--;
          this.onLoaded();
          // dopo un errore di rete si rallenta per non insistere
          setTimeout(() => this.pump(), this.networkDown ? 5000 : 0);
        });
    }
  }
}
