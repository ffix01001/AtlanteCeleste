/**
 * Modello del campo magnetico di un pianeta, per disegnarne le linee di campo.
 *
 * Tre parti, sommate:
 *   1. il dipolo del pianeta, inclinato e spostato dal centro come quello misurato;
 *   2. un "dipolo immagine" oltre la magnetopausa (Chapman e Ferraro, 1931): il vento solare
 *      non lascia uscire il campo verso il Sole, che sul lato giorno resta schiacciato;
 *   3. lo strato di corrente della coda (modello di Harris): sul lato notte le linee vengono
 *      stirate lontano dal Sole in due lobi, sopra e sotto lo strato.
 * Le linee si tracciano numericamente (Runge-Kutta di ordine 4) partendo dalla superficie.
 *
 * Unità: raggi del pianeta. Vettori: [x, y, z] in un qualunque sistema fisso (quello della scena).
 * Il modulo è puro calcolo, senza three.js, così si prova con i test.
 */

export type V3 = [number, number, number];

export interface FieldSetup {
  /** asse del dipolo (unitario): verso il polo magnetico "nord" del pianeta (emisfero nord) */
  axis: V3;
  /** +1 se il momento magnetico punta verso quel polo (come Giove), −1 se opposto (come la Terra) */
  sign: number;
  /** centro del dipolo rispetto al centro del pianeta */
  center: V3;
  /** verso il Sole (unitario) */
  sun: V3;
  /** distanza della magnetopausa sul lato giorno */
  rmp: number;
}

