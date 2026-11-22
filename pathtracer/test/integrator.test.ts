/* PT-U4 integrator: WGSL parse + layouts of the integrator kernels, camera
   ray generation vs core/math (and three), queue / indirect-args / wave
   packing, frame uniform serialization, and the CPU reference path tracer
   (furnace Le / (1 − ρ), NEE+MIS ≡ BSDF-only). No GPU here — GPU runs are
   tests/browser/pt-view.spec.ts. */
import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { WgslReflect } from 'wgsl_reflect/wgsl_reflect.module.js';
import { viewPose } from '../../core/camera/flight.ts';
import { CORE_CONFIG } from '../../core/config/index.ts';
import { lightingAt, exposureFromEv100 } from '../../core/lighting/phases.ts';
import { compose, invert, transformPoint } from '../../core/math/mat4.ts';
import { buildKernelSource, dispatchSize } from '../kernels.ts';
import {
  CAPACITY_ALIGN, FRAME_BYTES, integratorGeneratedSources, FRAME_OFFSETS, FRAME_SLOT, INTEGRATOR_KERNELS, MAX_WAVES_PER_SUBMIT, PATH_BYTES,
  PATH_OFFSETS, Q, Q_CTL_WORDS, STUB_DEFINES, argsSplit, cameraBasis, cameraRayDir, pathCapacity, pathsForBudget,
  planWaves, planWavesByCost, createCostModel, estimateMs, updateCostModel, COST_REGIONS, queuesBytes, tubeFromEmitters, tubeRadiance, writeFrame, type FrameParams
} from '../integrator.ts';
import { furnaceRadiance, refEstimate, refIntersect, type RefScene } from '../integrator-ref.ts';
import { RAY_BYTES } from '../rays.ts';
import { surfaceGeneratedSources } from '../scene-upload.ts';
import { FRAME_F, paletteUniform } from '../materials.ts';
import { loadWgslSources } from './wgsl-fs.ts';

const fsSources = loadWgslSources();
/* U3's surface (+ scene-upload.ts generated includes) and the Lambert stub */
const sources = { ...fsSources, ...surfaceGeneratedSources(), ...integratorGeneratedSources() };
const stubSources = { ...fsSources, ...integratorGeneratedSources(), 'surface.wgsl': fsSources['surface_stub.wgsl'] };
const defines = { B5_SPECULAR: true, ...STUB_DEFINES };

/* ─── WGSL ────────────────────────────────────────────────────────────────── */

