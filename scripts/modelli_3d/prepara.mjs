/**
 * Prepara i modelli 3D delle sonde e dei satelliti per Atlante Celeste.
 *
 * Fonte: NASA 3D Resources (https://github.com/nasa/NASA-3D-Resources), modelli liberi da
 * diritti (linee guida d'uso dei media NASA). Lo script:
 *   1. scarica i modelli da una versione fissa del repository (in data/sources/modelli_3d,
 *      così una seconda esecuzione non scarica nulla);
 *   2. li porta in metri, con il centro sul corpo della sonda, e corregge i modelli
 *      salvati "allo specchio";
 *   3. unisce i pezzi con lo stesso materiale (poche chiamate di disegno), tenendo separati
 *      solo i giunti che si muovono (i pannelli solari della Stazione che seguono il Sole);
 *   4. semplifica le geometrie, riduce le texture (WebP) e comprime le mesh (meshopt);
 *   5. scrive data/assets/models/<nome>.glb e manifest.json con dimensioni, assetto e crediti.
 *
 * Uso:
 *   cd scripts/modelli_3d
 *   npm install
 *   node prepara.mjs            (tutti)        node prepara.mjs iss juno   (solo alcuni)
 */

import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Logger, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  dedup, join, meshopt, prune, simplify, textureCompress, transformMesh, weld,
} from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SRC_DIR = path.join(ROOT, 'data', 'sources', 'modelli_3d');
const OUT_DIR = path.join(ROOT, 'data', 'assets', 'models');
const COMMIT = '11ebb4ee043715aefbba6aeec8a61746fad67fa7';
const RAW = `https://raw.githubusercontent.com/nasa/NASA-3D-Resources/${COMMIT}/3D%20Models/`;
const RAW_PRINT = `https://raw.githubusercontent.com/nasa/NASA-3D-Resources/${COMMIT}/3D%20Printing/`;
const NASA_CREDIT = {
  fonte: 'NASA 3D Resources',
  url: 'https://science.nasa.gov/3d-resources/',
  licenza: 'Materiale NASA, uso libero (linee guida per i media NASA)',
  licenza_url: 'https://www.nasa.gov/nasa-brand-center/images-and-media/',
};

/**
 * Modelli. `scale`: metri per unità del file. `attitude`: come si orienta nello spazio
 * (assi nel sistema del modello già scalato):
 *   primary   -> l'asse che punta verso il bersaglio principale (Terra, Sole, nadir, ...)
 *   secondary -> l'asse che si allinea, per quanto possibile, al secondo bersaglio
 * `spin_rpm`: rotazione attorno all'asse principale (sonde stabilizzate per rotazione).
 * `trackers`: giunti dei pannelli solari che ruotano per seguire il Sole (nell'ordine).
 */
