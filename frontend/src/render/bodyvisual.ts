/** Rappresentazione 3D di un corpo: sfera/forma irregolare, atmosfera, anelli, nubi, alone, coda. */

import {
  BufferGeometry, Color, Group, Matrix3, Matrix4, Mesh, PerspectiveCamera, PlaneGeometry, Quaternion, RingGeometry,
  DataTexture, LinearFilter, LinearMipmapLinearFilter, RGBAFormat, SRGBColorSpace, UnsignedByteType,
  ShaderMaterial, Vector2, Vector3, type Texture,
} from 'three';
import type { Body } from '../sim/body';
import { M_ICRF_TO_SCENE } from '../core/frames';
import { AU_KM, PC_KM } from '../core/units';
import { poleMatrix } from '../ephem/rotation';
import { irregular, sphere } from './geometry';
import { CometVisual } from './comet';
import { GlobularCluster } from './globular';
import { OpenCluster } from './opencluster';
import {
  atmosphereMaterial, blackHoleMaterial, diskGalaxyMaterial, diskPhotoMaterial, galaxyCoreMaterial, glowMaterial, nebulaMaterial, photoMaterial, planetMaterial,
  ringMaterial, sunMaterial,
} from './shaders';
import { DEEP_KINDS } from '../data/types';
import { crossesGalacticDisk, unitFromRaDec } from '../core/galactic';
import type { TextureManager } from './textures';
import { applyGroundAir, scatterMaterial, updateScatter } from './atmosphere';
import { NebulaCloud } from './nebulacloud';
import { MODELS, SpacecraftModel } from './spacecraft';
import { proceduralSurface } from './procsurface';

/** Dal sistema della sfera di three.js (Y = polo) al sistema IAU (Z = polo, X = meridiano zero). */
const M_STD_FROM_THREE = new Matrix3().set(1, 0, 0, 0, 0, -1, 0, 1, 0);

const _m3 = new Matrix3();
const _m4 = new Matrix4();
const _v = new Vector3();
const _s = new Vector3();
const _r = new Vector3();
const _w = new Vector3();
const _u = new Vector3();
const _q = new Quaternion();
/** il polo nord celeste (asse z dell'ICRF) in coordinate di scena */
const NORTH_SCENE = new Vector3(0, 0, 1).applyMatrix3(M_ICRF_TO_SCENE);

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
const _cands: { body: Body; margin: number }[] = [];

/** Aumenta la saturazione di un colore (k > 1) mantenendo a 1 il canale più forte. */
function saturate(c: Color, k: number): Color {
  const l = (c.r + c.g + c.b) / 3;
  c.setRGB(Math.max(0, l + (c.r - l) * k), Math.max(0, l + (c.g - l) * k), Math.max(0, l + (c.b - l) * k));
  const m = Math.max(c.r, c.g, c.b, 1e-3);
  return c.multiplyScalar(1 / m);
}

/**
 * "Spazio ridotto": un oggetto più lontano di questa distanza dalla camera viene
 * avvicinato e rimpicciolito nella stessa proporzione. Direzione e dimensione
 * apparente restano identiche, ma la GPU non deve mai interpolare coordinate
 * enormi (a migliaia di anni luce alcune schede video, e il rasterizzatore
 * software, producono valori non numerici che rovinano l'immagine).
 * 1e10 km ≈ 67 UA: oltre l'orbita di Plutone, quindi nel Sistema Solare non cambia nulla.
 * Oltre la soglia la distanza viene compressa in modo logaritmico: l'ordine resta lo
 * stesso (una luna dietro il suo pianeta resta dietro anche vista da molto lontano).
 */
const SCALED_SPACE_KM = 1e10;

function scaledDistance(d: number): number {
  return d <= SCALED_SPACE_KM ? d : SCALED_SPACE_KM * (1 + 0.1 * Math.log10(d / SCALED_SPACE_KM));
}

export interface FrameCtx {
  camPos: Vector3;          // posizione della camera (scena, rispetto al baricentro)
  sun: Body;
  camera: PerspectiveCamera;
  pxPerRad: number;         // pixel per radiante al centro dello schermo
  pxScale: number;          // pixel fisici per pixel CSS
  jd: number;
  /** secondi reali dal fotogramma precedente */
  dt?: number;
  /** secondi di tempo simulato dal fotogramma precedente (limitati: servono per le rotazioni) */
  dtSim?: number;
  earth?: Body;
  /** magnitudine limite e saturazione dei colori delle stelle del catalogo (per gli ammassi aperti) */
  starMagLimit?: number;
  starSaturation?: number;
}

/**
 * Una texture del corpo (mappa, luci notturne, nubi, anelli). Da lontano si usa la versione
 * normale (2k); quella grande (8k) solo quando il corpo riempie lo schermo, e poi si libera.
 */
interface TexSlot {
  name: () => string;
  apply: (t: Texture, name: string) => void | Promise<void>;
  /** versione grande in uso (da restituire) */
  held: string | null;
  seq: number;
}

/** raggio a schermo (pixel fisici) oltre il quale la texture a 2k non basta più */
const HI_TEX_PX = 260;

function quatFrom(m: Matrix3, out: Quaternion): Quaternion {
  _m4.setFromMatrix3(m);
  return out.setFromRotationMatrix(_m4);
}