describe('integrator WGSL', () => {
  const entries = Object.values(INTEGRATOR_KERNELS).map((k) => [k.file, k.entryPoint] as const);

  test.each(entries)('%s parses, B5Frame / B5Path match integrator.ts, hygiene', (file, entryPoint) => {
    const src = buildKernelSource(file, sources, defines);
    const r = new WgslReflect(src.code);
    expect(r.entry.compute.map((f) => f.name)).toEqual([entryPoint]);
    expect(src.code.includes('$')).toBe(false);
    if (!src.code.includes('struct B5Frame')) return; // k_shadow_tr / k_lightpower: no integrator state
    const frame = r.getStructInfo('B5Frame')!;
    expect(frame.size).toBe(FRAME_BYTES);
    expect(Object.fromEntries(frame.members.map((m) => [m.name, m.offset]))).toEqual(FRAME_OFFSETS);
    const path = r.getStructInfo('B5Path')!;
    expect(path.size).toBe(PATH_BYTES);
    expect(Object.fromEntries(path.members.map((m) => [m.name, m.offset]))).toEqual(PATH_OFFSETS);
    expect(src.code.includes('$')).toBe(false);
    for (const m of src.code.matchAll(/^(?:const|override|fn|struct|var(?:<[^>]*>)?)\s+(\w+)/gm)) expect(m[1]).toMatch(/^(B5|b5_)/);
  });

  test('queue control word constants agree', () => {
    const code = buildKernelSource('k_args.wgsl', sources, defines).code;
    const val = (n: string) => Number(new RegExp(`const ${n}: u32 = (\\d+)u;`).exec(code)?.[1]);
    expect(val('B5_Q_COUNT')).toBe(Q.count);
    expect(val('B5_Q_NEXT')).toBe(Q.next);
    expect(val('B5_Q_SHADOW')).toBe(Q.shadow);
    expect(val('B5_Q_SHADOW_LIVE')).toBe(Q.shadowLive);
    expect(val('B5_Q_PARITY')).toBe(Q.parity);
    expect(val('B5_Q_RAYS')).toBe(Q.rays);
    expect(val('B5_Q_SHADOWS')).toBe(Q.shadows);
    expect(val('B5_Q_CTL')).toBe(Q_CTL_WORDS);
  });

  test('k_shade also builds with the Lambert stub surface', () => {
    const r = new WgslReflect(buildKernelSource('k_shade.wgsl', stubSources, defines).code);
    expect(r.entry.compute.map((f) => f.name)).toEqual(['b5_k_shade']);
    expect(r.getStructInfo('B5Surface')).toBeTruthy();
  });

  test('k_shade bindings: scene tris/insts in group 0, integrator group 1', () => {
    const r = new WgslReflect(buildKernelSource('k_shade.wgsl', sources, defines).code);
    const at = (g: number, b: number) => r.findResource(g, b, 'b5_k_shade');
    expect(at(1, 0)?.name).toBe('b5_wave');
    expect(at(0, 1)?.name).toBe('b5_tris');
    expect(at(0, 2)?.name).toBe('b5_insts');
    expect(at(2, 3)?.name).toBe('b5_frame'); // U3's surface frame uniform
    expect(at(1, 1)?.name).toBe('b5_paths');
    expect(at(1, 2)?.name).toBe('b5_hits');
    expect(at(1, 3)?.name).toBe('b5_queues');
    expect(at(1, 4)?.name).toBe('b5_rays');
  });
});

/* ─── camera ──────────────────────────────────────────────────────────────── */

describe('camera rays', () => {
  const W = 960, H = 540, fov = 60;

  test.each(CORE_CONFIG.TP.map((v, i) => [i, v] as const))('view %i: rays project back to their pixel (core/math)', (_i, v) => {
    const pose = viewPose(v.pos, v.look);
    const b = cameraBasis(pose, fov, W / H);
    // forward = toward the look target
    const look = [Math.sin(v.look[0] * Math.PI / 180) * v.look[1], Math.cos(v.look[0] * Math.PI / 180) * v.look[1], v.look[2]];
    const tf = [look[0] - b.pos[0], look[1] - b.pos[1], look[2] - b.pos[2]];
    const tl = Math.hypot(tf[0], tf[1], tf[2]);
    expect(b.fwd[0] * tf[0] / tl + b.fwd[1] * tf[1] / tl + b.fwd[2] * tf[2] / tl).toBeCloseTo(1, 9);
    // camera up leans toward the axis (station up)
    const su = [-b.pos[0], -b.pos[1], 0];
    expect(b.up[0] * su[0] + b.up[1] * su[1]).toBeGreaterThan(0);
    // view matrix from core/math: project ray points to NDC
    const inv = invert(compose(pose.pos, pose.quat, [1, 1, 1]));
    const t = Math.tan(fov * Math.PI / 360), aspect = W / H;
    for (const [px, py] of [[0, 0], [W, H], [W / 2, H / 2], [123.25, 400.5], [W, 0]]) {
      const d = cameraRayDir(b, px, py, W, H);
      const q = transformPoint(inv, [b.pos[0] + d[0] * 10, b.pos[1] + d[1] * 10, b.pos[2] + d[2] * 10]);
      const ndcX = q[0] / (-q[2] * t * aspect), ndcY = q[1] / (-q[2] * t);
      expect(ndcX).toBeCloseTo(px / W * 2 - 1, 9);
      expect(ndcY).toBeCloseTo(1 - py / H * 2, 9);
      expect(Math.hypot(d[0], d[1], d[2])).toBeCloseTo(1, 12);
    }
  });

  test('matches three PerspectiveCamera.project', () => {
    const v = CORE_CONFIG.TP[0];
    const pose = viewPose(v.pos, v.look);
    const cam = new THREE.PerspectiveCamera(fov, W / H, 0.1, 1000);
    cam.position.set(pose.pos[0], pose.pos[1], pose.pos[2]);
    cam.quaternion.set(pose.quat[0], pose.quat[1], pose.quat[2], pose.quat[3]);
    cam.updateMatrixWorld(true);
    const b = cameraBasis(pose, fov, W / H);
    for (const [px, py] of [[10, 20], [480, 270], [900, 500]]) {
      const d = cameraRayDir(b, px, py, W, H);
      const p = new THREE.Vector3(pose.pos[0] + d[0] * 50, pose.pos[1] + d[1] * 50, pose.pos[2] + d[2] * 50).project(cam);
      expect(p.x).toBeCloseTo(px / W * 2 - 1, 6);
      expect(p.y).toBeCloseTo(1 - py / H * 2, 6);
    }
  });
});

