/**
 * Luoghi dell'osservatore: da dove si guarda il cielo per eventi, orari e visibilità.
 *
 * Un elenco di città è incluso (funziona anche senza rete); per qualsiasi altro luogo c'è
 * la ricerca in rete (Open-Meteo, dati GeoNames) o le coordinate scritte a mano.
 * Ogni luogo ha il suo fuso orario: gli orari degli eventi sono quelli dell'orologio del posto.
 */

import { lang, locale, t } from './i18n';
import { normalize } from './format';

export interface Place {
  name: string;
  lat: number;
  lon: number;
  /** metri sul livello del mare */
  elev?: number;
  /** fuso orario IANA (es. "Europe/Rome"); se manca, quello del computer */
  tz?: string;
  /** paese o regione, per distinguere omonimi */
  where?: string;
}

export const DEFAULT_PLACE: Place = { name: t('Roma'), lat: 41.9028, lon: 12.4964, elev: 21, tz: 'Europe/Rome', where: t('{regione}, Italia', { regione: t('Lazio') }) };

type Row = [string, number, number, string?, string?];

// [nome, latitudine, longitudine, regione o paese, fuso orario (se non Europe/Rome)]
const IT: Row[] = [
  ['Roma', 41.9028, 12.4964, 'Lazio'], ['Milano', 45.4642, 9.19, 'Lombardia'], ['Napoli', 40.8518, 14.2681, 'Campania'],
  ['Torino', 45.0703, 7.6869, 'Piemonte'], ['Palermo', 38.1157, 13.3615, 'Sicilia'], ['Genova', 44.4056, 8.9463, 'Liguria'],
  ['Bologna', 44.4949, 11.3426, 'Emilia-Romagna'], ['Firenze', 43.7696, 11.2558, 'Toscana'], ['Bari', 41.1171, 16.8719, 'Puglia'],
  ['Catania', 37.5079, 15.083, 'Sicilia'], ['Venezia', 45.4408, 12.3155, 'Veneto'], ['Verona', 45.4384, 10.9916, 'Veneto'],
  ['Messina', 38.1938, 15.554, 'Sicilia'], ['Padova', 45.4064, 11.8768, 'Veneto'], ['Trieste', 45.6495, 13.7768, 'Friuli-Venezia Giulia'],
  ['Brescia', 45.5416, 10.2118, 'Lombardia'], ['Parma', 44.8015, 10.3279, 'Emilia-Romagna'], ['Taranto', 40.4644, 17.247, 'Puglia'],
  ['Prato', 43.8777, 11.1022, 'Toscana'], ['Modena', 44.6471, 10.9252, 'Emilia-Romagna'], ['Reggio Calabria', 38.1113, 15.6473, 'Calabria'],
  ['Reggio Emilia', 44.6989, 10.6297, 'Emilia-Romagna'], ['Perugia', 43.1107, 12.3908, 'Umbria'], ['Ravenna', 44.4184, 12.2035, 'Emilia-Romagna'],
  ['Livorno', 43.5485, 10.3106, 'Toscana'], ['Cagliari', 39.2238, 9.1217, 'Sardegna'], ['Foggia', 41.4622, 15.5446, 'Puglia'],
  ['Rimini', 44.0678, 12.5695, 'Emilia-Romagna'], ['Salerno', 40.6824, 14.7681, 'Campania'], ['Ferrara', 44.8381, 11.6198, 'Emilia-Romagna'],
  ['Sassari', 40.7259, 8.5557, 'Sardegna'], ['Latina', 41.4676, 12.9036, 'Lazio'], ['Monza', 45.5845, 9.2744, 'Lombardia'],
  ['Siracusa', 37.0755, 15.2866, 'Sicilia'], ['Pescara', 42.4618, 14.2161, 'Abruzzo'], ['Bergamo', 45.6983, 9.6773, 'Lombardia'],
  ['Trento', 46.0748, 11.1217, 'Trentino-Alto Adige'], ['Vicenza', 45.5455, 11.5354, 'Veneto'], ['Bolzano', 46.4983, 11.3548, 'Trentino-Alto Adige'],
  ['Novara', 45.4469, 8.6219, 'Piemonte'], ['Piacenza', 45.0526, 9.693, 'Emilia-Romagna'], ['Ancona', 43.6158, 13.5189, 'Marche'],
  ['Udine', 46.0711, 13.2346, 'Friuli-Venezia Giulia'], ['Arezzo', 43.4633, 11.8796, 'Toscana'], ['Lecce', 40.3515, 18.175, 'Puglia'],
  ['Pesaro', 43.9098, 12.9131, 'Marche'], ['La Spezia', 44.1025, 9.8241, 'Liguria'], ['Como', 45.8081, 9.0852, 'Lombardia'],
  ['Pisa', 43.7228, 10.4017, 'Toscana'], ["L'Aquila", 42.3498, 13.3995, 'Abruzzo'], ['Potenza', 40.6404, 15.8056, 'Basilicata'],
  ['Campobasso', 41.5603, 14.6627, 'Molise'], ['Aosta', 45.7376, 7.3172, "Valle d'Aosta"], ['Catanzaro', 38.9098, 16.5877, 'Calabria'],
  ['Cosenza', 39.2983, 16.2537, 'Calabria'], ['Matera', 40.6664, 16.6043, 'Basilicata'], ['Siena', 43.3188, 11.3308, 'Toscana'],
  ['Lucca', 43.8429, 10.5027, 'Toscana'], ['Viterbo', 42.4207, 12.1077, 'Lazio'], ['Frosinone', 41.6396, 13.3426, 'Lazio'],
  ['Rieti', 42.4045, 12.8567, 'Lazio'], ['Benevento', 41.1298, 14.7826, 'Campania'], ['Caserta', 41.0745, 14.3324, 'Campania'],
  ['Avellino', 40.9146, 14.7906, 'Campania'], ['Agrigento', 37.3111, 13.5765, 'Sicilia'], ['Trapani', 38.0176, 12.5372, 'Sicilia'],
  ['Ragusa', 36.9269, 14.7255, 'Sicilia'], ['Enna', 37.5671, 14.2795, 'Sicilia'], ['Caltanissetta', 37.4901, 14.0629, 'Sicilia'],
  ['Olbia', 40.9235, 9.4964, 'Sardegna'], ['Nuoro', 40.3209, 9.3305, 'Sardegna'], ['Oristano', 39.9062, 8.5886, 'Sardegna'],
  ['Teramo', 42.6589, 13.7044, 'Abruzzo'], ['Chieti', 42.351, 14.1675, 'Abruzzo'], ['Macerata', 43.3007, 13.4532, 'Marche'],
  ['Ascoli Piceno', 42.8536, 13.5749, 'Marche'], ['Terni', 42.5636, 12.6427, 'Umbria'], ['Rovigo', 45.0703, 11.7904, 'Veneto'],
  ['Treviso', 45.6669, 12.243, 'Veneto'], ['Belluno', 46.1425, 12.2167, 'Veneto'], ['Pordenone', 45.9564, 12.6615, 'Friuli-Venezia Giulia'],
  ['Gorizia', 45.9409, 13.6214, 'Friuli-Venezia Giulia'], ['Sondrio', 46.1699, 9.8715, 'Lombardia'], ['Lecco', 45.8566, 9.3977, 'Lombardia'],
  ['Varese', 45.8206, 8.8251, 'Lombardia'], ['Pavia', 45.1847, 9.1582, 'Lombardia'], ['Cremona', 45.1335, 10.0227, 'Lombardia'],
  ['Mantova', 45.1564, 10.7914, 'Lombardia'], ['Lodi', 45.3142, 9.5035, 'Lombardia'], ['Cuneo', 44.3845, 7.5427, 'Piemonte'],
  ['Asti', 44.9008, 8.2064, 'Piemonte'], ['Alessandria', 44.9133, 8.615, 'Piemonte'], ['Biella', 45.5629, 8.0583, 'Piemonte'],
  ['Vercelli', 45.3202, 8.4185, 'Piemonte'], ['Savona', 44.3091, 8.4772, 'Liguria'], ['Imperia', 43.8897, 8.039, 'Liguria'],
  ['Massa', 44.0354, 10.1393, 'Toscana'], ['Grosseto', 42.7635, 11.1124, 'Toscana'], ['Pistoia', 43.933, 10.9177, 'Toscana'],
  ['Forlì', 44.2227, 12.0407, 'Emilia-Romagna'], ['Cesena', 44.1391, 12.2431, 'Emilia-Romagna'], ['Brindisi', 40.6327, 17.9418, 'Puglia'],
  ['Andria', 41.2271, 16.2952, 'Puglia'], ['Barletta', 41.3196, 16.2813, 'Puglia'], ['Crotone', 39.0808, 17.1271, 'Calabria'],
  ['Vibo Valentia', 38.6759, 16.1006, 'Calabria'], ['Isernia', 41.5944, 14.2333, 'Molise'],
  ['San Marino', 43.9424, 12.4578, 'San Marino'], ['Città del Vaticano', 41.9029, 12.4534, 'Vaticano'],
];

