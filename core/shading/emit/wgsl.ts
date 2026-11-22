/* ═══════════════════════════════════════════════════════════════════════════
   WGSL emitter for shading kernels (path tracer, ThreeRT MaterialFunction).

   Per kernel (stem `T` = kernel.typeName, function `f` = signature.name):
     struct TIn { …inputs… }
     struct TUniforms { …uniforms… }
     struct TOut { …outputs… }
     fn f(b5_i: TIn, b5_u: TUniforms) -> TOut
     fn f_flat(b5_i: TIn, b5_p: array<f32, N>) -> TOut      (optional)

   Hygiene (AGENTS.md §5): pure functions, no bindings / override / enable,
   no `$`, f32 only, every module-scope and local identifier prefixed
   b5_ / B5 (struct MEMBER names are the contract keys — they are scoped to
   their struct and cannot collide), floored mod via b5_mod*, never `%`.

   Uniform struct layout (`arrays` option):
   • 'f32'  — array<f32, N>. Valid in function scope and in the STORAGE
              address space (stride 4). NOT valid in var<uniform>.
   • 'vec4' — array<vec4<f32>, ceil(N/4)>, element j at [j/4][j%4]. Valid in
              both uniform and storage address spaces (stride 16).
   Field offsets follow WGSL alignment rules (f32 a4, vec2 a8, vec3 a16 s12);
   `uniformLayout()` returns them for host-side packing.
   Flat variant: tightly packed floats in signature order (vec3 = 3 floats,
   arrays = N floats); `flatParamLayout()` / `packFlatParams()` describe it.
   ═══════════════════════════════════════════════════════════════════════════ */

import type { KernelSignature, KType } from '../contracts.ts';
import type { Kernel } from '../kernel.ts';
import { kTypeSize } from '../kernel.ts';
import { recordKernel } from './record.ts';
import type { RExpr, RType, Recorded } from './record.ts';

export type ArrayLayout = 'f32' | 'vec4';

export interface WgslOptions {
  /** array-uniform layout, see header. Default 'f32'. */
  arrays?: ArrayLayout;
  /** also emit `<name>_flat(b5_i, b5_p: array<f32, N>)`; true → N = 32 */
  flat?: boolean | number;
  /** emit helper functions (b5_mod…) — emitWgslLibrary emits them once itself */
  helpers?: boolean;
}

export const FLAT_PARAMS_DEFAULT = 32;

const WGSL_TYPE: Record<RType, string> = { f32: 'f32', vec2: 'vec2<f32>', vec3: 'vec3<f32>', bool: 'bool' };

const HELPERS: Record<string, string> = {
  b5_mod: 'fn b5_mod(b5_x: f32, b5_y: f32) -> f32 { return b5_x - b5_y * floor(b5_x / b5_y); }',
  b5_mod2: 'fn b5_mod2(b5_x: vec2<f32>, b5_y: vec2<f32>) -> vec2<f32> { return b5_x - b5_y * floor(b5_x / b5_y); }',
  b5_mod3: 'fn b5_mod3(b5_x: vec3<f32>, b5_y: vec3<f32>) -> vec3<f32> { return b5_x - b5_y * floor(b5_x / b5_y); }',
};

/** Keywords and reserved words of WGSL that could plausibly appear as contract keys. */
const RESERVED = new Set([
  'alias', 'break', 'case', 'const', 'const_assert', 'continue', 'continuing', 'default', 'diagnostic',
  'discard', 'else', 'enable', 'false', 'fn', 'for', 'if', 'let', 'loop', 'override', 'requires', 'return',
  'struct', 'switch', 'true', 'var', 'while',
  'NULL', 'Self', 'abstract', 'active', 'alignas', 'alignof', 'as', 'asm', 'attribute', 'auto', 'await',
  'become', 'cast', 'catch', 'class', 'common', 'compile', 'concept', 'demote', 'do', 'enum', 'explicit',
  'export', 'extends', 'extern', 'external', 'filter', 'final', 'finally', 'friend', 'from', 'get', 'goto',
  'handle', 'highp', 'impl', 'implements', 'import', 'inline', 'instanceof', 'interface', 'layout', 'lowp',
  'macro', 'match', 'mediump', 'meta', 'mod', 'module', 'move', 'mut', 'mutable', 'namespace', 'new', 'nil',
  'null', 'of', 'operator', 'package', 'partition', 'pass', 'patch', 'precise', 'precision', 'priv',
  'protected', 'pub', 'public', 'readonly', 'ref', 'register', 'require', 'resource', 'restrict', 'self',
  'set', 'shared', 'signed', 'sizeof', 'smooth', 'static', 'std', 'super', 'target', 'template', 'this',
  'throw', 'trait', 'try', 'type', 'typedef', 'typeid', 'typename', 'typeof', 'union', 'unless', 'unsafe',
  'unsized', 'use', 'using', 'varying', 'virtual', 'volatile', 'wgsl', 'where', 'with', 'writeonly', 'yield',
]);

