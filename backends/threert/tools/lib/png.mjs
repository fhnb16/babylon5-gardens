// Tiny PNG codec on node:zlib, no dependencies. 8-bit RGBA encoder; decoder for non-interlaced 8/16-bit
// grayscale, gray+alpha, RGB, RGBA and palette images (what threert shot / our bake produce).
import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Encode RGBA8 (row 0 = top, non-premultiplied) as a PNG Buffer. Per row the filter (None / Sub / Up) with the
 *  smallest sum of absolute residuals is chosen. `data` is a Uint8Array / Uint8ClampedArray of w*h*4 bytes. */
export function encodePng(width, height, data, { level = 6 } = {}) {
  if (data.length !== width * height * 4) throw new RangeError(`encodePng: expected ${width * height * 4} bytes, got ${data.length}`);
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  const cand = [new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride)];
  for (let y = 0; y < height; y++) {
    const row = data.subarray(y * stride, (y + 1) * stride);
    const up = y > 0 ? data.subarray((y - 1) * stride, y * stride) : null;
    let s0 = 0, s1 = 0, s2 = 0;
    for (let x = 0; x < stride; x++) {
      const v = row[x];
      const sub = (v - (x >= 4 ? row[x - 4] : 0)) & 255;
      const upv = (v - (up ? up[x] : 0)) & 255;
      cand[0][x] = v; cand[1][x] = sub; cand[2][x] = upv;
      s0 += v < 128 ? v : 256 - v; s1 += sub < 128 ? sub : 256 - sub; s2 += upv < 128 ? upv : 256 - upv;
    }
    const pick = s1 <= s0 && s1 <= s2 ? 1 : s2 < s0 ? 2 : 0;
    raw[y * (stride + 1)] = pick;      // filter ids: 0 None, 1 Sub, 2 Up
    raw.set(cand[pick], y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8-bit RGBA, deflate, adaptive filter, no interlace
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Decode a PNG Buffer to { width, height, data: Uint8Array RGBA8 }. Throws on interlaced images. */
export function decodePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('decodePng: not a PNG');
  let o = 8, w = 0, h = 0, ct = 0, bd = 0;
  const idat = [];
  let palette = null, trns = null;
  while (o + 8 <= buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString('ascii', o + 4, o + 8), d = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      w = d.readUInt32BE(0); h = d.readUInt32BE(4); bd = d[8]; ct = d[9];
      if (d[12]) throw new Error('decodePng: interlaced PNG not supported');
    } else if (type === 'PLTE') palette = d;
    else if (type === 'tRNS') trns = d;
    else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  const ch = CHANNELS[ct];
  if (!ch || (bd !== 8 && bd !== 16)) throw new Error(`decodePng: unsupported PNG (colour type ${ct}, ${bd}-bit)`);
  const bpp = ch * (bd / 8), stride = w * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const px = new Uint8Array(stride * h), prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = px.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      else if (f !== 0) throw new Error(`decodePng: bad filter ${f}`);
      out[x] = v & 255;
    }
    prev.set(out);
  }
  const step = bd / 8;                                     // bytes per sample (16-bit: keep the high byte)
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0, n = w * h; i < n; i++) {
    const s = i * bpp, d = i * 4;
    if (ct === 6) { rgba[d] = px[s]; rgba[d + 1] = px[s + step]; rgba[d + 2] = px[s + 2 * step]; rgba[d + 3] = px[s + 3 * step]; }
    else if (ct === 2) { rgba[d] = px[s]; rgba[d + 1] = px[s + step]; rgba[d + 2] = px[s + 2 * step]; rgba[d + 3] = 255; }
    else if (ct === 0) { rgba[d] = rgba[d + 1] = rgba[d + 2] = px[s]; rgba[d + 3] = 255; }
    else if (ct === 4) { rgba[d] = rgba[d + 1] = rgba[d + 2] = px[s]; rgba[d + 3] = px[s + step]; }
    else {
      const k = px[s];
      if (!palette) throw new Error('decodePng: palette image without PLTE');
      rgba[d] = palette[3 * k]; rgba[d + 1] = palette[3 * k + 1]; rgba[d + 2] = palette[3 * k + 2];
      rgba[d + 3] = trns && k < trns.length ? trns[k] : 255;
    }
  }
  return { width: w, height: h, data: rgba };
}

// ── colour difference ────────────────────────────────────────────────────────────────────────────────

const srgbToLinear = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const LIN_LUT = Float64Array.from({ length: 256 }, (_, i) => srgbToLinear(i));
const labF = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);

/** sRGB8 -> CIE L*a*b* (D65), written to out[0..2] */
export function rgbToLab(r, g, b, out) {
  const R = LIN_LUT[r], G = LIN_LUT[g], B = LIN_LUT[b];
  const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const Y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  const Z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
  const fx = labF(X), fy = labF(Y), fz = labF(Z);
  out[0] = 116 * fy - 16; out[1] = 500 * (fx - fy); out[2] = 200 * (fy - fz);
  return out;
}

/** Mean CIE76 delta E (Euclidean distance in L*a*b*) between two decoded images of the same size, alpha ignored.
 *  Returns { mean, p95, max, diff } where diff is an RGBA8 heat image (delta E x 8, clamped) for inspection. */
export function deltaE(a, b) {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`deltaE: size mismatch ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
  const n = a.width * a.height, la = [0, 0, 0], lb = [0, 0, 0];
  const hist = new Uint32Array(1024);                      // delta E in steps of 0.1, up to 102.3
  const diff = new Uint8Array(n * 4);
  let sum = 0, max = 0;
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    rgbToLab(a.data[p], a.data[p + 1], a.data[p + 2], la);
    rgbToLab(b.data[p], b.data[p + 1], b.data[p + 2], lb);
    const de = Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
    sum += de; if (de > max) max = de;
    hist[Math.min(1023, Math.round(de * 10))]++;
    const v = Math.min(255, Math.round(de * 8));
    diff[p] = v; diff[p + 1] = v; diff[p + 2] = v; diff[p + 3] = 255;
  }
  let acc = 0, p95 = 0;
  for (let k = 0; k < 1024; k++) { acc += hist[k]; if (acc >= n * 0.95) { p95 = k / 10; break; } }
  return { mean: sum / n, p95, max, diff };
}
