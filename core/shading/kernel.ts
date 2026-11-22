/* ═══════════════════════════════════════════════════════════════════════════
   K — the TSL-compatible subset that shading kernels are written against.

   A kernel is a plain function (K, inputs, uniforms) => outputs. It builds an
   expression graph using ONLY what is declared here, so the very same kernel
   source can be run against:
     • the real `three/tsl` module (raster, WebGPU + WebGL2)      — wave 3 bridge
     • the AST recorder in core/shading/emit/record.ts → WGSL    — PT / ThreeRT
     • the CPU evaluator in core/shading/emit/cpu.ts             — tests

   Design rules (keep K ⊆ three/tsl r187):
   • Every name on K is an export of `three/tsl` with the same argument order
     and semantics. Node methods (.add/.sub/.mul/.div, swizzles) exist on every
     TSL node object.
   • atan is the 2-argument form atan(y, x) (TSL r172+ renamed atan2 → atan;
     GLSL atan(y, x); WGSL atan2(y, x)). Argument order is (y, x).
   • mod is FLOORED (GLSL semantics): x - y * floor(x / y).
   • select(cond, ifTrue, ifFalse) — TSL order. WGSL's select(f, t, c) order is
     handled by the emitter.
   • No control flow on K: loops over compile-time constant counts are plain JS
     (see `unroll`), branches are `select`. Both sides of a select are
     evaluated on every backend (no early-out).
   • Uniform arrays are passed as JS arrays of scalar nodes and indexed with JS
     integer constants (TSL bridge: uniformArray(...).element(i)).
   ═══════════════════════════════════════════════════════════════════════════ */

import type { KernelSignature, KType } from './contracts.ts';

/** An operand: a node or a JS number (promoted to a float constant). */
export type KIn = KNode | number;

/** Value node (f32, vec2 or vec3). Mirrors the TSL ShaderNodeObject surface we use. */
export interface KNode {
  add(b: KIn): KNode;
  sub(b: KIn): KNode;
  mul(b: KIn): KNode;
  div(b: KIn): KNode;
  readonly x: KNode;
  readonly y: KNode;
  readonly z: KNode;
  readonly xy: KNode;
}

declare const kBoolBrand: unique symbol;

/** Boolean node (result of comparisons). Opaque brand: only usable in select/and/or/not;
    implementations produce it with a cast. */
export interface KBool {
  readonly [kBoolBrand]: true;
}

/** The kernel vocabulary. Each member is a `three/tsl` export of the same name. */
export interface K {
  float(x: KIn): KNode;
  /** vec2(s) splats; vec2(x, y) constructs from scalars */
  vec2(x: KIn, y?: KIn): KNode;
  /** vec3(s) splats; vec3(x, y, z) constructs from scalars */
  vec3(x: KIn, y?: KIn, z?: KIn): KNode;

  sin(x: KIn): KNode;
  cos(x: KIn): KNode;
  exp(x: KIn): KNode;
  sqrt(x: KIn): KNode;
  abs(x: KIn): KNode;
  floor(x: KIn): KNode;
  fract(x: KIn): KNode;
  normalize(x: KIn): KNode;
  length(x: KIn): KNode;

  pow(x: KIn, y: KIn): KNode;
  min(a: KIn, b: KIn): KNode;
  max(a: KIn, b: KIn): KNode;
  /** floored modulo, GLSL semantics */
  mod(x: KIn, y: KIn): KNode;
  /** GLSL order: step(edge, x) = x < edge ? 0 : 1 */
  step(edge: KIn, x: KIn): KNode;
  dot(a: KIn, b: KIn): KNode;
  /** two-argument arctangent, argument order (y, x) */
  atan(y: KIn, x: KIn): KNode;
  /** reflect(I, N) = I - 2 dot(N, I) N */
  reflect(i: KIn, n: KIn): KNode;

  clamp(x: KIn, lo: KIn, hi: KIn): KNode;
  /** mix(a, b, t) = a (1 - t) + b t */
  mix(a: KIn, b: KIn, t: KIn): KNode;
  /** GLSL order: smoothstep(low, high, x). Kernels keep low < high
      (WGSL leaves low >= high implementation-defined). */
  smoothstep(lo: KIn, hi: KIn, x: KIn): KNode;

  /** TSL order: select(cond, ifTrue, ifFalse) */
  select(cond: KBool, a: KIn, b: KIn): KNode;
  /** scalar comparisons */
  greaterThan(a: KIn, b: KIn): KBool;
  lessThan(a: KIn, b: KIn): KBool;
  and(a: KBool, b: KBool): KBool;
  or(a: KBool, b: KBool): KBool;
  not(a: KBool): KBool;
}

