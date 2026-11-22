/* core/scene/structures.ts vs the golden world snapshots (test/golden, see
   tools/snapshot-lib.mjs for the format). For every structures role:
   geometry arrays, instance matrices, world transforms (legacy parent chain ×
   local vs MeshDesc.transform) and material summaries. LOW/HIGH cases carry
   full arrays (tolerance 1e-5); ULTRAM/ULTRA only hashes of values quantized
   to 1e-4. */
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { buildStructuresFragment } from '../scene/structures.ts';
import type { MaterialDesc, MeshDesc, QualityId, SceneFragment, SeasonId } from '../scene/types.ts';
import { CORE_CONFIG } from '../config/index.ts';
import * as m4 from '../math/mat4.ts';
import { getHex, setHex } from '../math/color.ts';

const GOLDEN = fileURLToPath(new URL('../../test/golden/', import.meta.url));
const TOL = 1e-5;
const QUANT = 1e-4;

const ROLES = ['axis.sun', 'axis.spine', 'lift.body', 'lift.lamp', 'lift.glass', 'axis.collars', 'truss',
  'tower.concrete', 'tower.glass', 'tower.beacon', 'endcap.disc', 'endcap.hub'];

/* ─── golden format ─── */
interface Ref { type: string; len: number; exact: string; quant: string; off?: number }
interface GObj {
  name: string; type: string; parent: string | null; renderOrder: number;
  position: number[]; quaternion: number[]; scale: number[];
  geo?: string; material?: Record<string, unknown>; count?: number; instanceMatrix?: Ref;
}
interface GGeo {
  id: string; firstUser: string; vertexCount: number; indexCount: number;
  attributes: Record<string, { itemSize: number; data: Ref }>; index: Ref | null; groups: number[][];
}
interface Golden { full: boolean; objects: GObj[]; geometries: GGeo[]; data?: Buffer }

const TYPES: Record<string, { new (b: ArrayBuffer): ArrayLike<number>; BYTES_PER_ELEMENT: number }> = {
  f32: Float32Array, f64: Float64Array, u32: Uint32Array, u16: Uint16Array,
  u8: Uint8Array, i32: Int32Array, i16: Int16Array, i8: Int8Array
};
const tagOf = (a: ArrayLike<number>): string => {
  for (const [t, C] of Object.entries(TYPES)) if (a instanceof (C as unknown as typeof Float32Array)) return t;
  throw new Error('unknown array type');
};

function readGolden(id: string): Golden {
  const meta = JSON.parse(readFileSync(GOLDEN + id + '/manifest.json', 'utf8')) as Golden;
  if (meta.full) meta.data = gunzipSync(readFileSync(GOLDEN + id + '/data.bin.gz'));
  return meta;
}
function loadArray(buf: Buffer, r: Ref): ArrayLike<number> {
  const C = TYPES[r.type];
  const start = buf.byteOffset + (r.off as number);
  return new C(buf.buffer.slice(start, start + r.len * C.BYTES_PER_ELEMENT) as ArrayBuffer);
}

