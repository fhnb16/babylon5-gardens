/* ═══════════════════════════════════════════════════════════════════════════
   Recording K — runs a kernel body against an AST builder.

   • Hash-consing: structurally identical sub-expressions are the same node
     (common-subexpression elimination for free).
   • Type inference + validation with WGSL rules in mind: binary arithmetic
     allows vector⊕scalar; built-ins that need equal types get their scalar
     arguments splatted by the emitter; comparisons are scalar-only.
   • Cheap simplifications only: swizzle-of-swizzle and swizzle-of-construct
     collapse; `float(x)` of a scalar is x.
   Consumers: emit/wgsl.ts (text), emit/cpu.ts (evaluateRecorded).
   ═══════════════════════════════════════════════════════════════════════════ */

import type { KernelSignature, KType } from '../contracts.ts';
import type { K, KBool, KIn, KNode, Kernel, KUniformValue } from '../kernel.ts';
import { kTypeSize } from '../kernel.ts';

export type RType = KType | 'bool';

export type ROp =
  | 'const' | 'in'
  | 'add' | 'sub' | 'mul' | 'div'
  | 'swz' | 'vec2' | 'vec3'
  | 'sin' | 'cos' | 'exp' | 'sqrt' | 'abs' | 'floor' | 'fract' | 'normalize' | 'length'
  | 'pow' | 'min' | 'max' | 'mod' | 'step' | 'dot' | 'atan' | 'reflect'
  | 'clamp' | 'mix' | 'smoothstep'
  | 'select' | 'gt' | 'lt' | 'and' | 'or' | 'not';

export interface RExpr {
  readonly id: number;
  readonly op: ROp;
  readonly args: readonly RExpr[];
  readonly type: RType;
  /** const */
  readonly value?: number;
  /** in: 'i' input / 'u' uniform */
  readonly src?: 'i' | 'u';
  readonly name?: string;
  /** in: element index of an array uniform */
  readonly index?: number;
  /** swz: component letters */
  readonly comps?: string;
}

const SIZE_TYPE: Record<number, KType> = { 1: 'f32', 2: 'vec2', 3: 'vec3' };
const COMP = 'xyz';

function size(t: RType): number {
  if (t === 'bool') throw new Error('bool used as a value');
  return kTypeSize(t);
}

/** Result type of an elementwise op: equal sizes, or scalars broadcast. */
function broadcastType(op: string, args: readonly RExpr[]): KType {
  let n = 1;
  for (const a of args) {
    const s = size(a.type);
    if (s === 1) continue;
    if (n !== 1 && s !== n) throw new Error(`${op}: mismatched types ${args.map(x => x.type).join(', ')}`);
    n = s;
  }
  return SIZE_TYPE[n];
}

class RNode implements KNode {
  readonly e: RExpr;
  readonly g: Graph;
  constructor(g: Graph, e: RExpr) { this.g = g; this.e = e; }
  add(b: KIn): KNode { return this.g.arith('add', this, b); }
  sub(b: KIn): KNode { return this.g.arith('sub', this, b); }
  mul(b: KIn): KNode { return this.g.arith('mul', this, b); }
  div(b: KIn): KNode { return this.g.arith('div', this, b); }
  get x(): KNode { return this.g.swizzle(this.e, 'x'); }
  get y(): KNode { return this.g.swizzle(this.e, 'y'); }
  get z(): KNode { return this.g.swizzle(this.e, 'z'); }
  get xy(): KNode { return this.g.swizzle(this.e, 'xy'); }
}

export class Graph {
  readonly nodes: RExpr[] = [];
  private readonly map = new Map<string, RExpr>();

  node(e: RExpr): RNode { return new RNode(this, e); }

  make(op: ROp, args: readonly RExpr[], type: RType, extra: Partial<RExpr> = {}): RExpr {
    const key = op + '|' + (extra.value !== undefined ? String(extra.value) : '') + '|' +
      (extra.src ?? '') + (extra.name ?? '') + '|' + (extra.index ?? '') + '|' + (extra.comps ?? '') + '|' +
      args.map(a => a.id).join(',');
    const hit = this.map.get(key);
    if (hit) return hit;
    const e: RExpr = { id: this.nodes.length, op, args, type, ...extra };
    this.nodes.push(e);
    this.map.set(key, e);
    return e;
  }

