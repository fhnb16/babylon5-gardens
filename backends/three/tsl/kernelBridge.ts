/* ═══════════════════════════════════════════════════════════════════════════
   Kernel bridge: core/shading kernels on the REAL `three/tsl` module.

   K ⊆ three/tsl (proven by core/test/shading-tsl.test.ts), so the bridge is a
   type cast: `TSL as unknown as K`. This file only adds the plumbing that the
   backend needs around it:
     · runKernel(kernel, options, inputs, uniforms) — specialise and call a
       kernel with TSL nodes, get its outputs back as TSL nodes;
     · arrayUniform(values) — a uniformArray split into scalar element nodes
       (the K convention for array uniforms);
     · pulled(fn) — a float uniform that re-reads its value from `fn` once per
       render (the world keeps ONE set of plain uniform objects —
       materials/legacy.ts HullUniforms / WindUniforms — driven by
       adapt/palette.ts; node materials pull from them, so both material
       flavours are driven by the same code).
   ═══════════════════════════════════════════════════════════════════════════ */

import * as TSL from 'three/tsl';
import type { UniformNode } from 'three/webgpu';
import type { K, KNode, KUniformValue, Kernel } from '../../../core/shading/kernel.ts';

/** The whole bridge: the real module, typed as K. */
export const KT = TSL as unknown as K;

/** A TSL node as the backend sees it. Deliberately untyped: @types/three
    types TSL nodes by component type (Node<'vec3'> …) and the kernels'
    mixed float/vec graphs (proven by the node builders, see
    test/node-materials.test.ts) do not survive that typing. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TNode = any;

export const asK = (n: unknown): KNode => n as KNode;
export const asT = (n: unknown): TNode => n as TNode;

/** Specialise `kernel` with `options` and evaluate it on TSL nodes. */
export function runKernel<O>(
  kernel: Kernel<O>, options: O,
  inputs: Record<string, unknown>,
  uniforms: Record<string, unknown>
): Record<string, TNode> {
  const sig = kernel.signatureFor(options);
  for (const k of Object.keys(sig.inputs)) {
    if (!(k in inputs)) throw new Error(`${sig.name}: missing input '${k}'`);
  }
  const u: Record<string, KUniformValue> = {};
  for (const [k, v] of Object.entries(uniforms)) u[k] = (Array.isArray(v) ? v.map(asK) : asK(v)) as KUniformValue;
  const i: Record<string, KNode> = {};
  for (const [k, v] of Object.entries(inputs)) i[k] = asK(v);
  const out = kernel.build(options)(KT, i, u);
  const res: Record<string, TNode> = {};
  for (const k of Object.keys(sig.outputs)) {
    if (!out[k]) throw new Error(`${sig.name}: no output '${k}'`);
    res[k] = asT(out[k]);
  }
  return res;
}

/** A float uniform array split into element nodes (K array-uniform convention). */
export function arrayUniform(values: readonly number[]): TNode[] {
  const arr = TSL.uniformArray(values.slice(), 'float');
  return values.map((_, j) => asT(arr.element(j)));
}

/** Float uniform that re-reads `fn()` once per render. */
export function pulled(fn: () => number): UniformNode<'float', number> {
  const u = TSL.uniform(fn());
  u.onRenderUpdate(() => fn());
  return u as unknown as UniformNode<'float', number>;
}