export interface FieldLine {
  pts: number[];       // x, y, z, x, y, z, ...
  closed: boolean;     // torna sul pianeta (linea chiusa) o finisce nella coda (aperta)
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.sqrt(dot(a, a));
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a: V3): V3 => scale(a, 1 / (len(a) || 1));
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export class PlanetField {
  private m: V3;          // momento (unitario)
  private c: V3;
  private mi: V3;         // dipolo immagine
  private ci: V3;
  private s: V3;
  private n: V3;          // normale allo strato di corrente della coda
  private bt: number;     // intensità dei lobi della coda
  private dsheet: number; // mezzo spessore dello strato
  readonly rmp: number;
  readonly f: FieldSetup;

  constructor(f: FieldSetup) {
    this.f = f;
    this.s = norm(f.sun);
    this.m = scale(norm(f.axis), f.sign);
    this.c = f.center;
    this.rmp = f.rmp;
    // immagine riflessa nel piano della magnetopausa (perpendicolare al Sole, a distanza rmp):
    // così sul piano il campo non ha componente verso il Sole
    const off = f.rmp - dot(this.c, this.s);
    this.ci = add(this.c, scale(this.s, 2 * off));
    this.mi = sub(this.m, scale(this.s, 2 * dot(this.m, this.s)));
    // lo strato della coda contiene la direzione del Sole ed è "perpendicolare" al dipolo;
    // se il dipolo punta quasi al Sole (Urano in certe stagioni) si usa il piano dell'orbita
    let perp = sub(this.m, scale(this.s, dot(this.m, this.s)));
    if (len(perp) < 0.15) {
      const y: V3 = [0, Math.sign(this.m[1] || 1), 0];
      perp = add(perp, scale(sub(y, scale(this.s, dot(y, this.s))), 0.15));
    }
    this.n = norm(perp);
    this.bt = 1.5 / (f.rmp * f.rmp * f.rmp);
    this.dsheet = 0.12 * f.rmp;
  }

  /** Campo nel punto r (unità arbitrarie: al polo del pianeta vale circa 2). */
  field(r: V3): V3 {
    const b = dipole(r, this.c, this.m);
    const bi = dipole(r, this.ci, this.mi);
    const xs = dot(r, this.s);
    let out: V3 = add(b, bi);
    if (xs < 0) {
      // la coda si accende piano dal terminatore verso il lato notte
      const k = Math.min(1, -xs / (0.7 * this.rmp));
      const ramp = k * k * (3 - 2 * k);
      const zt = dot(sub(r, this.c), this.n);
      out = add(out, scale(this.s, -this.bt * Math.tanh(zt / this.dsheet) * ramp));
    }
    return out;
  }

  /** Dentro la magnetopausa? Forma di Shue: r = rmp (2 / (1 + cos θ))^0,55 */
  inside(r: V3): boolean {
    const d = len(r);
    const cos = dot(r, this.s) / (d || 1);
    return d < this.rmp * Math.pow(2 / Math.max(1 + cos, 1e-6), 0.55);
  }

  /**
   * Traccia una linea dal punto r0 (sulla superficie), verso l'esterno. Si ferma sul pianeta
   * (linea chiusa), oltre la magnetopausa o nella coda lontana (linea aperta).
   */
  trace(r0: V3, tailLength = 3.5): FieldLine {
    const b0 = this.field(r0);
    const dir = dot(b0, r0) >= 0 ? 1 : -1;
    const pts: number[] = [r0[0], r0[1], r0[2]];
    let r = r0;
    let closed = false;
    const step = (p: V3): V3 => {
      const b = this.field(p);
      return scale(b, dir / (len(b) || 1));
    };
    for (let i = 0; i < 4000; i++) {
      const d = len(r);
      const h = Math.min(Math.max(0.05 * d, 0.006), 0.1 * this.rmp);
      const k1 = step(r);
      const k2 = step(add(r, scale(k1, h / 2)));
      const k3 = step(add(r, scale(k2, h / 2)));
      const k4 = step(add(r, scale(k3, h)));
      const next = add(r, scale(add(add(k1, scale(k2, 2)), add(scale(k3, 2), k4)), h / 6));
      if (len(next) < 1) {
        // sul pianeta: punto finale proprio sulla superficie
        const a = len(r) - 1, b = 1 - len(next);
        const t = a / Math.max(a + b, 1e-9);
        const e = add(r, scale(sub(next, r), t));
        pts.push(e[0], e[1], e[2]);
        closed = true;
        break;
      }
      r = next;
      pts.push(r[0], r[1], r[2]);
      if (dot(r, this.s) < -tailLength * this.rmp) break;
      if (!this.inside(r)) break;
    }
    return { pts, closed };
  }

  /**
   * Un insieme di linee ben distribuito: alcune "fasce" (gusci L) chiuse e altre aperte nella coda,
   * su `nLon` meridiani magnetici a partire da mezzogiorno.
   */
  lines(nLon = 8): FieldLine[] {
    const a = norm(this.f.axis);
    let e1 = sub(this.s, scale(a, dot(this.s, a)));
    if (len(e1) < 1e-6) e1 = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    e1 = norm(sub(e1, scale(a, dot(e1, a))));
    const e2 = cross(a, e1);
    const R = this.rmp;
    const Ls = [1.5, 2.5, 0.25 * R, 0.45 * R, 0.7 * R, 1.0 * R, 1.6 * R, 3 * R, 8 * R]
      .filter((L) => L > 1.08)
      .sort((x, y) => x - y)
      .filter((L, i, arr) => i === 0 || L / arr[i - 1] > 1.15);
    const out: FieldLine[] = [];
    for (const hemi of [1, -1]) {
      for (const L of Ls) {
        const lat = Math.acos(Math.sqrt(1 / L)) * hemi;
        // le linee che possono finire nella coda (gusci grandi) si fittiscono: riempiono i lobi
        const n = L >= 0.9 * R ? Math.round(nLon * 1.5) : nLon;
        for (let j = 0; j < n; j++) {
          const phi = (j / n) * Math.PI * 2;
          const u = add(scale(add(scale(e1, Math.cos(phi)), scale(e2, Math.sin(phi))), Math.cos(lat)), scale(a, Math.sin(lat)));
          const line = this.trace(u);
          // le linee chiuse partono da entrambi gli emisferi: si tengono una volta sola
          if (line.closed && hemi < 0) continue;
          // le linee aperte che escono sul lato giorno o sui fianchi si collegano al campo del
          // vento solare: disegnate sembrerebbero peli che spuntano. Restano quelle della coda
          const m = line.pts.length;
          if (!line.closed && dot([line.pts[m - 3], line.pts[m - 2], line.pts[m - 1]], this.s) > -0.5 * R) continue;
          if (m >= 6) out.push(line);
        }
      }
    }
    return out;
  }
}

/**
 * Campo magnetico di una stella, nello schema più semplice (dipolo con "superficie sorgente",
 * Altschuler e Newkirk, 1969; Schatten e collaboratori, 1969): vicino alla superficie le linee
 * a bassa latitudine si richiudono ad arco; oltre la superficie sorgente (per il Sole a circa
 * 2,5 raggi) il vento stellare le trascina via e proseguono dritte verso lo spazio.
 * È la forma della corona che si vede nelle eclissi vicino al minimo dell'attività.
 */
export class StarField {
  private a: V3;
  readonly rss: number;
  constructor(axis: V3, rss: number) {
    this.a = norm(axis);
    this.rss = rss;
  }