  expr(v: KIn | KBool): RExpr {
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new Error(`non-finite constant ${v}`);
      return this.make('const', [], 'f32', { value: v });
    }
    if (v instanceof RNode && v.g === this) return v.e;
    throw new Error('foreign node passed to the recording K');
  }

  value(v: KIn): RExpr {
    const e = this.expr(v);
    if (e.type === 'bool') throw new Error('bool used as a value');
    return e;
  }

  bool(v: KBool): RExpr {
    const e = this.expr(v);
    if (e.type !== 'bool') throw new Error('value used as a bool');
    return e;
  }

  arith(op: 'add' | 'sub' | 'mul' | 'div', a: KIn, b: KIn): KNode {
    const ea = this.value(a), eb = this.value(b);
    return this.node(this.make(op, [ea, eb], broadcastType(op, [ea, eb])));
  }

  swizzle(src: RExpr, comps: string): KNode {
    const n = size(src.type);
    for (const c of comps) {
      if (COMP.indexOf(c) < 0 || COMP.indexOf(c) >= n) throw new Error(`swizzle .${comps} on ${src.type}`);
    }
    if (n === 1 && comps === 'x') return this.node(src);
    // swizzle of swizzle → one swizzle
    if (src.op === 'swz') {
      const base = src.comps as string;
      const composed = comps.split('').map(c => base[COMP.indexOf(c)]).join('');
      return this.swizzle(src.args[0], composed);
    }
    // swizzle of a scalar-constructed (or splatted) vector → the scalars
    if (src.op === 'vec2' || src.op === 'vec3') {
      const picked = comps.split('').map(c => src.args[src.args.length > 1 ? COMP.indexOf(c) : 0]);
      if (picked.length === 1) return this.node(picked[0]);
      return this.node(this.make(picked.length === 2 ? 'vec2' : 'vec3', picked, SIZE_TYPE[picked.length]));
    }
    if (comps === COMP.slice(0, n)) return this.node(src);
    return this.node(this.make('swz', [src], SIZE_TYPE[comps.length], { comps }));
  }

  construct(op: 'vec2' | 'vec3', parts: readonly (KIn | undefined)[]): KNode {
    const n = op === 'vec2' ? 2 : 3;
    const given = parts.filter((p): p is KIn => p !== undefined).map(p => this.value(p));
    for (const g of given) if (g.type !== 'f32') throw new Error(`${op}: components must be scalars`);
    if (given.length !== 1 && given.length !== n) throw new Error(`${op}: expected 1 or ${n} scalars`);
    return this.node(this.make(op, given, SIZE_TYPE[n]));
  }

  call(op: ROp, args: readonly KIn[], kind: 'same' | 'scalar' | 'vecSame' | 'f32'): KNode {
    const es = args.map(a => this.value(a));
    let type: KType;
    switch (kind) {
      case 'same': type = broadcastType(op, es); break;
      case 'scalar':
        for (const e of es) if (e.type !== 'f32') throw new Error(`${op}: scalar arguments only`);
        type = 'f32'; break;
      case 'vecSame': {
        // dot / reflect / normalize / length: vectors of equal size
        const t = es[0].type as KType;
        for (const e of es) if (e.type !== t) throw new Error(`${op}: mismatched ${es.map(x => x.type).join(', ')}`);
        type = op === 'dot' || op === 'length' ? 'f32' : t; break;
      }
      default: type = 'f32';
    }
    return this.node(this.make(op, es, type));
  }

  cmp(op: 'gt' | 'lt', a: KIn, b: KIn): KBool {
    const ea = this.value(a), eb = this.value(b);
    if (ea.type !== 'f32' || eb.type !== 'f32') throw new Error(`${op}: scalar comparison only`);
    return this.node(this.make(op, [ea, eb], 'bool')) as unknown as KBool;
  }

  logic(op: 'and' | 'or' | 'not', args: readonly KBool[]): KBool {
    return this.node(this.make(op, args.map(a => this.bool(a)), 'bool')) as unknown as KBool;
  }

  select(c: KBool, a: KIn, b: KIn): KNode {
    const ec = this.bool(c), ea = this.value(a), eb = this.value(b);
    return this.node(this.make('select', [ec, ea, eb], broadcastType('select', [ea, eb])));
  }
}

