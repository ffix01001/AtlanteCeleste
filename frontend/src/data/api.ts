/** Accesso al server locale (FastAPI). */

import type { CatalogBody, EphemChunk, OMM } from './types';
import type { Place } from '../core/places';
import { lang } from '../core/i18n';

const BASE = '/api';

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(BASE + path, { signal });
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try {
      const js = await r.json();
      if (js?.detail) msg = js.detail;
    } catch { /* corpo non JSON */ }
    throw new Error(msg);
  }
  return r.json() as Promise<T>;
}

async function postJson<T>(path: string): Promise<T> {
  // l'intestazione dice al server che la richiesta arriva dal programma (vedi only_from_atlante in main.py)
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'X-Atlante': '1' } });
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try {
      const js = await r.json();
      if (js?.detail) msg = js.detail;
    } catch { /* corpo non JSON */ }
    throw new Error(msg);
  }
  return r.json() as Promise<T>;
}

async function getBinary(path: string): Promise<ArrayBuffer> {
  const r = await fetch(BASE + path);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.arrayBuffer();
}

const enc = (id: string) => encodeURIComponent(id);

/** Albero dei tasselli di un catalogo stellare (vedi scripts/build_star_tiles.py). */
export interface StarIndexNode {
  id: string;
  c: [number, number, number]; // centro del cubo, parsec ICRS
  h: number;                   // metà lato, parsec
  n: number;                   // stelle nel tassello
  m: number;                   // magnitudine assoluta della più brillante del tassello
  sm: number;                  // ... e di tutto il ramo
  k: string[];                 // figli
}

export interface StarIndex {
  id: string;
  label: string;
  count: number;
  nodes: StarIndexNode[];
}

export interface StarName {
  id: string;
  name: string;
  p: [number, number, number];
  m: number;
  t: string | null;
}

export interface WikiSummary {
  title: string;
  extract: string;
  url: string;
  thumbnail?: string;
}

const wikiMemo = new Map<string, Promise<WikiSummary>>();

/**
 * Riassunto di Wikipedia. Prima si chiede al server locale (che lo tiene in
 * cache e funziona offline); se il server non ci riesce (Wikimedia a volte
 * rifiuta i programmi senza recapito), lo scarica il browser stesso e lo
 * consegna al server, così la volta dopo è già in cache.
 */
function wikiSummary(title: string, lang: string): Promise<WikiSummary> {
  const key = `${lang}:${title}`;
  let p = wikiMemo.get(key);
  if (!p) {
    p = (async () => {
      try {
        return await getJson<WikiSummary>(`/wiki?title=${enc(title)}&lang=${lang}`);
      } catch { /* si prova dal browser */ }
      const w = await wikiFromBrowser(title, lang);
      void fetch(`${BASE}/wiki/cache`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Atlante': '1' },
        body: JSON.stringify({ ...w, request_title: title, lang }),
      }).catch(() => {});
      return w;
    })();
    wikiMemo.set(key, p);
  }
  return p;
}

async function wikiFromBrowser(title: string, lang: string): Promise<WikiSummary> {
  const host = `https://${lang}.wikipedia.org`;
  try {
    const r = await fetch(`${host}/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`);
    if (r.ok) {
      const js = await r.json();
      if (js.type !== 'disambiguation' && js.extract) {
        return { title: js.title, extract: js.extract, url: js.content_urls?.desktop?.page ?? `${host}/wiki/${encodeURIComponent(title)}`, thumbnail: js.thumbnail?.source };
      }
    }
  } catch { /* si prova l'altra API */ }
  const q = new URLSearchParams({
    action: 'query', format: 'json', formatversion: '2', redirects: '1', origin: '*',
    prop: 'extracts|pageimages|info|pageprops', exintro: '1', explaintext: '1', inprop: 'url', pithumbsize: '400', titles: title,
  });
  const r = await fetch(`${host}/w/api.php?${q}`);
  if (!r.ok) throw new Error(`${r.status}`);
  const page = (await r.json())?.query?.pages?.[0];
  if (!page || page.missing || !page.extract || page.pageprops?.disambiguation !== undefined) throw new Error('Voce non trovata');
  return { title: page.title, extract: page.extract, url: page.fullurl, thumbnail: page.thumbnail?.source };
}

