/* ═══════════════════════════════════════════════════════════════════════════
   Binary container for SceneDesc (and any plain JSON-able object holding
   typed arrays): bake in Node, ship to a worker / ThreeRT, load anywhere.

   Layout (little-endian):
     0   'B5SD'                magic (4 bytes)
     4   u32 container version (= 1)
     8   u32 header byte length H
     12  header: UTF-8 JSON, padded with spaces to a multiple of 8
     12+H' blobs: every typed array's bytes, each starting on an 8-byte
           boundary (relative to the start of the container)
   In the JSON a typed array is replaced by {"$ta": tag, "o": offset, "n": length}
   (tag: f32 f64 u32 u16 u8 u8c i32 i16 i8). Identical array objects are stored
   once and come back as ONE shared array (the traffic / lift meshes share
   their matrices on purpose). A sub-view (subarray) is stored by value.

   QuickJS-safe: no TextEncoder/TextDecoder/structuredClone — UTF-8 is coded
   by hand; only DataView/typed arrays are used.
   ═══════════════════════════════════════════════════════════════════════════ */

type TA = Float32Array | Float64Array | Uint32Array | Uint16Array | Uint8Array | Uint8ClampedArray
  | Int32Array | Int16Array | Int8Array;

const MAGIC = [0x42, 0x35, 0x53, 0x44];   // 'B5SD'
const VERSION = 1;

interface TaCtor { new (buf: ArrayBuffer, off: number, len: number): TA; new (len: number): TA; BYTES_PER_ELEMENT: number }

function tagOf(a: unknown): string | null {
  if (a instanceof Float32Array) return 'f32';
  if (a instanceof Float64Array) return 'f64';
  if (a instanceof Uint32Array) return 'u32';
  if (a instanceof Uint16Array) return 'u16';
  if (a instanceof Uint8ClampedArray) return 'u8c';
  if (a instanceof Uint8Array) return 'u8';
  if (a instanceof Int32Array) return 'i32';
  if (a instanceof Int16Array) return 'i16';
  if (a instanceof Int8Array) return 'i8';
  return null;
}
const CTORS: Record<string, TaCtor> = {
  f32: Float32Array as unknown as TaCtor, f64: Float64Array as unknown as TaCtor,
  u32: Uint32Array as unknown as TaCtor, u16: Uint16Array as unknown as TaCtor,
  u8: Uint8Array as unknown as TaCtor, u8c: Uint8ClampedArray as unknown as TaCtor,
  i32: Int32Array as unknown as TaCtor, i16: Int16Array as unknown as TaCtor, i8: Int8Array as unknown as TaCtor
};

/* ─── UTF-8 ─── */
export function utf8Encode(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d < 0xe000) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}

export function utf8Decode(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length;) {
    const c = b[i++];
    let cp: number;
    if (c < 0x80) cp = c;
    else if (c < 0xe0) cp = ((c & 31) << 6) | (b[i++] & 63);
    else if (c < 0xf0) { cp = ((c & 15) << 12) | ((b[i] & 63) << 6) | (b[i + 1] & 63); i += 2; }
    else { cp = ((c & 7) << 18) | ((b[i] & 63) << 12) | ((b[i + 1] & 63) << 6) | (b[i + 2] & 63); i += 3; }
    if (cp >= 0x10000) {
      cp -= 0x10000;
      s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023));
    } else s += String.fromCharCode(cp);
  }
  return s;
}

/* ─── write ─── */

/** Serialize a plain object graph with typed arrays into one byte buffer. */
export function serializeScene(obj: unknown): Uint8Array {
  const blobs: TA[] = [];
  const ids = new Map<TA, number>();
  const offsets: number[] = [];
  let blobBytes = 0;
  const walk = (v: unknown): unknown => {
    const tag = tagOf(v);
    if (tag) {
      const a = v as TA;
      let id = ids.get(a);
      if (id === undefined) {
        id = blobs.length;
        ids.set(a, id);
        blobs.push(a);
        blobBytes += (8 - (blobBytes % 8)) % 8;
        offsets.push(blobBytes);
        blobBytes += a.byteLength;
      }
      return { $ta: tag, o: offsets[id], n: a.length };
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) throw new Error('serializeScene: unsupported binary type');
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v)) {
        const x = (v as Record<string, unknown>)[k];
        if (x !== undefined) out[k] = walk(x);
      }
      return out;
    }
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('serializeScene: non-finite number');
    return v;
  };
  const header = walk(obj);
  let hb = utf8Encode(JSON.stringify(header));
  const pad = (8 - ((12 + hb.length) % 8)) % 8;
  if (pad) {
    const p = new Uint8Array(hb.length + pad);
    p.set(hb);
    p.fill(0x20, hb.length);
    hb = p;
  }
  const base = 12 + hb.length;                 // multiple of 8
  const out = new Uint8Array(base + blobBytes + (8 - (blobBytes % 8)) % 8);
  out.set(MAGIC, 0);
  const dv = new DataView(out.buffer);
  dv.setUint32(4, VERSION, true);
  dv.setUint32(8, hb.length, true);
  out.set(hb, 12);
  for (let i = 0; i < blobs.length; i++) {
    const a = blobs[i];
    out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), base + offsets[i]);
  }
  return out;
}

/* ─── read ─── */

/**
 * Inverse of serializeScene. Typed arrays are COPIED out of `bytes` (so the
 * result owns aligned buffers and `bytes` may be released). Shared arrays
 * stay shared.
 */
export function deserializeScene<T = unknown>(bytes: Uint8Array): T {
  for (let i = 0; i < 4; i++) if (bytes[i] !== MAGIC[i]) throw new Error('deserializeScene: bad magic');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ver = dv.getUint32(4, true);
  if (ver !== VERSION) throw new Error('deserializeScene: unsupported version ' + ver);
  const hl = dv.getUint32(8, true);
  const header = JSON.parse(utf8Decode(bytes.subarray(12, 12 + hl))) as unknown;
  const base = 12 + hl;
  const cache = new Map<string, TA>();
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const r = v as Record<string, unknown>;
      if (typeof r.$ta === 'string') {
        const key = r.$ta + ':' + r.o;
        let a = cache.get(key);
        if (!a) {
          const C = CTORS[r.$ta];
          if (!C) throw new Error('deserializeScene: unknown array tag ' + r.$ta);
          const n = r.n as number;
          a = new C(n);
          const src = bytes.subarray(base + (r.o as number), base + (r.o as number) + n * C.BYTES_PER_ELEMENT);
          new Uint8Array(a.buffer).set(src);
          cache.set(key, a);
        }
        return a;
      }
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(r)) out[k] = walk(r[k]);
      return out;
    }
    return v;
  };
  return walk(header) as T;
}
