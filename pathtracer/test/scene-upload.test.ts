/* PT-U3: scene upload (CPU part), texture planning, generated WGSL layouts.
   GPU parts run in the browser smoke (tests/browser/pt-surface.spec.ts). */
import { beforeAll, describe, expect, test } from 'vitest';
import { WgslReflect } from 'wgsl_reflect/wgsl_reflect.module.js';
import { buildScene, defaultParams } from '../../core/scene/build.ts';
import type { SceneDesc } from '../../core/scene/types.ts';
import { mulberry32 } from '../../core/rng.ts';
import { INST_W, INST_WORDS, NO_LIGHT, TRI_W, TRI_WORDS, decodeRgb9e5 } from '../bvh/layout.ts';
import { buildKernelSource } from '../kernels.ts';
import {
  ATTR_BYTES, ATTR_OFFSETS, ATTR_W, ATTR_WORDS, SURFACE_BINDINGS, decodeOct, encodeOct, prepareScene, refreshDynamic,
  surfaceBindGroupLayoutEntries, surfaceGeneratedSources, tracedItems, type PreparedScene
} from '../scene-upload.ts';
import { FRAME_BYTES, FRAME_OFFSETS, MAT_BYTES, MAT_OFFSETS, readMaterial } from '../materials.ts';
import {
  LOC_CLAMP, LOC_SRGB, MAX_TEX, SIZE_CLASSES, TEXREF_BYTES, TEXREF_OFFSETS, arraySlot, mipChainCpu, packTexTable,
  planTextures, sizeClassOf, toClassSquare
} from '../textures.ts';
import { loadWgslSources } from './wgsl-fs.ts';

let scene: SceneDesc;
let prep: PreparedScene;

beforeAll(async () => {
  scene = buildScene({ ...defaultParams('HIGH'), seed: 1337 });
  prep = await prepareScene(scene);
  const s = prep.stats, t = prep.timings;
  console.log(`[pt-u3] HIGH seed 1337: ${s.geometries} BLAS, ${s.triangles} tris (${s.instancedTriangles} instanced), ` +
    `${s.instances} instances (${s.dynamicInstances} dyn), ${s.nodes} nodes, ${s.materials} materials, ${s.textures} textures, ` +
    `${s.emissiveTriangles} emissive tris; BVH ${t.bvhMs.toFixed(0)} ms, pack ${t.packMs.toFixed(0)} ms, attrs ${t.attrMs.toFixed(0)} ms`);
}, 120_000);

describe('traced items', () => {
  test('raster-only things are skipped, LOD level 0 only', () => {
    const roles = new Set(tracedItems(scene).map((i) => i.role));
    expect(roles.has('hull')).toBe(true);
    expect(roles.has('crowns.lod0')).toBe(true);
    expect(roles.has('crowns.lod1')).toBe(false);
    expect(roles.has('crowns.lod2')).toBe(false);
    expect(roles.has('blob')).toBe(false);
    expect(roles.has('print')).toBe(false);
    expect(roles.has('axis.sun')).toBe(true);
    for (const r of prep.roles) for (const m of r.materials) expect(['decal', 'sprite']).not.toContain(scene.materials[m].model);
  });

  test('role ranges cover every instance once; dynamic last', () => {
    const seen = new Uint8Array(prep.packed.instanceCount);
    for (const r of prep.roles) for (let i = r.first; i < r.first + r.count; i++) { expect(seen[i]).toBe(0); seen[i] = 1; }
    expect(seen.every((x) => x === 1)).toBe(true);
    const dyn = prep.roles.filter((r) => r.dynamic);
    expect(dyn.map((r) => r.role).sort()).toEqual(['lift.body', 'lift.glass', 'lift.lamp', 'traffic.body', 'traffic.lamp']);
    for (const r of dyn) expect(r.first).toBeGreaterThanOrEqual(prep.packed.staticInstanceCount);
  });

  test('static meshes keep their transform; instance material table = matBase + slot', () => {
    const IU = new Uint32Array(prep.packed.instances);
    for (const r of prep.roles) {
      const inst = r.first;
      const base = IU[inst * INST_WORDS + INST_W.matBase];
      expect(base).toBe(r.matBase);
      r.materials.forEach((id, slot) => {
        expect(prep.materialIds[readMaterial(prep.materials, base + slot).id]).toBe(id);
      });
    }
    // tower meshes are static with a transform: instance 0 of the role is not the identity inverse
    const tower = prep.roles.find((r) => r.role === 'tower.concrete')!;
    const IF = new Float32Array(prep.packed.instances);
    const w = tower.first * INST_WORDS;
    const t = scene.meshes.find((m) => m.role === 'tower.concrete')!.transform!;
    // worldToObject applied to the transform's translation gives the origin
    const p = [t[12], t[13], t[14]];
    for (let k = 0; k < 3; k++) {
      const row = IF.subarray(w + 4 * k, w + 4 * k + 4);
      expect(row[0] * p[0] + row[1] * p[1] + row[2] * p[2] + row[3]).toBeCloseTo(0, 3);
    }
  });
});

