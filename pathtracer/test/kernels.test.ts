/* PT P0 + P1-U2: WGSL kernels (parse + layout agreement via wgsl_reflect),
   kernel loader, device negotiation helpers, three-interop seam checks,
   traverse-ref f32 mode, smoke comparison verdicts. No GPU here — GPU runs
   are pathtracer/smoke (browser: tests/browser/pt-smoke.spec.ts). */
import { describe, expect, test } from 'vitest';
import { WgslReflect } from 'wgsl_reflect/wgsl_reflect.module.js';
import {
  INST_BYTES, INST_OFFSETS, NODE_BYTES, NODE_OFFSETS, TRI_BYTES, TRI_OFFSETS, VIS_ALL,
  buildPackedBlas, createTraverser, packScene, type Hit, type Ray
} from '../bvh/index.ts';
import {
  DBG_BYTES, DBG_OFFSETS, HIT_BYTES, HIT_OFFSETS, IO_STRUCTS, NO_INDEX, PARAMS_BYTES, PARAMS_OFFSETS,
  RAY_BYTES, RAY_OFFSETS, emitWgslRays
} from '../rays.ts';
import {
  DEFAULT_DEFINES, KERNELS, buildKernelSource, dispatchSize, formatCompilationMessages, resolveIncludes
} from '../kernels.ts';
import { MAX_BUFFER_CAP, adoptDevice, checkLimits, computeRequiredLimits, selectFeatures } from '../device.ts';
import { THREE_PINNED_REVISION, ThreeInteropError, threeStorageTextureToGPU, verifyGpuTexture } from '../three-interop.ts';
import { compareHit, type GpuHit } from '../smoke/compare.ts';
import { hullMesh, mulberry32 } from '../smoke/scene.ts';
import { loadWgslSources } from './wgsl-fs.ts';

const sources = loadWgslSources();

/* ─── WGSL parse + layouts ────────────────────────────────────────────────── */

const LAYOUTS: [string, number, Record<string, number>][] = [
  ['B5BvhNode', NODE_BYTES, NODE_OFFSETS],
  ['B5Tri', TRI_BYTES, TRI_OFFSETS],
  ['B5Instance', INST_BYTES, INST_OFFSETS],
  ['B5Ray', RAY_BYTES, RAY_OFFSETS],
  ['B5HitRec', HIT_BYTES, HIT_OFFSETS],
  ['B5KernelParams', PARAMS_BYTES, PARAMS_OFFSETS],
  ['B5Dbg', DBG_BYTES, DBG_OFFSETS]
];

