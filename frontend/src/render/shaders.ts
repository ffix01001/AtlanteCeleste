/**
 * Shader GLSL dei corpi celesti.
 * Tutti includono il "logarithmic depth buffer": senza, a scale così diverse
 * (metri per una sonda, miliardi di km per Nettuno) la profondità si
 * confonderebbe.
 */

import {
  AddEquation, AdditiveBlending, Color, CustomBlending, DoubleSide, FrontSide, OneFactor, OneMinusSrcAlphaFactor,
  ShaderChunk, ShaderMaterial, Texture, Vector2, Vector3, Vector4,
} from 'three';

/*
 * Piano lontano "sicuro". Con near = 1 mm e far = 1e21 km la matrice di proiezione, in
 * float32, mette ogni punto oltre qualche decina di km esattamente sul piano lontano
 * (z = w): basta un arrotondamento della scheda video perché un vertice risulti appena
 * "oltre" e venga tagliato, e linee o triangoli lontani lampeggiano. Con il depth buffer
 * logaritmico la profondità vera la scrive il fragment shader, quindi z si può riportare
 * un soffio dentro il volume visibile senza cambiare nient'altro (il taglio dietro la
 * camera resta: per i punti dietro w è negativo).
 */
if (!ShaderChunk.logdepthbuf_vertex.includes('ATLANTE_FAR_SAFE')) {
  ShaderChunk.logdepthbuf_vertex = /* glsl */ `
#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
	vFragDepth = 1.0 + gl_Position.w;
	vIsPerspective = float( isPerspectiveMatrix( projectionMatrix ) );
	// ATLANTE_FAR_SAFE
	gl_Position.z = min( gl_Position.z, gl_Position.w * 0.99999 );
#endif
`;
}

const HEAD_V = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
`;
const HEAD_F = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
`;

// ------------------------------------------------------------------ pianeti
const PLANET_V = /* glsl */ `
${HEAD_V}
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vViewW;
varying vec3 vRel;      // posizione rispetto al centro del corpo (unità della scena)
varying vec3 vObj;      // posizione nel sistema del corpo (gira con lui): per il dettaglio procedurale
void main() {
  vUv = uv;
  vObj = position;
  mat3 m = mat3(modelMatrix);
  vNormalW = normalize(transpose(inverse(m)) * normal);
  vRel = m * position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vViewW = normalize(cameraPosition - wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}`;

/**
 * Ombre ed eclissi. Per ogni punto della superficie si guarda il disco del Sole e si
 * calcola quanta parte ne coprono i corpi vicini (fino a 4): da qui escono da sole
 * l'ombra e la penombra, le eclissi totali e anulari, le ombre delle lune su Giove.
 * La Terra, con la sua atmosfera, lascia passare nell'ombra un po' di luce rossa:
 * è il colore rame della Luna durante un'eclissi totale.
 * Gli anelli (Saturno) proiettano la loro ombra a bande sul pianeta.
 */
