/**
 * Modelli 3D semplificati delle sonde che non hanno un modello pubblico (o non uno adatto):
 * costruiti qui con forme semplici, sulle dimensioni vere (in metri) e con i colori dei
 * materiali veri: isolamento termico dorato o nero, pannelli solari blu scuro, antenne bianche.
 *
 * Convenzione: +Y è l'asse che la sonda tiene puntato (antenna o pannelli solari verso la
 * Terra o il Sole, oppure lo scudo verso il Sole), +Z il secondo riferimento.
 */

import { t } from '../core/i18n';
import {
  BoxGeometry, CanvasTexture, CircleGeometry, Color, CylinderGeometry, DoubleSide, ExtrudeGeometry, Group,
  LatheGeometry, Material, Mesh, MeshStandardMaterial, Object3D, RepeatWrapping, Shape, SphereGeometry,
  SRGBColorSpace, Texture, Vector2, Vector3,
} from 'three';
import type { ModelSpec } from '../data/api';

type V3 = [number, number, number];

// ---------------------------------------------------------------------------- materiali
let mats: Record<string, MeshStandardMaterial> | null = null;

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): Texture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = t.wrapT = RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

/** Numeri pseudo-casuali ripetibili (le texture sono sempre uguali). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** Isolamento multistrato: un foglio sottile e stropicciato. */
function mliTexture(base: string, light: string, dark: string, seed: number): Texture {
  return canvasTex(256, 256, (g) => {
    g.fillStyle = base;
    g.fillRect(0, 0, 256, 256);
    const r = rng(seed);
    for (let i = 0; i < 420; i++) {
      g.strokeStyle = r() < 0.5 ? light : dark;
      g.globalAlpha = 0.08 + r() * 0.18;
      g.lineWidth = 1 + r() * 5;
      g.beginPath();
      const x = r() * 256, y = r() * 256, a = r() * Math.PI;
      const l = 10 + r() * 50;
      g.moveTo(x, y);
      g.quadraticCurveTo(x + Math.cos(a + 0.6) * l * 0.5, y + Math.sin(a + 0.6) * l * 0.5, x + Math.cos(a) * l, y + Math.sin(a) * l);
      g.stroke();
    }
    g.globalAlpha = 1;
  });
}

/** Celle solari: righe e colonne di celle blu scuro separate da sottili linee d'argento. */
function cellTexture(cols: number, rows: number, cell: string, line: string): Texture {
  return canvasTex(512, 512, (g) => {
    g.fillStyle = line;
    g.fillRect(0, 0, 512, 512);
    const w = 512 / cols, h = 512 / rows;
    const r = rng(cols * 31 + rows);
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        const k = 0.9 + r() * 0.2;
        const c = new Color(cell).multiplyScalar(k);
        g.fillStyle = `#${c.getHexString()}`;
        g.fillRect(i * w + 1.2, j * h + 1.2, w - 2.4, h - 2.4);
      }
    }
  });
}

/** Pannello circolare "a ventaglio" (UltraFlex di Lucy): spicchi di celle. */
function fanTexture(): Texture {
  return canvasTex(512, 512, (g) => {
    g.fillStyle = '#1a2340';
    g.fillRect(0, 0, 512, 512);
    g.strokeStyle = '#c9c4b0';
    g.lineWidth = 2;
    for (let i = 0; i < 20; i++) {
      const a = (i / 20) * Math.PI * 2;
      g.beginPath();
      g.moveTo(256, 256);
      g.lineTo(256 + Math.cos(a) * 256, 256 + Math.sin(a) * 256);
      g.stroke();
    }
    g.globalAlpha = 0.35;
    for (let r = 30; r < 256; r += 14) {
      g.beginPath();
      g.arc(256, 256, r, 0, Math.PI * 2);
      g.stroke();
    }
    g.globalAlpha = 1;
  });
}

