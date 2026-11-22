/* ═══════════════════════════════════════════════════════════════════════════
   Seam between the path tracer and three r187 WebGPURenderer (wave 3), plus
   a standalone presenter for pages that run the path tracer without three.

   Plan (docs/ROADMAP.md §2.8):
     1. pt = await createDevice({ forThree: true })            (device.ts)
        renderer = new WebGPURenderer({ device: pt.device }); await renderer.init()
     2. hdr = new StorageTexture(w, h); hdr.type = HalfFloatType (rgba16float,
        AOV_FORMATS.color); renderer.initTexture(hdr)
     3. gpuTex = threeStorageTextureToGPU(renderer, hdr, { revision: THREE.REVISION,
        device: pt.device, format: AOV_FORMATS.color })
        → the PT kernels write gpuTex; three samples `hdr` in its RenderPipeline
          (pipeline.compositeExternal(hdrNode, exposure)).
   `renderer.backend.get(texture).texture` is three's INTERNAL backend data
   map — the only internal API we use. It is pinned to r187 and verified at
   runtime (revision, WebGPU backend, same device, instanceof GPUTexture,
   size, format, STORAGE_BINDING usage), so an upgrade fails loudly here
   instead of rendering garbage.

   Alternative seam, also public in r187: three's ExternalTexture wraps a
   GPUTexture we create (WebGPUTextureUtils: `texture.isExternalTexture` →
   `textureData.texture = texture.sourceTexture`). Kept in reserve; the
   StorageTexture route lets three own the lifetime and resize logic.

   This module does not import three (the caller passes its objects in), so
   the path tracer stays usable and testable without it.
   ═══════════════════════════════════════════════════════════════════════════ */

import { BUFFER, STAGE, TEXTURE } from './gpu-flags.ts';

export const THREE_PINNED_REVISION = '187';

export class ThreeInteropError extends Error {
  constructor(message: string) {
    super(`[pt/three-interop] ${message}`);
    this.name = 'ThreeInteropError';
  }
}

/** The parts of three's WebGPURenderer / WebGPUBackend this seam touches. */
export interface ThreeRendererLike {
  backend?: {
    isWebGPUBackend?: boolean;
    device?: GPUDevice | null;
    get?(object: object): Record<string, unknown> | undefined;
  } | null;
}

export interface ThreeTextureLike {
  isStorageTexture?: boolean;
  image?: { width?: number; height?: number } | null;
}

export interface GpuTextureExpect {
  width?: number;
  height?: number;
  format?: GPUTextureFormat;
  /** GPUTextureUsage bits that must be present */
  usage?: number;
}

/** Self-test of a texture handed across the seam; returns it typed. */
export function verifyGpuTexture(tex: unknown, expect: GpuTextureExpect, what = 'texture'): GPUTexture {
  if (typeof GPUTexture !== 'undefined') {
    if (!(tex instanceof GPUTexture)) throw new ThreeInteropError(`${what} is not a GPUTexture (got ${describe(tex)})`);
  } else if (!tex || typeof (tex as GPUTexture).createView !== 'function') {
    throw new ThreeInteropError(`${what} is not a GPUTexture-like object (got ${describe(tex)})`);
  }
  const t = tex as GPUTexture;
  const errs: string[] = [];
  if (expect.width !== undefined && t.width !== expect.width) errs.push(`width ${t.width} ≠ ${expect.width}`);
  if (expect.height !== undefined && t.height !== expect.height) errs.push(`height ${t.height} ≠ ${expect.height}`);
  if (expect.format !== undefined && t.format !== expect.format) errs.push(`format ${t.format} ≠ ${expect.format}`);
  if (expect.usage !== undefined && (t.usage & expect.usage) !== expect.usage) {
    errs.push(`usage 0x${t.usage.toString(16)} lacks 0x${(expect.usage & ~t.usage).toString(16)}`);
  }
  if (errs.length) throw new ThreeInteropError(`${what}: ${errs.join(', ')}`);
  return t;
}

