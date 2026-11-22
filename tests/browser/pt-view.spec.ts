import { test, expect, type Browser, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';

/* PT (pathtracer/smoke/pt-view.html) in headless Edge with WebGPU:
   (a)  furnace: closed Lambert cylinder, ρ = 0.5, Le = 1 → mean radiance
        within 2 % of Le / (1 − ρ);
   (a2) tube-lit cylinder: NEE (equiangular tube) + MIS + shadow rays vs the
        CPU reference integrator;
   (b)  the real station, 960×540 → 128 spp, calibrated palette
        (pathtracer/config.ts PHYS_OVERRIDE), views 0 DAY, 1 DUSK, 2 NIGHT,
        8 DAY (river / water BSDF). Each run asserts a finite, non-black image,
        no validation errors / device loss and every submit ≤ ~40 ms; saves
        the PNG to test-results/pt-view/, the raster reference of the same
        view (tools/core-world.html?mode=core, read-only use) next to it, and
        reports time-to-128-spp, Mrays/s and the mean displayed luminance of
        both (pt-view presents with the raster's exposure 1.22 + three's ACES);
   (c)  station noise, view 0 DAY at 16 spp, half resolution: equiangular vs
        uniform-area tube sampling (two independent renders per strategy).
   Like pt-smoke.spec.ts, the pages are not build inputs, so this spec starts
   its own Vite dev server. */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SHOTS = 'test-results/pt-view';
const W = 960, H = 540;
/** GPU ms per submit: budget 40 ms + slack for the cost model's first guesses */
const MAX_SUBMIT_MS = 48;

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
    server: { host: '127.0.0.1', port: 4184, strictPort: false }
  });
  await server.listen();
  base = server.resolvedUrls?.local[0] ?? 'http://127.0.0.1:4184/';
});

test.afterAll(async () => {
  await server?.close();
});

interface ViewState {
  done: boolean;
  error?: string;
  log: string[];
  device?: string;
  spp?: number;
  steps?: number;
  timeToTargetMs?: number;
  gpuMs?: number;
  mraysPerSec?: number;
  msPerWaveAvg?: number;
  maxSubmitMs?: number;
  timer?: string;
  compileMs?: number;
  uploadMs?: number;
  image?: { meanRgb: number[]; meanLum: number; nonFinite: number; black: number; pixels: number; minW: number; maxW: number };
  furnace?: { expected: number; mean: number; relErr: number; refStderr: number };
  lights?: { lights: number; active: number; nodes: number; totalPhi: number; powerMs: number; buildMs: number };
  phys?: { tubeNits: number; ev100: number };
  noise?: { relRms: number; meanLum: number; spp: number };
  gpuErrors: string[];
  deviceLost?: string;
}

