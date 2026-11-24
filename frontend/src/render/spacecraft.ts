/**
 * Modelli 3D delle sonde e dei satelliti (raccolta NASA 3D Resources, vedi scripts/modelli_3d).
 *
 * Ogni modello è in metri e si orienta come la sonda vera:
 *   - le sonde lontane tengono l'antenna parabolica puntata verso la Terra;
 *   - Parker Solar Probe e il James Webb tengono lo scudo verso il Sole;
 *   - la Stazione Spaziale vola "in assetto LVLH": un lato sempre verso la Terra, la prua nel
 *     verso del moto, e i pannelli solari che ruotano sui loro giunti per seguire il Sole;
 *   - Juno e i Pioneer ruotano su se stessi attorno all'asse dell'antenna.
 * La luce è quella del Sole (che si spegne quando la sonda entra nell'ombra di un pianeta), più
 * la luce riflessa dal pianeta vicino: la Stazione, di notte, si vede appena.
 */

import {
  AmbientLight, Box3, DirectionalLight, Group, Material, Matrix3, Matrix4, Mesh, MeshStandardMaterial, Object3D,
  Quaternion, Scene, Vector3, WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { api, type ModelAxis, type ModelSpec, type ModelsManifest, type ModelTracker } from '../data/api';
import { M_ICRF_TO_SCENE } from '../core/frames';
import { unitFromRaDec } from '../core/galactic';
import type { Body } from '../sim/body';
import { sunVisibility } from '../core/eclipse';
import { PROCEDURAL, PROCEDURAL_BODIES } from './procedural';

export { sunVisibility };

const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _d = new Vector3();
const _e = new Vector3();
const _q = new Quaternion();
const _m4 = new Matrix4();
const _m3 = new Matrix3();
const _inv = new Matrix4();
const ECL_NORTH = new Vector3(0, 1, 0);
/** luce del Sole sui modelli: una superficie bianca rivolta al Sole resta appena sotto la soglia del bagliore */
const SUN_INTENSITY = 2.1;

/** Catalogo dei modelli: si carica una volta, i file .glb solo quando servono. */
export class ModelLibrary {
  private manifest: ModelsManifest | null = null;
  private loading: Promise<void> | null = null;
  private files = new Map<string, Promise<Object3D | null>>();
  private loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  /** chiamata quando il catalogo è arrivato (per collegare i modelli ai corpi già creati) */
  onReady: () => void = () => {};

  load(): Promise<void> {
    this.loading ??= api.modelsManifest()
      .then((m) => { this.manifest = m; this.onReady(); })
      .catch(() => { this.manifest = { models: {}, bodies: {} }; });
    return this.loading;
  }

  get ready(): boolean {
    return this.manifest !== null;
  }

  keyFor(bodyId: string): string | null {
    return this.manifest?.bodies[bodyId] ?? PROCEDURAL_BODIES[bodyId] ?? null;
  }

  private procSpecs = new Map<string, ModelSpec>();

  spec(key: string): ModelSpec | null {
    const m = this.manifest?.models[key];
    if (m) return m;
    const p = PROCEDURAL[key];
    if (!p) return null;
    let s = this.procSpecs.get(key);
    if (!s) {
      // dimensioni misurate sul modello costruito
      const g = p.build();
      g.updateMatrixWorld(true);
      const box = new Box3().setFromObject(g);
      const size = box.getSize(new Vector3());
      let r = 0;
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) r = Math.max(r, Math.hypot(x, y, z));
      const { build: _b, ...rest } = p;
      s = { ...rest, file: '', procedural: true, size_m: [size.x, size.y, size.z], radius_m: r };
      this.procSpecs.set(key, s);
    }
    return s;
  }

  /** Per un corpo: il modello (se c'è) e il suo raggio in km, salvato nel corpo per la camera. */
  attach(b: Body): ModelSpec | null {
    const key = this.keyFor(b.id);
    const spec = key ? this.spec(key) : null;
    if (spec) {
      b.extra.modelKey = key;
      b.extra.modelRadiusKm = frameRadiusKm(spec);
      if (spec.view) b.extra.approach = { phase: (spec.view.phase_deg * Math.PI) / 180, elev: (spec.view.elev_deg * Math.PI) / 180 };
    }
    return spec;
  }

  /** Una copia del modello (geometrie e materiali condivisi fra le copie). */
  async instance(key: string): Promise<Object3D | null> {
    const spec = this.spec(key);
    if (!spec) return null;
    if (spec.procedural) {
      const g = PROCEDURAL[key].build();
      g.traverse((o) => {
        if ((o as Mesh).isMesh) o.castShadow = o.receiveShadow = true;
      });
      return g;
    }
    let p = this.files.get(key);
    if (!p) {
      p = this.loader.loadAsync(api.modelUrl(spec.file)).then((g) => {
        g.scene.traverse((o) => {
          const m = o as Mesh;
          if (!m.isMesh) return;
          m.castShadow = true;
          m.receiveShadow = true;
          const mats = (Array.isArray(m.material) ? m.material : [m.material]) as Material[];
          for (const mat of mats) {
            const s = mat as MeshStandardMaterial;
            if (s.isMeshStandardMaterial) {
              // nello spazio non c'è un ambiente da riflettere: senza un limite i metalli
              // sarebbero neri, salvo il riflesso del Sole
              s.metalness = Math.min(s.metalness, 0.45);
            }
          }
        });
        return g.scene;
      }).catch(() => null);
      this.files.set(key, p);
    }
    const src = await p;
    return src ? src.clone(true) : null;
  }
}