function describe(x: unknown): string {
  if (x === null || x === undefined) return String(x);
  if (typeof x !== 'object') return typeof x;
  return (x as object).constructor?.name ?? 'object';
}

function webgpuBackend(renderer: ThreeRendererLike, revision: string) {
  if (revision !== THREE_PINNED_REVISION) {
    throw new ThreeInteropError(`three r${revision} is not supported: the seam is pinned to r${THREE_PINNED_REVISION} ` +
      '(re-verify renderer.backend.get(texture).texture and update THREE_PINNED_REVISION)');
  }
  const backend = renderer?.backend;
  if (!backend || backend.isWebGPUBackend !== true) {
    throw new ThreeInteropError('renderer is not a WebGPURenderer on the WebGPU backend (WebGL2 fallback active, or not a WebGPURenderer)');
  }
  if (!backend.device) throw new ThreeInteropError('renderer.backend.device is null: await renderer.init() first');
  if (typeof backend.get !== 'function') throw new ThreeInteropError('renderer.backend.get() is missing (three internals changed)');
  return backend as Required<NonNullable<ThreeRendererLike['backend']>> & { device: GPUDevice };
}

/** The GPUDevice three renders with (to adoptDevice() it, or to check it is ours). */
export function threeDevice(renderer: ThreeRendererLike, opts: { revision: string }): GPUDevice {
  return webgpuBackend(renderer, opts.revision).device;
}

export interface ThreeTextureOptions {
  /** THREE.REVISION of the running three */
  revision: string;
  /** our device: the texture must belong to it */
  device?: GPUDevice;
  /** expected format, e.g. AOV_FORMATS.color ('rgba16float') */
  format?: GPUTextureFormat;
}

/** GPUTexture behind a three StorageTexture (pinned three-internal access, verified). */
export function threeStorageTextureToGPU(
  renderer: ThreeRendererLike, texture: ThreeTextureLike, opts: ThreeTextureOptions
): GPUTexture {
  const backend = webgpuBackend(renderer, opts.revision);
  if (!texture || texture.isStorageTexture !== true) throw new ThreeInteropError('texture is not a THREE.StorageTexture');
  if (opts.device && backend.device !== opts.device) {
    throw new ThreeInteropError('three renders on a different GPUDevice: create the renderer with { device: pt.device }');
  }
  const data = backend.get(texture as object);
  const gpuTex = data?.texture;
  if (!gpuTex) {
    throw new ThreeInteropError('the StorageTexture has no GPU texture yet: call renderer.initTexture(texture) after await renderer.init()');
  }
  return verifyGpuTexture(gpuTex, {
    width: texture.image?.width ?? undefined,
    height: texture.image?.height ?? undefined,
    format: opts.format,
    usage: TEXTURE.STORAGE_BINDING
  }, 'renderer.backend.get(storageTexture).texture');
}

/* ─── standalone presenter ────────────────────────────────────────────────── */

const PRESENT_WGSL = /* wgsl */ `
struct B5PresentParams {
  exposure: f32,
  mode: u32,      // 0 = ACES fitted tonemap, 1 = linear clamp, 2 = three r187 ACESFilmicToneMapping
  canvas: vec2f,
}

// three.js ACESFilmicToneMapping (tonemapping_pars_fragment, r187): RRT+ODT fit
// with the sRGB → AP1 matrices and the 1/0.6 exposure pre-scale
fn b5_rrt_odt(v: vec3f) -> vec3f {
  let a = v * (v + 0.0245786) - 0.000090537;
  let b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
fn b5_aces_three(c: vec3f) -> vec3f {
  let inM = mat3x3f(vec3f(0.59719, 0.07600, 0.02840), vec3f(0.35458, 0.90834, 0.13383), vec3f(0.04823, 0.01566, 0.83777));
  let outM = mat3x3f(vec3f(1.60475, -0.10208, -0.00327), vec3f(-0.53108, 1.10813, -0.07276), vec3f(-0.07367, -0.00605, 1.07602));
  return clamp(outM * b5_rrt_odt(inM * (c / 0.6)), vec3f(0.0), vec3f(1.0));
}
@group(0) @binding(0) var b5_src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> b5_pp: B5PresentParams;

@vertex
fn b5_vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

// Narkowicz 2015 ACES filmic fit
fn b5_aces(x: vec3f) -> vec3f {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}

fn b5_srgb_oetf(c: vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = 1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}

@fragment
fn b5_fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let dims = textureDimensions(b5_src);
  let uv = pos.xy / b5_pp.canvas;
  let px = min(vec2u(uv * vec2f(dims)), dims - vec2u(1u));
  let hdr = max(textureLoad(b5_src, px, 0).rgb * b5_pp.exposure, vec3f(0.0));
  var c = clamp(hdr, vec3f(0.0), vec3f(1.0));
  if (b5_pp.mode == 0u) {
    c = b5_aces(hdr);
  } else if (b5_pp.mode == 2u) {
    c = b5_aces_three(hdr);
  }
  return vec4f(b5_srgb_oetf(c), 1.0);
}
`;

