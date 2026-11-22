/* ═══════════════════════════════════════════════════════════════════════════
   Open Image Denoise on WebGPU — optional, lazy (PT-P4 research result).

   Package: `oidn-webgpu` (npm, MIT, by pissang; 0.6.0 at the time of
   writing). It is the renamed `oidn-web` (≤ 0.5.0, now DEPRECATED on npm with
   "renamed to oidn-webgpu"). Since 0.4 it no longer uses tfjs: the OIDN
   U-Net runs as its own WGSL kernels on a GPUDevice the caller passes in
   (`initUNetFromURL(url, { device }, opts)`), inputs may be GPUTextures
   (textureLoad, any float-sampled format — our rgba16float colour, rgba8
   albedo, rgba16float normal), output is a GPUBuffer of vec4f.
   Only runtime dependency: @petamoriken/float16.
   Weights are NOT in the npm package: the `.tza` files (Apache-2.0, from
   RenderKit/oidn-weights, also in the GitHub repo's weights/) must be served
   by the app; for us `rt_hdr_alb_nrm.tza` (HDR colour + albedo + normal),
   or `rt_hdr_alb_nrm_small.tza` for speed.

   This module does NOT import the package (it is not a dependency yet and
   the lead adds dependencies): the caller injects the loader, e.g.
     createOidnDenoiser(device, { load: () => import('oidn-webgpu'), weightsUrl })
   so nothing is fetched until the user presses "clean".
   ═══════════════════════════════════════════════════════════════════════════ */

import { STAGE, TEXTURE } from './gpu-flags.ts';

export const OIDN_PACKAGE = { name: 'oidn-webgpu', version: '0.6.0', license: 'MIT', weights: 'rt_hdr_alb_nrm.tza' } as const;

/** The part of the oidn-webgpu module API we use (lib/main.d.ts, 0.6.0). */
export interface OidnModuleLike {
  initUNetFromURL(url: string, backend?: { device: GPUDevice }, opts?: { hdr?: boolean; aux?: boolean; maxTileSize?: number }): Promise<OidnUNetLike>;
}

interface GpuImage { data: GPUTexture | GPUBuffer; width: number; height: number }

export interface OidnUNetLike {
  tileExecute(args: {
    color: GpuImage;
    albedo?: GpuImage;
    normal?: GpuImage;
    done: (out: { data: GPUBuffer; width: number; height: number }) => void | Promise<void>;
    error?: (reason: unknown) => void;
    progress?: (...a: unknown[]) => void;
  }): () => void;
  dispose(): void;
}

export interface OidnOptions {
  /** dynamic import of the package, e.g. () => import('oidn-webgpu') */
  load: () => Promise<OidnModuleLike>;
  /** URL of the .tza weights served by the app */
  weightsUrl: string;
  /** model expects albedo + normal (default true: rt_hdr_alb_nrm) */
  aux?: boolean;
}

export interface OidnDenoiser {
  output: GPUTexture;
  /** denoise colour (+ albedo / normal AOVs) into `output`; resolves with the wall time (ms) */
  denoise(color: GPUTexture, albedo?: GPUTexture, normal?: GPUTexture): Promise<number>;
  cancel(): void;
  dispose(): void;
}

const COPY_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read> b5_src: array<vec4f>;
@group(0) @binding(1) var b5_dst: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(8, 8)
fn b5_k_buf2tex(@builtin(global_invocation_id) gid: vec3u) {
  let d = textureDimensions(b5_dst);
  if (gid.x >= d.x || gid.y >= d.y) {
    return;
  }
  let c = b5_src[gid.y * d.x + gid.x];
  textureStore(b5_dst, gid.xy, vec4f(clamp(c.rgb, vec3f(0.0), vec3f(65000.0)), 1.0));
}`;

/** Load the package + weights (the expensive part) and prepare a denoiser for width × height. */
export async function createOidnDenoiser(device: GPUDevice, width: number, height: number, o: OidnOptions): Promise<OidnDenoiser> {
  const mod = await o.load();
  const aux = o.aux ?? true;
  const unet = await mod.initUNetFromURL(o.weightsUrl, { device }, { hdr: true, aux });
  const output = device.createTexture({
    label: 'b5 pt oidn', size: [width, height], format: 'rgba16float',
    usage: TEXTURE.STORAGE_BINDING | TEXTURE.TEXTURE_BINDING | TEXTURE.COPY_SRC
  });
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: STAGE.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: STAGE.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba16float' } }
    ]
  });
  const pipe = device.createComputePipeline({
    label: 'b5 oidn copy',
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    compute: { module: device.createShaderModule({ code: COPY_WGSL }), entryPoint: 'b5_k_buf2tex' }
  });
  let cancel: (() => void) | null = null;
  return {
    output,
    denoise(color, albedo, normal) {
      const t0 = performance.now();
      const img = (t: GPUTexture): GpuImage => ({ data: t, width, height });
      return new Promise<number>((resolve, reject) => {
        const abort = unet.tileExecute({
          color: img(color),
          ...(aux && albedo && normal ? { albedo: img(albedo), normal: img(normal) } : {}),
          done: async (out) => {
            cancel = null;
            const enc = device.createCommandEncoder({ label: 'b5 oidn copy' });
            const p = enc.beginComputePass();
            p.setPipeline(pipe);
            p.setBindGroup(0, device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: out.data } }, { binding: 1, resource: output.createView() }] }));
            p.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
            p.end();
            device.queue.submit([enc.finish()]);
            await device.queue.onSubmittedWorkDone();
            resolve(performance.now() - t0);
          },
          error: reason => { cancel = null; reject(reason); }
        });
        cancel = () => {
          cancel = null;
          abort();
          reject(new Error('OIDN cancelled'));
        };
      });
    },
    cancel() { cancel?.(); },
    dispose() { cancel?.(); unet.dispose(); output.destroy(); }
  };
}
