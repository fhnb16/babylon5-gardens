/* ═══════════════════════════════════════════════════════════════════════════
   Reference-image gate for the world: tools/core-world.html (core
   buildScene → backends/three, the minimal legacy renderer setup) against
   the reference images in tests/browser/ref/core-world/, for the 9 teleport
   views × DAY / NIGHT at HIGH.

   The references were rendered from the LEGACY world (js/world.js +
   js/structures.js, the pre-v2.12.0 app path) by the same page in its old
   mode=legacy, just before those files were retired (v2.12.0, B7). They stay
   the reference: same thresholds as the former legacy-vs-core comparison.
   HIGH has mirror 0, so the v2.12.0 hull-reflection fix does not show here.

   Regenerating references is an intentional act (a deliberate visual change):
   B5_REF_WRITE=1 npx playwright test tests/browser/core-world.spec.ts
   writes the CURRENT core render as the new reference — say why in the report.

   tools/core-world.html is a dev-only page (not a build input), so this spec
   starts its own Vite dev server; the global webServer (build + preview) is
   not used here. Per shot: mean absolute difference (0..255, over RGB) and
   the share of pixels whose max channel difference exceeds 8/255.
   Side-by-side images (reference | core | |diff|×4) and summary.json go to
   test-results/core-world/.
   ═══════════════════════════════════════════════════════════════════════════ */

import { test, expect, type Browser, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PORT = 5199;
const BASE = `http://127.0.0.1:${PORT}/tools/core-world.html`;
const OUT = join(process.cwd(), 'test-results', 'core-world');
const REF = join(process.cwd(), 'tests', 'browser', 'ref', 'core-world');
const WRITE = !!process.env.B5_REF_WRITE;
const VIEWS = 9;
const PHASES: [string, number][] = [['DAY', 0], ['NIGHT', 2]];
const QUALITY = 'HIGH';
/* Near-identical: the rest is texture rasterizer AA (core/raster vs the
   legacy Canvas2D). Measured legacy-vs-core on RTX 3070 / ANGLE D3D11:
   mean ≤ 0.16, ≤ 0.06 % */
const MAX_MEAN = 0.5;        // mean |Δ| per channel, 0..255
const MAX_PCT8 = 0.5;        // % pixels with max |Δ| > 8/255

declare global {
  interface Window {
    __coreWorld?: { done?: boolean; error?: string; show?: (view: number, phase: number) => Promise<void> };
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

async function shoot(browser: Browser, errors: string[]): Promise<Map<string, Buffer>> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page: Page = await ctx.newPage();
  page.on('console', m => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  page.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) errors.push(`${r.status()} ${r.url()}`); });
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${BASE}?quality=${QUALITY}&view=0&phase=0`);
  await page.waitForFunction(() => window.__coreWorld?.done || window.__coreWorld?.error, null, { timeout: 180_000 });
  const err = await page.evaluate(() => window.__coreWorld?.error);
  expect(err, 'page error').toBeFalsy();
  const out = new Map<string, Buffer>();
  for (const [pname, ph] of PHASES) {
    for (let v = 0; v < VIEWS; v++) {
      await page.evaluate(([vv, pp]) => window.__coreWorld!.show!(vv, pp), [v, ph] as [number, number]);
      out.set(`${v}-${pname}`, await page.locator('canvas').screenshot());
    }
  }
  await ctx.close();
  return out;
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

test('core world vs reference images: 9 views × DAY/NIGHT at HIGH', async ({ browser }) => {
  test.setTimeout(600_000);
  mkdirSync(OUT, { recursive: true });
  const errors: string[] = [];
  const core = await shoot(browser, errors);
  expect(errors).toEqual([]);

  if (WRITE) {
    mkdirSync(REF, { recursive: true });
    for (const [key, png] of core) writeFileSync(join(REF, `view${key}.png`), png);
    console.log(`wrote ${core.size} reference images to ${REF}`);
    return;
  }

  const cmpCtx = await browser.newContext();
  const cmp = await cmpCtx.newPage();
  await cmp.goto('about:blank');
  const rows: { shot: string; mean: number; pct8: number }[] = [];
  for (const [key, png] of core) {
    const file = join(REF, `view${key}.png`);
    expect(existsSync(file), `reference ${file}`).toBe(true);
    const s = await diff(cmp, readFileSync(file), png, ['reference (legacy)', 'core']);
    writeFileSync(join(OUT, `view${key}.png`), Buffer.from(s.png, 'base64'));
    rows.push({ shot: key, mean: +s.mean.toFixed(3), pct8: +s.pct8.toFixed(3) });
  }
  await cmpCtx.close();

  writeFileSync(join(OUT, 'summary.json'), JSON.stringify({ quality: QUALITY, rows }, null, 1));
  console.log('shot        mean|Δ|  %>8/255');
  for (const r of rows) console.log(`${r.shot.padEnd(10)} ${r.mean.toFixed(3).padStart(8)} ${r.pct8.toFixed(2).padStart(8)}`);

  for (const r of rows) {
    expect.soft(r.mean, `${r.shot} mean |Δ|`).toBeLessThan(MAX_MEAN);
    expect.soft(r.pct8, `${r.shot} % > 8/255`).toBeLessThan(MAX_PCT8);
  }
});
