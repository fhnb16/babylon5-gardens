/* K ⊆ three/tsl (r187): the shading kernels are built with the REAL TSL module
   as K — no adapter beyond a type cast — and compiled to WGSL and GLSL by
   three's own node builders in Node (no GPU).

   three is imported here only to prove the bridge; core/ never imports it.
   Shims needed to run the builders headless (test-only, not for the bridge):
   a stub canvas, renderer._bindings = undefined (normally set by init()),
   and builder.camera / builder.scene. */
import { describe, expect, test } from 'vitest';
import { REVISION } from 'three';
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { K_FUNCTIONS, K_NODE_MEMBERS } from '../shading/kernel.ts';
import type { K, KNode, KUniformValue, Kernel } from '../shading/kernel.ts';
import type { KType } from '../shading/contracts.ts';
import { hullSurface } from '../shading/kernels/hull.ts';
import { hullMirror } from '../shading/kernels/hullMirror.ts';
import { windOffset } from '../shading/kernels/wind.ts';
import { fogFade } from '../shading/kernels/fogfade.ts';
import { foliageDither } from '../shading/kernels/foliageDither.ts';

const R187 = Number(REVISION) >= 187;
const tsl = TSL as unknown as Record<string, unknown>;
/** The whole bridge: the real module, typed as K. */
const KT = TSL as unknown as K;

type TslNode = KNode & { isNode: boolean; getNodeType(builder: unknown): string };

function tslArgs(kernel: Kernel<unknown>, options: unknown) {
  const sig = kernel.signatureFor(options ?? kernel.defaults);
  const mk = (t: KType): KNode => (t === 'f32'
    ? TSL.uniform(0.5)
    : t === 'vec2' ? TSL.uniform(new THREE.Vector2(0.3, 0.7)) : TSL.uniform(new THREE.Vector3(0.1, 0.2, 0.3))) as unknown as KNode;
  const inputs: Record<string, KNode> = {};
  for (const [k, t] of Object.entries(sig.inputs)) inputs[k] = mk(t);
  const uniforms: Record<string, KUniformValue> = {};
  for (const [k, t] of Object.entries(sig.uniforms)) {
    if (typeof t === 'string') { uniforms[k] = mk(t); continue; }
    const arr = TSL.uniformArray(new Array<number>(t.length).fill(0.25), 'float');
    uniforms[k] = Array.from({ length: t.length }, (_, j) => arr.element(j) as unknown as KNode);
  }
  return { sig, inputs, uniforms };
}

const CASES: [string, Kernel<unknown>, unknown][] = [
  ['hull raster', hullSurface as Kernel<unknown>, { raster: true, nArm: 3, nSpar: 4 }],
  ['hull tracer', hullSurface as Kernel<unknown>, { raster: false, nArm: 3, nSpar: 4 }],
  ['hull mirror', hullMirror as Kernel<unknown>, undefined],
  ['wind', windOffset as Kernel<unknown>, undefined],
  ['fog fade', fogFade as Kernel<unknown>, undefined],
  ['foliage dither', foliageDither as Kernel<unknown>, undefined],
];

const TSL_TYPE: Record<KType, string> = { f32: 'float', vec2: 'vec2', vec3: 'vec3' };

/** Compile all outputs of a kernel with three's WGSL or GLSL node builder; returns the fragment code. */
function compile(kernel: Kernel<unknown>, options: unknown, glsl: boolean): { code: string; types: Record<string, string> } {
  const { sig, inputs, uniforms } = tslArgs(kernel, options);
  const out = kernel.build(options ?? kernel.defaults)(KT, inputs, uniforms) as Record<string, TslNode>;
  // fold every output into one float so all of them are reachable from the material
  let total: KNode = KT.float(0);
  for (const [k, t] of Object.entries(sig.outputs)) {
    const n = out[k];
    total = total.add(t === 'f32' ? n : t === 'vec2' ? n.x.add(n.y) : n.x.add(n.y).add(n.z));
  }
  const canvas = {
    style: {}, width: 1, height: 1,
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, getContext() { return null; },
  };
  const renderer = new THREE.WebGPURenderer({ forceWebGL: glsl, canvas: canvas as unknown as HTMLCanvasElement });
  (renderer as unknown as { _bindings: unknown })._bindings = undefined;
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.colorNode = TSL.vec4(TSL.vec3(total as never), 1);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(), mat);
  const Builder = (THREE as unknown as Record<string, new (o: unknown, r: unknown) => {
    material: unknown; camera: unknown; scene: unknown; fragmentShader: string; build(): void;
  }>)[glsl ? 'GLSLNodeBuilder' : 'WGSLNodeBuilder'];
  const builder = new Builder(mesh, renderer);
  builder.material = mat;
  builder.camera = new THREE.PerspectiveCamera();
  builder.scene = new THREE.Scene();
  builder.build();
  const types: Record<string, string> = {};
  for (const k of Object.keys(sig.outputs)) types[k] = out[k].getNodeType(builder);
  return { code: builder.fragmentShader, types };
}

describe.skipIf(!R187)('K ⊆ three/tsl r' + REVISION, () => {
  test('every K function is a three/tsl export; nodes carry every K member', () => {
    for (const f of K_FUNCTIONS) expect(typeof tsl[f], f).toBe('function');
    const v = TSL.vec3(1, 2, 3) as unknown as Record<string, unknown>;
    for (const m of K_NODE_MEMBERS) expect(v[m], m).toBeDefined();
    // r187: atan2 is gone — two-argument atan(y, x) replaces it
    expect(tsl.atan2).toBeUndefined();
  });

  test.each(CASES)('%s: graph builds on the real TSL module', (_label, kernel, options) => {
    const { sig, inputs, uniforms } = tslArgs(kernel, options);
    const out = kernel.build(options ?? kernel.defaults)(KT, inputs, uniforms) as Record<string, TslNode>;
    for (const k of Object.keys(sig.outputs)) expect(out[k]?.isNode, k).toBe(true);
  });

  test.each(CASES)('%s: compiles with WGSLNodeBuilder and GLSLNodeBuilder (headless)', (_label, kernel, options) => {
    const sig = kernel.signatureFor(options ?? kernel.defaults);
    for (const glsl of [false, true]) {
      const { code, types } = compile(kernel, options, glsl);
      expect(code.length).toBeGreaterThan(100);
      for (const [k, t] of Object.entries(sig.outputs)) expect(types[k], k).toBe(TSL_TYPE[t]);
    }
  });

  test('semantics of the lowered code: floored mod, atan(y, x), select', () => {
    const hw = compile(hullSurface as Kernel<unknown>, { raster: true, nArm: 3, nSpar: 4 }, false).code;
    const hg = compile(hullSurface as Kernel<unknown>, { raster: true, nArm: 3, nSpar: 4 }, true).code;
    // float % → floored polyfill in WGSL, GLSL mod() in WebGL2 (never WGSL `%`)
    expect(hw).toContain('fn tsl_mod_float( x : f32, y : f32 ) -> f32 { return x - y * floor( x / y ); }');
    expect(hg).toMatch(/\bmod\(/);
    const mw = compile(hullMirror as Kernel<unknown>, undefined, false).code;
    const mg = compile(hullMirror as Kernel<unknown>, undefined, true).code;
    expect(mw).toMatch(/\batan2\(/);
    expect(mg).toMatch(/\batan\([^()]*,/);
  });
});