describe('attribute buffer', () => {
  test('oct encoding round trip', () => {
    const rnd = mulberry32(5);
    let worst = 0;
    for (let i = 0; i < 20000; i++) {
      let x = rnd() * 2 - 1, y = rnd() * 2 - 1, z = rnd() * 2 - 1;
      const l = Math.hypot(x, y, z); if (l < 1e-3) continue;
      x /= l; y /= l; z /= l;
      const d = decodeOct(encodeOct(x, y, z));
      worst = Math.max(worst, Math.acos(Math.min(1, d[0] * x + d[1] * y + d[2] * z)));
    }
    expect(worst).toBeLessThan(1e-4);
    for (const v of [[0, 0, 1], [0, 0, -1], [1, 0, 0], [0, -1, 0]]) {
      const d = decodeOct(encodeOct(v[0], v[1], v[2]));
      expect(d[0] * v[0] + d[1] * v[1] + d[2] * v[2]).toBeGreaterThan(1 - 1e-8);
    }
  });

  test('record order matches the triangle records (through the BLAS permutation)', () => {
    const TU = new Uint32Array(prep.packed.tris), TF = new Float32Array(prep.packed.tris);
    const AU = new Uint32Array(prep.attrs), AF = new Float32Array(prep.attrs);
    expect(prep.attrs.byteLength).toBe(prep.packed.triCount * ATTR_BYTES);
    const rnd = mulberry32(1337);
    let maxN = 0, lights = 0;
    for (let k = 0; k < 4000; k++) {
      const rec = Math.floor(rnd() * prep.packed.triCount);
      const tw = rec * TRI_WORDS, aw = rec * ATTR_WORDS;
      const b = TU[tw + TRI_W.aux];
      const t = TU[tw + TRI_W.primId];
      const g = scene.geometries[prep.geometries[b]];
      const vi = g.index ? [g.index[t * 3], g.index[t * 3 + 1], g.index[t * 3 + 2]] : [t * 3, t * 3 + 1, t * 3 + 2];
      for (let c = 0; c < 3; c++) {
        const v = vi[c];
        // vertex form of the record = source position
        for (let a = 0; a < 3; a++) expect(TF[tw + 4 * c + a]).toBe(g.position[v * 3 + a]);
        const n = decodeOct(AU[aw + ATTR_W.n0 + c]);
        const sl = Math.hypot(g.normal[v * 3], g.normal[v * 3 + 1], g.normal[v * 3 + 2]);
        const dn = (n[0] * g.normal[v * 3] + n[1] * g.normal[v * 3 + 1] + n[2] * g.normal[v * 3 + 2]) / sl;
        maxN = Math.max(maxN, Math.acos(Math.min(1, dn)));
        expect(AF[aw + ATTR_W.uv0 + 2 * c]).toBe(g.uv[v * 2]);
        expect(AF[aw + ATTR_W.uv0 + 2 * c + 1]).toBe(g.uv[v * 2 + 1]);
        const cw = c === 0 ? ATTR_W.c0 : c === 1 ? ATTR_W.c1 : ATTR_W.c2;
        const col = decodeRgb9e5(AU[aw + cw], [0, 0, 0]);
        const want = g.color ? [g.color[v * 3], g.color[v * 3 + 1], g.color[v * 3 + 2]] : [1, 1, 1];
        const mx = Math.max(...want);
        for (let a = 0; a < 3; a++) expect(Math.abs(col[a] - want[a])).toBeLessThanOrEqual(mx * 2 ** -8 + 1e-9);
      }
      // lodConst from the source triangle
      const P = g.position, UV = g.uv;
      const e1 = [0, 1, 2].map((a) => P[vi[1] * 3 + a] - P[vi[0] * 3 + a]);
      const e2 = [0, 1, 2].map((a) => P[vi[2] * 3 + a] - P[vi[0] * 3 + a]);
      const area = 0.5 * Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]);
      const uvA = 0.5 * Math.abs((UV[vi[1] * 2] - UV[vi[0] * 2]) * (UV[vi[2] * 2 + 1] - UV[vi[0] * 2 + 1]) -
        (UV[vi[1] * 2 + 1] - UV[vi[0] * 2 + 1]) * (UV[vi[2] * 2] - UV[vi[0] * 2]));
      const want = area > 0 && uvA > 0 ? 0.5 * Math.log2(uvA / area) : 0;
      expect(AF[aw + ATTR_W.lodConst]).toBeCloseTo(want, 4);
      if (AU[aw + ATTR_W.light] !== NO_LIGHT) lights++;
    }
    expect(maxN).toBeLessThan(2e-4);
    expect(lights).toBeGreaterThan(0);
  });

  test('emissive triangles: local indices 0..n−1 per BLAS', () => {
    const AU = new Uint32Array(prep.attrs);
    for (let b = 0; b < prep.blas.length; b++) {
      const base = prep.packed.blasTriBase[b], n = prep.blas[b].triCount;
      const got: number[] = [];
      for (let i = 0; i < n; i++) { const l = AU[(base + i) * ATTR_WORDS + ATTR_W.light]; if (l !== NO_LIGHT) got.push(l); }
      expect(got).toEqual(Array.from({ length: prep.emissiveTris[b] }, (_, i) => i));
    }
    const geo = (role: string) => prep.roles.find((r) => r.role === role)!.blas;
    expect(prep.emissiveTris[geo('bld.0')]).toBeGreaterThan(0);   // window walls
    expect(prep.emissiveTris[geo('hull')]).toBe(0);
    expect(prep.emissiveTris[geo('axis.sun')]).toBe(0);           // analytic tube emitter
  });

  test('dynamic refresh rewrites traffic/lift instances in place', () => {
    const lifts = scene.meshes.find((m) => m.role === 'lift.body')!.instances!;
    const before = new Uint8Array(prep.packed.instances.slice(0));
    lifts.matrices[14] += 3; // move lift 0 along z (shared array: body, lamp, glass)
    const d = refreshDynamic(prep)!;
    expect(d).toBeTruthy();
    expect(d.instances[0]).toBe(prep.packed.staticInstanceCount * 64);
    const after = new Uint8Array(prep.packed.instances);
    expect(after.subarray(0, d.instances[0])).toEqual(before.subarray(0, d.instances[0]));
    expect(after.subarray(d.instances[0])).not.toEqual(before.subarray(d.instances[0]));
    lifts.matrices[14] -= 3;
    refreshDynamic(prep);
  });
});