export const api = {
  health: () => getJson<{ ok: boolean; version: string; chunk_days: number; j2000: number }>('/health'),
  catalog: () => getJson<{ bodies: CatalogBody[]; chunk_days: number }>(`/catalog?lang=${lang()}`),
  body: (id: string) => getJson<CatalogBody & { content_md: string | null; content_lang?: string | null }>(`/body/${enc(id)}?lang=${lang()}`),
  ephem: (id: string, chunk: number, signal?: AbortSignal) => getJson<EphemChunk>(`/ephem/${enc(id)}?chunk=${chunk}`, signal),
  trail: (id: string) => getJson<EphemChunk>(`/trail/${enc(id)}`),
  smallBodies: (set: string) => getBinary(`/smallbodies/${set}.bin`),
  smallBody: (des: string) => getJson<Record<string, any>>(`/sb/${enc(des)}`),
  satellites: (group: string) => getJson<{ satellites: OMM[]; count: number }>(`/satellites/${group}`),
  satellite: (norad: number) => getJson<Record<string, any>>(`/satellite/${norad}`),
  /** voce di Wikipedia: nella lingua indicata dal catalogo (wiki_lang), altrimenti in quella dell'interfaccia */
  wiki: (title: string, wikiLang: string = lang()) => wikiSummary(title, wikiLang),
  starCatalogs: () => getJson<{ catalogs: { id: string; label: string; count: number }[]; default: string | null }>('/stars/catalogs'),
  starIndex: (cat: string) => getJson<StarIndex>(`/stars/${enc(cat)}/index.json`),
  starNames: (cat: string) => getJson<StarName[]>(`/stars/${enc(cat)}/names.json`),
  starTile: (cat: string, tile: string) => getBinary(`/stars/${enc(cat)}/tile/${enc(tile)}.atbl`),
  starInfo: (cat: string, id: string) => getJson<Record<string, any>>(`/stars/${enc(cat)}/info/${enc(id)}`),
  starHr: (cat: string) => getJson<HrHistogram>(`/stars/${enc(cat)}/hr.json`),
  closeApproaches: (days: number) => getJson<{ approaches: CloseApproach[] }>(`/events/approaches?days=${days}`),
  geocode: (q: string, signal?: AbortSignal) => getJson<{ places: Place[]; source: string }>(`/geocode?q=${encodeURIComponent(q)}&lang=${lang()}`, signal),
  textureUrl: (name: string, res: string) => `${BASE}/texture/${name}?res=${res}`,
  textureCredits: () => getJson<{ textures: Record<string, TextureCredit> }>('/textures/credits'),
  dsoManifest: () => getJson<{ objects: Record<string, DsoPhoto> }>('/dso/manifest'),
  dsoImageUrl: (name: string) => `${BASE}/dso/image/${enc(name)}`,
  modelsManifest: () => getJson<ModelsManifest>('/models/manifest'),
  gaiaStatus: () => getJson<GaiaStatus>('/stars/gaia'),
  gaiaStart: (gmax: number) => postJson<GaiaStatus>(`/stars/gaia/start?gmax=${gmax}`),
  gaiaCancel: () => postJson<GaiaStatus>('/stars/gaia/cancel'),
  modelUrl: (file: string) => `${BASE}/models/file/${enc(file)}`,
  /** dati di riferimento (data/reference), nella versione della lingua scelta se c'è */
  referenceUrl: (name: string, lng: string = lang()) => `${BASE}/reference/${name}?lang=${lng}`,
  /** dice al server la lingua scelta (la schermata d'avvio la userà la prossima volta) */
  tellLang: () => fetch(`${BASE}/lang`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Atlante': '1' }, body: JSON.stringify({ lang: lang() }),
  }).catch(() => {}),
};

