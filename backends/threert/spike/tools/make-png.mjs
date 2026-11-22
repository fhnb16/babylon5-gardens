// Writes assets/tex2048.png (the same pattern as src/lib/pattern.ts) with Node's zlib, and times it.
//   node --experimental-strip-types tools/make-png.mjs   (Node 24 strips the .ts types on import)
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fillPattern } from '../src/lib/pattern.ts';

const N = 2048;
const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};

let t = performance.now();
const px = new Uint8Array(N * N * 4);
fillPattern(px, N);
const fillMs = performance.now() - t;
t = performance.now();
const raw = Buffer.alloc(N * (N * 4 + 1));
for (let y = 0; y < N; y++) { raw[y * (N * 4 + 1)] = 0; raw.set(px.subarray(y * N * 4, (y + 1) * N * 4), y * (N * 4 + 1) + 1); }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
mkdirSync(new URL('../assets/', import.meta.url), { recursive: true });
writeFileSync(new URL('../assets/tex2048.png', import.meta.url), png);
console.log(`node fill ${fillMs.toFixed(1)} ms, encode ${(performance.now() - t).toFixed(1)} ms, ${(png.length / 1048576).toFixed(2)} MiB`);