/* ─── queues / args / waves / frame ───────────────────────────────────────── */

describe('queues and waves', () => {
  test('argsSplit = kernels.ts dispatchSize for count > 0; zero groups for an empty queue', () => {
    for (const n of [1, 63, 64, 65, 4_000_000, 65535 * 64, 65535 * 64 + 1, 1920 * 1080 * 3]) {
      const [x, y, z] = argsSplit(n, 64, 65535);
      expect([x, y]).toEqual(dispatchSize(n, 64, 65535));
      expect(z).toBe(1);
      expect(x).toBeLessThanOrEqual(65535);
      expect(x * y * 64).toBeGreaterThanOrEqual(n);
    }
    expect(argsSplit(0, 64, 65535)).toEqual([0, 1, 1]);
  });

  test('capacity alignment keeps the shadow-ray region 256-byte aligned', () => {
    for (const [w, h] of [[960, 540], [1920, 1080], [37, 23], [1, 1], [4096, 2160]]) {
      const c = pathCapacity(w * h, 1 << 20);
      expect(c % CAPACITY_ALIGN).toBe(0);
      expect((c * RAY_BYTES) % 256).toBe(0);
      expect(c).toBeGreaterThanOrEqual(Math.min(w * h, 1 << 20));
      expect(queuesBytes(c)).toBe((Q_CTL_WORDS + 3 * c) * 4);
    }
  });

  test('planWaves: waves never exceed a frame, at most MAX_WAVES_PER_SUBMIT', () => {
    expect(planWaves(1000, 1024, 518400)).toEqual([1000]);
    expect(planWaves(518400 * 2.5, 518400, 518400)).toEqual([518400, 518400, 259200]);
    expect(planWaves(10, 64, 6)).toEqual([6, 4]);       // capacity rounded above the pixel count
    expect(planWaves(1e12, 1000, 1000).length).toBe(MAX_WAVES_PER_SUBMIT);
    expect(planWaves(0, 64, 64)).toEqual([1]);
  });

  test('per-region cost model: waves fit the budget where the image is expensive', () => {
    const px = 2_073_600, cap = 262_144;
    const m = createCostModel();
    expect(planWavesByCost(m, 0, 34, cap, px, 518_400)).toEqual([262_144, 256_256]); // nothing known: first fraction
    // regions 0..15 cheap (20 ns/path), 16..31 expensive (100 ns/path)
    for (let r = 0; r < COST_REGIONS; r++) m.cost[r] = r < COST_REGIONS / 2 ? 2e-5 : 1e-4;
    for (const start of [0, px / 2 - 100_000, px / 2, px - 50_000]) {
      const w = planWavesByCost(m, start, 34, cap, px, 1);
      const ms = estimateMs(m, start, w.reduce((a, b) => a + b, 0), px);
      expect(ms).toBeLessThanOrEqual(34);
      expect(ms).toBeGreaterThan(34 * 0.9);
      expect(w.every((n) => n <= cap)).toBe(true);
    }
    // a measured submit twice as expensive as predicted doubles the touched regions only
    const before = Array.from(m.cost);
    updateCostModel(m, 0, [cap], 2 * estimateMs(m, 0, cap, px), px, 1);
    expect(m.cost[0]).toBeCloseTo(before[0] * 2, 12);
    expect(m.cost[COST_REGIONS - 1]).toBe(before[COST_REGIONS - 1]);
  });

  test('budget → paths', () => {
    expect(pathsForBudget(40, null, 1000, 0.25)).toBe(250);
    expect(pathsForBudget(40, 0.001, 1000, 0.25)).toBe(40000);
  });

  test('writeFrame byte layout', () => {
    const buf = new ArrayBuffer(FRAME_SLOT * 2);
    const f: FrameParams = {
      camPos: [1, 2, 3], camRight: [4, 5, 6], camUp: [7, 8, 9], camFwd: [0, 0, -1],
      waveStart: 123456, waveSize: 789, width: 960, height: 540,
      tube: { radius: 2.2, length: 276, z0: -138 }, tubeLe: [10, 11, 12],
      maxDepth: 6, rrDepth: 3, clampInd: 16, flags: 3, coneSpread: 0.002, maxDim: 65535, capacity: 518400,
      salt: 7, rayEps: 2e-5, diffuseSpread: 0.25, shadowEps: 1e-3, minAlpha: 0.002, tubeMode: 1, lightMode: 2,
      regK: 0.5, tilesX: 60, activeSlots: 2560, toneExp: 1.22, convEps: 0.02
    };
    writeFrame(buf, FRAME_SLOT, f);
    const v = new DataView(buf, FRAME_SLOT);
    const O = FRAME_OFFSETS;
    expect(v.getFloat32(O.camPos + 8, true)).toBe(3);
    expect(v.getUint32(O.waveStart, true)).toBe(123456);
    expect(v.getUint32(O.pixels, true)).toBe(960 * 540);
    expect(v.getFloat32(O.tubeR, true)).toBeCloseTo(2.2, 6);
    expect(v.getUint32(O.tubeOn, true)).toBe(1);
    expect(v.getUint32(O.capacity, true)).toBe(518400);
    expect(v.getFloat32(O.minAlpha, true)).toBeCloseTo(0.002, 9);
    expect(v.getUint32(O.tubeMode, true)).toBe(1);
    expect(v.getUint32(O.lightMode, true)).toBe(2);
    expect(v.getFloat32(O.tubeLum, true)).toBeCloseTo(0.2126 * 10 + 0.7152 * 11 + 0.0722 * 12, 4);
    expect(v.getFloat32(O.regK, true)).toBe(0.5);
    expect(v.getUint32(O.tilesX, true)).toBe(60);
    expect(v.getUint32(O.activeSlots, true)).toBe(2560);
    expect(v.getFloat32(O.toneExp, true)).toBeCloseTo(1.22, 6);
    expect(v.getFloat32(O.convEps, true)).toBeCloseTo(0.02, 7);
    expect(O.convEps + 4).toBe(FRAME_BYTES);
    expect(new Uint8Array(buf, 0, FRAME_SLOT).every((x) => x === 0)).toBe(true);
  });

  test('tube emitter + radiance in scene units (nits × exposure)', () => {
    expect(tubeFromEmitters([{ kind: 'meshEmission', role: 'x' }])).toBeNull();
    expect(tubeFromEmitters([{ kind: 'tube', radius: 2.2, length: 276, z0: -138, channel: 'tube', role: 'axis.sun' }]))
      .toEqual({ radius: 2.2, length: 276, z0: -138 });
    const s = lightingAt(0);
    const L = tubeRadiance(s);
    const k = s.phys.tubeNits * exposureFromEv100(s.phys.ev100);
    expect(Math.max(...L)).toBeCloseTo(k, 6); // tubeColor max component = 1
    expect(k).toBeGreaterThan(1);
    // same as U3's palette uniform 'tube' channel (channel 0), every phase
    for (const ph of [0, 0.5, 1, 2, 2.7]) {
      const st = lightingAt(ph), pu = paletteUniform(st), tl = tubeRadiance(st);
      for (let c = 0; c < 3; c++) expect(pu[FRAME_F.channels + c]).toBeCloseTo(tl[c], 3);
    }
  });
});

