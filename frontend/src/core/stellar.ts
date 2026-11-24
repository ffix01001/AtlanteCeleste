/**
 * Fisica delle stelle in forma semplice: dal colore e dalla luminosità (o dalla classe
 * spettrale, quando c'è) si ricavano temperatura, luminosità, raggio e il "tipo" di stella
 * (nana rossa, gigante rossa, nana bianca...).
 *
 * Fonti delle relazioni usate:
 *  - temperatura dall'indice B−V: Ballesteros (2012, EPL 97, 34009);
 *  - correzione bolometrica: Flower (1996) nella versione corretta di Torres (2010, AJ 140, 1158);
 *  - temperature e magnitudini della sequenza principale: tabella di E. Mamajek
 *    ("A Modern Mean Dwarf Stellar Color and Effective Temperature Sequence", 2022);
 *  - giganti e supergiganti: valori medi da Gray, "The Observation and Analysis of Stellar Photospheres".
 */

import { t } from './i18n';
import { Color, SRGBColorSpace } from 'three';

export const T_SUN = 5772;
const MBOL_SUN = 4.74;

/** Temperatura efficace (K) dall'indice di colore B−V. */
export function bvToTemp(bv: number): number {
  const b = Math.max(-0.4, Math.min(2.0, Number.isFinite(bv) ? bv : 0.65));
  return 4600 * (1 / (0.92 * b + 1.7) + 1 / (0.92 * b + 0.62));
}

/** B−V che corrisponde a una temperatura (inversione numerica della relazione precedente). */
export function tempToBv(T: number): number {
  let lo = -0.4, hi = 2.0;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (bvToTemp(mid) > T) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Colore di un corpo nero alla temperatura T (approssimazione di T. Helland).
 * È lo stesso calcolo che lo shader delle stelle fa per ogni punto.
 */
export function tempToColor(T: number, out = new Color()): Color {
  const t = Math.max(1000, Math.min(40000, T)) / 100;
  let r: number, g: number, b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708 * Math.log(t) - 161.1196;
    b = t <= 19 ? 0 : 138.5177 * Math.log(t - 10) - 305.0448;
  } else {
    r = 329.6987 * Math.pow(t - 60, -0.1332);
    g = 288.1222 * Math.pow(t - 60, -0.0755);
    b = 255;
  }
  const c = (x: number) => Math.max(0, Math.min(255, x)) / 255;
  // i valori della formula sono colori "da schermo" (sRGB): three.js li converte nel suo spazio lineare
  return out.setRGB(c(r), c(g), c(b), SRGBColorSpace);
}

/** Lo stesso colore come stringa CSS (#rrggbb). */
export function tempToCss(T: number): string {
  return `#${tempToColor(T, _css).getHexString()}`;
}
const _css = new Color();

// sotto i 4000 K il polinomio di Flower diverge: valori delle nane M (Pecaut & Mamajek 2013)
const BC_COOL: [number, number][] = [
  [2300, -5.6], [2380, -5.3], [2570, -4.8], [2680, -4.4], [2810, -3.9], [3060, -3.1], [3210, -2.6],
  [3430, -2.0], [3560, -1.7], [3700, -1.45], [3850, -1.21], [3950, -1.15],
];

/** Correzione bolometrica BC_V (Flower 1996 / Torres 2010): M_bol = M_V + BC. */
export function bolometricCorrection(T: number): number {
  if (T < 3950) return interp(BC_COOL, T);
  const x = Math.log10(Math.min(50000, T));
  if (x < 3.7) {
    return -0.190537291496456e5 + 0.155144866764412e5 * x - 0.421278819301717e4 * x ** 2 + 0.381476328422343e3 * x ** 3;
  }
  if (x < 3.9) {
    return -0.370510203809015e5 + 0.385672629965804e5 * x - 0.150651486316025e5 * x ** 2
      + 0.261724637119416e4 * x ** 3 - 0.170623810323864e3 * x ** 4;
  }
  return -0.118115450538963e6 + 0.137145973583929e6 * x - 0.636233812100225e5 * x ** 2
    + 0.147412923562646e5 * x ** 3 - 0.170587278406872e4 * x ** 4 + 0.788731721804990e2 * x ** 5;
}

// ---------------------------------------------------------------- classe spettrale

export interface Spectral {
  /** lettera della classe: O B A F G K M (L T Y nane brune, W Wolf-Rayet, C S stelle al carbonio, D nane bianche) */
  cls: string;
  /** sottoclasse 0-9.5 */
  sub: number;
  /** classe di luminosità: 0, Ia, Iab, Ib, I, II, III, IV, V, VI (o '' se non indicata) */
  lum: string;
  /** testo originale */
  raw: string;
}