function checkMember(name: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || name.indexOf('__') >= 0 || RESERVED.has(name)) {
    throw new Error(`WGSL: '${name}' is not usable as a struct member name`);
  }
}

/** Format a number as a WGSL float literal (negative values parenthesised). */
export function wgslFloat(v: number): string {
  if (!Number.isFinite(v)) throw new Error(`WGSL: non-finite literal ${v}`);
  const a = Math.abs(v);
  let s = String(a);
  const e = s.indexOf('e');
  if (s.indexOf('.') < 0) s = e < 0 ? s + '.0' : s.slice(0, e) + '.0' + s.slice(e);
  return v < 0 || Object.is(v, -0) ? `(-${s})` : s;
}

function uniformWgslType(t: KernelSignature['uniforms'][string], arrays: ArrayLayout): string {
  if (typeof t === 'string') return WGSL_TYPE[t];
  return arrays === 'f32' ? `array<f32, ${t.length}>` : `array<vec4<f32>, ${Math.ceil(t.length / 4)}>`;
}

function structDecl(name: string, fields: [string, string][]): string {
  if (fields.length === 0) fields = [['b5_pad', 'f32']];
  return `struct ${name} {\n${fields.map(([n, t]) => `  ${n}: ${t},`).join('\n')}\n}`;
}

/* ─── layouts ────────────────────────────────────────────────────────────── */

export interface LayoutField { name: string; offset: number; size: number; align: number }

/** Byte layout of `TUniforms` per WGSL host-shareable rules. */
export function uniformLayout(sig: KernelSignature, arrays: ArrayLayout = 'f32'): { fields: LayoutField[]; size: number } {
  let off = 0, maxAlign = 4;
  const fields: LayoutField[] = [];
  for (const name of Object.keys(sig.uniforms)) {
    const t = sig.uniforms[name];
    let align: number, sz: number;
    if (typeof t === 'string') {
      align = t === 'f32' ? 4 : t === 'vec2' ? 8 : 16;
      sz = kTypeSize(t) * 4;
    } else if (arrays === 'f32') {
      align = 4; sz = 4 * t.length;
    } else {
      align = 16; sz = 16 * Math.ceil(t.length / 4);
    }
    off = Math.ceil(off / align) * align;
    fields.push({ name, offset: off, size: sz, align });
    off += sz;
    maxAlign = Math.max(maxAlign, align);
  }
  return { fields, size: Math.max(maxAlign, Math.ceil(off / maxAlign) * maxAlign) };
}

/** Float offsets of uniforms in the flat-param variant (tight packing, signature order). */
export function flatParamLayout(sig: KernelSignature): { name: string; offset: number; length: number }[] {
  let off = 0;
  const res: { name: string; offset: number; length: number }[] = [];
  for (const name of Object.keys(sig.uniforms)) {
    const t = sig.uniforms[name];
    const length = typeof t === 'string' ? kTypeSize(t) : t.length;
    res.push({ name, offset: off, length });
    off += length;
  }
  return res;
}

/** Pack uniform values into the flat-param array (zero-padded to `count`). */
export function packFlatParams(
  sig: KernelSignature, values: Record<string, number | readonly number[]>, count = FLAT_PARAMS_DEFAULT
): Float32Array {
  const out = new Float32Array(count);
  for (const f of flatParamLayout(sig)) {
    if (f.offset + f.length > count) throw new Error(`packFlatParams: ${sig.name} needs more than ${count} floats`);
    const v = values[f.name];
    if (v === undefined) throw new Error(`packFlatParams: missing ${f.name}`);
    const a = typeof v === 'number' ? [v] : v;
    if (a.length !== f.length) throw new Error(`packFlatParams: ${f.name} has ${a.length} components, expected ${f.length}`);
    for (let k = 0; k < f.length; k++) out[f.offset + k] = a[k];
  }
  return out;
}

/* ─── expression emission ────────────────────────────────────────────────── */

const SPLAT_OPS = new Set(['pow', 'min', 'max', 'step', 'clamp', 'smoothstep', 'mod']);

interface EmitResult { code: string; helpers: Set<string> }

