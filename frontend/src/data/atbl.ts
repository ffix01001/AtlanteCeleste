/** Lettore del formato binario ATBL (vedi backend/atlante/binpack.py). */

type TypedArray = Float64Array | Float32Array | Uint8Array | Uint32Array | Int32Array | Uint16Array | Int16Array;

const CTORS: Record<string, new (buf: ArrayBuffer, off: number, len: number) => TypedArray> = {
  f8: Float64Array,
  f4: Float32Array,
  u1: Uint8Array,
  u2: Uint16Array,
  i2: Int16Array,
  u4: Uint32Array,
  i4: Int32Array,
};

export interface Atbl<M = Record<string, any>> {
  meta: M;
  cols: Record<string, TypedArray>;
}

export function parseAtbl<M = Record<string, any>>(buf: ArrayBuffer): Atbl<M> {
  const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 4));
  if (magic !== 'ATBL') throw new Error('File binario non riconosciuto');
  const dv = new DataView(buf);
  const jlen = dv.getUint32(8, true);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, jlen)));
  const base = 12 + jlen;
  const cols: Record<string, TypedArray> = {};
  for (const c of meta.columns as { name: string; dtype: string; offset: number; count: number }[]) {
    const Ctor = CTORS[c.dtype];
    if (!Ctor) throw new Error(`Tipo di colonna non gestito: ${c.dtype}`);
    cols[c.name] = new Ctor(buf, base + c.offset, c.count);
  }
  return { meta, cols };
}
