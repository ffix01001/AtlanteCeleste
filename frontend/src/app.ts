/** Applicazione: collega simulazione, grafica e interfaccia. */

import { t } from './core/i18n';
import { Vector3 } from 'three';
import { json2satrec } from 'satellite.js';
import { api } from './data/api';
import type { CatalogBody } from './data/types';
import { ORBIT_CLASS_IT, isCometClass } from './data/classes';
import { loadPref, savePref } from './core/events';
import { fmtDate, fmtKm, fmtNum, normalize } from './core/format';
import { FlightHud } from './ui/flighthud';
import { BlackHoleHud } from './ui/bhhud';
import { GroundHud } from './ui/groundhud';
import { sceneToIcrf } from './core/frames';
import { jdTdbToUnixMs, SimClock } from './core/time';
import { AU_KM, PC_KM } from './core/units';
import { starNature, tempToCss } from './core/stellar';
import { setChunkDays } from './ephem/jpl';
import { Body } from './sim/body';
import { Universe } from './sim/universe';
import { CameraRig } from './render/camera';
import { satCategory, SAT_CATEGORIES } from './render/satellites';
import { MODELS } from './render/spacecraft';
import { cleanName, type SmallBodySet } from './render/smallbodies';
import { DEFAULT_LAYERS, SceneView, type Layers } from './render/view';
import { h } from './ui/dom';
import { HelpPanel } from './ui/help';
import { langPicker } from './ui/langpicker';
import { InfoPanel } from './ui/infopanel';
import { LayersPanel } from './ui/layers';
import { GaiaBox } from './ui/gaia';
import { EventsPanel } from './ui/events';
import type { AstroEvent, SatInput } from './events/astroevents';
import { DEFAULT_PLACE, type Place } from './core/places';
import { kindLabel } from './ui/lexicon';
import { SearchBox, type SearchItem } from './ui/search';
import { TimeBar } from './ui/timebar';

interface Settings {
  layers: Layers;
  magLimit: number;
  hiTextures: boolean;
  satMask: number[];
  /** colori delle stelle accentuati (true) o come a occhio nudo */
  vividStars?: boolean;
  /** fotogrammi al secondo massimi (0 = quanti ne permette il monitor) */
  fpsCap?: number;
  /** luogo dell'osservatore (eventi, orari, alba e tramonto) */
  observer?: Place;
  /** corpi preferiti, per nome */
  favorites?: string[];
  /** da terra: cielo azzurro di giorno (true) o stelle sempre visibili */
  daySky?: boolean;
  /** versione delle impostazioni sulle texture (1 = alta risoluzione predefinita dove la scheda la regge) */
  texV?: number;
}

/** Stazioni e telescopi di cui si calcolano i passaggi visibili. */
const VISIBLE_SATS: { norad: number; name: string; of: string; stdMag: number }[] = [
  { norad: 25544, name: t('Stazione Spaziale Internazionale'), of: t('della Stazione Spaziale Internazionale'), stdMag: -1.8 },
  { norad: 48274, name: t('Stazione spaziale cinese Tiangong'), of: t('della stazione cinese Tiangong'), stdMag: -1.0 },
  { norad: 20580, name: t('Telescopio spaziale Hubble'), of: t('del telescopio spaziale Hubble'), stdMag: 1.5 },
];

export class App {
  readonly clock = new SimClock();
  universe!: Universe;
  view!: SceneView;
  info!: InfoPanel;
  events!: EventsPanel;
  search!: SearchBox;
  timebar!: TimeBar;
  layersPanel!: LayersPanel;
  gaia!: GaiaBox;
  help!: HelpPanel;
  private statusEl!: HTMLElement;
  private loadingEl!: HTMLElement;
  private stage!: HTMLElement;
  private ui!: HTMLElement;
  selected: Body | null = null;
  private dynamic: Body[] = [];
  private settings: Settings;
  private lastFrame = performance.now();
  private lastStatus = 0;
  private nextFrameAt = 0;
  private down: { x: number; y: number; t: number } | null = null;
  private flightHud!: FlightHud;
  private bhHud!: BlackHoleHud;
  private lastBh = 0;
  private freeBtn!: HTMLButtonElement;
  private toastEl!: HTMLElement;
  private toastTimer = 0;
  private groundHud!: GroundHud;
  private groundBtn!: HTMLButtonElement;
  /** da terra: corpo verso cui girare lo sguardo appena la sua posizione è aggiornata */
  private pendingLook: { id: string; until: number } | null = null;
  private lastHud = 0;
  /** fino a quando si disegna a pieno ritmo anche in pausa (vedi loop) */
  private awakeUntil = 0;
  private lastDraw = 0;

  constructor(private root: HTMLElement) {
    this.settings = loadPref<Settings>('settings', {
      layers: { ...DEFAULT_LAYERS },
      magLimit: 6.8,
      hiTextures: true,
      satMask: [1, 1, 1, 1, 1, 1],
    });
    this.settings.layers = { ...DEFAULT_LAYERS, ...this.settings.layers };
  }

  /** Qualcosa è cambiato (un comando, la camera, il tempo): per un po' si disegna a pieno ritmo. */
  wake(ms = 1500): void {
    this.awakeUntil = Math.max(this.awakeUntil, performance.now() + ms);
  }

