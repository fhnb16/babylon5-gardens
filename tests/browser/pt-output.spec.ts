import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';

/* PT-P4 output side (pathtracer/smoke/pt-output.html) in headless Edge with WebGPU:
   (a) k_tilestats vs the CPU mirror, the half-buffer noise estimator vs two
       independent renders, k_atrous vs the CPU mirror;
   (b) public API (pathtracer/index.ts): DAY view 0, 960×540, adaptive to the
       target noise 3 % → spp reached, time, measured noise; raw + à-trous PNGs;
   (c) à-trous on 64 spp vs a 2048 spp reference (half resolution): RMSE of
       noisy and denoised (linear relative, display space); PNGs;
   (d) Owen-scrambled Sobol vs PCG noise at 16 spp (half resolution).
   Every run asserts no validation errors / device loss. Results and images go
   to test-results/pt-output/. Like the other PT specs, the pages are not build
   inputs, so this spec starts its own Vite dev server. */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = 'test-results/pt-output';

test.use({
  launchOptions: {
    args: process.env.PT_SMOKE_ARGS !== undefined ? process.env.PT_SMOKE_ARGS.split(/\s+/).filter(Boolean) : [
      '--enable-unsafe-webgpu',
      '--enable-webgpu-developer-features',
      '--use-angle=d3d11',
      '--enable-gpu',
      '--ignore-gpu-blocklist'
    ]
  },
  viewport: { width: 1000, height: 800 }
});

let server: ViteDevServer;
let base = '';

test.beforeAll(async () => {
  server = await createServer({
    root: ROOT,
    configFile: false,
    logLevel: 'warn',
    server: { host: '127.0.0.1', port: 4186, strictPort: false }
  });
  await server.listen();
  base = server.resolvedUrls?.local[0] ?? 'http://127.0.0.1:4186/';
});

test.afterAll(async () => {
  await server?.close();
});

interface OutState {
  done: boolean;
  error?: string;
  log: string[];
  gpuErrors: string[];
  deviceLost?: string;
  images: Record<string, string>;
  adaptive?: Record<string, number | boolean | string | unknown[]>;
  stats?: Record<string, number>;
  rmse?: Record<string, number>;
  sampler?: Record<string, { relRms: number; meanLum: number; gpuMs: number; ms: number } | number>;
}

