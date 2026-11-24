/** Vocabolario italiano dell'interfaccia (tipi di corpi, codici dei cataloghi). */

import { t } from '../core/i18n';
import type { Body } from '../sim/body';

const MOON_OF: Record<string, string> = {
  'naif:399': t('Luna della Terra'),
  'naif:499': t('Luna di Marte'),
  'naif:599': t('Luna di Giove'),
  'naif:699': t('Luna di Saturno'),
  'naif:799': t('Luna di Urano'),
  'naif:899': t('Luna di Nettuno'),
  'naif:999': t('Luna di Plutone'),
};

const ORBITING: Record<string, string> = {
  'naif:399': t('Sonda spaziale, in orbita della Terra'),
  'naif:499': t('Sonda spaziale, in orbita di Marte'),
  'naif:599': t('Sonda spaziale, in orbita di Giove'),
  'naif:699': t('Sonda spaziale, in orbita di Saturno'),
};

export function kindLabel(b: Body): string {
  switch (b.kind) {
    case 'star': {
      if (b.data.sky_orbit) return t('Stella in orbita attorno a Sagittarius A*');
      if (b.data.exo) return b.data.phys?.spectral?.startsWith('pulsar') ? t('Pulsar con pianeti') : t('Stella con pianeti');
      if (!b.dynamic) return t('La nostra stella · nana gialla');
      const n = b.extra.nature?.name as string | undefined;
      return n ? t('Stella · {n}', { n }) : t('Stella');
    }
    case 'planet':
      if (b.data.exo) return b.parent ? t('Esopianeta di {stella}', { stella: b.parent.name }) : t('Esopianeta');
      return b.radius > 20000 ? t('Pianeta gigante') : t('Pianeta roccioso');
    case 'dwarf': return b.id === 'sb:90377' ? t('Oggetto transnettuniano (candidato pianeta nano)') : t('Pianeta nano');
    case 'moon': return b.parent ? MOON_OF[b.parent.id] ?? t('Luna di {pianeta}', { pianeta: b.parent.name }) : t('Luna');
    case 'asteroid': return t('Asteroide');
    case 'comet': return b.data.interstellar ? t('Oggetto interstellare') : t('Cometa');
    case 'spacecraft': return b.parent && b.parent.id !== 'naif:10' ? (ORBITING[b.parent.id] ?? t('Sonda spaziale, in orbita attorno a {corpo}', { corpo: b.parent.name })) : t('Sonda spaziale');
    case 'satellite': return t('Satellite artificiale');
    case 'barycenter': return t('Punto di riferimento');
    case 'galaxy': return b.id === 'gal:mw' ? t('La nostra galassia') : t('Galassia');
    case 'blackhole': return t('Buco nero supermassiccio');
    case 'nebula': return t('Nebulosa');
    case 'cluster': return b.data.globular ? t('Ammasso globulare') : t('Ammasso aperto di stelle');
    case 'arm': return t('Braccio a spirale della Via Lattea');
  }
}

