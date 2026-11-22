/* ═══════════════════════════════════════════════════════════════════════════
   CPU evaluation of shading kernels (f64, GLSL/WGSL semantics).

   • cpuK          — a K whose nodes carry numbers; kernels run directly.
   • evaluateKernel — run a kernel on plain values (number | number[]).
   • evaluateRecorded — interpret a recorded DAG (emit/record.ts) with the same
     op semantics; tests use it to cross-check the recorder that feeds WGSL.

   Semantics: mod floored, step(edge, x) = x < edge ? 0 : 1,
   smoothstep(lo, hi, x) Hermite of clamp((x-lo)/(hi-lo)), mix(a,b,t) = a(1-t)+bt,
   atan(y, x) = atan2. Scalars broadcast against vectors elementwise.
   ═══════════════════════════════════════════════════════════════════════════ */

import type { K, KBool, KIn, KNode, Kernel, KUniformValue } from '../kernel.ts';
import { kTypeSize } from '../kernel.ts';
import type { RExpr, ROp, Recorded } from './record.ts';

/** A kernel value on the CPU: scalar or 2/3-component vector. */
export type CpuValue = number | readonly number[];
type V = readonly number[];

function bc(op: string, args: readonly V[], f: (...xs: number[]) => number): number[] {
  let n = 1;
  for (const a of args) {
    if (a.length === 1) continue;
    if (n !== 1 && a.length !== n) throw new Error(`${op}: size mismatch`);
    n = a.length;
  }
  const out: number[] = [];
  for (let k = 0; k < n; k++) out.push(f(...args.map(a => (a.length === 1 ? a[0] : a[k]))));
  return out;
}

function dotV(a: V, b: V): number {
  if (a.length !== b.length) throw new Error('dot: size mismatch');
  let s = 0;
  for (let k = 0; k < a.length; k++) s += a[k] * b[k];
  return s;
}

const smooth = (lo: number, hi: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};

/** Elementwise / vector op semantics shared by cpuK and evaluateRecorded. */
export const CPU_OPS: Partial<Record<ROp, (args: readonly V[]) => number[]>> = {
  add: a => bc('add', a, (x, y) => x + y),
  sub: a => bc('sub', a, (x, y) => x - y),
  mul: a => bc('mul', a, (x, y) => x * y),
  div: a => bc('div', a, (x, y) => x / y),
  sin: a => bc('sin', a, Math.sin),
  cos: a => bc('cos', a, Math.cos),
  exp: a => bc('exp', a, Math.exp),
  sqrt: a => bc('sqrt', a, Math.sqrt),
  abs: a => bc('abs', a, Math.abs),
  floor: a => bc('floor', a, Math.floor),
  fract: a => bc('fract', a, x => x - Math.floor(x)),
  pow: a => bc('pow', a, Math.pow),
  min: a => bc('min', a, Math.min),
  max: a => bc('max', a, Math.max),
  mod: a => bc('mod', a, (x, y) => x - y * Math.floor(x / y)),
  step: a => bc('step', a, (e, x) => (x < e ? 0 : 1)),
  atan: a => bc('atan', a, Math.atan2),
  clamp: a => bc('clamp', a, (x, lo, hi) => Math.min(Math.max(x, lo), hi)),
  mix: a => bc('mix', a, (x, y, t) => x * (1 - t) + y * t),
  smoothstep: a => bc('smoothstep', a, smooth),
  dot: a => [dotV(a[0], a[1])],
  length: a => [Math.sqrt(dotV(a[0], a[0]))],
  normalize: a => {
    const l = Math.sqrt(dotV(a[0], a[0]));
    return a[0].map(x => x / l);
  },
  reflect: a => {
    const d = 2 * dotV(a[1], a[0]);
    return a[0].map((x, k) => x - d * a[1][k]);
  },
};

function op(name: ROp, args: readonly V[]): number[] {
  const f = CPU_OPS[name];
  if (!f) throw new Error(`cpu: no op ${name}`);
  return f(args);
}