describe('WGSL kernels', () => {
  const entries = [...Object.values(KERNELS).map((k) => [k.file, k.entryPoint] as const), ['k_hitviz.wgsl', 'b5_k_hitviz'] as const];

  test.each(entries)('%s parses; structs match layout.ts / rays.ts', (file, entryPoint) => {
    const src = buildKernelSource(file, sources);
    const r = new WgslReflect(src.code);
    expect(r.entry.compute.map((f) => f.name)).toEqual([entryPoint]);
    for (const [name, size, offsets] of LAYOUTS) {
      const s = r.getStructInfo(name);
      expect(s, `${file}: struct ${name}`).toBeTruthy();
      expect(s!.size, `${name} size`).toBe(size);
      expect(Object.fromEntries(s!.members.map((m) => [m.name, m.offset])), `${name} offsets`).toEqual(offsets);
    }
    // array strides of the storage buffers equal the record sizes
    for (const v of r.storage) {
      const t = v.type as unknown as { stride?: number; format?: { name: string } };
      if (t.stride !== undefined && t.format) {
        const rec = LAYOUTS.find(([n]) => n === t.format!.name);
        if (rec) expect(t.stride, `${v.name} stride`).toBe(rec[1]);
      }
    }
    // hygiene: no '$'; module-scope identifiers prefixed
    expect(src.code.includes('$')).toBe(false);
    for (const m of src.code.matchAll(/^(?:const|override|fn|struct|var(?:<[^>]*>)?)\s+(\w+)/gm)) expect(m[1]).toMatch(/^(B5|b5_)/);
  });

  test('traversal bindings: scene group 0, I/O group 1', () => {
    for (const k of Object.values(KERNELS)) {
      const r = new WgslReflect(buildKernelSource(k.file, sources).code);
      const at = (g: number, b: number) => r.findResource(g, b, k.entryPoint);
      expect(at(0, 0)?.name).toBe('b5_nodes');
      expect(at(0, 1)?.name).toBe('b5_tris');
      expect(at(0, 2)?.name).toBe('b5_insts');
      expect(at(0, 3)?.name).toBe('b5_dbg');
      expect(at(0, 3)?.access).toBe('read_write');
      expect(at(1, 0)?.name).toBe('b5_params');
      expect(at(1, 1)?.name).toBe('b5_rays');
      expect(at(1, 2)?.access).toBe('read_write');
      expect(r.getOverrideInfo('B5_WG_SIZE')).toBeTruthy();
    }
  });

  test('loader: include-once, line map, defines, missing include', () => {
    const files = { 'a.wgsl': '//#include "b.wgsl"\n//#include "c.wgsl"\nfn b5_a() {}', 'b.wgsl': '//#include "c.wgsl"\nfn b5_b() {}', 'c.wgsl': 'fn b5_c() {}' };
    const r = resolveIncludes('a.wgsl', files);
    expect(r.code).toBe('fn b5_c() {}\nfn b5_b() {}\nfn b5_a() {}');
    expect(r.lines).toEqual([{ file: 'c.wgsl', line: 1 }, { file: 'b.wgsl', line: 2 }, { file: 'a.wgsl', line: 3 }]);
    expect(() => resolveIncludes('x.wgsl', { 'x.wgsl': '//#include "nope.wgsl"' })).toThrow(/x\.wgsl:1.*nope\.wgsl/);
    const k = buildKernelSource('k_shadow.wgsl', sources, { B5_TRAVERSE_STACK: 48, B5_FLAG: true });
    expect(k.code).toContain('const B5_TRAVERSE_STACK: u32 = 48u;');
    expect(k.code).toContain('const B5_FLAG: bool = true;');
    expect(k.lines.length).toBe(k.code.split('\n').length);
    expect(DEFAULT_DEFINES.B5_TRAVERSE_STACK).toBe(32);
    // compiler messages map back to the source file
    const idx = k.lines.findIndex((l) => l.file === 'traverse.wgsl' && l.line === 50);
    const msg = formatCompilationMessages([{ type: 'error', message: 'boom', lineNum: idx + 1, linePos: 3 }], k);
    expect(msg).toMatch(/^traverse\.wgsl:50:3: error: boom/);
    expect(() => buildKernelSource('k_shadow.wgsl', sources, { bad: 1 })).toThrow();
  });

  test('dispatchSize splits over y beyond 65535 groups', () => {
    expect(dispatchSize(100, 64)).toEqual([2, 1]);
    expect(dispatchSize(0, 64)).toEqual([1, 1]);
    const [x, y] = dispatchSize(1920 * 1080 * 4, 64);
    expect(x).toBeLessThanOrEqual(65535);
    expect(x * y * 64).toBeGreaterThanOrEqual(1920 * 1080 * 4);
  });

  test('emitted I/O declarations are hygienic', () => {
    const w = emitWgslRays();
    expect(w.includes('$')).toBe(false);
    for (const s of IO_STRUCTS) expect(w).toContain(`struct ${s.name} {`);
  });
});

/* ─── device negotiation (pure parts) ─────────────────────────────────────── */

describe('device', () => {
  const big = {
    maxStorageBufferBindingSize: 2 ** 31, maxBufferSize: 2 ** 31, maxStorageBuffersPerShaderStage: 16,
    maxComputeWorkgroupStorageSize: 32768, maxComputeInvocationsPerWorkgroup: 1024, maxComputeWorkgroupSizeX: 1024,
    maxComputeWorkgroupsPerDimension: 65535, maxBindGroups: 4
  };
  test('requiredLimits: capped at 1 GiB / 10 buffers, never above the adapter', () => {
    expect(computeRequiredLimits(big)).toEqual({
      maxBufferSize: MAX_BUFFER_CAP, maxStorageBufferBindingSize: MAX_BUFFER_CAP,
      maxStorageBuffersPerShaderStage: 10, maxComputeWorkgroupStorageSize: 32768
    });
    const small = { ...big, maxStorageBufferBindingSize: 134217728, maxBufferSize: 268435456, maxStorageBuffersPerShaderStage: 8, maxComputeWorkgroupStorageSize: 16384 };
    expect(computeRequiredLimits(small)).toEqual({
      maxBufferSize: 268435456, maxStorageBufferBindingSize: 134217728,
      maxStorageBuffersPerShaderStage: 8, maxComputeWorkgroupStorageSize: 16384
    });
  });
  test('features: optional ones present on the adapter, or all for three', () => {
    const f = new Set(['timestamp-query', 'texture-compression-bc', 'subgroups', 'core-features-and-limits']);
    expect(selectFeatures(f).sort()).toEqual(['core-features-and-limits', 'subgroups', 'timestamp-query']);
    expect(selectFeatures(f, true).sort()).toEqual([...f].sort());
  });
  test('limits check + adoptDevice error', () => {
    expect(checkLimits(big)).toEqual([]);
    expect(checkLimits({ ...big, maxStorageBuffersPerShaderStage: 4 })[0]).toMatch(/maxStorageBuffersPerShaderStage = 4 < 9/);
    const fake = { limits: { ...big, maxStorageBuffersPerShaderStage: 4 }, createComputePipelineAsync() {} } as unknown as GPUDevice;
    expect(() => adoptDevice(fake)).toThrow(/maxStorageBuffersPerShaderStage/);
    expect(() => adoptDevice({} as GPUDevice)).toThrow(/not a GPUDevice/);
  });
});

