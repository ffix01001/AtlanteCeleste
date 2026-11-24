/**
 * Sagittarius A* da vicino: la luce che passa accanto al buco nero, calcolata davvero.
 *
 * Si seguono all'indietro i raggi di luce che arrivano alla camera, nello spaziotempo curvo di un
 * buco nero che non ruota (Schwarzschild). Ogni raggio resta in un piano che contiene il buco nero;
 * in quel piano la sua forma obbedisce all'equazione delle orbite della luce
 *     d²u/dφ² = −u + 3/2·u²        (u = rs / r)
 * integrata passo passo (Runge-Kutta). Così vengono da sole, senza trucchi:
 *  - l'ombra, 2,6 volte più larga dell'orizzonte (da vicino copre gran parte del cielo);
 *  - il sottile anello di fotoni e le immagini secondarie;
 *  - il cielo deformato dalla lente gravitazionale, compreso quello alle spalle della camera
 *    (le direzioni fuori dallo schermo si leggono da una "fotografia a 360°" della scena);
 *  - il gas caldo che gira attorno al buco nero: un flusso spesso e trasparente, come si pensa sia
 *    quello di Sgr A*, più luminoso dal lato che viene verso di noi (effetto Doppler) e più debole
 *    vicino all'orizzonte (spostamento verso il rosso gravitazionale);
 *  - la "macchia calda" dei lampi, che gira attorno al buco nero in poco meno di un'ora.
 * La camera è un osservatore fermo (sospeso con i razzi): la luce che gli arriva da lontano è più
 * blu e più intensa, tanto più quanto è vicino all'orizzonte.
 *
 * Per non pesare sulla scheda video il lavoro è diviso in due:
 *  - la deviazione della luce delle stelle dipende solo dall'angolo fra il raggio e la direzione
 *    del buco nero: la calcola il processore una volta (una tabella di 1024 raggi, rifatta solo
 *    quando cambia la distanza) e ogni pixel la legge;
 *  - la luce del gas, che non ha questa simmetria, si calcola raggio per raggio, ma a metà
 *    risoluzione (è una luce morbida) e solo per i raggi che passano vicino al buco nero.
 *
 * Direzioni nella scena (la camera è nell'origine), distanze in raggi di Schwarzschild. Da lontano,
 * quando l'ombra è più piccola di un pixel, gas e ombra li disegna ancora il quadrato del buco nero
 * nella scena (come lo vede l'Event Horizon Telescope) e qui resta solo la luce deviata.
 */

import {
  DataTexture, FloatType, HalfFloatType, Matrix4, NearestFilter, RedFormat, RGBAFormat, ShaderMaterial, Vector3, Vector4, WebGLRenderTarget,
  type Texture, type WebGLRenderer,
} from 'three';
import { kerrCamera } from '../core/kerrgeo';
import { horizon, isco } from '../core/kerr';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';
import { LUT_K, deflectionLut, shadowRadius } from '../core/blackhole';

const LUT_N = 1024;
/** tabella 2D del buco nero che ruota: direzioni attorno al centro × campioni dal bordo dell'ombra */
const K_NCHI = 72, K_NT = 48;

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/** parte comune: direzione del raggio del pixel e piano del raggio attorno al buco nero */
const RAY_COMMON = /* glsl */ `
uniform vec3 camRight;
uniform vec3 camUp;
uniform vec3 camFwd;
uniform float tanHalf;
uniform float aspect;
uniform vec3 bh;          // centro del buco nero rispetto alla camera, in rs
varying vec2 vUv;
vec3 pixelRay() {
  vec2 ndc = vUv * 2.0 - 1.0;
  return normalize(camFwd + ndc.x * tanHalf * aspect * camRight + ndc.y * tanHalf * camUp);
}
// --- buco nero che ruota (Kerr): vedi core/kerrgeo.ts. Lunghezze in M = rs/2, assi X, Y, Z con Z
//     lungo l'asse di rotazione e la camera nel piano X-Z
uniform float kerrOn;
uniform float spin;       // a* (0..1)
uniform vec3 kX;
uniform vec3 kY;
uniform vec3 kZ;
uniform vec3 kPos;        // posizione della camera
uniform vec3 kC;          // verso il centro; kEa: verso l'asse; kEb = kC × kEa
uniform vec3 kEa;
uniform vec3 kEb;
// direzione di vista negli assi (kC, kEa, kEb) della camera
vec3 kerrView(vec3 d) {
  vec3 n = vec3(dot(d, kX), dot(d, kY), dot(d, kZ));
  return vec3(dot(n, kC), dot(n, kEa), dot(n, kEb));
}
// E1: dal buco nero verso la camera; E2: nel piano del raggio, dalla parte verso cui va
void rayPlane(vec3 d, out vec3 E1, out vec3 E2, out float cp, out float sp) {
  float r0 = length(bh);
  E1 = -bh / r0;
  cp = dot(d, E1);
  vec3 tv = d - cp * E1;
  sp = length(tv);
  E2 = sp > 1e-9 ? tv / sp : normalize(cross(E1, abs(E1.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
}`;

