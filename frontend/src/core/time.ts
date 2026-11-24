/**
 * Tempo della simulazione.
 *
 * Internamente il tempo è in millisecondi Unix (l'ora civile: UTC). Per i calcoli
 * astronomici si converte in Giorno Giuliano nella scala TDB, la stessa usata
 * da JPL Horizons, che scorre uniforme. La differenza fra le due non è fissa, perché
 * la rotazione della Terra rallenta e ha i suoi capricci:
 *   - dal 1972 a oggi è nota esattamente: 32,184 s più i secondi intercalari (oggi 69,184 s);
 *   - nel passato è stata ricostruita dalle osservazioni (circa 2 minuti nel 1600, quasi zero
 *     attorno al 1900): formule di Espenak e Meeus, le stesse usate per l'elenco degli eventi;
 *   - nel futuro si può solo estrapolare (circa 24 minuti nel 2500).
 * Con un valore fisso, un'eclisse del 2400 sarebbe apparsa nella scena con un quarto d'ora di
 * scarto rispetto all'orario dell'elenco Eventi.
 */

import { DeltaT_EspenakMeeus } from 'astronomy-engine';

export const J2000 = 2451545.0;
export const UNIX_EPOCH_JD = 2440587.5;
/** TDB − UTC di oggi (37 secondi intercalari dal 2017, più 32,184 s) */
export const TDB_MINUS_UTC_S = 69.184;
export const DAY_S = 86400;

/** Secondi intercalari: da questa data (UTC), TAI − UTC vale tanti secondi. */
const LEAP: [number, number][] = ([
  [1972, 1, 10], [1972, 7, 11], [1973, 1, 12], [1974, 1, 13], [1975, 1, 14], [1976, 1, 15], [1977, 1, 16],
  [1978, 1, 17], [1979, 1, 18], [1980, 1, 19], [1981, 7, 20], [1982, 7, 21], [1983, 7, 22], [1985, 7, 23],
  [1988, 1, 24], [1990, 1, 25], [1991, 1, 26], [1992, 7, 27], [1993, 7, 28], [1994, 7, 29], [1996, 1, 30],
  [1997, 7, 31], [1999, 1, 32], [2006, 1, 33], [2009, 1, 34], [2012, 7, 35], [2015, 7, 36], [2017, 1, 37],
] as [number, number, number][]).map(([y, m, s]) => [Date.UTC(y, m - 1, 1), s]);
const LEAP_START_MS = LEAP[0][0];
/** fin qui si tiene il valore di oggi; poi si raccorda piano alla formula per il futuro */
const KNOWN_UNTIL_MS = Date.UTC(2030, 0, 1);
const BLEND_MS = 70 * 365.25 * 86400000;
const UNIX_MS_J2000 = (J2000 - UNIX_EPOCH_JD) * DAY_S * 1000;

function espenakMeeus(ms: number): number {
  return DeltaT_EspenakMeeus((ms - UNIX_MS_J2000) / 86400000);
}
const FUTURE_GAP_S = TDB_MINUS_UTC_S - espenakMeeus(KNOWN_UNTIL_MS);

/** TDB − UTC (secondi) in un certo istante, dato in millisecondi Unix. */
export function tdbMinusUtc(ms: number): number {
  if (ms >= KNOWN_UNTIL_MS) {
    // il raccordo si esaurisce in 70 anni: dal 2100 vale la formula, come nell'elenco degli eventi
    return espenakMeeus(ms) + FUTURE_GAP_S * Math.max(0, 1 - (ms - KNOWN_UNTIL_MS) / BLEND_MS);
  }
  if (ms >= LEAP_START_MS) {
    let s = LEAP[0][1];
    for (let i = LEAP.length - 1; i > 0; i--) {
      if (ms >= LEAP[i][0]) { s = LEAP[i][1]; break; }
    }
    return 32.184 + s;
  }
  return espenakMeeus(ms);
}

export function unixMsToJdTdb(ms: number): number {
  return UNIX_EPOCH_JD + (ms / 1000 + tdbMinusUtc(ms)) / DAY_S;
}

export function jdTdbToUnixMs(jd: number): number {
  const base = (jd - UNIX_EPOCH_JD) * DAY_S * 1000;
  // la differenza cambia lentissimamente: due passi bastano per arrivare al millisecondo
  let ms = base - TDB_MINUS_UTC_S * 1000;
  ms = base - tdbMinusUtc(ms) * 1000;
  return base - tdbMinusUtc(ms) * 1000;
}

/**
 * Istante da usare per l'angolo di rotazione della Terra. La Terra gira secondo l'ora civile,
 * non secondo il tempo uniforme: la formula di rotazione (tarata sui nostri anni) va quindi
 * calcolata come se la differenza fra i due fosse sempre quella di oggi. Così Roma è sotto il
 * Sole a mezzogiorno anche nel 1600 e nel 2500.
 */
export function earthRotationJd(jdTdb: number): number {
  return UNIX_EPOCH_JD + (jdTdbToUnixMs(jdTdb) / 1000 + TDB_MINUS_UTC_S) / DAY_S;
}

/** Limiti della simulazione: fuori da qui le effemeridi JPL non sono garantite. */
export const MIN_SIM_MS = Date.UTC(1600, 0, 1);
export const MAX_SIM_MS = Date.UTC(2500, 0, 1);

type Listener = () => void;

export class SimClock {
  simMs = Date.now();
  /** secondi simulati per secondo reale (negativo = indietro nel tempo) */
  rate = 1;
  paused = false;
  /** true = agganciato all'ora reale del computer */
  live = true;
  private lastReal = performance.now();
  private listeners: Listener[] = [];

  onChange(fn: Listener): void {
    this.listeners.push(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** Avanza il tempo; restituisce i secondi simulati trascorsi. */
  tick(): number {
    const now = performance.now();
    const dtReal = Math.min((now - this.lastReal) / 1000, 0.25);
    this.lastReal = now;
    if (this.paused) return 0;
    const before = this.simMs;
    if (this.live) {
      this.simMs = Date.now();
    } else {
      this.simMs += dtReal * this.rate * 1000;
    }
    if (this.simMs < MIN_SIM_MS || this.simMs > MAX_SIM_MS) {
      this.simMs = Math.min(Math.max(this.simMs, MIN_SIM_MS), MAX_SIM_MS);
      this.paused = true;
      this.emit();
    }
    return (this.simMs - before) / 1000;
  }

  get jd(): number {
    return unixMsToJdTdb(this.simMs);
  }

  setLive(): void {
    this.simMs = Date.now();
    this.rate = 1;
    this.paused = false;
    this.live = true;
    this.emit();
  }

  setRate(rate: number): void {
    this.rate = rate;
    this.live = rate === 1 && Math.abs(this.simMs - Date.now()) < 2000;
    this.paused = false;
    this.emit();
  }

  setTime(ms: number): void {
    this.simMs = Math.min(Math.max(ms, MIN_SIM_MS), MAX_SIM_MS);
    this.live = false;
    this.emit();
  }

  togglePause(): void {
    this.paused = !this.paused;
    if (this.paused) this.live = false;
    this.emit();
  }
}