export interface PresentOptions {
  /** linear multiplier before the tonemap (default 1) */
  exposure?: number;
  /** 'aces' (default, Narkowicz fit), 'aces-three' (three r187 ACESFilmicToneMapping — compare with the raster)
      or 'linear' (clamp, for debug images) */
  mode?: 'aces' | 'linear' | 'aces-three';
}

export interface Presenter {
  /** canvas format (non-sRGB; the shader encodes sRGB itself) */
  format: GPUTextureFormat;
  /** blit an rgba16float / rgba32float (unfilterable-float) texture to the canvas */
  present(src: GPUTexture, opts?: PresentOptions): void;
  destroy(): void;
}

/** Full-screen blit with a simple tonemap onto a canvas (standalone pages, no three). */
export function createPresenter(device: GPUDevice, canvas: HTMLCanvasElement | OffscreenCanvas, gpu?: GPU): Presenter {
  const g = gpu ?? navigator.gpu;
  const ctx = canvas.getContext('webgpu') as GPUCanvasContext | null;
  if (!ctx) throw new ThreeInteropError('canvas.getContext("webgpu") returned null');
  const format = g.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: 'opaque' });
  const module = device.createShaderModule({ label: 'b5 present', code: PRESENT_WGSL });
  const bgl = device.createBindGroupLayout({
    label: 'b5 present',
    entries: [
      { binding: 0, visibility: STAGE.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
      { binding: 1, visibility: STAGE.FRAGMENT, buffer: { type: 'uniform' } }
    ]
  });
  const pipeline = device.createRenderPipeline({
    label: 'b5 present',
    layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
    vertex: { module, entryPoint: 'b5_vs' },
    fragment: { module, entryPoint: 'b5_fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' }
  });
  const ubo = device.createBuffer({ label: 'b5 present params', size: 16, usage: BUFFER.UNIFORM | BUFFER.COPY_DST });
  let cachedSrc: GPUTexture | null = null;
  let cachedBg: GPUBindGroup | null = null;
  return {
    format,
    present(src, opts = {}) {
      if (src !== cachedSrc) {
        cachedSrc = src;
        cachedBg = device.createBindGroup({
          layout: bgl,
          entries: [{ binding: 0, resource: src.createView() }, { binding: 1, resource: { buffer: ubo } }]
        });
      }
      const p = new ArrayBuffer(16);
      new Float32Array(p, 0, 1)[0] = opts.exposure ?? 1;
      new Uint32Array(p, 4, 1)[0] = opts.mode === 'linear' ? 1 : opts.mode === 'aces-three' ? 2 : 0;
      new Float32Array(p, 8, 2).set([canvas.width, canvas.height]);
      device.queue.writeBuffer(ubo, 0, p);
      const enc = device.createCommandEncoder({ label: 'b5 present' });
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }]
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, cachedBg!);
      pass.draw(3);
      pass.end();
      device.queue.submit([enc.finish()]);
    },
    destroy() {
      ubo.destroy();
      ctx.unconfigure();
    }
  };
}
