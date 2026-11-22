/* Golden gate for core/scene/world.ts: buildScene() must reproduce the legacy
   js/world.js objects captured by tools/snapshot-lib.mjs in test/golden.

   Per world role: instance counts, matrices and colours (legacy object order
   = buckets concatenated), chunk spheres (= InstancedMesh bounding spheres),
   geometry attributes / index / groups, plus the hill and pond lists and the
   legacy object count. Full cases (LOW, HIGH) compare arrays with |Δ| ≤ 1e-5;
   big cases (ULTRAM, ULTRA) compare the 1e-4-quantized FNV hashes.

   The hull is emitted for viewing from inside (see core/scene/world-shapes.ts
   hullGeo): its normals are negated, its winding reversed and U un-mirrored
   (u' = 0.5 − u = what legacy SAMPLED with repeat.x = −1, offset.x = 0.5).
   The comparison undoes exactly that; the index is compared as a triangle
   SET (legacy order comes from the three-mesh-bvh rebuild). */
import { describe, expect, test } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { buildScene } from '../scene/build.ts';
import type { GeometryDesc, SceneDesc, WorldParams } from '../scene/types.ts';
import { CORE_CONFIG } from '../config/index.ts';
import { mulberry32 } from '../rng.ts';
import { placeHills, pondsOf } from '../layout/hills.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GOLDEN = join(ROOT, 'test', 'golden');
const TOL = 1e-5, QUANT = 1e-4;

/* ─── golden format (tools/snapshot-lib.mjs) ─── */
interface Ref { type: string; len: number; exact: string; quant: string; off?: number }
interface GObj {
  name: string; role: string; type: string; geo?: string; count?: number; capacity?: number;
  instanceMatrix?: Ref | null; instanceColor?: Ref | null; boundingSphere?: number[];
}
interface GGeo {
  id: string; firstUser: string; attrOrder: string[];
  attributes: Record<string, { itemSize: number; count: number; data: Ref }>;
  vertexCount: number; index: Ref | null; indexCount: number; triSet?: string; groups: number[][];
}
interface Gold {
  id: string; seed: number; quality: WorldParams['quality']; season: WorldParams['season']; full: boolean;
  drawn: number; hills: Record<string, number | boolean>[]; ponds: Record<string, number>[];
  objects: GObj[]; geometries: GGeo[]; data?: Buffer;
}

type Arr = Float32Array | Float64Array | Uint32Array | Uint16Array | Uint8Array | Int32Array;
const TYPES: Record<string, new (b: ArrayBuffer) => Arr> = {
  f32: Float32Array, f64: Float64Array, u32: Uint32Array, u16: Uint16Array, u8: Uint8Array, i32: Int32Array
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
  const order = Array.from({ length: n }, (_, k) => k);
  order.sort((x, y) => (tri[x * 3] - tri[y * 3]) || (tri[x * 3 + 1] - tri[y * 3 + 1]) || (tri[x * 3 + 2] - tri[y * 3 + 2]));
  const out = new Uint32Array(n * 3);
  for (let k = 0; k < n; k++) {
    const s = order[k] * 3;
    out[k * 3] = tri[s]; out[k * 3 + 1] = tri[s + 1]; out[k * 3 + 2] = tri[s + 2];
  }
  return hex(fnvBytes(new Uint8Array(out.buffer)));
}

function readGolden(id: string): Gold | null {
  const dir = join(GOLDEN, id);
  if (!existsSync(join(dir, 'manifest.json'))) return null;
  const g = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Gold;
  if (g.full) g.data = gunzipSync(readFileSync(join(dir, 'data.bin.gz')));
  return g;
}
function load(g: Gold, r: Ref): Arr {
  const C = TYPES[r.type];
  const buf = g.data as Buffer;
  const start = buf.byteOffset + (r.off as number);
  const bpe = (C as unknown as { BYTES_PER_ELEMENT: number }).BYTES_PER_ELEMENT;
  return new C(buf.buffer.slice(start, start + r.len * bpe) as ArrayBuffer);
}

/* ─── comparison ─── */
interface RoleStat { objects: number; instances: number; maxDev: number }
interface Report { problems: string[]; roles: Record<string, RoleStat> }

/** World roles produced by js/world.js (buildWorld). Structures roles are B2b's. */
const SECTORED = ['bld.0', 'bld.1', 'bld.2', 'bld.3', 'cars.parked', 'trunks', 'tufts', 'bushes', 'blob', 'print'];