export class BodyVisual {
  readonly group = new Group();
  private mesh: Mesh | null = null;
  private mat: ShaderMaterial | null = null;
  private atmo: Mesh | null = null;
  /** l'atmosfera è quella calcolata con la diffusione della luce (render/atmosphere.ts) */
  private scatter = false;
  private clouds: Mesh | null = null;
  private rings: Mesh | null = null;
  /** sfera fitta (se il corpo ne usa una): si alterna a quella leggera secondo la grandezza a schermo */
  private sphereHi: BufferGeometry | null = null;
  private glow: Mesh | null = null;
  comet: CometVisual | null = null;
  /** oggetti lontani: nebulose, galassie, buchi neri */
  private deep: Mesh | null = null;
  private deepMode: 'billboard' | 'disk' | 'blackhole' | null = null;
  /** galassie a disco: nucleo e disco visto di taglio, sempre rivolti alla camera */
  private core: Mesh | null = null;
  /** Andromeda: assi del disco e del cielo (ICRS) per proiettare la foto sul disco vero */
  private diskAxes: { major: Vector3; second: Vector3; east: Vector3; north: Vector3 } | null = null;
  private photoDisk: Mesh | null = null;
  /** nebulose: la foto "gonfiata" in 3D, da guardare da ogni parte e in cui entrare */
  private cloud: NebulaCloud | null = null;
  private deepActive = false;
  /** foto del cielo profondo (caricata quando l'oggetto diventa visibile) */
  private photo: Mesh | null = null;
  private photoName: string | null = null;
  private photoRequested = false;
  private photoSize = new Vector2();
  /** scostamento del centro della foto (km verso est, km verso nord) */
  private photoOffset = new Vector2();
  /** ammasso globulare stella per stella */
  private globular: GlobularCluster | null = null;
  private globRhKm = 1;
  /** ammasso aperto stella per stella (Pleiadi, Iadi) */
  private openCluster: OpenCluster | null = null;
  /**
   * Stelle: quanto attenuare l'alone (0..1). Con le linee del campo magnetico accese l'alone si
   * abbassa, come il Sole dietro il disco di un coronografo: altrimenti le coprirebbe del tutto.
   */
  glowDim = 0;
  /** raggio apparente in pixel (aggiornato a ogni fotogramma) */
  pxRadius = 0;
  /** per Sagittarius A*: quanto la lente gravitazionale (che disegna anche l'anello) ha preso il posto del quadrato */
  lensFade = 0;
  distance = 0;
  /** texture da caricare solo quando il corpo appare come un disco */
  private lazy: (() => Promise<void>)[] = [];
  /** modello 3D (sonde e satelliti), se la raccolta ne ha uno */
  craft: SpacecraftModel | null = null;
  private craftChecked = false;

  /** mappa mostrata ora (quella normale o, per Venere e Titano, la superficie sotto le nubi) */
  private mapName: string | null = null;
  private texSlots: TexSlot[] = [];
  private mapSlot: TexSlot | null = null;
  /** 0 = nessuna texture caricata, 1 = versione normale, 2 = versione grande */
  private texLevel: 0 | 1 | 2 = 0;
  private smallSince = 0;
  private disposed = false;

  private slot(name: () => string, apply: TexSlot['apply']): TexSlot {
    const s: TexSlot = { name, apply, held: null, seq: 0 };
    this.texSlots.push(s);
    return s;
  }

  private async loadSlot(slot: TexSlot, hi: boolean): Promise<void> {
    const seq = ++slot.seq;
    const name = slot.name();
    const tm = this.textures;
    let useHi = hi && tm.res === '8k' && (await tm.credit(name))?.hi !== false;
    let t = useHi ? await tm.acquireHi(name) : await tm.get(name, true, '2k');
    if (!t && !useHi && tm.res === '8k') {
      // manca la versione normale (per esempio senza rete): si prova quella grande già scaricata
      useHi = true;
      t = await tm.acquireHi(name);
    }
    if (!t || this.disposed || seq !== slot.seq) {
      if (useHi) tm.releaseHi(name);
      return;
    }
    const prev = slot.held;
    slot.held = useHi ? name : null;
    await slot.apply(t, name);
    if (prev) tm.releaseHi(prev);
  }

  /** Sceglie la versione delle texture secondo la grandezza del corpo sullo schermo. */
  private updateTextureLevel(ctx: FrameCtx): void {
    if (this.texLevel === 0) {
      if (this.pxRadius <= 2.5) return;
      this.texLevel = 1;
      for (const s of this.texSlots) void this.loadSlot(s, false);
    }
    if (this.textures.res !== '8k') return;
    const px = this.pxRadius * ctx.pxScale;
    if (this.texLevel === 1) {
      if (px > HI_TEX_PX) {
        this.texLevel = 2;
        this.smallSince = 0;
        for (const s of this.texSlots) void this.loadSlot(s, true);
      }
    } else if (px > HI_TEX_PX * 0.4) {
      this.smallSince = 0;
    } else if (!this.smallSince) {
      this.smallSince = performance.now();
    } else if (performance.now() - this.smallSince > 8000) {
      // il corpo è tornato piccolo da qualche secondo: la versione grande si libera
      this.texLevel = 1;
      this.smallSince = 0;
      for (const s of this.texSlots) if (s.held) void this.loadSlot(s, false);
    }
  }

  /** La stella che illumina il corpo: il Sole, oppure la propria stella per gli esopianeti. */
  private light(ctx: FrameCtx): Body {
    if (!this.body.data.exo) return ctx.sun;
    let p = this.body.parent;
    while (p && p.kind !== 'star') p = p.parent;
    return p ?? ctx.sun;
  }

  /** Libera la memoria video del corpo (per i corpi creati al volo, quando non servono più). */
  dispose(): void {
    this.disposed = true;
    for (const s of this.texSlots) {
      s.seq++;
      if (s.held) this.textures.releaseHi(s.held);
      s.held = null;
    }
    for (const m of [this.mesh, this.atmo, this.clouds, this.glow, this.rings]) (m?.material as ShaderMaterial | undefined)?.dispose();
    this.glow?.geometry.dispose();
    this.rings?.geometry.dispose();
  }

