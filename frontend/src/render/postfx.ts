/**
 * Effetti finali dell'immagine, con meno passaggi a piena risoluzione.
 *
 * Prima, dopo il disegno della scena, l'immagine intera (milioni di pixel a mezza precisione)
 * veniva letta e riscritta quattro volte: pulizia dei pixel non validi, somma del bagliore,
 * esposizione e conversione dei colori. Ora:
 *   - il bagliore (LeanBloomPass) lavora solo sulle sue immagini a bassa risoluzione e non
 *     riscrive la scena; la pulizia dei pixel non validi la fa già quando ne estrae le parti
 *     luminose, così un pixel "non numerico" non si allarga in un quadrato nero;
 *   - un solo passaggio finale (FinalPass) pulisce, somma il bagliore, applica l'esposizione
 *     (ACES) e converte in sRGB, scrivendo direttamente sullo schermo.
 * Il risultato è lo stesso di prima.
 */

import { ShaderMaterial, type Texture, type WebGLRenderer, type WebGLRenderTarget } from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

/** vero se il numero è "non numerico" o infinito: si guardano i bit (alcune GPU ignorano isnan) */
const BAD_GLSL = /* glsl */ `
bool bad(float x) { return (floatBitsToUint(x) & 0x7f800000u) == 0x7f800000u; }
vec4 cleanTexel(vec4 c) {
  if (bad(c.r) || bad(c.g) || bad(c.b) || bad(c.a)) return vec4(0.0, 0.0, 0.0, 1.0);
  // limite delle texture a mezza precisione (65504): oltre diventerebbero infinite
  return clamp(c, vec4(0.0), vec4(6e4));
}
`;

const HIGH_PASS_F = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec3 defaultColor;
uniform float defaultOpacity;
uniform float luminosityThreshold;
uniform float smoothWidth;
varying vec2 vUv;
${BAD_GLSL}
void main() {
  vec4 texel = cleanTexel(texture2D(tDiffuse, vUv));
  float v = luminance(texel.xyz);
  vec4 outputColor = vec4(defaultColor.rgb, defaultOpacity);
  float alpha = smoothstep(luminosityThreshold, luminosityThreshold + smoothWidth, v);
  gl_FragColor = mix(outputColor, texel, alpha);
}`;

/** Bagliore che non riscrive la scena: il risultato resta in `texture`, lo somma FinalPass. */
export class LeanBloomPass extends UnrealBloomPass {
  constructor(...args: ConstructorParameters<typeof UnrealBloomPass>) {
    super(...args);
    const self = this as any;
    const m = self.materialHighPassFilter as ShaderMaterial;
    m.fragmentShader = HIGH_PASS_F;
    m.needsUpdate = true;
  }

  /** l'immagine del bagliore (a metà risoluzione), da sommare alla scena */
  get texture(): Texture {
    return this.renderTargetsHorizontal[0].texture;
  }

  override render(renderer: WebGLRenderer, _writeBuffer: WebGLRenderTarget, readBuffer: WebGLRenderTarget): void {
    const self = this as any;
    renderer.getClearColor(self._oldClearColor);
    const oldAlpha = renderer.getClearAlpha();
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setClearColor(this.clearColor, 0);
    const quad = self._fsQuad;
    // 1. parti luminose (e pulizia dei pixel non validi)
    self.highPassUniforms.tDiffuse.value = readBuffer.texture;
    self.highPassUniforms.luminosityThreshold.value = this.threshold;
    quad.material = self.materialHighPassFilter;
    renderer.setRenderTarget(self.renderTargetBright);
    renderer.clear();
    quad.render(renderer);
    // 2. sfocature progressive
    let input = self.renderTargetBright as WebGLRenderTarget;
    for (let i = 0; i < self.nMips; i++) {
      const mat = self.separableBlurMaterials[i] as ShaderMaterial;
      quad.material = mat;
      mat.uniforms.colorTexture.value = input.texture;
      mat.uniforms.direction.value = (UnrealBloomPass as any).BlurDirectionX;
      renderer.setRenderTarget(this.renderTargetsHorizontal[i]);
      renderer.clear();
      quad.render(renderer);
      mat.uniforms.colorTexture.value = this.renderTargetsHorizontal[i].texture;
      mat.uniforms.direction.value = (UnrealBloomPass as any).BlurDirectionY;
      renderer.setRenderTarget(this.renderTargetsVertical[i]);
      renderer.clear();
      quad.render(renderer);
      input = this.renderTargetsVertical[i];
    }
    // 3. somma delle sfocature (il risultato resta in renderTargetsHorizontal[0])
    const comp = self.compositeMaterial as ShaderMaterial;
    quad.material = comp;
    comp.uniforms.bloomStrength.value = this.strength;
    comp.uniforms.bloomRadius.value = this.radius;
    comp.uniforms.bloomTintColors.value = self.bloomTintColors;
    renderer.setRenderTarget(this.renderTargetsHorizontal[0]);
    renderer.clear();
    quad.render(renderer);
    renderer.setClearColor(self._oldClearColor, oldAlpha);
    renderer.autoClear = oldAutoClear;
  }
}

const FinalShader = {
  name: 'AtlanteFinal',
  uniforms: {
    tDiffuse: { value: null as Texture | null },
    tBloom: { value: null as Texture | null },
    bloomOn: { value: 1 },
  },
  vertexShader: /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`,
  fragmentShader: /* glsl */ `
uniform sampler2D tDiffuse;
uniform sampler2D tBloom;
uniform float bloomOn;
varying vec2 vUv;
${BAD_GLSL}
void main() {
  vec4 c = cleanTexel(texture2D(tDiffuse, vUv));
  if (bloomOn > 0.5) c.rgb += texture2D(tBloom, vUv).rgb;
  gl_FragColor = vec4(c.rgb, 1.0);
  // esposizione (la stessa curva ACES di prima) e conversione in sRGB, come l'OutputPass di three.js
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
};

/** Ultimo passaggio: pulizia, bagliore, esposizione e colori, direttamente sullo schermo. */
export class FinalPass extends ShaderPass {
  constructor(private bloom: LeanBloomPass) {
    super(FinalShader);
  }

  override render(renderer: WebGLRenderer, writeBuffer: WebGLRenderTarget, readBuffer: WebGLRenderTarget, deltaTime: number, maskActive: boolean): void {
    this.uniforms.tBloom.value = this.bloom.texture;
    this.uniforms.bloomOn.value = this.bloom.enabled ? 1 : 0;
    super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
  }
}