const CLASS_ORDER = 'OBAFGKM';

/** Interpreta sigle come "M1-2Ia-Iab", "K0III", "G2V", "DA2", "sdB5", "A1Vm", "B8Ia:". */
export function parseSpectral(raw: string | null | undefined): Spectral | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  // nane bianche: DA, DB, DC, DO, DQ, DZ...
  let m = /^D[ABCOQZX]?[A-Z]*\s*([0-9.]*)/.exec(s);
  if (m && s[0] === 'D' && s.length > 1 && /[ABCOQZX0-9]/.test(s[1])) {
    return { cls: 'D', sub: parseFloat(m[1]) || 0, lum: 'D', raw: s };
  }
  let lumPrefix = '';
  let rest = s;
  if (/^sd/i.test(rest)) { lumPrefix = 'VI'; rest = rest.slice(2); }
  else if (/^(esd|usd)/i.test(rest)) { lumPrefix = 'VI'; rest = rest.slice(3); }
  else if (/^d(?=[OBAFGKM])/.test(rest)) { lumPrefix = 'V'; rest = rest.slice(1); }  // vecchia notazione: "dM3"
  else if (/^[cg](?=[OBAFGKM])/.test(rest)) { lumPrefix = rest[0] === 'c' ? 'I' : 'III'; rest = rest.slice(1); }
  m = /^(W[NCRO]?|[OBAFGKMLTYCSNR])\s*([0-9](?:\.[0-9]+)?)?/.exec(rest);
  if (!m) return null;
  let cls = m[1];
  if (cls.startsWith('W')) cls = 'W';
  if (cls === 'N' || cls === 'R') cls = 'C';
  const sub = m[2] !== undefined ? parseFloat(m[2]) : 5;
  const after = rest.slice(m[0].length).replace(/^[-/][0-9.]+/, '');
  const lm = /(0|Ia\+|Ia0|Iab|Ia|Ib|III|II|IV|VI|V|I)/.exec(after);
  const lum = lumPrefix || (lm ? (lm[1] === 'Ia0' || lm[1] === 'Ia+' ? '0' : lm[1]) : '');
  return { cls, sub, lum, raw: s };
}

/** posizione continua lungo la sequenza O0 ... M9 (0-69) */
function spectralIndex(sp: Spectral): number | null {
  const k = CLASS_ORDER.indexOf(sp.cls);
  return k < 0 ? null : k * 10 + sp.sub;
}

