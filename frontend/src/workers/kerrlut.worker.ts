/// <reference lib="webworker" />
/**
 * Tabella della deviazione della luce attorno al buco nero che ruota, calcolata in un thread
 * separato (un decimo di secondo ogni volta che la camera cambia distanza o latitudine).
 */

import { kerrLut } from '../core/kerrgeo';

self.onmessage = (ev: MessageEvent) => {
  const m = ev.data as { id: number; a: number; rho: number; z: number; psiMax: number; nChi: number; nT: number };
  const lut = kerrLut(m.a, m.rho, m.z, m.psiMax, m.nChi, m.nT);
  (self as unknown as Worker).postMessage({ ...m, data: lut.data }, [lut.data.buffer]);
};
