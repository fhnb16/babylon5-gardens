/* ═══════════════════════════════════════════════════════════════════════════
   GPU byte layouts of the path tracer acceleration structures — the single
   source of truth shared by the CPU builder/packer, the CPU reference
   traversal and the WGSL code generator (emitWgslLayout()).

   All records are 16-byte aligned and made only of vec3f/vec4f/u32 fields,
   so the WGSL storage-buffer layout equals the plain C layout below and each
   16-byte row is one vector load on the GPU.

   BVH2 node, 64 B (Aila–Laine style: both child boxes live in the parent, so
   one node fetch tests two children):
     byte  0  c0min  vec3f   child 0 box min
     byte 12  child0 u32     child 0 reference
     byte 16  c0max  vec3f   child 0 box max
     byte 28  child1 u32     child 1 reference
     byte 32  c1min  vec3f   child 1 box min
     byte 44  parent u32     parent node index (NODE_INVALID for a root) — refit/stackless
     byte 48  c1max  vec3f   child 1 box max
     byte 60  aux    u32     reserved, 0
   Child reference: bit 31 = leaf flag.
     inner: bits 0..30 = absolute node index in the node buffer
     leaf : bits 27..30 = count (0..15), bits 0..26 = offset (0..2^27-1)
            BLAS leaf → `count` triangles starting at triangle record `offset`
            TLAS leaf → count = 1, offset = instance index
            count 0   → empty slot (only at the root of a 0/1-leaf tree); its box
                        is the EMPTY box (a point at +2^127) which every finite-tmax slab test misses.

   Triangle record, 48 B, pre-gathered in leaf order (vertex form):
     byte  0  v0     vec3f
     byte 12  primId u32     original triangle index in the source geometry
     byte 16  v1     vec3f
     byte 28  slot   u32     material slot (GeometryGroup.slot), 0 if no groups
     byte 32  v2     vec3f
     byte 44  aux    u32     BLAS (geometry) index, written by packScene (0 in a lone PackedBlas)
   Vertex form (not v0/e1/e2): the watertight test (Woop–Benthin–Wald 2013)
   translates the three vertices into the ray frame; rebuilding v1 = v0 + e1
   in f32 would round differently for neighbouring triangles and reopen the
   cracks the watertight test exists to close.

   Instance record, 64 B:
     byte  0  w2o0   vec4f   row 0 of worldToObject (3×4 affine, row-major rows:
     byte 16  w2o1   vec4f     p_obj.x = dot(w2o0, vec4(p,1)), d_obj.x = dot(w2o0.xyz, d))
     byte 32  w2o2   vec4f
     byte 48  blasRoot u32   absolute node index of the BLAS root
     byte 52  matBase  u32   material index of slot 0 (material = matBase + tri.slot)
     byte 56  tint     u32   RGB9E5 linear tint (see below)
     byte 60  flagsLight u32 bits 24..31 flags, bits 0..23 lightBase (NO_LIGHT = 0xFFFFFF)
   Tint = RGB9E5 (shared exponent, 9-bit mantissas, range 0..65408): instance
   colours are linear floats; 8-bit linear unorm bands badly in the darks
   (step 1/255 ≈ 0.004 vs typical foliage values 0.02..0.1) and sRGB unorm
   needs a pow in the shader, while RGB9E5 keeps ~0.2 % relative precision on
   the dominant channel, allows HDR tints (> 1) and decodes in 5 ALU ops.
   Flags: bits 0..3 = visibility mask, tested as (flags & rayMask & 0xF) != 0;
   bits 4..7 = properties.
   ═══════════════════════════════════════════════════════════════════════════ */

/* ─── BVH2 node ───────────────────────────────────────────────────────────── */

export const NODE_BYTES = 64;
export const NODE_WORDS = 16;
/** byte offsets inside a node */
export const NODE_OFFSETS = {
  c0min: 0, child0: 12, c0max: 16, child1: 28,
  c1min: 32, parent: 44, c1max: 48, aux: 60
} as const;
/** 32-bit word offsets inside a node (byte offset / 4) */
export const NODE_W = {
  c0min: 0, child0: 3, c0max: 4, child1: 7,
  c1min: 8, parent: 11, c1max: 12, aux: 15
} as const;