const SW = 'xyz';

class CpuNode implements KNode {
  readonly v: V;
  constructor(v: V) { this.v = v; }
  add(b: KIn): KNode { return new CpuNode(op('add', [this.v, val(b)])); }
  sub(b: KIn): KNode { return new CpuNode(op('sub', [this.v, val(b)])); }
  mul(b: KIn): KNode { return new CpuNode(op('mul', [this.v, val(b)])); }
  div(b: KIn): KNode { return new CpuNode(op('div', [this.v, val(b)])); }
  get x(): KNode { return this.sw('x'); }
  get y(): KNode { return this.sw('y'); }
  get z(): KNode { return this.sw('z'); }
  get xy(): KNode { return this.sw('xy'); }
  private sw(c: string): KNode {
    return new CpuNode(c.split('').map(ch => {
      const k = SW.indexOf(ch);
      if (k >= this.v.length) throw new Error(`swizzle .${c} on size ${this.v.length}`);
      return this.v[k];
    }));
  }
}

class CpuBool {
  readonly b: boolean;
  constructor(b: boolean) { this.b = b; }
}

const kb = (b: boolean): KBool => new CpuBool(b) as unknown as KBool;

function val(x: KIn): V {
  if (typeof x === 'number') return [x];
  if (x instanceof CpuNode) return x.v;
  throw new Error('foreign node passed to the CPU K');
}
function scalar(x: KIn): number {
  const v = val(x);
  if (v.length !== 1) throw new Error('scalar expected');
  return v[0];
}
function bool(x: KBool): boolean {
  const v: unknown = x;
  if (v instanceof CpuBool) return v.b;
  throw new Error('bool expected');
}
function construct(n: number, parts: readonly (KIn | undefined)[]): KNode {
  const given = parts.filter((p): p is KIn => p !== undefined).map(scalar);
  if (given.length === 1) return new CpuNode(new Array<number>(n).fill(given[0]));
  if (given.length !== n) throw new Error(`vec${n}: expected 1 or ${n} scalars`);
  return new CpuNode(given);
}
const f1 = (name: ROp) => (x: KIn): KNode => new CpuNode(op(name, [val(x)]));
const f2 = (name: ROp) => (a: KIn, b: KIn): KNode => new CpuNode(op(name, [val(a), val(b)]));
const f3 = (name: ROp) => (a: KIn, b: KIn, c: KIn): KNode => new CpuNode(op(name, [val(a), val(b), val(c)]));

/** K implementation evaluating numbers immediately. */
export const cpuK: K = {
  float: x => new CpuNode([scalar(x)]),
  vec2: (x, y) => construct(2, [x, y]),
  vec3: (x, y, z) => construct(3, [x, y, z]),
  sin: f1('sin'), cos: f1('cos'), exp: f1('exp'), sqrt: f1('sqrt'), abs: f1('abs'),
  floor: f1('floor'), fract: f1('fract'), normalize: f1('normalize'), length: f1('length'),
  pow: f2('pow'), min: f2('min'), max: f2('max'), mod: f2('mod'), step: f2('step'),
  dot: f2('dot'), atan: (y, x) => new CpuNode(op('atan', [[scalar(y)], [scalar(x)]])), reflect: f2('reflect'),
  clamp: f3('clamp'), mix: f3('mix'), smoothstep: f3('smoothstep'),
  select: (c, a, b) => {
    const va = val(a), vb = val(b);
    const n = Math.max(va.length, vb.length);
    const pick = bool(c) ? va : vb;
    return new CpuNode(pick.length === n ? pick : new Array<number>(n).fill(pick[0]));
  },
  greaterThan: (a, b) => kb(scalar(a) > scalar(b)),
  lessThan: (a, b) => kb(scalar(a) < scalar(b)),
  and: (a, b) => kb(bool(a) && bool(b)),
  or: (a, b) => kb(bool(a) || bool(b)),
  not: a => kb(!bool(a)),
};

export type CpuValues = Record<string, CpuValue>;

