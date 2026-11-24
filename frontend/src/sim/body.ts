/**
 * Un corpo celeste della simulazione.
 *
 * Lo stato (posizione/velocità) è sempre relativo al corpo "padre" nell'albero
 * (Luna -> Terra -> Sole -> baricentro). Le fonti si usano in ordine di qualità:
 *   1. JPL Horizons (interpolato)                          'jpl'
 *   2. l'ultimo stato JPL proseguito con Keplero, mentre
 *      arriva il blocco successivo (niente salti)          'jplprop'
 *   3. teorie analitiche per la Luna e le lune di Giove    'analytic'
 *   4. elementi orbitali SBDB (2 corpi)                    'sbdb'
 *   5. elementi medi di Standish                           'kepler'
 *   6. orbita circolare media (offline)                    'approx'
 *   7. SGP4 per i satelliti terrestri                      'sgp4'
 */

import { t } from '../core/i18n';
import { skyOrbitMu, skyOrbitState } from '../ephem/skyorbit';
import { Matrix3, Vector3 } from 'three';
import type { SatRec } from 'satellite.js';
import { sgp4At } from '../ephem/sgp4at';
import type { CatalogBody, Kind } from '../data/types';
import { ECLIPTIC_POLE_ICRF, eclToIcrf, icrfToScene, precessionDateToJ2000 } from '../core/frames';
import { modelToIcrfKm, unitFromRaDec } from '../core/galactic';
import { earthRotationJd, J2000, jdTdbToUnixMs } from '../core/time';
import { AU_KM, DEG, G_KM3_KG_S2, MU_SUN_AU_DAY, PC_KM } from '../core/units';
import { conicState, propagateUniversal, type Conic } from '../ephem/kepler';
import { AstroTime, GeoMoonState, JupiterMoons } from 'astronomy-engine';
import { JplEphemeris } from '../ephem/jpl';
import { orientation, poleOf } from '../ephem/rotation';
import { standishState } from '../ephem/standish';

export type PosSource = 'jpl' | 'jplprop' | 'analytic' | 'sbdb' | 'kepler' | 'approx' | 'exo' | 'sgp4' | 'catalog' | 'skyorbit' | 'none';

export const SOURCE_LABEL: Record<PosSource, string> = {
  jpl: t('NASA/JPL Horizons (interpolazione di Hermite)'),
  jplprop: t('NASA/JPL Horizons, proseguita col calcolo kepleriano mentre arriva il blocco successivo'),
  analytic: t('Teoria analitica (Astronomy Engine), in attesa dei dati JPL'),
  sbdb: t('Elementi orbitali JPL SBDB (problema dei due corpi)'),
  kepler: t('Modello kepleriano approssimato (Standish)'),
  approx: t('Orbita media approssimata (in attesa dei dati JPL)'),
  exo: t('Orbita circolare con il periodo misurato (NASA Exoplanet Archive); l\'orientamento nello spazio non è noto'),
  sgp4: t('Modello SGP4 con elementi CelesTrak'),
  catalog: t('Posizione fissa (catalogo stellare o di oggetti lontani)'),
  skyorbit: t('Orbita misurata dall\'ESO attorno a Sagittarius A* (Gillessen e collaboratori, 2017)'),
  none: t('Posizione non disponibile'),
};

const _p = new Vector3();
const _v = new Vector3();

/**
 * Per quanti giorni (di tempo simulato) si prosegue l'ultimo stato JPL col problema dei
 * due corpi, mentre il blocco successivo non è ancora arrivato. Oltre, l'errore delle
 * perturbazioni conterebbe più del salto verso il modello approssimato.
 */
const CONTINUE_DAYS: Partial<Record<Kind, number>> = {
  planet: 400, dwarf: 400, asteroid: 400, comet: 120, moon: 30, spacecraft: 12,
};

/** Lune con una teoria analitica precisa (Astronomy Engine): NAIF -> chiave */
const ANALYTIC_MOONS: Record<string, 'moon' | 'io' | 'europa' | 'ganymede' | 'callisto'> = {
  'naif:301': 'moon', 'naif:501': 'io', 'naif:502': 'europa', 'naif:503': 'ganymede', 'naif:504': 'callisto',
};
const AU_PER_DAY_TO_KMS = AU_KM / 86400;
const _node = new Vector3();
const _n2 = new Vector3();

export class Body {
  readonly id: string;
  readonly name: string;
  readonly kind: Kind;
  readonly data: CatalogBody;
  parent: Body | null = null;
  children: Body[] = [];
  readonly rank: number;
  readonly radius: number;
  readonly radii: [number, number, number];
  readonly gm: number;