const WORLD: Row[] = [
  ['Londra', 51.5072, -0.1276, 'Regno Unito', 'Europe/London'], ['Parigi', 48.8566, 2.3522, 'Francia', 'Europe/Paris'],
  ['Berlino', 52.52, 13.405, 'Germania', 'Europe/Berlin'], ['Madrid', 40.4168, -3.7038, 'Spagna', 'Europe/Madrid'],
  ['Barcellona', 41.3874, 2.1686, 'Spagna', 'Europe/Madrid'], ['Lisbona', 38.7223, -9.1393, 'Portogallo', 'Europe/Lisbon'],
  ['Vienna', 48.2082, 16.3738, 'Austria', 'Europe/Vienna'], ['Zurigo', 47.3769, 8.5417, 'Svizzera', 'Europe/Zurich'],
  ['Ginevra', 46.2044, 6.1432, 'Svizzera', 'Europe/Zurich'], ['Lugano', 46.0037, 8.9511, 'Svizzera', 'Europe/Zurich'],
  ['Bruxelles', 50.8503, 4.3517, 'Belgio', 'Europe/Brussels'], ['Amsterdam', 52.3676, 4.9041, 'Paesi Bassi', 'Europe/Amsterdam'],
  ['Atene', 37.9838, 23.7275, 'Grecia', 'Europe/Athens'], ['Stoccolma', 59.3293, 18.0686, 'Svezia', 'Europe/Stockholm'],
  ['Oslo', 59.9139, 10.7522, 'Norvegia', 'Europe/Oslo'], ['Helsinki', 60.1699, 24.9384, 'Finlandia', 'Europe/Helsinki'],
  ['Copenaghen', 55.6761, 12.5683, 'Danimarca', 'Europe/Copenhagen'], ['Dublino', 53.3498, -6.2603, 'Irlanda', 'Europe/Dublin'],
  ['Varsavia', 52.2297, 21.0122, 'Polonia', 'Europe/Warsaw'], ['Praga', 50.0755, 14.4378, 'Repubblica Ceca', 'Europe/Prague'],
  ['Budapest', 47.4979, 19.0402, 'Ungheria', 'Europe/Budapest'], ['Bucarest', 44.4268, 26.1025, 'Romania', 'Europe/Bucharest'],
  ['Lubiana', 46.0569, 14.5058, 'Slovenia', 'Europe/Ljubljana'], ['Zagabria', 45.815, 15.9819, 'Croazia', 'Europe/Zagreb'],
  ['Malta (La Valletta)', 35.8989, 14.5146, 'Malta', 'Europe/Malta'], ['Istanbul', 41.0082, 28.9784, 'Turchia', 'Europe/Istanbul'],
  ['Mosca', 55.7558, 37.6173, 'Russia', 'Europe/Moscow'], ['Reykjavík', 64.1466, -21.9426, 'Islanda', 'Atlantic/Reykjavik'],
  ['Tromsø', 69.6492, 18.9553, 'Norvegia (oltre il Circolo polare)', 'Europe/Oslo'],
  ['Longyearbyen', 78.2232, 15.6267, 'Svalbard', 'Arctic/Longyearbyen'],
  ['New York', 40.7128, -74.006, 'Stati Uniti', 'America/New_York'], ['Washington', 38.9072, -77.0369, 'Stati Uniti', 'America/New_York'],
  ['Chicago', 41.8781, -87.6298, 'Stati Uniti', 'America/Chicago'], ['Los Angeles', 34.0522, -118.2437, 'Stati Uniti', 'America/Los_Angeles'],
  ['San Francisco', 37.7749, -122.4194, 'Stati Uniti', 'America/Los_Angeles'], ['Miami', 25.7617, -80.1918, 'Stati Uniti', 'America/New_York'],
  ['Houston', 29.7604, -95.3698, 'Stati Uniti', 'America/Chicago'], ['Honolulu', 21.3069, -157.8583, 'Hawaii', 'Pacific/Honolulu'],
  ['Mauna Kea (osservatori)', 19.8207, -155.4681, 'Hawaii', 'Pacific/Honolulu'], ['Anchorage', 61.2181, -149.9003, 'Alaska', 'America/Anchorage'],
  ['Toronto', 43.6532, -79.3832, 'Canada', 'America/Toronto'], ['Montréal', 45.5019, -73.5674, 'Canada', 'America/Toronto'],
  ['Vancouver', 49.2827, -123.1207, 'Canada', 'America/Vancouver'], ['Città del Messico', 19.4326, -99.1332, 'Messico', 'America/Mexico_City'],
  ['L\'Avana', 23.1136, -82.3666, 'Cuba', 'America/Havana'], ['Bogotá', 4.711, -74.0721, 'Colombia', 'America/Bogota'],
  ['Lima', -12.0464, -77.0428, 'Perù', 'America/Lima'], ['Santiago del Cile', -33.4489, -70.6693, 'Cile', 'America/Santiago'],
  ['San Pedro de Atacama', -22.9087, -68.1997, 'Cile (deserto di Atacama)', 'America/Santiago'],
  ['Buenos Aires', -34.6037, -58.3816, 'Argentina', 'America/Argentina/Buenos_Aires'], ['Ushuaia', -54.8019, -68.303, 'Argentina', 'America/Argentina/Ushuaia'],
  ['San Paolo', -23.5505, -46.6333, 'Brasile', 'America/Sao_Paulo'], ['Rio de Janeiro', -22.9068, -43.1729, 'Brasile', 'America/Sao_Paulo'],
  ['Il Cairo', 30.0444, 31.2357, 'Egitto', 'Africa/Cairo'], ['Marrakech', 31.6295, -7.9811, 'Marocco', 'Africa/Casablanca'],
  ['Tunisi', 36.8065, 10.1815, 'Tunisia', 'Africa/Tunis'], ['Lagos', 6.5244, 3.3792, 'Nigeria', 'Africa/Lagos'],
  ['Nairobi', -1.2921, 36.8219, 'Kenya', 'Africa/Nairobi'], ['Città del Capo', -33.9249, 18.4241, 'Sudafrica', 'Africa/Johannesburg'],
  ['Johannesburg', -26.2041, 28.0473, 'Sudafrica', 'Africa/Johannesburg'], ['Dubai', 25.2048, 55.2708, 'Emirati Arabi Uniti', 'Asia/Dubai'],
  ['Gerusalemme', 31.7683, 35.2137, 'Medio Oriente', 'Asia/Jerusalem'], ['Teheran', 35.6892, 51.389, 'Iran', 'Asia/Tehran'],
  ['Mumbai', 19.076, 72.8777, 'India', 'Asia/Kolkata'], ['Nuova Delhi', 28.6139, 77.209, 'India', 'Asia/Kolkata'],
  ['Bangkok', 13.7563, 100.5018, 'Thailandia', 'Asia/Bangkok'], ['Singapore', 1.3521, 103.8198, 'Singapore', 'Asia/Singapore'],
  ['Giacarta', -6.2088, 106.8456, 'Indonesia', 'Asia/Jakarta'], ['Hong Kong', 22.3193, 114.1694, 'Cina', 'Asia/Hong_Kong'],
  ['Pechino', 39.9042, 116.4074, 'Cina', 'Asia/Shanghai'], ['Shanghai', 31.2304, 121.4737, 'Cina', 'Asia/Shanghai'],
  ['Seul', 37.5665, 126.978, 'Corea del Sud', 'Asia/Seoul'], ['Tokyo', 35.6762, 139.6503, 'Giappone', 'Asia/Tokyo'],
  ['Manila', 14.5995, 120.9842, 'Filippine', 'Asia/Manila'], ['Sydney', -33.8688, 151.2093, 'Australia', 'Australia/Sydney'],
  ['Melbourne', -37.8136, 144.9631, 'Australia', 'Australia/Melbourne'], ['Perth', -31.9505, 115.8605, 'Australia', 'Australia/Perth'],
  ['Auckland', -36.8485, 174.7633, 'Nuova Zelanda', 'Pacific/Auckland'],
  ['La Palma (osservatorio del Roque)', 28.7606, -17.8816, 'Canarie, Spagna', 'Atlantic/Canary'],
  ['Base McMurdo', -77.8463, 166.6683, 'Antartide', 'Antarctica/McMurdo'],
];