async function run(page: Page, query: string, shot: string | null): Promise<{ st: ViewState; png: Buffer | null }> {
  mkdirSync(SHOTS, { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
  /* PT_VIEW_QUERY (e.g. "&stub=1&res=0.5") is appended to every page query, for experiments */
  await page.goto(new URL(`pathtracer/smoke/pt-view.html?${query}${process.env.PT_VIEW_QUERY ?? ''}`, base).href);
  await page.waitForFunction(() => (window as unknown as { __ptView?: ViewState }).__ptView?.done === true,
    null, { timeout: 280_000, polling: 500 });
  const st = await page.evaluate(() => (window as unknown as { __ptView: ViewState }).__ptView);
  console.log(`[pt-view ${query}] log:\n  ` + st.log.join('\n  '));
  let png: Buffer | null = null;
  if (shot) {
    await page.evaluate(() => { (document.getElementById('hud') as HTMLElement).style.display = 'none'; });
    png = await page.locator('#view').screenshot({ path: `${SHOTS}/${shot}` });
  }
  expect(st.error, st.error).toBeUndefined();
  expect(st.deviceLost).toBeUndefined();
  expect(st.gpuErrors).toEqual([]);
  expect(errors, errors.join('\n')).toEqual([]);
  return { st, png };
}

function report(name: string, st: ViewState): void {
  console.log(`[pt-view] ${name}: ${st.spp!.toFixed(2)} spp in ${st.timeToTargetMs!.toFixed(0)} ms ` +
    `(GPU ${st.gpuMs!.toFixed(0)} ms, ${st.steps} steps, ${st.msPerWaveAvg!.toFixed(1)} ms/wave, max submit ${(st.maxSubmitMs ?? 0).toFixed(1)} ms, ` +
    `${st.mraysPerSec!.toFixed(0)} Mrays/s [${st.timer}]); setup ${st.uploadMs!.toFixed(0)} ms ` +
    `(kernels ${st.compileMs!.toFixed(0)} ms); mean rgb ${st.image!.meanRgb.map((x) => x.toFixed(4)).join(' ')}, ` +
    `black px ${st.image!.black}/${st.image!.pixels}`);
}

/** Raster reference: the core world through backends/three (tools/core-world.html), same view / phase / size. */
async function rasterShot(browser: Browser, view: number, phase: number, file: string): Promise<Buffer> {
  const ctx = await browser.newContext({ viewport: { width: W, height: H } });
  const page = await ctx.newPage();
  await page.goto(new URL(`tools/core-world.html?mode=core&quality=HIGH&view=${view}&phase=${phase}`, base).href);
  await page.waitForFunction(() => {
    const w = (window as unknown as { __coreWorld?: { done?: boolean; error?: string } }).__coreWorld;
    return !!(w?.done || w?.error);
  }, null, { timeout: 240_000, polling: 500 });
  const err = await page.evaluate(() => (window as unknown as { __coreWorld?: { error?: string } }).__coreWorld?.error);
  expect(err, 'core-world error').toBeFalsy();
  const png = await page.locator('canvas').screenshot({ path: `${SHOTS}/${file}` });
  await ctx.close();
  return png;
}

/** Mean linear luminance of a PNG (sRGB decode) — computed in a page. */
async function meanLuminance(page: Page, png: Buffer, fromRow = 0): Promise<number> {
  return page.evaluate(async ([b64, from]) => {
    const blob = await (await fetch('data:image/png;base64,' + b64)).blob();
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d') as OffscreenCanvasRenderingContext2D;
    g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
    const lin = (v: number) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
    let s = 0;
    const i0 = Math.floor(from * bmp.height) * bmp.width * 4;
    for (let i = i0; i < d.length; i += 4) s += 0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2]);
    return s / ((d.length - i0) / 4);
  }, [png.toString('base64'), fromRow] as [string, number]);
}

test('(a) furnace: mean radiance within 2 % of Le / (1 − ρ)', async ({ page }) => {
  test.setTimeout(300_000);
  const { st } = await run(page, 'scene=furnace&spp=32&res=0.5', 'furnace.png');
  report('furnace', st);
  const f = st.furnace!;
  console.log(`[pt-view] furnace: GPU mean ${f.mean.toFixed(5)} vs analytic ${f.expected} (${(f.relErr * 100).toFixed(3)} %)`);
  expect(st.image!.nonFinite).toBe(0);
  expect(Math.abs(f.relErr)).toBeLessThan(0.02);
});

test('(a2) tube-lit cylinder: NEE + MIS + shadow rays match the CPU reference', async ({ page }) => {
  test.setTimeout(300_000);
  const { st } = await run(page, 'scene=tube&spp=64&res=0.5', 'tube.png');
  report('tube', st);
  const f = st.furnace!;
  const tol = Math.max(0.02 * f.expected, 4 * f.refStderr);
  console.log(`[pt-view] tube: GPU mean ${f.mean.toFixed(5)} vs CPU ${f.expected.toFixed(5)} ± ${f.refStderr.toFixed(5)} ` +
    `(${(f.relErr * 100).toFixed(3)} %)`);
  expect(st.image!.nonFinite).toBe(0);
  expect(Math.abs(f.mean - f.expected)).toBeLessThan(tol);
});

const PHASE_NAMES = ['DAY', 'DUSK', 'NIGHT'];
const summary: Record<string, unknown>[] = [];