/* ─── three interop seam (fakes; the real thing arrives in wave 3) ────────── */

describe('three-interop', () => {
  class FakeGPUTexture {
    width = 64; height = 32; format = 'rgba16float'; usage = 0x08 | 0x04; // STORAGE_BINDING | TEXTURE_BINDING
    createView() { return {}; }
  }
  const dev = {} as GPUDevice;
  const tex = { isStorageTexture: true, image: { width: 64, height: 32 } };
  const mkRenderer = (data: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) => ({
    backend: { isWebGPUBackend: true, device: dev, get: () => data, ...extra }
  });
  const g = globalThis as unknown as Record<string, unknown>;

  test('happy path and every guard', () => {
    const had = 'GPUTexture' in g;
    g.GPUTexture = FakeGPUTexture;
    try {
      const gt = new FakeGPUTexture();
      const opts = { revision: THREE_PINNED_REVISION, device: dev, format: 'rgba16float' as GPUTextureFormat };
      expect(threeStorageTextureToGPU(mkRenderer({ texture: gt }), tex, opts)).toBe(gt);
      expect(() => threeStorageTextureToGPU(mkRenderer({ texture: gt }), tex, { ...opts, revision: '188' })).toThrow(/pinned to r187/);
      expect(() => threeStorageTextureToGPU({ backend: { isWebGPUBackend: false } }, tex, opts)).toThrow(/WebGPU backend/);
      expect(() => threeStorageTextureToGPU(mkRenderer({}), tex, opts)).toThrow(/initTexture/);
      expect(() => threeStorageTextureToGPU(mkRenderer({ texture: gt }), { isStorageTexture: false }, opts)).toThrow(/StorageTexture/);
      expect(() => threeStorageTextureToGPU(mkRenderer({ texture: gt }, { device: {} }), tex, opts)).toThrow(/different GPUDevice/);
      expect(() => threeStorageTextureToGPU(mkRenderer({ texture: { createView() {} } }), tex, opts)).toThrow(/not a GPUTexture/);
      expect(() => threeStorageTextureToGPU(mkRenderer({ texture: gt }), { ...tex, image: { width: 65, height: 32 } }, opts)).toThrow(/width 64 ≠ 65/);
      expect(() => threeStorageTextureToGPU(mkRenderer({ texture: gt }), tex, { ...opts, format: 'rgba32float' })).toThrow(ThreeInteropError);
      gt.usage = 0x04;
      expect(() => verifyGpuTexture(gt, { usage: 0x08 })).toThrow(/lacks 0x8/);
    } finally {
      if (!had) delete g.GPUTexture;
    }
  });
});

/* ─── traverse-ref f32 mode ───────────────────────────────────────────────── */