const ELEV: Record<string, number> = {
  'Mauna Kea (osservatori)': 4200, 'San Pedro de Atacama': 2400, 'La Palma (osservatorio del Roque)': 2400, Aosta: 583,
  'Città del Messico': 2240, Bogotá: 2640, Potenza: 819, Enna: 931, Campobasso: 701, "L'Aquila": 714, Johannesburg: 1753, Nairobi: 1795,
};

// nomi e regioni si traducono qui (le tabelle restano in italiano: tools/i18n_keys.mjs ne raccoglie le scritte)
const toPlace = (tzDefault: string, italy: boolean) => (r: Row): Place => ({
  name: t(r[0]), lat: r[1], lon: r[2],
  where: italy && r[3] !== 'San Marino' && r[3] !== 'Vaticano' ? t('{regione}, Italia', { regione: t(r[3] ?? '') }) : t(r[3] ?? ''),
  tz: r[4] ?? tzDefault, elev: ELEV[r[0]] ?? 0,
});

export const CITIES: Place[] = [
  ...IT.map(toPlace('Europe/Rome', true)),
  ...WORLD.map(toPlace('UTC', false)),
];

/** Città incluse che corrispondono alla ricerca (prima quelle che iniziano con il testo). */
export function searchCities(q: string, max = 8): Place[] {
  const n = normalize(q);
  if (!n) return [];
  const starts: Place[] = [], contains: Place[] = [];
  for (const c of CITIES) {
    const cn = normalize(c.name);
    if (cn.startsWith(n)) starts.push(c);
    else if (cn.includes(n) || normalize(c.where ?? '').startsWith(n)) contains.push(c);
  }
  return [...starts, ...contains].slice(0, max);
}