for (const [view, phase] of [[0, 0], [1, 1], [2, 2], [8, 0]] as const) {
  const tag = `view${view}-${PHASE_NAMES[phase].toLowerCase()}`;
  test(`(b) station view ${view} ${PHASE_NAMES[phase]} ${W}×${H} → 128 spp vs raster`, async ({ page, browser }) => {
    test.setTimeout(600_000);
    const { st, png } = await run(page, `view=${view}&phase=${phase}&spp=128`, `${tag}.png`);
    report(tag, st);
    const im = st.image!;
    expect(st.spp!).toBeGreaterThanOrEqual(128);
    expect(im.minW).toBeGreaterThanOrEqual(128);
    expect(im.nonFinite).toBe(0);
    expect(im.meanLum).toBeGreaterThan(1e-4);
    expect(im.black / im.pixels).toBeLessThan(0.5);
    expect(st.maxSubmitMs!).toBeLessThan(MAX_SUBMIT_MS);
    const raster = await rasterShot(browser, view, phase, `${tag}-raster.png`);
    const lPt = await meanLuminance(page, png!), lRa = await meanLuminance(page, raster);
    /* near field (bottom third: the floor close to the camera, little raster fog) */
    const nPt = await meanLuminance(page, png!, 2 / 3), nRa = await meanLuminance(page, raster, 2 / 3);
    const row = {
      shot: tag, spp: +st.spp!.toFixed(2), timeToSppMs: Math.round(st.timeToTargetMs!), gpuMs: Math.round(st.gpuMs!),
      mraysPerSec: Math.round(st.mraysPerSec!), maxSubmitMs: +st.maxSubmitMs!.toFixed(1),
      tubeNits: st.phys?.tubeNits, ev100: st.phys?.ev100, lights: st.lights,
      displayLumPt: +lPt.toFixed(4), displayLumRaster: +lRa.toFixed(4), ratio: +(lPt / lRa).toFixed(3),
      nearRatio: +(nPt / nRa).toFixed(3)
    };
    summary.push(row);
    writeFileSync(`${SHOTS}/summary.json`, JSON.stringify(summary, null, 1));
    console.log(`[pt-view] ${tag}: displayed mean luminance PT ${lPt.toFixed(4)} vs raster ${lRa.toFixed(4)} (ratio ${(lPt / lRa).toFixed(3)}; bottom third ${nPt.toFixed(4)} vs ${nRa.toFixed(4)}, ratio ${(nPt / nRa).toFixed(3)})`);
    /* loose sanity band: the raster has fog / hemisphere fakes the tracer does not */
    expect(lPt / lRa).toBeGreaterThan(0.33);
    expect(lPt / lRa).toBeLessThan(3);
  });
}

test('(c) station noise: equiangular vs uniform-area tube sampling (view 0 DAY, 16 spp, half res)', async ({ page }) => {
  test.setTimeout(600_000);
  const res: Record<string, number> = {};
  for (const mode of ['equiangular', 'uniformArea'] as const) {
    const { st } = await run(page, `view=0&phase=0&spp=16&res=0.5&noise=1&tube=${mode}`, null);
    res[mode] = st.noise!.relRms;
  }
  const varRatio = (res.uniformArea / res.equiangular) ** 2;
  console.log(`[pt-view] station noise @16 spp: equiangular ${(res.equiangular * 100).toFixed(2)} %, ` +
    `uniform area ${(res.uniformArea * 100).toFixed(2)} % → variance ×${varRatio.toFixed(2)} lower`);
  writeFileSync(`${SHOTS}/noise.json`, JSON.stringify({ ...res, varianceRatio: varRatio }, null, 1));
  expect(res.equiangular).toBeLessThan(res.uniformArea);
});

test('(d) NIGHT emissive-triangle lights: light BVH vs alias table vs BSDF-only (view 1, 16 spp, half res)', async ({ page }) => {
  test.setTimeout(600_000);
  const res: Record<string, number> = {};
  const means: Record<string, number> = {};
  for (const mode of ['tree', 'alias', 'none'] as const) {
    const { st } = await run(page, `view=1&phase=2&spp=16&res=0.5&noise=1&lights=${mode}`, null);
    res[mode] = st.noise!.relRms;
    means[mode] = st.noise!.meanLum;
  }
  console.log(`[pt-view] NIGHT view 1 noise @16 spp: tree ${(res.tree * 100).toFixed(2)} %, alias ${(res.alias * 100).toFixed(2)} %, ` +
    `none (BSDF hits only) ${(res.none * 100).toFixed(2)} %; mean luminance ${means.tree.toFixed(5)} / ${means.alias.toFixed(5)} / ${means.none.toFixed(5)}`);
  writeFileSync(`${SHOTS}/noise-night.json`, JSON.stringify({ relRms: res, meanLum: means }, null, 1));
  // same integral, three estimators
  expect(Math.abs(means.tree / means.none - 1)).toBeLessThan(0.03);
  expect(Math.abs(means.alias / means.none - 1)).toBeLessThan(0.03);
  expect(res.tree).toBeLessThan(res.none);
});
