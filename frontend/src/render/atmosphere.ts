/**
 * Atmosfere "vere": diffusione della luce del Sole (Rayleigh e Mie), calcolata per ogni pixel.
 *
 * Lungo il raggio di vista si fanno alcuni passi dentro il guscio dell'atmosfera. A ogni passo
 * si guarda quanta luce del Sole arriva (attenuata dall'aria che attraversa) e quanta ne viene
 * deviata verso la camera. Da questo solo calcolo escono:
 *   - il bordo azzurro della Terra (le molecole deviano di più il blu: Rayleigh);
 *   - la foschia chiara sul lato di giorno e l'alone attorno al Sole (polveri e goccioline: Mie);
 *   - la fascia arancione e rossa lungo il confine giorno/notte (la luce che attraversa tanta
 *     aria perde il blu, come al tramonto);
 *   - il buio della notte (il pianeta fa ombra all'aria stessa).
 * La superficie dietro l'atmosfera viene velata dalla trasparenza calcolata lungo il raggio.
 *
 * Unità: tutto è misurato in raggi del pianeta, così i numeri restano piccoli e precisi in
 * virgola mobile a 32 bit (a 100 milioni di km la camera vede comunque un guscio sottile).
 * Regola degli shader del progetto: niente pow() con basi che possono essere negative.
 */

import { BackSide, Color, CustomBlending, FrontSide, OneFactor, OneMinusSrcAlphaFactor, ShaderMaterial, Vector3 } from 'three';

/** Dati di un'atmosfera, come nel catalogo (`scatter`). Coefficienti per km, altezze in km. */
export interface ScatterSpec {
  top_km: number;                       // spessore del guscio (oltre, l'aria è trascurabile)
  rayleigh_km: [number, number, number];// diffusione delle molecole al suolo, per rosso, verde, blu
  h_r_km: number;                       // altezza di scala delle molecole
  mie_km: number;                       // estinzione di polveri e goccioline al suolo
  mie_albedo?: [number, number, number];// quanta luce le polveri diffondono invece di assorbirla
  h_m_km: number;                       // altezza di scala delle polveri
  g: number;                            // asimmetria: quanto le polveri diffondono "in avanti"
  sun?: number;                         // ritocco della luminosità (1 = fisica)
  /**
   * Rimbalzi multipli, in modo approssimato: luce diffusa in tutte le direzioni in più rispetto
   * al primo rimbalzo. Conta poco per la Terra, molto per la foschia densa di Titano.
   */
  ms?: number;
}