describe('textures', () => {
  test('size classes', () => {
    expect(sizeClassOf(32, 32)).toBe(0);
    expect(sizeClassOf(256, 256)).toBe(0);
    expect(sizeClassOf(257, 10)).toBe(1);
    expect(sizeClassOf(64, 8)).toBe(0);
    expect(sizeClassOf(1024, 1024)).toBe(2);
    expect(sizeClassOf(2048, 1024)).toBe(3);
    expect(sizeClassOf(4096, 4096)).toBe(3);
    expect(arraySlot(true, 0)).toBe(0);
    expect(arraySlot(false, 3)).toBe(7);
  });

  test('scene plan: classes, formats, wrap, layers, table', () => {
    const plan = prep.texPlan;
    const ref = (id: string) => plan.refs[plan.byImage.get(id)!];
    expect(ref('hull.albedo')).toMatchObject({ cls: 3, srgb: true, clamp: false, layer: 0 });
    expect(ref('hull.mask')).toMatchObject({ cls: 2, srgb: false });
    expect(ref('detail')).toMatchObject({ cls: 0, srgb: false });
    expect(ref('cars.windows')).toMatchObject({ cls: 0, srgb: true, clamp: true });
    expect(ref('endcap')).toMatchObject({ cls: 2, srgb: true, clamp: true });
    expect(plan.byImage.has('decal.blob')).toBe(false);
    expect(plan.byImage.has('sprite.nav')).toBe(false);
    expect(plan.byImage.has('leaf')).toBe(false);       // only crowns.lod2 uses it
    expect(plan.byImage.has('leaf.normal')).toBe(true); // crowns.lod0 normal map
    // layers are dense per array
    for (let slot = 0; slot < 8; slot++) {
      const ls = plan.refs.filter((r) => arraySlot(r.srgb, r.cls) === slot).map((r) => r.layer).sort((a, b) => a - b);
      expect(ls).toEqual(ls.map((_, i) => i));
      expect(plan.layers[slot]).toBe(ls.length);
    }
    const tab = packTexTable(plan);
    const U = new Uint32Array(tab), F = new Float32Array(tab);
    const w = (ref('cars.windows').index * TEXREF_BYTES) / 4;
    expect(U[w] & LOC_CLAMP).toBeTruthy();
    expect(U[w] & LOC_SRGB).toBeTruthy();
    expect(F[w + 1]).toBe(8); // log2 256
    expect([...F.subarray(w + 4, w + 8)]).toEqual([1, -1, 0, 1]);
    console.log(`[pt-u3] texture plan: ${plan.refs.length} textures, ${(plan.bytes / 1048576).toFixed(1)} MiB, layers ${plan.layers.join('/')}`);
  });

  test('class squares and the CPU mip chain', () => {
    const img = { width: 32, height: 32, data: new Uint8ClampedArray(32 * 32 * 4).map((_, i) => (i * 7) & 255) };
    const sq = toClassSquare(img, SIZE_CLASSES[0]);
    expect(sq.width).toBe(256);
    expect(sq.data[0]).toBe(img.data[0]);                       // nearest up-scale keeps texels
    expect(sq.data[(7 * 256 + 7) * 4 + 1]).toBe(img.data[1]);
    const two = { width: 2, height: 2, data: new Uint8ClampedArray([0, 0, 0, 0, 255, 255, 255, 255, 0, 0, 0, 0, 255, 255, 255, 255]) };
    const lin = mipChainCpu(two, false), srgb = mipChainCpu(two, true);
    expect(lin.length).toBe(2);
    expect([...lin[1].data]).toEqual([128, 128, 128, 128]);
    expect([...srgb[1].data]).toEqual([188, 188, 188, 128]); // linear 0.5 → sRGB 0.735
    expect(MAX_TEX * TEXREF_BYTES).toBe(8192);
  });
});

