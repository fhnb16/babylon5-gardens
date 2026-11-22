/* ═══════════════════════════════════════════════════════════════════════════
   Adapter golden gate: buildScene() → createThreeWorld() (stub renderer, no
   texture generation) must reproduce the legacy three objects captured by
   tools/snapshot-lib.mjs in test/golden, for all 9 cases.

   Per object of the legacy worldGroup: name (incl. `.s<bucket>`), type,
   visible, renderOrder, frustumCulled, count/capacity, transform in station
   space, material summary (tools/snapshot-lib.mjs matSummary), bounding
   sphere, instanceMatrix / instanceColor, and geometry (attributes, index,
   groups, drawRange, triangle set) at its first user. Full cases compare
   arrays with |Δ| ≤ 1e-5, big cases (ULTRAM/ULTRA) the 1e-4 quantized hash
   — the snapshot-lib rules.

   Documented, intentional differences (asserted, not ignored):
   · hull: emitted front-facing for viewing from inside (B2a, core/scene/
     world-shapes.ts hullGeo): material side BackSide → FrontSide and
     normalScale (1,1) → (−1,−1) (three negates the normalScale uniform of
     BackSide materials; since v2.12.0 the core hull MaterialDesc carries the
     as-rendered (−1,−1) itself and the adapter applies it as is); normals
     negated, u ↦ 0.5 − u, winding reversed. The comparison undoes exactly
     that; the index is compared as a triangle SET (both sides run the
     three-mesh-bvh rebuild, which reorders triangles).
   · 'tower' Group: the core bakes its matrix into tower.* transforms, so
     there is no Group; tower.* are compared by their station-space matrix
     (legacy group × child) with |Δ| ≤ TOL_BAKED (float32 bake + decompose).
   · opacity of ParamRef-driven blends (blob, print): legacy constructors
     said 0.85 and applyPalette(0) overwrote it at boot before any frame;
     the adapter starts from the ParamRef at DAY. Asserted equal to that.
   · normalScale of materials WITHOUT a normal map (LOW): inert; the core
     only emits it alongside the map. Dropped from both summaries then.
   · geometry attribute declaration order: compared as a set (endcap.disc
     legacy order position, uv, normal; GeometryDesc has fixed fields).
   · scene order: the full object order (names incl. sector suffixes) must
     equal legacy's, minus the missing 'tower' Group.
   ═══════════════════════════════════════════════════════════════════════════ */

import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { CASES, readGolden } from '../../../tools/snapshot-lib.mjs';
import { buildScene } from '../../../core/scene/build.ts';
import { CORE_CONFIG } from '../../../core/config/index.ts';
import type { MaterialDesc, SceneDesc, WorldParams } from '../../../core/scene/types.ts';
import { createThreeWorld, type ThreeWorld } from '../adapt/sceneGraph.ts';
import { dayState, evalRef } from '../materials/legacy.ts';
import { lightingAt } from '../../../core/lighting/phases.ts';
import { mulberry32 as legacyMulberry } from '../../../test/legacy-oracle/util.js';

const TOL = 1e-5, QUANT = 1e-4, TOL_BAKED = 1e-4;

/* ─── golden format ─── */
interface Ref { type: string; len: number; exact: string; quant: string; off?: number }
interface GObj {
  name: string; role: string; type: string; parent: string | null; visible: boolean; renderOrder: number;
  frustumCulled: boolean; position: number[]; quaternion: number[]; scale: number[];
  geo?: string; material?: unknown; count?: number; capacity?: number;
  instanceMatrix?: Ref | null; instanceColor?: Ref | null; boundingSphere?: number[];
}
interface GGeo {
  id: string; firstUser: string; attrOrder: string[];
  attributes: Record<string, { itemSize: number; count: number; normalized: boolean; data: Ref }>;
  vertexCount: number; index: Ref | null; indexCount: number; triSet?: string; groups: number[][]; drawRange: number[];
}
interface Gold { id: string; seed: number; quality: WorldParams['quality']; season: WorldParams['season']; full: boolean;
  objects: GObj[]; geometries: GGeo[]; __data?: Buffer }
interface Case { id: string; seed: number; quality: WorldParams['quality']; season: WorldParams['season']; full: boolean }

