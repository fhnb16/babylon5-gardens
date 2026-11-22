/* ═══════════════════════════════════════════════════════════════════════════
   WebGPU post pipeline (backends/three/post) on tools/post-lab.html, on both
   backends of WebGPURenderer: native WebGPU and the WebGL2 fallback.

   - every CONFIG.AA_FILTER option (with and without MSAA) and the bloom /
     rays / FSR / SSAA combinations render without WebGPU validation errors,
     console errors or page errors; screenshots → test-results/post/;
   - tone mapping: a fixed HDR ramp through compositeExternal() is compared
     with the CPU port of the classic js/photo.js toScreen() — both our ACES
     port ('b5') and three's acesFilmicToneMapping with the calibrated
     exposure ('three'), read back from a render target and from the canvas:
     max error < 2/255;
   - TAA (three's TRAA via ScaledTRAANode) keeps its history at render
     scales ≠ 1 (SSAA, FSR): two consecutive frames of a static scene differ
     by < 1/255 on average (stock TRAANode: ~3–4/255, the jitter flickers);
   - frame cost per option at 1280×720 → test-results/post/timing-*.json:
     WebGPU timestamp queries summed over every pass of a frame, and wall
     time per frame with a GPU drain (CPU-bound on a fast GPU — an upper
     bound, the only number on the WebGL2 fallback).

   tools/post-lab.html is a dev-only page: this spec runs its own Vite dev
   server (the global build + preview server is not used).
   ═══════════════════════════════════════════════════════════════════════════ */
import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PORT = 5201;
const BASE = `http://127.0.0.1:${PORT}/tools/post-lab.html`;
const OUT = join(process.cwd(), 'test-results', 'post');
const MAX_TONEMAP_ERR = 2;       // /255
const MAX_TAA_FLICKER = 1;       // mean |Δ| /255 between two static TAA frames
const TAA_FRAMES = 24;           // frames before a shot (TAA history settles)
const TIME_FRAMES = Number(process.env.B5_POST_TIME_FRAMES ?? 120);

test.use({
  viewport: { width: 1280, height: 720 },
  launchOptions: {
    args: process.env.PT_SMOKE_ARGS !== undefined ? process.env.PT_SMOKE_ARGS.split(/\s+/).filter(Boolean) : [
      '--enable-unsafe-webgpu', '--enable-webgpu-developer-features',
      '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'
    ]
  }
});

interface LabResult { maxErr: number; meanErr: number; worst: number[] }
interface Lab {
  ready: boolean; error?: string; errors: string[]; isWebGPU: boolean; stages: string[];
  setOptions(p: Record<string, unknown>): string[];
  frames(n: number): Promise<void>;
  time(n: number): Promise<{ wallMs: number; gpuMs: number | null; gpuPasses: number; detail: string[] }>;
  probeRamp(tonemap: string, exposure: number, canvas?: boolean): Promise<LabResult>;
  setAnim(on: boolean): void;
  frameDiff(n: number): Promise<number>;
}
declare global { interface Window { __postLab?: Lab } }

