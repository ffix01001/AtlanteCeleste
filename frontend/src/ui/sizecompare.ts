/**
 * "Quanto è grande?": il corpo selezionato accanto a qualcosa di familiare, in scala.
 * Per i pianeti la Terra, per le lune la Luna, per gli asteroidi l'Italia, Roma o un campo
 * da calcio, per le sonde un autobus o un campo da tennis, per le stelle il Sole.
 * Una figurina in SVG e una frase: niente di più (e niente da imparare per usarlo).
 */

import { t } from '../core/i18n';
import { Color } from 'three';
import { fmtNum } from '../core/format';
import { AU_KM } from '../core/units';
import { h } from './dom';

/** Un termine di paragone: diametro (o lunghezza) in km, forma, colore, articolo. */
interface Ref {
  name: string;          // "la Terra"
  short: string;         // "Terra" (sotto la figura)
  plural?: string;       // "Terre" (per il volume)
  gen?: string;          // "della Terra"
  km: number;
  shape: 'disk' | 'bar' | 'field' | 'court' | 'bus';
  color: string;
}

const REFS: Record<string, Ref> = {
  sun: { name: t('il Sole'), short: t('Sole'), plural: t('Soli'), gen: t('del Sole'), km: 1_391_400, shape: 'disk', color: '#ffcf6b' },
  jupiter: { name: t('Giove'), short: t('Giove'), plural: t('Giovi'), gen: t('di Giove'), km: 139_820, shape: 'disk', color: '#d9b48a' },
  earth: { name: t('la Terra'), short: t('Terra'), plural: t('Terre'), gen: t('della Terra'), km: 12_742, shape: 'disk', color: '#5d8ed8' },
  moon: { name: t('la Luna'), short: t('Luna'), plural: t('Lune'), gen: t('della Luna'), km: 3_474.8, shape: 'disk', color: '#b9b5ad' },
  italy: { name: t("l'Italia, dalle Alpi alla punta della Calabria"), short: t('Italia (1200 km)'), km: 1_200, shape: 'bar', color: '#7fbf7f' },
  romanapoli: { name: t('la distanza fra Roma e Napoli'), short: t('Roma–Napoli (190 km)'), km: 190, shape: 'bar', color: '#7fbf7f' },
  gra: { name: t('il Grande Raccordo Anulare di Roma'), short: t('il GRA di Roma (22 km)'), km: 22, shape: 'bar', color: '#7fbf7f' },
  bianco: { name: t('il Monte Bianco, dal mare alla vetta'), short: t('Monte Bianco (4,8 km)'), km: 4.81, shape: 'bar', color: '#cfd8e6' },
  eiffel: { name: t('la Torre Eiffel'), short: t('Torre Eiffel (330 m)'), km: 0.33, shape: 'bar', color: '#c9a25a' },
  field: { name: t('un campo da calcio'), short: t('campo da calcio (105 m)'), km: 0.105, shape: 'field', color: '#4f9a52' },
  court: { name: t('un campo da tennis'), short: t('campo da tennis (24 m)'), km: 0.0238, shape: 'court', color: '#3f7fbf' },
  bus: { name: t('un autobus'), short: t('autobus (12 m)'), km: 0.012, shape: 'bus', color: '#e0a030' },
};

/** Il paragone più adatto a un oggetto di diametro D (km). */
export function pickRef(D: number, kind: string, id: string): Ref {
  if (id === 'naif:399') return REFS.moon;          // la Terra accanto alla Luna
  if (id === 'naif:10' || id === 'naif:301') return REFS.earth; // il Sole e la Luna accanto alla Terra
  if (kind === 'star') return REFS.sun;
  if (kind === 'planet') return REFS.earth;
  if (D >= 60_000) return REFS.earth;
  if (D >= 5_000) return REFS.earth;
  if (D >= 1_500) return REFS.moon;
  if (D >= 300) return REFS.italy;
  if (D >= 45) return REFS.romanapoli;
  if (D >= 6) return REFS.gra;
  if (D >= 1.2) return REFS.bianco;
  if (D >= 0.2) return REFS.eiffel;
  if (D >= 0.045) return REFS.field;
  if (D >= 0.018) return REFS.court;
  return REFS.bus;
}