const SHADOW_GLSL = /* glsl */ `
uniform vec3 sunRel;          // il Sole rispetto al centro del corpo
uniform float sunRadius;
uniform int occCount;
uniform vec3 occRel[4];       // corpi che possono fare ombra, rispetto al centro del corpo
uniform float occRadius[4];
uniform float occAtmo[4];     // 1 = atmosfera che arrossa la luce nell'ombra (la Terra)
uniform float hasRing;
uniform vec3 ringNormalW;
uniform float ringInner;
uniform float ringOuter;
uniform sampler2D ringMap;
uniform float hasRingMap;
varying vec3 vRel;

float angleBetween(vec3 a, vec3 b) {
  // preciso anche per angoli piccolissimi (il Sole visto da Giove è largo 0,1°)
  return atan(length(cross(a, b)), dot(a, b));
}

/** frazione del disco 1 (raggio angolare r1) coperta dal disco 2 (r2), centri distanti d */
float discCover(float r1, float r2, float d) {
  if (d >= r1 + r2) return 0.0;
  if (d <= abs(r1 - r2)) return r2 >= r1 ? 1.0 : (r2 * r2) / (r1 * r1);
  float r1s = r1 * r1, r2s = r2 * r2;
  float a = r1s * acos(clamp((d * d + r1s - r2s) / (2.0 * d * r1), -1.0, 1.0));
  float b = r2s * acos(clamp((d * d + r2s - r1s) / (2.0 * d * r2), -1.0, 1.0));
  float c = 0.5 * sqrt(max((-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2), 0.0));
  return clamp((a + b - c) / (PI * r1s), 0.0, 1.0);
}

float ringAlpha(float x) {
  if (hasRingMap > 0.5) return texture2D(ringMap, vec2(x, 0.5)).a;
  return 0.55 * (0.75 + 0.25 * sin(x * 23.0) * sin(x * 7.0)) * smoothstep(0.0, 0.05, x) * (1.0 - smoothstep(0.62, 0.66, x) * 0.7);
}

vec3 sunLight(vec3 p) {
  vec3 toSun = sunRel - p;
  float ds = length(toSun);
  float as = asin(min(sunRadius / ds, 1.0));
  vec3 light = vec3(1.0);
  for (int i = 0; i < 4; i++) {
    if (i >= occCount) break;
    vec3 toOcc = occRel[i] - p;
    float dO = length(toOcc);
    if (dO >= ds || dot(toOcc, toSun) <= 0.0) continue;
    float ao = asin(min(occRadius[i] / dO, 1.0));
    float cover = discCover(as, ao, angleBetween(toOcc, toSun));
    // nell'ombra della Terra resta una luce rossa, rifratta dall'atmosfera
    light *= vec3(1.0 - cover) + occAtmo[i] * cover * vec3(0.11, 0.035, 0.012);
  }
  if (hasRing > 0.5) {
    vec3 dir = toSun / ds;
    float den = dot(dir, ringNormalW);
    if (abs(den) > 1e-5) {
      float t = -dot(p, ringNormalW) / den;
      if (t > 0.0) {
        float r = length(p + dir * t);
        float x = (r - ringInner) / (ringOuter - ringInner);
        if (x > 0.0 && x < 1.0) light *= 1.0 - 0.85 * ringAlpha(x);
      }
    }
  }
  return light;
}
`;