export const LEAF_FLAG = 0x80000000;
export const LEAF_COUNT_SHIFT = 27;
export const LEAF_COUNT_MASK = 0xf;
export const LEAF_OFFSET_MASK = 0x07ffffff;
/** hard cap of primitives in one leaf (4-bit count) */
export const MAX_LEAF_PRIMS = 15;
/** largest addressable leaf offset + 1 */
export const MAX_LEAF_OFFSET = 1 << LEAF_COUNT_SHIFT;
/** reference to an empty child slot */
export const EMPTY_LEAF = LEAF_FLAG;
export const NODE_INVALID = 0xffffffff;
/** coordinate of the EMPTY box (min = max = (E,E,E)), 2^127 (exact in f32): far beyond any ray tmax */
export const EMPTY_BOX_COORD = 2 ** 127;

/* ─── triangle record ─────────────────────────────────────────────────────── */

export const TRI_BYTES = 48;
export const TRI_WORDS = 12;
export const TRI_OFFSETS = { v0: 0, primId: 12, v1: 16, slot: 28, v2: 32, aux: 44 } as const;
export const TRI_W = { v0: 0, primId: 3, v1: 4, slot: 7, v2: 8, aux: 11 } as const;

/* ─── instance record ─────────────────────────────────────────────────────── */

export const INST_BYTES = 64;
export const INST_WORDS = 16;
export const INST_OFFSETS = {
  w2o0: 0, w2o1: 16, w2o2: 32, blasRoot: 48, matBase: 52, tint: 56, flagsLight: 60
} as const;
export const INST_W = {
  w2o0: 0, w2o1: 4, w2o2: 8, blasRoot: 12, matBase: 13, tint: 14, flagsLight: 15
} as const;

export const INST_FLAGS_SHIFT = 24;
export const INST_LIGHT_MASK = 0x00ffffff;
export const NO_LIGHT = 0x00ffffff;
/** visibility bits (ray mask) */
export const VIS_CAMERA = 1 << 0;
export const VIS_SHADOW = 1 << 1;
export const VIS_INDIRECT = 1 << 2;
export const VIS_RESERVED = 1 << 3;
export const VIS_ALL = 0xf;
/** property bits */
export const INST_EMISSIVE = 1 << 4;
export const INST_DYNAMIC = 1 << 5;
/** thin glazing: shadow rays multiply its transmittance instead of stopping (k_shadow_tr.wgsl) */
export const INST_GLASS = 1 << 6;

/* ─── depth limits / traversal stack ──────────────────────────────────────── */

/** max inner nodes on any root→leaf path */
export const BLAS_MAX_DEPTH = 40;
export const TLAS_MAX_DEPTH = 28;
/**
 * Ordered traversal pushes at most one far child per inner node on the
 * current path, so the stack never holds more than TLAS + BLAS depth.
 * Stack entry = (child reference u32, entry distance f32).
 */
export const TRAVERSAL_STACK_SIZE = BLAS_MAX_DEPTH + TLAS_MAX_DEPTH;
/** Ize 2013: slab tfar *= 1 + 2·γ(3), γ(n) = n·u/(1−n·u), u = 2^-24 (f32) */
export const SLAB_TFAR_SCALE = 1 + 2 * ((3 * 2 ** -24) / (1 - 3 * 2 ** -24));
/** |d| below this is replaced by ±this before 1/d (keeps 1/d finite in f32) */
export const DIR_EPS = 1e-20;

/* ─── reference helpers (the WGSL has the same functions) ─────────────────── */

export function isLeaf(ref: number): boolean {
  return (ref & LEAF_FLAG) !== 0;
}
export function leafCount(ref: number): number {
  return (ref >>> LEAF_COUNT_SHIFT) & LEAF_COUNT_MASK;
}
export function leafOffset(ref: number): number {
  return ref & LEAF_OFFSET_MASK;
}
export function makeLeaf(count: number, offset: number): number {
  if (count < 0 || count > MAX_LEAF_PRIMS) throw new RangeError(`leaf count ${count} > ${MAX_LEAF_PRIMS}`);
  if (offset < 0 || offset >= MAX_LEAF_OFFSET) throw new RangeError(`leaf offset ${offset} ≥ 2^27`);
  return (LEAF_FLAG | (count << LEAF_COUNT_SHIFT) | offset) >>> 0;
}