function M(): Record<string, MeshStandardMaterial> {
  if (mats) return mats;
  const std = (o: ConstructorParameters<typeof MeshStandardMaterial>[0]) => new MeshStandardMaterial(o);
  mats = {
    gold: std({ map: mliTexture('#b8892f', '#f0cf7a', '#6e4c14', 1), metalness: 0.45, roughness: 0.38 }),
    black: std({ map: mliTexture('#1d1d20', '#4a4a50', '#08080a', 2), metalness: 0.2, roughness: 0.55 }),
    silver: std({ map: mliTexture('#a9acb2', '#e8eaee', '#6c6f76', 3), metalness: 0.45, roughness: 0.32 }),
    white: std({ color: '#e6e4df', metalness: 0.0, roughness: 0.62 }),
    grey: std({ color: '#6d7078', metalness: 0.35, roughness: 0.5 }),
    dark: std({ color: '#2b2c30', metalness: 0.3, roughness: 0.55 }),
    cells: std({ map: cellTexture(6, 10, '#1b2b55', '#b9b6a8'), metalness: 0.3, roughness: 0.3, side: DoubleSide }),
    cellsRosa: std({ map: cellTexture(4, 24, '#2a2558', '#d8c277'), metalness: 0.25, roughness: 0.3, side: DoubleSide }),
    panelBack: std({ color: '#c9c6bd', metalness: 0.1, roughness: 0.7 }),
    fan: std({ map: fanTexture(), metalness: 0.25, roughness: 0.35, side: DoubleSide }),
    red: std({ color: '#b3121c', metalness: 0.55, roughness: 0.28 }),
    glass: std({ color: '#0c1016', metalness: 0.8, roughness: 0.1 }),
    tire: std({ color: '#111111', metalness: 0, roughness: 0.9 }),
    suit: std({ color: '#f2f2f0', metalness: 0, roughness: 0.75 }),
  };
  return mats;
}

// ------------------------------------------------------------------------------- forme
function place(o: Object3D, at: V3 = [0, 0, 0], rot?: V3): Object3D {
  o.position.set(...at);
  if (rot) o.rotation.set(...rot);
  return o;
}

function box(w: number, h: number, d: number, mat: Material | Material[], at?: V3, rot?: V3): Object3D {
  return place(new Mesh(new BoxGeometry(w, h, d), mat), at, rot);
}

/** Cilindro lungo l'asse indicato. */
function cyl(r1: number, r2: number, len: number, mat: Material, at: V3 = [0, 0, 0], axis: 'x' | 'y' | 'z' = 'y', seg = 28): Object3D {
  const m = new Mesh(new CylinderGeometry(r1, r2, len, seg), mat);
  if (axis === 'x') m.rotation.z = Math.PI / 2;
  if (axis === 'z') m.rotation.x = Math.PI / 2;
  return place(m, at, axis === 'y' ? undefined : [m.rotation.x, m.rotation.y, m.rotation.z]);
}

/** Asta sottile fra due punti. */
function boom(a: V3, b: V3, r = 0.03, mat?: Material): Object3D {
  const va = new Vector3(...a), vb = new Vector3(...b);
  const len = va.distanceTo(vb);
  const m = new Mesh(new CylinderGeometry(r, r, len, 8), mat ?? M().grey);
  m.position.copy(va).add(vb).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), vb.sub(va).normalize());
  return m;
}

/** Antenna parabolica (diametro, profondità), concava verso +Y; poi ruotata verso `dir`. */
function dish(diam: number, depth: number, at: V3, dir: V3 = [0, 1, 0], mat?: Material): Object3D {
  const R = diam / 2;
  const pts: Vector2[] = [];
  for (let i = 0; i <= 16; i++) {
    const r = (i / 16) * R;
    pts.push(new Vector2(r, (depth * r * r) / (R * R)));
  }
  const g = new Group();
  const shell = new Mesh(new LatheGeometry(pts, 40), mat ?? new MeshStandardMaterial({ color: '#ecebe6', roughness: 0.6, side: DoubleSide }));
  g.add(shell);
  // illuminatore al centro, sorretto da tre gambe
  const f = depth + R * 0.55;
  g.add(cyl(R * 0.05, R * 0.07, R * 0.12, M().white, [0, f, 0]));
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2;
    g.add(boom([Math.cos(a) * R * 0.85, depth * 0.72, Math.sin(a) * R * 0.85], [0, f, 0], R * 0.012, M().white));
  }
  g.position.set(...at);
  g.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(...dir).normalize());
  return g;
}