const MODELS = {
  voyager: {
    src: 'Voyager Probe (B)/Voyager Probe (B).glb',
    name: 'Voyager',
    note: "L'antenna parabolica resta puntata verso la Terra, come sulla sonda vera: è da lì che arrivano, dopo quasi un giorno di viaggio, i suoi segnali.",
    autori: 'NASA/JPL-Caltech',
    scale: 1,
    // l'antenna parabolica (asse +Y) resta puntata verso la Terra
    attitude: { primary: { axis: [0, 1, 0], to: 'earth' }, secondary: { axis: [0, 0, 1], to: 'eclnorth' } },
    // di lato: l'antenna guarda la Terra (cioè quasi il Sole) e coprirebbe tutto il resto
    view: { phase_deg: 80, elev_deg: 20 },
    simplify: { ratio: 0.6, error: 0.0008 },
    tex: 1024,
  },
  pioneer: {
    src: 'Pioneer 10/Pioneer 10.glb',
    name: 'Pioneer 10 e 11',
    note: "L'antenna è puntata verso la Terra e la sonda ruota su se stessa, quasi cinque giri al minuto. Il modello è quello di Pioneer 10; Pioneer 11 è la sua gemella.",
    autori: 'NASA/Ames',
    scale: 1,
    attitude: { primary: { axis: [0, 0, -1], to: 'earth' }, secondary: { axis: [0, -1, 0], to: 'eclnorth' } },
    view: { phase_deg: 80, elev_deg: 20 },
    spin_rpm: 4.8,
    simplify: { ratio: 0.6, error: 0.0008 },
    tex: 1024,
  },
  jwst: {
    src: 'James Webb Space Telescope (B)/James Webb Space Telescope (B).glb',
    name: 'James Webb',
    note: "Lo schermo solare, grande come un campo da tennis, è sempre rivolto verso il Sole: gli specchi dorati restano al buio e al freddo, a circa −230 °C.",
    autori: 'NASA/GSFC',
    scale: 1,
    // lo schermo solare (lato -Y) guarda il Sole; il telescopio (+Z) è perpendicolare
    attitude: { primary: { axis: [0, -1, 0], to: 'sun' }, secondary: { axis: [0, 0, 1], to: 'eclnorth' } },
    // dal lato in ombra si vedono gli specchi dorati (illuminati solo dalla luce diffusa)
    view: { phase_deg: 115, elev_deg: 30 },
    simplify: { ratio: 0.6, error: 0.0008 },
    tex: 1024,
  },
  juno: {
    src: 'Juno (B)/Juno (B).glb',
    name: 'Juno',
    note: "Juno ruota su se stessa (due giri al minuto) con l'antenna verso la Terra, e i tre pannelli solari rivolti al Sole: è la sonda a energia solare arrivata più lontano.",
    autori: 'NASA/JPL-Caltech',
    // il file è un po' fuori scala: così l'antenna misura 2,5 m e le ali dei pannelli circa 9 m
    scale: 0.72,
    // sonda che ruota su se stessa: asse di rotazione e antenna (+Y) verso la Terra
    attitude: { primary: { axis: [0, 1, 0], to: 'earth' }, secondary: { axis: [1, 0, 0], to: 'eclnorth' } },
    spin_rpm: 2,
    simplify: { ratio: 0.7, error: 0.0008 },
    tex: 1024,
  },
  parker: {
    src: 'Parker Solar Probe/Parker Solar Probe.glb',
    name: 'Parker Solar Probe',
    note: "Lo scudo termico, spesso 11 cm, è sempre rivolto verso il Sole: dietro, gli strumenti restano a temperatura ambiente mentre davanti si superano i 1000 °C.",
    autori: 'NASA/Johns Hopkins APL',
    scale: 1,
    // lo scudo termico (lato -Z) sempre verso il Sole
    attitude: { primary: { axis: [0, 0, -1], to: 'sun' }, secondary: { axis: [0, 1, 0], to: 'eclnorth' } },
    simplify: { ratio: 0.6, error: 0.0008 },
    tex: 1024,
  },
  osiris: {
    src: 'Origins, Spectral Interpretation, Resource Identification, and Security - Regolith Explorer (OSIRIS-REx)/OSIRIS-REx.glb',
    name: 'OSIRIS-REx / OSIRIS-APEX',
    note: "Il modello è quello di OSIRIS-REx, che nel 2023 ha riportato sulla Terra i campioni dell'asteroide Bennu; ora, come OSIRIS-APEX, è in viaggio verso Apophis. L'antenna è puntata verso la Terra.",
    autori: 'NASA/Goddard/University of Arizona',
    scale: 0.2,
    attitude: { primary: { axis: [1, 0, 0], to: 'earth' }, secondary: { axis: [0, 1, 0], to: 'eclnorth' } },
    simplify: { ratio: 0.5, error: 0.0008 },
    tex: 1024,
  },
  newhorizons: {
    // non c'è un modello glTF: si monta il modello da stampare in 3D (corpo, antenna, RTG)
    stl: [
      { src: 'New Horizons/7399_05_rp_body.stl', color: [0.71, 0.54, 0.23], metal: 0.55, rough: 0.45 },
      { src: 'New Horizons/7399_05_rp_antenna.stl', color: [0.9, 0.9, 0.88], metal: 0.05, rough: 0.6, at: [0.07, 1.7, 0.58] },
      // l'RTG sporge dalla punta del corpo, in orizzontale
      { src: 'New Horizons/7399_05_rp_rtg.stl', color: [0.22, 0.22, 0.23], metal: 0.4, rough: 0.5, at: [2.6, 0.9, 1.72], axis: [0.913, 0, 0.409] },
    ],
    src: 'New Horizons (stampa 3D)',
    name: 'New Horizons',
    autori: 'NASA/Johns Hopkins APL',
    note: "L'antenna parabolica resta puntata verso la Terra. Dal 2015, quando ha sorvolato Plutone, la sonda si allontana nella fascia di Kuiper.",
    scale: 0.5,
    attitude: { primary: { axis: [0, 1, 0], to: 'earth' }, secondary: { axis: [0, 0, 1], to: 'eclnorth' } },
    view: { phase_deg: 75, elev_deg: 25 },
    simplify: { ratio: 0.8, error: 0.0005 },
    tex: 512,
  },
  hubble: {
    src: 'Hubble Space Telescope (A)/Hubble Space Telescope (A).glb',
    name: 'Hubble',
    note: "Il telescopio è puntato sul campo dell'Hubble Ultra Deep Field, una delle immagini più profonde dell'universo.",
    autori: 'NASA/STScI',
    scale: 0.0254, // pollici
    // punta il campo dell'Hubble Ultra Deep Field; i pannelli ruotano verso il Sole
    attitude: { primary: { axis: [0, 1, 0], to: 'radec:53.1625,-27.7914' }, secondary: { axis: [0, 0, 1], to: 'sun' } },
    simplify: { ratio: 0.6, error: 0.0008 },
    tex: 1024,
  },
  iss: {
    src: 'International Space Station (ISS) (D) (IGOAL)/International Space Station (ISS).glb',
    name: 'Stazione Spaziale Internazionale',
    note: "Vola con un lato sempre rivolto verso la Terra e la prua nel verso del moto; gli otto grandi pannelli solari ruotano sui loro giunti per seguire il Sole. A ogni giro passa circa 35 minuti nell'ombra della Terra, al buio.",
    autori: 'NASA (modello IGOAL, Johnson Space Center)',
    // il file è in pollici, con una scala negativa che lo rende speculare: si sostituisce
    rootScale: { node: 'SSREF_IGOAL', value: 0.0254 },
    scale: 1,
    // corrimano, maniglie e appigli: invisibili da qualche decina di metri, sono quasi metà dei triangoli
    // e i piccoli esperimenti esterni (restano moduli, tralicci, radiatori, batterie e pannelli)
    drop: /Handrail|Handhold|APFR|Bolts|Connector|Connections|Trunnion|Keel|Struts|Decals|DockingTarget|Camera|Umbilical|SunSensor|Ikarus|_ICA|CRPCM|Workstation|TransferHatch|Lettering|IPA_Mod_Kit|Antenna|^Payload_|STP-H|COWVR|GITAI|SPDM|POA_on_MBS|Details(?!.*(Radiator|Batter))/i,
    keep: /ALPHA_ROT|BETA_ROT/,
    // assetto LVLH: il nadir (+Y) verso la Terra, la prua (+X) nel verso del moto
    attitude: { primary: { axis: [0, 1, 0], to: 'nadir' }, secondary: { axis: [1, 0, 0], to: 'velocity' } },
    trackers: [
      // giunti alfa: ruotano attorno all'asse del traliccio (Z) finché le ali sono perpendicolari al Sole
      { match: 'ALPHA_ROT', axis: [0, 0, 1], normal: [0, 1, 0], two_sided: true },
      // giunti beta: ruotano attorno al lato lungo di ogni ala, che si volta verso il Sole
      // (a riposo le ali guardano lungo il traliccio, con le celle rivolte verso il centro della Stazione)
      { match: 'BETA_ROT', axis: [1, 0, 0], normal: 'inward_z' },
    ],
    simplify: { ratio: 0.2, error: 0.001 },
    tex: 512,
    texOther: 256,
    metal: 0.35,
  },
};