/** Un numero grande detto "a voce": 1.302.097 -> "1,3 milioni", 13.410 -> "13.000". */
function count(v: number): string {
  if (v >= 1e9) return t('{n} miliardi', { n: fmtNum(v / 1e9, 1) });
  if (v >= 1e6) return t('{n} milioni', { n: fmtNum(v / 1e6, 1) });
  if (v >= 1e4) return fmtNum(Math.round(v / 1000) * 1000, 0);
  if (v >= 100) return fmtNum(Math.round(v), 0);
  return fmtNum(v, 1);
}

function ratioText(r: number): string {
  if (r >= 100) return fmtNum(Math.round(r), 0);
  if (r >= 10) return fmtNum(r, 0);
  return fmtNum(r, 1);
}

/** Frase del paragone. `D` diametro (o, per le sonde, lunghezza) dell'oggetto in km. */
export function compareSentence(D: number, ref: Ref): string {
  const r = D / ref.km;
  if (Math.abs(r - 1) < 0.15) return t('È grande più o meno come {name}.', { name: ref.name });
  if (ref.shape === 'disk') {
    const big = r > 1 ? r : 1 / r;
    const vol = big ** 3;
    const n = count(vol);
    if (r > 1) {
      const inside = vol >= 1.5 && vol < 1e12 ? t(' Dentro ci starebbero circa {n}{v1} {plural}.', { n, v1: /[a-z]$/.test(n) ? t(' di') : '', plural: ref.plural }) : '';
      return t('Il diametro è {v0} volte quello {gen}.{inside}', { v0: ratioText(r), gen: ref.gen, inside });
    }
    const many = vol >= 1.5 && vol < 1e12 ? t(' Per fare il volume {gen} ne servirebbero circa {n}.', { gen: ref.gen, n }) : '';
    return t('{v0} è {v1} volte più grande.{many}', { v0: capital(ref.name), v1: ratioText(big), many });
  }
  // termini di paragone "di casa": lunghezze
  if (r > 1) return t('Misura circa {v0} volte {name}.', { v0: ratioText(r), name: ref.name });
  return t('{v0} è circa {v1} volte più grande.', { v0: capital(ref.name), v1: ratioText(1 / r) });
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const NS = 'http://www.w3.org/2000/svg';
function svgEl(tag: string, attrs: Record<string, string | number>): SVGElement {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

/** Figura in scala: l'oggetto (a sinistra) e il termine di paragone (a destra). */
function figure(D: number, color: string, ref: Ref, label: string, isModel: boolean): SVGElement {
  const W = 300, H = 132, base = 104, maxPx = 92;
  const big = Math.max(D, ref.km);
  const k = maxPx / big;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': t('{label} e {short}, in scala', { label, short: ref.short }) });
  const drawObj = (x: number, size: number, col: string, asBar: boolean, name: string) => {
    const s = Math.max(size, 1.5);
    if (asBar) {
      svg.append(svgEl('rect', { x: x - s / 2, y: base - 5, width: s, height: 5, rx: 1.5, fill: col }));
    } else {
      svg.append(svgEl('circle', { cx: x, cy: base - s / 2, r: s / 2, fill: col }));
      if (size < 4) svg.append(svgEl('circle', { cx: x, cy: base - s / 2, r: 7, fill: 'none', stroke: col, 'stroke-opacity': 0.55 }));
    }
    const t = svgEl('text', { x, y: base + 18, 'text-anchor': 'middle', fill: '#c9c4b8', 'font-size': 11 });
    t.textContent = name;
    svg.append(t);
  };
  const leftX = 78, rightX = 222;
  drawObj(leftX, D * k, color, isModel, label);
  const rs = ref.km * k;
  if (ref.shape === 'disk') drawObj(rightX, rs, ref.color, false, ref.short);
  else if (ref.shape === 'bar') drawObj(rightX, rs, ref.color, true, ref.short);
  else {
    // campo da calcio / da tennis / autobus: rettangoli in proporzione, visti dall'alto
    const w = Math.max(rs, 2), hh = ref.shape === 'field' ? w * 0.65 : ref.shape === 'court' ? w * 0.46 : Math.max(w * 0.21, 1.5);
    svg.append(svgEl('rect', { x: rightX - w / 2, y: base - hh, width: w, height: hh, fill: ref.color, rx: ref.shape === 'bus' ? 1 : 0 }));
    if (ref.shape !== 'bus' && w > 20) {
      svg.append(svgEl('rect', { x: rightX - w / 2 + 2, y: base - hh + 2, width: w - 4, height: hh - 4, fill: 'none', stroke: '#ffffff', 'stroke-opacity': 0.6 }));
      svg.append(svgEl('line', { x1: rightX, y1: base - hh + 2, x2: rightX, y2: base - 2, stroke: '#ffffff', 'stroke-opacity': 0.6 }));
    }
    const t = svgEl('text', { x: rightX, y: base + 18, 'text-anchor': 'middle', fill: '#c9c4b8', 'font-size': 11 });
    t.textContent = ref.short;
    svg.append(t);
  }
  svg.append(svgEl('line', { x1: 14, y1: base + 0.5, x2: W - 14, y2: base + 0.5, stroke: '#ffffff', 'stroke-opacity': 0.12 }));
  return svg;
}

/**
 * Sezione "Quanto è grande?" per un corpo di diametro D (km); per le sonde con il modello 3D,
 * D è la lunghezza massima. Restituisce null se non ha senso (oggetti senza dimensioni).
 */
export function sizeComparison(opts: { name: string; D: number; color: string; kind: string; id: string; isModel?: boolean }): HTMLElement | null {
  const { name, D, color, kind, id } = opts;
  if (!(D > 0)) return null;
  const ref = pickRef(D, kind, id);
  const isModel = !!opts.isModel;
  const text = compareSentence(D, ref);
  const extra: string[] = [];
  if (kind === 'star' && D > 0.5 * AU_KM) {
    // le stelle giganti: al posto del Sole, fin dove arriverebbero?
    const R = D / 2 / AU_KM;
    const orbit = R > 9.5 ? t('oltre l\'orbita di Saturno') : R > 5.2 ? t('oltre l\'orbita di Giove') : R > 1.52 ? t('oltre l\'orbita di Marte')
      : R > 1 ? t('oltre l\'orbita della Terra') : R > 0.72 ? t('oltre l\'orbita di Venere') : R > 0.39 ? t('oltre l\'orbita di Mercurio') : '';
    if (orbit) extra.push(t('Messa al posto del Sole, arriverebbe {orbit}.', { orbit }));
  }
  // sotto la figura c'è poco spazio: i nomi lunghi si accorciano ("Stazione ... (ISS)" -> "ISS")
  let label = name;
  if (label.length > 18) {
    const par = /\(([^)]+)\)\s*$/.exec(label);
    label = par ? par[1] : label.split(/\s+/).slice(-2).join(' ');
  }
  // i corpi scurissimi (Bennu, i nuclei delle comete) si schiariscono un po', se no non si vedono
  const c = new Color(color);
  const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  if (lum < 0.12) c.lerp(new Color('#9a948a'), 0.5);
  return h('div', { class: 'size-compare' },
    figure(D, `#${c.getHexString()}`, ref, label, isModel),
    h('p', { class: 'small' }, text, extra.length ? ` ${extra.join(' ')}` : ''));
}