/** Pannello solare piatto (larghezza lungo X, altezza lungo Z): celle sopra (+Y), retro chiaro. */
function panel(w: number, h: number, at: V3, cells?: Material): Object3D {
  const m = M();
  const c = cells ?? m.cells;
  // facce del BoxGeometry: +x, -x, +y, -y, +z, -z
  return box(w, 0.04, h, [m.panelBack, m.panelBack, c, m.panelBack, m.panelBack, m.panelBack], at);
}

/**
 * Ala di pannelli in fila lungo ±X a partire da `root` (distanza dal centro), con il braccio.
 * `side` = +1 o -1. Restituisce un gruppo con l'origine sul giunto (per farla ruotare).
 */
function wing(side: 1 | -1, root: number, n: number, pw: number, ph: number, gap = 0.08, cells?: Material, name?: string): Group {
  const g = new Group();
  if (name) g.name = name;
  g.add(boom([0, 0, 0], [side * (root + 0.02), 0, 0], 0.05));
  for (let i = 0; i < n; i++) {
    const x = side * (root + pw / 2 + i * (pw + gap));
    g.add(panel(pw, ph, [x, 0, 0], cells));
  }
  return g;
}

function group(...objs: Object3D[]): Group {
  const g = new Group();
  g.add(...objs);
  return g;
}

// ------------------------------------------------------------------------------ sonde
function europaClipper(): Group {
  const m = M();
  const g = group(
    cyl(0.78, 0.78, 3.0, m.silver, [0, 0, 0]),             // modulo di propulsione
    box(1.6, 0.9, 1.6, m.gold, [0, 1.1, 0]),                // "cassaforte" dell'elettronica
    cyl(0.55, 0.7, 0.5, m.dark, [0, -1.7, 0]),              // motori
    dish(3.0, 0.42, [0, 1.6, 0]),
    box(0.6, 0.5, 0.5, m.black, [0.9, 0.6, 0.7]),           // strumenti
    box(0.5, 0.6, 0.4, m.gold, [-0.9, 0.2, -0.7]),
  );
  // pannelli: 5 per ala, 14,2 m x 4,1 m; le antenne del radar REASON lungo i bordi
  for (const s of [1, -1] as const) {
    const w = wing(s, 1.0, 5, 2.76, 4.1, 0.1, undefined);
    w.position.y = 0.3;
    g.add(w);
    for (const z of [2.25, -2.25]) g.add(box(17.6, 0.05, 0.12, m.white, [s * 9.4, 0.32, z]));
  }
  g.add(boom([0, -0.5, 0.75], [0, -0.5, 9.2], 0.04));      // magnetometro
  return g;
}

function juice(): Group {
  const m = M();
  const g = group(
    box(2.6, 2.6, 4.1, m.black, [0, 0, 0]),
    box(2.7, 0.15, 4.2, m.gold, [0, 1.35, 0]),
    dish(2.5, 0.35, [0, 1.45, 0]),
    box(0.8, 0.6, 0.8, m.gold, [0.8, 0.4, 2.3]),
    cyl(0.45, 0.6, 0.5, m.dark, [0, -1.55, 0]),
  );
  for (const s of [1, -1] as const) {
    const w = wing(s, 1.4, 5, 2.4, 3.5, 0.1);
    w.position.y = 0.2;
    g.add(w);
  }
  g.add(boom([0, 0.9, -2.05], [0, 0.9, -12.6], 0.035));     // magnetometro (10,6 m)
  g.add(box(0.06, 0.06, 16, m.white, [1.35, -1.0, 0]));     // antenna del radar RIME (16 m)
  return g;
}