const PLANET_F = /* glsl */ `
${HEAD_F}
uniform sampler2D map;
uniform float hasMap;
uniform vec3 mapTint;     // moltiplica la mappa: guadagno per i corpi scuri, colore per le mappe in bianco e nero
uniform vec3 color;
uniform sampler2D nightMap;
uniform float hasNight;
uniform vec3 sunDir;
uniform float ambient;
uniform float wrap;       // morbidezza del terminatore (atmosfere spesse)
uniform float cloudMode;  // 1 = strato di nubi (alpha dalla luminanza)
uniform vec3 rimColor;
uniform float rimStrength;
// atmosfera calcolata: la luce del Sole che arriva al suolo attraversa l'aria e, vicino al
// confine giorno/notte, perde il blu (il suolo e le nubi al tramonto si colorano di arancione)
uniform float atmoOn;
uniform vec2 atmoH;       // altezze di scala (Rayleigh, Mie) in raggi del pianeta
uniform vec3 atmoBR;      // Rayleigh al suolo, per raggio
uniform vec3 atmoBM;      // Mie (estinzione) al suolo, per raggio
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vViewW;
${SHADOW_GLSL}
// funzione di Chapman (approssimazione di Schüler): aria attraversata verso il Sole
float chapmanG(float X, float coschi) {
  float c = sqrt(X);
  if (coschi >= 0.0) return c / (c * coschi + 1.0);
  float x0 = sqrt(max(1.0 - coschi * coschi, 0.0)) * X;
  return 2.0 * sqrt(x0) * exp(min(X - x0, 40.0)) - c / (1.0 - c * coschi);
}
// ---- dettaglio procedurale: quando la foto è ingrandita oltre la sua risoluzione, piccole
// variazioni generate dal programma evitano la macchia sfocata (rumore di valore a 5 ottave)
varying vec3 vObj;
float hash3(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.11, 0.17, 0.13));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x), mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x), mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float detailFbm(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; }
  return s / 0.96875;
}
// quanto la foto è ingrandita: 0 = un texel per pixel o meno, 1 = molto ingrandita
float magnified(float texW) {
  float texelPerPx = length(fwidth(vObj)) * texW / 6.2831853;
  return 1.0 - smoothstep(0.2, 0.9, texelPerPx);
}
vec3 sunThroughAir(float ndl) {
  if (atmoOn < 0.5) return vec3(1.0);
  vec3 tau = atmoBR * atmoH.x * chapmanG(1.0 / atmoH.x, ndl) + atmoBM * atmoH.y * chapmanG(1.0 / atmoH.y, ndl);
  return exp(-min(tau, vec3(60.0)));
}
void main() {
  #include <logdepthbuf_fragment>
  vec3 n = normalize(vNormalW);
  vec4 tex = hasMap > 0.5 ? texture2D(map, vUv) * vec4(mapTint, 1.0) : vec4(color, 1.0);
  if (hasMap > 0.5) {
    float texW = float(textureSize(map, 0).x);
    float w = magnified(texW);
    if (w > 0.0) {
      // il rumore parte dalla grandezza di un texel e scende di quattro ottave
      float dn = detailFbm(normalize(vObj) * (texW / 6.2831853));
      if (cloudMode > 0.5) tex.r *= mix(1.0, 0.55 + 0.9 * dn, w);
      else tex.rgb *= mix(1.0, 0.62 + 0.76 * dn, w);
    }
  }
  float ndl = dot(n, sunDir);
  float diff = clamp((ndl + wrap) / (1.0 + wrap), 0.0, 1.0);
  vec3 light = diff > 0.0 ? sunLight(vRel) * sunThroughAir(ndl) : vec3(1.0);
  vec3 col = tex.rgb * (diff * 1.15 * light + ambient);
  if (hasNight > 0.5) {
    vec3 night = texture2D(nightMap, vUv).rgb;
    float dark = smoothstep(0.08, -0.18, ndl);
    col += night * night * dark * 2.2;
  }
  // clamp: per arrotondamento il prodotto scalare può superare 1 di un soffio, e pow() di una
  // base negativa dà NaN (sul Mac il bloom lo allarga in un grande quadrato nero)
  float rimB = 1.0 - clamp(dot(n, normalize(vViewW)), 0.0, 1.0);
  float rim = rimB * rimB * rimB;
  col += rimColor * rim * rimStrength * smoothstep(-0.25, 0.4, ndl) * light;
  if (cloudMode > 0.5) {
    float a = tex.r;
    gl_FragColor = vec4((diff * 1.1 * light + ambient * 0.5), a * 0.9);
  } else {
    gl_FragColor = vec4(col, 1.0);
  }
}`;

export function planetMaterial(opts: { color: Color; ambient?: number; wrap?: number; clouds?: boolean; rim?: Color; rimStrength?: number }): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      map: { value: null as Texture | null },
      hasMap: { value: 0 },
      mapTint: { value: new Vector3(1, 1, 1) },
      color: { value: opts.color },
      nightMap: { value: null as Texture | null },
      hasNight: { value: 0 },
      sunDir: { value: new Vector3(1, 0, 0) },
      ambient: { value: opts.ambient ?? 0.025 },
      wrap: { value: opts.wrap ?? 0 },
      cloudMode: { value: opts.clouds ? 1 : 0 },
      rimColor: { value: opts.rim ?? new Color(0, 0, 0) },
      rimStrength: { value: opts.rimStrength ?? 0 },
      atmoOn: { value: 0 },
      atmoH: { value: new Vector2(1, 1) },
      atmoBR: { value: new Vector3() },
      atmoBM: { value: new Vector3() },
      // ombre ed eclissi (aggiornate a ogni fotogramma da BodyVisual)
      sunRel: { value: new Vector3(1e9, 0, 0) },
      sunRadius: { value: 1 },
      occCount: { value: 0 },
      occRel: { value: [new Vector3(), new Vector3(), new Vector3(), new Vector3()] },
      occRadius: { value: [0, 0, 0, 0] },
      occAtmo: { value: [0, 0, 0, 0] },
      hasRing: { value: 0 },
      ringNormalW: { value: new Vector3(0, 1, 0) },
      ringInner: { value: 1 },
      ringOuter: { value: 2 },
      ringMap: { value: null as Texture | null },
      hasRingMap: { value: 0 },
    },
    vertexShader: PLANET_V,
    fragmentShader: PLANET_F,
    transparent: !!opts.clouds,
    depthWrite: !opts.clouds,
  });
}