function unwrap(v: V): CpuValue {
  return v.length === 1 ? v[0] : v.slice();
}

function checkSize(what: string, v: CpuValue | undefined, n: number): V {
  if (v === undefined) throw new Error(`${what}: missing`);
  const a = typeof v === 'number' ? [v] : v;
  if (a.length !== n) throw new Error(`${what}: expected ${n} components, got ${a.length}`);
  return a;
}

/** Evaluate a kernel on the CPU. Array uniforms are number[] of their declared length. */
export function evaluateKernel<O>(kernel: Kernel<O>, inputs: CpuValues, uniforms: CpuValues, options?: O): CpuValues {
  const opts = options ?? kernel.defaults;
  const sig = kernel.signatureFor(opts);
  const ins: Record<string, KNode> = {};
  for (const name of Object.keys(sig.inputs)) {
    ins[name] = new CpuNode(checkSize(`input ${name}`, inputs[name], kTypeSize(sig.inputs[name])));
  }
  const us: Record<string, KUniformValue> = {};
  for (const name of Object.keys(sig.uniforms)) {
    const t = sig.uniforms[name];
    if (typeof t === 'string') {
      us[name] = new CpuNode(checkSize(`uniform ${name}`, uniforms[name], kTypeSize(t)));
    } else {
      us[name] = checkSize(`uniform ${name}`, uniforms[name], t.length).map(x => new CpuNode([x]));
    }
  }
  const out = kernel.build(opts)(cpuK, ins, us);
  const res: CpuValues = {};
  for (const name of Object.keys(sig.outputs)) {
    const v = out[name];
    if (v === undefined) throw new Error(`${sig.name}: missing output ${name}`);
    res[name] = unwrap(checkSize(`output ${name}`, unwrap(val(v)), kTypeSize(sig.outputs[name])));
  }
  return res;
}

/** Interpret a recorded DAG with the CPU semantics (cross-check of the recorder). */
export function evaluateRecorded(rec: Recorded, inputs: CpuValues, uniforms: CpuValues): CpuValues {
  const memo = new Map<number, V | boolean>();
  const ev = (e: RExpr): V | boolean => {
    const hit = memo.get(e.id);
    if (hit !== undefined) return hit;
    let r: V | boolean;
    const a = (k: number): V => ev(e.args[k]) as V;
    const b = (k: number): boolean => ev(e.args[k]) as boolean;
    switch (e.op) {
      case 'const': r = [e.value as number]; break;
      case 'in': {
        const src = e.src === 'i' ? inputs : uniforms;
        const v = src[e.name as string];
        if (v === undefined) throw new Error(`missing ${e.name}`);
        r = e.index !== undefined ? [(v as readonly number[])[e.index]] : (typeof v === 'number' ? [v] : v);
        break;
      }
      case 'swz': { const s = a(0); r = (e.comps as string).split('').map(c => s[SW.indexOf(c)]); break; }
      case 'vec2': case 'vec3': {
        const n = e.op === 'vec2' ? 2 : 3;
        r = e.args.length === 1 ? new Array<number>(n).fill(a(0)[0]) : e.args.map((_, k) => a(k)[0]);
        break;
      }
      case 'select': {
        const n = e.type === 'f32' ? 1 : e.type === 'vec2' ? 2 : 3;
        const p = b(0) ? a(1) : a(2);
        r = p.length === n ? p : new Array<number>(n).fill(p[0]);
        break;
      }
      case 'gt': r = a(0)[0] > a(1)[0]; break;
      case 'lt': r = a(0)[0] < a(1)[0]; break;
      case 'and': r = b(0) && b(1); break;
      case 'or': r = b(0) || b(1); break;
      case 'not': r = !b(0); break;
      default: r = op(e.op, e.args.map((_, k) => a(k)));
    }
    memo.set(e.id, r);
    return r;
  };
  const res: CpuValues = {};
  for (const o of rec.outputs) res[o.name] = unwrap(ev(o.expr) as V);
  return res;
}
