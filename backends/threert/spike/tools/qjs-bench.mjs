// Node side of the QuickJS benchmark (src/j_qjs.ts).  node tools/qjs-bench.mjs
import { layoutLike, sinLoop } from '../src/lib/bench.ts';

function time(label, fn) {
  const t0 = performance.now();
  const r = fn();
  console.log(`[node] ${label}: ${(performance.now() - t0).toFixed(1)} ms (result ${r.toFixed(4)})`);
}
time('1e6 Math.sin + Float32Array writes', () => sinLoop(1e6));
time('1e6 Math.sin + Float32Array writes (2nd run)', () => sinLoop(1e6));
time('1e5 layout-like instances (mulberry32 + 16-float matrices)', () => layoutLike(1e5));