// ------------------------------------------------------------------ Sole
const SUN_F = /* glsl */ `
${HEAD_F}
uniform sampler2D map;
uniform float hasMap;
uniform vec3 color;
uniform vec3 hue;        // colore della luce della stella
uniform float recolor;   // 1 = la mappa (del Sole) dà solo la granulazione, il colore è quello della stella
uniform float intensity;
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vViewW;
void main() {
  #include <logdepthbuf_fragment>
  vec3 base = hasMap > 0.5 ? texture2D(map, vUv).rgb : color;
  if (recolor > 0.5) base = hue * (0.3 + 1.25 * dot(base, vec3(0.2126, 0.7152, 0.0722)));
  float mu = clamp(dot(normalize(vNormalW), normalize(vViewW)), 0.0, 1.0);
  float limb = 0.35 + 0.65 * pow(mu, 0.45);       // oscuramento al bordo
  vec3 col = mix(hue, base * 1.6, 0.55) * limb * intensity;
  gl_FragColor = vec4(col, 1.0);
}`;

/** Superficie di una stella. `hue`: colore della sua luce (per il Sole un bianco caldo). */
export function sunMaterial(color: Color, hue?: Color): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      map: { value: null }, hasMap: { value: 0 }, color: { value: color }, intensity: { value: 2.4 },
      hue: { value: hue ?? new Color(1.0, 0.86, 0.62) }, recolor: { value: hue ? 1 : 0 },
    },
    vertexShader: PLANET_V,
    fragmentShader: SUN_F,
  });
}