function bepiColombo(): Group {
  const m = M();
  // in viaggio: modulo di trasferimento (MTM), orbiter ESA (MPO), schermo MOSIF e Mio (JAXA)
  const g = group(
    box(3.6, 1.8, 3.6, m.gold, [0, -2.2, 0]),               // MTM
    cyl(0.5, 0.7, 0.6, m.dark, [0, -3.4, 0]),
    box(2.4, 2.2, 2.6, m.silver, [0, -0.2, 0]),             // MPO
    box(0.08, 3.6, 1.7, m.white, [1.25, -0.2, 0]),          // radiatore dell'MPO
    cyl(1.25, 1.75, 1.3, m.white, [0, 1.55, 0], 'y', 8),    // MOSIF
    cyl(0.9, 0.9, 1.1, m.silver, [0, 2.7, 0], 'y', 8),      // Mio
  );
  // pannelli del modulo di trasferimento: due ali lunghe (14 m)
  for (const s of [1, -1] as const) {
    const w = wing(s, 1.9, 4, 3.3, 2.6, 0.1);
    w.position.y = -2.2;
    g.add(w);
  }
  // l'ala dell'MPO (una sola, inclinata)
  const mpo = wing(-1, 1.3, 3, 2.4, 1.6, 0.06);
  mpo.position.set(0, -0.2, 0);
  mpo.rotation.x = 0.5;
  g.add(mpo);
  return g;
}

function solarOrbiter(): Group {
  const m = M();
  const g = group(
    box(2.5, 3.1, 2.7, m.gold, [0, 0, 0]),
    // lo scudo termico (verso il Sole, -Y): fogli neri su una struttura chiara
    box(3.1, 0.18, 2.4, m.black, [0, -1.95, 0]),
    box(2.8, 0.25, 2.2, m.silver, [0, -1.7, 0]),
    dish(1.1, 0.16, [1.25, 1.2, 0.8], [1, 0.4, 0.2]),
  );
  for (const s of [1, -1] as const) {
    const w = wing(s, 1.35, 3, 2.5, 1.2, 0.08);
    w.position.y = 0.4;
    w.rotation.x = 0.35; // ali un po' inclinate, per non scaldarsi troppo vicino al Sole
    g.add(w);
  }
  g.add(boom([0, 1.4, -1.0], [0, 1.4, -5.4], 0.03));        // asta degli strumenti (4,4 m)
  return g;
}

function lucy(): Group {
  const m = M();
  const g = group(
    box(1.8, 2.0, 1.8, m.gold, [0, 0, 0]),
    dish(2.0, 0.3, [0, 1.05, 0]),
    box(0.9, 0.7, 0.6, m.black, [0, -0.3, 1.25]),           // piattaforma degli strumenti
    cyl(0.4, 0.55, 0.4, m.dark, [0, -1.2, 0]),
  );
  // i due grandi pannelli circolari (7,3 m)
  for (const s of [1, -1]) {
    g.add(boom([s * 0.9, 0, 0], [s * 1.3, 0, 0], 0.07));
    const d = new Mesh(new CircleGeometry(3.65, 48), M().fan);
    d.rotation.x = -Math.PI / 2;
    d.position.set(s * 4.95, 0, 0);
    g.add(d);
    g.add(cyl(0.12, 0.12, 0.3, m.dark, [s * 4.95, -0.1, 0]));
  }
  return g;
}

function psyche(): Group {
  const m = M();
  const g = group(
    box(2.4, 2.2, 2.4, m.gold, [0, 0, 0]),
    dish(2.0, 0.28, [0, 1.15, 0]),
    box(0.7, 0.6, 0.7, m.black, [0.6, -0.2, 1.4]),
    cyl(0.3, 0.45, 0.4, m.dark, [0, -1.25, 0]),
  );
  // ali "a croce": quattro pannelli in fila e due di lato a quello centrale
  for (const s of [1, -1] as const) {
    const w = wing(s, 1.3, 4, 2.45, 2.45, 0.08);
    w.position.y = 0.3;
    const xc = s * (1.3 + 2.45 * 2.5 + 0.08 * 2);
    w.add(panel(2.45, 2.45, [xc, 0, 2.53]), panel(2.45, 2.45, [xc, 0, -2.53]));
    g.add(w);
  }
  return g;
}