function emitFunction(rec: Recorded, arrays: ArrayLayout): EmitResult {
  const helpers = new Set<string>();
  const outs = rec.outputs.map(o => o.expr);

  // use counts over the reachable DAG
  const uses = new Map<number, number>();
  const reach: RExpr[] = [];
  const seen = new Set<number>();
  const visit = (e: RExpr): void => {
    uses.set(e.id, (uses.get(e.id) ?? 0) + 1);
    if (seen.has(e.id)) return;
    seen.add(e.id);
    for (const a of e.args) visit(a);
    reach.push(e);
  };
  for (const o of outs) visit(o);

  const trivial = (e: RExpr): boolean =>
    e.op === 'const' || e.op === 'in' || (e.op === 'swz' && e.args[0].op === 'in');

  const names = new Map<number, string>();
  const lines: string[] = [];
  const text = new Map<number, string>();

  const splat = (e: RExpr, t: RType): string => {
    const s = ref(e);
    return e.type === 'f32' && t !== 'f32' ? `${WGSL_TYPE[t]}(${s})` : s;
  };
  const ref = (e: RExpr): string => names.get(e.id) ?? (text.get(e.id) as string);

  const build = (e: RExpr): string => {
    const A = (k: number): string => ref(e.args[k]);
    switch (e.op) {
      case 'const': return wgslFloat(e.value as number);
      case 'in': {
        const base = `b5_${e.src}.${e.name}`;
        if (e.index === undefined) return base;
        return arrays === 'f32' ? `${base}[${e.index}]` : `${base}[${e.index >> 2}].${'xyzw'[e.index & 3]}`;
      }
      case 'add': return `(${A(0)} + ${A(1)})`;
      case 'sub': return `(${A(0)} - ${A(1)})`;
      case 'mul': return `(${A(0)} * ${A(1)})`;
      case 'div': return `(${A(0)} / ${A(1)})`;
      case 'swz': return `${A(0)}.${e.comps}`;
      case 'vec2': case 'vec3': return `${WGSL_TYPE[e.type]}(${e.args.map(ref).join(', ')})`;
      case 'gt': return `(${A(0)} > ${A(1)})`;
      case 'lt': return `(${A(0)} < ${A(1)})`;
      case 'and': return `(${A(0)} && ${A(1)})`;
      case 'or': return `(${A(0)} || ${A(1)})`;
      case 'not': return `(!${A(0)})`;
      case 'select': return `select(${splat(e.args[2], e.type)}, ${splat(e.args[1], e.type)}, ${A(0)})`;
      case 'atan': return `atan2(${A(0)}, ${A(1)})`;
      case 'mix':
        // mix(vecN, vecN, f32) is a WGSL overload; splat a/b only
        return `mix(${splat(e.args[0], e.type)}, ${splat(e.args[1], e.type)}, ${A(2)})`;
      default: {
        let fn: string = e.op;
        if (e.op === 'mod') {
          fn = e.type === 'f32' ? 'b5_mod' : e.type === 'vec2' ? 'b5_mod2' : 'b5_mod3';
          helpers.add(fn);
        }
        const args = SPLAT_OPS.has(e.op) ? e.args.map(a => splat(a, e.type)) : e.args.map(ref);
        return `${fn}(${args.join(', ')})`;
      }
    }
  };

  let t = 0;
  for (const e of reach) {
    const s = build(e);
    if ((uses.get(e.id) ?? 0) > 1 && !trivial(e)) {
      const n = `b5_t${t++}`;
      const body = s.length > 2 && s[0] === '(' && s[s.length - 1] === ')' && balanced(s.slice(1, -1)) ? s.slice(1, -1) : s;
      lines.push(`  let ${n} = ${body};`);
      names.set(e.id, n);
    } else {
      text.set(e.id, s);
    }
  }

  // one named let per non-trivial output: readable code, cheap to debug
  rec.outputs.forEach(o => {
    if (names.has(o.expr.id) || trivial(o.expr)) return;
    const n = `b5_o_${o.name}`;
    const s = ref(o.expr);
    const body = s.length > 2 && s[0] === '(' && s[s.length - 1] === ')' && balanced(s.slice(1, -1)) ? s.slice(1, -1) : s;
    lines.push(`  let ${n} = ${body};`);
    names.set(o.expr.id, n);
  });

  const T = rec.typeName, f = rec.signature.name;
  const ret = `  return ${T}Out(${outs.map(ref).join(', ')});`;
  const code = `fn ${f}(b5_i: ${T}In, b5_u: ${T}Uniforms) -> ${T}Out {\n${lines.join('\n')}${lines.length ? '\n' : ''}${ret}\n}`;
  return { code, helpers };
}

/** True when parentheses in s are balanced at every prefix (so outer parens can be stripped). */
function balanced(s: string): boolean {
  let d = 0;
  for (const ch of s) {
    if (ch === '(') d++;
    else if (ch === ')') { d--; if (d < 0) return false; }
  }
  return d === 0;
}