// ------------------------------------------------------------------ alone (billboard)
const BILLBOARD_V = /* glsl */ `
${HEAD_V}
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;

const GLOW_F = /* glsl */ `
${HEAD_F}
uniform vec3 color;
uniform float intensity;
uniform float core;   // frazione del raggio occupata dal disco
varying vec2 vUv;
void main() {
  #include <logdepthbuf_fragment>
  float r = length(vUv - 0.5) * 2.0;
  if (r > 1.0) discard;
  float g = exp(-pow(max(r - core, 0.0) / (1.0 - core), 0.7) * 5.5);
  float rays = 0.0;
  gl_FragColor = vec4(color * (g + rays) * intensity, 1.0);
}`;

export function glowMaterial(color: Color, intensity = 1.0): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { color: { value: color }, intensity: { value: intensity }, core: { value: 0.0 } },
    vertexShader: BILLBOARD_V,
    fragmentShader: GLOW_F,
    blending: AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
}

// ------------------------------------------------------------------ atmosfera
const ATMO_V = PLANET_V;
const ATMO_F = /* glsl */ `
${HEAD_F}
uniform vec3 color;
uniform vec3 sunDir;
uniform float strength;
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vViewW;
void main() {
  #include <logdepthbuf_fragment>
  vec3 n = normalize(vNormalW);
  float v = clamp(dot(n, normalize(vViewW)), 0.0, 1.0);
  float rim = pow(max(1.0 - v, 0.0), 2.6) * smoothstep(0.0, 0.25, v);
  float lit = smoothstep(-0.35, 0.35, dot(n, sunDir));
  gl_FragColor = vec4(color * rim * lit * strength * 1.6, 1.0);
}`;

export function atmosphereMaterial(color: Color, strength: number): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { color: { value: color }, sunDir: { value: new Vector3(1, 0, 0) }, strength: { value: strength } },
    vertexShader: ATMO_V,
    fragmentShader: ATMO_F,
    blending: AdditiveBlending,
    transparent: true,
    depthWrite: false,
    side: FrontSide,
  });
}

// ------------------------------------------------------------------ anelli
const RING_V = /* glsl */ `
${HEAD_V}
uniform float inner;
uniform float outer;
varying float vR;
varying vec3 vWorld;
void main() {
  vR = (length(position.xy) - inner) / (outer - inner);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}`;

const RING_F = /* glsl */ `
${HEAD_F}
uniform sampler2D map;
uniform float hasMap;
uniform vec3 color;
uniform vec3 sunDir;
uniform vec3 planetCenter;
uniform float planetRadius;
uniform vec3 ringNormal;
varying float vR;
varying vec3 vWorld;
void main() {
  #include <logdepthbuf_fragment>
  if (vR < 0.0 || vR > 1.0) discard;
  vec4 tex = hasMap > 0.5 ? texture2D(map, vec2(vR, 0.5)) : vec4(color, 0.55 * (0.75 + 0.25 * sin(vR * 23.0) * sin(vR * 7.0)) * smoothstep(0.0, 0.05, vR) * (1.0 - smoothstep(0.62, 0.66, vR) * 0.7));
  // ombra del pianeta sugli anelli: il raggio verso il Sole interseca la sfera?
  vec3 oc = vWorld - planetCenter;
  float b = dot(oc, sunDir);
  float c = dot(oc, oc) - planetRadius * planetRadius;
  float shadow = (b < 0.0 && b * b - c > 0.0) ? 0.08 : 1.0;
  float lit = 0.35 + 0.65 * abs(dot(ringNormal, sunDir));
  gl_FragColor = vec4(tex.rgb * lit * shadow * 1.1, tex.a);
}`;

export function ringMaterial(inner: number, outer: number, color: Color): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      map: { value: null }, hasMap: { value: 0 }, color: { value: color },
      inner: { value: inner }, outer: { value: outer },
      sunDir: { value: new Vector3(1, 0, 0) }, planetCenter: { value: new Vector3() },
      planetRadius: { value: 1 }, ringNormal: { value: new Vector3(0, 1, 0) },
    },
    vertexShader: RING_V,
    fragmentShader: RING_F,
    transparent: true,
    side: DoubleSide,
    depthWrite: false,
  });
}

// ------------------------------------------------------------------ linee delle orbite
const LINE_V = /* glsl */ `
${HEAD_V}
attribute float alpha;
varying float vA;
void main() {
  vA = alpha;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;

const LINE_F = /* glsl */ `
${HEAD_F}
uniform vec3 color;
uniform float opacity;
varying float vA;
void main() {
  #include <logdepthbuf_fragment>
  gl_FragColor = vec4(color, opacity * (0.12 + 0.88 * vA * vA));
}`;

export function lineMaterial(color: Color, opacity: number): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { color: { value: color }, opacity: { value: opacity } },
    vertexShader: LINE_V,
    fragmentShader: LINE_F,
    transparent: true,
    depthWrite: false,
  });
}

// ------------------------------------------------------------------ oggetti lontani
const NOISE = /* glsl */ `
float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1, 0)), u.x), mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int k = 0; k < 5; k++) { v += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return v;
}`;