  relPos = new Vector3();
  relVel = new Vector3();
  pos = new Vector3();
  vel = new Vector3();
  scenePos = new Vector3();
  orient = new Matrix3();

  source: PosSource = 'none';
  valid = false;
  dynamic = false;

  jpl: JplEphemeris | null = null;
  /** ultimo stato ricevuto da JPL (relativo al padre), per proseguirlo senza salti */
  private lastJpl: { jd: number; pos: Vector3; vel: Vector3 } | null = null;
  conic: Conic | null = null;
  satrec: SatRec | null = null;
  /** extra: dati specifici (es. elementi OMM per i satelliti) */
  extra: Record<string, any> = {};

  constructor(data: CatalogBody) {
    this.data = data;
    this.id = data.id;
    this.name = data.name;
    this.kind = data.kind;
    this.rank = data.rank ?? 3;
    this.radius = data.radius_km ?? 0;
    this.radii = data.radii_km ?? [this.radius, this.radius, this.radius];
    const ph = data.phys ?? {};
    this.gm = ph.gm_km3s2 ?? (ph.mass_kg ? ph.mass_kg * G_KM3_KG_S2 : 0);
    // oggetti lontani: posizione fissa rispetto al Sole (ICRS, km)
    const f = data.fixed;
    if (f) {
      if (f.model_kpc) this.extra.fixed = modelToIcrfKm(f.model_kpc[0], f.model_kpc[1], f.model_kpc[2]);
      else if (f.ra_deg !== undefined && f.dec_deg !== undefined && f.dist_pc)
        this.extra.fixed = unitFromRaDec(f.ra_deg, f.dec_deg).multiplyScalar(f.dist_pc * PC_KM);
    }
  }

  get isRoot(): boolean {
    return this.parent === null;
  }

  /** Calcola lo stato relativo al padre. Restituisce false se non disponibile. */
  computeRel(jd: number, priority: number): boolean {
    // corpi che a un certo istante smettono di esistere (comete disintegrate, ...)
    if (this.extra.endJd !== undefined && jd > this.extra.endJd) {
      this.source = 'none';
      return false;
    }
    if (this.extra.fixed) {
      this.relPos.copy(this.extra.fixed);
      this.relVel.set(0, 0, 0);
      this.source = 'catalog';
      return true;
    }
    if (this.jpl && this.jpl.sample(jd, this.relPos, this.relVel, priority)) {
      this.source = 'jpl';
      const l = (this.lastJpl ??= { jd: 0, pos: new Vector3(), vel: new Vector3() });
      l.jd = jd;
      l.pos.copy(this.relPos);
      l.vel.copy(this.relVel);
      return true;
    }
    if (this.continueJpl(jd)) return true;
    const am = ANALYTIC_MOONS[this.id];
    if (am && this.analyticMoon(am, jd)) {
      this.source = 'analytic';
      return true;
    }
    if (this.conic && this.parent?.id === 'naif:10') {
      conicState(this.conic, jd, MU_SUN_AU_DAY, _p, _v);
      eclToIcrf(_p.x, _p.y, _p.z, this.relPos).multiplyScalar(AU_KM);
      eclToIcrf(_v.x, _v.y, _v.z, this.relVel).multiplyScalar(AU_KM / 86400);
      this.source = 'sbdb';
      return true;
    }
    if (this.data.elements) {
      standishState(this.data.elements, jd, this.relPos, this.relVel);
      this.source = 'kepler';
      return true;
    }
    if (this.data.sky_orbit && this.parent?.data.fixed?.ra_deg !== undefined) {
      // stelle S attorno a Sagittarius A*: orbita misurata sul cielo
      const f = this.parent.data.fixed;
      skyOrbitState(this.data.sky_orbit, jd, f.ra_deg!, f.dec_deg!, this.relPos, this.relVel);
      this.source = 'skyorbit';
      return true;
    }
    if (this.data.mean_orbit && this.parent) {
      this.meanOrbit(jd);
      this.source = this.data.exo ? 'exo' : 'approx';
      return true;
    }
    if (this.satrec) {
      return this.sgp4(jd);
    }
    if (this.parent?.isRoot && this.kind === 'star') {
      // il Sole si discosta dal baricentro al massimo di ~2 raggi solari: in attesa di JPL va bene zero
      this.relPos.set(0, 0, 0);
      this.relVel.set(0, 0, 0);
      this.source = 'approx';
      return true;
    }
    this.source = 'none';
    return false;
  }

