/**
 * Nomi di stelle e costellazioni nella lingua dell'interfaccia.
 *
 * I cataloghi generati contengono i nomi italiani; per le altre lingue si passa dal nome
 * proprio IAU (stelle_nomi_it.json: IAU -> italiano) a quello della lingua scelta
 * (stelle_nomi_<lingua>.json), e se manca si usa il nome IAU.
 */

import { lang } from '../core/i18n';
import { api } from './api';

type NameMap = Record<string, string>;

async function ref(name: string, lng?: string): Promise<NameMap> {
  try {
    const r = await fetch(api.referenceUrl(name, lng));
    if (!r.ok) return {};
    const js = (await r.json()) as NameMap;
    return Object.fromEntries(Object.entries(js).filter(([k, v]) => !k.startsWith('_') && typeof v === 'string'));
  } catch {
    return {};
  }
}

let starFn: Promise<(itName: string) => string> | null = null;

/** Funzione che traduce un nome di stella italiano (quello dei cataloghi) nella lingua scelta. */
export function starNameTranslator(): Promise<(itName: string) => string> {
  starFn ??= (async () => {
    if (lang() === 'it') return (n: string) => n;
    const [it, local] = await Promise.all([ref('stelle_nomi_it', 'it'), ref('stelle_nomi_it')]);
    const iau = new Map(Object.entries(it).map(([proper, itName]) => [itName, proper]));
    // se il file della lingua non c'è, il server rimanda quello italiano: allora vale il nome IAU
    const same = Object.keys(local).every((k) => local[k] === it[k]);
    return (n: string) => {
      const proper = iau.get(n);
      if (!proper) return n;
      return (!same && local[proper]) || proper;
    };
  })();
  return starFn;
}

let constNames: Promise<NameMap> | null = null;

/** Nomi delle costellazioni nella lingua scelta, per abbreviazione IAU (Ori, UMa, ...). */
export function constellationNames(): Promise<NameMap> {
  constNames ??= ref('costellazioni_it');
  return constNames;
}