const NEBULA_F = /* glsl */ `
${HEAD_F}
uniform vec3 color;
uniform float intensity;
uniform float seed;
varying vec2 vUv;
${NOISE}
void main() {
  #include <logdepthbuf_fragment>
  vec2 p = (vUv - 0.5) * 2.0;
  float r = length(p);
  if (r > 1.0) discard;
  float n = fbm(p * 2.2 + seed);
  float fil = fbm(p * 5.0 - seed * 1.7);
  // (sfuma a zero prima del bordo del quadrato: niente cerchio netto attorno alle nebulose luminose)
  float body = exp(-r * r * 3.0) * (0.45 + 0.9 * n) * (1.0 - smoothstep(0.55, 1.0, r));
  float dark = smoothstep(0.55, 0.75, fil) * 0.6;          // filamenti di polvere
  vec3 col = mix(color, vec3(1.0, 0.95, 0.9), exp(-r * r * 30.0) * 0.35); // nucleo più chiaro
  gl_FragColor = vec4(col * body * (1.0 - dark) * intensity, 1.0);
}`;

/** Nebulosa o galassia irregolare vista come una nube luminosa (billboard). */
export function nebulaMaterial(color: Color, seed: number): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { color: { value: color }, intensity: { value: 1 }, seed: { value: seed } },
    vertexShader: BILLBOARD_V,
    fragmentShader: NEBULA_F,
    blending: AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
}

const PHOTO_F = /* glsl */ `
${HEAD_F}
uniform sampler2D map;
uniform sampler2D matte;
uniform float intensity;
varying vec2 vUv;
void main() {
  #include <logdepthbuf_fragment>
  vec3 c = texture2D(map, vUv).rgb;
  // bordi sfumati in modo irregolare, seguendo l'oggetto (photomatte.ts): nello spazio non si
  // deve vedere il riquadro della foto
  float edge = texture2D(matte, vUv).r;
  gl_FragColor = vec4(c * edge * intensity, 1.0);
}`;

/** Fotografia di una nebulosa, di un ammasso o di una galassia, sommata alla luce del cielo. */
export function photoMaterial(map: Texture, matte: Texture): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { map: { value: map }, matte: { value: matte }, intensity: { value: 0 } },
    vertexShader: BILLBOARD_V,
    fragmentShader: PHOTO_F,
    blending: AdditiveBlending,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
  });
}

// la foto "come dalla Terra" proiettata sul piano vero del disco: resta valida anche girandoci attorno
const DISK_PHOTO_F = /* glsl */ `
${HEAD_F}
uniform sampler2D map;
uniform sampler2D matte;
uniform float intensity;
uniform vec4 uvA;         // da coordinate del disco (raggio 1 = bordo) a coordinate della foto
uniform vec2 uvC;
varying vec2 vUv;
void main() {
  #include <logdepthbuf_fragment>
  vec2 p = (vUv - 0.5) * 2.0;
  float r = length(p);
  if (r > 1.0) discard;
  vec2 uv = uvC + vec2(dot(uvA.xy, p), dot(uvA.zw, p));
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
  float edge = texture2D(matte, uv).r * (1.0 - smoothstep(0.8, 1.0, r));
  gl_FragColor = vec4(texture2D(map, uv).rgb * edge * intensity, 1.0);
}`;

export function diskPhotoMaterial(map: Texture, matte: Texture, uvA: [number, number, number, number], uvC: [number, number]): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { map: { value: map }, matte: { value: matte }, intensity: { value: 0 }, uvA: { value: new Vector4(...uvA) }, uvC: { value: new Vector2(...uvC) } },
    vertexShader: BILLBOARD_V,
    fragmentShader: DISK_PHOTO_F,
    blending: AdditiveBlending,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
  });
}