/** la luce del gas lungo ogni raggio (metà risoluzione) */
const EMIS_F = /* glsl */ `
${RAY_COMMON}
uniform vec3 axis;        // asse di rotazione del gas (verso del momento angolare)
uniform vec4 hs;          // macchia calda: posizione rispetto al buco nero (rs), luminosità
uniform vec3 hsT;         // direzione del moto della macchia
uniform float hsLen;      // lunghezza della macchia lungo l'orbita (rs, una deviazione standard)
const float U_GAS = 0.083;   // il gas che conta sta entro 12 rs
uniform vec4 kU;          // impulso del fotone: p = kU + n0·kE0 + n1·kE1 + n2·kE2 (t, x, y, z)
uniform vec4 kE0;
uniform vec4 kE1;
uniform vec4 kE2;
uniform vec4 hsK;         // macchia calda negli assi X, Y, Z (M) e luminosità
uniform vec3 hsTK;
uniform float kRh;        // orizzonte
uniform float kIsco;      // ultima orbita stabile (prograda)

// derivate di posizione e impulso lungo il raggio (equazioni di Hamilton in Kerr-Schild, spin am)
void kerrDeriv(float am, vec3 x, vec3 p, float pt, out vec3 dx, out vec3 dp, out float r, out float f, out vec3 l) {
  float a2 = am * am;
  float w = dot(x, x) - a2;
  float D = sqrt(w * w + 4.0 * a2 * x.z * x.z);
  float r2 = max(0.5 * (w + D), 1e-12);
  r = sqrt(r2);
  float d = r2 + a2;
  float G = r2 * r2 + a2 * x.z * x.z;
  f = 2.0 * r2 * r / G;
  l = vec3((r * x.x + am * x.y) / d, (r * x.y - am * x.x) / d, x.z / r);
  float lp = -pt + dot(l, p);
  float k = f * lp;
  dx = p - k * l;
  float Ds = max(D, 1e-12);
  vec3 gr = vec3(x.x * r / Ds, x.y * r / Ds, x.z * d / (r * Ds));
  float fr = (6.0 * r2 * G - 8.0 * r2 * r2 * r2) / (G * G);
  float fz = -4.0 * r2 * r * a2 * x.z / (G * G);
  float Sr = (p.x * (x.x * d - (r * x.x + am * x.y) * 2.0 * r) + p.y * (x.y * d - (r * x.y - am * x.x) * 2.0 * r)) / (d * d) - p.z * x.z / r2;
  vec3 gS = Sr * gr + vec3((r * p.x - am * p.y) / d, (am * p.x + r * p.y) / d, p.z / r);
  float h2 = 0.5 * lp * lp;
  dp = h2 * (fr * gr + vec3(0.0, 0.0, fz)) + k * gS;
}

// luce del gas lungo il raggio attorno al buco nero che ruota. Il raggio si segue all'indietro nel
// tempo: è come seguirlo in avanti attorno a un buco nero che gira al contrario (spin −a, gas al contrario)
float kerrEmission(vec3 d) {
  vec3 nv = kerrView(d);
  float R0 = length(kPos);
  float sinPsi = sqrt(max(1.0 - nv.x * nv.x, 0.0));
  // raggi che non passano mai entro 16 M (8 rs, dove finisce il gas che si vede): niente gas
  if (R0 > 18.0 && (nv.x < 0.0 || R0 * sinPsi > 21.0)) return 0.0;
  float am = -spin;
  vec4 p4 = kU + nv.x * kE0 + nv.y * kE1 + nv.z * kE2;
  float pt = p4.x;
  vec3 x = kPos, p = p4.yzw;
  float I = 0.0;
  vec3 dx, dp, l, dx2, dp2;
  float r, f, rr, ff;
  // (metodo del punto medio: per la luce morbida del gas basta, e costa la metà di Runge-Kutta 4)
  for (int i = 0; i < 110; i++) {
    kerrDeriv(am, x, p, pt, dx, dp, r, f, l);
    if (r < kRh * 1.04) break;
    if (r > 16.0 && dot(x, dx) > 0.0) break;
    float h = (r > 16.0 ? 0.2 * r : min(0.09 * r, max(0.05, 0.2 * (r - kRh)))) / max(-pt, 1e-6);
    vec3 ll;
    kerrDeriv(am, x + 0.5 * h * dx, p + 0.5 * h * dp, pt, dx2, dp2, rr, ff, ll);
    if (r < 16.0) {
      // il gas in questo punto (prima del passo): stesso flusso spesso del caso senza rotazione
      float Rc = length(x.xy);
      float q = x.z / (0.27 * Rc + 0.44);
      float j = 0.0;
      if (q * q < 16.0) {
        float u = 2.0 / r;   // come nel caso senza rotazione, dove u = rs / r
        float u2 = u * u;
        // (sotto l'ultima orbita stabile il gas precipita e si dirada: la sua luce cala in fretta)
        j = 1.6 * u2 * u2 * sqrt(u) * exp(-0.5 * q * q) * smoothstep(kRh, kIsco + 1.5, r) * (1.0 - smoothstep(10.0, 16.0, r));
      }
      if (hsK.w > 0.0) {
        vec3 dh = x - hsK.xyz;
        float dd = dot(dh, dh);
        float sl = 2.0 * hsLen;
        if (dd < 16.0 * sl * sl + 16.0) {
          float al = dot(dh, hsTK);
          j += hsK.w * exp(-0.5 * (al * al / (sl * sl) + (dd - al * al) / 1.2));
        }
      }
      if (j > 2e-5) {
        // il gas gira con il buco nero (qui al contrario, come lo spin); sotto l'ultima orbita
        // stabile è trascinato dallo spazio stesso (velocità angolare dell'osservatore senza momento angolare)
        float a2 = spin * spin;
        float A = (r * r + a2) * (r * r + a2) - a2 * (r * r - 2.0 * r + a2);
        float wz = -2.0 * spin * r / A;
        float wk = -1.0 / (pow(max(Rc, kIsco), 1.5) + spin);
        float Om = mix(wz, wk, smoothstep(kRh, kIsco, r));
        float lv = 1.0 + Om * (l.y * x.x - l.x * x.y);
        float N = 1.0 - Om * Om * Rc * Rc - f * lv * lv;
        if (N < 0.02) {
          Om = wz;
          lv = 1.0 + Om * (l.y * x.x - l.x * x.y);
          N = max(1.0 - Om * Om * Rc * Rc - f * lv * lv, 0.02);
        }
        // energia del fotone vista dal gas (quella vista dalla camera vale 1)
        float Eg = -(pt + Om * (x.x * p.y - x.y * p.x)) * inversesqrt(N);
        float g = 1.0 / max(Eg, 1e-3);
        I += g * g * j * h * 0.5;   // (0,5: lunghezze in M invece che in rs)
      }
    }
    x += h * dx2;
    p += h * dp2;
  }
  return I;
}

void main() {
  vec3 d = pixelRay();
  if (kerrOn > 0.5) { gl_FragColor = vec4(kerrEmission(d), 0.0, 0.0, 1.0); return; }
  vec3 E1, E2;
  float cp, sp;
  rayPlane(d, E1, E2, cp, sp);
  sp = max(sp, 1e-7);
  float u0 = 1.0 / length(bh);
  float lapse0 = sqrt(max(1.0 - u0, 1e-6));
  float b = sp / (u0 * lapse0);
  // raggi che non passano mai entro 12 rs: niente gas
  if (u0 < U_GAS && (cp > 0.0 || b > 13.0)) { gl_FragColor = vec4(0.0); return; }
  float u = u0;
  float up = -u0 * lapse0 * cp / sp;
  float cph = 1.0, sph = 0.0;   // cos φ e sin φ, aggiornati a ogni passo con una piccola rotazione
  float I = 0.0;
  for (int i = 0; i < 200; i++) {
    // uscito dalla zona del gas (e se ne allontana) o caduto oltre l'orizzonte: finito
    if (up <= 0.0 && u < U_GAS) break;
    float h = min(0.07, 0.25 * u / max(abs(up), 1e-12));
    float k1u = up;
    float k1p = -u + 1.5 * u * u;
    float ua = u + 0.5 * h * k1u;
    float k2u = up + 0.5 * h * k1p;
    float k2p = -ua + 1.5 * ua * ua;
    float ub = u + 0.5 * h * k2u;
    float k3u = up + 0.5 * h * k2p;
    float k3p = -ub + 1.5 * ub * ub;
    float uc = u + h * k3u;
    float k4u = up + h * k3p;
    float k4p = -uc + 1.5 * uc * uc;
    u += h / 6.0 * (k1u + 2.0 * k2u + 2.0 * k3u + k4u);
    up += h / 6.0 * (k1p + 2.0 * k2p + 2.0 * k3p + k4p);
    float ch = 1.0 - 0.5 * h * h, sh = h - h * h * h / 6.0;
    float c2 = cph * ch - sph * sh;
    sph = sph * ch + cph * sh;
    cph = c2;
    if (u >= 1.0) break;
    if (u <= U_GAS) continue;
    float r = 1.0 / u;
    vec3 er = cph * E1 + sph * E2;
    vec3 X = r * er;
    float z = dot(X, axis);
    // flusso spesso (altezza ~ un quarto della distanza), molto più denso e caldo verso il centro:
    // la luce viene quasi tutta dai primi 5-10 rs, come nelle immagini dell'EHT
    float R = sqrt(max(r * r - z * z, 0.0));
    float q = z / (0.27 * R + 0.22);
    float j = 0.0;
    if (q * q < 16.0) {
      float u2 = u * u;
      j = 7.0 * u2 * u2 * sqrt(u) * exp(-0.5 * q * q) * smoothstep(1.0, 1.8, r) * (1.0 - smoothstep(7.0, 12.0, r));
    }
    // la macchia calda dei lampi, allungata lungo l'orbita
    if (hs.w > 0.0) {
      vec3 dh = X - hs.xyz;
      float dd = dot(dh, dh);
      if (dd < 16.0 * hsLen * hsLen + 4.0) {
        float al = dot(dh, hsT);
        j += hs.w * exp(-0.5 * (al * al / (hsLen * hsLen) + (dd - al * al) / 0.3));
      }
    }
    if (j < 2e-5) continue;
    vec3 Rv = X - z * axis;
    // il gas gira attorno all'asse (velocità misurata da chi sta fermo lì) e, sotto l'ultima orbita
    // stabile (3 rs), precipita verso l'orizzonte
    float vc = min(sqrt(0.5 / max(r - 1.0, 0.05)), 0.6) * R / r;
    vec3 v = R > 1e-4 ? vc * normalize(cross(axis, Rv)) : vec3(0.0);
    v -= er * (0.45 * sqrt(u) * (1.0 - smoothstep(2.2, 4.0, r)));
    float vv = length(v);
    if (vv > 0.97) v *= 0.97 / vv;
    // direzione locale del raggio (all'indietro): la luce va al contrario
    vec3 eph = -sph * E1 + cph * E2;   // (cph, sph: rotazione di φ)
    float drdphi = -up / (u * u);
    float lapse = sqrt(max(1.0 - u, 1e-6));
    vec3 n = normalize((drdphi / lapse) * er + r * eph);
    float gam = inversesqrt(max(1.0 - dot(v, v), 1e-4));
    // spostamento di frequenza: Doppler del gas e gravità fra il gas e la camera
    float g = (lapse / lapse0) / (gam * (1.0 + dot(v, n)));
    float ds = h * sqrt(drdphi * drdphi + r * r);
    I += g * g * g * j * ds;
  }
  gl_FragColor = vec4(I, 0.0, 0.0, 1.0);
}`;