function interp(table: [number, number][], x: number): number {
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    if (x <= table[i][0]) {
      const [x0, y0] = table[i - 1], [x1, y1] = table[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return table[table.length - 1][1];
}

// temperatura (K) lungo la sequenza spettrale: indice O0=0, B0=10, A0=20, F0=30, G0=40, K0=50, M0=60
const T_DWARF: [number, number][] = [
  [3, 44900], [5, 41400], [7, 36500], [9, 31900], [10, 31400], [12, 23000], [13, 18800], [15, 15700],
  [17, 13500], [19, 11400], [20, 9700], [22, 9000], [25, 8080], [27, 7650], [30, 7220], [32, 6810],
  [35, 6510], [38, 6170], [40, 5920], [42, 5770], [45, 5660], [48, 5490], [50, 5280], [52, 5040],
  [55, 4450], [57, 4050], [60, 3850], [61, 3770], [62, 3560], [63, 3430], [64, 3210], [65, 3060],
  [66, 2810], [67, 2680], [68, 2570], [69, 2380],
];
const T_GIANT: [number, number][] = [
  [10, 29000], [15, 15000], [20, 10100], [25, 8100], [30, 7150], [35, 6400], [40, 5850], [42, 5450],
  [45, 5150], [48, 5000], [50, 4750], [52, 4500], [53, 4300], [55, 3950], [60, 3850], [61, 3780],
  [62, 3700], [63, 3600], [64, 3500], [65, 3400], [66, 3250], [67, 3100], [68, 2950], [69, 2800],
];

/** magnitudine assoluta V della sequenza principale in funzione di B−V (Mamajek) */
const MS_MV: [number, number][] = [
  [-0.32, -4.6], [-0.30, -3.9], [-0.26, -2.6], [-0.20, -1.6], [-0.16, -1.1], [-0.12, -0.4], [-0.05, 0.6],
  [0.0, 1.1], [0.09, 1.7], [0.15, 1.9], [0.30, 2.5], [0.38, 3.0], [0.44, 3.4], [0.53, 4.0], [0.58, 4.4],
  [0.65, 4.8], [0.74, 5.4], [0.82, 5.9], [0.92, 6.3], [1.00, 6.7], [1.15, 7.4], [1.30, 8.2], [1.40, 8.9],
  [1.46, 9.6], [1.50, 10.3], [1.55, 11.0], [1.64, 12.0], [1.75, 13.0], [1.85, 14.5], [2.00, 16.0],
];

/** Magnitudine assoluta che avrebbe una stella di sequenza principale con questo colore. */
export function mainSequenceMv(bv: number): number {
  return interp(MS_MV, bv);
}

// ---------------------------------------------------------------- tipo di stella

export type StarFamily =
  | 'supergigante' | 'gigante luminosa' | 'gigante' | 'subgigante' | 'sequenza principale'
  | 'subnana' | 'nana bianca' | 'nana bruna' | 'Wolf-Rayet' | 'carbonio';

export interface StarNature {
  /** nome comune, per esempio "gigante rossa" o "nana gialla" */
  name: string;
  family: StarFamily;
  /** frase che spiega cosa vuol dire */
  note: string;
  /** true se il tipo è dedotto da colore e luminosità e non dalla classe spettrale */
  estimated: boolean;
  temperatureK: number;
  /** luminosità totale (tutte le lunghezze d'onda), in luminosità solari */
  luminositySun: number;
  /** raggio in raggi solari */
  radiusSun: number;
  spectral: Spectral | null;
}

function letterFromTemp(T: number): string {
  if (T >= 30000) return 'O';
  if (T >= 10000) return 'B';
  if (T >= 7400) return 'A';
  if (T >= 6000) return 'F';
  if (T >= 5200) return 'G';
  if (T >= 3900) return 'K';
  return 'M';
}

function familyFromLumClass(lum: string): StarFamily | null {
  switch (lum) {
    case '0': case 'Ia': case 'Iab': case 'Ib': case 'I': return 'supergigante';
    case 'II': return 'gigante luminosa';
    case 'III': return 'gigante';
    case 'IV': return 'subgigante';
    case 'V': return 'sequenza principale';
    case 'VI': return 'subnana';
    case 'D': return 'nana bianca';
    default: return null;
  }
}

function describe(family: StarFamily, letter: string): { name: string; note: string } {
  switch (family) {
    case 'nana bianca':
      return { name: t('nana bianca'), note: t("Il nucleo spento di una stella come il Sole: grande come la Terra, ma con una massa simile a quella del Sole. Non produce più energia e si raffredda lentamente.") };
    case 'nana bruna':
      return { name: t('nana bruna'), note: t("Troppo piccola per accendere la fusione dell'idrogeno: una via di mezzo fra un pianeta gigante e una stella.") };
    case 'Wolf-Rayet':
      return { name: t('stella di Wolf-Rayet'), note: t("Una stella massiccia e caldissima che ha perso gli strati esterni in un vento violento: destinata a esplodere come supernova.") };
    case 'carbonio':
      return { name: t('stella al carbonio'), note: t("Una gigante rossa molto evoluta, con più carbonio che ossigeno nell'atmosfera: per questo appare di un rosso intenso.") };
    case 'supergigante':
      return {
        name: letter === 'M' || letter === 'K' ? t('supergigante rossa') : letter === 'G' || letter === 'F' ? t('supergigante gialla') : t('supergigante blu'),
        note: t("Una delle stelle più grandi e luminose che esistano: decine di volte più massiccia del Sole, vive pochi milioni di anni e finirà come supernova."),
      };
    case 'gigante luminosa':
    case 'gigante': {
      // (nomi interi: in altre lingue il colore cambia forma e posizione)
      const names: Record<string, string> = {
        O: t('gigante blu'), B: t('gigante azzurra'), A: t('gigante bianca'), F: t('gigante bianco-gialla'), G: t('gigante gialla'),
      };
      return {
        name: letter === 'M' || letter === 'K' ? t('gigante rossa') : names[letter] ?? t('gigante'),
        note: letter === 'M' || letter === 'K'
          ? t("Una stella che ha finito l'idrogeno nel nucleo e si è gonfiata: decine o centinaia di volte più grande del Sole. Fra circa 5 miliardi di anni anche il Sole diventerà così.")
          : t('Una stella più grande e luminosa di quelle di sequenza principale con lo stesso colore: sta lasciando la fase stabile della sua vita.'),
      };
    }
    case 'subgigante': {
      const names: Record<string, string> = {
        O: t('subgigante blu'), B: t('subgigante azzurra'), A: t('subgigante bianca'), F: t('subgigante bianco-gialla'),
        G: t('subgigante gialla'), K: t('subgigante arancione'), M: t('subgigante rossa'),
      };
      return { name: names[letter] ?? t('subgigante'), note: t("Ha appena finito l'idrogeno nel nucleo e comincia a espandersi: è a metà strada verso la fase di gigante.") };
    }
    case 'subnana':
      return { name: t('subnana'), note: t('Una stella antica e povera di metalli, un po\' meno luminosa di quelle di sequenza principale con lo stesso colore.') };
    case 'sequenza principale': {
      const names: Record<string, string> = {
        O: t('stella blu di sequenza principale'), B: t('stella azzurra di sequenza principale'),
        A: t('stella bianca di sequenza principale'), F: t('stella bianco-gialla di sequenza principale'),
        G: t('nana gialla'), K: t('nana arancione'), M: t('nana rossa'),
      };
      const notes: Record<string, string> = {
        M: t("Il tipo di stella più comune della Galassia: piccola, fredda e parsimoniosa. Può brillare per migliaia di miliardi di anni."),
        K: t('Un po\' più piccola e fredda del Sole, molto stabile: vive decine di miliardi di anni.'),
        G: t('Una stella come il Sole, nella fase stabile della sua vita: trasforma idrogeno in elio nel nucleo.'),
      };
      return {
        name: names[letter] ?? t('stella di sequenza principale'),
        note: notes[letter] ?? t("Trasforma idrogeno in elio nel nucleo, nella fase stabile della sua vita. Più è calda e massiccia, più in fretta consuma il suo combustibile."),
      };
    }
  }
}

/**
 * Tipo, temperatura, luminosità e raggio di una stella.
 * @param absmag magnitudine assoluta visuale
 * @param bv indice di colore B−V (può mancare)
 * @param spect classe spettrale del catalogo (può mancare)
 */
export function starNature(absmag: number, bv: number | null | undefined, spect?: string | null): StarNature {
  const sp = parseSpectral(spect);
  const bvOk = bv !== null && bv !== undefined && Number.isFinite(bv);
  let T = bvOk ? bvToTemp(bv!) : 5800;
  let family: StarFamily | null = null;
  let estimated = true;

  if (sp) {
    // nane bianche: la sottoclasse è 50400 / T (DA2 = circa 25.000 K)
    if (sp.cls === 'D') {
      family = 'nana bianca';
      if (sp.sub > 0) T = 50400 / sp.sub;
      else if (bvOk) T = Math.max(bvToTemp(bv!), 6000);
    }
    else if (sp.cls === 'L' || sp.cls === 'T' || sp.cls === 'Y') family = 'nana bruna';
    else if (sp.cls === 'W') family = 'Wolf-Rayet';
    else if (sp.cls === 'C' || sp.cls === 'S') family = 'carbonio';
    else family = familyFromLumClass(sp.lum);
    const idx = spectralIndex(sp);
    if (idx !== null) {
      const giant = family === 'gigante' || family === 'gigante luminosa' || family === 'supergigante';
      T = interp(giant ? T_GIANT : T_DWARF, idx);
    } else if (sp.cls === 'W') {
      T = 70000;
    } else if (sp.cls === 'C' || sp.cls === 'S') {
      T = 3000;
    } else if (sp.cls === 'L') {
      T = 1800;
    } else if (sp.cls === 'T') {
      T = 1000;
    }
    if (family) estimated = false;
  }

  // senza classe di luminosità: la posizione nel diagramma H-R
  if (!family) {
    const c = bvOk ? bv! : 0.65;
    const ms = mainSequenceMv(c);
    if (c < 0.9 && absmag > 7.5 + 5 * c) family = 'nana bianca';
    else if (absmag < -3.5 && absmag < ms - 2) family = 'supergigante';
    else if (absmag < ms - 1.5 && c >= 0.6) family = 'gigante';
    else if (absmag < ms - 1.0 && c < 0.6 && c > 0.2) family = 'subgigante';
    else if (absmag > ms + 1.5 && c > 0.3) family = 'subnana';
    else family = 'sequenza principale';
    if (family === 'nana bianca' && bvOk) T = Math.max(T, 6000);
  }

  const bc = family === 'nana bianca' ? bolometricCorrection(Math.min(T, 30000)) : bolometricCorrection(T);
  const L = Math.pow(10, -0.4 * (absmag + bc - MBOL_SUN));
  const R = Math.sqrt(L) / (T / T_SUN) ** 2;
  const letter = sp && CLASS_ORDER.includes(sp.cls) ? sp.cls : letterFromTemp(T);
  const { name, note } = describe(family, letter);
  return { name, family, note, estimated, temperatureK: T, luminositySun: L, radiusSun: R, spectral: sp };
}