const DISK_GALAXY_F = /* glsl */ `
${HEAD_F}
uniform vec3 color;
uniform float intensity;
uniform float face;       // luminosità del disco piatto: cresce quando lo si vede inclinato, sparisce di taglio
varying vec2 vUv;
${NOISE}
void main() {
  #include <logdepthbuf_fragment>
  vec2 p = (vUv - 0.5) * 2.0;           // piano del disco, raggio 1 = bordo
  float r = length(p);
  if (r > 1.0) discard;
  float th = atan(p.y, p.x);
  // due bracci a spirale logaritmica (passo ~15°), con polveri
  float arm = 0.5 + 0.5 * cos(2.0 * (th - log(max(r, 0.02)) / 0.27));
  float disk = exp(-r / 0.22);
  float bulge = exp(-r * r / 0.006);
  float n = fbm(p * 9.0);
  float lanes = smoothstep(0.62, 0.9, arm) * smoothstep(0.08, 0.3, r) * 0.55;
  vec3 young = vec3(0.75, 0.82, 1.0), old = vec3(1.0, 0.86, 0.66);
  vec3 col = mix(young, old, smoothstep(0.35, 0.05, r));
  // (il nucleo, sferico, lo disegna galaxyCoreMaterial: si vede uguale da ogni direzione)
  float light = disk * (0.55 + 0.45 * arm * (0.6 + 0.6 * n)) * (1.0 - lanes) * (1.0 - smoothstep(0.8, 1.0, r));
  gl_FragColor = vec4(col * color * light * intensity * face, 1.0);
}`;

/** Galassia a spirale (es. Andromeda) come disco orientato nello spazio. */
export function diskGalaxyMaterial(color: Color): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { color: { value: color }, intensity: { value: 1 }, face: { value: 1 } },
    vertexShader: BILLBOARD_V,
    fragmentShader: DISK_GALAXY_F,
    blending: AdditiveBlending,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
  });
}

/*
 * Il resto di una galassia a disco, disegnato sempre rivolto alla camera:
 * - il nucleo (bulge), che è quasi sferico e si vede uguale da ogni direzione;
 * - il disco visto di taglio: un disco piatto, di profilo, diventerebbe una linea senza
 *   spessore e la galassia sparirebbe. Qui, quando l'inclinazione si avvicina al taglio, il
 *   disco piatto sfuma e al suo posto c'è una striscia sottile lungo l'asse maggiore apparente,
 *   con la stessa luce totale (le stelle non diminuiscono girandoci intorno) e la sua banda
 *   di polveri al centro, come nelle galassie viste di taglio.
 */
const GALAXY_CORE_F = /* glsl */ `
${HEAD_F}
uniform vec3 color;
uniform float intensity;
uniform vec2 axis;        // direzione dell'asse maggiore apparente (nel piano del quadrato)
uniform float cosI;       // |coseno| dell'inclinazione: 1 = di faccia, 0 = di taglio
uniform float edge;       // peso del disco di taglio (0..1)
varying vec2 vUv;
void main() {
  #include <logdepthbuf_fragment>
  vec2 p = (vUv - 0.5) * 2.0;           // raggio 1 = bordo del disco
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  vec3 young = vec3(0.75, 0.82, 1.0), old = vec3(1.0, 0.86, 0.66);
  float bulge = exp(-r2 / 0.006) * 1.8;
  vec3 col = old * bulge;
  if (edge > 0.001) {
    float along = dot(p, axis);
    float across = dot(p, vec2(-axis.y, axis.x));
    // spessore apparente: lo spessore vero del disco (~4% del raggio) più la parte dovuta all'inclinazione
    float sig = max(0.5 * cosI * 0.22, 0.02);
    float prof = exp(-abs(along) / 0.22) * exp(-0.5 * across * across / (sig * sig));
    // stessa luce totale del disco visto di faccia (2π·0,22² × 0,75 ≈ 0,23)
    float amp = 0.23 / (0.22 * 2.0 * sig * 2.5066);
    float lane = 1.0 - 0.6 * exp(-across * across / (sig * sig * 0.12)) * smoothstep(0.03, 0.15, abs(along));
    vec3 c = mix(young, old, exp(-abs(along) / 0.12));
    // la striscia sfuma prima del bordo del quadrato (di taglio è luminosa: si vedrebbe il taglio netto)
    col += c * prof * amp * lane * edge * (1.0 - smoothstep(0.75, 1.0, abs(along)));
  }
  gl_FragColor = vec4(col * color * intensity, 1.0);
}`;

