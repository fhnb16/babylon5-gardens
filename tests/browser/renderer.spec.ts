/* ═══════════════════════════════════════════════════════════════════════════
   Renderer matrix: the node-material raster (backends/three materials/node.ts
   on WebGPURenderer) against the classic reference images.

   tools/core-world.html?renderer=webgpu | webgl2 renders the 9 teleport views
   × DAY / NIGHT at HIGH through backends/three/renderer.ts createRenderer —
   the factory the app uses — and each shot is compared with
   tests/browser/ref/core-world/*.png (rendered by the classic WebGLRenderer,
   see core-world.spec.ts). Per shot: mean |Δ| (0..255 over RGB) and the
   share of pixels whose max channel difference exceeds 8/255.

   Acceptance (unit R1a): mean < 3/255 per shot, no console errors (WebGPU
   validation errors surface as console errors: pathtracer/device.ts logs
   uncaptured device errors, three logs its own), the WebGPU run really on
   the WebGPU backend with the shared path-tracer device.
   Side-by-sides (reference | node | |diff|×4) and summary.json go to
   test-results/renderer/<mode>/. A perf line per renderer (classic, webgpu,
   webgl2): ms per frame at view 0, HIGH, 1280×720, n frames back to back
   until the GPU is idle (tools/core-world.ts bench()).

   The app itself (index.html?renderer=webgpu|webgl2) boots on the same dev
   server: first frame through the RenderPipeline, no console errors, the
   «Рендерер» row shows the mode, photo-mode buttons that need the classic
   renderer are disabled, and a screenshot (render target +
   readRenderTargetPixelsAsync) downloads a non-empty, upright PNG.

   tools/core-world.html is a dev-only page, so this spec runs its own Vite
   dev server (port 5198; core-world.spec.ts uses 5199).
   ═══════════════════════════════════════════════════════════════════════════ */

