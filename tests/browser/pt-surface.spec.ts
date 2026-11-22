import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';

/* PT-U3 surface smoke (pathtracer/smoke/pt-surface.html) in headless Edge
   with WebGPU: real buildScene (seed 1337, HIGH) uploaded through
   pathtracer/scene-upload.ts, TP view 0 at 640×360 through k_intersect and
   b5_surface, compared with surface-ref.ts on 2,000 random hit pixels.
   AOV PNGs → test-results/pt-surface/. Like pt-smoke.spec.ts this starts
   its own Vite dev server (the page is not a build input). */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = 'test-results/pt-surface';

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
    server: { host: '127.0.0.1', port: 4184, strictPort: false }
  });
  await server.listen();
  base = server.resolvedUrls?.local[0] ?? 'http://127.0.0.1:4184/';
});

test.afterAll(async () => {
  await server?.close();
});

interface Metric { name: string; tol: number; unit: string; pass: number; p50: number; p99: number; max: number }
interface SurfaceState {
  done: boolean;
  pass?: boolean;
  error?: string;
  log: string[];
  report?: {
    hits: number; compared: number; idMismatch: number; metrics: Metric[]; minPass: number;
    timings: Record<string, number | string>[]; gpuErrors: string[];
  };
  images?: Record<string, string>;
}

test('b5_surface on the real scene agrees with surface-ref', async ({ page }) => {
  test.setTimeout(600_000);
  mkdirSync(OUT, { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });

  const query = process.env.PT_SURFACE_QUERY ?? '';
  await page.goto(new URL(`pathtracer/smoke/pt-surface.html${query}`, base).href);
  await page.waitForFunction(() => (window as unknown as { __ptSurface?: SurfaceState }).__ptSurface?.done === true,
    null, { timeout: 560_000, polling: 1000 });
  const st = await page.evaluate(() => (window as unknown as { __ptSurface: SurfaceState }).__ptSurface);
  console.log('[pt-surface] log:\n  ' + st.log.join('\n  '));
  for (const [name, url] of Object.entries(st.images ?? {})) {
    writeFileSync(`${OUT}/${name}.png`, Buffer.from(url.replace(/^data:image\/png;base64,/, ''), 'base64'));
  }
  await page.screenshot({ path: `${OUT}/page.png`, fullPage: true });

  expect(st.error, st.error).toBeUndefined();
  const r = st.report!;
  expect(r.gpuErrors).toEqual([]);
  expect(r.idMismatch).toBe(0);
  expect(r.compared).toBeGreaterThanOrEqual(2000);
  for (const m of r.metrics) expect(m.pass, `${m.name}: ${(m.pass * 100).toFixed(2)} % within ${m.tol} ${m.unit}`).toBeGreaterThanOrEqual(r.minPass);
  expect(Object.keys(st.images ?? {}).sort()).toEqual(['albedo', 'emission', 'normal', 'roughness']);
  expect(st.pass).toBe(true);
  expect(errors, errors.join('\n')).toEqual([]);
});