describe('generated WGSL', () => {
  const sources = { ...loadWgslSources(), ...surfaceGeneratedSources() };
  const layouts: [string, number, Record<string, number>][] = [
    ['B5Material', MAT_BYTES, MAT_OFFSETS],
    ['B5TriAttr', ATTR_BYTES, ATTR_OFFSETS],
    ['B5TexRef', TEXREF_BYTES, TEXREF_OFFSETS]
  ];

  test.each(['surface.wgsl', 'pt-surface.wgsl'])('%s parses; layouts match the TS tables', (file) => {
    const src = buildKernelSource(file, sources);
    const r = new WgslReflect(src.code);
    for (const [name, size, offsets] of layouts) {
      const s = r.getStructInfo(name);
      expect(s, name).toBeTruthy();
      expect(s!.size, name).toBe(size);
      expect(Object.fromEntries(s!.members.map((m) => [m.name, m.offset])), name).toEqual(offsets);
    }
    const fr = r.getStructInfo('B5SurfaceFrame')!;
    expect(fr.size).toBe(FRAME_BYTES);
    const fo = Object.fromEntries(fr.members.map((m) => [m.name, m.offset]));
    for (const [k, v] of Object.entries(FRAME_OFFSETS)) expect(fo[k], k).toBe(v);
    // B5Surface as in DECISIONS.md (M1 interface) + the PT-W4a water-BSDF fields appended
    const surf = r.getStructInfo('B5Surface')!;
    expect(surf.members.map((m) => `${m.name}@${m.offset}`)).toEqual([
      'p@0', 'kind@12', 'ng@16', 'matId@28', 'ns@32', 'rough@44', 'albedo@48', 'metal@60', 'emission@64', 'water@76',
      'tint@80', 'ior@92', 'slope@96', 'coneW@104', 'frontFace@108', 'bed@112', 'foam@124', 'wtint@128', 'rough0@140'
    ]);
    expect(src.code.includes('$')).toBe(false);
    for (const m of src.code.matchAll(/^(?:const|override|fn|struct|var(?:<[^>]*>)?)\s+(\w+)/gm)) expect(m[1]).toMatch(/^(B5|b5_)/);
    expect(src.code).toContain('fn b5_hull_surface(');
    expect(src.code).not.toMatch(/sparShade \*/); // raster-only truss shadow not emitted
  });

  test('group 2 bindings match surfaceBindGroupLayoutEntries', () => {
    const r = new WgslReflect(buildKernelSource('pt-surface.wgsl', sources).code);
    const at = (b: number) => r.findResource(2, b, 'b5_k_surface_dbg');
    expect(at(SURFACE_BINDINGS.attrs)?.name).toBe('b5_attrs');
    expect(at(SURFACE_BINDINGS.mats)?.name).toBe('b5_mats');
    expect(at(SURFACE_BINDINGS.texrefs)?.name).toBe('b5_texrefs');
    expect(at(SURFACE_BINDINGS.frame)?.name).toBe('b5_frame');
    expect(surfaceBindGroupLayoutEntries.map((e) => e.binding)).toEqual(Array.from({ length: 14 }, (_, i) => i));
    for (let i = 0; i < 8; i++) expect(at(SURFACE_BINDINGS.textures + i), `texture binding ${i}`).toBeTruthy();
    // the uniform table/frame fit the default maxUniformBufferBindingSize (64 KiB)
    expect(MAX_TEX * TEXREF_BYTES + FRAME_BYTES).toBeLessThan(65536);
  });

  test('mipgen.wgsl parses', () => {
    const r = new WgslReflect(sources['mipgen.wgsl']);
    expect(r.entry.compute.map((f) => f.name)).toEqual(['b5_k_mipgen']);
  });
});

describe('planTextures', () => {
  test('rejects unknown images and keeps first-use order', () => {
    expect(() => planTextures(scene.images, ['nope'])).toThrow(/nope/);
    const p = planTextures(scene.images, ['detail', 'hull.albedo', 'detail']);
    expect(p.refs.map((r) => r.image)).toEqual(['detail', 'hull.albedo']);
  });
});