/* ─── RGB9E5 ──────────────────────────────────────────────────────────────── */

const E5_BIAS = 15;
const E5_MANT = 9;
const E5_MAX_EXP = 31;
export const RGB9E5_MAX = ((2 ** E5_MANT - 1) / 2 ** E5_MANT) * 2 ** (E5_MAX_EXP - E5_BIAS);

/** Encode linear RGB (EXT_texture_shared_exponent rules, round to nearest). */
export function encodeRgb9e5(r: number, g: number, b: number): number {
  const cl = (x: number) => (x > 0 ? (x < RGB9E5_MAX ? x : RGB9E5_MAX) : 0); // NaN → 0
  const rc = cl(r), gc = cl(g), bc = cl(b);
  const maxc = Math.max(rc, gc, bc);
  let expP = -E5_BIAS - 1;
  if (maxc > 0) {
    let e = Math.floor(Math.log2(maxc));
    if (2 ** e > maxc) e--;            // guard log2 rounding at powers of two
    else if (2 ** (e + 1) <= maxc) e++;
    expP = Math.max(expP, e);
  }
  let exp = expP + 1 + E5_BIAS;
  const maxS = Math.floor(maxc / 2 ** (exp - E5_BIAS - E5_MANT) + 0.5);
  if (maxS === 1 << E5_MANT) exp++;
  const sc = 2 ** (exp - E5_BIAS - E5_MANT);
  const rs = Math.floor(rc / sc + 0.5), gs = Math.floor(gc / sc + 0.5), bs = Math.floor(bc / sc + 0.5);
  return (rs | (gs << 9) | (bs << 18) | (exp << 27)) >>> 0;
}

export function decodeRgb9e5(p: number, out: Float64Array | number[] = [0, 0, 0]): Float64Array | number[] {
  const s = 2 ** ((p >>> 27) - E5_BIAS - E5_MANT);
  out[0] = (p & 511) * s;
  out[1] = ((p >>> 9) & 511) * s;
  out[2] = ((p >>> 18) & 511) * s;
  return out;
}

/* ─── WGSL emission ───────────────────────────────────────────────────────── */

export type WgslFieldType = 'vec3f' | 'vec4f' | 'u32' | 'f32';
export interface StructDef {
  name: string;
  size: number;
  fields: { name: string; type: WgslFieldType; offset: number }[];
}

/** Struct definitions — the same field order and offsets as the tables above. */
export const STRUCTS: StructDef[] = [
  {
    name: 'B5BvhNode',
    size: NODE_BYTES,
    fields: [
      { name: 'c0min', type: 'vec3f', offset: NODE_OFFSETS.c0min },
      { name: 'child0', type: 'u32', offset: NODE_OFFSETS.child0 },
      { name: 'c0max', type: 'vec3f', offset: NODE_OFFSETS.c0max },
      { name: 'child1', type: 'u32', offset: NODE_OFFSETS.child1 },
      { name: 'c1min', type: 'vec3f', offset: NODE_OFFSETS.c1min },
      { name: 'parent', type: 'u32', offset: NODE_OFFSETS.parent },
      { name: 'c1max', type: 'vec3f', offset: NODE_OFFSETS.c1max },
      { name: 'aux', type: 'u32', offset: NODE_OFFSETS.aux }
    ]
  },
  {
    name: 'B5Tri',
    size: TRI_BYTES,
    fields: [
      { name: 'v0', type: 'vec3f', offset: TRI_OFFSETS.v0 },
      { name: 'primId', type: 'u32', offset: TRI_OFFSETS.primId },
      { name: 'v1', type: 'vec3f', offset: TRI_OFFSETS.v1 },
      { name: 'slot', type: 'u32', offset: TRI_OFFSETS.slot },
      { name: 'v2', type: 'vec3f', offset: TRI_OFFSETS.v2 },
      { name: 'aux', type: 'u32', offset: TRI_OFFSETS.aux }
    ]
  },
  {
    name: 'B5Instance',
    size: INST_BYTES,
    fields: [
      { name: 'w2o0', type: 'vec4f', offset: INST_OFFSETS.w2o0 },
      { name: 'w2o1', type: 'vec4f', offset: INST_OFFSETS.w2o1 },
      { name: 'w2o2', type: 'vec4f', offset: INST_OFFSETS.w2o2 },
      { name: 'blasRoot', type: 'u32', offset: INST_OFFSETS.blasRoot },
      { name: 'matBase', type: 'u32', offset: INST_OFFSETS.matBase },
      { name: 'tint', type: 'u32', offset: INST_OFFSETS.tint },
      { name: 'flagsLight', type: 'u32', offset: INST_OFFSETS.flagsLight }
    ]
  }
];

