import { test } from 'node:test';
import assert from 'node:assert/strict';
import { thinTrail } from '../src/render/trailthin.ts';

const AU = 149597870.7;
const N = 1601;

/** traiettoria finta lunga 160 UA, un punto ogni 0,1 UA (come Voyager 1 a passi di 10 giorni) */
function fake(): Float64Array {
  const src = new Float64Array(N * 3);
  for (let i = 0; i < N; i++) {
    src[i * 3] = i * 0.1 * AU;
    src[i * 3 + 1] = 0.3 * AU * Math.sin(i / 200);
  }
  return src;
}
const alpha = new Float32Array(N).fill(0.5);

test('traiettoria lontana: restano solo i punti che servono', () => {
  const out = new Float32Array(N * 3), oa = new Float32Array(N);
  // vista dal Sistema Solare interno, 1000 pixel per radiante, errore di mezzo pixel
  const { count } = thinTrail(fake(), alpha, 0, 0, 3 * AU, 0.5 / 1000, out, oa);
  assert.ok(count < 200 && count >= 2, `punti tenuti: ${count}`);
});

test('da vicino alla sonda i punti sono riferiti alla camera (precisione piena)', () => {
  const out = new Float32Array(N * 3), oa = new Float32Array(N);
  // camera a 1000 km dall'ultimo punto (a 160 UA dal Sole)
  const src = fake();
  const lx = src[(N - 1) * 3], ly = src[(N - 1) * 3 + 1];
  const { count, near } = thinTrail(src, alpha, lx, ly + 1000, 0, 0.5 / 1000, out, oa);
  assert.ok(near <= 1000 + 1e-6 && near > 100, `${near}`);
  assert.ok(Math.abs(out[(count - 1) * 3]) < 1e-3 && Math.abs(out[(count - 1) * 3 + 1] + 1000) < 1e-3);
});

test('vista da vicino: nessun punto tolto se la linea si allontanerebbe dalla traiettoria vera', () => {
  const out = new Float32Array(N * 3), oa = new Float32Array(N);
  const src = fake();
  // camera a 1000 km dal punto 800, a metà della traiettoria curva
  const cx = src[800 * 3], cy = src[800 * 3 + 1] + 1000;
  const { count } = thinTrail(src, alpha, cx, cy, 0, 0.5 / 1000, out, oa);
  // ogni punto tenuto, ricostruito, deve stare sulla traiettoria: verifico che fra i punti
  // tenuti ci siano i vicini del punto 800 (altrimenti la corda passerebbe lontana)
  let found = false;
  for (let k = 0; k < count; k++) if (Math.abs(out[k * 3]) < 0.2 * AU && Math.abs(out[k * 3 + 1] + 1000) < 0.01 * AU) found = true;
  assert.ok(found);
});