  /**
   * Mentre il blocco JPL successivo non è ancora arrivato (tempo che scorre veloce, rete
   * lenta) si prosegue l'ultimo stato JPL con il problema dei due corpi: niente salti
   * sull'orbita approssimata e ritorno, che facevano "lampeggiare" corpi e orbite.
   */
  private continueJpl(jd: number): boolean {
    const l = this.lastJpl;
    if (!l) return false;
    const gap = Math.abs(jd - l.jd);
    const limit = CONTINUE_DAYS[this.kind] ?? 30;
    // per la Luna e le lune di Giove, oltre un giorno è più precisa la teoria analitica
    if (gap > limit || (ANALYTIC_MOONS[this.id] && gap > 1)) return false;
    const mu = this.muAroundParent;
    if (!(mu > 0)) return false;
    if (!propagateUniversal(l.pos, l.vel, mu, (jd - l.jd) * 86400, this.relPos, this.relVel)) return false;
    this.source = 'jplprop';
    return true;
  }

  private analyticMoon(key: 'moon' | 'io' | 'europa' | 'ganymede' | 'callisto', jd: number): boolean {
    try {
      const t = AstroTime.FromTerrestrialTime(jd - J2000);
      const st = key === 'moon' ? GeoMoonState(t) : JupiterMoons(t)[key];
      // equatoriale J2000 (EQJ) = ICRF entro 0,02": UA e UA/giorno
      this.relPos.set(st.x, st.y, st.z).multiplyScalar(AU_KM);
      this.relVel.set(st.vx, st.vy, st.vz).multiplyScalar(AU_PER_DAY_TO_KMS);
      return Number.isFinite(this.relPos.x);
    } catch {
      return false;
    }
  }

  private meanOrbit(jd: number): void {
    const mo = this.data.mean_orbit!;
    const pole = mo.plane === 'ecliptic' || !this.parent ? ECLIPTIC_POLE_ICRF : poleOf(this.parent.orient, _n2);
    // nodo arbitrario sull'equatore del pianeta; inclinazione rispetto a quel piano
    _node.set(0, 0, 1).cross(pole);
    if (_node.lengthSq() < 1e-12) _node.set(1, 0, 0);
    _node.normalize();
    const inPlane = new Vector3().crossVectors(pole, _node).normalize();
    const inc = (mo.i_deg ?? 0) * DEG;
    const y = inPlane.multiplyScalar(Math.cos(inc)).addScaledVector(pole, Math.sin(inc));
    const P = mo.period_d;
    const th = (2 * Math.PI * (jd - J2000)) / P;
    const c = Math.cos(th), s = Math.sin(th);
    this.relPos.copy(_node).multiplyScalar(mo.a_km * c).addScaledVector(y, mo.a_km * s);
    const vmag = (2 * Math.PI * mo.a_km) / (P * 86400);
    this.relVel.copy(_node).multiplyScalar(-vmag * s).addScaledVector(y, vmag * c);
  }

  private sgp4(jd: number): boolean {
    const pv = sgp4At(this.satrec!, jdTdbToUnixMs(jd));
    if (!pv || typeof pv.position !== 'object' || typeof pv.velocity !== 'object') {
      this.source = 'none';
      return false;
    }
    const T = (jd - J2000) / 36525;
    const m = precessionDateToJ2000(T);
    this.relPos.set(pv.position.x, pv.position.y, pv.position.z).applyMatrix3(m);
    this.relVel.set(pv.velocity.x, pv.velocity.y, pv.velocity.z).applyMatrix3(m);
    this.source = 'sgp4';
    return true;
  }

  /** Aggiorna posizione assoluta e orientamento (il padre deve essere già aggiornato). */
  finalize(jd: number): void {
    if (this.parent) {
      this.pos.copy(this.parent.pos).add(this.relPos);
      this.vel.copy(this.parent.vel).add(this.relVel);
    }
    icrfToScene(this.pos, this.scenePos);
    orientation(this.data.rotation, this.id === 'naif:399' ? earthRotationJd(jd) : jd, this.relPos, this.relVel, this.orient);
  }

  /** GM del sistema padre+corpo, per calcolare l'orbita osculatrice. */
  get muAroundParent(): number {
    if (this.data.sky_orbit) return skyOrbitMu(this.data.sky_orbit);
    return (this.parent?.gm ?? 0) + (this.kind === 'moon' || this.kind === 'dwarf' ? this.gm : 0);
  }
}