// ------------------------------------------------------------------- matrici 4x4 (colonne)
function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}
function invert(m) {
  const inv = new Array(16);
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  const d = 1 / det;
  inv[0] = (a11 * b11 - a12 * b10 + a13 * b09) * d;
  inv[1] = (a02 * b10 - a01 * b11 - a03 * b09) * d;
  inv[2] = (a31 * b05 - a32 * b04 + a33 * b03) * d;
  inv[3] = (a22 * b04 - a21 * b05 - a23 * b03) * d;
  inv[4] = (a12 * b08 - a10 * b11 - a13 * b07) * d;
  inv[5] = (a00 * b11 - a02 * b08 + a03 * b07) * d;
  inv[6] = (a32 * b02 - a30 * b05 - a33 * b01) * d;
  inv[7] = (a20 * b05 - a22 * b02 + a23 * b01) * d;
  inv[8] = (a10 * b10 - a11 * b08 + a13 * b06) * d;
  inv[9] = (a01 * b08 - a00 * b10 - a03 * b06) * d;
  inv[10] = (a30 * b04 - a31 * b02 + a33 * b00) * d;
  inv[11] = (a21 * b02 - a20 * b04 - a23 * b00) * d;
  inv[12] = (a11 * b07 - a10 * b09 - a12 * b06) * d;
  inv[13] = (a00 * b09 - a01 * b07 + a02 * b06) * d;
  inv[14] = (a31 * b01 - a30 * b03 - a32 * b00) * d;
  inv[15] = (a20 * b03 - a21 * b01 + a22 * b00) * d;
  return inv;
}
const apply = (m, v) => [
  m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
  m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
  m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
];

