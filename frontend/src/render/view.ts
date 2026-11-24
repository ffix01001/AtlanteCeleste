/** Motore grafico: renderer, scena, livelli, selezione col mouse. */

import { t } from '../core/i18n';
import {
  ACESFilmicToneMapping, Color, CubeCamera, HalfFloatType, LinearFilter, LinearMipmapLinearFilter, type Object3D, PerspectiveCamera,
  Quaternion, Scene, SRGBColorSpace, Vector2, Vector3, WebGLCubeRenderTarget, WebGLRenderer, WebGLRenderTarget,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { BlackHolePass } from './blackhole';
import { HOTSPOT_R, flareAt, hotspotPeriod } from '../core/blackhole';
import { skyPlaneNormal } from '../ephem/skyorbit';
import { M_ICRF_TO_SCENE } from '../core/frames';
import { FinalPass, LeanBloomPass } from './postfx';
import type { Body } from '../sim/body';
import type { Universe } from '../sim/universe';
import { AU_KM, PC_KM } from '../core/units';
import { DEEP_KINDS } from '../data/types';
import { GalaxyLayer, GalaxySky, type GalaxyParams } from './galaxy';
import { BodyVisual, type FrameCtx } from './bodyvisual';
import { CameraRig } from './camera';
import { LabelLayer } from './labels';
import { OrbitLine, TrailLine } from './orbits';
import { LINE_SHARED, ThickLine } from './lines';
import { AxisGizmo } from './axis';
import { ObserverMarker } from './observer';
import { GroundView } from './groundview';
import { ConstellationLayer } from './constellations';
import { RegionLayer } from './regions';
import { SurfacePlaces } from './places';
import { MagnetosphereLayer } from './magnetosphere';
import { ProceduralStars } from './procstars';
import type { Place } from '../core/places';
import { SatelliteLayer } from './satellites';
import { SmallBodySet } from './smallbodies';
import { StarLayer } from './stars';
import { TextureManager } from './textures';
import { CraftLighting, MODELS, type SpacecraftModel } from './spacecraft';

export interface Layers {
  planets: boolean;
  dwarfs: boolean;
  moons: boolean;
  comets: boolean;
  asteroids: boolean;
  spacecraft: boolean;
  orbits: boolean;
  trails: boolean;
  labels: boolean;
  stars: boolean;
  satellites: boolean;
  sb_comete: boolean;
  sb_neo: boolean;
  sb_principali: boolean;
  sb_tno: boolean;
  /** modello della Via Lattea */
  galaxy: boolean;
  /** nebulose, ammassi, galassie vicine, bracci */
  deepsky: boolean;
  /** asse di rotazione ed equatore del corpo selezionato */
  axis: boolean;
  /** linee del campo magnetico del pianeta selezionato o inquadrato */
  magnetic: boolean;
  /** figure e nomi delle costellazioni */
  constellations: boolean;
  /** stelle con pianeti e i loro esopianeti (NASA Exoplanet Archive) */
  exoplanets: boolean;
  /** zona abitabile, fascia di Kuiper, eliopausa, nube di Oort, punti di Lagrange */
  regions: boolean;
  /** nomi dei luoghi sulle superfici (mari, crateri, siti di atterraggio) */
  places: boolean;
}

export const DEFAULT_LAYERS: Layers = {
  planets: true, dwarfs: true, moons: true, comets: true, asteroids: true, spacecraft: true,
  orbits: true, trails: true, labels: true, stars: true, satellites: true,
  sb_comete: true, sb_neo: true, sb_principali: true, sb_tno: true,
  galaxy: true, deepsky: true, axis: true, magnetic: true, constellations: true, exoplanets: true, regions: true, places: true,
};

export type PickResult =
  | { type: 'body'; body: Body }
  | { type: 'small'; set: SmallBodySet; index: number }
  | { type: 'satellite'; index: number }
  | { type: 'star'; id: string; pos: Vector3; absmag?: number; ci?: number };

const _hole = new Vector3();
const _bh = new Vector3();
const _bhF = new Vector3();
const _bhW = new Vector3();
const _bhR = new Vector3();
const _bhU = new Vector3();
type Matrix4Like = { multiplyMatrices: (a: unknown, b: unknown) => unknown };
function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
/** corpi di cui da terra si mostra il nome senza doverli cercare */
const GROUND_KINDS = new Set(['star', 'planet', 'moon', 'nebula', 'cluster', 'galaxy', 'blackhole']);

export class SceneView {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly rig: CameraRig;
  readonly textures: TextureManager;
  readonly labels: LabelLayer;
  readonly stars = new StarLayer();
  readonly galaxy = new GalaxyLayer();
  readonly galaxySky = new GalaxySky();
  readonly procStars = new ProceduralStars();
  readonly satellites = new SatelliteLayer();
  readonly magneto = new MagnetosphereLayer();
  readonly smallSets: SmallBodySet[] = ['comete', 'neo', 'tno', 'principali'].map((s) => new SmallBodySet(s));
  private composer: EffectComposer;
  private bloom: LeanBloomPass;
  private visuals = new Map<string, BodyVisual>();
  private orbits = new Map<string, OrbitLine>();
  private axis!: AxisGizmo;
  private bhPass!: BlackHolePass;
  /** "fotografia a 360°" della scena attorno alla camera, per la luce deviata dal buco nero */
  private envTarget = new WebGLCubeRenderTarget(256, {
    type: HalfFloatType, generateMipmaps: true, minFilter: LinearMipmapLinearFilter, magFilter: LinearFilter,
  });
  private envCam = new CubeCamera(1e-6, 1e21, this.envTarget);
  private envAt = -1e9;
  private envValid = false;
  private envPos = new Vector3();
  /** asse di rotazione del gas attorno a Sgr A* (scena) e una base del suo piano */
  private bhAxis: Vector3 | null = null;
  private bhP = new Vector3();
  private bhQ = new Vector3();
  /** rotazione di Sagittarius A* (a*, da 0 a 0,998): non è misurata con certezza, si sceglie nel riquadro */
  bhSpin = 0.9;
  /** posizione della camera rispetto al buco nero (ρ dall'asse, z lungo l'asse) in unità di M, se è vicina */
  bhCamM: [number, number] | null = null;
  private observerPin!: ObserverMarker;
  ground!: GroundView;
  constellations!: ConstellationLayer;
  regions!: RegionLayer;
  places!: SurfacePlaces;
  private _fov = 50;
  private trails = new Map<string, TrailLine>();
  private craftLight: CraftLighting;
  layers: Layers = { ...DEFAULT_LAYERS };
  selectedId: string | null = null;
  width = 1;
  height = 1;
  pxPerRad = 1;
  private canvas: HTMLCanvasElement;

  constructor(private container: HTMLElement, private universe: Universe) {
    // La tela riceve solo il passaggio finale (un rettangolo a schermo intero): la scena si disegna
    // nelle texture della catena degli effetti, con il loro antialiasing. Con antialias sulla tela,
    // a ogni fotogramma la scheda video riempiva e fondeva 4 campioni per pixel per nulla
    // (sul Retina 12 milioni di campioni: due terzi del tempo di tutto il fotogramma).
    // Per lo stesso motivo la tela non ha bisogno di profondità.
    this.renderer = new WebGLRenderer({
      antialias: false, depth: false, stencil: false, logarithmicDepthBuffer: true, powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'scene-canvas';
    container.appendChild(this.canvas);
    this.scene.background = new Color('#010208');

    this.camera = new PerspectiveCamera(50, 1, 1e-6, 1e21);
    this.textures = new TextureManager(this.renderer);
    this.labels = new LabelLayer(container);
    this.rig = new CameraRig(this.camera, this.canvas, universe.sun, 3.2 * AU_KM);
    this.scene.add(this.magneto.group);
    this.scene.add(this.procStars.points);

    // antialiasing anche dentro la catena degli effetti (il canvas da solo non basta: il disegno
    // avviene in una texture intermedia). Solo sugli schermi a densità normale (sui Retina i bordi
    // sono già fini) e mai con WebKit, cioè la finestra del Mac: lì le texture intermedie
    // multicampionate in virgola mobile lasciano grandi riquadri neri e rallentano tutto
    const pr = this.renderer.getPixelRatio();
    const ua = navigator.userAgent;
    const webkit = /AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg\//.test(ua);
    const target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: pr < 1.5 && !webkit ? 4 : 0 });
    target.texture.name = 'EffectComposer.rt1';
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bhPass = new BlackHolePass();
    this.bhPass.onLut = () => { this.cameraMoved = true; };
    this.composer.addPass(this.bhPass);
    // il bagliore lavora a bassa risoluzione e non riscrive la scena: lo somma il passaggio finale,
    // che pulisce anche i pixel non validi (NaN, infiniti) e applica esposizione e colori (vedi postfx.ts)
    this.bloom = new LeanBloomPass(new Vector2(256, 256), 0.85, 0.55, 0.9);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new FinalPass(this.bloom));

    this.craftLight = new CraftLighting(this.scene, this.renderer);
    this.galaxySky.renderer = this.renderer;
    this.galaxySky.galaxy = this.galaxy;
    MODELS.onReady = () => { for (const b of this.universe.ordered) MODELS.attach(b); };
    void MODELS.load();

    this.axis = new AxisGizmo(this.labels.root);
    this.scene.add(this.axis.group);
    this.observerPin = new ObserverMarker(this.labels.root);
    this.ground = new GroundView(this.labels.root);
    this.scene.add(this.ground.group);
    this.constellations = new ConstellationLayer(this.labels.root);
    this.scene.add(this.constellations.line.mesh);
    void this.constellations.load().catch((err) => console.warn(t('Costellazioni non disponibili'), err));
    this.places = new SurfacePlaces(this.labels.root);
    void this.places.load().catch((err) => console.warn(t('Luoghi sulle superfici non disponibili'), err));
    this.regions = new RegionLayer(this.labels.root);
    this.regions.covered = this.labels.covered;
    this.scene.add(this.regions.group);
    for (const b of universe.ordered) this.addBody(b);
    universe.changed.on(() => this.syncBodies());
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  private addBody(b: Body): void {
    if (this.visuals.has(b.id) || b.kind === 'barycenter') return;
    if (MODELS.ready) MODELS.attach(b);
    const v = new BodyVisual(b, this.textures);
    this.visuals.set(b.id, v);
    this.scene.add(v.group);
    if (b.parent && ((b.kind !== 'star' && !DEEP_KINDS.has(b.kind)) || b.data.sky_orbit)) {
      const o = new OrbitLine(b);
      this.orbits.set(b.id, o);
      this.scene.add(o.line);
    }
    if (b.data.trail) {
      const t = new TrailLine(b);
      this.trails.set(b.id, t);
      this.scene.add(t.line);
    }
    this.labels.ensure(b);
  }

  /** Venere e Titano: superficie sotto le nubi oppure aspetto normale. */
  showSurface(id: string, on: boolean): void {
    this.visuals.get(id)?.showSurface(on);
  }

  private syncBodies(): void {
    for (const b of this.universe.ordered) this.addBody(b);
    for (const [id, v] of this.visuals) {
      if (!this.universe.bodies.has(id)) {
        this.scene.remove(v.group);
        v.dispose();
        this.visuals.delete(id);
        const o = this.orbits.get(id);
        if (o) {
          this.scene.remove(o.line);
          o.dispose();
          this.orbits.delete(id);
        }
        this.labels.remove(id);
      }
    }
  }

  resize(): void {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    const pr = this.renderer.getPixelRatio();
    LINE_SHARED.resolution.value.set(w * pr, h * pr);
    LINE_SHARED.pxRatio.value = pr;
    this.bloom.resolution.set(w / 2, h / 2);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.pxPerRad = h / 2 / Math.tan((this.camera.fov * Math.PI) / 360);
  }

  /** luogo dell'osservatore, segnato sulla Terra */
  set observer(p: Place | null) {
    this.observerPin.place = p;
  }

  kindVisible(b: Body): boolean {
    const L = this.layers;
    if (b.id === this.selectedId) return true;
    if (b.data.exo) return L.exoplanets;
    switch (b.kind) {
      case 'planet': return L.planets;
      case 'dwarf': return L.dwarfs;
      case 'moon': return L.moons;
      case 'comet': return L.comets;
      case 'asteroid': return L.asteroids;
      case 'spacecraft': return L.spacecraft;
      case 'satellite': return L.satellites;
      case 'galaxy': case 'blackhole': case 'nebula': case 'cluster': case 'arm': return L.deepsky;
      default: return true;
    }
  }

  /** Etichette che dipendono dalla scala (es. i bracci galattici solo da lontano). */
  private camFromSunPc = 0;
  labelVisible(b: Body): boolean {
    if (!this.kindVisible(b)) return false;
    if (this.rig.mode === 'ground') {
      // da terra: niente etichetta per la Terra stessa né per ciò che è sotto l'orizzonte
      if (b === this.universe.earth) return false;
      if (b.id !== this.selectedId) {
        // a occhio nudo o con un piccolo telescopio: Sole, Luna, pianeti e oggetti del cielo profondo.
        // Sonde, asteroidi e comete si vedono solo cercandoli (la ricerca li seleziona)
        if (!GROUND_KINDS.has(b.kind)) return false;
        if (!GroundView.above(this.rig, b.scenePos)) return false;
      }
    }
    const sh = b.data.show;
    if (!sh || b.id === this.selectedId) return true;
    const d = sh.from === 'sun' ? this.camFromSunPc : this.rig.camPos.distanceTo(b.scenePos) / PC_KM;
    return (sh.min_pc === undefined || d >= sh.min_pc) && (sh.max_pc === undefined || d <= sh.max_pc);
  }

  async loadStars(): Promise<void> {
    await this.stars.load();
    this.scene.add(this.stars.group);
  }

  async loadGalaxy(params: GalaxyParams): Promise<void> {
    await this.galaxy.load(params);
    if (this.galaxy.light && this.galaxy.dust) this.scene.add(this.galaxy.light, this.galaxy.dust);
    if (this.galaxy.armMap) {
      this.galaxySky.setArms(this.galaxy.armMap, 256);
      this.procStars.setArms(this.galaxy.armMap);
      this.scene.add(this.galaxySky.display);
    }
  }

  async loadSmallBodies(skip: Set<string>, onEach: () => void): Promise<void> {
    // in sequenza: così i duplicati finiscono nell'insieme più specifico
    for (const s of this.smallSets) {
      await s.load(skip);
      if (s.points) this.scene.add(s.points);
      onEach();
    }
  }

  async loadSatellites(): Promise<void> {
    await this.satellites.load();
    if (this.satellites.points) this.scene.add(this.satellites.points);
    if (this.satellites.nearPoints) this.scene.add(this.satellites.nearPoints);
  }

  /**
   * Raggio apparente (pixel CSS) di un corpo come lo si vede: per le sonde conta il modello 3D
   * (antenne, bracci), non il raggio di un paio di metri del catalogo.
   */
  private apparentPx(b: Body): number {
    const v = this.visuals.get(b.id);
    if (!v || !v.group.visible || v.distance <= 0) return 0;
    const r = Math.max(b.radius, (b.extra.modelRadiusKm as number | undefined) ?? 0);
    return (r / v.distance) * this.pxPerRad;
  }

  /** La linea (orbita o scia) di un corpo si interrompe attorno al corpo: non lo attraversa mai. */
  private cutHole(b: Body, line: ThickLine): void {
    const px = line.visible ? this.apparentPx(b) : 0;
    const v = this.visuals.get(b.id);
    if (px < 1.5 || !v) { line.setHole(); return; }
    _hole.copy(v.group.position).applyMatrix4(this.camera.matrixWorldInverse);
    if (_hole.z >= 0) { line.setHole(); return; }
    _hole.applyMatrix4(this.camera.projectionMatrix);
    const res = LINE_SHARED.resolution.value, pr = LINE_SHARED.pxRatio.value;
    const r0 = (px * 1.08 + 2) * pr;
    line.setHole(((_hole.x + 1) / 2) * res.x, ((_hole.y + 1) / 2) * res.y, r0, r0 * 1.3 + 6 * pr);
  }

  /** la camera si è mossa in questo fotogramma (serve al "disegno a riposo") */
  cameraMoved = true;
  private _prevCam = new Vector3(NaN, NaN, NaN);
  private _prevQuat = new Quaternion();

  frame(dtReal: number, jd: number, simMs: number, rate: number): void {
    this.rig.update(dtReal);
    const camPos = this.rig.camPos;
    {
      const scale = Math.max(camPos.distanceTo(this.rig.target.scenePos), 1e-3);
      const still = camPos.distanceTo(this._prevCam) <= scale * 1e-9
        && Math.abs(this.camera.quaternion.dot(this._prevQuat)) >= 1 - 1e-12;
      this.cameraMoved = !still;
      this._prevCam.copy(camPos);
      this._prevQuat.copy(this.camera.quaternion);
    }
    if (this.camera.fov !== this._fov) {
      // da terra la rotella cambia il campo visivo: cambiano i pixel per radiante
      this._fov = this.camera.fov;
      this.pxPerRad = this.height / 2 / Math.tan((this.camera.fov * Math.PI) / 360);
      this.cameraMoved = true;
    }
    const onGround = this.rig.mode === 'ground';
    this.universe.cameraPos = camPos;
    const sun = this.universe.sun;
    const pxScale = this.renderer.getPixelRatio();
    const dt = Math.min(0.25, Math.max(0, dtReal));
    const ctx: FrameCtx = {
      camPos, sun, camera: this.camera, pxPerRad: this.pxPerRad, pxScale, jd, dt,
      dtSim: Math.max(-1, Math.min(1, dt * rate)), earth: this.universe.earth,
      starMagLimit: this.stars.magLimit, starSaturation: this.stars.saturation,
    };

    let craft: SpacecraftModel | null = null;
    let craftPos: Vector3 | null = null;
    {
      const sv = this.visuals.get(sun.id);
      if (sv) sv.glowDim = this.magneto.shownFor(sun.id);
    }
    for (const v of this.visuals.values()) {
      v.update(ctx);
      if (v.group.visible && !this.kindVisible(v.body)) v.group.visible = false;
      // da terra la Terra non si disegna: al suo posto ci sono il suolo e l'orizzonte
      if (onGround && v.body === this.universe.earth) v.group.visible = false;
      const c = v.craft;
      if (c && v.group.visible && c.group.visible && (!craft || c.px > craft.px)) {
        craft = c;
        craftPos = v.group.position;
      }
    }
    this.craftLight.update(craft, craftPos ?? camPos, sun);
    for (const o of this.orbits.values()) {
      const b = o.body;
      const isSel = b.id === this.selectedId;
      const enabled = ((this.layers.orbits && this.kindVisible(b) && b.kind !== 'spacecraft' && b.kind !== 'satellite') || isSel)
        // da terra le orbite riempirebbero il cielo di righe: resta solo quella del corpo selezionato
        && !(onGround && (b === this.universe.earth || !isSel));
      o.update(ctx, { highlighted: isSel, force: isSel, enabled, bodyPx: this.apparentPx(b) });
      this.cutHole(b, o.thick);
    }
    for (const t of this.trails.values()) {
      const center = this.universe.get(t.centerId);
      t.update(ctx, center, this.layers.trails && this.kindVisible(t.body) && !onGround, t.body.id === this.selectedId);
      this.cutHole(t.body, t.thick);
    }
    {
      const focus = new Set<string>([this.rig.target.id]);
      if (this.selectedId) focus.add(this.selectedId);
      this.magneto.update(ctx, this.universe.bodies.values(), sun, focus, this.layers.magnetic && !onGround);
    }
    {
      const sel = this.selectedId ? this.universe.get(this.selectedId) ?? null : null;
      const sv = sel ? this.visuals.get(sel.id) : undefined;
      this.axis.update(sel, sv ? sv.group.position : camPos, sv && sel ? sv.group.scale.x * sel.radius : 1, sv?.pxRadius ?? 0,
        this.layers.axis && !!sv && sv.group.visible, ctx.dt ?? 1 / 60, this.camera, this.width, this.height);
      const ev = this.visuals.get(this.universe.earth.id);
      // il luogo dell'osservatore (Roma) si mostra solo quando si guarda proprio la Terra:
      // selezionata o inquadrata. Dalla Luna o da Saturno resterebbe una scritta che galleggia
      const earthFocus = !onGround && (this.selectedId === this.universe.earth.id || this.rig.target === this.universe.earth);
      if (ev && ev.group.visible && earthFocus) {
        this.observerPin.update(this.universe.earth, ev.group.position, ev.group.scale.x * this.universe.earth.radius, ev.pxRadius,
          this.camera, this.width, this.height);
      } else {
        this.observerPin.update(this.universe.earth, camPos, 1, 0, this.camera, this.width, this.height);
      }
    }

    const camRelSun = new Vector3().subVectors(camPos, sun.scenePos);
    this.camFromSunPc = camRelSun.length() / PC_KM;
    {
      // la stella del catalogo selezionata (o inquadrata): da vicino la disegna il suo corpo
      const sel = this.selectedId ? this.universe.get(this.selectedId) : undefined;
      const st = (sel?.extra.star ?? this.rig.target.extra.star) as { catalog: string; id: string } | undefined;
      this.stars.skipId = st && st.catalog === this.stars.catalog ? st.id : null;
    }
    this.stars.update(camRelSun, pxScale);
    this.stars.visible = this.layers.stars;
    this.galaxy.insideDisk = this.galaxySky.update(sun.scenePos, camPos, this.layers.galaxy, this.pxPerRad);
    // da dentro il disco le nuvolette della Galassia sono già nel cubo del cielo
    this.galaxy.update(sun.scenePos, camPos, this.pxPerRad, pxScale, this.layers.galaxy && !this.galaxySky.particlesBaked);
    this.procStars.update(sun.scenePos, camPos, pxScale, this.stars.magLimit, this.layers.stars && this.layers.galaxy);
    const setLayer: Record<string, boolean> = {
      comete: this.layers.sb_comete, neo: this.layers.sb_neo, principali: this.layers.sb_principali, tno: this.layers.sb_tno,
    };
    // da molto lontano centinaia di migliaia di asteroidi finirebbero sullo stesso pixel del Sole:
    // oltre qualche migliaio di UA dal Sole non si disegnano più (le comete più lontane arrivano a ~1000 UA)
    const smallBodiesNear = this.camFromSunPc < 0.025;
    const selBody = this.selectedId ? this.universe.get(this.selectedId) : undefined;
    const tgtBody = this.rig.target;
    for (const s of this.smallSets) {
      if (!s.points) continue;
      const hideA = selBody?.extra.smallSet === s.setId ? (selBody.extra.smallIndex as number) : -1;
      const hideB = tgtBody.extra.smallSet === s.setId ? (tgtBody.extra.smallIndex as number) : -1;
      // (da terra nessun asteroide si vede a occhio nudo: 250.000 puntini sarebbero un cielo finto)
      s.points.visible = setLayer[s.setId] && smallBodiesNear && !onGround;
      if (s.points.visible) s.update(jd, camRelSun, pxScale, hideA, hideB);
    }
    const earth = this.universe.earth;
    const earthRel = new Vector3().subVectors(earth.scenePos, camPos);
    // i satelliti hanno senso solo vicino alla Terra (l'orbita geostazionaria è a 42.000 km)
    this.satellites.update(simMs, rate, earthRel, pxScale, this.layers.satellites && earthRel.length() < 3e7, jd);

    this.ground.update(onGround, this.rig, this.camera, sun, earth, (id) => this.universe.get(id), pxScale, this.width, this.height);
    this.constellations.update(this.layers.constellations, this.layers.labels, camRelSun.clone().negate(), this.camFromSunPc,
      this.camera, this.width, this.height, this.pxPerRad, onGround ? this.rig.groundUp : null, this.labels.covered);
    {
      // luoghi sulla superficie del corpo selezionato (o di quello attorno a cui si gira)
      const sel = this.selectedId ? this.universe.get(this.selectedId) : undefined;
      const pb = sel && this.places.has(sel.id) ? sel : this.rig.target;
      const pv = this.visuals.get(pb.id);
      const show = this.layers.places && this.layers.labels && !onGround && !!pv && pv.group.visible;
      this.places.update(show ? pb : null, pv ? pv.group.position : camPos, pv ? pv.group.scale.x * pb.radius : 1, pv?.pxRadius ?? 0,
        this.camera, this.width, this.height);
    }
    this.regions.update(this.layers.regions && !onGround, this.layers.labels, camRelSun.clone().negate(), sun, earth,
      this.camera, this.width, this.height, this.pxPerRad);
    this.updateMeasure(camPos);
    this.labels.showNames = this.layers.labels;
    this.labels.update(this.camera, this.width, this.height, camPos, this.pxPerRad, (b) => this.labelVisible(b), this.selectedId);
    this.updateBlackHole(ctx, camRelSun, rate);
    this.composer.render();
  }

  /**
   * Sagittarius A*: la luce deviata dal buco nero, l'ombra e il gas caldo (vedi blackhole.ts).
   * Il passaggio si accende quando la deviazione della luce delle stelle supera un paio di pixel.
   */
  private updateBlackHole(ctx: FrameCtx, camRelSun: Vector3, rate: number): void {
    const pass = this.bhPass;
    const bh = this.universe.get('gal:sgra');
    const v = bh ? this.visuals.get(bh.id) : undefined;
    if (!bh || !v || !bh.valid || !this.layers.deepsky) {
      pass.enabled = false;
      if (v) v.lensFade = 0;
      return;
    }
    const rs = bh.radius;
    const rel = _bh.subVectors(bh.scenePos, this.rig.camPos);   // dalla camera al buco nero (km)
    const D = Math.max(rel.length(), rs * 1.0005);
    const r0 = D / rs;
    const pr = this.renderer.getPixelRatio();
    const pxDev = this.pxPerRad * pr;
    const rsPx = (rs / D) * pxDev;
    const thetaE = Math.sqrt((2 * rs) / D) * pxDev;
    // asse del gas: quello dell'orbita della "macchia calda" dei lampi misurata da GRAVITY
    // (inclinazione ~158°, cioè quasi di faccia e in senso orario sul cielo; nodo ~160°)
    if (!this.bhAxis) {
      const f = bh.data.fixed!;
      const ax = skyPlaneNormal(158, 160, f.ra_deg!, f.dec_deg!).applyMatrix3(M_ICRF_TO_SCENE).normalize();
      this.bhAxis = ax;
      this.bhP.set(1, 0, 0).addScaledVector(ax, -ax.x);
      if (this.bhP.lengthSq() < 1e-6) this.bhP.set(0, 1, 0).addScaledVector(ax, -ax.y);
      this.bhP.normalize();
      this.bhQ.crossVectors(ax, this.bhP);
    }
    const axis = this.bhAxis;
    // davanti o dietro alla camera?
    const fwd = _bhF.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const ahead = rel.dot(fwd) > 0;
    let lensOn = Math.min(1, Math.max(0, (thetaE - 2) / 10));
    if (!ahead && r0 > 2000) lensOn = 0;
    if (r0 < 2000) lensOn = 1;
    pass.enabled = lensOn > 0.002;
    v.lensFade = lensOn;
    // lato luminoso dell'anello visto da lontano: dove il gas viene verso la camera
    {
      const e1 = _bhW.copy(rel).multiplyScalar(-1 / D);
      const w = e1.cross(axis);
      const right = _bhR.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
      const up = _bhU.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
      v.setBlackHolePhase(Math.atan2(w.dot(up), w.dot(right)));
    }
    this.bhCamM = null;
    if (!pass.enabled) return;
    const u = pass.u;
    (u.camRight.value as Vector3).set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    (u.camUp.value as Vector3).set(0, 1, 0).applyQuaternion(this.camera.quaternion);
    (u.camFwd.value as Vector3).copy(fwd);
    u.tanHalf.value = Math.tan((this.camera.fov * Math.PI) / 360);
    u.aspect.value = this.camera.aspect;
    (u.viewProj.value as Matrix4Like).multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    (u.bh.value as Vector3).copy(rel).multiplyScalar(1 / rs);
    (u.axis.value as Vector3).copy(axis);
    // oltre questo angolo dal buco nero la luce è deviata di meno di un quarto di pixel
    u.maxTheta.value = Math.min(Math.PI, (8 * pxDev) / r0);
    pass.setDistance(r0);
    u.lensOn.value = lensOn;
    u.flowOn.value = smoothstep(0.6, 2.0, rsPx) * lensOn;
    u.pxPerRad.value = pxDev;
    // la macchia calda dei lampi: con il tempo molto accelerato girerebbe troppo in fretta per vederla
    const tSec = (ctx.jd - 2451545.0) * 86400;
    const fl = flareAt(tSec, rs, this.bhSpin);
    const period = hotspotPeriod(rs, this.bhSpin);
    // con la camera immersa nel gas (sotto ~2,5 rs) la sua luce coprirebbe tutto lo schermo: si attenua
    u.expo.value = 4.5 * (0.3 + 0.7 * smoothstep(1.1, 2.5, r0));
    const revPerSec = Math.abs(rate) / period;
    const amp = fl.amp * (1 - smoothstep(0.4, 2.5, revPerSec));
    const c = Math.cos(fl.phase), s = Math.sin(fl.phase);
    const hs = u.hs.value as { set: (x: number, y: number, z: number, w: number) => void };
    hs.set(HOTSPOT_R * (c * this.bhP.x + s * this.bhQ.x), HOTSPOT_R * (c * this.bhP.y + s * this.bhQ.y),
      HOTSPOT_R * (c * this.bhP.z + s * this.bhQ.z), 0.12 * amp);
    (u.hsT.value as Vector3).set(-s * this.bhP.x + c * this.bhQ.x, -s * this.bhP.y + c * this.bhQ.y, -s * this.bhP.z + c * this.bhQ.z);
    u.hsLen.value = 0.7 + 1.6 * fl.age;
    {
      // buco nero che ruota: assi X (dall'asse verso la camera), Y, Z (asse di rotazione), lunghezze in M = rs/2
      const cz = -rel.dot(axis);
      const X = _bhR.copy(rel).multiplyScalar(-1).addScaledVector(axis, -cz);
      const rho = X.length();
      if (rho > 1e-6 * D) X.multiplyScalar(1 / rho); else X.copy(this.bhP);
      const Y = _bhU.crossVectors(axis, X);
      this.bhCamM = [(2 * rho) / rs, (2 * cz) / rs];
      if (pass.setKerr(this.bhSpin, (2 * rho) / rs, (2 * cz) / rs, pxDev)) {
        (u.kX.value as Vector3).copy(X); (u.kY.value as Vector3).copy(Y); (u.kZ.value as Vector3).copy(axis);
        const hv = u.hs.value as unknown as { x: number; y: number; z: number; w: number };
        const ht = u.hsT.value as Vector3;
        const hp = _bhW.set(hv.x, hv.y, hv.z);
        (u.hsK.value as unknown as { set: (x: number, y: number, z: number, w: number) => void })
          .set(2 * hp.dot(X), 2 * hp.dot(Y), 2 * hp.dot(axis), hv.w);
        (u.hsTK.value as Vector3).set(ht.dot(X), ht.dot(Y), ht.dot(axis));
      }
    }
    // fotografia a 360° della scena: serve quando la luce che arriva alla camera viene da fuori dallo schermo
    // (le stelle e le nubi attorno sono lontanissime rispetto ai raggi dell'orizzonte: girando
    // attorno al buco nero la fotografia resta valida; si rifà spostandosi davvero, o di tanto in
    // tanto per le stelle S che corrono sulle loro orbite)
    const needEnv = r0 < 800;
    if (needEnv) {
      const now = performance.now();
      const moved = this.envPos.distanceTo(this.rig.camPos) / rs;
      // (a tempo reale le stelle S quasi non si muovono: rifarla spesso darebbe solo uno scatto ogni volta)
      const ar = Math.abs(rate);
      const every = ar > 1e6 ? 150 : ar > 1e4 ? 1500 : 20000;
      if (!this.envValid || moved > Math.max(20, 0.05 * r0) || now - this.envAt > every) {
        this.renderEnv(ctx, camRelSun, v);
        this.envAt = now;
        this.envPos.copy(this.rig.camPos);
        this.envValid = true;
      }
    } else {
      this.envValid = false;
    }
    u.envOn.value = needEnv ? 1 : 0;
    u.env.value = this.envTarget.texture;
    u.envTexPerRad.value = this.envTarget.width / 2;
  }

  /**
   * Disegna la scena in un cubo attorno alla camera: stelle, ammasso nucleare, Via Lattea e cielo
   * profondo. Niente orbite, scritte o linee: sono aiuti per leggere la scena, non luce da deviare.
   * I punti luminosi prendono la grandezza giusta per i pixel del cubo.
   */
  private renderEnv(ctx: FrameCtx, camRelSun: Vector3, bhVisual: BodyVisual): void {
    const keep = new Set<Object3D>([this.galaxySky.display, this.stars.group, this.procStars.points]);
    if (this.galaxy.light) keep.add(this.galaxy.light);
    if (this.galaxy.dust) keep.add(this.galaxy.dust);
    const family: BodyVisual[] = [];
    for (const vis of this.visuals.values()) {
      const b = vis.body;
      if (b.kind === 'star' || DEEP_KINDS.has(b.kind)) keep.add(vis.group);
      if (vis === bhVisual || b.parent?.id === bhVisual.body.id) family.push(vis);
    }
    const hidden: Object3D[] = [];
    for (const o of this.scene.children) {
      if (o.visible && !keep.has(o)) { o.visible = false; hidden.push(o); }
    }
    // dimensione dei punti: pixel del cubo (N/2 per radiante) invece di quelli dello schermo
    const pxScaleCube = this.envTarget.width / 2 / this.pxPerRad;
    // (senza tempo che passa: lo stesso fotogramma si ridisegna, niente deve avanzare due volte)
    const cubeCtx: FrameCtx = { ...ctx, pxScale: pxScaleCube, dt: 0, dtSim: 0 };
    for (const vis of family) vis.update(cubeCtx);
    this.stars.update(camRelSun, pxScaleCube);
    this.procStars.update(this.universe.sun.scenePos, this.rig.camPos, pxScaleCube, this.stars.magLimit, this.layers.stars && this.layers.galaxy);
    this.envCam.position.set(0, 0, 0);
    this.envCam.update(this.renderer, this.scene);
    // tutto come prima, per il disegno normale
    const back: FrameCtx = { ...ctx, dt: 0, dtSim: 0 };
    for (const vis of family) vis.update(back);
    this.stars.update(camRelSun, ctx.pxScale);
    this.procStars.update(this.universe.sun.scenePos, this.rig.camPos, ctx.pxScale, this.stars.magLimit, this.layers.stars && this.layers.galaxy);
    for (const o of hidden) o.visible = true;
  }

  /** Cosa c'è sotto il puntatore? Priorità: corpi del catalogo, satelliti, corpi minori, stelle. */
  pick(x: number, y: number, jd: number, simMs: number): PickResult | null {
    const b = this.labels.pick(x, y, 12);
    if (b) return { type: 'body', body: b };
    const camPos = this.rig.camPos;
    const earthRel = new Vector3().subVectors(this.universe.earth.scenePos, camPos);
    const si = this.satellites.pick(x, y, simMs, this.camera, earthRel, this.width, this.height);
    if (si !== null) return { type: 'satellite', index: si };
    const camRelSun = new Vector3().subVectors(camPos, this.universe.sun.scenePos);
    let best: { set: SmallBodySet; index: number; dist: number } | null = null;
    for (const s of this.smallSets) {
      const r = s.pick(x, y, jd, this.camera, camRelSun, this.width, this.height);
      if (r && (!best || r.dist < best.dist)) best = { set: s, ...r };
    }
    if (best) return { type: 'small', set: best.set, index: best.index };
    if (this.layers.stars) {
      const st = this.stars.pick(x, y, this.camera, camRelSun, this.width, this.height);
      if (st !== null) return { type: 'star', id: st.id, pos: st.pos, absmag: st.absmag, ci: st.ci };
    }
    return null;
  }

  /** Fotografia della scena così com'è (senza nomi né pannelli), in PNG. */
  capture(): Promise<Blob | null> {
    // l'immagine va letta subito dopo il disegno, prima che il browser svuoti la tela
    this.composer.render();
    return new Promise((resolve) => this.canvas.toBlob(resolve, 'image/png'));
  }

  /** misura: corpo di partenza della linea verso il corpo selezionato */
  measureFrom: Body | null = null;
  private measureLine: ThickLine | null = null;

  private updateMeasure(camPos: Vector3): void {
    const a = this.measureFrom, b = this.selectedId ? this.universe.get(this.selectedId) : undefined;
    const on = !!a && !!b && a !== b && a.valid && b.valid;
    if (!on) {
      if (this.measureLine) this.measureLine.visible = false;
      return;
    }
    if (!this.measureLine) {
      this.measureLine = new ThickLine(2, new Color('#ffd27a'), 0.75, 1.4);
      this.measureLine.mesh.renderOrder = 4;
      this.scene.add(this.measureLine.mesh);
    }
    // estremi riferiti alla camera a ogni fotogramma: precisi da vicino come da lontano
    const p = a!.scenePos, q = b!.scenePos;
    this.measureLine.setPoints([p.x - camPos.x, p.y - camPos.y, p.z - camPos.z, q.x - camPos.x, q.y - camPos.y, q.z - camPos.z], 1, 2);
    this.measureLine.visible = true;
  }

  get domElement(): HTMLCanvasElement {
    return this.canvas;
  }
}