/** Nucleo e disco "di taglio" di una galassia a spirale (vedi GALAXY_CORE_F). */
export function galaxyCoreMaterial(color: Color): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      color: { value: color }, intensity: { value: 1 }, axis: { value: new Vector2(1, 0) }, cosI: { value: 1 },
      edge: { value: 0 },
    },
    vertexShader: BILLBOARD_V,
    fragmentShader: GALAXY_CORE_F,
    blending: AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
}

const BLACKHOLE_F = /* glsl */ `
${HEAD_F}
uniform float extent;     // metà lato del quadrato, in raggi di Schwarzschild
uniform float phase;      // orientamento delle zone più brillanti dell'anello
uniform float intensity;
uniform float sharp;      // 0 = come lo vede l'EHT (sfocato), 1 = nitido, come vicino al buco nero
varying vec2 vUv;
// mappa di colori "afmhot", la stessa delle immagini dell'Event Horizon Telescope
float sq(float x) { return x * x; }   // pow(x, 2.0) con x negativo non è definito (NaN su alcune GPU)
vec3 afmhot(float x) {
  x = clamp(x, 0.0, 1.0);
  return vec3(clamp(2.0 * x, 0.0, 1.0), clamp(2.0 * x - 0.5, 0.0, 1.0), clamp(2.0 * x - 1.0, 0.0, 1.0));
}
void main() {
  #include <logdepthbuf_fragment>
  vec2 p = (vUv - 0.5) * 2.0 * extent;   // in raggi di Schwarzschild
  float r = length(p);
  float ang = atan(p.y, p.x);
  float rsh = 2.598;                     // ombra: sqrt(27)/2 raggi di Schwarzschild
  // --- come nell'immagine EHT del 2022: anello largo quanto la risoluzione del telescopio
  float ringR = rsh * 0.98;
  float ringE = exp(-sq((r - ringR) / 0.85));
  float knots = 1.0 + 0.32 * cos(3.0 * (ang - phase)) + 0.22 * cos(ang - phase - 0.7);
  float inner = 0.16 * exp(-r * r / (ringR * ringR * 0.6));
  float Ieht = ringE * knots + inner;
  // --- nitido: sottile anello di fotoni sul bordo dell'ombra, gas caldo che brilla appena fuori
  //     (più luminoso dal lato dove il gas ruota verso di noi: effetto Doppler)
  float photon = exp(-sq((r - rsh) / 0.07)) * 1.3 + exp(-sq((r - rsh * 1.04) / 0.22)) * 0.35;
  float flow = smoothstep(rsh * 0.97, rsh * 1.06, r) * exp(-(r - rsh) / 0.8);
  float doppler = 1.0 + 0.6 * cos(ang - phase - 0.7) + 0.12 * cos(3.0 * (ang - phase));
  float front = 0.07 * exp(-r * r / 9.0);           // gas davanti all'ombra: la rende appena non nera
  float Isharp = (photon + flow * 0.85) * doppler + front;
  float I = mix(Ieht, Isharp, sharp);
  float edge = 1.0 - smoothstep(extent * 0.75, extent, r);
  vec3 col = afmhot(I * mix(0.52, 0.6, sharp)) * 0.75 * intensity * edge;
  // l'ombra copre ciò che sta dietro (le stelle lontane): nitida da vicino, sfumata da lontano
  float occl = 1.0 - smoothstep(rsh * mix(0.9, 0.985, sharp), rsh * mix(1.05, 1.0, sharp), r);
  gl_FragColor = vec4(col, occl);
}`;

/** Buco nero come lo ha fotografato l'Event Horizon Telescope (onde radio a 1,3 mm). */
export function blackHoleMaterial(extent: number): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { extent: { value: extent }, phase: { value: 0.5 }, intensity: { value: 1 }, sharp: { value: 0 } },
    vertexShader: BILLBOARD_V,
    fragmentShader: BLACKHOLE_F,
    // colore sommato + copertura: risultato = colore + sfondo × (1 − alfa)
    blending: CustomBlending,
    blendEquation: AddEquation,
    blendSrc: OneFactor,
    blendDst: OneMinusSrcAlphaFactor,
    transparent: true,
    depthWrite: false,
  });
}