import { test, expect, type Browser, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PORT = 5198;
const BASE = `http://127.0.0.1:${PORT}/tools/core-world.html`;
const OUT = join(process.cwd(), 'test-results', 'renderer');
const REF = join(process.cwd(), 'tests', 'browser', 'ref', 'core-world');
const VIEWS = 9;
const PHASES: [string, number][] = [['DAY', 0], ['NIGHT', 2]];
const QUALITY = 'HIGH';
const MAX_MEAN = 3;          // mean |Δ| per channel, 0..255
const BENCH_FRAMES = 60;

interface RendererInfo { requested: string; kind: string; sharedDevice: boolean; fallback: string; adapter: string }
declare global {
  interface Window {
    __coreWorld?: {
      done?: boolean; error?: string; renderer?: RendererInfo;
      show?: (view: number, phase: number) => Promise<void>;
      bench?: (n: number) => Promise<number>;
    };
  }
}

let server: ViteDevServer | null = null;

test.beforeAll(async () => {
  server = await createServer({
    server: { port: PORT, strictPort: true, host: '127.0.0.1' },
    logLevel: 'error', clearScreen: false
  });
  await server.listen();
});
test.afterAll(async () => { await server?.close(); });

async function openPage(browser: Browser, mode: string, errors: string[]): Promise<{ page: Page; close: () => Promise<void>; info: RendererInfo }> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page: Page = await ctx.newPage();
  page.on('console', m => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text());
    if (m.type() === 'warning' && /WebGPU|validation|GPU/i.test(m.text())) errors.push('warning: ' + m.text());
  });
  page.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) errors.push(`${r.status()} ${r.url()}`); });
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${BASE}?quality=${QUALITY}&view=0&phase=0&renderer=${mode}`);
  await page.waitForFunction(() => window.__coreWorld?.done || window.__coreWorld?.error, null, { timeout: 180_000 });
  const err = await page.evaluate(() => window.__coreWorld?.error);
  expect(err, 'page error').toBeFalsy();
  const info = await page.evaluate(() => window.__coreWorld!.renderer!);
  return { page, close: () => ctx.close(), info };
}

async function shoot(page: Page): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  for (const [pname, ph] of PHASES) {
    for (let v = 0; v < VIEWS; v++) {
      await page.evaluate(([vv, pp]) => window.__coreWorld!.show!(vv, pp), [v, ph] as [number, number]);
      out.set(`${v}-${pname}`, await page.locator('canvas').screenshot());
    }
  }
  return out;
}

async function bench(page: Page): Promise<number> {
  await page.evaluate(() => window.__coreWorld!.show!(0, 0));
  return page.evaluate(n => window.__coreWorld!.bench!(n), BENCH_FRAMES);
}

interface Stats { mean: number; pct8: number; png: string }

/** diff two PNGs in a page; returns stats and a side-by-side PNG (base64) */
async function diff(page: Page, a: Buffer, b: Buffer, labels: [string, string]): Promise<Stats> {
  return page.evaluate(async ([A, B, la, lb]) => {
    const dec = async (b64: string): Promise<ImageData> => {
      const blob = await (await fetch('data:image/png;base64,' + b64)).blob();
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d') as OffscreenCanvasRenderingContext2D;
      g.drawImage(bmp, 0, 0);
      return g.getImageData(0, 0, bmp.width, bmp.height);
    };
    const ia = await dec(A), ib = await dec(B);
    const w = ia.width, h = ia.height;
    const d = new ImageData(w, h);
    let sum = 0, over = 0;
    for (let i = 0; i < w * h; i++) {
      let mx = 0;
      for (let c = 0; c < 3; c++) {
        const x = Math.abs(ia.data[i * 4 + c] - ib.data[i * 4 + c]);
        sum += x; if (x > mx) mx = x;
        d.data[i * 4 + c] = Math.min(255, x * 4);
      }
      d.data[i * 4 + 3] = 255;
      if (mx > 8) over++;
    }
    const out = new OffscreenCanvas(w * 3, h);
    const g = out.getContext('2d') as OffscreenCanvasRenderingContext2D;
    g.putImageData(ia, 0, 0); g.putImageData(ib, w, 0); g.putImageData(d, 2 * w, 0);
    g.font = '16px monospace'; g.fillStyle = '#ff0';
    g.fillText(la, 8, 20); g.fillText(lb, w + 8, 20); g.fillText('|diff| x4', 2 * w + 8, 20);
    const png = await out.convertToBlob({ type: 'image/png' });
    const buf = new Uint8Array(await png.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { mean: sum / (w * h * 3), pct8: 100 * over / (w * h), png: btoa(bin) };
  }, [a.toString('base64'), b.toString('base64'), labels[0], labels[1]] as [string, string, string, string]);
}

const perf: Record<string, number> = {};

for (const mode of ['webgpu', 'webgl2'] as const) {
  test(`${mode}: node materials vs classic references, 9 views × DAY/NIGHT at HIGH`, async ({ browser }) => {
    test.setTimeout(600_000);
    const dir = join(OUT, mode);
    mkdirSync(dir, { recursive: true });
    const errors: string[] = [];
    const { page, close, info } = await openPage(browser, mode, errors);
    console.log(`${mode}: kind=${info.kind} sharedDevice=${info.sharedDevice} adapter=${info.adapter.slice(0, 80)}` +
      (info.fallback ? ` fallback=${info.fallback}` : ''));
    expect(info.kind, 'backend actually used').toBe(mode);
    if (mode === 'webgpu') expect(info.sharedDevice, 'device from pathtracer/device.ts').toBe(true);
    const shots = await shoot(page);
    perf[mode] = await bench(page);
    await close();
    expect(errors).toEqual([]);

    const cmpCtx = await browser.newContext();
    const cmp = await cmpCtx.newPage();
    await cmp.goto('about:blank');
    const rows: { shot: string; mean: number; pct8: number }[] = [];
    for (const [key, png] of shots) {
      const file = join(REF, `view${key}.png`);
      expect(existsSync(file), `reference ${file}`).toBe(true);
      const s = await diff(cmp, readFileSync(file), png, ['reference (classic)', mode]);
      writeFileSync(join(dir, `view${key}.png`), Buffer.from(s.png, 'base64'));
      rows.push({ shot: key, mean: +s.mean.toFixed(3), pct8: +s.pct8.toFixed(3) });
    }
    await cmpCtx.close();

    writeFileSync(join(dir, 'summary.json'), JSON.stringify({ mode, quality: QUALITY, renderer: info, msPerFrame: perf[mode], rows }, null, 1));
    console.log(`${mode}  shot        mean|Δ|  %>8/255`);
    for (const r of rows) console.log(`${mode}  ${r.shot.padEnd(10)} ${r.mean.toFixed(3).padStart(8)} ${r.pct8.toFixed(2).padStart(8)}`);
    console.log(`${mode}  frame ${perf[mode].toFixed(2)} ms (view 0, HIGH, 1280×720, ${BENCH_FRAMES} frames)`);

    for (const r of rows) expect.soft(r.mean, `${r.shot} mean |Δ|`).toBeLessThan(MAX_MEAN);
  });
}

for (const mode of ['webgpu', 'webgl2'] as const) {
  test(`app boots with ?renderer=${mode}: pipeline frame, settings row, photo buttons, screenshot`, async ({ browser }) => {
    test.setTimeout(300_000);
    const errors: string[] = [];
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: 'block', acceptDownloads: true });
    const page = await ctx.newPage();
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${PORT}/index.html?renderer=${mode}`);
    await page.waitForFunction(() => (window as unknown as { __b5ready?: boolean }).__b5ready === true, null, { timeout: 180_000 });
    /* intro away, pointer released, world held still: the canvas and the shot see the same frame */
    await page.click('#go');
    await expect(page.locator('#intro')).toBeHidden({ timeout: 5_000 });
    await page.keyboard.press('Escape');
    await page.evaluate(() => (window as unknown as { __b5: { dispatch(a: string): boolean } }).__b5.dispatch('togglePause'));
    await page.waitForTimeout(1500);
    expect(await page.locator('#sRend').inputValue()).toBe(mode);
    expect(await page.locator('#sRendV').textContent()).toContain(mode === 'webgpu' ? 'WebGPU' : 'WebGL2');
    expect(await page.locator('#bTrace').getAttribute('aria-disabled')).toBe(mode === 'webgl2' ? 'true' : null);

    const canvasPng = await page.locator('#stage canvas').screenshot();
    const dl = page.waitForEvent('download', { timeout: 60_000 });
    await page.evaluate(() => (window as unknown as { __b5: { dispatch(a: string): boolean } }).__b5.dispatch('shot'));
    const file = await (await dl).path();
    const shot = readFileSync(file);
    await page.waitForTimeout(500);
    await ctx.close();
    expect(errors).toEqual([]);

    /* the shot must look like the canvas (upright, same exposure): compare downscaled */
    const cmpCtx = await browser.newContext();
    const cmp = await cmpCtx.newPage();
    await cmp.goto('about:blank');
    const s = await diff(cmp, canvasPng, shot, ['canvas', 'shot']);
    await cmpCtx.close();
    mkdirSync(join(OUT, mode), { recursive: true });
    writeFileSync(join(OUT, mode, 'app-shot.png'), Buffer.from(s.png, 'base64'));
    console.log(`${mode} app: shot vs canvas mean ${s.mean.toFixed(2)}, %>8 ${s.pct8.toFixed(1)}`);
    expect(shot.length).toBeGreaterThan(50_000);
    expect(s.mean, 'screenshot upright and like the canvas').toBeLessThan(6);
  });
}

test('classic: frame time on the same page (perf baseline)', async ({ browser }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  const { page, close } = await openPage(browser, 'classic', errors);
  perf.classic = await bench(page);
  await close();
  expect(errors).toEqual([]);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'perf.json'), JSON.stringify(perf, null, 1));
  console.log(`perf ms/frame (view 0, HIGH, 1280×720): ${Object.entries(perf).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ')}`);
});