/** Names of all K members — used by bridges/tests to check a K implementation. */
export const K_FUNCTIONS: readonly (keyof K)[] = [
  'float', 'vec2', 'vec3',
  'sin', 'cos', 'exp', 'sqrt', 'abs', 'floor', 'fract', 'normalize', 'length',
  'pow', 'min', 'max', 'mod', 'step', 'dot', 'atan', 'reflect',
  'clamp', 'mix', 'smoothstep',
  'select', 'greaterThan', 'lessThan', 'and', 'or', 'not'
];

/** Names of all node methods/properties a K node must have. */
export const K_NODE_MEMBERS: readonly (keyof KNode)[] = ['add', 'sub', 'mul', 'div', 'x', 'y', 'z', 'xy'];

/* ─── kernel definition ──────────────────────────────────────────────────── */

/** A uniform value seen by a kernel body: a node, or (for array uniforms) a list of scalar nodes. */
export type KUniformValue = KNode | readonly KNode[];
export type KInputs = Readonly<Record<string, KNode>>;
export type KUniforms = Readonly<Record<string, KUniformValue>>;
export type KOutputs = Record<string, KNode>;

export type KernelBody = (k: K, inputs: KInputs, uniforms: KUniforms) => KOutputs;

/** Options type for kernels without compile-time options. */
export type NoOptions = Readonly<Record<string, never>>;

export interface Kernel<O> {
  /** signature as declared in contracts (array lengths may be overridden per options) */
  readonly signature: KernelSignature;
  /** WGSL type-name stem: structs are `${typeName}In`, `${typeName}Uniforms`, `${typeName}Out` */
  readonly typeName: string;
  readonly defaults: O;
  /** the signature with array-uniform lengths resolved for these options */
  signatureFor(options: O): KernelSignature;
  /** compile-time specialisation → kernel body */
  build(options: O): KernelBody;
}

export interface KernelExtras<O> {
  defaults: O;
  /** WGSL struct stem; default: PascalCase of the function name (b5_fog_fade → B5FogFade) */
  typeName?: string;
  /** array-uniform lengths that depend on options (e.g. nArm / nSpar) */
  arrayLengths?: (options: O) => Record<string, number>;
}

function pascalStem(name: string): string {
  return name.split('_').filter(s => s.length > 0)
    .map(s => s[0].toUpperCase() + s.slice(1)).join('');
}

/**
 * Define a kernel: `defineKernel(SIGNATURE, options => (K, inputs, uniforms) => outputs, extras)`.
 * The factory specialises on compile-time options (raster flag, loop counts).
 */
export function defineKernel<O>(
  signature: KernelSignature,
  factory: (options: O) => KernelBody,
  extras: KernelExtras<O>
): Kernel<O> {
  const typeName = extras.typeName ?? pascalStem(signature.name);
  return {
    signature,
    typeName,
    defaults: extras.defaults,
    signatureFor(options: O): KernelSignature {
      if (!extras.arrayLengths) return signature;
      const lens = extras.arrayLengths(options);
      const uniforms: KernelSignature['uniforms'] = {};
      for (const name of Object.keys(signature.uniforms)) {
        const t = signature.uniforms[name];
        if (typeof t !== 'string' && lens[name] !== undefined) {
          uniforms[name] = { array: 'f32', length: lens[name] };
        } else {
          uniforms[name] = t;
        }
      }
      return { name: signature.name, inputs: signature.inputs, uniforms, outputs: signature.outputs };
    },
    build: factory
  };
}

/* ─── helpers usable inside kernel bodies ────────────────────────────────── */

/**
 * Compile-time loop: fold `body` over i = 0..count-1. Plain JS, so every
 * backend sees an unrolled graph (TSL included). `count` must be a
 * non-negative integer known when the kernel is built.
 */
export function unroll<T>(count: number, init: T, body: (acc: T, i: number) => T): T {
  if (!(Number.isInteger(count) && count >= 0)) throw new Error(`unroll: bad count ${count}`);
  let acc = init;
  for (let i = 0; i < count; i++) acc = body(acc, i);
  return acc;
}

/** Narrow a uniform to a single node (throws for arrays / missing). */
export function one(u: KUniforms, name: string): KNode {
  const v = u[name];
  if (v === undefined || Array.isArray(v)) throw new Error(`uniform ${name}: expected a node`);
  return v as KNode;
}

/** Narrow a uniform to an array of scalar nodes (throws for non-arrays / missing). */
export function many(u: KUniforms, name: string): readonly KNode[] {
  const v = u[name];
  if (v === undefined || !Array.isArray(v)) throw new Error(`uniform ${name}: expected an array`);
  return v as readonly KNode[];
}

/** Narrow an input (throws if missing). */
export function input(i: KInputs, name: string): KNode {
  const v = i[name];
  if (v === undefined) throw new Error(`input ${name}: missing`);
  return v;
}

/** Number of components of a contract type. */
export function kTypeSize(t: KType): number {
  return t === 'f32' ? 1 : t === 'vec2' ? 2 : 3;
}