const hex = (n: number) => '0x' + (n >>> 0).toString(16) + 'u';

/**
 * WGSL declarations matching the byte layouts: constants, the three structs
 * and tiny decode helpers. Pure functions only, identifiers prefixed B5/b5_,
 * no `$`, no bindings — safe to concatenate into any module.
 */
export function emitWgslLayout(): string {
  const lines: string[] = [];
  lines.push('// generated by pathtracer/bvh/layout.ts — do not edit');
  const u = (name: string, v: number) => lines.push(`const ${name}: u32 = ${hex(v)};`);
  const d = (name: string, v: number) => lines.push(`const ${name}: u32 = ${v}u;`);
  u('B5_LEAF_FLAG', LEAF_FLAG);
  d('B5_LEAF_COUNT_SHIFT', LEAF_COUNT_SHIFT);
  u('B5_LEAF_COUNT_MASK', LEAF_COUNT_MASK);
  u('B5_LEAF_OFFSET_MASK', LEAF_OFFSET_MASK);
  u('B5_NODE_INVALID', NODE_INVALID);
  d('B5_INST_FLAGS_SHIFT', INST_FLAGS_SHIFT);
  u('B5_INST_LIGHT_MASK', INST_LIGHT_MASK);
  u('B5_NO_LIGHT', NO_LIGHT);
  u('B5_VIS_CAMERA', VIS_CAMERA);
  u('B5_VIS_SHADOW', VIS_SHADOW);
  u('B5_VIS_INDIRECT', VIS_INDIRECT);
  u('B5_VIS_ALL', VIS_ALL);
  u('B5_INST_EMISSIVE', INST_EMISSIVE);
  u('B5_INST_DYNAMIC', INST_DYNAMIC);
  u('B5_INST_GLASS', INST_GLASS);
  d('B5_BLAS_MAX_DEPTH', BLAS_MAX_DEPTH);
  d('B5_TLAS_MAX_DEPTH', TLAS_MAX_DEPTH);
  d('B5_STACK_SIZE', TRAVERSAL_STACK_SIZE);
  lines.push(`const B5_SLAB_TFAR_SCALE: f32 = ${SLAB_TFAR_SCALE.toPrecision(9)};`);
  lines.push(`const B5_DIR_EPS: f32 = ${DIR_EPS.toExponential()};`);
  lines.push('');
  for (const s of STRUCTS) {
    lines.push(`// size ${s.size} B`);
    lines.push(`struct ${s.name} {`);
    for (const f of s.fields) lines.push(`  ${f.name}: ${f.type}, // @${f.offset}`);
    lines.push('}');
    lines.push('');
  }
  lines.push(
    'fn b5_is_leaf(c: u32) -> bool { return (c & B5_LEAF_FLAG) != 0u; }',
    'fn b5_leaf_count(c: u32) -> u32 { return (c >> B5_LEAF_COUNT_SHIFT) & B5_LEAF_COUNT_MASK; }',
    'fn b5_leaf_offset(c: u32) -> u32 { return c & B5_LEAF_OFFSET_MASK; }',
    'fn b5_inst_flags(fl: u32) -> u32 { return fl >> B5_INST_FLAGS_SHIFT; }',
    'fn b5_inst_light_base(fl: u32) -> u32 { return fl & B5_INST_LIGHT_MASK; }',
    'fn b5_rgb9e5_decode(p: u32) -> vec3f {',
    '  let s = exp2(f32(p >> 27u) - 24.0);',
    '  return vec3f(f32(p & 511u), f32((p >> 9u) & 511u), f32((p >> 18u) & 511u)) * s;',
    '}',
    ''
  );
  return lines.join('\n');
}
