/** Formattazione di numeri, distanze, durate e date nella lingua scelta (in italiano: virgola decimale, punto delle migliaia). */

import { AU_KM, C_KMS, LY_KM, PC_KM } from './units';
import { locale, t } from './i18n';

const cache = new Map<string, Intl.NumberFormat>();

function nf(min: number, max: number): Intl.NumberFormat {
  const key = `${min}-${max}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale(), { minimumFractionDigits: min, maximumFractionDigits: max });
    cache.set(key, f);
  }
  return f;
}

export function fmtNum(v: number, digits = 0): string {
  if (!Number.isFinite(v)) return '—';
  return nf(digits, digits).format(v);
}

/** Numero con un certo numero di cifre significative. */
export function fmtSig(v: number, sig = 4): string {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  const mag = Math.floor(Math.log10(Math.abs(v)));
  const digits = Math.max(0, Math.min(10, sig - 1 - mag));
  return nf(0, digits).format(v);
}

const SUP: Record<string, string> = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };

export function fmtSci(v: number, sig = 4): string {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  const exp = Math.floor(Math.log10(Math.abs(v)));
  if (exp >= -2 && exp < 7) return fmtSig(v, sig);
  const mant = v / 10 ** exp;
  const e = String(exp).split('').map((c) => SUP[c] ?? c).join('');
  return `${fmtSig(mant, sig)} × 10${e}`;
}

export function fmtKm(km: number): string {
  const a = Math.abs(km);
  if (a < 1) return `${fmtNum(km * 1000, 0)} m`;
  if (a < 1e7) return `${fmtNum(km, 0)} km`;
  if (a < 1e10) return t('{n} milioni di km', { n: fmtSig(km / 1e6, 4) });
  return t('{n} miliardi di km', { n: fmtSig(km / 1e9, 4) });
}

/** Distanza con unità scelta in base alla scala, più una forma alternativa. */
export function fmtDistance(km: number): { main: string; alt: string } {
  const a = Math.abs(km);
  if (a < 0.01 * AU_KM) return { main: fmtKm(km), alt: `${fmtSig(km / AU_KM, 4)} ${t('UA')}` };
  if (a < 0.05 * LY_KM) return { main: `${fmtSig(km / AU_KM, a < 10 * AU_KM ? 5 : 6)} ${t('UA')}`, alt: fmtKm(km) };
  const ly = km / LY_KM, pc = km / PC_KM;
  const lyTxt = Math.abs(ly) >= 1e6 ? t('{n} milioni di anni luce', { n: fmtSig(ly / 1e6, 4) }) : t('{n} anni luce', { n: fmtSig(ly, 4) });
  const pcTxt = Math.abs(pc) >= 1e6 ? `${fmtSig(pc / 1e6, 4)} megaparsec` : Math.abs(pc) >= 1000 ? `${fmtSig(pc / 1000, 4)} kiloparsec` : `${fmtSig(pc, 4)} parsec`;
  return { main: lyTxt, alt: pcTxt };
}

export function fmtLightTime(km: number): string {
  let s = Math.abs(km) / C_KMS;
  if (s < 60) return `${fmtSig(s, 3)} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${Math.floor(s % 60)} s`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  const days = s / 86400;
  if (days < 365.25) {
    const d = Math.floor(days);
    s -= d * 86400;
    return t('{d} g {h} h {min} min', { d, h: Math.floor(s / 3600), min: Math.floor((s % 3600) / 60) });
  }
  return t('{n} anni', { n: fmtSig(days / 365.25, 4) });
}

export function fmtSpeed(kms: number): string {
  return `${fmtSig(kms, Math.abs(kms) < 10 ? 4 : 5)} km/s`;
}

export function fmtDuration(hours: number): string {
  const h = Math.abs(hours);
  const sign = hours < 0 ? t(' (retrograda)') : '';
  if (h < 1) return `${fmtSig(h * 60, 3)} min${sign}`;
  if (h < 48) {
    const hh = Math.floor(h);
    const mm = Math.floor((h - hh) * 60);
    const ss = Math.round(((h - hh) * 60 - mm) * 60);
    return `${hh} h ${mm} min${ss ? ` ${ss} s` : ''}${sign}`;
  }
  const d = h / 24;
  if (d < 1000) return t('{n} giorni', { n: fmtSig(d, 4) }) + sign;
  return t('{n} anni', { n: fmtSig(d / 365.25, 4) }) + sign;
}

export function fmtDays(days: number): string {
  return fmtDuration(days * 24);
}

/** Angolo in gradi sessagesimali: +22° 00′ 52″ */
export function fmtDMS(deg: number): string {
  const sign = deg < 0 ? '−' : '+';
  let a = Math.abs(deg);
  let d = Math.floor(a);
  a = (a - d) * 60;
  let m = Math.floor(a);
  let s = Math.round((a - m) * 60);
  if (s === 60) { s = 0; m += 1; }
  if (m === 60) { m = 0; d += 1; }
  return `${sign}${d}° ${String(m).padStart(2, '0')}′ ${String(s).padStart(2, '0')}″`;
}

/** Ascensione retta: 05h 34m 31,9s */
export function fmtRA(deg: number): string {
  let h = ((deg % 360) + 360) % 360 / 15;
  const hh = Math.floor(h);
  h = (h - hh) * 60;
  const mm = Math.floor(h);
  const ss = (h - mm) * 60;
  return `${String(hh).padStart(2, '0')}h ${String(mm).padStart(2, '0')}m ${fmtNum(ss, 1).padStart(4, '0')}s`;
}

const dateFmt = new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'long', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dateFmtUtc = new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const timeFmtUtc = new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC' });

export function fmtDate(ms: number, utc = false): { date: string; time: string } {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return { date: '—', time: '' };
  return utc ? { date: dateFmtUtc.format(d), time: timeFmtUtc.format(d) } : { date: dateFmt.format(d), time: timeFmt.format(d) };
}

export function fmtIsoDate(s: string | null | undefined): string {
  if (!s) return '—';
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/.exec(s);
  if (!m) return s;
  if (!m[2]) return m[1];
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, m[3] ? +m[3] : 1));
  if (!m[3]) return new Intl.DateTimeFormat(locale(), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);
  return dateFmtUtc.format(d);
}

/** Toglie accenti e maiuscole per la ricerca. */
export function normalize(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[ʻ'’`]/g, '').toLowerCase();
}

/** Intensità di un campo magnetico, dai nanotesla: nT, µT, mT o T secondo la grandezza. */
export function fmtField(nT: number): string {
  if (!Number.isFinite(nT)) return '—';
  if (nT < 1000) return `${fmtSig(nT, nT < 10 ? 2 : 3)} nT`;
  if (nT < 1e6) return `${fmtSig(nT / 1e3, 3)} µT`;
  if (nT < 1e9) return `${fmtSig(nT / 1e6, 3)} mT`;
  return `${fmtSig(nT / 1e9, 3)} T`;
}
