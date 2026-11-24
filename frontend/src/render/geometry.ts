/** Geometrie condivise: sfere per i pianeti e "patate" per asteroidi e nuclei cometari. */

import { BufferGeometry, SphereGeometry, Vector3 } from 'three';

let sphereHi: SphereGeometry | null = null;
let sphereLo: SphereGeometry | null = null;

export function sphere(hi: boolean): SphereGeometry {
  if (hi) return (sphereHi ??= new SphereGeometry(1, 128, 96));
  return (sphereLo ??= new SphereGeometry(1, 48, 32));
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function rng(seed: number): () => number {
  let s = seed || 1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

const cacheIrr = new Map<string, BufferGeometry>();

/**
 * Corpo irregolare: sfera deformata con rumore a bassa frequenza
 * (deterministico: lo stesso asteroide ha sempre la stessa forma).
 *
 * Si parte da una sfera a meridiani e paralleli, come per i pianeti, così le
 * coordinate della texture (longitudine, latitudine) restano le stesse e le
 * mappe vere di Fobos, Eros, Bennu... si posano nel posto giusto.
 * `craters`: aggiunge conche inventate; si usa solo se manca una mappa vera,
 * altrimenti i crateri finti si sovrapporrebbero a quelli fotografati.
 */
export function irregular(id: string, craters = true, roughness = 0.2): BufferGeometry {
  const key = `${id}|${craters ? 1 : 0}`;
  let g = cacheIrr.get(key);
  if (g) return g;
  const rand = rng(hash(id));
  // forma generale: poche onde a bassa frequenza
  const waves: { d: Vector3; f: number; p: number; a: number }[] = [];
  for (let k = 0; k < 7; k++) {
    const d = new Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize();
    waves.push({ d, f: 0.6 + k * 0.55 + rand() * 0.5, p: rand() * Math.PI * 2, a: roughness / (1 + k * 0.9) });
  }
  // crateri: conche morbide con un leggero bordo rialzato
  // (i numeri casuali si estraggono comunque, così la forma generale non cambia)
  const pits: { c: Vector3; r: number; depth: number }[] = [];
  for (let k = 0; k < 18; k++) {
    pits.push({
      c: new Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize(),
      r: 0.08 + rand() * rand() * 0.35,
      depth: 0.015 + rand() * 0.03,
    });
  }
  if (!craters) pits.length = 0;

  /** distanza dal centro della superficie nella direzione (unitaria) v */
  const radial = (v: Vector3): number => {
    let r = 1;
    for (const w of waves) r += w.a * Math.sin(w.f * v.dot(w.d) * Math.PI + w.p);
    for (const c of pits) {
      const t = v.distanceTo(c.c) / c.r;
      if (t < 1.6) {
        const bowl = t < 1 ? (1 - t * t) * (1 - t * t) : 0;
        const rim = Math.exp(-(((t - 1) / 0.18) ** 2)) * 0.35;
        r += c.depth * (rim - bowl);
      }
    }
    return Math.max(0.6, r);
  };

  const geo = new SphereGeometry(1, 128, 96);
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const v = new Vector3(), t1 = new Vector3(), t2 = new Vector3();
  const p0 = new Vector3(), p1 = new Vector3(), p2 = new Vector3();
  const eps = 1e-3;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    p0.copy(v).multiplyScalar(radial(v));
    // normale calcolata dalla forma stessa (due passettini lungo la superficie): identica
    // per i vertici doppi della cucitura e dei poli, quindi nessuna riga visibile
    t1.crossVectors(v, Math.abs(v.y) < 0.99 ? Y_AXIS : X_AXIS).normalize();
    t2.crossVectors(v, t1);
    p1.copy(v).addScaledVector(t1, eps).normalize();
    p1.multiplyScalar(radial(p1));
    p2.copy(v).addScaledVector(t2, eps).normalize();
    p2.multiplyScalar(radial(p2));
    p1.sub(p0);
    p2.sub(p0);
    t1.crossVectors(p1, p2).normalize();
    pos.setXYZ(i, p0.x, p0.y, p0.z);
    nor.setXYZ(i, t1.x, t1.y, t1.z);
  }
  geo.computeBoundingSphere();
  cacheIrr.set(key, geo);
  return geo;
}

const X_AXIS = new Vector3(1, 0, 0);
const Y_AXIS = new Vector3(0, 1, 0);