/* ─── CPU reference integrator ────────────────────────────────────────────── */

describe('integrator-ref (CPU oracle)', () => {
  const opt = { maxDepth: 64, rrDepth: 3 };

  test('intersection: walls, caps, tube from inside', () => {
    const sc: RefScene = { R: 10, H: 20, albedo: 0.5, Le: 0, tube: { radius: 1, length: 10, z0: -5, Le: 1 } };
    expect(refIntersect(sc, [5, 0, 0], [1, 0, 0])!.t).toBeCloseTo(5, 12);
    expect(refIntersect(sc, [5, 0, 0], [0, 0, 1])).toMatchObject({ what: 1 });
    expect(refIntersect(sc, [5, 0, 0], [0, 0, 1])!.t).toBeCloseTo(10, 12);
    expect(refIntersect(sc, [5, 0, 0], [-1, 0, 0])).toMatchObject({ what: 2 });
    expect(refIntersect(sc, [5, 0, 0], [-1, 0, 0])!.t).toBeCloseTo(4, 12);
  });

  test.each([[0.5, 1], [0.8, 0.25]])('furnace ρ=%f Le=%f → Le/(1−ρ)', (rho, Le) => {
    const sc: RefScene = { R: 5, H: 12, albedo: rho, Le };
    const e = refEstimate(sc, [1, 2, 0.5], 20000, 11, opt);
    const want = furnaceRadiance(Le, rho);
    expect(Math.abs(e.mean - want)).toBeLessThan(Math.max(4 * e.stderr, 1e-9));
    expect(e.mean / want).toBeGreaterThan(0.98);
    expect(e.mean / want).toBeLessThan(1.02);
  });

  test('tube NEE + MIS agrees with pure BSDF sampling', () => {
    const sc: RefScene = { R: 50, H: 300, albedo: 0.6, Le: 0, tube: { radius: 2.2, length: 276, z0: -138, Le: 20 } };
    const o: [number, number, number] = [10, -38, 20];
    const a = refEstimate(sc, o, 40000, 3, { maxDepth: 6, rrDepth: 3, nee: true });
    const b = refEstimate(sc, o, 40000, 5, { maxDepth: 6, rrDepth: 3, nee: false });
    const se = Math.hypot(a.stderr, b.stderr);
    expect(Math.abs(a.mean - b.mean)).toBeLessThan(4 * se);
    expect(a.stderr).toBeLessThan(b.stderr); // NEE reduces variance
    expect(a.mean).toBeGreaterThan(0);
  });

  test('equiangular tube NEE + MIS agrees with uniform-area NEE and has lower variance', () => {
    const sc: RefScene = { R: 50, H: 300, albedo: 0.6, Le: 0, tube: { radius: 2.2, length: 276, z0: -138, Le: 20 } };
    const o: [number, number, number] = [10, -38, 20];
    const a = refEstimate(sc, o, 40000, 3, { maxDepth: 6, rrDepth: 3, tubeSampler: 'equiangular' });
    const b = refEstimate(sc, o, 40000, 5, { maxDepth: 6, rrDepth: 3, tubeSampler: 'uniform' });
    const se = Math.hypot(a.stderr, b.stderr);
    console.log(`[integrator-ref] equiangular ${a.mean.toFixed(4)} ± ${a.stderr.toFixed(4)} vs uniform area ${b.mean.toFixed(4)} ± ${b.stderr.toFixed(4)}`);
    expect(Math.abs(a.mean - b.mean)).toBeLessThan(4 * se);
    expect(a.stderr).toBeLessThan(b.stderr);
  });
});