  private save(): void {
    savePref('settings', this.settings);
  }

  async start(): Promise<void> {
    void api.tellLang();
    this.stage = h('div', { class: 'stage' });
    this.ui = h('div', { class: 'ui' });
    this.loadingEl = h('div', { class: 'loading' },
      h('h1', {}, 'Atlante Celeste'),
      h('p', { class: 'loading-msg' }, t('Preparo il Sistema Solare…')));
    this.root.append(this.stage, this.ui, this.loadingEl);

    let catalog: { bodies: CatalogBody[]; chunk_days: number };
    try {
      catalog = await api.catalog();
    } catch {
      const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
      this.fatal(t('Il server dati non risponde.'), t('Avvia Atlante Celeste con il file «{v0}» nella cartella del progetto, poi ricarica questa pagina.', { v0: mac ? 'avvia.command' : 'avvia.bat' }));
      return;
    }
    setChunkDays(catalog.chunk_days ?? 32);
    this.universe = new Universe(catalog.bodies);
    try {
      this.view = new SceneView(this.stage, this.universe);
    } catch (err) {
      this.fatal(t('La grafica 3D non è disponibile.'), t('Il browser non riesce a usare la scheda video (WebGL 2). Dettagli: {message}', { message: (err as Error).message }));
      return;
    }
    this.view.layers = this.settings.layers;
    this.view.stars.magLimit = this.settings.magLimit;
    this.view.stars.vividColors = this.settings.vividStars ?? true;
    // dalla versione 0.3 le texture in alta risoluzione sono la scelta predefinita, se la scheda
    // video le regge (si possono sempre spegnere in Livelli)
    if ((this.settings.texV ?? 0) < 1) {
      this.settings.hiTextures = this.view.textures.supports8k;
      this.settings.texV = 1;
      this.save();
    }
    this.view.textures.res = this.settings.hiTextures ? '8k' : '2k';
    this.view.satellites.catMask.splice(0, 6, ...this.settings.satMask);
    this.buildUi();
    this.bindInput();

    // primo calcolo e prima immagine
    this.universe.update(this.clock.jd, 1);
    this.view.rig.jumpTo(this.universe.sun, 3.2 * 149597870.7);
    this.view.rig.az = -1.2;
    this.view.rig.el = 0.42;
    requestAnimationFrame(() => this.loop());
    setTimeout(() => this.loadingEl.classList.add('gone'), 400);
    setTimeout(() => this.loadingEl.remove(), 2400);

    const fromHash = decodeURIComponent(location.hash.slice(1));
    if (fromHash && this.universe.get(fromHash)) this.select(this.universe.get(fromHash)!, true);

    // caricamenti in sottofondo
    void this.view.loadStars().then(() => {
      this.starCatalogLoaded();
      setTimeout(() => this.search.invalidate(), 1500);
    }).catch(() => {});
    void fetch(api.referenceUrl('via_lattea_bracci'))
      .then((r) => r.json())
      .then((ref) => this.view.loadGalaxy({ arms: ref.bracci, bar: ref.barra, disco: ref.disco }))
      .catch((err) => console.warn(t('Modello della Via Lattea non disponibile'), err));
    const skip = new Set<string>();
    for (const b of this.universe.bodies.values()) skip.add(b.id);
    for (const a of this.universe.aliases.keys()) skip.add(a);
    void this.view.loadSmallBodies(skip, () => {
      this.search.invalidate();
      this.attachConics();
    });
    void this.view.loadSatellites().then(() => this.search.invalidate());
  }

  private fatal(title: string, msg: string): void {
    this.loadingEl.replaceChildren(h('h1', {}, 'Atlante Celeste'), h('p', { class: 'loading-msg strong' }, title), h('p', { class: 'loading-msg' }, msg));
  }

  /** I corpi del catalogo ricevono gli elementi SBDB come ripiego (se presenti negli insiemi scaricati). */
  private attachConics(): void {
    for (const set of this.view.smallSets) {
      if (!set.count) continue;
      const index = new Map<string, number>();
      set.ids.forEach((id, i) => index.set(id, i));
      for (const b of this.universe.bodies.values()) {
        if (b.conic) continue;
        const keys = [b.id, ...(b.data.aliases ?? [])];
        for (const k of keys) {
          const known = set.skipped.get(k);
          if (known) { b.conic = known; break; }
          const i = index.get(k);
          if (i !== undefined) { b.conic = set.conic(i); break; }
        }
      }
    }
  }