const BASE_OPTS = { msaa: 0, aa: 'none', ssaa: 1, fsr: 1, fsrImpl: 'b5', bloom: false, bloomImpl: 'three', rays: false };
const AA_IDS = ['none', 'fxaa', 'smaa', 'smaafxaa', 'taa', 'taafxaa', 'taasmaa', 'taasmaafxaa'];
const CASES: [string, Record<string, unknown>][] = [];
for (const aa of AA_IDS) CASES.push([`aa-${aa}`, { aa }]);
for (const msaa of [2, 4, 8]) CASES.push([`msaa${msaa}`, { msaa }]);
CASES.push(
  ['msaa4-smaafxaa', { msaa: 4, aa: 'smaafxaa' }],
  ['bloom', { bloom: true }],
  ['bloom-classic', { bloom: true, bloomImpl: 'classic' }],
  ['rays', { rays: true }],
  ['bloom-rays', { bloom: true, rays: true }],
  ['fsr077', { fsr: 0.77 }],
  ['fsr067', { fsr: 0.67 }],
  ['fsr050', { fsr: 0.5 }],
  ['fsr050-three', { fsr: 0.5, fsrImpl: 'three' }],
  ['ssaa125', { ssaa: 1.25 }],
  ['ssaa2', { ssaa: 2 }],
  ['taa-fsr067', { aa: 'taa', fsr: 0.67 }],
  ['taa-ssaa15', { aa: 'taa', ssaa: 1.5 }],
  ['full-taasmaafxaa-bloom-rays-fsr067', { aa: 'taasmaafxaa', bloom: true, rays: true, fsr: 0.67 }],
  ['msaa4-fxaa-bloomclassic-rays-ssaa15', { msaa: 4, aa: 'fxaa', bloom: true, bloomImpl: 'classic', rays: true, ssaa: 1.5 }],
  /* last: exaggerated rays to eyeball their direction (stays set afterwards) */
  ['rays-x10', { rays: true, rayStrength: 3 }]
);

let server: ViteDevServer | null = null;
test.beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  server = await createServer({
    server: { port: PORT, strictPort: true, host: '127.0.0.1' },
    logLevel: 'error', clearScreen: false
  });
  await server.listen();
});
test.afterAll(async () => { await server?.close(); });

const IGNORE = [/favicon/i, /DevTools/i];
const BAD_WARN = /validation|invalid|GPUValidationError|uncaptured|device lost|WebGL: INVALID/i;

async function openLab(page: Page, backend: string, params = ''): Promise<string[]> {
  const log: string[] = [];
  page.on('console', (m: ConsoleMessage) => {
    const t = `${m.text()} (${m.location().url})`;
    if (IGNORE.some(r => r.test(t))) return;
    if (m.type() === 'error' || (m.type() === 'warning' && BAD_WARN.test(t))) log.push(`[${m.type()}] ${t}`);
  });
  page.on('pageerror', e => log.push(`[pageerror] ${e.message}`));
  await page.goto(`${BASE}?backend=${backend}&hud=0${params}`);
  await page.waitForFunction(() => window.__postLab?.ready || window.__postLab?.error, null, { timeout: 90_000 });
  const err = await page.evaluate(() => window.__postLab?.error);
  expect(err, 'post-lab startup').toBeFalsy();
  return log;
}

