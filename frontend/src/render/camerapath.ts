/**
 * Matematica della navigazione: percorso morbido per inquadrare un corpo e velocità del volo libero.
 *
 * Percorso: metodo di van Wijk e Nuij ("Smooth and efficient zooming and panning", 2003).
 * Si muovono insieme il punto osservato (u, lungo la retta fra i due corpi) e la distanza della
 * camera (w). Il percorso è quello che, a velocità costante sullo schermo, si percorre nel minor
 * tempo: per i salti lunghi la camera si allontana, attraversa e si riavvicina; per quelli brevi
 * scivola quasi dritta. Così il corpo di arrivo entra nell'inquadratura presto e non "scatta"
 * in vista solo negli ultimi istanti.
 */

/** Rapporto fra zoom e spostamento: √2 è il valore che van Wijk e Nuij trovano più naturale. */
export const RHO = 1.4;

export interface ZoomPath {
  /** lunghezza del percorso (adimensionale): serve a scegliere la durata */
  S: number;
  /** frazione (0..1) della distanza fra i due punti osservati, al parametro s ∈ [0, S] */
  u(s: number): number;
  /**
   * 1 − u(s), calcolato dalla parte dell'arrivo. Vicino all'arrivo serve questo: da Andromeda
   * alla Terra (2,4 × 10¹⁹ km) l'ultima cifra di u vale da sola migliaia di km e la vista tremerebbe.
   */
  v(s: number): number;
  /** distanza della camera al parametro s */
  w(s: number): number;
}

/**
 * u1: distanza fra il punto osservato di partenza e quello di arrivo (km)
 * w0, w1: distanza della camera all'inizio e alla fine (km)
 */
export function zoomPath(u1: number, w0: number, w1: number, rho = RHO): ZoomPath {
  const r2 = rho * rho;
  // quasi nessuno spostamento: solo zoom, esponenziale
  if (!(u1 > 1e-9 * Math.max(w0, w1))) {
    const k = w1 >= w0 ? 1 : -1;
    const S = Math.abs(Math.log(w1 / w0)) / rho;
    return { S, u: () => 1, v: () => 0, w: (s) => (S > 0 ? w0 * Math.exp(k * rho * s) : w0) };
  }
  const b0 = (w1 * w1 - w0 * w0 + r2 * r2 * u1 * u1) / (2 * w0 * r2 * u1);
  const b1 = (w1 * w1 - w0 * w0 - r2 * r2 * u1 * u1) / (2 * w1 * r2 * u1);
  // ln(-b + √(b²+1)) = -asinh(b): la seconda forma non perde cifre quando b è enorme
  const r0 = -Math.asinh(b0);
  const r1 = -Math.asinh(b1);
  const S = (r1 - r0) / rho;
  const c0 = Math.cosh(r0);
  // u = (w0/ρ²)(cosh r0 · tanh(ρs + r0) − sinh r0) / u1, scritto come sinh(ρs) / cosh(ρs + r0):
  // stesso valore, ma senza sottrarre due numeri enormi quasi uguali
  return {
    S,
    u: (s) => {
      if (s >= S) return 1;
      if (s <= 0) return 0;
      return ((w0 / r2) * Math.sinh(rho * s)) / Math.cosh(rho * s + r0) / u1;
    },
    // il percorso al contrario è lo stesso percorso: da B verso A con r0' = −r1
    v: (s) => {
      if (s >= S) return 0;
      if (s <= 0) return 1;
      const q = S - s;
      return ((w1 / r2) * Math.sinh(rho * q)) / Math.cosh(rho * q - r1) / u1;
    },
    w: (s) => {
      if (s >= S) return w1;
      if (s <= 0) return w0;
      return (w0 * c0) / Math.cosh(rho * s + r0);
    },
  };
}

/** Durata in secondi di un volo di lunghezza S: lunga abbastanza da seguirlo, mai noiosa. */
export function flightDuration(S: number): number {
  return Math.min(4.5, Math.max(0.9, 0.9 + 0.55 * Math.sqrt(Math.max(0, S))));
}

/** Avvio e arrivo dolci: velocità e accelerazione nulle agli estremi (quintica di Perlin). */
export function smoother(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/** Frazione da usare in un fotogramma di dt secondi per avvicinarsi a un valore con costante di tempo tau. */
export function follow(dt: number, tau: number): number {
  return tau <= 0 ? 1 : 1 - Math.exp(-dt / tau);
}

/**
 * Velocità del volo libero (km/s) quando si tiene premuto "avanti", alla distanza `gap` (km)
 * dalla superficie più vicina. In un secondo si percorre la distanza che manca alla superficie:
 * vicino a un asteroide si va piano, fra le stelle velocissimi, e non ci si schianta mai.
 */
export function cruiseSpeed(gap: number, mul: number, boost: boolean): number {
  return Math.max(gap, 0.005) * mul * (boost ? 5 : 1);
}