  constructor(readonly body: Body, private textures: TextureManager) {
    const d = body.data;
    // i nuclei cometari sono fra gli oggetti più scuri del Sistema Solare (albedo ~0,04):
    // il colore del catalogo descrive la chioma, il nucleo si disegna grigio scuro
    const color = new Color(body.kind === 'comet' ? '#4a4643' : d.color ?? '#9a9a9a');
    const [ra, rb, rc] = body.radii;
    this.group.name = body.id;

    if (DEEP_KINDS.has(body.kind)) {
      this.buildDeep(body, color);
    } else if (body.kind === 'spacecraft' || body.kind === 'satellite' || body.kind === 'barycenter' || body.radius <= 0) {
      // nessuna sfera: sonde e satelliti sono marcatori, e da vicino il loro modello 3D (se c'è)
    } else if (body.kind === 'star') {
      // le altre stelle: colore dalla temperatura, appena accentuato (così luminoso, a schermo
      // il colore vero di un corpo nero tenderebbe al bianco)
      const hue = body.id === 'naif:10' ? undefined : saturate(color.clone(), 1.3);
      this.mat = sunMaterial(color, hue);
      if (d.texture) {
        this.slot(() => d.texture!, (t) => {
          if (!this.mat) return;
          this.mat.uniforms.map.value = t;
          this.mat.uniforms.hasMap.value = 1;
        });
      }
      this.mesh = new Mesh(sphere(true), this.mat);
      this.sphereHi = this.mesh.geometry as BufferGeometry;
      this.mesh.scale.set(ra, rc, rb);
      this.glow = new Mesh(new PlaneGeometry(2, 2), glowMaterial(hue ? hue.clone().lerp(new Color(1, 1, 1), 0.15) : new Color(1.0, 0.82, 0.55), 1.0));
      this.glow.renderOrder = 2;
      this.group.add(this.mesh, this.glow);
    } else {
      const irregularShape = body.kind === 'asteroid' || body.kind === 'comet' || body.radius < 150;
      const atm = d.atmosphere;
      // con l'atmosfera calcolata (diffusione della luce) bordo e crepuscolo li fa lei
      const sc = d.scatter;
      this.mat = planetMaterial({
        color,
        wrap: !sc && atm && atm.strength > 0.8 ? 0.15 : 0.0,
        rim: atm && !sc ? new Color(atm.color) : undefined,
        rimStrength: atm && !sc ? 0.25 * atm.strength : 0,
        ambient: body.kind === 'comet' ? 0.04 : 0.02,
      });
      const geo = irregularShape ? irregular(body.id, !d.texture) : sphere(body.kind === 'planet' || body.radius > 1000);
      if (!irregularShape && geo === sphere(true)) this.sphereHi = geo;
      this.mesh = new Mesh(geo, this.mat);
      this.mesh.scale.set(ra, rc, rb);
      this.group.add(this.mesh);

      if (d.texture) this.mapSlot = this.slot(() => this.mapName ?? d.texture!, (t, name) => this.applyMapTexture(t, name));
      else if (!irregularShape) {
        // nessuna sonda l'ha mai fotografato: una superficie indicativa, invece di un colore piatto
        const style = d.surface ?? (body.kind === 'dwarf' ? (/^#[c-f]/i.test(d.color ?? '') && !/sedna|makemake/i.test(body.name) ? 'ghiaccio' : 'tholin') : 'roccia');
        this.lazy.push(async () => {
          const t = proceduralSurface(body.id, d.color ?? '#9a9a9a', style, body.kind === 'dwarf' || d.surface === 'gas' ? 1024 : 512);
          t.anisotropy = textures.maxAnisotropy;
          if (!this.mat) return;
          this.mat.uniforms.map.value = t;
          this.mat.uniforms.hasMap.value = 1;
          (this.mat.uniforms.mapTint.value as Vector3).set(1, 1, 1);
        });
      }
      if (d.night_texture) {
        this.slot(() => d.night_texture!, (t) => {
          if (!this.mat) return;
          this.mat.uniforms.nightMap.value = t;
          this.mat.uniforms.hasNight.value = 1;
        });
      }
      if (d.clouds_texture) {
        const cm = planetMaterial({ color: new Color(1, 1, 1), clouds: true });
        if (sc) applyGroundAir(cm, sc, body.radius);
        this.clouds = new Mesh(sphere(true), cm);
        this.clouds.scale.set(ra * 1.006, rc * 1.006, rb * 1.006);
        this.clouds.visible = false;
        this.group.add(this.clouds);
        this.slot(() => d.clouds_texture!, (t) => {
          if (!this.clouds) return;
          cm.uniforms.map.value = t;
          cm.uniforms.hasMap.value = 1;
          this.clouds.visible = true;
        });
      }
      if (sc) {
        this.scatter = true;
        applyGroundAir(this.mat, sc, body.radius);
        this.atmo = new Mesh(sphere(true), scatterMaterial(sc, body.radius));
        // un po' più grande del guscio: la sfera a poligoni deve contenerlo tutto
        this.atmo.scale.setScalar(body.radius * (1 + sc.top_km / body.radius) * 1.02);
        this.atmo.renderOrder = 3;
        this.group.add(this.atmo);
      } else if (atm) {
        this.atmo = new Mesh(sphere(true), atmosphereMaterial(new Color(atm.color), atm.strength));
        this.atmo.scale.set(ra * atm.scale, rc * atm.scale, rb * atm.scale);
        this.group.add(this.atmo);
      }
      if (d.rings) {
        const rm = ringMaterial(d.rings.inner_km, d.rings.outer_km, new Color(d.rings.color ?? '#d8c8a0'));
        this.rings = new Mesh(new RingGeometry(d.rings.inner_km, d.rings.outer_km, 256, 1), rm);
        this.rings.renderOrder = 1;
        this.group.add(this.rings);
        if (d.rings.bands) {
          rm.uniforms.map.value = ringBandTexture(d.rings.inner_km, d.rings.outer_km, d.rings.bands, new Color(d.rings.color ?? '#9aa0a8'));
          rm.uniforms.hasMap.value = 1;
        }
        if (d.rings.texture) {
          this.slot(() => d.rings!.texture!, (t) => {
            rm.uniforms.map.value = t;
            rm.uniforms.hasMap.value = 1;
          });
        }
      }
      if (body.kind === 'comet') {
        this.comet = new CometVisual(body);
        this.group.add(this.comet.group);
      }
    }
  }

  /**
   * Applica una mappa della superficie. Per le mappe incluse nel progetto si usano anche:
   * il "guadagno" (i corpi scurissimi come Fobos vengono schiariti, come in una foto con
   * esposizione lunga) e, per le mappe in bianco e nero, il colore medio del catalogo.
   */
  private applyMap(name: string): void {
    this.mapName = name;
    // se le texture non sono ancora state chieste (corpo lontano), ci penserà il primo caricamento
    if (this.mapSlot && this.texLevel > 0) void this.loadSlot(this.mapSlot, this.texLevel === 2);
  }

  private async applyMapTexture(t: Texture, name: string): Promise<void> {
    const credit = await this.textures.credit(name);
    if (!this.mat || (this.mapName ?? this.body.data.texture) !== name) return;
    const u = this.mat.uniforms;
    u.map.value = t;
    u.hasMap.value = 1;
    const tint = (u.mapTint.value as Vector3).set(1, 1, 1);
    if (credit?.grigia && this.body.data.color) {
      const c = new Color(this.body.data.color); // spazio lineare
      const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
      if (lum > 1e-4) {
        // si conserva la luminosità della mappa e si prende solo la tinta (un po' attenuata)
        const k = 0.5;
        tint.set(1 + (c.r / lum - 1) * k, 1 + (c.g / lum - 1) * k, 1 + (c.b / lum - 1) * k);
      }
    }
    tint.multiplyScalar(credit?.gain ?? 1);
  }

  /**
   * Ombre ed eclissi: si cercano i corpi che in questo momento possono stare fra questo
   * corpo e il Sole (il pianeta attorno a cui gira, le altre lune dello stesso pianeta,
   * le proprie lune) e si passano allo shader, che calcola ombra e penombra punto per punto.
   * Tutto in unità della scena relative al centro del corpo (precisione piena anche da lontano).
   */
  private updateShadows(ctx: FrameCtx, shrink: number): void {
    const b = this.body;
    const sun = this.light(ctx);
    const toSun = _s.subVectors(sun.scenePos, b.scenePos);
    const dS = toSun.length();
    if (dS === 0) return;
    toSun.divideScalar(dS);
    const bR = Math.max(...b.radii);
    const sunSpread = sun.radius / dS; // la penombra si allarga di tanto per ogni km
    _cands.length = 0;
    const consider = (c: Body) => {
      if (c === b || !c.valid || c.radius <= 0 || c.kind === 'star' || c.kind === 'barycenter') return;
      const rel = _r.subVectors(c.scenePos, b.scenePos);
      const along = rel.dot(toSun);
      if (along <= 0) return; // dalla parte opposta al Sole
      const perp = Math.sqrt(Math.max(rel.lengthSq() - along * along, 0));
      const reach = bR + c.radius + along * sunSpread;
      if (perp < reach) _cands.push({ body: c, margin: perp - reach });
    };
    const p = b.parent;
    if (p && p.kind !== 'star' && p.kind !== 'barycenter') {
      consider(p);
      for (const s of p.children) consider(s);
    }
    for (const c of b.children) consider(c);
    _cands.sort((x, y) => x.margin - y.margin);
    const n = Math.min(4, _cands.length);

    const mats = this.clouds ? [this.mat!, this.clouds.material as ShaderMaterial] : [this.mat!];
    for (const m of mats) {
      const u = m.uniforms;
      u.sunRel.value.copy(toSun).multiplyScalar(dS * shrink);
      u.sunRadius.value = sun.radius * shrink;
      u.occCount.value = n;
      for (let i = 0; i < n; i++) {
        const c = _cands[i].body;
        (u.occRel.value as Vector3[])[i].subVectors(c.scenePos, b.scenePos).multiplyScalar(shrink);
        (u.occRadius.value as number[])[i] = c.radius * shrink;
        // solo la Terra: la sua atmosfera piega nell'ombra la luce rossa dei tramonti
        (u.occAtmo.value as number[])[i] = c.id === 'naif:399' ? 1 : 0;
      }
      if (this.rings) {
        const ru = (this.rings.material as ShaderMaterial).uniforms;
        u.hasRing.value = 1;
        u.ringNormalW.value.copy(ru.ringNormal.value);
        u.ringInner.value = (b.data.rings?.inner_km ?? 0) * shrink;
        u.ringOuter.value = (b.data.rings?.outer_km ?? 1) * shrink;
        u.ringMap.value = ru.map.value;
        u.hasRingMap.value = ru.hasMap.value;
      }
    }
  }

  /** Venere e Titano: mostra la superficie sotto le nubi (true) o l'aspetto normale (false). */
  showSurface(on: boolean): void {
    const d = this.body.data;
    if (!d.texture_alt || !this.mat) return;
    this.applyMap(on ? d.texture_alt : d.texture!);
    // senza nubi anche l'alone dell'atmosfera e il terminatore morbido distraggono
    if (this.atmo) this.atmo.userData.hidden = on;
    // e la luce del Sole arriva piena: la foschia (densissima su Titano) non la attenua più
    if (this.scatter && this.mat.uniforms.atmoOn) this.mat.uniforms.atmoOn.value = on ? 0 : 1;
    this.mat.uniforms.wrap.value = on || d.scatter ? 0 : (d.atmosphere && d.atmosphere.strength > 0.8 ? 0.15 : 0);
  }

  private buildDeep(body: Body, color: Color): void {
    const seed = (body.id.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 97) * 0.37;
    this.deepActive = true;
    if (body.kind === 'blackhole') {
      this.deep = new Mesh(new PlaneGeometry(2, 2), blackHoleMaterial(10));
      this.deepMode = 'blackhole';
    } else if (body.id === 'dso:m31') {
      // disco orientato come lo vediamo dalla Terra: inclinazione 77°, angolo di posizione 38°
      this.deep = new Mesh(new PlaneGeometry(2, 2), diskGalaxyMaterial(color));
      this.deepMode = 'disk';
      const f = body.data.fixed!;
      const s = unitFromRaDec(f.ra_deg!, f.dec_deg!);
      const north = new Vector3(0, 0, 1).addScaledVector(s, -s.z).normalize();
      const east = new Vector3().crossVectors(north, s);
      const pa = 38 * Math.PI / 180, inc = 77 * Math.PI / 180;
      const major = north.clone().multiplyScalar(Math.cos(pa)).addScaledVector(east, Math.sin(pa));
      const minor = north.clone().multiplyScalar(-Math.sin(pa)).addScaledVector(east, Math.cos(pa));
      const normal = s.clone().multiplyScalar(-Math.cos(inc)).addScaledVector(minor, Math.sin(inc)).normalize();
      const second = new Vector3().crossVectors(normal, major);
      this.diskAxes = { major: major.clone(), second: second.clone(), east: east.clone(), north: north.clone() };
      // assi ICRS -> scena
      for (const v of [major, second, normal]) v.applyMatrix3(M_ICRF_TO_SCENE);
      this.deep.quaternion.setFromRotationMatrix(new Matrix4().makeBasis(major, second, normal));
      this.core = new Mesh(new PlaneGeometry(2, 2), galaxyCoreMaterial(color));
      this.core.renderOrder = 2;
      this.group.add(this.core);
    } else if (body.kind === 'nebula' || body.kind === 'galaxy') {
      if (body.id === 'gal:mw') return; // la Via Lattea è il modello a particelle
      this.deep = new Mesh(new PlaneGeometry(2, 2), nebulaMaterial(color, seed));
      this.deepMode = 'billboard';
    }
    if (this.deep) {
      this.deep.renderOrder = 2;
      this.group.add(this.deep);
    }
    const d = body.data;
    if (d.photo) this.photoName = d.photo;
    if (d.globular) {
      // per Sagittarius A*: l'ammasso stellare nucleare (stelle più giovani e più arrossate dalla polvere)
      this.globular = new GlobularCluster(d.globular.rh_pc, d.globular.stars, Math.round(seed * 1000) + 7,
        body.kind === 'blackhole' ? 'nucleare' : 'antico');
      this.globRhKm = d.globular.rh_pc * PC_KM;
      this.group.add(this.globular.points);
    }
    if (d.open_cluster) {
      this.openCluster = new OpenCluster(d.open_cluster, Math.round(seed * 1000) + 3);
      this.group.add(this.openCluster.points);
    }
  }

  /**
   * Foto dell'oggetto (nebulose, ammassi, galassie): un rettangolo grande quanto la foto
   * alla distanza dell'oggetto, quindi dalla Terra coincide con il cielo vero.
   */
  private async loadPhoto(sunDistKm: number): Promise<void> {
    this.photoRequested = true;
    const r = await this.textures.photo(this.photoName!);
    if (!r) return;
    const w = 2 * sunDistKm * Math.tan((r.info.width_deg * Math.PI) / 360);
    const h = 2 * sunDistKm * Math.tan((r.info.height_deg * Math.PI) / 360);
    const off = r.info.offset_deg ?? [0, 0];
    this.photoOffset.set(sunDistKm * Math.tan((off[0] * Math.PI) / 180), sunDistKm * Math.tan((off[1] * Math.PI) / 180));
    const m = new Mesh(new PlaneGeometry(1, 1), photoMaterial(r.tex, r.matte.tex));
    m.renderOrder = 2;
    m.frustumCulled = false;
    m.visible = false;
    this.photoSize.set(w, h);
    this.photo = m;
    this.group.add(m);
    const fx = this.body.data.fixed;
    // nebulose, e galassie con la geometria del disco nel catalogo (Nubi di Magellano): nuvola 3D
    const cs = this.body.data.cloud;
    if ((this.body.kind === 'nebula' || cs) && fx?.ra_deg !== undefined && fx.dec_deg !== undefined) {
      const s = unitFromRaDec(fx.ra_deg, fx.dec_deg);
      const north = new Vector3(0, 0, 1).addScaledVector(s, -s.z).normalize();
      const east = new Vector3().crossVectors(north, s);
      for (const v of [s, north, east]) v.applyMatrix3(M_ICRF_TO_SCENE);
      const seed = this.body.id.split('').reduce((a, c) => a * 31 + c.charCodeAt(0), 7) >>> 0;
      const D = Math.PI / 180;
      const disk = cs ? { incl: cs.incl_deg * D, nodesPa: cs.nodes_pa_deg * D, thick: cs.thick_kpc * 1000 * PC_KM } : undefined;
      // oggetti in primo piano nella foto: posizione sul piano tangente al cielo, in km alla distanza dell'oggetto
      const mask = cs?.mask?.map(([ra, dec, rDeg]) => {
        const [xi, eta] = tangentPlane(fx.ra_deg!, fx.dec_deg!, ra, dec);
        return { e: xi * sunDistKm, n: eta * sunDistKm, r: Math.tan(rDeg * D) * sunDistKm };
      });
      this.cloud = new NebulaCloud(r.matte, { east, north, los: s, w, h, offE: this.photoOffset.x, offN: this.photoOffset.y, disk, mask, grain: cs ? 1 / 400 : undefined },
        seed, cs ? 16000 : 12000);
      this.group.add(this.cloud.points);
    }
    if (this.diskAxes && this.deep) {
      // stessa foto sul disco della galassia: un punto del disco (x, y in raggi) visto dalla Terra
      // cade a est/nord di (P·est, P·nord) dal centro; da lì le coordinate nella foto
      // (est a sinistra, nord in alto, centro della foto spostato di "offset")
      const { major, second, east, north } = this.diskAxes;
      const R = this.body.radius;
      const ox = this.photoOffset.x, oy = this.photoOffset.y;
      const A: [number, number, number, number] = [
        (-R * major.dot(east)) / w, (-R * second.dot(east)) / w,
        (R * major.dot(north)) / h, (R * second.dot(north)) / h,
      ];
      const C: [number, number] = [0.5 + ox / w, 0.5 - oy / h];
      const pd = new Mesh(new PlaneGeometry(2, 2), diskPhotoMaterial(r.tex, r.matte.tex, A, C));
      pd.renderOrder = 2;
      pd.frustumCulled = false;
      pd.visible = false;
      pd.quaternion.copy(this.deep.quaternion);
      this.photoDisk = pd;
      this.group.add(pd);
    }
  }

  /**
   * Angolo sullo schermo (radianti da +x verso +y) del "lato luminoso" dell'anello di Sagittarius A*
   * visto da lontano: è il lato dove il gas, girando, viene verso la camera (lo calcola la vista
   * dall'asse di rotazione del gas). Nel quadrato l'angolo è misurato nel sistema della camera.
   */
  setBlackHolePhase(phase: number): void {
    const d = this.deep;
    // (nello shader il massimo dell'effetto Doppler è 0,7 radianti dopo "phase")
    if (d && this.deepMode === 'blackhole') (d.material as ShaderMaterial).uniforms.phase.value = phase - 0.7;
  }

  private updateDeep(ctx: FrameCtx): void {
    const b = this.body;
    const d = this.deep;
    if (d && this.deepMode === 'blackhole') {
      // il quadrato copre 10 raggi di Schwarzschild; sotto il pixel non si vede nulla
      const half = b.radius * 10;
      d.scale.setScalar(half);
      d.quaternion.copy(ctx.camera.quaternion);
      const rsPx = (b.radius / Math.max(this.distance, 1)) * ctx.pxPerRad;
      d.visible = rsPx * 10 > 1.5 && this.lensFade < 0.999;
      const bm = d.material as ShaderMaterial;
      // da lontano l'immagine dei radiotelescopi (sfocata); da vicino quella nitida
      bm.uniforms.sharp.value = smooth(6, 30, rsPx);
      bm.uniforms.intensity.value = 1 - this.lensFade;
      // l'ammasso stellare nucleare attorno: milioni di stelle in pochi parsec. Da lontano non si
      // vede: fra noi e il centro della Galassia c'è tanta polvere da spegnerne la luce visibile
      // di circa 30 magnitudini (senza questo, da casa nostra sarebbe un bagliore come un sole)
      if (this.globular) {
        const pc = this.distance / PC_KM;
        this.globular.update(ctx.pxPerRad, ctx.pxScale, 1 - smooth(150, 450, pc), (this.globRhKm / Math.max(this.distance, 1)) * ctx.pxPerRad,
          1 - smooth(1.5, 4, this.distance / this.globRhKm));
      }
      return;
    }
    // da dove lo guardiamo: dalla direzione del Sole (cioè come dalla Terra) o da un'altra parte?
    const camDir = _v.copy(this.group.position).normalize();
    const sunDir = _s.subVectors(b.scenePos, ctx.sun.scenePos);
    const sunDist = sunDir.length();
    if (sunDist > 0) sunDir.divideScalar(sunDist);
    const align = camDir.dot(sunDir);
    const wAngle = smooth(0.93, 0.985, align); // pieno entro ~10°, sparisce oltre ~22°

    if (this.photoName && !this.photoRequested && this.pxRadius > 0.3) void this.loadPhoto(sunDist);
    // ammassi aperti: dalla direzione della Terra (e da lontano) valgono la foto e le stelle vere del
    // catalogo; girandoci attorno o entrandoci, il modello stella per stella
    const wEarth = this.openCluster ? wAngle * smooth(4, 12, this.distance / (this.openCluster.rhPc * PC_KM)) : wAngle;
    if (this.openCluster) {
      this.openCluster.update(ctx.pxScale, 1 - wEarth, ctx.starMagLimit ?? 6.8, ctx.starSaturation ?? 1.35);
    }
    let wPhoto = 0;
    if (this.photo) {
      // la foto è "come dalla Terra": per galassie a disco e ammassi, da altre direzioni si vede il modello 3D
      if (this.globular) wPhoto = wAngle * smooth(5, 15, this.distance / this.globRhKm);
      else if (this.openCluster) wPhoto = wEarth;
      else if (this.deepMode === 'disk' || b.kind === 'cluster' || this.cloud) wPhoto = wAngle;
      else wPhoto = 1;
      const half = Math.max(this.photoSize.x, this.photoSize.y) / 2;
      const px = (half / Math.max(this.distance, 1)) * ctx.pxPerRad;
      const minPx = 4;
      const grow = px < minPx ? minPx / Math.max(px, 1e-9) : 1;
      const flux = px < minPx ? (px / minPx) ** 2 : 1;
      // da vicino una foto piatta non ha senso: dentro l'oggetto sparisce
      const inside = smooth(0.35, 1.0, this.distance / half);
      const I = 0.95 * wPhoto * flux * inside;
      // la nube 3D prende il posto della foto fuori dalla direzione della Terra e da vicino
      if (this.cloud) {
        this.cloud.update(ctx.pxPerRad, ctx.pxScale, 0.95 * (1 - wPhoto * inside));
        // le galassie vicine dietro il disco della Via Lattea vengono oscurate dalle sue polveri:
        // si disegnano prima di esse (vale anche per la foto)
        if (b.kind === 'galaxy') {
          const behind = crossesGalacticDisk(ctx.camPos, b.scenePos, ctx.sun.scenePos);
          this.cloud.setBehindGalaxy(behind);
          this.photo.renderOrder = behind ? -21 : 2;
        }
      }
      const pm = this.photo.material as ShaderMaterial;
      pm.uniforms.intensity.value = I;
      this.photo.visible = I > 0.002;
      if (this.photo.visible) {
        this.photo.scale.set(this.photoSize.x * grow, this.photoSize.y * grow, 1);
        // rivolta verso la camera, con il nord celeste in alto (l'est a sinistra, come in cielo)
        const z = _r.copy(camDir).negate();
        const y = _w.copy(NORTH_SCENE).addScaledVector(z, -NORTH_SCENE.dot(z));
        if (y.lengthSq() < 1e-8) y.set(0, 1, 0).applyQuaternion(ctx.camera.quaternion);
        y.normalize();
        const x = _u.crossVectors(y, z);
        this.photo.quaternion.setFromRotationMatrix(_m4.makeBasis(x, y, z));
        // l'est è a sinistra (verso -x), il nord in alto (+y)
        this.photo.position.copy(x).multiplyScalar(-this.photoOffset.x * grow).addScaledVector(y, this.photoOffset.y * grow);
      }
    }

    if (d) {
      const mat = d.material as ShaderMaterial;
      const R = b.radius;
      const px = (R / Math.max(this.distance, 1)) * ctx.pxPerRad;
      // da molto lontano resta una macchiolina di qualche pixel, con la stessa luce totale
      const minPx = 3;
      const scale = px < minPx ? (minPx / ctx.pxPerRad) * this.distance : R;
      const flux = px < minPx ? (px / minPx) ** 2 : 1;
      // dentro la nube la luce si diluisce
      const inside = Math.min(1, Math.max(0.05, this.distance / R));
      const base = b.kind === 'galaxy' ? 0.28 : 0.55;
      // con la foto caricata, il modello disegnato resta solo dove la foto non vale.
      // Andromeda: fuori dalla direzione della Terra la foto passa sul disco vero (photoDisk), finché
      // il disco non si vede troppo di faccia (lì la foto, presa a 77°, sarebbe stirata 4 volte)
      let wDisk = 0, cDisk = 1;
      if (this.photoDisk && this.deepMode === 'disk') {
        const nrm0 = _w.set(0, 0, 1).applyQuaternion(d.quaternion);
        cDisk = Math.abs(nrm0.dot(camDir));
        wDisk = 1 - smooth(0.5, 0.82, cDisk);
      }
      const model = this.cloud ? 0 : this.photo ? (1 - wPhoto) * (1 - wDisk) : 1;
      mat.uniforms.intensity.value = base * flux * inside * model;
      d.scale.setScalar(scale);
      if (this.deepMode === 'billboard') d.quaternion.copy(ctx.camera.quaternion);
      d.visible = flux * model > 0.002;
      if (this.core) {
        // inclinazione del disco rispetto alla linea di vista
        const nrm = _w.set(0, 0, 1).applyQuaternion(d.quaternion);
        const c = Math.abs(nrm.dot(camDir));
        // il disco piatto: luce per pixel inversamente proporzionale alla sua area apparente
        // (luce totale costante), poi sfuma vicino al taglio dove lo sostituisce la striscia
        const edge = 1 - smooth(0.1, 0.3, c);
        mat.uniforms.face.value = (1 - edge) / Math.max(c, 0.1);
        const cm = this.core.material as ShaderMaterial;
        // il nucleo sferico resta in parte anche sotto la foto sul disco (la foto lo schiaccia)
        cm.uniforms.intensity.value = base * flux * inside * (this.photo ? (1 - wPhoto) * (1 - 0.6 * wDisk) : 1);
        cm.uniforms.cosI.value = c;
        cm.uniforms.edge.value = edge;
        // asse maggiore apparente: perpendicolare alla proiezione della normale sullo schermo
        const nv = nrm.applyQuaternion(_q.copy(ctx.camera.quaternion).invert());
        const len = Math.hypot(nv.x, nv.y);
        (cm.uniforms.axis.value as Vector2).set(len > 1e-6 ? -nv.y / len : 1, len > 1e-6 ? nv.x / len : 0);
        this.core.scale.setScalar(scale);
        this.core.quaternion.copy(ctx.camera.quaternion);
        this.core.visible = d.visible || (this.photo !== null && flux > 0.002);
      }
      if (this.photoDisk) {
        // disco sottile che emette luce: visto più di taglio si concentra (fino a 3 volte); dalla
        // Terra (cos 77° = 0,225) vale come la foto, così il passaggio dalla foto piatta è invisibile
        const gain = Math.min(0.225 / Math.max(cDisk, 0.05), 3);
        const Ip = 0.95 * flux * Math.min(1, this.distance / (0.35 * R)) * gain * wDisk * (1 - wPhoto);
        (this.photoDisk.material as ShaderMaterial).uniforms.intensity.value = Ip;
        this.photoDisk.scale.setScalar(scale);
        this.photoDisk.visible = Ip > 0.002;
      }
    }
    if (this.globular) {
      this.globular.update(ctx.pxPerRad, ctx.pxScale, this.photo ? 1 - wPhoto : 1,
        (this.globRhKm / Math.max(this.distance, 1)) * ctx.pxPerRad, 1 - smooth(1.5, 4, this.distance / this.globRhKm));
    }
  }

  update(ctx: FrameCtx): void {
    const b = this.body;
    this.group.visible = b.valid;
    if (!b.valid) return;
    this.group.position.subVectors(b.scenePos, ctx.camPos);
    this.distance = this.group.position.length();
    this.pxRadius = this.distance > 0 ? (b.radius / this.distance) * ctx.pxPerRad : 0;
    const shrink = this.distance > SCALED_SPACE_KM ? scaledDistance(this.distance) / this.distance : 1;
    this.group.position.multiplyScalar(shrink);
    this.group.scale.setScalar(shrink);
    if (this.deepActive) {
      this.updateDeep(ctx);
      return;
    }
    if (b.kind === 'spacecraft' || b.kind === 'satellite') {
      if (!this.craftChecked && MODELS.ready) {
        this.craftChecked = true;
        const spec = MODELS.attach(b);
        if (spec) {
          this.craft = new SpacecraftModel(b, b.extra.modelKey as string, spec);
          this.group.add(this.craft.group);
        }
      }
      if (this.craft && ctx.earth) {
        this.craft.update({ sun: ctx.sun, earth: ctx.earth, jd: ctx.jd, dtSim: ctx.dtSim ?? 0, dt: ctx.dt ?? 1 / 60 },
          this.distance, ctx.pxPerRad);
      }
      return;
    }
    if (this.texSlots.length) this.updateTextureLevel(ctx);
    if (this.lazy.length && this.pxRadius > 2.5) {
      for (const load of this.lazy) void load();
      this.lazy = [];
    }

    // direzione del Sole vista dal corpo (in coordinate di scena)
    const sunDir = _v.subVectors(this.light(ctx).scenePos, b.scenePos);
    if (sunDir.lengthSq() === 0) sunDir.set(1, 0, 0);
    sunDir.normalize();

    if (this.mesh) {
      // sotto mezzo pixel una stella è solo il suo alone (prima ogni stella, anche le stelle S
      // lontanissime, disegnava comunque una sfera da 24.000 triangoli)
      const tiny = this.pxRadius < (b.kind === 'star' ? 0.5 : 0.2);
      this.mesh.visible = !tiny;
      // livello di dettaglio: la sfera fitta solo quando il corpo è grande sullo schermo
      if (this.sphereHi && !tiny) {
        const want = this.pxRadius > 40 ? this.sphereHi : sphere(false);
        if (this.mesh.geometry !== want) {
          this.mesh.geometry = want;
          if (this.clouds) this.clouds.geometry = want;
          if (this.atmo) this.atmo.geometry = want;
        }
      }
      _m3.copy(M_ICRF_TO_SCENE).multiply(b.orient).multiply(M_STD_FROM_THREE);
      quatFrom(_m3, this.mesh.quaternion);
      if (this.mat?.uniforms.sunDir) this.mat.uniforms.sunDir.value.copy(sunDir);
      if (this.clouds) {
        this.clouds.visible = !tiny && (this.clouds.material as ShaderMaterial).uniforms.hasMap.value > 0;
        this.clouds.quaternion.copy(this.mesh.quaternion);
        (this.clouds.material as ShaderMaterial).uniforms.sunDir.value.copy(sunDir);
      }
      if (this.atmo) {
        this.atmo.visible = !tiny && this.pxRadius > 2 && !this.atmo.userData.hidden;
        this.atmo.quaternion.copy(this.mesh.quaternion);
        if (this.scatter) updateScatter(this.atmo.material as ShaderMaterial, this.group.position, b.radius * shrink, sunDir);
        else (this.atmo.material as ShaderMaterial).uniforms.sunDir.value.copy(sunDir);
      }
    }
    if (this.rings) {
      this.rings.visible = this.pxRadius > 0.3;
      _m3.copy(M_ICRF_TO_SCENE).multiply(poleMatrix(b.data.rotation, ctx.jd));
      quatFrom(_m3, this.rings.quaternion);
      const u = (this.rings.material as ShaderMaterial).uniforms;
      u.sunDir.value.copy(sunDir);
      u.planetCenter.value.copy(this.group.position);
      u.planetRadius.value = b.radius * shrink;
      u.ringNormal.value.set(0, 0, 1).applyQuaternion(this.rings.quaternion);
    }
    if (this.mat && this.mesh?.visible && b.kind !== 'star') this.updateShadows(ctx, shrink);
    if (this.glow) {
      // alone del Sole: almeno qualche decina di pixel, così resta visibile da lontano
      const au = this.distance / AU_KM;
      const minPx = au < 5 ? 36 : Math.max(5, 36 - Math.log10(au / 5) * 7);
      const radius = Math.max(b.radius * 5, (minPx / ctx.pxPerRad) * this.distance);
      this.glow.scale.setScalar(radius);
      this.glow.quaternion.copy(ctx.camera.quaternion);
      const gm = this.glow.material as ShaderMaterial;
      gm.uniforms.core.value = Math.min(0.5, b.radius / radius);
      // fuori dal Sistema Solare una stella si affievolisce come tutte le altre:
      // magnitudine apparente m = M + 5 log10(d / 10 pc); da qualche parsec in poi è un puntino
      const dPc = this.distance / PC_KM;
      const absMag = (b.extra.absmag as number | undefined) ?? b.data.absmag ?? 4.83;
      const m = absMag + 5 * Math.log10(Math.max(dPc, 1e-9) / 10);
      const fade = Math.min(1, Math.pow(10, -0.4 * (m + 0.5)));
      // le altre stelle: luce meno "bruciata", così da vicino se ne vede il colore
      // (una gigante rossa resta rossa, non diventa un bagliore bianco)
      const other = b.id !== 'naif:10';
      const near = other ? Math.min(1, Math.max(0.2, 30 / Math.max(this.pxRadius, 1))) : 1;
      gm.uniforms.intensity.value = fade * (other ? 0.6 * near : 1) * (1 - 0.97 * Math.min(1, 1.6 * this.glowDim));
      this.glow.visible = fade > 0.003;
      // con il campo magnetico acceso anche il disco si abbassa: senza il suo bagliore
      // (che coprirebbe gli archi vicini alla superficie) si vede la granulazione
      if (this.mat?.uniforms.intensity) this.mat.uniforms.intensity.value = (other ? 0.5 : 2.4) * Math.max(fade, 0.02) * (1 - 0.66 * Math.min(1, 1.6 * this.glowDim));
    }
    if (this.comet) this.comet.update(ctx, this.group.position, this.distance);
  }
}

/**
 * Anelli sottili (Urano, Giove, Nettuno): una striscia di 2048 punti dal bordo interno a quello
 * esterno, trasparente dove non c'è nulla. Gli anelli più stretti di un paio di punti vengono
 * allargati a quella misura, altrimenti da lontano sparirebbero.
 */
function ringBandTexture(inner: number, outer: number, bands: [number, number, number][], color: Color): DataTexture {
  const N = 2048;
  const data = new Uint8Array(N * 4);
  const step = (outer - inner) / N;
  // la texture è in sRGB: il colore (lineare) va riconvertito
  const c = color.clone().convertLinearToSRGB();
  for (let i = 0; i < N; i++) {
    const r = inner + (i + 0.5) * step;
    let a = 0;
    for (const [center, width, op] of bands) {
      const half = Math.max(width / 2, step);
      const edge = Math.min(half * 0.5, 2 * step) + 1e-6;
      const t = Math.min(1, Math.max(0, (half - Math.abs(r - center)) / edge));
      a = Math.max(a, op * t * t * (3 - 2 * t));
    }
    data[i * 4] = Math.round(c.r * 255);
    data[i * 4 + 1] = Math.round(c.g * 255);
    data[i * 4 + 2] = Math.round(c.b * 255);
    data[i * 4 + 3] = Math.round(Math.min(1, a) * 255);
  }
  const t = new DataTexture(data, N, 1, RGBAFormat, UnsignedByteType);
  t.colorSpace = SRGBColorSpace;
  t.magFilter = LinearFilter;
  t.minFilter = LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/** Coordinate sul piano tangente al cielo (radianti, ξ verso est, η verso nord) di (ra, dec) attorno a (ra0, dec0). */
function tangentPlane(ra0: number, dec0: number, ra: number, dec: number): [number, number] {
  const D = Math.PI / 180;
  const a = (ra - ra0) * D, d = dec * D, d0 = dec0 * D;
  const den = Math.sin(d) * Math.sin(d0) + Math.cos(d) * Math.cos(d0) * Math.cos(a);
  return [(Math.cos(d) * Math.sin(a)) / den, (Math.sin(d) * Math.cos(d0) - Math.cos(d) * Math.sin(d0) * Math.cos(a)) / den];
}
