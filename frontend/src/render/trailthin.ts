/**
 * Semplificazione di una traiettoria lunga, vista da una certa posizione della camera.
 *
 * È l'algoritmo di Douglas–Peucker, con l'errore misurato come lo vede chi guarda: un punto
 * si può togliere se dista dalla corda che lo sostituisce meno di `tol` radianti (cioè meno
 * di qualche decimo di pixel sullo schermo). Da lontano restano pochi punti e segmenti lunghi
 * (niente segmenti più corti di un pixel, che diventerebbero puntini che sfarfallano); da
 * vicino restano tutti i punti che servono.
 *
 * I punti in uscita sono riferiti alla camera, calcolati in doppia precisione: così in
 * virgola mobile a 32 bit restano precisi proprio dove serve, vicino a chi guarda.
 */
let rel = new Float64Array(0);
let dist = new Float64Array(0);
let keep = new Uint8Array(0);
let stack = new Int32Array(0);

export function thinTrail(
  src: Float64Array, alpha: ArrayLike<number>, camX: number, camY: number, camZ: number, tol: number,
  out: Float32Array, outAlpha: Float32Array,
): { count: number; near: number } {
  const n = alpha.length;
  if (rel.length < n * 3) {
    rel = new Float64Array(n * 3);
    dist = new Float64Array(n);
    keep = new Uint8Array(n);
    stack = new Int32Array(n * 2 + 4);
  }
  let near = Infinity;
  for (let i = 0; i < n; i++) {
    const x = src[i * 3] - camX, y = src[i * 3 + 1] - camY, z = src[i * 3 + 2] - camZ;
    rel[i * 3] = x;
    rel[i * 3 + 1] = y;
    rel[i * 3 + 2] = z;
    const d = Math.sqrt(x * x + y * y + z * z);
    dist[i] = Math.max(d, 1e-9);
    if (d < near) near = d;
    keep[i] = 0;
  }
  if (n === 0) return { count: 0, near };
  let iNear = -1;
  // distanza minima dalla linea (non solo dai punti): da vicino a una sonda la camera può
  // stare a pochi km dalla traiettoria e a milioni di km dai punti più vicini
  for (let i = 0; i + 1 < n; i++) {
    const ax = rel[i * 3], ay = rel[i * 3 + 1], az = rel[i * 3 + 2];
    const vx = rel[i * 3 + 3] - ax, vy = rel[i * 3 + 4] - ay, vz = rel[i * 3 + 5] - az;
    const vv = vx * vx + vy * vy + vz * vz;
    let t = vv > 0 ? -(ax * vx + ay * vy + az * vz) / vv : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = ax + t * vx, dy = ay + t * vy, dz = az + t * vz;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < near) {
      near = d;
      iNear = i;
    }
  }
  keep[0] = 1;
  keep[n - 1] = 1;
  let sp = 0;
  if (iNear >= 0) {
    // il tratto più vicino alla camera si tiene sempre: l'errore si misura sui punti, ma da
    // vicino è lungo il segmento (fra due punti) che una corda si allontanerebbe di più
    keep[iNear] = 1;
    keep[iNear + 1] = 1;
    stack[sp++] = 0;
    stack[sp++] = iNear;
    stack[sp++] = iNear + 1;
    stack[sp++] = n - 1;
  } else {
    stack[sp++] = 0;
    stack[sp++] = n - 1;
  }
  while (sp > 0) {
    const b = stack[--sp];
    const a = stack[--sp];
    if (b - a < 2) continue;
    const ax = rel[a * 3], ay = rel[a * 3 + 1], az = rel[a * 3 + 2];
    const vx = rel[b * 3] - ax, vy = rel[b * 3 + 1] - ay, vz = rel[b * 3 + 2] - az;
    const vv = vx * vx + vy * vy + vz * vz;
    let worst = -1, wi = -1;
    for (let j = a + 1; j < b; j++) {
      const wx = rel[j * 3] - ax, wy = rel[j * 3 + 1] - ay, wz = rel[j * 3 + 2] - az;
      let t = vv > 0 ? (wx * vx + wy * vy + wz * vz) / vv : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = wx - t * vx, dy = wy - t * vy, dz = wz - t * vz;
      // distanza dalla corda vista dalla camera (angolo, approssimato)
      const e = Math.sqrt(dx * dx + dy * dy + dz * dz) / dist[j];
      if (e > worst) {
        worst = e;
        wi = j;
      }
    }
    if (worst > tol) {
      keep[wi] = 1;
      stack[sp++] = a;
      stack[sp++] = wi;
      stack[sp++] = wi;
      stack[sp++] = b;
    }
  }
  let k = 0;
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    out[k * 3] = rel[i * 3];
    out[k * 3 + 1] = rel[i * 3 + 1];
    out[k * 3 + 2] = rel[i * 3 + 2];
    outAlpha[k] = alpha[i];
    k++;
  }
  return { count: k, near };
}