  /** Campo nel punto r (sotto la superficie sorgente). */
  field(r: V3): V3 {
    const d = len(r);
    const rh = scale(r, 1 / (d || 1));
    const cos = dot(rh, this.a);
    // B = Br r̂ + Bθ θ̂, con θ̂ sinθ = cosθ r̂ − asse
    const k3 = 1 / (this.rss * this.rss * this.rss), i3 = 1 / (d * d * d);
    const br = cos * (2 * i3 + k3), bt = i3 - k3;
    return add(scale(rh, br + bt * cos), scale(this.a, -bt));
  }

  trace(r0: V3, reach: number): FieldLine {
    const dir = dot(this.field(r0), r0) >= 0 ? 1 : -1;
    const pts: number[] = [r0[0], r0[1], r0[2]];
    let r = r0;
    const step = (p: V3): V3 => {
      const b = this.field(p);
      return scale(b, dir / (len(b) || 1));
    };
    for (let i = 0; i < 600; i++) {
      const h = 0.07 * len(r);
      const k1 = step(r);
      const k2 = step(add(r, scale(k1, h / 2)));
      const k3 = step(add(r, scale(k2, h / 2)));
      const k4 = step(add(r, scale(k3, h)));
      const next = add(r, scale(add(add(k1, scale(k2, 2)), add(scale(k3, 2), k4)), h / 6));
      const dn = len(next);
      if (dn < 1) {
        const e = norm(next);
        pts.push(e[0], e[1], e[2]);
        return { pts, closed: true };
      }
      if (dn >= this.rss) {
        // oltre la superficie sorgente: dritta verso l'esterno
        const u = norm(next);
        for (const d of [this.rss, (this.rss + reach) / 2, reach]) pts.push(u[0] * d, u[1] * d, u[2] * d);
        return { pts, closed: false };
      }
      r = next;
      pts.push(r[0], r[1], r[2]);
    }
    return { pts, closed: false };
  }

  /** Archi chiusi alle basse latitudini e linee aperte dalle alte, su `nLon` meridiani. */
  lines(nLon = 6, reach = 3 * this.rss): FieldLine[] {
    const a = this.a;
    const e1 = norm(cross(a, Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
    const e2 = cross(a, e1);
    const out: FieldLine[] = [];
    for (const latDeg of [12, 22, 31, 38, 46, 56, 67, 79]) {
      for (const hemi of [1, -1]) {
        const lat = (latDeg * Math.PI) / 180 * hemi;
        for (let j = 0; j < nLon; j++) {
          // meridiani sfalsati da una latitudine all'altra: le linee non si coprono
          const phi = ((j + (latDeg % 2 ? 0.5 : 0)) / nLon) * Math.PI * 2;
          const u = add(scale(add(scale(e1, Math.cos(phi)), scale(e2, Math.sin(phi))), Math.cos(lat)), scale(a, Math.sin(lat)));
          const line = this.trace(u, reach);
          if (line.closed && hemi < 0) continue; // gli archi partono da entrambi gli emisferi
          out.push(line);
        }
      }
    }
    return out;
  }
}

function dipole(r: V3, c: V3, m: V3): V3 {
  const p = sub(r, c);
  const d2 = dot(p, p);
  const d = Math.sqrt(d2);
  const d5 = d2 * d2 * d;
  if (d5 < 1e-12) return [0, 0, 0];
  const mr = dot(m, p);
  return [(3 * mr * p[0] - m[0] * d2) / d5, (3 * mr * p[1] - m[1] * d2) / d5, (3 * mr * p[2] - m[2] * d2) / d5];
}

/** Punto della superficie da latitudine e longitudine planetocentriche (gradi), sistema solidale. */
export function bodyFixed(latDeg: number, lonDeg: number): V3 {
  const la = (latDeg * Math.PI) / 180, lo = (lonDeg * Math.PI) / 180;
  return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
}

/**
 * Intensità del campo di un dipolo inclinato e spostato nel punto `p` (in raggi, dal centro del corpo).
 * `bEq` è il campo all'equatore magnetico alla distanza di un raggio dal centro del dipolo: il
 * campo cala con il cubo della distanza ed è doppio sopra i poli (B = bEq / r³ · √(1 + 3 cos²θ)).
 */
export function dipoleStrength(bEq: number, axis: V3, center: V3, p: V3): number {
  const r = sub(p, center);
  const d = len(r);
  if (d < 1e-9) return Infinity;
  const c = dot(r, norm(axis)) / d;
  return (bEq / d ** 3) * Math.sqrt(1 + 3 * c * c);
}