/** cielo deviato (dalla tabella), ombra, luce del gas: a piena risoluzione */
const COMP_F = /* glsl */ `
${RAY_COMMON}
uniform sampler2D tDiffuse;
uniform sampler2D tEmis;
uniform sampler2D lut;
uniform float lutN;
uniform float lutK;
uniform float lutAlpha;   // raggio angolare dell'ombra (rad) per cui è fatta la tabella
uniform samplerCube env;
uniform float envOn;
uniform float envTexPerRad;
uniform mat4 viewProj;
uniform float maxTheta;   // oltre questo angolo dal buco nero la deviazione è sotto il pixel
uniform float lensOn;
uniform float flowOn;
uniform float expo;
uniform float pxPerRad;
uniform sampler2D kLut;   // tabella 2D: colonne = campioni dal bordo dell'ombra, righe = direzioni χ
uniform float kPsiMax;
uniform float kScale;     // distanza attuale della camera / distanza per cui è fatta la tabella
uniform float kBlue;      // spostamento verso il blu della luce che arriva alla camera
const float PI = 3.14159265358979;
const float K_NCHI = ${K_NCHI}.0;
const float K_NT = ${K_NT}.0;

// una riga della tabella: direzione di arrivo (xyz) e bordo dell'ombra (w) per l'angolo ψ dal centro
vec4 kerrRow(int row, float psi) {
  float edge = texelFetch(kLut, ivec2(0, row), 0).a;
  float t = log(1.0 + max(psi - edge, 0.0) * (exp(lutK) - 1.0) / max(kPsiMax - edge, 1e-6)) / lutK;
  float x = t * K_NT - 0.5;
  float i0 = clamp(floor(x), 0.0, K_NT - 1.0);
  float fr = clamp(x - i0, 0.0, 1.0);
  vec3 a = texelFetch(kLut, ivec2(int(i0), row), 0).rgb;
  vec3 b = texelFetch(kLut, ivec2(int(min(i0 + 1.0, K_NT - 1.0)), row), 0).rgb;
  return vec4(mix(a, b, fr), edge);
}

// mappa di colori "afmhot", la stessa delle immagini dell'Event Horizon Telescope
vec3 afmhot(float x) {
  x = clamp(x, 0.0, 1.0);
  return vec3(clamp(2.0 * x, 0.0, 1.0), clamp(2.0 * x - 0.5, 0.0, 1.0), clamp(2.0 * x - 1.0, 0.0, 1.0));
}

// angolo polare finale del raggio (attorno al buco nero, dalla camera) per un raggio a θ dal buco nero
float escapeAt(float th) {
  float t = log(1.0 + max(th - lutAlpha, 0.0) * (exp(lutK) - 1.0) / (PI - lutAlpha)) / lutK;
  float x = t * lutN - 0.5;
  float i0 = clamp(floor(x), 0.0, lutN - 1.0);
  float f = clamp(x - i0, 0.0, 1.0);
  float a = texelFetch(lut, ivec2(int(i0), 0), 0).r;
  float b = texelFetch(lut, ivec2(int(min(i0 + 1.0, lutN - 1.0)), 0), 0).r;
  return mix(a, b, f);
}

void main() {
  vec4 base = texture2D(tDiffuse, vUv);
  vec3 d = pixelRay();
  vec3 E1, E2;
  float cp, sp;
  rayPlane(d, E1, E2, cp, sp);
  float th = atan(sp, -cp);                 // angolo fra il raggio e la direzione del buco nero
  bool near = th < maxTheta;
  float phiInf = near ? escapeAt(th) : atan(sp, cp);
  vec3 dirInf = cos(phiInf) * E1 + sin(phiInf) * E2;
  float edgeAng = lutAlpha;
  if (kerrOn > 0.5 && th < kPsiMax) {
    // buco nero che ruota: la deviazione dipende anche da che parte dell'asse passa il raggio
    vec3 nv = kerrView(d);
    float chi = atan(nv.z, nv.y);
    float y = fract(chi / (2.0 * PI)) * K_NCHI;
    float j0 = floor(y);
    // la tabella arriva con un attimo di ritardo: se intanto la camera si è avvicinata o allontanata,
    // gli angoli si riscalano con la distanza (così l'ombra cresce in modo continuo, senza scatti)
    float ks = mix(kScale, 1.0, smoothstep(0.9, 1.4, th));
    vec4 r0 = kerrRow(int(mod(j0, K_NCHI)), th * ks);
    vec4 r1 = kerrRow(int(mod(j0 + 1.0, K_NCHI)), th * ks);
    vec4 kr = mix(r0, r1, y - j0);
    kr.w /= ks;
    vec3 kd = normalize(kr.x * kX + kr.y * kY + kr.z * kZ);
    // verso il margine della tabella si torna alla deviazione senza rotazione (lì la differenza è minima)
    float wk = 1.0 - smoothstep(0.75 * kPsiMax, kPsiMax, th);
    dirInf = normalize(mix(dirInf, kd, wk));
    edgeAng = kr.w;
  }
  // il cielo nella direzione da cui arriva la luce: dall'immagine se è sullo schermo, se no dalla
  // fotografia a 360°. Dove la lente rimpicciolisce il cielo si fa la media di più punti
  vec4 clip = viewProj * vec4(dirInf, 0.0);
  vec2 sn = clip.xy / max(abs(clip.w), 1e-6);
  vec2 suv = sn * 0.5 + 0.5;
  float fw = max(length(dFdx(dirInf)), length(dFdy(dirInf)));
  vec2 dsx = dFdx(suv), dsy = dFdy(suv);
  float onScr = step(0.0, clip.w) * (1.0 - smoothstep(0.96, 1.0, max(abs(sn.x), abs(sn.y))));
  vec3 sky = base.rgb;
  if (near) {
    vec3 sScr = vec3(0.0);
    if (onScr > 0.0) {
      float n = clamp(ceil(fw * pxPerRad), 1.0, 3.0);
      for (int i = 0; i < 4; i++) {
        if (float(i) >= n) break;
        for (int k = 0; k < 4; k++) {
          if (float(k) >= n) break;
          vec2 o = ((float(i) + 0.5) / n - 0.5) * dsx + ((float(k) + 0.5) / n - 0.5) * dsy;
          sScr += texture2D(tDiffuse, suv + o).rgb;
        }
      }
      sScr /= n * n;
    }
    vec3 sEnv = base.rgb * 0.6;
    if (onScr < 1.0 && envOn > 0.5) sEnv = textureLod(env, dirInf, clamp(log2(max(fw * envTexPerRad, 1.0)), 0.0, 6.0)).rgb;
    sky = mix(base.rgb, mix(sEnv, sScr, onScr), lensOn);
  }
  // l'ombra (con il bordo sfumato su un pixel)
  float pix = 1.0 / pxPerRad;
  float shadow = (1.0 - smoothstep(edgeAng - pix, edgeAng + pix, th)) * flowOn;
  sky *= 1.0 - shadow;
  // la camera ferma vicino al buco nero riceve la luce da lontano più blu e più intensa (∝ g⁴)
  float gcam = kerrOn > 0.5 ? kBlue : inversesqrt(max(1.0 - 1.0 / length(bh), 1e-6));
  float boost = min(gcam * gcam * gcam * gcam, 8.0);
  vec3 tint = mix(vec3(1.0), vec3(0.72, 0.95, 1.5), clamp((gcam - 1.0) * 0.8, 0.0, 1.0));
  sky *= boost * tint;
  // la luce del gas (la curva tiene scuro il gas più debole: niente nebbia rossa su tutto il cielo)
  float I = flowOn > 0.0 ? texture2D(tEmis, vUv).r : 0.0;
  vec3 gas = afmhot(pow(1.0 - exp(-I * expo), 1.6)) * 0.9 * flowOn;
  gl_FragColor = vec4(sky + gas, base.a);
}`;

