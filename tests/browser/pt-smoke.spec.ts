import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';

/* WGSL traversal smoke (pathtracer/smoke/pt-smoke.html) in headless Edge with
   WebGPU: GPU kernels vs the CPU reference in f32 mode, ≥ 99.99 % agreement.

   pt-smoke.html is not a build input of vite.config.ts, so the preview server
   of playwright.config.ts does not serve it; this spec starts its own Vite
   dev server (TS + `?raw` imports work there without config changes). */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SHOTS = 'test-results';

/* WebGPU in headless Edge on Windows (D3D12 Dawn backend); ANGLE/D3D11 kept for
   WebGL. --enable-webgpu-developer-features: unquantised timestamp queries.
   PT_SMOKE_ARGS (space-separated) replaces the list for experiments. */
test.use({
  launchOptions: {
    args: process.env.PT_SMOKE_ARGS !== undefined ? process.env.PT_SMOKE_ARGS.split(/\s+/).filter(Boolean) : [
      '--enable-unsafe-webgpu',
      '--enable-webgpu-developer-features',
      '--use-angle=d3d11',
      '--enable-gpu',
      '--ignore-gpu-blocklist'
    ]
  }
});

let server: ViteDevServer;
let base = '';

test.beforeAll(async () => {
  server = await createServer({
    root: ROOT,
    configFile: false,
    logLevel: 'warn',
    server: { host: '127.0.0.1', port: 4183, strictPort: false }
  });
  await server.listen();
  base = server.resolvedUrls?.local[0] ?? 'http://127.0.0.1:4183/';
});

test.afterAll(async () => {
  await server?.close();
});

interface Tally { rays: number; exact: number; close: number; tie: number; mismatch: number; hits: number }
interface Bench { rays: number; medianMs: number; mraysPerSec: number }
interface SmokeState {
  done: boolean;
  pass?: boolean;
  error?: string;
  log: string[];
  report?: {
    agreement: number;
    total: Tally;
    tallies: Record<string, Tally>;
    mismatches: { set: string; ray: number; detail: string }[];
    stackOverflow: number;
    gpuErrors: string[];
    bench: { timer: string; primary: Bench; diffuse: Bench; shadow: Bench } | null;
  };
}

test('WGSL traversal agrees with the CPU reference (f32) on ≥ 99.99 % of rays', async ({ page }) => {
  test.setTimeout(240_000);
  mkdirSync(SHOTS, { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });

  await page.goto(new URL('pathtracer/smoke/pt-smoke.html', base).href);

  const gpu = await page.evaluate(async () => {
    if (!navigator.gpu) return 'navigator.gpu undefined';
    const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    return a ? `${a.info.vendor} ${a.info.architecture} ${a.info.description}`.trim() || 'adapter' : 'no adapter';
  });
  console.log('[pt-smoke] WebGPU adapter:', gpu);
  expect(gpu).not.toMatch(/undefined|no adapter/);

  await page.waitForFunction(() => (window as unknown as { __ptSmoke?: SmokeState }).__ptSmoke?.done === true,
    null, { timeout: 200_000, polling: 500 });
  const st = await page.evaluate(() => (window as unknown as { __ptSmoke: SmokeState }).__ptSmoke);
  console.log('[pt-smoke] log:\n  ' + st.log.join('\n  '));
  await page.locator('#view').screenshot({ path: `${SHOTS}/pt-smoke.png` });

  expect(st.error, st.error).toBeUndefined();
  const r = st.report!;
  expect(r.gpuErrors).toEqual([]);
  if (r.mismatches.length) {
    console.log('[pt-smoke] mismatches:\n' + r.mismatches.map((m) => `  ${m.set} #${m.ray}: ${m.detail}`).join('\n'));
  }
  console.log(`[pt-smoke] agreement ${(r.agreement * 100).toFixed(4)} %, mismatches ${r.total.mismatch} / ${r.total.rays}, ` +
    `ties ${r.total.tie}, stack overflows ${r.stackOverflow}`);
  if (r.bench) {
    const b = r.bench;
    console.log(`[pt-smoke] throughput (${b.timer}): primary ${b.primary.mraysPerSec.toFixed(0)} Mrays/s, ` +
      `incoherent ${b.diffuse.mraysPerSec.toFixed(0)} Mrays/s, shadow ${b.shadow.mraysPerSec.toFixed(0)} Mrays/s`);
  }
  expect(r.total.rays).toBeGreaterThan(100_000);
  expect(r.agreement).toBeGreaterThanOrEqual(0.9999);
  expect(st.pass).toBe(true);
  expect(errors, errors.join('\n')).toEqual([]);
});
