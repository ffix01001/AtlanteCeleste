/**
 * Lingue dell'interfaccia.
 *
 * Le scritte nel codice sono in italiano e fanno da chiave: t('Orbite') restituisce
 * la traduzione nella lingua scelta. Se una traduzione manca si ripiega sull'inglese
 * e poi sull'italiano, così l'interfaccia non resta mai vuota.
 *
 *   t('Distanza da {nome}', { nome: 'Marte' })
 *   tn(3, '{n} giorno', '{n} giorni')            // plurale secondo la lingua
 *
 * I dizionari (src/i18n/<lingua>.json) hanno la forma { "testo italiano": "traduzione" };
 * per i plurali il valore può essere { "one": "...", "other": "..." } (anche few/many).
 * La lingua si cambia ricaricando la pagina: ogni scritta viene ricostruita da capo.
 */

export type Lang = 'it' | 'en' | 'es' | 'de' | 'fr';

export interface LangInfo {
  code: Lang;
  /** nome della lingua scritto nella lingua stessa */
  name: string;
  /** locale predefinito per numeri e date */
  locale: string;
}

export const LANGS: readonly LangInfo[] = [
  { code: 'it', name: 'Italiano', locale: 'it-IT' },
  { code: 'en', name: 'English', locale: 'en-GB' },
  { code: 'es', name: 'Español', locale: 'es-ES' },
  { code: 'de', name: 'Deutsch', locale: 'de-DE' },
  { code: 'fr', name: 'Français', locale: 'fr-FR' },
];

export type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };
export type Dictionary = Record<string, string | PluralForms>;

const STORE_KEY = 'atlante:lang';
const isLang = (v: unknown): v is Lang => LANGS.some((l) => l.code === v);

function storedLang(): Lang | null {
  try {
    const v = globalThis.localStorage?.getItem(STORE_KEY);
    return isLang(v) ? v : null;
  } catch {
    return null;
  }
}

/** Lingua del sistema, se è una di quelle disponibili (altrimenti inglese). */
export function detectLang(prefs: readonly string[] = browserLangs()): Lang {
  for (const p of prefs) {
    const code = p.toLowerCase().split(/[-_]/)[0];
    if (isLang(code)) return code;
  }
  return 'en';
}

function browserLangs(): string[] {
  const n = globalThis.navigator;
  if (!n) return [];
  return [...(n.languages ?? []), n.language].filter(Boolean);
}

/** Locale per i numeri e le date: quello del sistema se parla la stessa lingua (es. en-US). */
function pickLocale(lang: Lang, prefs: readonly string[] = browserLangs()): string {
  for (const p of prefs) {
    if (p.toLowerCase().split(/[-_]/)[0] !== lang || !p.includes('-')) continue;
    try {
      return Intl.getCanonicalLocales(p)[0];
    } catch {
      /* locale non valido: si ignora */
    }
  }
  return LANGS.find((l) => l.code === lang)!.locale;
}

let current: Lang = storedLang() ?? detectLang();
let currentLocale = pickLocale(current);
let dict: Dictionary = {};
let fallback: Dictionary = {};
let plural = new Intl.PluralRules(currentLocale);

/** Lingua in uso. */
export function lang(): Lang {
  return current;
}

/** Locale in uso, da passare a Intl e toLocaleString. */
export function locale(): string {
  return currentLocale;
}

/** Sceglie la lingua (la salva per i prossimi avvii). La pagina va ricaricata. */
export function saveLang(l: Lang): void {
  try {
    globalThis.localStorage?.setItem(STORE_KEY, l);
  } catch {
    /* archiviazione non disponibile */
  }
}

/** Imposta lingua e dizionari (usato all'avvio e nei test). */
export function setLanguage(l: Lang, d: Dictionary = {}, fb: Dictionary = {}, loc?: string): void {
  current = l;
  currentLocale = loc ?? pickLocale(l);
  dict = l === 'it' ? {} : d;
  fallback = l === 'it' || l === 'en' ? {} : fb;
  plural = new Intl.PluralRules(currentLocale);
}

type Params = Record<string, string | number | null | undefined>;

function fill(s: string, params?: Params): string {
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k] ?? '') : m));
}

function lookup(key: string): string | PluralForms | undefined {
  return dict[key] ?? fallback[key];
}

/** Traduce una scritta italiana; {nome} viene sostituito con params.nome. */
export function t(key: string, params?: Params): string {
  const v = lookup(key);
  const s = v === undefined ? key : typeof v === 'string' ? v : v.other;
  return fill(s, params);
}

/**
 * Plurale: tn(n, '{n} giorno', '{n} giorni'). La chiave nel dizionario è la forma plurale
 * italiana; il valore può dare tutte le forme della lingua ({ one, few, many, other }).
 */
export function tn(n: number, one: string, other: string, params?: Params): string {
  const p = { n: fmtCount(n), ...params };
  const v = lookup(other);
  if (v === undefined) return fill(Math.abs(n) === 1 ? one : other, p);
  if (typeof v === 'string') return fill(v, p);
  const rule = plural.select(n);
  return fill(v[rule] ?? v.other, p);
}

function fmtCount(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString(currentLocale) : String(n);
}

/** Separatore decimale della lingua (virgola in italiano, punto in inglese). */
export function decimalSep(): string {
  return (1.5).toLocaleString(currentLocale).charAt(1);
}

/** Lingua e dizionari, da passare a un worker (che non ha accesso alle preferenze della pagina). */
export interface LanguagePack { lang: Lang; locale: string; dict: Dictionary; fallback: Dictionary }

export function exportLanguage(): LanguagePack {
  return { lang: current, locale: currentLocale, dict, fallback };
}

export function importLanguage(p: LanguagePack): void {
  setLanguage(p.lang, p.dict, p.fallback, p.locale);
}

/** Carica il dizionario della lingua scelta (e quello inglese come ripiego). */
export async function loadLanguage(loaders: Record<string, () => Promise<unknown>>): Promise<void> {
  const get = async (l: Lang): Promise<Dictionary> => {
    const fn = loaders[l];
    if (!fn) return {};
    try {
      const m = (await fn()) as Dictionary | { default: Dictionary };
      return ('default' in m && typeof m.default === 'object' ? m.default : m) as Dictionary;
    } catch {
      return {};
    }
  };
  const l = current;
  const [d, fb] = await Promise.all([l === 'it' ? {} : get(l), l === 'it' || l === 'en' ? {} : get('en')]);
  setLanguage(l, d, fb, currentLocale);
  if (globalThis.document) document.documentElement.lang = l;
}