function compareScene(gold: Gold, scene: SceneDesc): Report {
  const problems: string[] = [];
  const roles: Record<string, RoleStat> = {};
  const stat = (role: string): RoleStat => (roles[role] ??= { objects: 0, instances: 0, maxDev: 0 });
  const bad = (what: string, msg: string): void => { problems.push(`${gold.id} ${what}: ${msg}`); };

  /** compare one array (gold ref vs current values); mode by case */
  const cmp = (role: string, what: string, gr: Ref | null | undefined, cur: Arr | null | undefined): void => {
    const st = stat(role);
    if (!gr || !cur) { if (gr || cur) bad(role, `${what}: only on one side`); return; }
    if (gr.len !== cur.length) { bad(role, `${what}: length ${gr.len} → ${cur.length}`); return; }
    if (gold.full) {
      const ga = load(gold, gr);
      if (isFloat(ga)) {
        let d = 0;
        for (let k = 0; k < ga.length; k++) {
          const x = Math.abs(ga[k] - cur[k]);
          if (!(x <= d)) d = Number.isNaN(x) ? Infinity : x;
        }
        st.maxDev = Math.max(st.maxDev, d);
        if (!(d <= TOL)) bad(role, `${what}: deviation ${d.toExponential(2)} > ${TOL}`);
      } else {
        let n = 0;
        for (let k = 0; k < ga.length; k++) if (ga[k] !== cur[k]) n++;
        if (n) { st.maxDev = Infinity; bad(role, `${what}: ${n} integers differ`); }
      }
    } else {
      const C = TYPES[gr.type];
      const typed = cur instanceof C ? cur : (C as unknown as { from(a: ArrayLike<number>): Arr }).from(cur);
      if (quantHash(typed) !== gr.quant) { st.maxDev = Infinity; bad(role, `${what}: quantized hash differs`); }
    }
  };
  const sphereDev = (role: string, what: string, g: number[] | undefined, c: readonly number[]): void => {
    if (!g) return;
    let d = 0;
    for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(g[k] - c[k]));
    stat(role).maxDev = Math.max(stat(role).maxDev, d);
    if (!(d <= TOL)) bad(role, `${what}: sphere deviation ${d}`);
  };

  const gGeo = new Map(gold.geometries.map(g => [g.id, g]));
  const objsOf = (role: string): GObj[] => gold.objects.filter(o => o.role === role);

  /** geometry check; hull gets the inside-view transforms undone */
  const cmpGeo = (role: string, go: GObj, g: GeometryDesc | undefined, hull = false): void => {
    const gg = gGeo.get(go.geo as string);
    if (!gg || !g) { bad(role, 'geometry missing'); return; }
    if (gg.firstUser !== go.name) return;
    const vc = g.position.length / 3;
    if (gg.vertexCount !== vc) bad(role, `vertexCount ${gg.vertexCount} → ${vc}`);
    const ic = g.index ? g.index.length : 0;
    if (gg.indexCount !== ic) bad(role, `indexCount ${gg.indexCount} → ${ic}`);
    const groups = g.groups.map(x => [x.start, x.count, x.slot]);
    if (JSON.stringify(gg.groups) !== JSON.stringify(groups)) bad(role, `groups ${JSON.stringify(gg.groups)} → ${JSON.stringify(groups)}`);
    const attrs: Record<string, Arr | undefined> = { position: g.position, normal: g.normal, uv: g.uv, color: g.color };
    const order = Object.keys(attrs).filter(k => attrs[k]);
    if (JSON.stringify(gg.attrOrder) !== JSON.stringify(order)) bad(role, `attributes ${gg.attrOrder} → ${order}`);
    if (hull) {
      attrs.normal = g.normal.map(v => -v);
      attrs.uv = g.uv.map((v, i) => (i % 2 ? v : 0.5 - v));
      const idx = g.index as Uint16Array | Uint32Array;
      const back = new Uint32Array(idx.length);
      for (let i = 0; i < idx.length; i += 3) { back[i] = idx[i]; back[i + 1] = idx[i + 2]; back[i + 2] = idx[i + 1]; }
      if (gg.triSet !== triSetHash(back)) bad(role, 'triangle set differs');
    } else {
      if (gg.triSet && g.index && gg.triSet !== triSetHash(g.index)) bad(role, 'triangle set differs');
      cmp(role, 'index', gg.index, g.index);
    }
    for (const n of gg.attrOrder) cmp(role, n, gg.attributes[n].data, attrs[n]);
  };

  let drawn = 0;
  /* hull */
  {
    const go = objsOf('hull')[0];
    const m = scene.meshes.find(x => x.role === 'hull');
    if (!go || !m) bad('hull', 'missing');
    else { stat('hull').objects++; drawn++; cmpGeo('hull', go, scene.geometries[m.geometry], true); }
  }
  /* sectored instanced roles */
  for (const role of SECTORED) {
    const gos = objsOf(role);
    const m = scene.meshes.find(x => x.role === role);
    if (!gos.length && !m) continue;
    if (!m || !m.instances) { bad(role, 'missing in scene'); continue; }
    const I = m.instances;
    if (I.chunks.length !== gos.length) { bad(role, `chunks ${gos.length} → ${I.chunks.length}`); continue; }
    const st = stat(role);
    gos.forEach((go, c) => {
      const ch = I.chunks[c];
      st.objects++; st.instances += ch.count; drawn++;
      if (go.count !== ch.count || go.capacity !== ch.count) bad(go.name, `count ${go.count} → ${ch.count}`);
      cmp(role, go.name + ':matrix', go.instanceMatrix, I.matrices.subarray(ch.start * 16, (ch.start + ch.count) * 16));
      cmp(role, go.name + ':color', go.instanceColor ?? null,
        I.colors ? I.colors.subarray(ch.start * 3, (ch.start + ch.count) * 3) : null);
      sphereDev(role, go.name, go.boundingSphere, ch.sphere);
    });
    cmpGeo(role, gos[0], scene.geometries[m.geometry]);
  }
  /* crowns: one LodSetDesc, three legacy meshes per sector */
  {
    const lod = scene.lodSets.find(l => l.role === 'crowns');
    if (!lod) bad('crowns', 'missing');
    else {
      for (let li = 0; li < 3; li++) {
        const role = 'crowns.lod' + li;
        const gos = objsOf(role);
        if (gos.length !== lod.chunks.length) { bad(role, `chunks ${gos.length} → ${lod.chunks.length}`); continue; }
        const st = stat(role);
        gos.forEach((go, c) => {
          const ch = lod.chunks[c];
          st.objects++; drawn++;
          const want = li === 0 ? ch.count : 0;
          st.instances += want;
          if (go.count !== want || go.capacity !== ch.count) bad(go.name, `count/capacity ${go.count}/${go.capacity} → ${want}/${ch.count}`);
          if (li === 0) {
            cmp(role, go.name + ':matrix', go.instanceMatrix, lod.matrices.subarray(ch.start * 16, (ch.start + ch.count) * 16));
            cmp(role, go.name + ':color', go.instanceColor, lod.colors.subarray(ch.start * 3, (ch.start + ch.count) * 3));
          }
          sphereDev(role, go.name, go.boundingSphere, ch.sphere);
        });
        cmpGeo(role, gos[0], scene.geometries[lod.levels[li].geometry]);
      }
    }
  }
  /* traffic */
  for (const role of ['traffic.body', 'traffic.lamp']) {
    const go = objsOf(role)[0];
    const m = scene.meshes.find(x => x.role === role);
    if (!go && !m) continue;
    if (!go || !m || !m.instances) { bad(role, 'only on one side'); continue; }
    const st = stat(role);
    st.objects++; st.instances += m.instances.count; drawn++;
    if (go.count !== m.instances.count) bad(role, `count ${go.count} → ${m.instances.count}`);
    cmp(role, 'matrix', go.instanceMatrix, m.instances.matrices);
    cmp(role, 'color', go.instanceColor ?? null, m.instances.colors ?? null);
    cmpGeo(role, go, scene.geometries[m.geometry]);
  }
  /* nav points */
  {
    const go = objsOf('nav')[0];
    const b = scene.billboards.find(x => x.role === 'nav');
    if (!go || !b) bad('nav', 'missing');
    else {
      stat('nav').objects++; drawn++;
      const gg = gGeo.get(go.geo as string) as GGeo;
      cmp('nav', 'position', gg.attributes.position.data, b.positions);
    }
  }
  if (drawn !== gold.drawn) bad('drawn', `${gold.drawn} → ${drawn}`);

  /* hills / ponds: full legacy records, plus the HillDesc view of them */
  {
    const hills = placeHills(mulberry32(gold.seed + 404), CORE_CONFIG.R, CORE_CONFIG.L);
    const ponds = pondsOf(hills);
    const listDev = (k: string, a: Record<string, unknown>[], b: Record<string, unknown>[]): void => {
      const st = stat(k);
      st.objects = a.length;
      if (a.length !== b.length) { bad(k, `count ${a.length} → ${b.length}`); return; }
      let d = 0;
      for (let i = 0; i < a.length; i++) {
        for (const f of Object.keys(a[i])) {
          if (typeof a[i][f] === 'number') d = Math.max(d, Math.abs((a[i][f] as number) - (b[i][f] as number)));
          else if (a[i][f] !== b[i][f]) d = Infinity;
        }
      }
      st.maxDev = Math.max(st.maxDev, d);
      if (!(d <= TOL)) bad(k, `deviation ${d}`);
    };
    listDev('hills', gold.hills, hills as unknown as Record<string, unknown>[]);
    listDev('ponds', gold.ponds, ponds as unknown as Record<string, unknown>[]);
    const hd = scene.hull.hills;
    if (hd.length !== hills.length) bad('hull.hills', 'count');
    else hills.forEach((h, i) => {
      const e = hd[i];
      const rise = h.dip ? -h.h * CORE_CONFIG.HILL.dipDepth : h.h;
      if (e.theta !== h.t || e.z !== h.z || e.r !== h.r || e.rise !== rise || !!e.pond !== h.dip) bad('hull.hills', `entry ${i}`);
    });
  }
  return { problems, roles };
}