async function run(page: Page, query: string, timeout = 280_000): Promise<OutState> {
  mkdirSync(OUT, { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
  await page.goto(new URL(`pathtracer/smoke/pt-output.html?${query}${process.env.PT_OUTPUT_QUERY ?? ''}`, base).href);
  await page.waitForFunction(() => (window as unknown as { __ptOut?: OutState }).__ptOut?.done === true, null, { timeout, polling: 500 });
  const st = await page.evaluate(() => (window as unknown as { __ptOut: OutState }).__ptOut);
  console.log(`[pt-output ${query}] log:\n  ` + st.log.join('\n  '));
  for (const [name, url] of Object.entries(st.images)) {
    if (url.startsWith('data:image/png;base64,')) writeFileSync(`${OUT}/${name}.png`, Buffer.from(url.slice(22), 'base64'));
  }
  expect(st.error, st.error).toBeUndefined();
  expect(st.deviceLost).toBeUndefined();
  expect(st.gpuErrors).toEqual([]);
  expect(errors, errors.join('\n')).toEqual([]);
  return st;
}

test('(a) tile statistics and à-trous match their CPU mirrors; the noise estimator matches two independent renders', async ({ page }) => {
  test.setTimeout(400_000);
  const out: Record<string, Record<string, number>> = {};
  for (const sampler of ['pcg', 'sobol'] as const) {
    const st = await run(page, `mode=stats&res=0.5&spp=64&sampler=${sampler}`);
    const s = out[sampler] = st.stats!;
    console.log(`[pt-output] stats ${sampler}: ${JSON.stringify(s)}`);
    expect(s.samplerMismatches).toBe(0);
    expect(s.tileStatsMaxRelDiff).toBeLessThan(1e-3);
    expect(s.tileCountDiff).toBe(0);
    expect(s.atrousMeanRelDiff).toBeLessThan(2e-3);
    /* PCG: the half-buffer estimate is unbiased up to its own noise; Sobol: after the
       CONVERGENCE.sobolCalibration factor (raw ≈ 1.5× conservative, QMC) */
    expect(s.medianRatioCalibrated).toBeGreaterThan(0.8);
    expect(s.medianRatioCalibrated).toBeLessThan(1.25);
  }
  writeFileSync(`${OUT}/stats.json`, JSON.stringify(out, null, 1));
});

test('(b) public API: DAY view 0, 960×540, adaptive to 3 % noise', async ({ page }) => {
  test.setTimeout(330_000);
  const st = await run(page, 'mode=adaptive&noise=3&view=0&phase=0', 320_000);
  const a = st.adaptive!;
  writeFileSync(`${OUT}/adaptive.json`, JSON.stringify(a, null, 1));
  console.log(`[pt-output] adaptive 3 %: ${(a.spp as number).toFixed(1)} spp mean (${a.minSpp}..${a.maxSpp}), ` +
    `${((a.timeMs as number) / 1000).toFixed(1)} s (setup ${((a.setupMs as number) / 1000).toFixed(1)} s), p95 noise ${(a.noiseP95 as number).toFixed(2)} %, ` +
    `tiles converged ${a.converged} / capped ${a.capped} / ${a.tiles}, à-trous ${(a.denoiseMs as number).toFixed(1)} ms`);
  expect(a.done).toBe(true);
  expect(a.cleaned).toBe(true);
  /* every tile either met the target or hit the spp cap */
  expect((a.converged as number) + (a.capped as number)).toBe(a.tiles);
  expect(a.noiseP95 as number).toBeLessThanOrEqual(3 * 1.0001);
});

test('(c) à-trous 64 spp vs 2048 spp reference (half resolution)', async ({ page }) => {
  test.setTimeout(400_000);
  const st = await run(page, 'mode=rmse&res=0.5&spp=64&ref=2048', 390_000);
  const r = st.rmse!;
  writeFileSync(`${OUT}/rmse.json`, JSON.stringify(r, null, 1));
  console.log(`[pt-output] RMSE vs 2048 spp: noisy 64 spp ${(r.relRmseNoisy * 100).toFixed(2)} % (display ${r.displayRmseNoisy.toFixed(4)}), ` +
    `à-trous ${(r.relRmseDenoised * 100).toFixed(2)} % (display ${r.displayRmseDenoised.toFixed(4)}), denoise ${r.denoiseMs.toFixed(1)} ms`);
  console.log(`[pt-output] relMSE noisy ${r.relMseNoisy.toExponential(3)} → à-trous ${r.relMseDenoised.toExponential(3)}; ` +
    `linear RMSE below display saturation ${(r.relRmseUnsatNoisy * 100).toFixed(2)} % → ${(r.relRmseUnsatDenoised * 100).toFixed(2)} %, ` +
    `saturated (${r.saturatedPixels} px) ${(r.relRmseSatNoisy * 100).toFixed(1)} % → ${(r.relRmseSatDenoised * 100).toFixed(1)} %`);
  /* the linear RMSE over all pixels is dominated by ~650 display-saturated pixels around the tube
     (HDR bleeding is invisible there); relMSE and display-space RMSE are the quality measures */
  expect(r.relMseDenoised).toBeLessThan(r.relMseNoisy);
  expect(r.displayRmseDenoised).toBeLessThan(r.displayRmseNoisy);
  expect(Math.abs(r.meanDenoised / r.meanRef - 1)).toBeLessThan(0.05);
});

test('(d) Owen-scrambled Sobol vs PCG at 16 spp (half resolution)', async ({ page }) => {
  test.setTimeout(300_000);
  const st = await run(page, 'mode=sampler&res=0.5&spp=16');
  const s = st.sampler! as Record<string, { relRms: number; meanLum: number; gpuMs: number }>;
  writeFileSync(`${OUT}/sampler.json`, JSON.stringify(s, null, 1));
  console.log(`[pt-output] sampler @16 spp: sobol ${(s.sobol.relRms * 100).toFixed(2)} % (${s.sobol.gpuMs.toFixed(0)} ms GPU), ` +
    `pcg ${(s.pcg.relRms * 100).toFixed(2)} % (${s.pcg.gpuMs.toFixed(0)} ms GPU); variance ×${((s.pcg.relRms / s.sobol.relRms) ** 2).toFixed(2)}`);
  console.log(`[pt-output] path regularization 0.5 (Sobol): noise ${(s.sobolReg.relRms * 100).toFixed(2)} %, ` +
    `mean luminance bias ${((s.sobolReg.meanLum / s.sobol.meanLum - 1) * 100).toFixed(2)} %`);
  /* same integral */
  expect(Math.abs(s.sobol.meanLum / s.pcg.meanLum - 1)).toBeLessThan(0.03);
  expect(s.sobol.relRms).toBeLessThan(s.pcg.relRms * 1.02);
});
