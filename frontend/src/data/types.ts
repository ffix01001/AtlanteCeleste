/** Tipi dei dati che arrivano dal server (catalogo, effemeridi, ...). */

import type { SkyOrbit } from '../ephem/skyorbit';

export type Kind =
  | 'barycenter' | 'star' | 'planet' | 'dwarf' | 'moon'
  | 'asteroid' | 'comet' | 'spacecraft' | 'satellite'
  // oltre il Sistema Solare
  | 'galaxy' | 'blackhole' | 'nebula' | 'cluster' | 'arm';

/** Tipi "lontani": posizione fissa, niente orbita, distanze in anni luce. */
export const DEEP_KINDS: ReadonlySet<Kind> = new Set(['galaxy', 'blackhole', 'nebula', 'cluster', 'arm']);

/** Posizione fissa: coordinate equatoriali ICRS + distanza, oppure un punto del modello galattico (kpc). */
export interface FixedPosition {
  ra_deg?: number;
  dec_deg?: number;
  dist_pc?: number;
  model_kpc?: [number, number, number];
}

/** Visibilità dell'etichetta in base alla distanza della camera dal Sole o dall'oggetto. */
export interface ShowRange {
  from: 'sun' | 'self';
  min_pc?: number;
  max_pc?: number;
}

export type Range2 = [number, number];

export interface RotationModel {
  model: 'iau' | 'sync' | 'spin' | 'none';
  ra?: Range2;
  dec?: Range2;
  w?: Range2;
  period_h?: number;
}

export interface StandishElements {
  frame: 'ecliptic_j2000';
  a: Range2; e: Range2; i: Range2; L: Range2; lp: Range2; node: Range2;
}

export interface MeanOrbit {
  a_km: number;
  period_d: number;
  i_deg?: number;
  plane?: 'ecliptic' | 'equator';
}

export interface Phys {
  mass_kg?: number;
  gm_km3s2?: number;
  radius_km?: number;
  density_gcm3?: number;
  gravity_ms2?: number;
  escape_kms?: number;
  rotation_h?: number;
  solar_day_h?: number;
  obliquity_deg?: number;
  temp_c?: number;
  temp_range_c?: [number, number];
  temp_surface_k?: number;
  temp_core_k?: number;
  pressure_bar?: number;
  albedo?: number | string;
  moons?: number;
  moons_note?: string;
  luminosity_w?: number;
  spectral?: string;
  age_gyr?: number;
  dimensions?: string;
  /** classificazione morfologica (galassie) */
  morphology?: string;
  period_y?: number;
  eccentricity?: number;
  perihelion_au?: number;
  mass_launch_kg?: number;
  agency?: string;
  status?: string;
  launch?: { date?: string; vehicle?: string; site?: string };
  discovery?: { by?: string; date?: string; place?: string; method?: string };
}