// ------------------------------------------------------------------------------ download
async function source(cfg, base = RAW, dir = SRC_DIR) {
  const file = path.join(dir, path.basename(cfg.src));
  try {
    await stat(file);
    return file;
  } catch { /* da scaricare */ }
  await mkdir(dir, { recursive: true });
  const url = base + cfg.src.split('/').map(encodeURIComponent).join('/');
  console.log(`  scarico ${url}`);
  const res = await fetch(url, { headers: { 'User-Agent': 'AtlanteCeleste/0.2 (scripts/modelli_3d)' } });
  if (!res.ok) throw new Error(`download non riuscito (${res.status}): ${url}`);
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

// ------------------------------------------------------------------------------- STL
/** STL binario -> posizioni e normali (una normale per faccia). */
function readStl(buf) {
  const n = buf.readUInt32LE(80);
  const pos = new Float32Array(n * 9), nor = new Float32Array(n * 9);
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50;
    const nx = buf.readFloatLE(o), ny = buf.readFloatLE(o + 4), nz = buf.readFloatLE(o + 8);
    for (let k = 0; k < 3; k++) {
      for (let c = 0; c < 3; c++) pos[i * 9 + k * 3 + c] = buf.readFloatLE(o + 12 + k * 12 + c * 4);
      nor[i * 9 + k * 3] = nx; nor[i * 9 + k * 3 + 1] = ny; nor[i * 9 + k * 3 + 2] = nz;
    }
  }
  return { pos, nor };
}

/** Quaternione che porta l'asse +Y su `dir`. */
function quatYTo(dir) {
  const [x, y, z] = dir;
  const l = Math.hypot(x, y, z);
  const d = [x / l, y / l, z / l];
  const c = d[1]; // coseno con +Y
  const ax = [d[2], 0, -d[0]]; // +Y × d
  const s = Math.hypot(ax[0], ax[2]);
  if (s < 1e-9) return c > 0 ? [0, 0, 0, 1] : [1, 0, 0, 0];
  const ang = Math.atan2(s, c);
  const k = Math.sin(ang / 2) / s;
  return [ax[0] * k, 0, ax[2] * k, Math.cos(ang / 2)];
}

/** Un documento glTF montato da più pezzi STL, ognuno con il suo colore. */
async function stlDocument(io, cfg) {
  const { Document } = await import('@gltf-transform/core');
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene();
  doc.getRoot().setDefaultScene(scene);
  for (const part of cfg.stl) {
    const file = await source(part, RAW_PRINT, path.join(SRC_DIR, 'new_horizons'));
    const { pos, nor } = readStl(await readFile(file));
    const mat = doc.createMaterial(path.basename(part.src, '.stl'))
      .setBaseColorFactor([...part.color, 1]).setMetallicFactor(part.metal).setRoughnessFactor(part.rough);
    const prim = doc.createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(pos).setBuffer(buffer))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(nor).setBuffer(buffer))
      .setMaterial(mat);
    const node = doc.createNode(path.basename(part.src, '.stl')).setMesh(doc.createMesh().addPrimitive(prim));
    if (part.at) node.setTranslation(part.at);
    if (part.axis) node.setRotation(quatYTo(part.axis));
    scene.addChild(node);
  }
  return doc;
}

// ------------------------------------------------------------------------- elaborazione
function removeTree(node) {
  for (const c of node.listChildren()) removeTree(c);
  node.dispose();
}

/**
 * "Appiattisce" la gerarchia: ogni mesh finisce sotto il giunto mobile più vicino (o sotto la
 * radice), con la trasformazione già applicata ai vertici. Restano solo la radice e i giunti.
 */