/* hashes — same as tools/snapshot-lib.mjs */
function fnvBytes(u8: Uint8Array, h = 0x811c9dc5): number {
  for (let k = 0; k < u8.length; k++) { h ^= u8[k]; h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
const hex = (h: number): string => h.toString(16).padStart(8, '0');
const bytesOf = (a: ArrayBufferView): Uint8Array => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
function quantHash(a: Float32Array | Uint16Array | Uint32Array): string {
  if (!(a instanceof Float32Array)) return hex(fnvBytes(bytesOf(a)));
  const q = new Int32Array(a.length);
  for (let k = 0; k < a.length; k++) {
    const v = Math.round(a[k] / QUANT);
    q[k] = Number.isFinite(v) ? v : 0x7fffffff;
  }
  return hex(fnvBytes(bytesOf(q)));
}

/* ─── comparison ─── */
interface RoleStat { maxDev: number; problems: string[] }

function cmpArray(g: Golden, st: RoleStat, what: string, gr: Ref | null | undefined,
  cur: Float32Array | Uint16Array | Uint32Array | undefined): void {
  if (!gr || !cur) { if (gr || cur) st.problems.push(`${what}: present on one side only`); return; }
  if (gr.type !== tagOf(cur) || gr.len !== cur.length) {
    st.problems.push(`${what}: ${gr.type}[${gr.len}] → ${tagOf(cur)}[${cur.length}]`); return;
  }
  if (g.full && g.data) {
    const ga = loadArray(g.data, gr);
    let d = 0;
    for (let k = 0; k < ga.length; k++) {
      const x = Math.abs(ga[k] - cur[k]);
      if (!(x <= d)) d = Number.isNaN(x) ? Infinity : x;
    }
    if (gr.type !== 'f32' && gr.type !== 'f64' && d !== 0) { st.problems.push(`${what}: integer mismatch`); d = Infinity; }
    st.maxDev = Math.max(st.maxDev, d);
    if (!(d <= TOL)) st.problems.push(`${what}: deviation ${d.toExponential(2)}`);
  } else if (gr.quant !== quantHash(cur)) {
    st.maxDev = Infinity;
    st.problems.push(`${what}: quantized hash ${gr.quant} → ${quantHash(cur)}`);
  }
}

const localMatrix = (o: GObj): number[] => m4.compose(o.position, o.quaternion, o.scale, new Array(16).fill(0)) as number[];

function worldMatrix(g: Golden, o: GObj): number[] {
  let m = localMatrix(o);
  let p = o.parent;
  while (p) {
    const po = g.objects.find(x => x.name === p);
    if (!po) throw new Error('parent not found: ' + p);
    m = m4.multiply(localMatrix(po), m, new Array(16).fill(0)) as number[];
    p = po.parent;
  }
  return m;
}

const SIDE: Record<number, MaterialDesc['side']> = { 0: 'front', 2: 'double' };
const MAP_KEYS: [string, keyof MaterialDesc][] = [
  ['map', 'map'], ['normalMap', 'normalMap'], ['emissiveMap', 'emissiveMap'], ['roughnessMap', 'roughnessMap']
];

function cmpMaterial(st: RoleStat, s: Record<string, unknown>, m: MaterialDesc, renderOrder: number): void {
  const bad = (msg: string): void => { st.problems.push('material ' + m.id + ': ' + msg); };
  const type = s.type as string;
  if (type === 'MeshBasicMaterial') { if (m.model !== 'unlit') bad(`model ${m.model} for ${type}`); }
  else if (type === 'MeshStandardMaterial') {
    if (m.model !== 'standard' && m.model !== 'thinGlass') bad(`model ${m.model} for ${type}`);
  } else bad('unexpected legacy type ' + type);

  const gHex = parseInt((s.color as string).slice(1), 16);
  if (getHex(m.baseColor) !== gHex) bad(`colour #${getHex(m.baseColor).toString(16)} ≠ ${s.color}`);
  if (m.baseColor.every(v => v <= 1)) {
    const lin = setHex(gHex);
    for (let i = 0; i < 3; i++) if (Math.abs(lin[i] - m.baseColor[i]) > TOL) bad('linear colour ' + m.baseColor);
  }
  if (typeof s.emissive === 'string') {
    const e = m.emissive ?? [0, 0, 0];
    if (getHex(e) !== parseInt(s.emissive.slice(1), 16)) bad(`emissive ≠ ${s.emissive}`);
    if (m.emissive && s.emissiveIntensity !== m.emissiveIntensity) bad(`emissiveIntensity ${String(m.emissiveIntensity)} ≠ ${String(s.emissiveIntensity)}`);
  }
  if (typeof s.roughness === 'number' && Math.abs(s.roughness - m.roughness) > 1e-6) bad('roughness');
  if (typeof s.metalness === 'number' && Math.abs(s.metalness - m.metalness) > 1e-6) bad('metalness');
  const transparent = m.alpha !== 'opaque' && 'blend' in m.alpha;
  if (s.transparent !== transparent) bad(`transparent ${transparent}`);
  const opacity = m.alpha !== 'opaque' && 'blend' in m.alpha ? m.alpha.blend : 1;
  if (s.opacity !== opacity) bad(`opacity ${JSON.stringify(opacity)}`);
  if (SIDE[s.side as number] !== m.side) bad(`side ${m.side} ≠ ${String(s.side)}`);
  if (s.toneMapped !== (m.toneMapped ?? true)) bad('toneMapped');
  if (s.depthWrite !== (m.depthWrite ?? true)) bad('depthWrite');
  const maps = MAP_KEYS.filter(([, k]) => m[k]).map(([n]) => n);
  if (JSON.stringify(maps) !== JSON.stringify(s.maps)) bad(`maps ${JSON.stringify(maps)} ≠ ${JSON.stringify(s.maps)}`);
  if (s.normalScale && JSON.stringify(m.normalScale ?? [1, 1]) !== JSON.stringify(s.normalScale)) bad('normalScale');
  if ((m.renderOrder ?? 0) !== renderOrder) bad('renderOrder');
}

function compareCase(g: Golden, frag: SceneFragment): Record<string, RoleStat> {
  const stats: Record<string, RoleStat> = {};
  const gGeo = new Map(g.geometries.map(x => [x.id, x]));
  for (const role of ROLES) {
    const st: RoleStat = (stats[role] = { maxDev: 0, problems: [] });
    const go = g.objects.find(o => o.name === role);
    const md = frag.meshes.filter((x: MeshDesc) => x.role === role);
    if (!go) { st.problems.push('no golden object'); continue; }
    if (md.length !== 1) { st.problems.push(`${md.length} MeshDescs`); continue; }
    const d = md[0];
    if (d.parent !== 'station') st.problems.push('parent ' + d.parent);

    /* geometry */
    const gg = gGeo.get(go.geo as string) as GGeo;
    const cg = frag.geometries[d.geometry];
    if (!cg) { st.problems.push('no geometry ' + d.geometry); continue; }
    if (gg.vertexCount !== cg.position.length / 3) st.problems.push(`vertexCount ${gg.vertexCount} → ${cg.position.length / 3}`);
    if (gg.indexCount !== (cg.index ? cg.index.length : 0)) st.problems.push('indexCount');
    const groups = cg.groups.map(x => [x.start, x.count, x.slot]);
    if (JSON.stringify(groups) !== JSON.stringify(gg.groups)) st.problems.push(`groups ${JSON.stringify(groups)}`);
    cmpArray(g, st, 'position', gg.attributes.position?.data, cg.position);
    cmpArray(g, st, 'normal', gg.attributes.normal?.data, cg.normal);
    cmpArray(g, st, 'uv', gg.attributes.uv?.data, cg.uv);
    cmpArray(g, st, 'index', gg.index, cg.index);

    /* instances */
    if ((go.count ?? 0) !== (d.instances?.count ?? 0)) st.problems.push(`count ${go.count} → ${d.instances?.count}`);
    if (go.instanceMatrix || d.instances) cmpArray(g, st, 'instanceMatrix', go.instanceMatrix, d.instances?.matrices);

    /* world transform */
    const gw = worldMatrix(g, go);
    const cw = d.transform ?? m4.identity();
    let dev = 0;
    for (let i = 0; i < 16; i++) dev = Math.max(dev, Math.abs(gw[i] - cw[i]));
    st.maxDev = Math.max(st.maxDev, dev);
    if (!(dev <= TOL)) st.problems.push(`transform deviation ${dev}`);

    /* material */
    if (d.materials.length !== 1) st.problems.push('materials ' + d.materials.join(','));
    const mat = frag.materials[d.materials[0]];
    if (!mat) st.problems.push('missing material ' + d.materials[0]);
    else cmpMaterial(st, go.material as Record<string, unknown>, mat, go.renderOrder);
  }
  return stats;
}

/* ─── cases ─── */
interface CaseDesc { id: string; seed: number; quality: QualityId; season: SeasonId; full: boolean }
const INDEX = JSON.parse(readFileSync(GOLDEN + 'index.json', 'utf8')) as { cases: CaseDesc[] };

describe('structures fragment vs golden snapshots', () => {
  test('9 golden cases are present', () => { expect(INDEX.cases.length).toBe(9); });

  test('negative control: the comparison catches perturbations', () => {
    const c = INDEX.cases.find(x => x.full) as CaseDesc;
    const g = readGolden(c.id);
    const { fragment } = buildStructuresFragment({
      seed: c.seed, quality: c.quality, season: c.season, saturation: 0.62, greenK: 1
    });
    fragment.geometries['s.axis.spine'].position[7] += 1e-3;
    (fragment.meshes.find(m => m.role === 'truss')?.instances as { matrices: Float32Array }).matrices[13] += 1e-3;
    fragment.materials['s.tower.beacon'].roughness = 0.5;
    fragment.meshes[fragment.meshes.findIndex(m => m.role === 'tower.glass')].transform = m4.identity(new Float32Array(16)) as Float32Array;
    const stats = compareCase(g, fragment);
    expect(stats['axis.spine'].problems.join()).toMatch(/position/);
    expect(stats.truss.problems.join()).toMatch(/instanceMatrix/);
    expect(stats['tower.beacon'].problems.join()).toMatch(/roughness/);
    expect(stats['tower.glass'].problems.join()).toMatch(/transform/);
    expect(stats['axis.sun'].problems).toEqual([]);
  });

  for (const c of INDEX.cases) {
    test(`${c.id}`, () => {
      const g = readGolden(c.id);
      const { fragment } = buildStructuresFragment({
        seed: c.seed, quality: c.quality, season: c.season,
        saturation: CORE_CONFIG.SATURATION_DEFAULT, greenK: CORE_CONFIG.GREEN_K_DEFAULT
      });
      const stats = compareCase(g, fragment);
      const lines = Object.entries(stats).map(([r, s]) =>
        `${c.id} ${r.padEnd(15)} ${s.problems.length ? 'FAIL' : 'ok  '} maxDev ${s.maxDev === Infinity ? 'hash≠' : s.maxDev.toExponential(1)}` +
        (s.problems.length ? '  ' + s.problems.join('; ') : ''));
      if (process.env.B5_VERBOSE || Object.values(stats).some(s => s.problems.length)) console.log(lines.join('\n'));
      expect(Object.values(stats).flatMap(s => s.problems)).toEqual([]);
    });
  }
});

describe('structures fragment shape', () => {
  const base = { seed: 1337, season: 'summer' as SeasonId, saturation: 0.62, greenK: 1 };

  test('ids are prefixed, meshes reference existing geometries/materials, order as legacy', () => {
    const { fragment } = buildStructuresFragment({ ...base, quality: 'HIGH' });
    expect(fragment.meshes.map(m => m.role)).toEqual(ROLES);
    for (const id of Object.keys(fragment.geometries)) expect(id.startsWith('s.')).toBe(true);
    for (const id of Object.keys(fragment.materials)) expect(id.startsWith('s.')).toBe(true);
    for (const m of fragment.meshes) {
      expect(fragment.geometries[m.geometry]).toBeTruthy();
      for (const id of m.materials) expect(fragment.materials[id]).toBeTruthy();
    }
    for (const mat of Object.values(fragment.materials)) {
      for (const k of ['map', 'normalMap', 'emissiveMap'] as const) {
        if (mat[k]) expect(fragment.images[mat[k] as string]).toBeTruthy();
      }
    }
  });

  test('images follow the legacy texture calls', () => {
    const low = buildStructuresFragment({ ...base, quality: 'LOW' }).fragment.images;
    const high = buildStructuresFragment({ ...base, quality: 'HIGH' }).fragment.images;
    expect(Object.keys(low).sort()).toEqual(['endcap', 'endcap.emis', 'panel']);
    expect(Object.keys(high).sort()).toEqual(['endcap', 'endcap.emis', 'endcap.normal', 'panel', 'panel.normal']);
    expect(low.panel.source).toEqual({ gen: 'panelTexture', args: { seed: 1337 + 53 } });
    expect(low.endcap.width).toBe(512);
    expect(high.endcap.source).toEqual({ gen: 'endCapTexture', args: { size: 1024, seed: 1337 + 99, output: 'map' } });
    expect(high['endcap.emis'].source.args.output).toBe('emissive');
    expect(high['endcap.normal'].source).toEqual({ gen: 'heightToNormal', args: { src: high.endcap.source, strength: 1.2, size: 1024 } });
  });

  test('emitters: analytic tube + emissive meshes', () => {
    const { fragment } = buildStructuresFragment({ ...base, quality: 'LOW' });
    const S = CORE_CONFIG.SUN;
    expect(fragment.emitters?.[0]).toEqual({ kind: 'tube', radius: S.r, length: S.len, z0: -S.len / 2, channel: 'tube', role: 'axis.sun' });
    const roles = (fragment.emitters ?? []).filter(e => e.kind === 'meshEmission').map(e => e.role);
    expect(roles).toEqual(['lift.lamp', 'lift.glass', 'tower.glass', 'tower.beacon', 'endcap.disc']);
    for (const e of fragment.emitters ?? []) {
      const mesh = fragment.meshes.find(m => m.role === e.role);
      expect(mesh).toBeTruthy();
      const mat = fragment.materials[(mesh as MeshDesc).materials[0]];
      expect(mat.channel).toBe(e.channel);
      expect(mat.emissiveNits).toBeGreaterThan(0);
    }
  });

  test('fragment is structured-clone-able plain data', () => {
    const { fragment, lifts } = buildStructuresFragment({ ...base, quality: 'LOW' });
    const c = structuredClone({ fragment, lifts });
    expect(c.fragment.meshes.length).toBe(fragment.meshes.length);
  });
});