for (const backend of ['webgpu', 'webgl'] as const) {
  test.describe(`post pipeline · ${backend}`, () => {
    test.describe.configure({ timeout: 600_000 });

    test('backend is the requested one', async ({ page }) => {
      await openLab(page, backend);
      const isGpu = await page.evaluate(() => window.__postLab!.isWebGPU);
      expect(isGpu, 'WebGPU backend active').toBe(backend === 'webgpu');
    });

    test('every AA option and effect combo renders cleanly; shots + timing', async ({ page }) => {
      const log = await openLab(page, backend);
      const timing: Record<string, { stages: string[]; wallMs: number; gpuMs: number | null; gpuPasses: number; detail: string[] }> = {};
      for (const [name, opts] of CASES) {
        const stages = await page.evaluate(o => window.__postLab!.setOptions(o), { ...BASE_OPTS, ...opts });
        await page.evaluate(n => window.__postLab!.frames(n), TAA_FRAMES);
        const labErrors = await page.evaluate(() => window.__postLab!.errors.splice(0));
        expect([...labErrors, ...log.splice(0)], `${backend}/${name}: ${stages.join(' → ')}`).toEqual([]);
        await page.locator('canvas').screenshot({ path: join(OUT, `${backend}-${name}.png`) });
        const t = await page.evaluate(n => window.__postLab!.time(n), TIME_FRAMES);
        timing[name] = { stages, ...t };
        const after = await page.evaluate(() => window.__postLab!.errors.splice(0));
        expect([...after, ...log.splice(0)], `${backend}/${name} (timing run)`).toEqual([]);
      }
      writeFileSync(join(OUT, `timing-${backend}.json`), JSON.stringify(timing, null, 2));
      const rows = Object.entries(timing).map(([k, v]) =>
        `${k.padEnd(40)} wall ${v.wallMs.toFixed(2).padStart(6)} ms` + (v.gpuMs !== null ? `  gpu ${v.gpuMs.toFixed(3).padStart(6)} ms in ${v.gpuPasses} passes` : ''));
      console.log(`\n[${backend}] frame cost at 1280×720\n${rows.join('\n')}`);
    });

    test('TAA history holds at every render scale (static scene is stable)', async ({ page }) => {
      const log = await openLab(page, backend);
      await page.evaluate(() => window.__postLab!.setAnim(false));
      const res: Record<string, number> = {};
      for (const [name, o] of [
        ['none', { aa: 'none' }], ['taa', { aa: 'taa' }],
        ['taa-ssaa15', { aa: 'taa', ssaa: 1.5 }], ['taa-ssaa2', { aa: 'taa', ssaa: 2 }],
        ['taa-fsr067', { aa: 'taa', fsr: 0.67 }], ['taa-fsr050', { aa: 'taa', fsr: 0.5 }]
      ] as [string, Record<string, unknown>][]) {
        await page.evaluate(p => window.__postLab!.setOptions(p), { ...BASE_OPTS, ...o });
        res[name] = await page.evaluate(n => window.__postLab!.frameDiff(n), 48);
      }
      console.log(`\n[${backend}] frame-to-frame mean |Δ| (static scene)\n` +
        Object.entries(res).map(([k, v]) => `${k.padEnd(12)} ${v.toFixed(3)}`).join('\n'));
      expect(res.none).toBeLessThan(0.01);
      for (const [k, v] of Object.entries(res)) expect(v, k).toBeLessThan(MAX_TAA_FLICKER);
      expect([...await page.evaluate(() => window.__postLab!.errors), ...log]).toEqual([]);
    });

    test('URL params build the same graph (fresh page)', async ({ page }) => {
      const log = await openLab(page, backend, '&aa=taasmaafxaa&bloom=1&rays=1&fsr=0.67&frames=8');
      const st = await page.evaluate(() => window.__postLab!.stages);
      expect(st).toEqual(expect.arrayContaining(['traa', 'easu', 'rcas', 'bloom(three)', 'rays', 'smaa', 'fxaa']));
      expect([...await page.evaluate(() => window.__postLab!.errors), ...log]).toEqual([]);
    });

    test('tone mapping matches the classic toScreen (< 2/255)', async ({ page }) => {
      const log = await openLab(page, backend);
      const report: Record<string, LabResult> = {};
      for (const tm of ['b5', 'three']) {
        for (const exposure of [1, 0.6, 1.7]) {
          for (const canvas of [false, true]) {
            const r = await page.evaluate(([a, b, c]) => window.__postLab!.probeRamp(a, b, c), [tm, exposure, canvas] as [string, number, boolean]);
            const key = `${tm} exp${exposure} ${canvas ? 'canvas' : 'rt'}`;
            report[key] = r;
            expect(r.maxErr, `${backend} ${key} worst [i, ch, got, ref] = ${r.worst.join(', ')}`).toBeLessThan(MAX_TONEMAP_ERR);
          }
        }
      }
      writeFileSync(join(OUT, `tonemap-${backend}.json`), JSON.stringify(report, null, 2));
      console.log(`\n[${backend}] tonemap probe\n` + Object.entries(report)
        .map(([k, v]) => `${k.padEnd(22)} max ${v.maxErr.toFixed(3)}  mean ${v.meanErr.toFixed(3)} /255`).join('\n'));
      expect([...await page.evaluate(() => window.__postLab!.errors), ...log]).toEqual([]);
    });
  });
}