export const MODELS = new ModelLibrary();

/**
 * Raggio "da inquadrare" (km): metà della dimensione intermedia del modello, o poco più di metà
 * del raggio totale. Le aste lunghe e sottili (il magnetometro dei Voyager, 13 m) non devono
 * allontanare troppo la camera dal corpo della sonda.
 */
export function frameRadiusKm(spec: ModelSpec): number {
  if (spec.frame_m) return spec.frame_m / 1000;
  const s = [...spec.size_m].sort((a, b) => a - b);
  return Math.max(s[1] / 2, spec.radius_m * 0.58) / 1000;
}

interface Tracker {
  node: Object3D;
  rest: Quaternion;
  axis: Vector3;     // asse di rotazione, nel sistema del nodo
  normal: Vector3;   // la faccia che deve guardare il Sole, nel sistema del nodo
  twoSided: boolean;
  angle: number;
}

export interface CraftCtx {
  sun: Body;
  earth: Body;
  jd: number;
  /** secondi di tempo simulato trascorsi dal fotogramma precedente (già limitati) */
  dtSim: number;
  /** secondi reali dal fotogramma precedente */
  dt: number;
}

/** Il modello di una sonda: caricamento al bisogno, assetto, pannelli che seguono il Sole. */
export class SpacecraftModel {
  readonly group = new Group();
  private root: Object3D | null = null;
  private requested = false;
  private trackers: Tracker[] = [];
  private tracked = false;
  private spin = 0;
  readonly radiusKm: number;
  /** raggio apparente in pixel all'ultimo fotogramma */
  px = 0;
  /** luce del Sole che arriva (0 = nell'ombra di un pianeta) */
  sunlight = 1;

  constructor(readonly body: Body, readonly key: string, readonly spec: ModelSpec) {
    this.radiusKm = spec.radius_m / 1000;
    this.group.scale.setScalar(0.001); // metri -> km
    this.group.visible = false;
  }

  get loaded(): boolean {
    return this.root !== null;
  }

  private async load(): Promise<void> {
    this.requested = true;
    const obj = await MODELS.instance(this.key);
    if (!obj) return;
    this.root = obj;
    this.group.add(obj);
    this.setupTrackers(this.spec.trackers ?? []);
    this.body.extra.visRadiusKm = frameRadiusKm(this.spec);
  }

