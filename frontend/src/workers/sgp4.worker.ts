/// <reference lib="webworker" />
/**
 * Propagazione SGP4 di migliaia di satelliti in un thread separato,
 * così l'interfaccia resta fluida.
 */

import { json2satrec, type SatRec } from 'satellite.js';
import { sgp4At } from '../ephem/sgp4at';

let recs: (SatRec | null)[] = [];

self.onmessage = (ev: MessageEvent) => {
  const m = ev.data;
  if (m.type === 'init') {
    recs = (m.omms as any[]).map((o) => {
      try {
        return json2satrec(o);
      } catch {
        return null;
      }
    });
    (self as unknown as Worker).postMessage({ type: 'ready', count: recs.length });
    return;
  }
  if (m.type === 'propagate') {
    const n = recs.length;
    const pos = new Float32Array(n * 3);
    const vel = new Float32Array(n * 3);
    const ok = new Uint8Array(n);
    const M: number[] = m.matrix; // 3x3, riga per riga: TEME -> scena
    for (let i = 0; i < n; i++) {
      const r = recs[i];
      if (!r) continue;
      const pv = sgp4At(r, m.unixMs);
      if (!pv || typeof pv.position !== 'object' || typeof pv.velocity !== 'object') continue;
      const p = pv.position, v = pv.velocity;
      if (!Number.isFinite(p.x)) continue;
      pos[i * 3] = M[0] * p.x + M[1] * p.y + M[2] * p.z;
      pos[i * 3 + 1] = M[3] * p.x + M[4] * p.y + M[5] * p.z;
      pos[i * 3 + 2] = M[6] * p.x + M[7] * p.y + M[8] * p.z;
      vel[i * 3] = M[0] * v.x + M[1] * v.y + M[2] * v.z;
      vel[i * 3 + 1] = M[3] * v.x + M[4] * v.y + M[5] * v.z;
      vel[i * 3 + 2] = M[6] * v.x + M[7] * v.y + M[8] * v.z;
      ok[i] = 1;
    }
    (self as unknown as Worker).postMessage(
      { type: 'result', seq: m.seq, unixMs: m.unixMs, pos, vel, ok },
      [pos.buffer, vel.buffer, ok.buffer],
    );
  }
};