export interface CatalogBody {
  id: string;
  slug?: string;
  name: string;
  kind: Kind;
  parent: string | null;
  rank?: number;
  radius_km: number;
  radii_km?: [number, number, number];
  color?: string;
  texture?: string;
  texture_alt?: string;
  /** orbita misurata sul cielo attorno al corpo padre (stelle S di Sagittarius A*) */
  sky_orbit?: SkyOrbit;
  /** magnitudine assoluta visuale (stelle del catalogo) */
  absmag?: number;
  /** foto del cielo profondo (data/assets/dso), per nebulose, ammassi e galassie */
  photo?: string;
  /** ammasso globulare disegnato stella per stella: raggio di metà luce (parsec) e numero di stelle */
  globular?: { rh_pc: number; stars: number };
  /** ammasso aperto disegnato stella per stella (vedi render/opencluster.ts) */
  open_cluster?: import('../render/opencluster').OpenClusterSpec;
  /**
   * galassie vicine come nuvola 3D sul loro disco inclinato (vedi render/nebulacloud.ts): inclinazione e
   * angolo di posizione della linea dei nodi (gradi), spessore del disco (kpc, una deviazione standard),
   * zone della foto da escludere [ascensione retta, declinazione, raggio] in gradi
   */
  cloud?: { incl_deg: number; nodes_pa_deg: number; thick_kpc: number; mask?: [number, number, number][] };
  night_texture?: string;
  clouds_texture?: string;
  atmosphere?: { color: string; scale: number; strength: number };
  /** atmosfera calcolata con la diffusione della luce (vedi render/atmosphere.ts) */
  scatter?: import('../render/atmosphere').ScatterSpec;
  /** campo magnetico: dipolo inclinato e spostato, magnetopausa (vedi render/fieldmodel.ts) */
  magnetic?: {
    pole_lat: number; pole_lon: number;   // polo "nord" dell'asse, planetocentrico, longitudine est
    moment_north: boolean;                // il momento punta verso quel polo (Giove) o al contrario (Terra)
    offset_r: [number, number, number];   // centro del dipolo, in raggi, sistema solidale
    magnetopause_r: number;               // distanza della magnetopausa dal lato del Sole, in raggi
    lon_known?: boolean;                  // false: longitudine indicativa (Urano, Nettuno)
    /** 'corotation': a schiacciare il campo non è il vento solare ma il plasma che gira con il pianeta (Ganimede) */
    flow?: 'corotation';
    /** 'source_surface': campo di una stella; magnetopause_r è il raggio oltre cui il vento apre le linee (Sole) */
    model?: 'source_surface';
    src: string;
    /** campo all'equatore magnetico sulla superficie, in nanotesla (ai poli è circa il doppio) */
    b_eq_nt?: number;
    /** da dove viene il valore dell'intensità */
    b_src?: string;
  };
  /** corpi senza un campo globale: una frase che spiega che cosa resta (Venere, Marte, Luna) */
  field_note?: string;
  rings?: {
    inner_km: number; outer_km: number; texture?: string; color?: string;
    /** anelli sottili senza una foto: [raggio al centro (km), larghezza (km), opacità nel disegno] */
    bands?: [number, number, number][];
    /** da dove vengono le misure, e quanto il disegno è più visibile del vero */
    src?: string;
  };
  rotation?: RotationModel;
  horizons?: { command: string | string[]; center: string; step: string };
  trail?: { start: string; step?: string; future_days?: number; center?: string };
  elements?: StandishElements;
  mean_orbit?: MeanOrbit;
  phys?: Phys;
  wiki?: string;
  /** lingua della voce "wiki" (il server la indica secondo le traduzioni disponibili) */
  wiki_lang?: string;
  sbdb?: string;
  aliases?: string[];
  interstellar?: boolean;
  /** cometa senza chioma né code (es. 1I/ʻOumuamua) */
  inactive?: boolean;
  fixed?: FixedPosition;
  show?: ShowRange;
  /** esopianeta o stella con esopianeti (NASA Exoplanet Archive): ha il suo livello */
  exo?: boolean;
  /** tipo di superficie indicativa, per i corpi senza mappa */
  surface?: 'roccia' | 'ghiaccio' | 'tholin' | 'gas';
  has_content?: boolean;
  content?: string;
}

export interface EphemChunk {
  id: string;
  chunk: number;
  rows: number[];
  start?: number;
  stop?: number;
  step_days?: number;
  center?: string;
  error?: string;
  transient?: boolean;
  available?: { not_before: number | null; not_after: number | null };
  source?: string;
}

export interface OMM {
  OBJECT_NAME: string;
  OBJECT_ID: string;
  EPOCH: string;
  MEAN_MOTION: number;
  ECCENTRICITY: number;
  INCLINATION: number;
  RA_OF_ASC_NODE: number;
  ARG_OF_PERICENTER: number;
  MEAN_ANOMALY: number;
  NORAD_CAT_ID: number;
  BSTAR: number;
  MEAN_MOTION_DOT: number;
  MEAN_MOTION_DDOT: number;
  EPHEMERIS_TYPE: number;
  CLASSIFICATION_TYPE: string;
  ELEMENT_SET_NO: number;
  REV_AT_EPOCH: number;
  _type?: string | null;
  _owner?: string | null;
}