export class BlackHolePass extends Pass {
  /** valori condivisi dai due passaggi */
  readonly u = {
    tDiffuse: { value: null as Texture | null },
    tEmis: { value: null as Texture | null },
    lut: { value: null as Texture | null },
    lutN: { value: LUT_N },
    lutK: { value: LUT_K },
    lutAlpha: { value: 0.1 },
    env: { value: null as Texture | null },
    envOn: { value: 0 },
    envTexPerRad: { value: 128 },
    camRight: { value: new Vector3(1, 0, 0) },
    camUp: { value: new Vector3(0, 1, 0) },
    camFwd: { value: new Vector3(0, 0, -1) },
    tanHalf: { value: 0.47 },
    aspect: { value: 1 },
    viewProj: { value: new Matrix4() },
    bh: { value: new Vector3(0, 0, -100) },
    axis: { value: new Vector3(0, 1, 0) },
    hs: { value: new Vector4(0, 0, 0, 0) },
    hsT: { value: new Vector3(1, 0, 0) },
    hsLen: { value: 0.7 },
    maxTheta: { value: Math.PI },
    lensOn: { value: 0 },
    flowOn: { value: 0 },
    expo: { value: 4.5 },
    pxPerRad: { value: 1000 },
    kerrOn: { value: 0 },
    spin: { value: 0 },
    kX: { value: new Vector3(1, 0, 0) },
    kY: { value: new Vector3(0, 1, 0) },
    kZ: { value: new Vector3(0, 0, 1) },
    kPos: { value: new Vector3(40, 0, 0) },
    kC: { value: new Vector3(-1, 0, 0) },
    kEa: { value: new Vector3(0, 0, 1) },
    kEb: { value: new Vector3(0, 1, 0) },
    kU: { value: new Vector4() },
    kE0: { value: new Vector4() },
    kE1: { value: new Vector4() },
    kE2: { value: new Vector4() },
    hsK: { value: new Vector4() },
    hsTK: { value: new Vector3(1, 0, 0) },
    kRh: { value: 2 },
    kIsco: { value: 6 },
    kLut: { value: null as Texture | null },
    kPsiMax: { value: 1 },
    kScale: { value: 1 },
    kBlue: { value: 1 },
  };
  // --- buco nero che ruota: la tabella 2D arriva da un thread separato
  private kData = new Float32Array(K_NCHI * K_NT * 4);
  private kTex = new DataTexture(this.kData, K_NT, K_NCHI, RGBAFormat, FloatType);
  private kWorker: Worker | null = null;
  private kBusy = false;
  private kAsked = { a: -1, R: 0, lat: 0, psiMax: 0 };
  /** la tabella in uso vale per questo spin (−1: nessuna ancora) */
  private kHave = -1;
  private kId = 0;
  /** distanza della camera (M) per cui è stata calcolata la tabella in uso */
  private kTableR = 0;
  private emisRT = new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false });
  private emisQuad: FullScreenQuad;
  private compQuad: FullScreenQuad;
  private lutData = new Float32Array(LUT_N);
  private lutTex = new DataTexture(this.lutData, LUT_N, 1, RedFormat, FloatType);
  private lutR0 = -1;

  constructor() {
    super();
    this.enabled = false;
    this.lutTex.minFilter = this.lutTex.magFilter = NearestFilter;
    this.lutTex.generateMipmaps = false;
    this.u.lut.value = this.lutTex;
    this.kTex.minFilter = this.kTex.magFilter = NearestFilter;
    this.kTex.generateMipmaps = false;
    this.u.kLut.value = this.kTex;
    this.u.tEmis.value = this.emisRT.texture;
    this.emisQuad = new FullScreenQuad(new ShaderMaterial({ uniforms: this.u, vertexShader: VERT, fragmentShader: EMIS_F, depthTest: false, depthWrite: false }));
    this.compQuad = new FullScreenQuad(new ShaderMaterial({ uniforms: this.u, vertexShader: VERT, fragmentShader: COMP_F, depthTest: false, depthWrite: false }));
  }

  /** La tabella della deviazione per la distanza r0 (in rs): si rifà solo se la distanza cambia. */
  setDistance(r0: number): void {
    if (this.lutR0 > 0 && Math.abs(r0 - this.lutR0) <= 0.002 * r0) return;
    deflectionLut(r0, LUT_N, this.lutData);
    this.lutTex.needsUpdate = true;
    this.u.lutAlpha.value = shadowRadius(r0);
    this.lutR0 = r0;
  }

  /**
   * Buco nero che ruota: spin a* (0 = spento) e posizione della camera in unità di M, negli assi
   * X, Y, Z (camera nel piano X-Z: ρ lungo X, z lungo l'asse di rotazione). Aggiorna la camera
   * (subito) e chiede la tabella della deviazione (arriva dopo un decimo di secondo; intanto
   * resta la precedente). Restituisce false finché non c'è una tabella per questo spin.
   */
  setKerr(a: number, rho: number, z: number, pxPerRad: number): boolean {
    const u = this.u;
    if (a <= 1e-4) { u.kerrOn.value = 0; return false; }
    // la camera è un osservatore fermo: deve stare fuori dall'ergosfera (f < 1)
    let k = 1;
    let cam = kerrCamera(-a, rho, z);
    while (cam.blueshift > 6 && k < 3) { k *= 1.02; cam = kerrCamera(-a, rho * k, z * k); }
    u.spin.value = a;
    u.kPos.value.set(cam.pos[0], cam.pos[1], cam.pos[2]);
    u.kC.value.set(...cam.c); u.kEa.value.set(...cam.ea); u.kEb.value.set(...cam.eb);
    u.kU.value.set(...cam.U); u.kE0.value.set(...cam.E[0]); u.kE1.value.set(...cam.E[1]); u.kE2.value.set(...cam.E[2]);
    u.kBlue.value = cam.blueshift;
    u.kRh.value = horizon(a);
    u.kIsco.value = isco(a, true);
    // la tabella copre fino a dove il raggio passa a ~60 M dal buco nero; oltre vale quella senza rotazione
    const R = Math.hypot(cam.pos[0], cam.pos[2]), lat = Math.atan2(cam.pos[2], cam.pos[0]);
    const psiMax = R > 62 ? Math.asin(60 / R) : Math.PI - 0.04;
    const q = this.kAsked;
    const changed = a !== q.a || Math.abs(R - q.R) > 0.003 * R || Math.abs(lat - q.lat) > 0.004 || Math.abs(psiMax - q.psiMax) > 0.003 * psiMax;
    if (changed && !this.kBusy) {
      if (!this.kWorker) {
        this.kWorker = new Worker(new URL('../workers/kerrlut.worker.ts', import.meta.url), { type: 'module' });
        this.kWorker.onmessage = (ev: MessageEvent) => {
          const m = ev.data as { a: number; rho: number; z: number; psiMax: number; data: Float32Array };
          this.kTableR = Math.hypot(m.rho, m.z);
          this.kBusy = false;
          this.kData.set(m.data);
          this.kTex.needsUpdate = true;
          u.kPsiMax.value = m.psiMax;
          this.kHave = m.a;
          this.onLut();
        };
      }
      this.kBusy = true;
      this.kAsked = { a, R, lat, psiMax };
      this.kWorker.postMessage({ id: ++this.kId, a, rho: cam.pos[0], z: cam.pos[2], psiMax, nChi: K_NCHI, nT: K_NT });
    }
    void pxPerRad;
    u.kScale.value = this.kTableR > 0 ? Math.min(1.3, Math.max(0.77, R / this.kTableR)) : 1;
    const ready = this.kHave === a;
    u.kerrOn.value = ready ? 1 : 0;
    return ready;
  }

  /** chiamato quando arriva una tabella nuova (per ridisegnare la scena anche a camera ferma) */
  onLut: () => void = () => {};

  private fullW = 2;
  private fullH = 2;
  private emisDiv = 2;

  override setSize(width: number, height: number): void {
    this.fullW = width; this.fullH = height;
    this.emisRT.setSize(Math.max(1, Math.ceil(width / this.emisDiv)), Math.max(1, Math.ceil(height / this.emisDiv)));
  }

  override render(renderer: WebGLRenderer, writeBuffer: WebGLRenderTarget, readBuffer: WebGLRenderTarget): void {
    // il gas attorno al buco nero che ruota costa di più per ogni raggio: lì un terzo della risoluzione
    // (è una luce morbida: la differenza non si vede), altrimenti metà
    // e comunque mai più di ~330.000 punti: su una finestra grande e uno schermo Retina i pixel sono
    // milioni, e il gas, sfocato com'è, non ne ha bisogno
    const budget = this.u.kerrOn.value > 0.5 ? 330000 : 800000;
    const div = Math.min(6, Math.max(this.u.kerrOn.value > 0.5 ? 3 : 2, Math.ceil(Math.sqrt((this.fullW * this.fullH) / budget))));
    if (div !== this.emisDiv) { this.emisDiv = div; this.setSize(this.fullW, this.fullH); }
    if (this.u.flowOn.value > 0) {
      renderer.setRenderTarget(this.emisRT);
      this.emisQuad.render(renderer);
    }
    this.u.tDiffuse.value = readBuffer.texture;
    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
    } else {
      renderer.setRenderTarget(writeBuffer);
      if (this.clear) renderer.clear();
    }
    this.compQuad.render(renderer);
  }

  override dispose(): void {
    this.emisRT.dispose();
    this.lutTex.dispose();
    this.kTex.dispose();
    this.kWorker?.terminate();
    this.emisQuad.dispose();
    this.compQuad.dispose();
  }
}