describe('traverse-ref f32 mode', () => {
  const hull = hullMesh(256, 96);
  const pb = buildPackedBlas(hull.pos, hull.idx);
  const scene = packScene([pb], [{ count: 1, blas: 0, matrices: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) }]);

  function rays(n: number, seed: number): Ray[] {
    const rnd = mulberry32(seed);
    const out: Ray[] = [];
    for (let i = 0; i < n; i++) {
      const th = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * 44;
      let x: number, y: number, z: number, l: number;
      do { x = rnd() * 2 - 1; y = rnd() * 2 - 1; z = rnd() * 2 - 1; l = Math.hypot(x, y, z); } while (l < 1e-3 || l > 1);
      const f = Math.fround;
      out.push({ ox: f(r * Math.sin(th)), oy: f(r * Math.cos(th)), oz: f((rnd() - 0.5) * 280), dx: f(x / l), dy: f(y / l), dz: f(z / l), tmin: 0, tmax: 1e30 });
    }
    return out;
  }

  test('agrees with the f64 oracle; results are f32; frontFace = geometric normal faces the ray', () => {
    const t64 = createTraverser(scene);
    const t32 = createTraverser(scene, { f32: true });
    const tri = new Float32Array(scene.tris);
    let same = 0, ties = 0, fails = 0, front = 0, hits = 0;
    for (const r of rays(5000, 3)) {
      const a = t64.closestHit(r), b = t32.closestHit(r);
      expect(!!a).toBe(!!b);
      if (!a || !b) continue;
      hits++;
      expect(Math.fround(b.t)).toBe(b.t);
      expect(Math.fround(b.u)).toBe(b.u);
      expect(t32.anyHit(r)).toBe(true);
      if (a.tri === b.tri) { same++; expect(Math.abs(a.t - b.t)).toBeLessThanOrEqual(1e-5 * a.t); }
      else if (Math.abs(a.t - b.t) <= 1e-5 * a.t) ties++;
      else fails++;
      // geometric normal (v1−v0)×(v2−v0) vs ray direction
      const w = b.tri * 12;
      const e1 = [tri[w + 4] - tri[w], tri[w + 5] - tri[w + 1], tri[w + 6] - tri[w + 2]];
      const e2 = [tri[w + 8] - tri[w], tri[w + 9] - tri[w + 1], tri[w + 10] - tri[w + 2]];
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const dn = n[0] * r.dx + n[1] * r.dy + n[2] * r.dz;
      expect(b.frontFace).toBe(dn < 0);
      if (b.frontFace) front++;
    }
    console.log(`[pt] f32 vs f64 on the hull: hits ${hits}, same ${same}, ties ${ties}, fails ${fails}, front faces ${front}`);
    expect(fails).toBe(0);
    expect(hits).toBeGreaterThan(4000);
    expect(same).toBeGreaterThan(hits * 0.99);
    expect(front).toBeGreaterThan(hits * 0.9); // inward hull seen from inside
    expect(t32.stats.stackOverflow).toBe(0);
    expect(t32.stats.maxStack).toBeLessThanOrEqual(32);
  });

  test('stack overflow: counted, never thrown; the farthest entry is dropped', () => {
    const tiny = createTraverser(scene, { f32: true, stackSize: 2 });
    const ok = createTraverser(scene, { f32: true });
    let found = 0, n = 0;
    for (const r of rays(500, 5)) {
      const a = ok.closestHit(r), b = tiny.closestHit(r);
      n++;
      if (a && b && a.tri === b.tri) found++;
    }
    expect(tiny.stats.stackOverflow).toBeGreaterThan(0);
    expect(tiny.stats.maxStack).toBe(2);
    // ordered traversal keeps the near subtrees: most closest hits survive even with 2 entries
    expect(found / n).toBeGreaterThan(0.5);
    // the default (f64) mode still throws on its (much larger) stack overflow
    expect(() => createTraverser(scene, { f32: true, stackSize: 0 })).toThrow(RangeError);
  });

  test('default mode unchanged: no frontFace, f64 values', () => {
    const t64 = createTraverser(scene);
    const h = t64.closestHit(rays(1, 9)[0]) as Hit;
    expect(h.frontFace).toBeUndefined();
    expect(t64.stats.stackOverflow).toBe(0);
    expect(VIS_ALL).toBe(15);
  });
});

/* ─── smoke comparison verdicts ───────────────────────────────────────────── */

describe('smoke compare', () => {
  const g = (o: Partial<GpuHit>): GpuHit => ({ t: 10, u: 0.25, v: 0.5, inst: 3, tri: 7, front: true, ...o });
  const h = (o: Partial<Hit>): Hit => ({ t: 10, u: 0.25, v: 0.5, instance: 3, tri: 7, prim: 1, frontFace: true, ...o });
  test('verdicts', () => {
    expect(compareHit(g({}), h({}))).toBe('exact');
    expect(compareHit(g({ tri: NO_INDEX }), null)).toBe('exact');
    expect(compareHit(g({ t: 10.00001 }), h({}))).toBe('close');
    expect(compareHit(g({ t: 10.1 }), h({}))).toBe('mismatch');
    expect(compareHit(g({ tri: 8, t: 10.0005 }), h({}))).toBe('tie');
    expect(compareHit(g({ tri: 8, t: 10.1 }), h({}))).toBe('mismatch');
    expect(compareHit(g({ tri: NO_INDEX }), h({}))).toBe('mismatch');
    expect(compareHit(g({}), null)).toBe('mismatch');
    expect(compareHit(g({ front: false }), h({}))).toBe('close');
  });
});