function hera(): Group {
  const m = M();
  const g = group(
    box(1.6, 1.7, 1.6, m.gold, [0, 0, 0]),
    dish(1.13, 0.16, [0, 0.9, 0]),
    box(0.4, 0.4, 0.4, m.black, [0.5, 0.3, 0.95]),
    box(0.5, 0.25, 0.4, m.silver, [-0.4, -0.95, 0.3]),      // i due CubeSat (Juventas, Milani)
  );
  for (const s of [1, -1] as const) {
    const w = wing(s, 0.85, 2, 2.0, 1.45, 0.06);
    w.position.y = 0.2;
    g.add(w);
  }
  return g;
}

function gaia(): Group {
  const m = M();
  const g = new Group();
  // lo schermo parasole (10 m, dodici pannelli): verso il Sole (-Y) le celle solari
  const shield = new Mesh(new CylinderGeometry(5.1, 5.1, 0.06, 12), [m.panelBack, m.white, m.cells]);
  g.add(place(shield, [0, -0.5, 0]));
  g.add(cyl(1.9, 1.9, 0.9, m.silver, [0, 0.0, 0], 'y', 6));      // modulo di servizio
  g.add(cyl(1.6, 1.9, 2.4, m.black, [0, 1.65, 0], 'y', 10));     // "tenda" termica del telescopio
  g.add(cyl(1.0, 1.0, 0.1, m.dark, [0, 2.9, 0], 'y', 10));
  return g;
}

function roadster(): Group {
  const m = M();
  const g = new Group();
  // fiancata (estrusa per la larghezza, 1,8 m): muso basso a +X, coda corta, abitacolo aperto
  const s = new Shape();
  s.moveTo(-1.95, 0.2);
  s.lineTo(-1.98, 0.6);
  s.quadraticCurveTo(-1.9, 0.78, -1.4, 0.8);
  s.lineTo(0.55, 0.8);
  s.quadraticCurveTo(1.5, 0.72, 1.92, 0.5);
  s.quadraticCurveTo(2.0, 0.3, 1.9, 0.2);
  s.lineTo(-1.95, 0.2);
  const body = new Mesh(new ExtrudeGeometry(s, { depth: 1.56, bevelEnabled: true, bevelSize: 0.12, bevelThickness: 0.12, bevelSegments: 4, curveSegments: 10 }), m.red);
  body.position.z = -0.78;
  g.add(body);
  // abitacolo aperto (scuro), parabrezza inclinato, fari e luci posteriori
  g.add(box(1.5, 0.06, 1.3, m.tire, [-0.35, 0.91, 0]));
  g.add(box(0.06, 0.38, 1.36, m.glass, [0.48, 1.06, 0], [0, 0, 0.75]));
  for (const z of [-0.55, 0.55]) {
    g.add(box(0.08, 0.06, 0.3, m.white, [2.03, 0.52, z]));
    g.add(box(0.06, 0.08, 0.32, m.red, [-2.08, 0.66, z]));
  }
  for (const x of [-1.25, 1.3]) for (const z of [-0.88, 0.88]) {
    g.add(cyl(0.33, 0.33, 0.24, m.tire, [x, 0.33, z], 'z', 24));
    g.add(cyl(0.2, 0.2, 0.26, m.silver, [x, 0.33, z], 'z', 16));
  }
  // Starman al posto di guida, con un braccio appoggiato alla portiera
  g.add(box(0.34, 0.55, 0.4, m.suit, [-0.45, 1.18, -0.33], [0, 0, 0.25]));
  g.add(place(new Mesh(new SphereGeometry(0.17, 18, 12), m.suit), [-0.38, 1.55, -0.33]));
  g.add(place(new Mesh(new SphereGeometry(0.135, 18, 12), m.glass), [-0.27, 1.56, -0.33]));
  g.add(box(0.55, 0.1, 0.1, m.suit, [-0.4, 1.08, -0.7], [0, 0.2, 0]));
  g.position.y = -0.7;
  return group(g);
}