export const OWNER_IT: Record<string, string> = {
  US: t('Stati Uniti'), PRC: t('Cina'), CIS: t('Russia (ex URSS)'), ESA: t('Agenzia Spaziale Europea'), FR: t('Francia'), IT: t('Italia'),
  JPN: t('Giappone'), IND: t('India'), UK: t('Regno Unito'), ISS: t('Stazione Spaziale Internazionale (consorzio)'), GER: t('Germania'),
  CA: t('Canada'), SKOR: t('Corea del Sud'), NKOR: t('Corea del Nord'), ISRA: t('Israele'), EUTE: t('Eutelsat'), SES: 'SES', O3B: t('O3b (SES)'),
  ITSO: t('Intelsat'), GLOB: t('Globalstar'), IRID: t('Iridium'), ORB: t('Orbcomm'), AB: t('Arabsat'), BRAZ: t('Brasile'), SPN: t('Spagna'),
  LUXE: t('Lussemburgo'), NETH: t('Paesi Bassi'), AUS: t('Australia'), TURK: t('Turchia'), UAE: t('Emirati Arabi Uniti'), SAUD: t('Arabia Saudita'),
  INDO: t('Indonesia'), MEX: t('Messico'), ARGN: t('Argentina'), SWTZ: t('Svizzera'), SING: t('Singapore'), TWN: t('Taiwan'), NOR: t('Norvegia'),
  FIN: t('Finlandia'), SWED: t('Svezia'), DEN: t('Danimarca'), POL: t('Polonia'), UKR: t('Ucraina'), KAZ: t('Kazakistan'), IRAN: t('Iran'),
  NZ: t('Nuova Zelanda'), SAFR: t('Sudafrica'), THAI: t('Thailandia'), VTNM: t('Vietnam'), PHIL: t('Filippine'), EGYP: t('Egitto'), NIG: t('Nigeria'),
  EUME: 'EUMETSAT', ESRO: 'ESRO', NATO: 'NATO', CHLE: t('Cile'), PER: t('Perù'), COL: t('Colombia'), GREC: t('Grecia'), CZE: t('Repubblica Ceca'),
  BEL: t('Belgio'), AUT: t('Austria'), POR: t('Portogallo'), IRL: t('Irlanda'), HUN: t('Ungheria'), LTU: t('Lituania'), EST: t('Estonia'),
  SVN: t('Slovenia'), BGR: t('Bulgaria'), ROM: t('Romania'), MALA: t('Malesia'), PAKI: t('Pakistan'), BGD: t('Bangladesh'), QAT: t('Qatar'),
  KWT: t('Kuwait'), MA: t('Marocco'), ALG: t('Algeria'), TUN: t('Tunisia'), ETH: t('Etiopia'), KEN: t('Kenya'), RWA: t('Ruanda'), GHA: t('Ghana'),
  ANG: t('Angola'), BOL: t('Bolivia'), ECU: t('Ecuador'), URY: t('Uruguay'), VENZ: t('Venezuela'), JOR: t('Giordania'), NPL: t('Nepal'), LKA: t('Sri Lanka'),
  MNG: t('Mongolia'), AZER: t('Azerbaigian'), BELA: t('Bielorussia'), LAOS: t('Laos'),
};

export const SITE_IT: Record<string, string> = {
  AFETR: t('Cape Canaveral (Florida, USA)'), AFWTR: t('Vandenberg (California, USA)'), TYMSC: t('Baikonur (Kazakistan)'),
  PKMTR: t('Plesetsk (Russia)'), VOSTO: t('Vostočnyj (Russia)'), KYMSC: t('Kapustin Jar (Russia)'), JSC: t('Jiuquan (Cina)'),
  TAISC: t('Taiyuan (Cina)'), XICLF: t('Xichang (Cina)'), WSC: t('Wenchang (Cina)'), YSLA: t('Mar Giallo, lancio da piattaforma (Cina)'),
  FRGUI: t('Kourou (Guyana francese)'), SRILR: t('Sriharikota (India)'), TNSTA: t('Tanegashima (Giappone)'), KSCUT: t('Uchinoura (Giappone)'),
  KODAK: t('Kodiak (Alaska, USA)'), WLPIS: t('Wallops (Virginia, USA)'), RLLB: t('Mahia (Nuova Zelanda)'), SEAL: t('Sea Launch (oceano Pacifico)'),
  SVOBO: t('Svobodnyj (Russia)'), YAVNE: t('Palmachim (Israele)'), NSC: t('Naro (Corea del Sud)'), SEMLS: t('Semnan (Iran)'),
  SNMLP: t('San Marco (Kenya), base italiana'), ERAS: t('Lancio da aereo (Pegasus)'), KWAJ: t('Kwajalein (Isole Marshall)'),
  DLS: t('Dombarovskij (Russia)'), SUBL: t('Lancio da sottomarino'), HGSTR: t('Hammaguir (Algeria)'), WOMRA: t('Woomera (Australia)'),
};

export const OBJTYPE_IT: Record<string, string> = {
  PAY: t('Carico utile (satellite)'), 'R/B': t('Stadio di razzo'), DEB: t('Detrito'), UNK: t('Sconosciuto'),
};

export const OPS_IT: Record<string, string> = {
  '+': t('Operativo'), '-': t('Non operativo'), P: t('Parzialmente operativo'), B: t('Di riserva'), S: t('Di scorta'),
  X: t('Missione estesa'), D: t('Rientrato'), '?': t('Sconosciuto'),
};
