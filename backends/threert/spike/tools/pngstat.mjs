// Mean sRGB value / relative luminance of PNG regions (8-bit RGB/RGBA, non-interlaced), no dependencies.
//   node tools/pngstat.mjs shots/x.png [shots/y.png ...]
// Prints the whole image and five horizontal bands (top .. bottom); the floor is the bottom bands.
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

function decode(buf) {
  let o = 8, w = 0, h = 0, ct = 0, bd = 0;
  const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString('ascii', o + 4, o + 8), d = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); bd = d[8]; ct = d[9]; if (d[12]) throw new Error('interlaced'); }
    else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  if (bd !== 8 || (ct !== 2 && ct !== 6)) throw new Error(`unsupported PNG ct=${ct} bd=${bd}`);
  const bpp = ct === 6 ? 4 : 3, stride = w * bpp, raw = inflateSync(Buffer.concat(idat));
  const px = new Uint8Array(w * h * bpp), prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = px.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[x] = v & 255;
    }
    prev.set(out);
  }
  return { w, h, bpp, px };
}

const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
function stats({ w, bpp, px }, y0, y1) {
  let s = 0, Y = 0, n = 0, black = 0, hf = 0;
  for (let y = y0; y < y1; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * bpp, r = px[i], g = px[i + 1], b = px[i + 2];
    s += (r + g + b) / 3; const l = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); Y += l; n++;
    if (r + g + b < 6) black++;
    // noise proxy: |green - mean of 4 neighbours| (edges included, so compare like with like)
    if (x > 0 && x < w - 1 && y > 0 && y < y1 - 1) {
      const nb = (px[i - bpp + 1] + px[i + bpp + 1] + px[i - w * bpp + 1] + px[i + w * bpp + 1]) / 4;
      hf += Math.abs(g - nb);
    }
  }
  return { mean8: +(s / n).toFixed(1), meanLin: +(Y / n).toFixed(4), black: +(black / n).toFixed(3), hf: +(hf / n).toFixed(2) };
}

for (const f of process.argv.slice(2)) {
  const img = decode(readFileSync(f));
  const bands = [0, 1, 2, 3, 4].map((k) => stats(img, Math.floor((img.h * k) / 5), Math.floor((img.h * (k + 1)) / 5)));
  console.log(JSON.stringify({ file: f, size: `${img.w}x${img.h}`, all: stats(img, 0, img.h), bands }));
}