function bake(doc, root, keep) {
  const nodes = [];
  root.traverse((n) => nodes.push(n));
  const isGroup = (n) => n === root || (keep && keep.test(n.getName()));
  const world = new Map(nodes.map((n) => [n, n.getWorldMatrix()]));
  const ownerOf = (n) => {
    let p = n.getParentNode();
    while (p && !isGroup(p)) p = p.getParentNode();
    return p ?? root;
  };
  const groups = nodes.filter((n) => n !== root && isGroup(n));
  const owners = new Map(groups.map((g) => [g, ownerOf(g)]));
  const meshNodes = nodes.filter((n) => n.getMesh());
  const meshOwners = new Map(meshNodes.map((n) => [n, isGroup(n) ? n : ownerOf(n)]));
  // giunti: riattaccati al giunto superiore, con la stessa posizione nel mondo
  for (const g of groups) {
    const o = owners.get(g);
    const local = mul(invert(world.get(o)), world.get(g));
    g.getParentNode()?.removeChild(g);
    o.addChild(g);
    g.setMatrix(local);
  }
  // mesh: copie con la trasformazione applicata, figlie del loro giunto
  for (const n of meshNodes) {
    const o = meshOwners.get(n);
    const local = mul(invert(world.get(o)), world.get(n));
    const m = doc.createMesh(n.getMesh().getName());
    for (const p of n.getMesh().listPrimitives()) m.addPrimitive(p);
    transformMesh(m, local);
    o.addChild(doc.createNode().setMesh(m));
  }
  // tutto il resto (i nodi originali) se ne va
  for (const n of nodes) {
    if (n === root || isGroup(n)) {
      if (n.getMesh()) n.setMesh(null);
      continue;
    }
    if (n.getMesh() || n.listChildren().length || n.getParentNode()) {
      n.getParentNode()?.removeChild(n);
      n.dispose();
    }
  }
}

/** Mediana delle posizioni dei vertici (nel sistema della radice): il centro della sonda. */
function medianCenter(root) {
  const xs = [], ys = [], zs = [];
  const visit = (n, m) => {
    const w = mul(m, n.getMatrix());
    const mesh = n.getMesh();
    if (mesh) for (const p of mesh.listPrimitives()) {
      const a = p.getAttribute('POSITION');
      const step = Math.max(1, Math.floor(a.getCount() / 4000));
      const v = [0, 0, 0];
      for (let i = 0; i < a.getCount(); i += step) {
        a.getElement(i, v);
        const q = apply(w, v);
        xs.push(q[0]); ys.push(q[1]); zs.push(q[2]);
      }
    }
    for (const c of n.listChildren()) visit(c, w);
  };
  visit(root, root.getMatrix());
  const med = (a) => { a.sort((x, y) => x - y); return a[Math.floor(a.length / 2)] ?? 0; };
  return [med(xs), med(ys), med(zs)];
}

/** Riquadro e raggio (dal centro) di tutti i vertici, nel sistema della scena. */
function extent(root) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  let r2 = 0, tris = 0;
  const visit = (n) => {
    const w = n.getWorldMatrix();
    const mesh = n.getMesh();
    if (mesh) for (const p of mesh.listPrimitives()) {
      const a = p.getAttribute('POSITION');
      const v = [0, 0, 0];
      for (let i = 0; i < a.getCount(); i++) {
        a.getElement(i, v);
        const q = apply(w, v);
        for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], q[k]); hi[k] = Math.max(hi[k], q[k]); }
        r2 = Math.max(r2, q[0] * q[0] + q[1] * q[1] + q[2] * q[2]);
      }
      tris += (p.getIndices()?.getCount() ?? a.getCount()) / 3;
    }
    for (const c of n.listChildren()) visit(c);
  };
  visit(root);
  return { size: hi.map((h, k) => h - lo[k]), radius: Math.sqrt(r2), tris };
}