  // ------------------------------------------------------------------ interfaccia
  private buildUi(): void {
    const top = h('div', { class: 'topbar' });
    const brand = h('div', { class: 'brand' }, h('span', { class: 'brand-name' }, 'Atlante Celeste'));
    const right = h('div', { class: 'top-actions' });
    top.append(brand);
    this.ui.append(top);
    this.search = new SearchBox(top);
    top.append(right);
    const eventsBtn = h('button', { class: 'btn', title: t('Eventi in cielo (E)'), onclick: () => this.events.toggle() }, t('Eventi'));
    const layersBtn = h('button', { class: 'btn', title: t('Livelli (L)'), onclick: () => this.layersPanel.toggle() }, t('Livelli'));
    // scorciatoia ben visibile per il catalogo di Gaia (prima era nascosto in fondo ai livelli)
    const gaiaBtn = h('button', {
      class: 'btn gaia-top', title: t('Più stelle: scarica dal satellite Gaia (ESA) milioni di stelle con la loro distanza vera'),
      onclick: () => {
        if (this.layersPanel.root.hidden) this.layersPanel.toggle();
        this.gaia.openBox();
      },
    }, t('Più stelle'));
    const helpBtn = h('button', { class: 'icon-btn', title: t('Comandi (?)'), 'aria-label': t('Comandi'), onclick: () => this.help.toggle() }, '?');
    // navigazione libera: si vola nello spazio come con un'astronave
    this.freeBtn = h('button', {
      class: 'btn', title: t('Volo libero (V): muoviti nello spazio con W A S D e il mouse'), 'aria-pressed': 'false',
      onclick: () => this.toggleFree(),
    }, t('Volo')) as HTMLButtonElement;
    // il cielo come lo si vede dal luogo dell'osservatore, con l'orizzonte
    this.groundBtn = h('button', {
      class: 'btn', title: t('Cielo visto da terra (T): guarda il cielo dal luogo scelto, con l\'orizzonte e le costellazioni'), 'aria-pressed': 'false',
      onclick: () => this.toggleGround(),
    }, t('Cielo')) as HTMLButtonElement;
    const photoBtn = h('button', { class: 'btn', title: t('Fotografa la scena (P): l\'immagine, senza nomi né pannelli, va nella cartella «immagini» del progetto'), onclick: () => void this.snapshot() }, t('Foto'));
    this.toastEl = h('div', { class: 'toast', role: 'status' });
    this.toastEl.hidden = true;
    this.ui.append(this.toastEl);
    right.append(this.groundBtn, this.freeBtn, gaiaBtn, eventsBtn, layersBtn, photoBtn, langPicker(), helpBtn);
    this.flightHud = new FlightHud(this.ui);
    this.bhHud = new BlackHoleHud(this.ui);
    this.view.bhSpin = loadPref<number>('bhSpin', 0.9);
    this.bhHud.spin = this.view.bhSpin;
    this.bhHud.onSpin = (a) => {
      this.view.bhSpin = a;
      savePref('bhSpin', a);
      this.wake();
    };
    this.flightHud.onExit = () => this.toggleFree();
    this.groundHud = new GroundHud(this.ui, this.settings.daySky ?? true);
    this.groundHud.onExit = () => this.toggleGround();
    this.groundHud.onDaylight = (on) => {
      this.settings.daySky = on;
      this.view.ground.daylight = on;
      this.save();
    };
    this.view.ground.daylight = this.settings.daySky ?? true;
    this.view.rig.bodies = () => this.universe.bodies.values();
    this.view.rig.onModeChange = (mode) => {
      const free = mode === 'free', ground = mode === 'ground';
      this.freeBtn.setAttribute('aria-pressed', String(free));
      this.freeBtn.classList.toggle('primary', free);
      this.flightHud.show(free);
      if (free) this.flightHud.update(this.view.rig, this.universe.sun.scenePos);
      this.groundBtn.setAttribute('aria-pressed', String(ground));
      this.groundBtn.classList.toggle('primary', ground);
      this.groundHud.show(ground);
      if (!ground) this.pendingLook = null;
    };

    this.layersPanel = new LayersPanel(this.ui, this.settings.layers, this.settings.magLimit, this.settings.hiTextures, this.settings.satMask, this.settings.vividStars ?? true, this.settings.fpsCap ?? 60);
    this.layersPanel.onFpsCap = (fps) => {
      this.settings.fpsCap = fps;
      this.save();
    };
    this.layersPanel.onStarColors = (vivid) => {
      this.settings.vividStars = vivid;
      this.view.stars.vividColors = vivid;
      this.save();
    };
    this.layersPanel.onChange = () => this.save();
    this.layersPanel.onMagLimit = (v) => {
      this.settings.magLimit = v;
      this.view.stars.magLimit = v;
      this.save();
    };
    this.layersPanel.onTextureRes = (hi) => {
      this.settings.hiTextures = hi;
      this.save();
      location.reload();
    };
    // "Più stelle": il catalogo di Gaia, scaricato dal programma
    this.gaia = new GaiaBox();
    this.gaia.catalogInfo = () => {
      const st = this.view.stars;
      return { id: st.catalog, label: st.catalogLabel, total: st.total, gmax: st.gmax };
    };
    this.gaia.onUseNew = async () => {
      await this.view.stars.reload();
      this.starCatalogLoaded();
      setTimeout(() => this.search.invalidate(), 1500);
    };
    this.layersPanel.starSlot.append(this.gaia.root);
    this.gaia.onStatus = (st) => {
      if (st?.running) {
        const frac = st.state === 'building' ? 1 : (st.zones_done ?? 0) / Math.max(1, st.zones_total ?? 1);
        gaiaBtn.textContent = t('Gaia {v0}%', { v0: Math.round(frac * 100) });
        gaiaBtn.classList.add('busy');
      } else {
        const ready = st?.catalog && this.view.stars.catalog !== st.catalog.id;
        gaiaBtn.textContent = ready ? t('Stelle pronte!') : t('Più stelle');
        gaiaBtn.classList.remove('busy');
        gaiaBtn.classList.toggle('primary', !!ready);
      }
    };
    this.layersPanel.onSatCategory = (i, on) => {
      this.settings.satMask[i] = on ? 1 : 0;
      this.view.satellites.catMask[i] = on ? 1 : 0;
      this.save();
    };
    this.events = new EventsPanel(this.ui, this.settings.observer ?? DEFAULT_PLACE);
    this.events.simTime = () => this.clock.simMs;
    this.events.onGo = (ev) => this.goToEvent(ev);
    this.events.onPlace = (p) => {
      this.settings.observer = p;
      this.save();
      this.view.observer = p;
      this.info.observer = p;
      if (this.view.rig.mode === 'ground') this.view.rig.groundSpot = p;
    };
    this.events.satellites = () => {
      const out: SatInput[] = [];
      for (const s of VISIBLE_SATS) {
        const o = this.view.satellites.omms.find((x) => x.NORAD_CAT_ID === s.norad);
        if (o) out.push({ ...s, omm: o as unknown as Record<string, unknown> });
      }
      return out;
    };
    this.help = new HelpPanel(this.ui);
    this.info = new InfoPanel(this.ui, this.universe);
    this.info.observer = this.view.observer = this.settings.observer ?? DEFAULT_PLACE;
    this.info.onClose = () => this.deselect();
    this.info.onFly = (b) => this.flyTo(b);
    this.info.onSurface = (b, on) => this.view.showSurface(b.id, on);
    this.info.onMeasure = (from) => {
      this.info.measureFrom = this.view.measureFrom = from;
      this.pruneDynamic();
    };
    this.info.isFavorite = (name) => (this.settings.favorites ?? []).includes(name);
    this.info.onFavorite = (name) => {
      const f = this.settings.favorites ?? [];
      this.settings.favorites = f.includes(name) ? f.filter((x) => x !== name) : [...f, name].slice(-30);
      this.save();
    };
    this.search.favorites = () => this.settings.favorites ?? [];
    this.info.textureCredit = (name) => this.view.textures.credit(name);
    this.info.photoCredit = (name) => this.view.textures.photoInfo(name);
    this.timebar = new TimeBar(this.ui, this.clock);
    this.statusEl = h('div', { class: 'status', 'aria-live': 'polite' });
    this.ui.append(this.statusEl);

    // fonti per la ricerca
    this.search.addSource(() => [...this.universe.bodies.values()]
      .filter((b) => b.kind !== 'barycenter' && !b.dynamic)
      .map((b) => ({
        name: b.name, hint: kindLabel(b), norm: normalize(`${b.name} ${b.data.slug ?? ''} ${b.data.sbdb ?? ''} ${(b.data.aliases ?? []).join(' ')}`),
        weight: b.rank * 2, pick: () => this.select(b, true),
      })));
    this.search.addSource(() => {
      const out: SearchItem[] = [];
      for (const s of this.view.smallSets) {
        for (let i = 0; i < s.count; i++) {
          const name = s.names[i];
          out.push({ name, hint: ORBIT_CLASS_IT[s.classes[i]] ?? t('Corpo minore'), norm: normalize(name), weight: 30, pick: () => this.selectSmall(s, i, true) });
        }
      }
      return out;
    });
    this.search.addSource(() => this.view.satellites.omms.map((o, i) => ({
      name: o.OBJECT_NAME, hint: t('Satellite, NORAD {NORAD_CAT_ID}', { NORAD_CAT_ID: o.NORAD_CAT_ID }), norm: normalize(`${o.OBJECT_NAME} ${o.NORAD_CAT_ID}`),
      weight: satCategory(o) === 0 ? 4 : 40, pick: () => this.selectSatellite(i, true),
    })));
    this.search.addSource(() => this.view.stars.names.map((n) => ({
      name: n.name, hint: t('Stella'), norm: normalize(n.name), weight: 20, pick: () => void this.selectStar(n.id, n.pos, true, n.absmag),
    })));

    this.view.labels.onPick = (b, dbl) => this.select(b, dbl);
    const panels = [this.info.root, this.timebar.root, this.layersPanel.root, this.help.root, this.search.root];
    this.view.labels.blockers = () => panels.filter((p) => !p.hidden).map((p) => p.getBoundingClientRect());
    this.view.rig.onUserInput = () => this.wake();
    this.view.places.onChange = () => this.wake();
    this.view.places.rightLimit = () => (this.info.root.hidden ? Infinity : this.info.root.getBoundingClientRect().left);
    // qualsiasi comando risveglia il disegno (in fase di cattura: vale anche per pannelli e ricerca)
    const wake = () => this.wake();
    for (const ev of ['pointerdown', 'pointerup', 'wheel', 'keydown', 'keyup', 'touchstart', 'touchmove', 'input', 'change', 'resize', 'focus']) {
      window.addEventListener(ev, wake, { capture: true, passive: true });
    }
    window.addEventListener('pointermove', (e) => { if (e.buttons) this.wake(); }, { capture: true, passive: true });
    this.clock.onChange(wake);
  }

