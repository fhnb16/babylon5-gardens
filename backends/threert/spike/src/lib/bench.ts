// Same micro-benchmarks in QuickJS (j_qjs.ts) and Node (tools/qjs-bench.mjs).
export function sinLoop(n: number): number {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.sin(i * 0.001) * 0.5 + 0.5;
  let s = 0;
  for (let i = 0; i < n; i += 1024) s += a[i];
  return s;
}

/** mulberry32 + a matrix-ish inner loop: what core layout/geometry code looks like. */
export function layoutLike(n: number): number {
  let a = 1337 >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const m = new Float32Array(n * 16);
  for (let i = 0; i < n; i++) {
    const th = rnd() * 6.2831853, z = rnd() * 300 - 150, s = 0.5 + rnd();
    const c = Math.cos(th), si = Math.sin(th), o = i * 16;
    m[o] = c * s; m[o + 1] = si * s; m[o + 4] = -si * s; m[o + 5] = c * s; m[o + 10] = s; m[o + 15] = 1;
    m[o + 12] = 48 * c; m[o + 13] = 48 * si; m[o + 14] = z;
  }
  return m[(n >> 1) * 16 + 12];
}
