/* Post pipeline (backends/three/post) without a GPU:
   - the tone-mapping CPU reference and the three ↔ classic ACES calibration;
   - the custom TSL nodes (EASU / sharpen ports, bright pass, glow blur,
     axis rays, tone map) compile with three's WGSL and GLSL node builders;
   - the RenderPipeline graph constructs for every option combination and
     its output material compiles with both builders.
   Headless shims as in core/test/shading-tsl.test.ts: a stub canvas,
   renderer._bindings = undefined, builder.camera / builder.scene. */
import { describe, expect, test } from 'vitest';
import * as THREE from 'three/webgpu';
import { texture, uniform, uv, vec2, vec4, Fn } from 'three/tsl';
import { easu } from '../post/fsrEasu.ts';
import { rcas } from '../post/rcas.ts';
import { axisRays, brightPass, glowBlur } from '../post/axisRays.ts';
import { toScreen, toScreenCpu, ACES_THREE_EXPOSURE_SCALE } from '../post/tonemap.ts';
import { createRenderPipeline } from '../post/pipeline.ts';
import {
  AA_FILTER_IDS, aaParts, defaultPostOptions, optionsFromParams, renderScaleOf, scaleRegime, sharpenFor,
  type PostOptions
} from '../post/options.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TslNode = any;

/* SMAANode loads its area / search LUTs through 
ew Image() (data URIs) */
const G = globalThis as unknown as { Image?: unknown };
G.Image ??= class { width = 0; height = 0; src = ''; onload: null | (() => void) = null; addEventListener() {} removeEventListener() {} };

function headlessRenderer(glsl: boolean): THREE.WebGPURenderer {
  const canvas = {
    style: {}, width: 1280, height: 720,
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, getContext() { return null; },
  };
  const r = new THREE.WebGPURenderer({ forceWebGL: glsl, canvas: canvas as unknown as HTMLCanvasElement });
  (r as unknown as { _bindings: unknown })._bindings = undefined;
  /* normally answered by the initialised backend (float32-filterable etc.) */
  (r as unknown as { hasFeature(): boolean }).hasFeature = () => false;
  return r;
}

type BuilderCtor = new (o: unknown, r: unknown) => {
  material: unknown; camera: unknown; scene: unknown; fragmentShader: string; build(): void;
};
const builderFor = (glsl: boolean): BuilderCtor =>
  (THREE as unknown as Record<string, BuilderCtor>)[glsl ? 'GLSLNodeBuilder' : 'WGSLNodeBuilder'];

/** Compile a material on a fullscreen-like mesh; returns the fragment code. */
function compileMaterial(mat: THREE.NodeMaterial, glsl: boolean, renderer = headlessRenderer(glsl)): string {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(), mat);
  const B = builderFor(glsl);
  const builder = new B(mesh, renderer);
  builder.material = mat;
  builder.camera = new THREE.PerspectiveCamera();
  builder.scene = new THREE.Scene();
  builder.build();
  return builder.fragmentShader;
}

function compileColor(node: () => TslNode, glsl: boolean): string {
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.colorNode = Fn(node)();
  return compileMaterial(mat, glsl);
}

const tex = (): TslNode => {
  const t = new THREE.DataTexture(new Uint8Array(16 * 16 * 4), 16, 16);
  t.needsUpdate = true;
  return texture(t);
};

/* ── tone mapping ──────────────────────────────────────────────────────── */

