// M0 (j): QuickJS speed in setup vs Node (tools/qjs-bench.mjs runs the same functions).
import { defineGame } from "@threert/gameplay";
import { layoutLike, sinLoop } from "./lib/bench.ts";
import { buildStation } from "./lib/station.ts";

const RealDate = Date;
const g = globalThis as Record<string, unknown>;

function time(label: string, fn: () => number) {
  const t0 = RealDate.now();
  const r = fn();
  console.log(`[j] ${label}: ${RealDate.now() - t0} ms (result ${r.toFixed(4)})`);
}

export default defineGame({
  state: {},
  handlers: {},
  setup() {
    console.log(`[j] globals: performance=${typeof g.performance} TextEncoder=${typeof g.TextEncoder} structuredClone=${typeof g.structuredClone} setTimeout=${typeof g.setTimeout} Intl=${typeof g.Intl} WebAssembly=${typeof g.WebAssembly}`);
    time("1e6 Math.sin + Float32Array writes", () => sinLoop(1e6));
    time("1e6 Math.sin + Float32Array writes (2nd run)", () => sinLoop(1e6));
    time("1e5 layout-like instances (mulberry32 + 16-float matrices)", () => layoutLike(1e5));
    const s = buildStation({ k: 1 });
    return { scene: s.scene, camera: s.camera };
  },
});