/** "41,90° N, 12,50° E" */
export function fmtLatLon(p: { lat: number; lon: number }): string {
  const f = (x: number) => Math.abs(x).toLocaleString(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${f(p.lat)}° ${p.lat >= 0 ? t('N') : t('S')}, ${f(p.lon)}° ${p.lon >= 0 ? t('E') : t('O')}`;
}

/** "da Roma", "dall'Aquila"... */
export function fromPlace(p: Place): string {
  if (lang() !== 'it') return t('da {luogo}', { luogo: p.name });
  if (/^L'/i.test(p.name)) return `dall'${p.name.slice(2)}`;
  if (/^Il /.test(p.name)) return `dal ${p.name.slice(3)}`;
  if (/^La /.test(p.name)) return `dalla ${p.name.slice(3)}`;
  return `da ${p.name}`;
}

/** Il fuso orario del luogo è valido? (alcuni browser non li conoscono tutti) */
export function validTz(tz: string | undefined): string | undefined {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat(locale(), { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

/** "21:47" all'ora del luogo */
export function fmtClock(d: Date, tz?: string): string {
  return d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', timeZone: validTz(tz) });
}

/** "sabato 14 novembre 2026, 21:47" all'ora del luogo */
export function fmtWhenFull(d: Date, tz?: string): string {
  return d.toLocaleString(locale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: validTz(tz) });
}

/** Giorno, mese breve e anno all'ora del luogo (per raggruppare gli eventi) */
export function localParts(d: Date, tz?: string): { day: string; mon: string; month: number; year: number } {
  const z = validTz(tz);
  const day = d.toLocaleDateString(locale(), { day: 'numeric', timeZone: z });
  const mon = d.toLocaleDateString(locale(), { month: 'short', timeZone: z }).replace('.', '');
  const month = Number(d.toLocaleDateString('en-US', { month: 'numeric', timeZone: z })) - 1;
  const year = Number(d.toLocaleDateString('en-US', { year: 'numeric', timeZone: z }));
  return { day, mon, month, year };
}

/** Punti cardinali in italiano (16 direzioni) da un azimut in gradi (0 = nord, 90 = est). */
export function compass(az: number): string {
  const D = [t('nord'), t('nord-nordest'), t('nordest'), t('est-nordest'), t('est'), t('est-sudest'), t('sudest'), t('sud-sudest'),
    t('sud'), t('sud-sudovest'), t('sudovest'), t('ovest-sudovest'), t('ovest'), t('ovest-nordovest'), t('nordovest'), t('nord-nordovest')];
  return D[Math.round((((az % 360) + 360) % 360) / 22.5) % 16];
}
