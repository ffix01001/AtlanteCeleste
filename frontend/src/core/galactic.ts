/**
 * Sistema di riferimento galattico.
 *
 * Coordinate galattiche IAU (l, b): asse x verso il centro galattico (l = 0),
 * y verso l = 90° (il verso della rotazione della Galassia nei pressi del Sole),
 * z verso il polo nord galattico. La matrice ICRS -> galattico è quella
 * ufficiale di Hipparcos/Gaia (documentazione Gaia DR3, §4.1.7).
 *
 * Il "modello" della Via Lattea usa gli stessi assi ma con l'origine in
 * Sagittarius A*, alla distanza misurata da GRAVITY (2021): 8,275 kpc.
 * In questo sistema il Sole si trova a x ≈ −8,275 kpc e pochi parsec sopra il piano.
 */

import { Matrix3, Vector3 } from 'three';
import { DEG, PC_KM } from './units';
import { M_ICRF_TO_SCENE } from './frames';

/** ICRS -> galattico (righe = assi galattici espressi in ICRS). */
export const M_ICRF_TO_GAL = new Matrix3().set(
  -0.0548755604162154, -0.8734370902348850, -0.4838350155487132,
  0.4941094278755837, -0.4448296299600112, 0.7469822444972189,
  -0.8676661490190047, -0.1980763734312015, 0.4559837761750669,
);
export const M_GAL_TO_ICRF = M_ICRF_TO_GAL.clone().transpose();

/** Distanza Sole – Sagittarius A* (GRAVITY Collaboration 2021). */
export const R0_PC = 8275;
/** Posizione di Sgr A* (Reid & Brunthaler 2004), gradi. */
export const SGRA_RA_DEG = 266.41683708;
export const SGRA_DEC_DEG = -29.00781056;

export function unitFromRaDec(raDeg: number, decDeg: number, out = new Vector3()): Vector3 {
  const ra = raDeg * DEG, dec = decDeg * DEG;
  return out.set(Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec));
}

/** Sgr A* rispetto al Sole, ICRS, parsec. */
export const GC_ICRS_PC = unitFromRaDec(SGRA_RA_DEG, SGRA_DEC_DEG).multiplyScalar(R0_PC);

/** Il Sole nel sistema del modello (origine in Sgr A*, assi galattici), in kpc. */
export const SUN_IN_MODEL_KPC = GC_ICRS_PC.clone().negate().applyMatrix3(M_ICRF_TO_GAL).divideScalar(1000);

/** Modello galattico (kpc) -> scena (km, rispetto al Sole): rotazione + scala, senza traslazione. */
export const M_MODEL_TO_SCENE = M_ICRF_TO_SCENE.clone().multiply(M_GAL_TO_ICRF).multiplyScalar(1000 * PC_KM);

/** Sgr A* rispetto al Sole, in coordinate di scena (km). */
export const GC_SCENE_KM = GC_ICRS_PC.clone().multiplyScalar(PC_KM).applyMatrix3(M_ICRF_TO_SCENE);

/** Punto del modello (kpc) -> ICRS rispetto al Sole (km). */
export function modelToIcrfKm(x: number, y: number, z: number, out = new Vector3()): Vector3 {
  return out.set(x, y, z).multiplyScalar(1000).applyMatrix3(M_GAL_TO_ICRF).add(GC_ICRS_PC).multiplyScalar(PC_KM);
}

/** Longitudine e latitudine galattiche (gradi) di un vettore ICRS. */
export function galacticLB(v: Vector3): { l: number; b: number } {
  const g = v.clone().applyMatrix3(M_ICRF_TO_GAL);
  const r = g.length();
  const l = (Math.atan2(g.y, g.x) / DEG + 360) % 360;
  const b = Math.asin(Math.max(-1, Math.min(1, g.z / r))) / DEG;
  return { l, b };
}

/** perpendicolare al piano della Galassia, nella scena (asse z del modello) */
const GAL_NORMAL_SCENE = new Vector3(...M_MODEL_TO_SCENE.elements.slice(6, 9)).normalize();
const _gc = new Vector3(), _gp = new Vector3();

/**
 * Il segmento dalla camera all'oggetto attraversa il disco della Via Lattea (il piano galattico
 * entro `rKpc` dal centro)? Serve a sapere se una galassia vicina, vista da qui, sta dietro il disco.
 * Posizioni nella scena (km); `sun` è la posizione del Sole.
 */
export function crossesGalacticDisk(cam: Vector3, obj: Vector3, sun: Vector3, rKpc = 15): boolean {
  _gc.copy(sun).add(GC_SCENE_KM);
  const hc = _gp.copy(cam).sub(_gc).dot(GAL_NORMAL_SCENE);
  const ho = _gp.copy(obj).sub(_gc).dot(GAL_NORMAL_SCENE);
  if (hc * ho >= 0) return false;
  // punto in cui il segmento buca il piano, e la sua distanza dal centro
  _gp.copy(obj).sub(cam).multiplyScalar(hc / (hc - ho)).add(cam).sub(_gc);
  return _gp.length() < rKpc * 1000 * PC_KM;
}