/* ─── cases ─── */
const index = JSON.parse(readFileSync(join(GOLDEN, 'index.json'), 'utf8')) as { cases: { id: string }[] };
const summary: Record<string, Record<string, RoleStat>> = {};

describe('scene golden (world roles vs legacy js/world.js)', () => {
  for (const c of index.cases) {
    test(c.id, () => {
      const gold = readGolden(c.id);
      expect(gold, `golden ${c.id}`).not.toBeNull();
      const g = gold as Gold;
      const params: WorldParams = {
        seed: g.seed >>> 0, quality: g.quality, season: g.season,
        saturation: CORE_CONFIG.SATURATION_DEFAULT, greenK: CORE_CONFIG.GREEN_K_DEFAULT
      };
      const scene = buildScene(params);
      const r = compareScene(g, scene);
      summary[c.id] = r.roles;
      if (process.env.B5_GOLDEN_REPORT) {
        const lines = Object.entries(r.roles).map(([k, s]) =>
          `${k.padEnd(14)} obj ${String(s.objects).padStart(4)} inst ${String(s.instances).padStart(6)} maxDev ${s.maxDev === Infinity ? 'hash≠' : s.maxDev.toExponential(1)}`);
        console.log(`${c.id}\n  ` + lines.join('\n  '));
      }
      expect(r.problems.slice(0, 30)).toEqual([]);
    }, 120000);
  }

  /* negative control: the comparator must notice small perturbations */
  test('comparator detects perturbations', () => {
    const g = readGolden(index.cases.find(c => /LOW/.test(c.id))?.id as string) as Gold;
    const scene = buildScene({ seed: g.seed >>> 0, quality: g.quality, season: g.season,
      saturation: CORE_CONFIG.SATURATION_DEFAULT, greenK: CORE_CONFIG.GREEN_K_DEFAULT });
    const bush = scene.meshes.find(m => m.role === 'bushes');
    (bush?.instances as { matrices: Float32Array }).matrices[13] += 1e-3;
    const hull = scene.geometries[scene.meshes.find(m => m.role === 'hull')?.geometry as string];
    const idx = hull.index as Uint16Array;
    const t = idx[1]; idx[1] = idx[2]; idx[2] = t;          // one triangle with legacy (outside) winding
    hull.uv[100] += 1e-3;
    const r = compareScene(g, scene);
    expect(r.problems.some(p => p.includes('bushes'))).toBe(true);
    expect(r.problems.some(p => p.includes('triangle set'))).toBe(true);
    expect(r.problems.some(p => p.includes('hull') && p.includes('uv'))).toBe(true);
  });
});