/** A recording implementation of K bound to a graph. */
export function recordingK(g: Graph): K {
  return {
    float: x => {
      const e = g.value(x);
      if (e.type !== 'f32') throw new Error('float(): scalar argument only');
      return g.node(e);
    },
    vec2: (x, y) => g.construct('vec2', [x, y]),
    vec3: (x, y, z) => g.construct('vec3', [x, y, z]),
    sin: x => g.call('sin', [x], 'same'),
    cos: x => g.call('cos', [x], 'same'),
    exp: x => g.call('exp', [x], 'same'),
    sqrt: x => g.call('sqrt', [x], 'same'),
    abs: x => g.call('abs', [x], 'same'),
    floor: x => g.call('floor', [x], 'same'),
    fract: x => g.call('fract', [x], 'same'),
    normalize: x => g.call('normalize', [x], 'vecSame'),
    length: x => g.call('length', [x], 'vecSame'),
    pow: (x, y) => g.call('pow', [x, y], 'same'),
    min: (a, b) => g.call('min', [a, b], 'same'),
    max: (a, b) => g.call('max', [a, b], 'same'),
    mod: (a, b) => g.call('mod', [a, b], 'same'),
    step: (e, x) => g.call('step', [e, x], 'same'),
    dot: (a, b) => g.call('dot', [a, b], 'vecSame'),
    atan: (y, x) => g.call('atan', [y, x], 'scalar'),
    reflect: (i, n) => g.call('reflect', [i, n], 'vecSame'),
    clamp: (x, lo, hi) => g.call('clamp', [x, lo, hi], 'same'),
    mix: (a, b, t) => g.call('mix', [a, b, t], 'same'),
    smoothstep: (lo, hi, x) => g.call('smoothstep', [lo, hi, x], 'same'),
    select: (c, a, b) => g.select(c, a, b),
    greaterThan: (a, b) => g.cmp('gt', a, b),
    lessThan: (a, b) => g.cmp('lt', a, b),
    and: (a, b) => g.logic('and', [a, b]),
    or: (a, b) => g.logic('or', [a, b]),
    not: a => g.logic('not', [a]),
  };
}

export interface Recorded {
  readonly signature: KernelSignature;
  readonly typeName: string;
  readonly graph: Graph;
  /** output expressions in signature order */
  readonly outputs: readonly { name: string; type: KType; expr: RExpr }[];
}

/** Record a kernel specialised for `options` into an expression DAG. */
export function recordKernel<O>(kernel: Kernel<O>, options?: O): Recorded {
  const opts = options ?? kernel.defaults;
  const sig = kernel.signatureFor(opts);
  const g = new Graph();
  const K = recordingK(g);
  const inputs: Record<string, KNode> = {};
  for (const name of Object.keys(sig.inputs)) {
    inputs[name] = g.node(g.make('in', [], sig.inputs[name], { src: 'i', name }));
  }
  const uniforms: Record<string, KUniformValue> = {};
  for (const name of Object.keys(sig.uniforms)) {
    const t = sig.uniforms[name];
    if (typeof t === 'string') {
      uniforms[name] = g.node(g.make('in', [], t, { src: 'u', name }));
    } else {
      const list: KNode[] = [];
      for (let j = 0; j < t.length; j++) list.push(g.node(g.make('in', [], 'f32', { src: 'u', name, index: j })));
      uniforms[name] = list;
    }
  }
  const out = kernel.build(opts)(K, inputs, uniforms);
  const outputs: { name: string; type: KType; expr: RExpr }[] = [];
  for (const name of Object.keys(sig.outputs)) {
    const v = out[name];
    if (v === undefined) throw new Error(`${sig.name}: missing output ${name}`);
    const expr = g.value(v);
    if (expr.type !== sig.outputs[name]) {
      throw new Error(`${sig.name}: output ${name} is ${expr.type}, contract says ${sig.outputs[name]}`);
    }
    outputs.push({ name, type: sig.outputs[name], expr });
  }
  for (const name of Object.keys(out)) {
    if (!(name in sig.outputs)) throw new Error(`${sig.name}: output ${name} not in the contract`);
  }
  return { signature: sig, typeName: kernel.typeName, graph: g, outputs };
}