function emitStructs(rec: Recorded, arrays: ArrayLayout): string {
  const sig = rec.signature, T = rec.typeName;
  const fin: [string, string][] = Object.keys(sig.inputs).map(n => { checkMember(n); return [n, WGSL_TYPE[sig.inputs[n]]]; });
  const fun: [string, string][] = Object.keys(sig.uniforms).map(n => { checkMember(n); return [n, uniformWgslType(sig.uniforms[n], arrays)]; });
  const fout: [string, string][] = Object.keys(sig.outputs).map(n => { checkMember(n); return [n, WGSL_TYPE[sig.outputs[n]]]; });
  return [structDecl(`${T}In`, fin), structDecl(`${T}Uniforms`, fun), structDecl(`${T}Out`, fout)].join('\n\n');
}

function emitFlat(rec: Recorded, arrays: ArrayLayout, count: number): string {
  const sig = rec.signature, T = rec.typeName;
  const P = (k: number): string => `b5_p[${k}]`;
  const layout = flatParamLayout(sig);
  const used = layout.length ? layout[layout.length - 1].offset + layout[layout.length - 1].length : 0;
  if (used > count) throw new Error(`${sig.name}: ${used} uniform floats do not fit ${count} flat params`);
  // member-wise assignment (zero-initialised var): readable, and arrays never
  // travel through a struct constructor
  const lines: string[] = [`  var b5_u: ${T}Uniforms;`];
  for (const fl of layout) {
    const t = sig.uniforms[fl.name];
    const items: string[] = [];
    for (let k = 0; k < fl.length; k++) items.push(P(fl.offset + k));
    if (typeof t === 'string') {
      lines.push(`  b5_u.${fl.name} = ${t === 'f32' ? items[0] : `${WGSL_TYPE[t]}(${items.join(', ')})`};`);
    } else {
      items.forEach((it, j) => lines.push(arrays === 'f32'
        ? `  b5_u.${fl.name}[${j}] = ${it};`
        : `  b5_u.${fl.name}[${j >> 2}].${'xyzw'[j & 3]} = ${it};`));
    }
  }
  return `fn ${sig.name}_flat(b5_i: ${T}In, b5_p: array<f32, ${count}>) -> ${T}Out {\n` +
    `${lines.join('\n')}\n  return ${sig.name}(b5_i, b5_u);\n}`;
}

function flatCount(flat: boolean | number | undefined): number {
  return typeof flat === 'number' ? flat : FLAT_PARAMS_DEFAULT;
}

/** Emit structs + function(s) for one kernel. */
export function emitWgsl<O>(kernel: Kernel<O>, options?: O, wopts: WgslOptions = {}): string {
  const arrays = wopts.arrays ?? 'f32';
  const rec = recordKernel(kernel, options);
  const fn = emitFunction(rec, arrays);
  const parts: string[] = [];
  if (wopts.helpers !== false) for (const h of [...fn.helpers].sort()) parts.push(HELPERS[h]);
  parts.push(emitStructs(rec, arrays), fn.code);
  if (wopts.flat) parts.push(emitFlat(rec, arrays, flatCount(wopts.flat)));
  return parts.join('\n\n') + '\n';
}

export interface KernelUse { kernel: Kernel<unknown>; options?: unknown }

/** One WGSL module with all requested kernels; helpers emitted once. */
export function emitWgslLibrary(kernels: readonly KernelUse[], wopts: WgslOptions = {}): string {
  const arrays = wopts.arrays ?? 'f32';
  const helpers = new Set<string>();
  const bodies: string[] = [];
  const names = new Set<string>();
  for (const use of kernels) {
    const rec = recordKernel(use.kernel, use.options);
    if (names.has(rec.signature.name) || names.has(rec.typeName)) {
      throw new Error(`emitWgslLibrary: duplicate kernel ${rec.signature.name}`);
    }
    names.add(rec.signature.name); names.add(rec.typeName);
    const fn = emitFunction(rec, arrays);
    for (const h of fn.helpers) helpers.add(h);
    bodies.push(`// ─── ${rec.signature.name} ───`, emitStructs(rec, arrays), fn.code);
    if (wopts.flat) bodies.push(emitFlat(rec, arrays, flatCount(wopts.flat)));
  }
  const head = '// Generated by core/shading/emit/wgsl.ts from core/shading/kernels — do not edit.';
  return [head, ...[...helpers].sort().map(h => HELPERS[h]), ...bodies].join('\n\n') + '\n';
}

/** WGSL type of a contract type (exported for bridges/tests). */
export function wgslType(t: KType): string { return WGSL_TYPE[t]; }