const V = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vRel;
void main() {
  vRel = mat3(modelMatrix) * position;
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;

const F = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 camRel;      // camera rispetto al centro del pianeta (scena)
uniform float planetR;    // raggio del pianeta (scena)
uniform float topR;       // raggio esterno del guscio, in raggi del pianeta
uniform vec3 betaR;       // Rayleigh al suolo, per raggio del pianeta
uniform float hR;         // altezze di scala, in raggi del pianeta
uniform vec3 betaMs;      // Mie: diffusione
uniform vec3 betaMe;      // Mie: estinzione (diffusione + assorbimento)
uniform float hM;
uniform float g;
uniform vec3 sunDir;      // verso il Sole (scena, unitario)
uniform float sunI;
uniform float inside;     // 1 = la camera è dentro l'atmosfera
uniform float ms;         // rimbalzi multipli (diffusione uguale in tutte le direzioni, in più)
varying vec3 vRel;

const int HALF_STEPS = 12;

// intersezioni di un raggio con una sfera centrata nell'origine: (entrata, uscita)
vec2 sphereHit(vec3 o, vec3 d, float r) {
  float b = dot(o, d);
  float c = dot(o, o) - r * r;
  float h = b * b - c;
  if (h < 0.0) return vec2(1e9, -1e9);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}

/*
 * Aria attraversata da un punto verso l'infinito, in unità di altezza di scala (funzione di
 * Chapman, approssimazione di Schüler 2012). X = raggio / H, h = quota / H, coschi = coseno
 * dell'angolo dallo zenit. Sotto l'orizzonte il raggio entra nel pianeta: valore enorme, cioè
 * ombra (l'esponente è limitato per non arrivare all'infinito).
 */
float chapman(float X, float h, float coschi) {
  float c = sqrt(X + h);
  if (coschi >= 0.0) return c / (c * coschi + 1.0) * exp(-h);
  float x0 = sqrt(max(1.0 - coschi * coschi, 0.0)) * (X + h);
  float c0 = sqrt(x0);
  return 2.0 * c0 * exp(min(X - x0, 40.0)) - c / (1.0 - c * coschi) * exp(-h);
}

// aria (Rayleigh, Mie) fra il punto x e il Sole, in raggi del pianeta × densità al suolo
vec2 lightDepth(vec3 x) {
  float r = length(x);
  float coschi = dot(x, sunDir) / r;
  float alt = max(r - 1.0, 0.0);
  return vec2(hR * chapman(1.0 / hR, alt / hR, coschi), hM * chapman(1.0 / hM, alt / hM, coschi));
}

void main() {
  #include <logdepthbuf_fragment>
  vec3 p = vRel / planetR;
  vec3 cam = camRel / planetR;
  vec3 d = normalize(p - cam);
  vec3 o;
  float tMax;
  if (inside > 0.5) {
    // camera dentro la sfera disegnata (che è un po' più grande dell'aria): si parte dalla camera,
    // o dal punto in cui il raggio entra nell'aria se la camera ne è ancora fuori
    vec2 tt = sphereHit(cam, d, topR);
    if (tt.y <= 0.0 || tt.y < tt.x) discard;
    float t0 = max(tt.x, 0.0);
    o = cam + d * t0;
    tMax = tt.y - t0;
  } else {
    // fuori: entrata e uscita dal guscio calcolate vicino al pianeta (numeri piccoli)
    vec2 tt = sphereHit(p, d, topR);
    if (tt.y < tt.x) discard;
    o = p + d * tt.x;
    tMax = tt.y - tt.x;
  }
  if (tMax <= 0.0) discard;
  vec2 tg = sphereHit(o, d, 1.0);
  bool ground = tg.x > 0.0 && tg.x < tMax;
  if (ground) tMax = tg.x;

  // i passi si infittiscono attorno al punto più basso del raggio, dove l'aria è più densa:
  // con passi uguali il bordo (che conta tutto in pochi km di quota) verrebbe saltato
  float tc = clamp(-dot(o, d), 0.0, tMax);
  vec2 odView = vec2(0.0);
  vec3 sumR = vec3(0.0), sumM = vec3(0.0);
  for (int k = 0; k < 2 * HALF_STEPS; k++) {
    float s = (float(k - (k < HALF_STEPS ? 0 : HALF_STEPS)) + 0.5) / float(HALF_STEPS);
    float t, dt;
    if (k < HALF_STEPS) {           // dall'inizio fino al punto più basso
      float q = 1.0 - s;
      t = tc - tc * q * q;
      dt = 2.0 * tc * q / float(HALF_STEPS);
    } else {                        // dal punto più basso all'uscita
      t = tc + (tMax - tc) * s * s;
      dt = 2.0 * (tMax - tc) * s / float(HALF_STEPS);
    }
    vec3 x = o + d * t;
    float h = max(length(x) - 1.0, 0.0);
    vec2 dens = exp(-h / vec2(hR, hM)) * dt;
    odView += dens * 0.5;
    vec2 odL = lightDepth(x);
    vec3 tau = betaR * (odView.x + odL.x) + betaMe * (odView.y + odL.y);
    vec3 att = exp(-min(tau, vec3(60.0)));
    sumR += dens.x * att;
    sumM += dens.y * att;
    odView += dens * 0.5;
  }
  float mu = dot(d, sunDir);
  float pR = 0.0596831 * (1.0 + mu * mu);                       // 3/(16π)(1+μ²)
  float g2 = g * g;
  float denom = max(1.0 + g2 - 2.0 * g * mu, 1e-4);
  float pM = 0.1193662 * (1.0 - g2) * (1.0 + mu * mu) / ((2.0 + g2) * denom * sqrt(denom)); // 3/(8π)…
  float pIso = ms * 0.0795775;                                   // ms / (4π)
  vec3 col = sunI * (sumR * betaR * (pR + pIso) + sumM * betaMs * (pM + pIso));
  vec3 T = exp(-(betaR * odView.x + betaMe * odView.y));
  // dietro c'è il pianeta o lo spazio: in entrambi i casi lo vela la trasparenza media
  float a = 1.0 - dot(T, vec3(0.3333));
  gl_FragColor = vec4(col, a);
}`;

export function scatterMaterial(spec: ScatterSpec, radiusKm: number): ShaderMaterial {
  const R = radiusKm;
  const alb = spec.mie_albedo ?? [0.9, 0.9, 0.9];
  return new ShaderMaterial({
    uniforms: {
      camRel: { value: new Vector3(1e9, 0, 0) },
      planetR: { value: 1 },
      topR: { value: 1 + spec.top_km / R },
      betaR: { value: new Vector3(...spec.rayleigh_km).multiplyScalar(R) },
      hR: { value: spec.h_r_km / R },
      betaMs: { value: new Vector3(spec.mie_km * alb[0], spec.mie_km * alb[1], spec.mie_km * alb[2]).multiplyScalar(R) },
      betaMe: { value: new Vector3(spec.mie_km, spec.mie_km, spec.mie_km).multiplyScalar(R) },
      hM: { value: spec.h_m_km / R },
      g: { value: spec.g },
      sunDir: { value: new Vector3(1, 0, 0) },
      // la superficie è illuminata come col × 1,15: la stessa "irradianza" vale π × 1,15
      sunI: { value: Math.PI * 1.15 * (spec.sun ?? 1) },
      inside: { value: 0 },
      ms: { value: spec.ms ?? 0 },
    },
    vertexShader: V,
    fragmentShader: F,
    transparent: true,
    depthWrite: false,
    // luce diffusa + velo sulla scena dietro: colore premoltiplicato
    blending: CustomBlending,
    blendSrc: OneFactor,
    blendDst: OneMinusSrcAlphaFactor,
    side: FrontSide,
  });
}

/**
 * Aggiorna l'atmosfera per il fotogramma. `center`: centro del pianeta rispetto alla camera
 * (scena, già ridotto se lontano); `radius`: raggio del pianeta nelle stesse unità.
 */
export function updateScatter(mat: ShaderMaterial, center: Vector3, radius: number, sunDir: Vector3): void {
  const u = mat.uniforms;
  (u.camRel.value as Vector3).copy(center).negate();
  u.planetR.value = radius;
  (u.sunDir.value as Vector3).copy(sunDir);
  // dentro la sfera disegnata (raggio dell'aria × 1,02) si usa la faccia interna, sopra tutto il
  // resto (il cielo sta davanti a ciò che si vede da lì); fuori la faccia esterna. Prima il confine
  // era l'aria vera: fra 60 e 190 km dalla Terra l'atmosfera spariva e il suolo diventava cupo
  const inside = center.length() < radius * (u.topR.value as number) * 1.019;
  u.inside.value = inside ? 1 : 0;
  const side = inside ? BackSide : FrontSide;
  if (mat.side !== side) {
    mat.side = side;
    mat.depthTest = !inside;
    mat.needsUpdate = true;
  }
}

/** Passa al materiale della superficie (o delle nubi) i dati per arrossare la luce radente. */
export function applyGroundAir(mat: ShaderMaterial, spec: ScatterSpec, radiusKm: number): void {
  const u = mat.uniforms;
  if (!u.atmoOn) return;
  u.atmoOn.value = 1;
  (u.atmoH.value as { set(x: number, y: number): void }).set(spec.h_r_km / radiusKm, spec.h_m_km / radiusKm);
  (u.atmoBR.value as Vector3).set(...spec.rayleigh_km).multiplyScalar(radiusKm);
  (u.atmoBM.value as Vector3).setScalar(spec.mie_km * radiusKm);
}

/** Colore indicativo dell'atmosfera (per l'alone dei pianeti lontani e le etichette). */
export function scatterTint(spec: ScatterSpec): Color {
  const b = spec.rayleigh_km;
  const m = spec.mie_albedo ?? [1, 1, 1];
  return new Color(b[0] + spec.mie_km * m[0] * 0.3, b[1] + spec.mie_km * m[1] * 0.3, b[2] + spec.mie_km * m[2] * 0.3);
}