type Arr = Float32Array | Float64Array | Uint32Array | Uint16Array | Uint8Array | Int32Array | Int16Array | Int8Array;
const TYPES: Record<string, { new(b: ArrayBuffer): Arr; BYTES_PER_ELEMENT: number; from(a: ArrayLike<number>): Arr }> = {
  f32: Float32Array, f64: Float64Array, u32: Uint32Array, u16: Uint16Array, u8: Uint8Array,
  i32: Int32Array, i16: Int16Array, i8: Int8Array
};
const isFloat = (a: Arr): boolean => a instanceof Float32Array || a instanceof Float64Array;

function fnvBytes(u8: Uint8Array, h = 0x811c9dc5): number {
  for (let k = 0; k < u8.length; k++) { h ^= u8[k]; h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
const hex = (h: number): string => h.toString(16).padStart(8, '0');
const bytesOf = (a: Arr): Uint8Array => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
function quantHash(a: Arr): string {
  if (!isFloat(a)) return hex(fnvBytes(bytesOf(a)));
  const q = new Int32Array(a.length);
  for (let k = 0; k < a.length; k++) {
    const v = Math.round(a[k] / QUANT);
    q[k] = Number.isFinite(v) ? v : 0x7fffffff;
  }
  return hex(fnvBytes(new Uint8Array(q.buffer)));
}
function triSetHash(index: ArrayLike<number>): string {
  const n = (index.length / 3) | 0;
  const tri = new Uint32Array(n * 3);
  for (let k = 0; k < n; k++) {
    let a = index[k * 3], b = index[k * 3 + 1], c = index[k * 3 + 2];
    if (b < a && b <= c) [a, b, c] = [b, c, a];
    else if (c < a && c < b) [a, b, c] = [c, a, b];
    tri[k * 3] = a; tri[k * 3 + 1] = b; tri[k * 3 + 2] = c;
  }
  const order = new Uint32Array(n);
  for (let k = 0; k < n; k++) order[k] = k;
  order.sort((x, y) => (tri[x * 3] - tri[y * 3]) || (tri[x * 3 + 1] - tri[y * 3 + 1]) || (tri[x * 3 + 2] - tri[y * 3 + 2]));
  const out = new Uint32Array(n * 3);
  for (let k = 0; k < n; k++) {
    const s = order[k] * 3;
    out[k * 3] = tri[s]; out[k * 3 + 1] = tri[s + 1]; out[k * 3 + 2] = tri[s + 2];
  }
  return hex(fnvBytes(new Uint8Array(out.buffer)));
}
function load(g: Gold, r: Ref): Arr {
  const C = TYPES[r.type];
  const buf = g.__data as Buffer;
  const start = buf.byteOffset + (r.off as number);
  return new C(buf.buffer.slice(start, start + r.len * C.BYTES_PER_ELEMENT) as ArrayBuffer);
}

/* ─── material summary (copy of tools/snapshot-lib.mjs matSummary) ─── */
const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;
const MAPS = ['map', 'normalMap', 'emissiveMap', 'alphaMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'bumpMap'];
function matSummary(m: THREE.Material): Record<string, unknown> {
  const a = m as unknown as Record<string, unknown>;
  const s: Record<string, unknown> = { type: m.type };
  if (a.color) s.color = '#' + (a.color as THREE.Color).getHexString();
  if (a.emissive) s.emissive = '#' + (a.emissive as THREE.Color).getHexString();
  for (const k of ['roughness', 'metalness', 'emissiveIntensity', 'opacity', 'alphaTest', 'size']) {
    if (typeof a[k] === 'number') s[k] = r6(a[k] as number);
  }
  for (const k of ['transparent', 'vertexColors', 'flatShading', 'depthWrite', 'toneMapped', 'fog']) {
    if (typeof a[k] === 'boolean') s[k] = a[k];
  }
  s.side = m.side;
  s.blending = m.blending;
  s.maps = MAPS.filter(k => a[k]);
  if (a.normalScale) s.normalScale = [r6((a.normalScale as THREE.Vector2).x), r6((a.normalScale as THREE.Vector2).y)];
  return s;
}

/* ─── comparison ─── */
interface RoleStat { objects: number; instances: number; maxDev: number }

const stub = { capabilities: { getMaxAnisotropy: () => 8 } };
const roleOf = (n: string): string => n.replace(/\.s\d+$/, '');

function paramsOf(c: Case): WorldParams {
  return { seed: c.seed >>> 0, quality: c.quality, season: c.season,
    saturation: CORE_CONFIG.SATURATION_DEFAULT, greenK: CORE_CONFIG.GREEN_K_DEFAULT };
}

function compareWorld(gold: Gold, scene: SceneDesc, world: ThreeWorld): { problems: string[]; roles: Record<string, RoleStat> } {
  const problems: string[] = [];
  const roles: Record<string, RoleStat> = {};
  const stat = (role: string): RoleStat => (roles[role] ??= { objects: 0, instances: 0, maxDev: 0 });
  const bad = (what: string, msg: string): void => { problems.push(`${gold.id} ${what}: ${msg}`); };

  const cmp = (name: string, what: string, gr: Ref | null | undefined, cur: Arr | null | undefined): void => {
    const st = stat(roleOf(name));
    if (!gr || !cur) { if (gr || cur) bad(name, `${what}: only on one side`); return; }
    if (gr.len !== cur.length) { bad(name, `${what}: length ${gr.len} → ${cur.length}`); return; }
    if (gold.full) {
      const ga = load(gold, gr);
      if (isFloat(ga)) {
        let d = 0;
        for (let k = 0; k < ga.length; k++) {
          const x = Math.abs(ga[k] - cur[k]);
          if (!(x <= d)) d = Number.isNaN(x) ? Infinity : x;
        }
        st.maxDev = Math.max(st.maxDev, d);
        if (!(d <= TOL)) bad(name, `${what}: deviation ${d.toExponential(2)} > ${TOL}`);
      } else {
        let n = 0;
        for (let k = 0; k < ga.length; k++) if (ga[k] !== cur[k]) n++;
        if (n) { st.maxDev = Infinity; bad(name, `${what}: ${n} integers differ`); }
      }
    } else {
      const C = TYPES[gr.type];
      const typed = cur instanceof (C as unknown as typeof Float32Array) ? cur : C.from(cur);
      if (quantHash(typed) !== gr.quant) { stat(roleOf(name)).maxDev = Infinity; bad(name, `${what}: quantized hash differs`); }
    }
  };
  const vecDev = (name: string, what: string, g: number[], c: number[], tol: number): void => {
    let d = 0;
    if (g.length !== c.length) d = Infinity;
    else for (let k = 0; k < g.length; k++) d = Math.max(d, Math.abs(g[k] - c[k]));
    stat(roleOf(name)).maxDev = Math.max(stat(roleOf(name)).maxDev, d);
    if (!(d <= tol)) bad(name, `${what}: deviation ${d}`);
  };

  /* my objects: station group children in order */
  const mine: THREE.Object3D[] = [];
  world.stationGroup.traverse(o => { if (o !== world.stationGroup) mine.push(o); });
  const byName = new Map<string, THREE.Object3D>();
  for (const o of mine) {
    if (byName.has(o.name)) bad(o.name, 'duplicate name');
    byName.set(o.name, o);
  }
  const goldObjs = gold.objects.filter(o => o.type !== 'Group');
  const gNames = goldObjs.map(o => o.name);
  const cNames = mine.map(o => o.name);
  if (JSON.stringify(gNames) !== JSON.stringify(cNames)) {
    const miss = gNames.filter(n => !byName.has(n)), extra = cNames.filter(n => !gNames.includes(n));
    bad('objects', `order/composition differs; missing [${miss.join(', ')}] extra [${extra.join(', ')}]`);
  }

  /* materials whose opacity follows a ParamRef */
  const refOpacity = new Map<THREE.Material, number>();
  for (const [id, m] of world.materials) {
    const d: MaterialDesc = scene.materials[id];
    if (typeof d.alpha === 'object' && 'blend' in d.alpha && typeof d.alpha.blend === 'object') {
      refOpacity.set(m, r6(evalRef(d.alpha.blend, dayState())));
    }
  }

  const groups = new Map(gold.objects.filter(o => o.type === 'Group').map(o => [o.name, o]));
  const localMatrix = (o: GObj): THREE.Matrix4 => new THREE.Matrix4().compose(
    new THREE.Vector3().fromArray(o.position), new THREE.Quaternion().fromArray(o.quaternion), new THREE.Vector3().fromArray(o.scale));
  const gGeo = new Map(gold.geometries.map(g => [g.id, g]));

  for (const go of goldObjs) {
    const co = byName.get(go.name);
    if (!co) continue;
    const name = go.name, st = stat(roleOf(name));
    st.objects++;
    const im = co as THREE.InstancedMesh;
    st.instances += im.isInstancedMesh ? im.count : 0;

    if (go.type !== co.type) bad(name, `type ${go.type} → ${co.type}`);
    if (go.visible !== co.visible) bad(name, `visible ${go.visible} → ${co.visible}`);
    if (go.renderOrder !== co.renderOrder) bad(name, `renderOrder ${go.renderOrder} → ${co.renderOrder}`);
    if (go.frustumCulled !== co.frustumCulled) bad(name, `frustumCulled ${go.frustumCulled} → ${co.frustumCulled}`);
    if (im.isInstancedMesh) {
      if (go.count !== im.count) bad(name, `count ${go.count} → ${im.count}`);
      if (go.capacity !== im.instanceMatrix.count) bad(name, `capacity ${go.capacity} → ${im.instanceMatrix.count}`);
    }

    /* station-space transform */
    const gm = localMatrix(go);
    if (go.parent) {
      const p = groups.get(go.parent);
      if (!p) bad(name, `unknown legacy parent ${go.parent}`);
      else gm.premultiply(localMatrix(p));
    }
    co.updateMatrix();
    vecDev(name, 'station matrix', gm.toArray(), co.matrix.toArray(), go.parent ? TOL_BAKED : TOL);

    /* material summary */
    const mats = (co as THREE.Mesh).material;
    if (go.material !== undefined) {
      const list = Array.isArray(mats) ? mats : [mats];
      const gl = (Array.isArray(go.material) ? go.material : [go.material]) as Record<string, unknown>[];
      if (gl.length !== list.length) bad(name, `material count ${gl.length} → ${list.length}`);
      gl.forEach((gs, i) => {
        const cs = matSummary(list[i]);
        const want = { ...gs };
        if (roleOf(name) === 'hull' && want.side === THREE.BackSide) {
          /* documented: FrontSide instead of BackSide, and the normalScale
             three applied to the BackSide uniform (negated) moved into the
             material, so the shader sees the same value */
          want.side = THREE.FrontSide;
          if (Array.isArray(want.normalScale)) want.normalScale = (want.normalScale as number[]).map(v => -v);
        }
        /* normalScale without a normal map is inert; the core omits it then
           (LOW: legacy passed 0.8 / 1.1 to materials whose normalMap was null) */
        if (!(want.maps as string[]).includes('normalMap') && !(cs.maps as string[]).includes('normalMap')) {
          delete want.normalScale; delete cs.normalScale;
        }
        if (refOpacity.has(list[i])) {
          if (cs.opacity !== refOpacity.get(list[i])) bad(name, `ParamRef opacity ${cs.opacity} ≠ DAY ${refOpacity.get(list[i])}`);
          want.opacity = cs.opacity;                                                                // documented
        }
        if (JSON.stringify(want) !== JSON.stringify(cs)) bad(name, `material[${i}] ${JSON.stringify(want)} → ${JSON.stringify(cs)}`);
      });
    }

    if (go.boundingSphere || (im.isInstancedMesh && im.boundingSphere)) {
      const cs = im.boundingSphere ? [...im.boundingSphere.center.toArray(), im.boundingSphere.radius] : [];
      vecDev(name, 'boundingSphere', go.boundingSphere || [], cs, TOL);
    }
    if (im.isInstancedMesh) {
      cmp(name, 'instanceMatrix', go.instanceMatrix, im.instanceMatrix.array as Float32Array);
      cmp(name, 'instanceColor', go.instanceColor ?? null, im.instanceColor ? im.instanceColor.array as Float32Array : null);
    }

    /* geometry at its first user */
    const geo = (co as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    if (!!go.geo !== !!geo) { bad(name, 'geometry on one side only'); continue; }
    if (!go.geo || !geo) continue;
    const gg = gGeo.get(go.geo) as GGeo;
    if (gg.firstUser !== name) continue;
    const hull = roleOf(name) === 'hull';
    /* attribute SET (GeometryDesc has fixed fields, so the declaration order
       is always position, normal, uv, color; legacy LatheGeometry declared uv
       before normal — irrelevant to rendering) */
    const attrOrder = Object.keys(geo.attributes);
    if (JSON.stringify([...gg.attrOrder].sort()) !== JSON.stringify([...attrOrder].sort())) bad(name, `attributes ${gg.attrOrder} → ${attrOrder}`);
    const vc = geo.attributes.position.count;
    if (gg.vertexCount !== vc) bad(name, `vertexCount ${gg.vertexCount} → ${vc}`);
    const ic = geo.index ? geo.index.count : 0;
    if (gg.indexCount !== ic) bad(name, `indexCount ${gg.indexCount} → ${ic}`);
    const grp = geo.groups.map(x => [x.start, x.count, x.materialIndex ?? 0]);
    if (JSON.stringify(gg.groups) !== JSON.stringify(grp)) bad(name, `groups ${JSON.stringify(gg.groups)} → ${JSON.stringify(grp)}`);
    const dr = [geo.drawRange.start, Number.isFinite(geo.drawRange.count) ? geo.drawRange.count : -1];
    if (JSON.stringify(gg.drawRange) !== JSON.stringify(dr)) bad(name, `drawRange ${gg.drawRange} → ${dr}`);
    for (const n of gg.attrOrder) {
      const at = geo.attributes[n] as THREE.BufferAttribute | undefined;
      if (!at) continue;
      const ga = gg.attributes[n];
      if (ga.itemSize !== at.itemSize || ga.normalized !== at.normalized) bad(name, `${n}: attribute format`);
      let arr = at.array as Arr;
      if (hull && n === 'normal') arr = (arr as Float32Array).map(v => -v);
      if (hull && n === 'uv') arr = (arr as Float32Array).map((v, i) => (i % 2 ? v : 0.5 - v));
      cmp(name, n, ga.data, arr);
    }
    if (geo.index) {
      const idx = geo.index.array as Uint16Array | Uint32Array;
      if (hull) {
        /* both sides went through the BVH rebuild: compare the triangle set
           after reversing the winding back to the legacy (outside) one */
        const back = new Uint32Array(idx.length);
        for (let i = 0; i < idx.length; i += 3) { back[i] = idx[i]; back[i + 1] = idx[i + 2]; back[i + 2] = idx[i + 1]; }
        if (gg.triSet !== triSetHash(back)) bad(name, 'triangle set differs');
      } else {
        if (gg.triSet && gg.triSet !== triSetHash(idx)) bad(name, 'triangle set differs');
        cmp(name, 'index', gg.index, idx);
      }
    } else if (gg.index) bad(name, 'index on one side only');
  }
  return { problems, roles };
}

/* ─── cases ─── */
describe('backends/three adapter vs legacy objects (test/golden)', () => {
  for (const c of CASES as Case[]) {
    test(c.id, () => {
      const gold = readGolden(c.id) as Gold | null;
      expect(gold, `golden ${c.id}`).not.toBeNull();
      const scene = buildScene(paramsOf(c));
      const world = createThreeWorld(scene, stub, { textures: 'none' });
      const r = compareWorld(gold as Gold, scene, world);
      if (process.env.B5_GOLDEN_REPORT) {
        const lines = Object.entries(r.roles).map(([k, s]) =>
          `${k.padEnd(14)} obj ${String(s.objects).padStart(4)} inst ${String(s.instances).padStart(6)} maxDev ${s.maxDev === Infinity ? 'hash≠' : s.maxDev.toExponential(1)}`);
        console.log(`${c.id}\n  ` + lines.join('\n  '));
      }
      world.dispose();
      expect(r.problems.slice(0, 40)).toEqual([]);
    }, 180000);
  }

  test('comparator detects perturbations', () => {
    const c = (CASES as Case[]).find(x => x.quality === 'LOW' && x.full) as Case;
    const gold = readGolden(c.id) as Gold;
    const scene = buildScene(paramsOf(c));
    const world = createThreeWorld(scene, stub, { textures: 'none' });
    const bush = world.objects.get('bushes')?.[0] as THREE.InstancedMesh;
    (bush.instanceMatrix.array as Float32Array)[13] += 1e-3;
    const blob = world.objects.get('blob')?.[0] as THREE.InstancedMesh;
    blob.name = 'blob.s99';
    world.materials.get('w.trunks')!.side = THREE.DoubleSide;
    const r = compareWorld(gold, scene, world);
    expect(r.problems.some(p => p.includes('bushes') && p.includes('instanceMatrix'))).toBe(true);
    expect(r.problems.some(p => p.includes('blob.s99'))).toBe(true);
    expect(r.problems.some(p => p.includes('trunks') && p.includes('material'))).toBe(true);
    world.dispose();
  });

  test('ambient (core/scene/ambient.ts) = the legacy app/lights.ts buildAmbient recipe', () => {
    for (const quality of ['LOW', 'HIGH'] as const) {
      const scene = buildScene({ ...paramsOf((CASES as Case[])[0]), quality });
      const world = createThreeWorld(scene, stub, { textures: 'none', collider: false });
      /* legacy recipe, verbatim: rng mulberry32(SEED ^ 0x5f5), 14 clouds, 400 motes */
      const rnd = legacyMulberry(scene.params.seed ^ 0x5f5);
      const ring = (n: number, r0: number, dr: number, z0: number, dz: number): number[] => {
        const p: number[] = [];
        for (let i = 0; i < n; i++) {
          const t = rnd() * Math.PI * 2, r = r0 + rnd() * dr;
          p.push(Math.sin(t) * r, Math.cos(t) * r, z0 + rnd() * dz);
        }
        return p;
      };
      const cp = ring(14, 10, 13, -140, 280), mp = ring(400, 4, 44, -150, 300);
      const names = world.sceneGroup.children.map(o => o.name);
      expect(names.slice(names.indexOf('glow'))).toEqual(quality === 'LOW' ? ['glow', 'motes'] : ['glow', 'clouds', 'motes']);
      const pts = (role: string): number[] =>
        [...((world.objects.get(role)?.[0] as THREE.Points).geometry.attributes.position.array as Float32Array)];
      if (quality !== 'LOW') expect(pts('clouds')).toEqual([...new Float32Array(cp)]);
      expect(pts('motes')).toEqual([...new Float32Array(mp)]);
      const glow = world.objects.get('glow')?.[0] as THREE.Mesh;
      const ref = new THREE.PlaneGeometry(12, CORE_CONFIG.SUN.len);
      ref.rotateX(Math.PI / 2);
      const gp = glow.geometry.attributes.position.array as Float32Array;
      const rp = ref.attributes.position.array as Float32Array;
      expect(gp.length).toBe(rp.length);
      for (let i = 0; i < gp.length; i++) expect(Math.abs(gp[i] - rp[i])).toBeLessThan(1e-5);
      const gm = glow.material as THREE.MeshBasicMaterial;
      expect([gm.blending, gm.side, gm.depthWrite, gm.toneMapped, gm.transparent])
        .toEqual([THREE.AdditiveBlending, THREE.DoubleSide, false, false, true]);
      /* the palette drives their colour and opacity */
      const night = lightingAt(2);
      world.applyLighting(night);
      expect(gm.opacity).toBeCloseTo(night.glowOpacity, 9);
      expect(gm.color.r).toBeCloseTo(night.sunColor[0], 9);
      const motes = (world.objects.get('motes')?.[0] as THREE.Points).material as THREE.PointsMaterial;
      expect(motes.size).toBeCloseTo(night.moteSize, 9);
      expect(motes.color.g).toBeCloseTo(night.moteColor[1], 9);
      world.dispose();
    }
  });

  test('dynamics / LOD / lighting drive the objects', () => {
    const scene = buildScene({ ...paramsOf((CASES as Case[])[0]), quality: 'LOW' });
    const world = createThreeWorld(scene, stub, { textures: 'none', collider: false });
    const body = world.objects.get('traffic.body')?.[0] as THREE.InstancedMesh;
    const lamp = world.objects.get('traffic.lamp')?.[0] as THREE.InstancedMesh;
    const z0 = body.instanceMatrix.array[14];
    const v0 = body.instanceMatrix.version;
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(0, 30, 0);
    world.update(0.5, cam);
    expect(body.instanceMatrix.array[14]).not.toBe(z0);
    expect(lamp.instanceMatrix.array[14]).toBe(body.instanceMatrix.array[14]);
    expect(body.instanceMatrix.version).toBeGreaterThan(v0);
    /* LOD: after the first pass far crowns left level 0 */
    const lod = world.lods[0];
    const n0 = lod.meshes.reduce((a, row) => a + row[0].count, 0);
    const nAll = lod.desc.matrices.length / 16;
    expect(n0).toBeLessThan(nAll);
    expect(lod.meshes.reduce((a, row) => a + row.reduce((b, m) => b + m.count, 0), 0)).toBe(nAll);
    world.setDetailFull(true, cam);
    expect(lod.meshes.reduce((a, row) => a + row[0].count, 0)).toBe(nAll);
    /* lighting: night windows, tube colour, hull uniforms */
    const wall = world.materials.get('w.bld.wall.0') as THREE.MeshStandardMaterial;
    const night = { ...dayState(), daylight: 0, windowEmission: 0.9, sparShade: 0.12 };
    world.applyLighting(night);
    expect(wall.emissiveIntensity).toBe(0.9);
    expect(world.hullUniforms.uSparShade.value).toBe(0.12);
    const sun = world.materials.get('s.sun') as THREE.MeshBasicMaterial;
    expect(sun.color.r).toBeCloseTo(night.sunColor[0] * night.sunEmission * CORE_CONFIG.SUN_HDR, 9);
    world.dispose();
  });
});
