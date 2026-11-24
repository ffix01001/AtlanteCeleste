/**
 * SGP4 a un istante qualsiasi, senza arrotondare il tempo al millisecondo.
 *
 * La funzione `propagate` di satellite.js riceve una data JavaScript, che conta solo i
 * millisecondi interi: in un millesimo di secondo un satellite in orbita bassa percorre quasi
 * 8 metri. Da lontano non conta, ma zoomando a pochi metri il satellite (e il suo punto)
 * avanzerebbero a scatti, e due calcoli dello stesso istante arrotondati in modo diverso
 * cadrebbero a 8 metri l'uno dall'altro. Qui il tempo dall'epoca degli elementi si calcola
 * in millisecondi con la virgola.
 */

import { sgp4, type SatRec } from 'satellite.js';

const UNIX_EPOCH_JD = 2440587.5;
const epochMs = new WeakMap<SatRec, number>();

/** Posizione e velocità (TEME, km e km/s) all'istante `unixMs` (millisecondi Unix, anche frazionari). */
export function sgp4At(rec: SatRec, unixMs: number): ReturnType<typeof sgp4> {
  let e = epochMs.get(rec);
  if (e === undefined) {
    e = (rec.jdsatepoch - UNIX_EPOCH_JD) * 86400000;
    epochMs.set(rec, e);
  }
  return sgp4(rec, (unixMs - e) / 60000);
}