async function processModel(io, key, cfg) {
  const t0 = Date.now();
  const doc = cfg.stl ? await stlDocument(io, cfg) : await io.read(await source(cfg));
  doc.setLogger(new Logger(Logger.Verbosity.WARN));
  // si riscrive con meshopt: la compressione Draco dell'originale non serve più
  for (const e of doc.getRoot().listExtensionsUsed()) if (e.extensionName === 'KHR_draco_mesh_compression') e.dispose();
  const rootDoc = doc.getRoot();
  const scene = rootDoc.listScenes()[0];

  if (cfg.drop) {
    let n = 0;
    for (const node of rootDoc.listNodes()) {
      if (!node.isDisposed() && cfg.drop.test(node.getName())) { removeTree(node); n++; }
    }
    console.log(`  tolti ${n} gruppi di dettagli minuti`);
  }
  if (cfg.rootScale) {
    const node = rootDoc.listNodes().find((n) => n.getName() === cfg.rootScale.node);
    const s = cfg.rootScale.value;
    node.setScale([s, s, s]);
  }
  // radice comune: scala in metri (il centro si sistema dopo l'unione)
  const top = doc.createNode('modello').setScale([cfg.scale, cfg.scale, cfg.scale]);
  for (const c of scene.listChildren()) {
    scene.removeChild(c);
    top.addChild(c);
  }
  scene.addChild(top);
  bake(doc, top, cfg.keep);

  // materiali: niente trasparenze ordinate (meglio il ritaglio), metallo più tenue
  for (const m of rootDoc.listMaterials()) {
    if (m.getAlphaMode() === 'BLEND') m.setAlphaMode('MASK').setAlphaCutoff(0.5);
    if (cfg.metal !== undefined) m.setMetallicFactor(Math.min(m.getMetallicFactor(), cfg.metal));
    m.setRoughnessFactor(Math.max(m.getRoughnessFactor(), 0.35));
    if (cfg.dropNormals) m.setNormalTexture(null);
  }

  await doc.transform(
    dedup(),
    prune(),
    join({ keepNamed: false }),
    weld(),
    simplify({ simplifier: MeshoptSimplifier, ratio: cfg.simplify.ratio, error: cfg.simplify.error }),
    prune(),
  );
  // centro sulla sonda (mediana dei vertici: le aste lunghe e sottili non lo spostano)
  const c = medianCenter(top);
  top.setTranslation([-c[0], -c[1], -c[2]]);

  // texture: WebP, i colori a piena risoluzione (fino a cfg.tex), il resto più piccolo
  const other = cfg.texOther ?? cfg.tex;
  await doc.transform(
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [cfg.tex, cfg.tex], quality: 82, slots: /^(baseColor|emissive)/ }),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [other, other], quality: 85, slots: /^(?!baseColor|emissive)/ }),
  );
  const ext = extent(top);
  await MeshoptEncoder.ready;
  await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'high' }));

  const outFile = path.join(OUT_DIR, `${key}.glb`);
  await io.write(outFile, doc);
  const bytes = (await stat(outFile)).size;
  console.log(`  ${key}.glb: ${(bytes / 1e6).toFixed(2)} MB, ${Math.round(ext.tris)} triangoli, `
    + `dimensioni ${ext.size.map((v) => v.toFixed(1)).join(' x ')} m, raggio ${ext.radius.toFixed(1)} m (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  const entry = {
    file: `${key}.glb`,
    name: cfg.name,
    size_m: ext.size.map((v) => +v.toFixed(2)),
    radius_m: +ext.radius.toFixed(2),
    note: cfg.note,
    attitude: cfg.attitude,
    ...(cfg.spin_rpm ? { spin_rpm: cfg.spin_rpm } : {}),
    ...(cfg.view ? { view: cfg.view } : {}),
    ...(cfg.trackers ? { trackers: cfg.trackers } : {}),
    credit: { ...NASA_CREDIT, autori: cfg.autori, originale: cfg.src.split('/').pop() },
  };
  return entry;
}

/** Quali corpi usano quale modello (id del catalogo o NORAD dei satelliti). */
const BODIES = {
  'naif:-31': 'voyager',
  'naif:-32': 'voyager',
  'naif:-23': 'pioneer',
  'naif:-24': 'pioneer',
  'naif:-170': 'jwst',
  'naif:-61': 'juno',
  'naif:-96': 'parker',
  'naif:-64': 'osiris',
  'naif:-98': 'newhorizons',
  'norad:20580': 'hubble',
  'norad:25544': 'iss',
};

async function main() {
  const only = process.argv.slice(2);
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'meshopt.decoder': MeshoptDecoder,
    'meshopt.encoder': MeshoptEncoder,
  });
  await mkdir(OUT_DIR, { recursive: true });
  const manifestFile = path.join(OUT_DIR, 'manifest.json');
  let manifest = { models: {}, bodies: {} };
  try { manifest = JSON.parse(await readFile(manifestFile, 'utf8')); } catch { /* nuovo */ }
  for (const [key, cfg] of Object.entries(MODELS)) {
    if (only.length && !only.includes(key)) continue;
    console.log(`${key}: ${cfg.name}`);
    manifest.models[key] = await processModel(io, key, cfg);
  }
  manifest.bodies = BODIES;
  manifest._descrizione = 'Modelli 3D di sonde e satelliti (scripts/modelli_3d/prepara.mjs). Assi nel sistema del modello, in metri.';
  await writeFile(manifestFile, JSON.stringify(manifest, null, 1) + '\n');
  console.log(`scritto ${path.relative(ROOT, manifestFile)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
