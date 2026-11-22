import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';

/* PT-W4a GPU unit probes (pathtracer/smoke/pt-unit.html): the WGSL BSDF and
   light-sampling modules on the GPU vs their CPU mirrors with identical
   inputs — per-record BSDF sample / eval, BSDF white furnace per
   configuration, light BVH sample / pmf, alias table, tube sample / pdf,
   tube-vs-triangles selection. Own Vite dev server (not a build input). */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

test.use({
  launchOptions: {
    args: process.env.PT_SMOKE_ARGS !== undefined ? process.env.PT_SMOKE_ARGS.split(/\s+/).filter(Boolean) : [
      '--enable-unsafe-webgpu', '--enable-webgpu-developer-features', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'
    ]
  }
});

let server: ViteDevServer;
let base = '';
test.beforeAll(async () => {
  server = await createServer({ root: ROOT, configFile: false, logLevel: 'warn', server: { host: '127.0.0.1', port: 4186, strictPort: false } });
  await server.listen();
  base = server.resolvedUrls?.local[0] ?? 'http://127.0.0.1:4186/';
});
test.afterAll(async () => { await server?.close(); });

interface UnitState {
  done: boolean;
  error?: string;
  log: string[];
  bsdf?: { records: number; mismatches: number; worstRel: number; furnace: { name: string; cos: number; gpu: number; cpu: number }[] };
  lights?: {
    queries: number; treeSameLight: number; treePmfWorstRel: number; pmfEvalWorstRel: number; aliasSame: number;
    tubeWorstRel: number; tubePdfWorstRel: number; pTubeWorstAbs: number;
  };
  gpuErrors: string[];
}

test('GPU BSDF + light sampling == CPU mirrors', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
  await page.goto(new URL('pathtracer/smoke/pt-unit.html', base).href);
  await page.waitForFunction(() => (window as unknown as { __ptUnit?: UnitState }).__ptUnit?.done === true, null, { timeout: 150_000, polling: 250 });
  const st = await page.evaluate(() => (window as unknown as { __ptUnit: UnitState }).__ptUnit);
  console.log('[pt-unit]\n  ' + st.log.join('\n  '));
  expect(st.error, st.error).toBeUndefined();
  expect(st.gpuErrors).toEqual([]);
  expect(errors, errors.join('\n')).toEqual([]);

  const b = st.bsdf!;
  // a handful of records may flip a lobe / reflect-vs-transmit decision when u sits on an f32 boundary
  expect(b.mismatches / b.records).toBeLessThan(0.005);
  expect(b.worstRel).toBeLessThan(2e-3);
  for (const f of b.furnace) {
    expect(f.gpu, `${f.name} @ cos ${f.cos}`).toBeLessThan(1.005);
    expect(Math.abs(f.gpu - f.cpu), `${f.name} @ cos ${f.cos}`).toBeLessThan(2e-3);
  }

  const l = st.lights!;
  expect(l.treeSameLight).toBeGreaterThan(0.995);
  // products of ~10 per-level f32 ratios (CPU in f64)
  expect(l.treePmfWorstRel).toBeLessThan(3e-3);
  expect(l.pmfEvalWorstRel).toBeLessThan(3e-3);
  expect(l.aliasSame).toBeGreaterThan(0.999);
  expect(l.tubeWorstRel).toBeLessThan(1e-3);
  expect(l.tubePdfWorstRel).toBeLessThan(2e-3);
  expect(l.pTubeWorstAbs).toBeLessThan(1e-4);
});