function tiangong(): Group {
  const m = M();
  const g = new Group();
  // modulo centrale Tianhe lungo X (+X = prua), nodo sferico davanti
  g.add(cyl(2.1, 2.1, 9.5, m.white, [-4.5, 0, 0], 'x'));
  g.add(cyl(1.4, 1.4, 5.0, m.white, [2.75, 0, 0], 'x'));
  g.add(place(new Mesh(new SphereGeometry(1.45, 24, 16), m.white), [6.2, 0, 0]));
  // Shenzhou e Tianzhou attraccate alle estremità
  g.add(cyl(1.1, 1.3, 7.5, m.silver, [11.3, 0, 0], 'x'));
  g.add(cyl(1.6, 1.6, 9.0, m.silver, [-13.8, 0, 0], 'x'));
  // laboratori Wentian e Mengtian ai lati del nodo (asse Z), coi pannelli giganti in fondo
  for (const s of [1, -1] as const) {
    g.add(cyl(2.1, 2.1, 17.9, m.white, [6.2, 0, s * 10.4], 'z'));
    const j = new Group();
    j.name = `CSS_WING_ROT_${s > 0 ? 'W' : 'M'}`;
    j.position.set(6.2, 0, s * 17.5);
    for (const x of [1, -1] as const) {
      // due ali flessibili di circa 27 m per laboratorio, lungo X
      const w = wing(x, 2.4, 1, 26.5, 4.2, 0, M().cellsRosa);
      j.add(w);
    }
    g.add(j);
  }
  return g;
}

// ------------------------------------------------------------------------ catalogo
type ProcSpec = Omit<ModelSpec, 'file' | 'size_m' | 'radius_m' | 'procedural'> & { build: () => Group };

const ESA = 'https://www.esa.int/';
/** fonte delle dimensioni: la pagina della missione */
const credit = (fonte: string, url: string): ModelSpec['credit'] => ({
  fonte, url, licenza: '', licenza_url: '', autori: 'Atlante Celeste', originale: '',
});