  /** Giunti dei pannelli: assi e normali portati nel sistema di ogni nodo, nella posizione di riposo. */
  private setupTrackers(defs: ModelTracker[]): void {
    const root = this.root!;
    root.updateMatrixWorld(true);
    _inv.copy(root.matrixWorld).invert();
    for (const def of defs) {
      const nodes: Object3D[] = [];
      root.traverse((o) => { if (o.name.includes(def.match)) nodes.push(o); });
      for (const node of nodes) {
        // rotazione del nodo rispetto al modello
        _m4.multiplyMatrices(_inv, node.matrixWorld);
        const pos = new Vector3().setFromMatrixPosition(_m4);
        _m3.setFromMatrix4(_m4).invert();
        const axis = new Vector3(...(def.axis === 'wing' ? [1, 0, 0] as const : def.axis)).applyMatrix3(_m3).normalize();
        const nModel = def.normal === 'inward_z' ? new Vector3(0, 0, -Math.sign(pos.z) || 1) : new Vector3(...def.normal);
        const normal = nModel.applyMatrix3(_m3).normalize();
        this.trackers.push({ node, rest: node.quaternion.clone(), axis, normal, twoSided: !!def.two_sided, angle: 0 });
      }
    }
  }

  /** Direzione (scena) verso un bersaglio dell'assetto, vista dalla sonda. */
  private target(t: string, ctx: CraftCtx, out: Vector3): Vector3 {
    const b = this.body;
    switch (t) {
      case 'earth': return out.subVectors(ctx.earth.scenePos, b.scenePos).normalize();
      case 'sun': return out.subVectors(ctx.sun.scenePos, b.scenePos).normalize();
      case 'nadir': return b.parent ? out.subVectors(b.parent.scenePos, b.scenePos).normalize() : out.set(0, -1, 0);
      case 'velocity': return out.copy(b.relVel).applyMatrix3(M_ICRF_TO_SCENE).normalize();
      case 'eclnorth': return out.copy(ECL_NORTH);
      default: {
        const m = /^radec:(-?[\d.]+),(-?[\d.]+)$/.exec(t);
        if (m) return out.copy(unitFromRaDec(+m[1], +m[2])).applyMatrix3(M_ICRF_TO_SCENE).normalize();
        return out.copy(ECL_NORTH);
      }
    }
  }

  /** Assetto: l'asse principale verso il primo bersaglio, il secondo il più vicino possibile al secondo. */
  private orient(ctx: CraftCtx, primary: ModelAxis, secondary: ModelAxis): void {
    const t1 = this.target(primary.to, ctx, _a);
    let t2 = this.target(secondary.to, ctx, _b);
    t2.addScaledVector(t1, -t2.dot(t1));
    if (t2.lengthSq() < 1e-8) {
      // i due bersagli coincidono: si usa il polo dell'eclittica (o un asse qualunque)
      t2 = _b.copy(ECL_NORTH).addScaledVector(t1, -ECL_NORTH.dot(t1));
      if (t2.lengthSq() < 1e-8) t2.set(1, 0, 0).addScaledVector(t1, -t1.x);
    }
    t2.normalize();
    const t3 = _c.crossVectors(t1, t2);
    const p = new Vector3(...primary.axis).normalize();
    const s = new Vector3(...secondary.axis);
    s.addScaledVector(p, -s.dot(p)).normalize();
    const r = new Vector3().crossVectors(p, s);
    // rotazione che porta (p, s, r) del modello su (t1, t2, t3) della scena
    const W = _m4.makeBasis(t1, t2, t3);
    const M = new Matrix4().makeBasis(p, s, r).transpose();
    W.multiply(M);
    this.group.quaternion.setFromRotationMatrix(W);
    if (this.spec.spin_rpm) {
      this.spin = (this.spin + (this.spec.spin_rpm / 60) * 2 * Math.PI * ctx.dtSim) % (2 * Math.PI);
      this.group.quaternion.multiply(_q.setFromAxisAngle(p, this.spin));
    }
  }