describe('tone mapping reference', () => {
  test('toScreenCpu: black → 0, monotonic, saturates to 1', () => {
    expect(toScreenCpu([0, 0, 0], 1)).toEqual([0, 0, 0]);
    let prev = -1;
    for (let i = 0; i <= 64; i++) {
      const v = toScreenCpu([i / 8, i / 8, i / 8], 1)[1];
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(toScreenCpu([1e4, 1e4, 1e4], 1)[0]).toBeCloseTo(1, 3);
  });

  test('three ACES = classic ACES at exposure × 0.6 (exact algebra)', () => {
    /* three: aces(x · e / 0.6). With e' = e · 0.6 → aces(x · e): identical. */
    expect(ACES_THREE_EXPOSURE_SCALE / 0.6).toBe(1);
    // the calibrated scale reproduces mid-grey exactly
    const a = toScreenCpu([0.18, 0.18, 0.18], 1);
    const b = toScreenCpu([0.18 / 0.6 * ACES_THREE_EXPOSURE_SCALE, 0.18 / 0.6 * ACES_THREE_EXPOSURE_SCALE, 0.18 / 0.6 * ACES_THREE_EXPOSURE_SCALE], 1);
    for (let i = 0; i < 3; i++) expect(b[i]).toBeCloseTo(a[i], 12);
  });
});

/* ── options ───────────────────────────────────────────────────────────── */

describe('post options', () => {
  test('AA ids are CONFIG.AA_FILTER, parts decode', async () => {
    const { CONFIG } = await import('../../../js/config.js') as { CONFIG: { AA_FILTER: { id: string }[] } };
    expect(CONFIG.AA_FILTER.map(x => x.id)).toEqual([...AA_FILTER_IDS]);
    expect(aaParts('taasmaafxaa')).toEqual({ taa: true, smaa: true, fxaa: true });
    expect(aaParts('smaa')).toEqual({ taa: false, smaa: true, fxaa: false });
  });

  test('scale regimes, sharpen formula, URL params', () => {
    const d = defaultPostOptions();
    expect(scaleRegime(d)).toBe('native');
    expect(scaleRegime({ ...d, ssaa: 2 })).toBe('down');
    expect(scaleRegime({ ...d, fsr: 0.5 })).toBe('up');
    expect(renderScaleOf({ ...d, ssaa: 2, fsr: 0.5 })).toBe(1);
    expect(sharpenFor(1)).toBe(0);
    expect(sharpenFor(0.35)).toBeCloseTo(0.55, 6);
    const o = optionsFromParams(new URLSearchParams('aa=taasmaa&msaa=4&fsr=0.67&bloom=1&rays=1&bloomImpl=classic'));
    expect(o).toMatchObject({ aa: 'taasmaa', msaa: 4, fsr: 0.67, bloom: true, rays: true, bloomImpl: 'classic' });
  });
});

/* ── custom TSL nodes compile on both builders ─────────────────────────── */

const CUSTOM: [string, () => TslNode][] = [
  ['easu', () => vec4(easu(tex(), uv()), 1)],
  ['rcas', () => vec4(rcas(tex(), uniform(0.4), uv()), 1)],
  ['bright', () => vec4(brightPass(tex().sample(uv()).rgb, uniform(0.45)), 1)],
  ['glow blur', () => vec4(glowBlur(tex(), vec2(0.01, 0)), 1)],
  ['axis rays', () => vec4(axisRays(tex(), uniform(new THREE.Vector2(0.5, 0.4)), uniform(0.5), uniform(0.9), 32), 1)],
  ['tonemap b5', () => vec4(toScreen(tex().sample(uv()).rgb, 'b5'), 1)],
  ['tonemap three', () => vec4(toScreen(tex().sample(uv()).rgb, 'three'), 1)],
];

describe('custom TSL nodes', () => {
  test.each(CUSTOM)('%s compiles with WGSLNodeBuilder and GLSLNodeBuilder', (_n, node) => {
    for (const glsl of [false, true]) {
      const code = compileColor(node, glsl);
      expect(code.length).toBeGreaterThan(100);
      expect(code).toMatch(glsl ? /texture/ : /texture\w*\(/);
    }
  });

  test('axis rays loop is a real loop (not unrolled), tonemap has the classic constants', () => {
    const w = compileColor(CUSTOM[4][1], false);
    expect(w).toMatch(/\bfor\s*\(/);
    const t = compileColor(CUSTOM[5][1], false);
    expect(t).toContain('0.0245786');
    expect(t).toContain('0.41666');
  });
});

/* ── whole graphs for every option combo ───────────────────────────────── */

const COMBOS: Partial<PostOptions>[] = [];
for (const aa of AA_FILTER_IDS) {
  for (const msaa of [0, 4] as const) COMBOS.push({ aa, msaa });
}
COMBOS.push(
  { aa: 'none', msaa: 8 }, { aa: 'none', msaa: 2 },
  { aa: 'none', bloom: true }, { aa: 'none', bloom: true, bloomImpl: 'classic' },
  { aa: 'none', rays: true }, { aa: 'smaafxaa', bloom: true, rays: true },
  { aa: 'none', fsr: 0.67 }, { aa: 'taa', fsr: 0.5 }, { aa: 'none', fsr: 0.5, fsrImpl: 'three' },
  { aa: 'none', ssaa: 2 }, { aa: 'taasmaafxaa', ssaa: 1.5, bloom: true, rays: true },
  { aa: 'taafxaa', fsr: 0.77, bloom: true, bloomImpl: 'classic', rays: true },
  { tonemap: 'three' }, { tonemap: 'none' }
);

function scene(): { scene: THREE.Scene; camera: THREE.PerspectiveCamera } {
  const s = new THREE.Scene();
  s.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardNodeMaterial()));
  return { scene: s, camera: new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 100) };
}

describe('RenderPipeline graphs', () => {
  test.each(COMBOS.map(c => [JSON.stringify(c), c] as const))('%s: constructs and compiles (WGSL + GLSL)', (_k, combo) => {
    for (const glsl of [false, true]) {
      const r = headlessRenderer(glsl);
      const { scene: s, camera } = scene();
      const p = createRenderPipeline(r, s, camera, combo);
      const st = p.describe().stages;
      const parts = aaParts(p.options.aa);
      expect(st.includes('traa')).toBe(parts.taa);
      expect(st.includes('smaa')).toBe(parts.smaa);
      expect(st.includes('fxaa')).toBe(parts.fxaa);
      expect(st.some(x => x.startsWith('bloom') || x.startsWith('glow'))).toBe(!!p.options.bloom);
      expect(st.includes('rays')).toBe(!!p.options.rays);
      expect(st[0]).toMatch(parts.taa ? /msaa0/ : new RegExp(`msaa${p.options.msaa}`));
      /* compile the pipeline's own output quad material */
      const rp = p.renderPipeline as unknown as { _update(): void; _quadMesh: THREE.Mesh };
      rp._update();
      const code = compileMaterial(rp._quadMesh.material as THREE.NodeMaterial, glsl, r);
      expect(code.length).toBeGreaterThan(100);
      p.dispose();
    }
  });

  test('uniform-only option changes keep the graph; structural ones rebuild', () => {
    const r = headlessRenderer(false);
    const { scene: s, camera } = scene();
    const p = createRenderPipeline(r, s, camera, { aa: 'fxaa' });
    const n0 = p.renderPipeline.outputNode;
    p.setOptions({ glow: 2, threshold: 0.6, rayDecay: 0.8, exposure: 1.3 });
    expect(p.renderPipeline.outputNode).toBe(n0);
    p.setOptions({ aa: 'smaa' });
    expect(p.renderPipeline.outputNode).not.toBe(n0);
    p.compositeExternal(tex(), 0.5);
    expect(p.describe().external).toBe(true);
    expect(p.describe().stages[0]).toBe('external');
    p.compositeExternal(null);
    expect(p.describe().external).toBe(false);
    p.dispose();
  });
});