export const PROCEDURAL: Record<string, ProcSpec> = {
  clipper: {
    name: 'Europa Clipper', build: europaClipper,
    credit: credit('NASA/JPL-Caltech', 'https://science.nasa.gov/mission/europa-clipper/'),
    note: t('La sonda più grande mai costruita dalla NASA per un altro pianeta: i pannelli solari, aperti, misurano 30 metri, e sono rivolti verso il Sole.'),
    attitude: { primary: { axis: [0, 1, 0], to: 'sun' }, secondary: { axis: [0, 0, 1], to: 'eclnorth' } },
  },
  juice: {
    name: 'JUICE', build: juice,
    credit: credit('ESA', 'https://www.esa.int/Science_Exploration/Space_Science/Juice'),
    note: t('85 m² di pannelli solari, rivolti verso il Sole, per lavorare con la sua luce debole attorno a Giove. Nel Sistema Solare interno l\'antenna grande fa anche da ombrello.'),
    attitude: { primary: { axis: [0, 1, 0], to: 'sun' }, secondary: { axis: [0, 0, 1], to: 'eclnorth' } },
  },
  bepi: {
    name: 'BepiColombo', build: bepiColombo,
    credit: credit('ESA/JAXA', 'https://www.esa.int/Science_Exploration/Space_Science/BepiColombo'),
    note: t('In viaggio le tre parti sono impilate: il modulo di trasferimento con i pannelli lunghi, l\'orbiter europeo MPO e, sotto lo schermo conico, l\'orbiter giapponese Mio. I pannelli guardano il Sole.'),
    attitude: { primary: { axis: [0, 1, 0], to: 'sun' }, secondary: { axis: [0, 0, 1], to: 'eclnorth' } },
  },
  solo: {
    name: 'Solar Orbiter', build: solarOrbiter,
    credit: credit('ESA/NASA', 'https://www.esa.int/Science_Exploration/Space_Science/Solar_Orbiter'),
    note: t('Lo scudo termico, sempre rivolto verso il Sole, protegge la sonda da temperature fino a 500 °C; dalle sue aperture guardano i telescopi.'),
    attitude: { primary: { axis: [0, -1, 0], to: 'sun' }, secondary: { axis: [0, 0, 1], to: 'eclnorth' } },
    view: { phase_deg: 70, elev_deg: 25 },
  },
  lucy: {
    name: 'Lucy', build: lucy,
    credit: credit('NASA/SwRI', 'https://science.nasa.gov/mission/lucy/'),
    note: t('I due pannelli circolari, larghi più di 7 metri, si aprono come ventagli; sono rivolti verso il Sole.'),
    attitude: { primary: { axis: [0, 1, 0], to: 'sun' }, secondary: { axis: [0, 0, 1], to: 'eclnorth' } },
  },
  psyche: {
    name: 'Psyche', build: psyche,
    credit: credit('NASA/JPL-Caltech', 'https://science.nasa.gov/mission/psyche/'),
    note: t('Le ali a croce dei pannelli solari alimentano i motori a ioni, che spingono la sonda verso l\'asteroide metallico Psiche.'),
    attitude: { primary: { axis: [0, 1, 0], to: 'sun' }, secondary: { axis: [0, 0, 1], to: 'eclnorth' } },
  },
  hera: {
    name: 'Hera', build: hera,
    credit: credit('ESA', 'https://www.esa.int/Space_Safety/Hera'),
    note: t('Grande come una scrivania, porta con sé due CubeSat. Va a vedere che cosa ha lasciato la sonda DART sull\'asteroide Dimorfo.'),
    attitude: { primary: { axis: [0, 1, 0], to: 'sun' }, secondary: { axis: [0, 0, 1], to: 'eclnorth' } },
  },
  gaia: {
    name: 'Gaia', build: gaia,
    credit: credit('ESA', ESA + 'Science_Exploration/Space_Science/Gaia'),
    note: t('Lo schermo parasole di 10 metri tiene all\'ombra il telescopio. Gaia girava su se stessa ogni sei ore per misurare un miliardo di stelle; dal 2025 è spenta.'),
    attitude: { primary: { axis: [0, -1, 0], to: 'sun' }, secondary: { axis: [0, 0, 1], to: 'eclnorth' } },
    spin_rpm: 1 / 360,
    view: { phase_deg: 120, elev_deg: 35 },
  },
  roadster: {
    name: 'Tesla Roadster', build: roadster,
    credit: credit('Wikipedia', 'https://it.wikipedia.org/wiki/Tesla_Roadster_di_Elon_Musk'),
    note: t('Lanciata nel 2018 dal primo Falcon Heavy, con il manichino «Starman» al volante: gira attorno al Sole fra la Terra e Marte, rotolando lentamente su se stessa.'),
    attitude: { primary: { axis: [0.3, 0.9, 0.3], to: 'eclnorth' }, secondary: { axis: [1, 0, 0], to: 'sun' } },
    spin_rpm: 0.2,
    frame_m: 2.6,
  },
  tiangong: {
    name: 'Tiangong', build: tiangong,
    credit: credit('Wikipedia', 'https://it.wikipedia.org/wiki/Stazione_spaziale_Tiangong'),
    note: t('La stazione cinese a forma di T: il modulo centrale Tianhe e i laboratori Wentian e Mengtian, con i loro pannelli solari giganti che seguono il Sole.'),
    attitude: { primary: { axis: [0, 1, 0], to: 'nadir' }, secondary: { axis: [1, 0, 0], to: 'velocity' } },
    trackers: [{ match: 'CSS_WING_ROT', axis: [0, 0, 1], normal: [0, 1, 0] }],
    view: { phase_deg: 60, elev_deg: 35 },
  },
};

export const PROCEDURAL_BODIES: Record<string, string> = {
  'naif:-159': 'clipper',
  'naif:-28': 'juice',
  'naif:-121': 'bepi',
  'naif:-144': 'solo',
  'naif:-49': 'lucy',
  'naif:-255': 'psyche',
  'naif:-91': 'hera',
  'naif:-139479': 'gaia',
  'naif:-143205': 'roadster',
  'norad:48274': 'tiangong',
};
