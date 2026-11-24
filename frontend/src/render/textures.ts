/** Caricamento delle texture (scaricate dal server al primo uso) e loro provenienza. */

import { LinearSRGBColorSpace, SRGBColorSpace, Texture, TextureLoader, WebGLRenderer } from 'three';
import { api, type DsoPhoto, type TextureCredit } from '../data/api';
import { makePhotoMatte, type PhotoMatte } from './photomatte';

export class TextureManager {
  private loader = new TextureLoader();
  private cache = new Map<string, Promise<Texture | null>>();
  private credits: Promise<Record<string, TextureCredit>> | null = null;
  res: '2k' | '8k' = '2k';

  constructor(private renderer: WebGLRenderer) {}

  get maxAnisotropy(): number {
    return this.renderer.capabilities.getMaxAnisotropy();
  }

  /** la scheda video regge le texture da 8192 pixel? */
  get supports8k(): boolean {
    return this.renderer.capabilities.maxTextureSize >= 8192;
  }

  /** chi sta usando la versione grande di ogni texture: quando non serve più a nessuno si libera */
  private hiUsers = new Map<string, number>();

  /**
   * Versione grande (8k) di una texture: occupa fino a 180 MB di memoria video, quindi la si
   * prende solo quando il corpo è grande sullo schermo e la si restituisce con releaseHi.
   */
  acquireHi(name: string): Promise<Texture | null> {
    this.hiUsers.set(name, (this.hiUsers.get(name) ?? 0) + 1);
    return this.get(name, true, '8k');
  }

  releaseHi(name: string): void {
    const n = (this.hiUsers.get(name) ?? 0) - 1;
    if (n > 0) {
      this.hiUsers.set(name, n);
      return;
    }
    this.hiUsers.delete(name);
    const key = `${name}@8k`;
    const p = this.cache.get(key);
    this.cache.delete(key);
    void p?.then((t) => t?.dispose());
  }

  get(name: string, color = true, res: '2k' | '8k' = this.res): Promise<Texture | null> {
    const key = `${name}@${res}`;
    let p = this.cache.get(key);
    if (!p) {
      p = new Promise((resolve) => {
        this.loader.load(
          api.textureUrl(name, res),
          (tex) => {
            tex.colorSpace = color ? SRGBColorSpace : LinearSRGBColorSpace;
            tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
            resolve(tex);
          },
          undefined,
          () => resolve(null),
        );
      });
      this.cache.set(key, p);
    }
    return p;
  }

  private dso: Promise<Record<string, DsoPhoto>> | null = null;
  private photos = new Map<string, Promise<{ tex: Texture; matte: PhotoMatte } | null>>();

  /** Foto del cielo profondo, la sua maschera di sfumatura e la sua scheda (estensione in cielo, crediti). */
  async photo(name: string): Promise<{ tex: Texture; matte: PhotoMatte; info: DsoPhoto } | null> {
    this.dso ??= api.dsoManifest().then((r) => r.objects).catch(() => ({}));
    const info = (await this.dso)[name];
    if (!info) return null;
    let p = this.photos.get(name);
    if (!p) {
      p = new Promise((resolve) => {
        this.loader.load(api.dsoImageUrl(name), (tex) => {
          tex.colorSpace = SRGBColorSpace;
          tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
          // il bordo irregolare ha una forma diversa per ogni foto, ma sempre la stessa per quella foto
          const seed = name.split('').reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
          resolve({ tex, matte: makePhotoMatte(tex.image as HTMLImageElement, seed) });
        }, undefined, () => resolve(null));
      });
      this.photos.set(name, p);
    }
    const r = await p;
    return r ? { ...r, info } : null;
  }

  async photoInfo(name: string): Promise<DsoPhoto | null> {
    this.dso ??= api.dsoManifest().then((r) => r.objects).catch(() => ({}));
    return (await this.dso)[name] ?? null;
  }

  /** Autori, licenza e parametri di resa di una texture (null se sconosciuta). */
  async credit(name: string): Promise<TextureCredit | null> {
    this.credits ??= api.textureCredits().then((r) => r.textures).catch(() => ({}));
    return (await this.credits)[name] ?? null;
  }
}
