/* PT-U3: CPU surface reference (surface-ref.ts) on the real scene: camera
   rays from TP view 0 through the f32 reference traversal, invariants of
   B5Surface, instance tint path, ray-cone LOD rule, texture sampling. */
import { beforeAll, describe, expect, test } from 'vitest';
import { buildScene, defaultParams } from '../../core/scene/build.ts';
import type { SceneDesc } from '../../core/scene/types.ts';
import type { PixelImage } from '../../core/raster/index.ts';
import { lightingAt } from '../../core/lighting/phases.ts';
import { INST_W, INST_WORDS, VIS_CAMERA, createTraverser, decodeRgb9e5 } from '../bvh/index.ts';
import { RAY_W, RAY_WORDS } from '../rays.ts';
import { prepareScene, type PreparedScene } from '../scene-upload.ts';
import { MAT_KIND, paletteUniform } from '../materials.ts';
import { loadTextureImages, packTexTable } from '../textures.ts';
import { createSurfaceRef, primaryRays, type RefSurface, type SurfaceRef } from '../surface-ref.ts';

let scene: SceneDesc;
let prep: PreparedScene;
let images: PixelImage[];
let ref: SurfaceRef;

beforeAll(async () => {
  scene = buildScene({ ...defaultParams('HIGH'), seed: 1337 });
  prep = await prepareScene(scene);
  const t0 = performance.now();
  images = await loadTextureImages(prep.texPlan, scene.images);
  console.log(`[pt-u3] texture generation (sync, Node): ${(performance.now() - t0).toFixed(0)} ms`);
  ref = createSurfaceRef({
    tris: prep.packed.tris, instances: prep.packed.instances, attrs: prep.attrs, materials: prep.materials,
    texTable: packTexTable(prep.texPlan), images, frame: paletteUniform(lightingAt(2), { detailRep: scene.hull.detailRep })
  });
}, 300_000);

const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: number[]) => Math.hypot(a[0], a[1], a[2]);

describe('surface-ref on TP view 0', () => {
  test('B5Surface invariants on a 96×54 camera grid', () => {
    const W = 96, H = 54;
    const v = scene.views[0];
    const cam = primaryRays(v.pos, v.look, W, H);
    const tr = createTraverser(prep.packed, { f32: true });
    const kinds = new Map<number, number>();
    let hits = 0, water = 0, lit = 0;
    for (let i = 0; i < W * H; i++) {
      const w = i * RAY_WORDS, R = cam.rays;
      const ray = { ox: R[w], oy: R[w + 1], oz: R[w + 2], dx: R[w + RAY_W.d], dy: R[w + RAY_W.d + 1], dz: R[w + RAY_W.d + 2], tmin: 0, tmax: 1e30 };
      const h = tr.closestHit(ray, VIS_CAMERA);
      if (!h) continue;
      hits++;
      const d = [ray.dx, ray.dy, ray.dz];
      const s: RefSurface = ref.surface({ t: h.t, u: h.u, v: h.v, inst: h.instance, tri: h.tri, flags: h.frontFace ? 1 : 0 },
        [ray.ox, ray.oy, ray.oz], d, cam.spread * h.t);
      kinds.set(s.kind, (kinds.get(s.kind) ?? 0) + 1);
      expect(dot(s.ng, d)).toBeLessThanOrEqual(1e-6);
      expect(len(s.ng)).toBeCloseTo(1, 5);
      expect(len(s.ns)).toBeCloseTo(1, 5);
      expect(dot(s.ns, s.ng)).toBeGreaterThan(0);
      for (const c of [...s.albedo, ...s.emission, s.rough, s.metal, s.water]) {
        expect(Number.isFinite(c)).toBe(true);
        expect(c).toBeGreaterThanOrEqual(0);
      }
      expect(Math.max(...s.albedo)).toBeLessThanOrEqual(1.5);
      expect(s.p[0]).toBeCloseTo(ray.ox + ray.dx * h.t, 4);
      expect(prep.materialIds[s.matId]).toBeTruthy();
      if (s.kind === MAT_KIND.hull) {
        expect(s.water).toBeLessThanOrEqual(1);
        if (s.water > 0.1) water++;
      }
      if (len(s.emission) > 0) lit++;
    }
    console.log(`[pt-u3] view 0 ${W}×${H}: ${hits} hits, kinds ${JSON.stringify([...kinds])}, water ${water}, emissive ${lit}`);
    expect(hits).toBeGreaterThan(W * H * 0.9);
    expect(kinds.get(MAT_KIND.hull) ?? 0).toBeGreaterThan(hits * 0.3);
    expect(lit).toBeGreaterThan(0); // night: city glow, windows, tube
  });

  test('instance tint: an untextured instanced material reports baseColor × instance colour', () => {
    const r = prep.roles.find((x) => x.role === 'cars.parked')!;
    const inst = r.first + 3;
    const tri = prep.packed.blasTriBase[r.blas] + 5;
    const s = ref.surface({ t: 1, u: 0.2, v: 0.3, inst, tri, flags: 1 }, [0, 0, 0], [0, 0, 1], 0.01);
    const tint = decodeRgb9e5(new Uint32Array(prep.packed.instances)[inst * INST_WORDS + INST_W.tint], [0, 0, 0]);
    const base = scene.materials['w.cars.parked'].baseColor;
    for (let k = 0; k < 3; k++) expect(s.albedo[k]).toBeCloseTo(Math.fround(base[k]) * tint[k], 6);
    expect(s.emission).toEqual([0, 0, 0]);
    expect(s.kind).toBe(MAT_KIND.standard);
    expect(s.metal).toBeCloseTo(0.35, 6);
  });

  test('ray-cone LOD: doubling the cone width adds one level', () => {
    const r = prep.roles.find((x) => x.role === 'hull')!;
    const tri = prep.packed.blasTriBase[r.blas] + 100;
    const a = ref.surface({ t: 1, u: 0.3, v: 0.3, inst: r.first, tri, flags: 1 }, [0, 0, 0], [0, 0, 1], 0.05);
    const b = ref.surface({ t: 1, u: 0.3, v: 0.3, inst: r.first, tri, flags: 1 }, [0, 0, 0], [0, 0, 1], 0.1);
    expect(b.lod - a.lod).toBeCloseTo(1, 9);
  });

  test('sampling: LOD beyond the chain gives the image mean; clamp vs repeat', () => {
    const idx = prep.texPlan.byImage.get('detail')!;
    const img = images[idx];
    let mean = 0;
    for (let i = 0; i < img.data.length; i += 4) mean += img.data[i];
    mean /= (img.data.length / 4) * 255;
    const s = ref.sample(idx, [0.37, 0.61], 40);
    expect(s[0]).toBeCloseTo(mean, 2);
    // level 0 at a texel centre returns that texel (v flip: v-up uv → row from the top)
    const S = img.width, x = 17, y = 40;
    const t = ref.sample(idx, [(x + 0.5) / S, 1 - (y + 0.5) / S], -100);
    expect(t[0] * 255).toBeCloseTo(img.data[(y * S + x) * 4], 6);
  });
});