  /** I pannelli seguono il Sole: prima i giunti grandi (alfa), poi quelli delle singole ali (beta). */
  private track(ctx: CraftCtx): void {
    if (!this.trackers.length || !this.root) return;
    const sunW = _d.subVectors(ctx.sun.scenePos, this.body.scenePos).normalize();
    // i giunti si muovono con continuità; al primo fotogramma sono già al loro posto
    const k = this.tracked ? 1 - Math.exp(-ctx.dt / 0.35) : 1;
    this.tracked = true;
    for (const t of this.trackers) {
      t.node.quaternion.copy(t.rest).multiply(_q.setFromAxisAngle(t.axis, t.angle));
    }
    this.group.updateMatrixWorld(true);
    for (const t of this.trackers) {
      // rotazione del nodo (nel mondo) con l'angolo a zero
      t.node.quaternion.copy(t.rest);
      t.node.updateMatrixWorld(true);
      _m3.setFromMatrix4(t.node.matrixWorld);
      const u = _a.copy(t.axis).applyMatrix3(_m3).normalize();
      const n = _b.copy(t.normal).applyMatrix3(_m3);
      n.addScaledVector(u, -n.dot(u));
      const s = _c.copy(sunW).addScaledVector(u, -sunW.dot(u));
      let goal = t.angle;
      if (n.lengthSq() > 1e-10 && s.lengthSq() > 1e-10) {
        n.normalize();
        s.normalize();
        goal = Math.atan2(u.dot(_e.crossVectors(n, s)), n.dot(s));
        if (t.twoSided) {
          // per i giunti alfa vanno bene entrambi i versi: il più vicino
          let alt = goal + Math.PI;
          while (alt - t.angle > Math.PI) alt -= 2 * Math.PI;
          while (alt - t.angle < -Math.PI) alt += 2 * Math.PI;
          let g = goal;
          while (g - t.angle > Math.PI) g -= 2 * Math.PI;
          while (g - t.angle < -Math.PI) g += 2 * Math.PI;
          goal = Math.abs(alt - t.angle) < Math.abs(g - t.angle) ? alt : g;
        }
      }
      let diff = goal - t.angle;
      while (diff > Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;
      t.angle += diff * k;
      t.node.quaternion.copy(t.rest).multiply(_q.setFromAxisAngle(t.axis, t.angle));
      t.node.updateMatrixWorld(true);
    }
  }

  /**
   * @param distKm distanza dalla camera
   * @param pxPerRad pixel per radiante
   */
  update(ctx: CraftCtx, distKm: number, pxPerRad: number): void {
    const b = this.body;
    this.px = distKm > 0 ? (this.radiusKm / distKm) * pxPerRad : 0;
    if (!this.requested && this.px > 0.5) void this.load();
    const show = !!this.root && b.valid && this.px > 0.9;
    this.group.visible = show;
    if (!show) return;
    this.orient(ctx, this.spec.attitude.primary, this.spec.attitude.secondary);
    this.track(ctx);
    // ombra dei pianeti: il corpo attorno a cui gira, la Terra e la Luna se vicine
    const occ: Body[] = [];
    if (b.parent && b.parent.kind !== 'star' && b.parent.kind !== 'barycenter') occ.push(b.parent);
    const earth = ctx.earth;
    if (!occ.includes(earth) && earth.scenePos.distanceTo(b.scenePos) < 3e6) {
      occ.push(earth);
      const moon = earth.children.find((c) => c.id === 'naif:301');
      if (moon) occ.push(moon);
    }
    this.sunlight = sunVisibility(b.scenePos, ctx.sun, occ);
  }
}

/**
 * Luci per i modelli (gli altri oggetti della scena hanno shader propri e le ignorano):
 * il Sole, con le ombre portate, e la luce riflessa dal pianeta più vicino.
 */
export class CraftLighting {
  readonly sun = new DirectionalLight(0xffffff, SUN_INTENSITY);
  readonly shine = new DirectionalLight(0x9fb8ff, 0);
  readonly ambient = new AmbientLight(0xffffff, 0.04);
  /** una luce tenue dalla camera: il lato in ombra resta scuro ma se ne leggono le forme */
  readonly fill = new DirectionalLight(0xdfe6ff, 0.32);
  private sunTarget = new Object3D();
  private shineTarget = new Object3D();
  private fillTarget = new Object3D();
  private renderer: WebGLRenderer;

