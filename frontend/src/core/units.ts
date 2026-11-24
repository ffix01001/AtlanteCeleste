/** Costanti fisiche e astronomiche (unità di base: km, s, kg). */

export const AU_KM = 149597870.7;
export const LY_KM = 9460730472580.8;
export const PC_KM = 3.0856775814913673e13;
export const C_KMS = 299792.458;
export const DEG = Math.PI / 180;
export const ARCSEC = DEG / 3600;
export const G_KM3_KG_S2 = 6.6743e-20; // costante di gravitazione in km^3 kg^-1 s^-2
export const GM_SUN = 132712440041.94; // km^3/s^2
export const K_GAUSS = 0.01720209895; // costante gaussiana: GM_sole = k^2 in UA^3/giorno^2
export const MU_SUN_AU_DAY = K_GAUSS * K_GAUSS;
export const EARTH_RADIUS_KM = 6371.0;
export const LUNAR_DISTANCE_KM = 384400;