  private bindInput(): void {
    const canvas = this.view.domElement;
    canvas.addEventListener('pointerdown', (e) => {
      this.down = { x: e.clientX, y: e.clientY, t: performance.now() };
    });
    canvas.addEventListener('pointerup', (e) => {
      const d = this.down;
      this.down = null;
      if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5 || e.button !== 0) return;
      this.pickAt(e.clientX, e.clientY, false);
    });
    canvas.addEventListener('dblclick', (e) => this.pickAt(e.clientX, e.clientY, true));
    window.addEventListener('keydown', (e) => {
      const tgt = e.target as HTMLElement;
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA')) return;
      // schermo intero come nelle app del Mac: Ctrl+Cmd+F
      if (e.metaKey && e.ctrlKey && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); toggleFullscreen(); return; }
      // con Cmd o Ctrl premuti i tasti appartengono al sistema (Cmd+H, Cmd+Q, Ctrl+F...)
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // in volo libero W A S D, Q E, Z C, + − e R muovono la camera
      if (this.view.rig.key(e, true)) { e.preventDefault(); return; }
      switch (e.key) {
        case '/': e.preventDefault(); this.search.focus(); break;
        case ' ': e.preventDefault(); this.clock.togglePause(); break;
        case '.': this.timebar.step(1); break;
        case ',': this.timebar.step(-1); break;
        case 'n': case 'N': this.clock.setLive(); break;
        case 'f': case 'F': if (this.selected) this.flyTo(this.selected); break;
        case 's': case 'S': this.flyTo(this.universe.sun, 3.2 * 149597870.7); break;
        case 't': case 'T': this.toggleGround(); break;
        case 'p': case 'P': void this.snapshot(); break;
        case 'g': case 'G': { const mw = this.universe.get('gal:mw'); if (mw) this.select(mw, true); break; }
        case 'l': case 'L': this.layersPanel.toggle(); break;
        case 'e': case 'E': this.events.toggle(); break;
        case 'h': case 'H': this.root.classList.toggle('ui-hidden'); break;
        case 'v': case 'V': this.toggleFree(); break;
        case 'm': case 'M':
          this.settings.layers.magnetic = !this.settings.layers.magnetic;
          this.layersPanel.sync('magnetic');
          this.save();
          break;
        case '?': this.help.toggle(); break;
        case 'Escape': this.deselect(); this.layersPanel.root.hidden = true; this.help.root.hidden = true; break;
        case 'F11': e.preventDefault(); toggleFullscreen(); break;
      }
    });
  }

  private pickAt(x: number, y: number, fly: boolean): void {
    const r = this.view.pick(x, y, this.clock.jd, this.clock.simMs);
    if (!r) return;
    if (r.type === 'body') this.select(r.body, fly);
    else if (r.type === 'small') this.selectSmall(r.set, r.index, fly);
    else if (r.type === 'satellite') this.selectSatellite(r.index, fly);
    else if (r.type === 'star') void this.selectStar(r.id, r.pos, fly, r.absmag, r.ci);
  }

  // ------------------------------------------------------------------ selezione
  select(b: Body, fly: boolean): void {
    this.selected = b;
    this.view.selectedId = b.id;
    this.info.show(b);
    if (fly) this.flyTo(b);
    this.pruneDynamic();
    try {
      history.replaceState(null, '', `#${encodeURIComponent(b.id)}`);
    } catch { /* ignorato */ }
  }

  /**
   * Porta la simulazione al momento di un evento (in pausa, così lo si osserva con calma)
   * e inquadra il corpo giusto.
   */
  goToEvent(ev: AstroEvent): void {
    this.clock.setTime(ev.time.getTime());
    if (!this.clock.paused) this.clock.togglePause();
    // passaggio di una stazione spaziale: si va sulla stazione
    if (ev.norad) {
      const i = this.view.satellites.omms.findIndex((o) => o.NORAD_CAT_ID === ev.norad);
      if (i >= 0) {
        this.selectSatellite(i, true);
        return;
      }
    }
    // asteroide o cometa di un passaggio ravvicinato: dal catalogo o dagli insiemi del JPL
    if (ev.sbdes) {
      const known = this.universe.get(`sb:${ev.sbdes}`);
      if (known) {
        this.select(known, true);
        return;
      }
      for (const set of this.view.smallSets) {
        const i = set.ids.indexOf(`sb:${ev.sbdes}`);
        if (i >= 0) {
          this.selectSmall(set, i, true);
          return;
        }
      }
    }
    const focus = this.universe.get(ev.focus);
    if (!focus) return;
    const hl = ev.highlight ? this.universe.get(ev.highlight) : undefined;
    if (this.view.rig.mode === 'ground') {
      // da terra si resta dove si è e si guarda verso l'evento: il Sole o la Luna per un'eclisse
      const id = ev.kind === 'eclissi-sole' ? 'naif:10' : ev.kind === 'eclissi-luna' || ev.kind === 'luna' ? 'naif:301' : focus.id;
      const look = this.universe.get(id) ?? focus;
      this.select(hl ?? (look === this.universe.earth ? focus : look), false);
      this.flyTo(look);
      return;
    }
    // con un corpo "da evidenziare" (la cometa madre di uno sciame) si apre la sua scheda
    // e se ne vede l'orbita, mentre la camera guarda la Terra
    this.select(hl ?? focus, false);
    this.flyTo(focus, ev.distanceKm);
  }

  flyTo(b: Body, distance?: number): void {
    if (this.view.rig.mode === 'ground') {
      // da terra non si parte: si gira lo sguardo verso il corpo (per un po', finché la sua
      // posizione non è aggiornata: dopo un salto nel tempo arriva qualche fotogramma più tardi)
      if (b !== this.universe.earth) this.pendingLook = { id: b.id, until: performance.now() + 900 };
      return;
    }
    // si arriva dal lato illuminato: dal Sole, o dalla propria stella per gli esopianeti
    const light = b.data.exo && b.parent?.kind === 'star' ? b.parent : this.universe.sun;
    this.view.rig.flyTo(b, distance ?? CameraRig.framingDistance(b), light.scenePos);
  }

  /** Volo libero sì/no. Uscendo si torna a girare attorno al corpo più vicino. */
  /** Messaggio breve in basso, che sparisce da solo. */
  private toast(text: string): void {
    this.toastEl.textContent = text;
    this.toastEl.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => { this.toastEl.hidden = true; }, 6000);
  }

  /** Fotografia della scena: salvata dal server nella cartella «immagini», o scaricata dal browser. */
  async snapshot(): Promise<void> {
    const blob = await this.view.capture();
    if (!blob) { this.toast(t('Non sono riuscito a fotografare la scena.')); return; }
    try {
      const r = await fetch('/api/snapshot', { method: 'POST', headers: { 'X-Atlante': '1', 'Content-Type': 'image/png' }, body: blob });
      if (!r.ok) throw new Error(String(r.status));
      const js = await r.json() as { file: string; folder: string };
      this.toast(t('Immagine salvata: {file}, nella cartella {folder}', { file: js.file, folder: js.folder }));
    } catch {
      // server non aggiornato o non raggiungibile: la scarica il browser
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `atlante_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      this.toast(t('Immagine scaricata dal browser (cartella dei download).'));
    }
  }

  /** Cielo visto da terra sì/no, dal luogo dell'osservatore. */
  toggleGround(): void {
    const rig = this.view.rig;
    if (rig.mode === 'ground') rig.leaveGround();
    else rig.startGround(this.universe.earth, this.settings.observer ?? DEFAULT_PLACE);
    this.wake();
  }

  toggleFree(): void {
    const rig = this.view.rig;
    if (rig.mode === 'free') rig.startOrbit(rig.target);
    else rig.startFree();
  }

  deselect(): void {
    this.selected = null;
    this.view.selectedId = null;
    this.info.hide();
    this.pruneDynamic();
    try {
      history.replaceState(null, '', location.pathname);
    } catch { /* ignorato */ }
  }

  /** Corpi creati al volo (asteroidi, satelliti, stelle): se ne tengono solo quelli in uso. */
  private addDynamic(b: Body): Body {
    const existing = this.universe.get(b.id);
    if (existing) return existing;
    this.universe.addDynamic(b);
    this.dynamic.push(b);
    return b;
  }

  private pruneDynamic(): void {
    const keep = new Set([this.selected?.id, this.view.rig.target.id, this.view.measureFrom?.id]);
    this.dynamic = this.dynamic.filter((b) => {
      if (keep.has(b.id)) return true;
      this.universe.removeDynamic(b);
      return false;
    });
  }

  selectSmall(set: SmallBodySet, i: number, fly: boolean): void {
    const rec = set.record(i);
    const comet = isCometClass(rec.cls);
    // diametro stimato dalla magnitudine assoluta H (albedo tipica 0,14)
    const diam = !comet && rec.mag < 40 ? (1329 / Math.sqrt(0.14)) * Math.pow(10, -rec.mag / 5) : 2;
    const data: CatalogBody = {
      id: rec.id, name: rec.name, kind: comet ? 'comet' : 'asteroid', parent: 'naif:10', rank: 3,
      radius_km: Math.max(diam / 2, 0.005), color: comet ? '#c8d8e0' : '#9a9088', rotation: { model: 'spin', period_h: 7 },
      horizons: { command: [], center: '500@10', step: '1 d' }, sbdb: rec.id.slice(3),
    };
    const b = new Body(data);
    b.conic = rec.conic;
    // il suo punto nell'insieme si nasconde: lo disegna il corpo
    b.extra.smallSet = set.setId;
    b.extra.smallIndex = i;
    if (rec.sungrazer) {
      const above = rec.conic.q * AU_KM - 695700;
      b.extra.endJd = rec.conic.tp;
      b.extra.endReason = t('Cometa radente: passando ad appena {v0} dalla superficie del Sole ', { v0: fmtKm(Math.max(above, 0)) })
        + t('si è quasi certamente disintegrata al perielio, il {date}. ', { date: fmtDate(jdTdbToUnixMs(rec.conic.tp), true).date })
        + t('Prima di quella data la trovi lungo la sua orbita.');
    }
    this.select(this.addDynamic(b), fly && !(rec.sungrazer && this.clock.jd > rec.conic.tp));
  }

  /** Catalogo stellare caricato (all'avvio o dopo aver scaricato Gaia): pannello e magnitudine limite. */
  private starCatalogLoaded(): void {
    const gmax = this.view.stars.gmax;
    // con Gaia si vedono stelle fino alla sua magnitudine limite (G), con HYG fino a circa la 9
    this.layersPanel.setMagMax(gmax ? Math.max(9.5, gmax + 0.5) : 9.5);
    this.gaia.refreshCurrent();
  }

  selectSatellite(i: number, fly: boolean): void {
    const o = this.view.satellites.omms[i];
    const cat = satCategory(o);
    const data: CatalogBody = {
      id: `norad:${o.NORAD_CAT_ID}`, name: prettySatName(o.OBJECT_NAME), kind: 'satellite', parent: 'naif:399', rank: 3,
      radius_km: cat === 0 ? 0.05 : 0.005, color: SAT_CATEGORIES[cat].color,
    };
    const b = new Body(data);
    b.satrec = json2satrec(o as any);
    b.extra.omm = o;
    MODELS.attach(b);
    this.select(this.addDynamic(b), fly);
  }

  /**
   * Stella del catalogo a tasselli: id del catalogo e posizione (parsec, scena).
   * Dalla classe spettrale (se il catalogo la conosce), dal colore e dalla luminosità si
   * ricavano tipo, temperatura e raggio: avvicinandosi, la stella appare come una sfera
   * del suo colore e della sua grandezza vera (Betelgeuse più grande dell'orbita di Marte,
   * una nana bianca grande come la Terra).
   */
  async selectStar(id: string, posPc: Vector3, fly: boolean, absmag?: number, ci?: number): Promise<void> {
    const st = this.view.stars;
    const catalog = st.catalog;
    let info: Record<string, any> | null = null;
    try {
      info = await api.starInfo(catalog, id);
    } catch { /* dati descrittivi non disponibili: bastano colore e luminosità */ }
    const M = absmag ?? (typeof info?.absmag === 'number' ? info.absmag : 4.83);
    // 0,65 è il valore messo dagli script alle stelle senza misura di colore
    if (ci !== undefined && Math.abs(ci - 0.65) < 1e-6) ci = undefined;
    const nature = starNature(M, ci ?? null, info?.spect ?? null);
    const name = st.nameOf(id) ?? t('Stella {id} ({catalogLabel})', { id, catalogLabel: st.catalogLabel });
    const posScene = posPc.clone().multiplyScalar(PC_KM);
    // raggio: fra 1000 km (nane bianche più dense) e 10 UA (le supergiganti più grandi)
    const radiusKm = Math.min(Math.max(nature.radiusSun * 695700, 1000), 1.5e9);
    const data: CatalogBody = {
      id: `star:${catalog}:${id}`, name, kind: 'star', parent: 'naif:10', rank: 3, radius_km: radiusKm,
      color: tempToCss(nature.temperatureK),
      // la granulazione del Sole, ricolorata: dà vita alla superficie anche delle altre stelle
      texture: 'sun',
    };
    const b = new Body(data);
    b.extra.star = { catalog, id };
    b.extra.absmag = M;
    if (ci !== undefined && Number.isFinite(ci)) b.extra.ci = ci;
    b.extra.nature = nature;
    if (info) b.extra.starInfo = info;
    b.extra.fixed = sceneToIcrf(posScene, new Vector3());
    const added = this.addDynamic(b);
    this.select(added, false);
    if (fly) this.flyTo(added, Math.max(CameraRig.framingDistance(added), 0.02 * PC_KM));
  }

  // ------------------------------------------------------------------ ciclo principale
  private loop(): void {
    requestAnimationFrame(() => this.loop());
    const now = performance.now();
    // disegno a riposo: con il tempo in pausa e la camera ferma l'immagine non cambia. Invece di
    // ridisegnarla 60 volte al secondo se ne fanno 4 (bastano a mostrare ciò che arriva intanto
    // dalla rete, come una texture o un tassello di stelle): scheda video e batteria riposano
    if (this.clock.paused && now > this.awakeUntil && now - this.lastDraw < 250) return;
    this.lastDraw = now;
    // limite di fotogrammi al secondo: su un monitor a 144 o 165 Hz la scheda video lavorerebbe
    // più del doppio per un'animazione che a 60 fps è già fluida
    const cap = this.settings.fpsCap ?? 60;
    if (cap > 0) {
      if (now < this.nextFrameAt - 1) return;
      // in media esattamente `cap` fotogrammi al secondo anche su monitor a 144 Hz
      this.nextFrameAt = Math.max(this.nextFrameAt + 1000 / cap, now);
    }
    const dtReal = Math.min((now - this.lastFrame) / 1000, 0.1);
    // fotogrammi lenti (oltre 25 ms, cioè sotto i 40 al secondo) mentre si disegna di continuo
    if (now - this.lastFrame < 200) {
      this.frameCount++;
      if (now - this.lastFrame > 25) this.slowCount++;
    }
    this.lastFrame = now;
    this.clock.tick();
    const focus = this.universe.focusIds;
    focus.clear();
    focus.add(this.view.rig.target.id);
    if (this.selected) focus.add(this.selected.id);
    this.universe.update(this.clock.jd, this.clock.paused ? 0 : this.clock.rate);
    this.view.frame(dtReal, this.clock.jd, this.clock.simMs, this.clock.paused ? 0 : this.clock.rate);
    if (this.view.cameraMoved) this.wake();
    if (this.view.rig.mode === 'ground') {
      const pl = this.pendingLook;
      if (pl) {
        const b = this.universe.get(pl.id);
        if (b?.valid) this.view.rig.groundLookAt(b.scenePos);
        if (now > pl.until) this.pendingLook = null;
        this.wake();
      }
      if (now - this.lastHud > 120) {
        this.lastHud = now;
        this.groundHud.update(this.view.rig, (this.settings.observer ?? DEFAULT_PLACE).name, this.view.ground.sunAltDeg);
      }
    }
    this.info.update();
    this.timebar.tick();
    if (this.view.rig.mode === 'free' && now - this.lastHud > 120) {
      this.lastHud = now;
      this.flightHud.update(this.view.rig, this.universe.sun.scenePos);
    }
    if (now - this.lastBh > 250) {
      this.lastBh = now;
      this.updateBlackHoleHud();
    }
    if (now - this.lastStatus > 500) {
      this.lastStatus = now;
      this.renderStatus();
    }
  }

  /** Vicino a Sagittarius A* (entro ~20.000 UA) il riquadro con ciò che proverebbe chi stesse lì. */
  private updateBlackHoleHud(): void {
    const bh = this.universe.get('gal:sgra');
    const rig = this.view.rig;
    let r: number | null = null;
    if (bh?.valid && this.view.layers.deepsky && rig.mode !== 'ground') {
      const d = bh.scenePos.distanceTo(rig.camPos) / bh.radius;
      if (d < 2.5e5) r = d;
    }
    // sotto il riquadro del volo libero, se c'è
    const fh = this.flightHud.root;
    this.bhHud.root.style.top = fh.hidden ? '' : `${fh.offsetTop + fh.offsetHeight + 10}px`;
    this.bhHud.update(r, bh?.radius ?? 1, (this.clock.jd - 2451545.0) * 86400, this.view.bhCamM);
  }

  private frameCount = 0;
  private slowCount = 0;

  private renderStatus(): void {
    const parts: HTMLElement[] = [];
    // se la scheda video fatica (più di un fotogramma lento su cinque) lo si dice
    if (this.frameCount > 12 && this.slowCount > this.frameCount / 5) {
      parts.push(h('span', { class: 'warn' }, t('Grafica lenta: {slowCount} fotogrammi lenti su {frameCount}', { slowCount: this.slowCount, frameCount: this.frameCount })));
    }
    this.frameCount = this.slowCount = 0;
    const L = this.universe.loader;
    const st = this.universe.jplStats();
    const busy = L.pending > 0;
    parts.push(h('span', { class: busy ? 'busy' : '' }, t('Posizioni JPL: {withData} di {total} corpi', { withData: st.withData, total: st.total })));
    if (L.networkDown) parts.push(h('span', { class: 'warn' }, t('JPL non raggiungibile: uso posizioni approssimate')));
    const sb = this.view.smallSets;
    const sbCount = sb.reduce((a, s) => a + s.count, 0);
    const sbLoading = sb.some((s) => s.loading);
    const sbErr = sb.find((s) => s.error);
    if (sbCount || sbLoading) parts.push(h('span', { class: sbLoading ? 'busy' : '' }, t('Asteroidi e comete: {v0}', { v0: fmtNum(sbCount, 0) })));
    if (sbErr && !sbCount) parts.push(h('span', { class: 'warn' }, t('Corpi minori non disponibili')));
    const sat = this.view.satellites;
    if (sat.loading) parts.push(h('span', { class: 'busy' }, t('Satelliti in arrivo')));
    else if (sat.count) {
      parts.push(sat.validAt(this.clock.simMs)
        ? h('span', {}, t('Satelliti: {v0}', { v0: fmtNum(sat.count, 0) }))
        : h('span', { class: 'warn' }, t('Satelliti nascosti: i loro elementi valgono solo vicino a oggi')));
    } else if (sat.error) parts.push(h('span', { class: 'warn' }, t('Satelliti non disponibili')));
    const sl = this.view.stars;
    if (sl.count) parts.push(h('span', {}, t('Stelle: {v0} di {v1} ({catalogLabel}, {tilesLoaded}/{tilesTotal} tasselli)', { v0: fmtNum(sl.count, 0), v1: fmtNum(sl.total, 0), catalogLabel: sl.catalogLabel, tilesLoaded: sl.tilesLoaded, tilesTotal: sl.tilesTotal })));
    this.statusEl.replaceChildren(...parts);
  }
}

/** Schermo intero: nella finestra desktop lo gestisce pywebview, nel browser l'API Fullscreen. */
function toggleFullscreen(): void {
  const pw = (window as unknown as { pywebview?: { api?: { toggle_fullscreen?: () => Promise<unknown> } } }).pywebview;
  if (pw?.api?.toggle_fullscreen) {
    void pw.api.toggle_fullscreen();
    return;
  }
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen().catch(() => {});
}

function prettySatName(n: string): string {
  if (/^ISS \(/.test(n)) return t('Stazione Spaziale Internazionale (ISS)');
  if (/TIANHE/.test(n)) return t('Stazione spaziale Tiangong (modulo Tianhe)');
  return n;
}

export function cleanSmallName(s: string): string {
  return cleanName(s);
}