  constructor(scene: Scene, renderer: WebGLRenderer) {
    renderer.shadowMap.enabled = true;
    // l'ombra si ricalcola solo quando c'è un modello da illuminare (vedi update)
    renderer.shadowMap.autoUpdate = false;
    this.renderer = renderer;
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.target = this.sunTarget;
    this.shine.target = this.shineTarget;
    this.fill.target = this.fillTarget;
    scene.add(this.sun, this.shine, this.ambient, this.fill, this.sunTarget, this.shineTarget, this.fillTarget);
  }

  /**
   * @param craft il modello più grande sullo schermo (o null)
   * @param pos   la sua posizione nella scena relativa alla camera (km)
   */
  update(craft: SpacecraftModel | null, pos: Vector3, sun: Body): void {
    const on = !!craft && craft.group.visible;
    // le luci restano sempre "accese" (cambiarne il numero farebbe ricompilare gli shader dei
    // modelli a ogni avvicinamento): senza modelli in vista hanno solo intensità zero
    if (!on || !craft) {
      this.sun.intensity = this.shine.intensity = this.ambient.intensity = this.fill.intensity = 0;
      return;
    }
    this.renderer.shadowMap.needsUpdate = true;
    this.ambient.intensity = 0.04;
    this.fill.intensity = 0.32;
    // la camera è nell'origine della scena; la luce arriva da appena sopra di lei
    this.fill.position.set(0, craft.radiusKm * 0.6, 0);
    this.fillTarget.position.copy(pos);
    this.fillTarget.updateMatrixWorld();
    const b = craft.body;
    const R = craft.radiusKm;
    const toSun = _a.subVectors(sun.scenePos, b.scenePos).normalize();
    this.sunTarget.position.copy(pos);
    this.sun.position.copy(pos).addScaledVector(toSun, R * 3);
    this.sun.intensity = SUN_INTENSITY * craft.sunlight;
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -R * 1.05;
    cam.right = cam.top = R * 1.05;
    cam.near = R * 0.5;
    cam.far = R * 6;
    cam.updateProjectionMatrix();
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = R * 0.004;
    this.sunTarget.updateMatrixWorld();
    // luce riflessa dal pianeta vicino: (raggio/distanza)² per la frazione illuminata vista dalla sonda
    const p = b.parent && b.parent.kind !== 'star' && b.parent.kind !== 'barycenter' ? b.parent : null;
    let shine = 0;
    if (p && p.radius > 500) {
      const toP = _b.subVectors(p.scenePos, b.scenePos);
      const d = toP.length();
      const sunFromP = _c.subVectors(sun.scenePos, p.scenePos).normalize();
      const craftFromP = _d.copy(toP).negate().divideScalar(d);
      const lit = 0.5 * (1 + sunFromP.dot(craftFromP));
      const omega = Math.min(1, (p.radius / d) ** 2);
      const albedo = p.id === 'naif:399' ? 0.3 : p.kind === 'planet' && p.radius > 20000 ? 0.45 : 0.15;
      shine = SUN_INTENSITY * albedo * omega * lit;
      this.shineTarget.position.copy(pos);
      this.shine.position.copy(pos).addScaledVector(toP.normalize(), R * 3);
      this.shine.color.set(p.id === 'naif:399' ? '#9fb8ff' : (p.data.color ?? '#cccccc'));
      this.shineTarget.updateMatrixWorld();
    }
    this.shine.intensity = shine;
  }
}