/** Download delle stelle di Gaia dentro il programma (vedi backend/atlante/gaia_job.py). */
export interface GaiaStatus {
  state: 'idle' | 'downloading' | 'building' | 'done' | 'error' | 'cancelled';
  running: boolean;
  gmax: number | null;
  zones_done?: number;
  zones_total?: number;
  rows?: number;
  message?: string;
  error?: string | null;
  eta_s?: number | null;
  choices?: { gmax: number; stars: number; mb: number; minutes: [number, number]; zones_on_disk: number }[];
  catalog?: { id: string; label: string; count: number; gmax?: number } | null;
}

/** Un asse del modello e il bersaglio verso cui va puntato. */
export interface ModelAxis {
  axis: [number, number, number];
  /** 'earth' | 'sun' | 'nadir' | 'velocity' | 'eclnorth' | 'radec:<ra>,<dec>' */
  to: string;
}

/** Giunto di un pannello solare che ruota per seguire il Sole. */
export interface ModelTracker {
  match: string;
  axis: [number, number, number] | 'wing';
  normal: [number, number, number] | 'inward_z';
  two_sided?: boolean;
}

/** Modello 3D di una sonda o di un satellite (assi in metri, nel sistema del modello). */
export interface ModelSpec {
  file: string;
  name: string;
  /** come è orientato, in una frase (per la scheda) */
  note?: string;
  /** costruito nel programma (render/procedural.ts), senza file */
  procedural?: boolean;
  /** raggio da inquadrare (m), se diverso da quello stimato dalle dimensioni */
  frame_m?: number;
  size_m: [number, number, number];
  radius_m: number;
  attitude: { primary: ModelAxis; secondary: ModelAxis };
  spin_rpm?: number;
  trackers?: ModelTracker[];
  /** da dove arriva la camera: angolo di fase (dal Sole) ed elevazione sull'eclittica, in gradi */
  view?: { phase_deg: number; elev_deg: number };
  credit: { fonte: string; url: string; licenza: string; licenza_url: string; autori: string; originale: string };
}

export interface ModelsManifest {
  models: Record<string, ModelSpec>;
  /** id del corpo (o "norad:<numero>") -> chiave del modello */
  bodies: Record<string, string>;
}

/** Passaggio ravvicinato alla Terra (NASA/JPL CNEOS). */
export interface CloseApproach {
  des: string | null;
  name: string;
  date: string | null;      // "2029-Apr-13 21:46" (TDB)
  jd: number | null;
  dist_au: number | null;
  dist_min_au: number | null;
  v_rel_kms: number | null;
  h: number | null;
  diameter_m: [number, number] | null;
}

/** Diagramma di Hertzsprung-Russell: stelle per casella (colore B−V × magnitudine assoluta). */
export interface HrHistogram {
  bv: [number, number, number];   // da, a, colonne
  mag: [number, number, number];  // da, a, righe
  counts: number[];               // riga per riga (magnitudine), colonna per colonna (colore)
  total: number;
}

/** Foto del cielo profondo: centro, estensione in cielo e crediti. */
export interface DsoPhoto {
  file: string;
  size: [number, number];
  center: [number, number];
  width_deg: number;
  height_deg: number;
  /** centro della foto rispetto all'oggetto sul piano del cielo: gradi verso est e verso nord */
  offset_deg?: [number, number];
  crediti: { autore: string; url?: string | null }[];
  fonte: string;
  url: string;
}

/** Provenienza di una texture (autori e licenza) e come mostrarla. */
export interface TextureCredit {
  gain?: number;          // schiarimento per i corpi molto scuri
  grigia?: boolean;       // mappa in bianco e nero: si tinge con il colore del corpo
  hi?: boolean;           // esiste una versione più grande (caricata solo da vicino)
  fonte?: string;
  url?: string;
  autori?: string[];
  licenza?: string;
  licenza_url?: string;
}
