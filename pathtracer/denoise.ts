/* ═══════════════════════════════════════════════════════════════════════════
   Denoisers (PT-P4).

   (a) À-trous / SVGF-lite (wgsl/k_atrous.wgsl) — the preview denoiser:
       albedo demodulation, normal / depth / luminance edge stopping, guided
       by the per-pixel variance of the mean from the convergence half buffer,
       DENOISE.passes levels (steps 1, 2, 4, …). Reads the integrator's
       accumulation buffers directly (Integrator.buffers), writes its own
       rgba16float texture. atrousRef() is the CPU mirror (tests).

   (b) Open Image Denoise on WebGPU — see oidn.ts (lazy, optional).
   ═══════════════════════════════════════════════════════════════════════════ */

import { BUFFER, STAGE, TEXTURE } from './gpu-flags.ts';
import kAtrous from './wgsl/k_atrous.wgsl?raw';

export const DENOISE = {
  /** à-trous levels (tap spacing 1, 2, 4, 8). Tuned on the station (view 0 DAY, 16 spp vs 512 spp,
      pt-output.spec.ts (c)): 4 levels / σl 2 gave the lowest relMSE and display RMSE (5 levels / σl 4
      smeared HDR highlights: linear RMSE worse than the noisy input) */
  passes: 4,
  /** normal edge-stopping exponent (SVGF σn) */
  sigmaN: 128,
  /** depth edge-stopping scale (× local depth gradient × tap distance) */
  sigmaZ: 1,
  /** luminance edge stopping (× √ filtered variance; SVGF σl) */
  sigmaL: 2,
  /** albedo floor of the demodulation */
  albedoEps: 0.02
} as const;

export interface AtrousOptions {
  passes?: number;
  sigmaN?: number;
  sigmaZ?: number;
  sigmaL?: number;
  albedoEps?: number;
}

export interface AtrousInputs {
  accum: GPUBuffer;
  half: GPUBuffer;
  aov: GPUBuffer;
}

export interface AtrousDenoiser {
  output: GPUTexture;
  /** record the passes into an encoder (own compute pass) */
  encode(enc: GPUCommandEncoder): void;
  /** encode + submit; resolves when the GPU finished, with the wall time */
  run(): Promise<number>;
  setOptions(o: AtrousOptions): void;
  dispose(): void;
}

const PARAM_SLOT = 256;
const PARAM_BYTES = 32;
const MAX_PASSES = 8;

export const ATROUS_ENTRIES = ['b5_k_atrous_prep', 'b5_k_atrous_pass', 'b5_k_atrous_final'] as const;

export function createAtrousDenoiser(
  device: GPUDevice, width: number, height: number, inputs: AtrousInputs, opts: AtrousOptions = {}, source: string = kAtrous
): AtrousDenoiser {
  let o = { ...DENOISE, ...opts };
  const C = STAGE.COMPUTE;
  const layout = device.createBindGroupLayout({
    label: 'b5 atrous',
    entries: [
      { binding: 0, visibility: C, buffer: { type: 'uniform', hasDynamicOffset: true } },
      { binding: 1, visibility: C, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: C, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: C, buffer: { type: 'read-only-storage' } },
      { binding: 4, visibility: C, buffer: { type: 'read-only-storage' } },
      { binding: 5, visibility: C, buffer: { type: 'storage' } },
      { binding: 6, visibility: C, storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d' } }
    ]
  });
  const module = device.createShaderModule({ label: 'k_atrous.wgsl', code: source });
  const pl = device.createPipelineLayout({ label: 'b5 atrous', bindGroupLayouts: [layout] });
  const [prep, pass, fin] = ATROUS_ENTRIES.map((entryPoint) =>
    device.createComputePipeline({ label: entryPoint, layout: pl, compute: { module, entryPoint } }));
  const pixels = width * height;
  const bufs = [0, 1].map((i) => device.createBuffer({ label: `b5 atrous ${i}`, size: pixels * 16, usage: BUFFER.STORAGE }));
  /* a third buffer as the (never read) dst of the final pass and src of prep */
  const dummy = device.createBuffer({ label: 'b5 atrous dummy', size: 16, usage: BUFFER.STORAGE });
  const params = device.createBuffer({ label: 'b5 atrous params', size: PARAM_SLOT * (MAX_PASSES + 2), usage: BUFFER.UNIFORM | BUFFER.COPY_DST });
  const output = device.createTexture({
    label: 'b5 pt denoised', size: [width, height], format: 'rgba16float',
    usage: TEXTURE.STORAGE_BINDING | TEXTURE.TEXTURE_BINDING | TEXTURE.COPY_SRC
  });
  const outView = output.createView();
  const bg = (src: GPUBuffer, dst: GPUBuffer) => device.createBindGroup({
    label: 'b5 atrous', layout,
    entries: [
      { binding: 0, resource: { buffer: params, offset: 0, size: PARAM_BYTES } },
      { binding: 1, resource: { buffer: inputs.accum } },
      { binding: 2, resource: { buffer: inputs.half } },
      { binding: 3, resource: { buffer: inputs.aov } },
      { binding: 4, resource: { buffer: src } },
      { binding: 5, resource: { buffer: dst } },
      { binding: 6, resource: outView }
    ]
  });
  const bgPrep = bg(dummy, bufs[0]);
  const bgAB = bg(bufs[0], bufs[1]);
  const bgBA = bg(bufs[1], bufs[0]);
  const bgFinA = bg(bufs[0], dummy);
  const bgFinB = bg(bufs[1], dummy);

  function writeParams(): void {
    const n = Math.min(o.passes, MAX_PASSES);
    const ab = new ArrayBuffer(PARAM_SLOT * (n + 2));
    for (let k = 0; k < n + 2; k++) {
      const v = new DataView(ab, k * PARAM_SLOT, PARAM_BYTES);
      v.setUint32(0, width, true); v.setUint32(4, height, true);
      v.setUint32(8, k >= 1 && k <= n ? 1 << (k - 1) : 1, true); v.setUint32(12, 0, true);
      v.setFloat32(16, o.sigmaN, true); v.setFloat32(20, o.sigmaZ, true);
      v.setFloat32(24, o.sigmaL, true); v.setFloat32(28, o.albedoEps, true);
    }
    device.queue.writeBuffer(params, 0, ab);
  }
  writeParams();

  function encode(enc: GPUCommandEncoder): void {
    const n = Math.min(o.passes, MAX_PASSES);
    const gx = Math.ceil(width / 8), gy = Math.ceil(height / 8);
    const p = enc.beginComputePass({ label: 'b5 atrous' });
    p.setPipeline(prep);
    p.setBindGroup(0, bgPrep, [0]);
    p.dispatchWorkgroups(gx, gy);
    let inA = true;
    for (let k = 1; k <= n; k++) {
      p.setPipeline(pass);
      p.setBindGroup(0, inA ? bgAB : bgBA, [k * PARAM_SLOT]);
      p.dispatchWorkgroups(gx, gy);
      inA = !inA;
    }
    p.setPipeline(fin);
    p.setBindGroup(0, inA ? bgFinA : bgFinB, [(n + 1) * PARAM_SLOT]);
    p.dispatchWorkgroups(gx, gy);
    p.end();
  }

  return {
    output,
    encode,
    async run() {
      const t = performance.now();
      const enc = device.createCommandEncoder({ label: 'b5 atrous' });
      encode(enc);
      device.queue.submit([enc.finish()]);
      await device.queue.onSubmittedWorkDone();
      return performance.now() - t;
    },
    setOptions(x) { o = { ...o, ...x }; writeParams(); },
    dispose() { for (const b of bufs) b.destroy(); dummy.destroy(); params.destroy(); output.destroy(); }
  };
}

/* ─── CPU mirror ──────────────────────────────────────────────────────────── */

const lum = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const H5 = [0.0625, 0.25, 0.375, 0.25, 0.0625];
const VAR_UNKNOWN = 1e6;

/**
 * CPU mirror of k_atrous.wgsl (f64): accum (vec4 per pixel), half (f32 per
 * pixel), aov (2 × vec4 per pixel: albedo sum + depth sum, normal sum) →
 * denoised rgb (3 floats per pixel). `stages` returns the intermediate
 * (illumination, variance) buffers too.
 */
export function atrousRef(
  accum: Float32Array, half: Float32Array, aov: Float32Array, width: number, height: number, opts: AtrousOptions = {}
): { rgb: Float32Array; stages: Float32Array[] } {
  const o = { ...DENOISE, ...opts };
  const n = width * height;
  const albedo = new Float64Array(n * 3), depth = new Float64Array(n), normal = new Float64Array(n * 3);
  for (let p = 0; p < n; p++) {
    const w = Math.max(accum[p * 4 + 3], 1);
    for (let c = 0; c < 3; c++) albedo[p * 3 + c] = Math.max(aov[p * 8 + c] / w, o.albedoEps);
    depth[p] = aov[p * 8 + 3] / w;
    const nx = aov[p * 8 + 4], ny = aov[p * 8 + 5], nz = aov[p * 8 + 6];
    const l = Math.hypot(nx, ny, nz);
    if (l > 0) { normal[p * 3] = nx / l; normal[p * 3 + 1] = ny / l; normal[p * 3 + 2] = nz / l; }
  }
  let cur = new Float32Array(n * 4);
  for (let p = 0; p < n; p++) {
    const w = accum[p * 4 + 3];
    const iw = 1 / Math.max(w, 1);
    for (let c = 0; c < 3; c++) cur[p * 4 + c] = (accum[p * 4 + c] * iw) / albedo[p * 3 + c];
    let v = VAR_UNKNOWN;
    if (w >= 2) {
      const nA = Math.ceil(w * 0.5);
      const A = half[p] / nA, B = (lum(accum[p * 4], accum[p * 4 + 1], accum[p * 4 + 2]) - half[p]) / (w - nA);
      const la = lum(albedo[p * 3], albedo[p * 3 + 1], albedo[p * 3 + 2]);
      v = ((A - B) * (A - B) * 0.25) / (la * la);
    }
    cur[p * 4 + 3] = v;
  }
  const stages = [cur];
  const idx = (x: number, y: number) => y * width + x;
  for (let k = 1; k <= o.passes; k++) {
    const s = 1 << (k - 1);
    const nxt = new Float32Array(n * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = idx(x, y);
        const lp = lum(cur[p * 4], cur[p * 4 + 1], cur[p * 4 + 2]);
        const zp = depth[p];
        const dz = Math.max(Math.abs(depth[idx(Math.min(x + 1, width - 1), y)] - zp), Math.abs(depth[idx(x, Math.min(y + 1, height - 1))] - zp));
        let gv = 0;
        for (let j = -1; j <= 1; j++) {
          for (let i = -1; i <= 1; i++) {
            const q = idx(Math.min(width - 1, Math.max(0, x + i)), Math.min(height - 1, Math.max(0, y + j)));
            const m = Math.abs(i) + Math.abs(j);
            gv += (m === 0 ? 0.25 : m === 1 ? 0.125 : 0.0625) * cur[q * 4 + 3];
          }
        }
        const lden = o.sigmaL * Math.sqrt(Math.max(gv, 0)) + 1e-6;
        let sr = 0, sg = 0, sb = 0, sw = 0, sv = 0;
        for (let j = -2; j <= 2; j++) {
          for (let i = -2; i <= 2; i++) {
            const qx = x + i * s, qy = y + j * s;
            if (qx < 0 || qy < 0 || qx >= width || qy >= height) continue;
            const q = idx(qx, qy);
            let w = H5[i + 2] * H5[j + 2];
            if (i !== 0 || j !== 0) {
              const d = normal[p * 3] * normal[q * 3] + normal[p * 3 + 1] * normal[q * 3 + 1] + normal[p * 3 + 2] * normal[q * 3 + 2];
              const hasP = normal[p * 3] !== 0 || normal[p * 3 + 1] !== 0 || normal[p * 3 + 2] !== 0;
              const hasQ = normal[q * 3] !== 0 || normal[q * 3 + 1] !== 0 || normal[q * 3 + 2] !== 0;
              if (hasP && hasQ) w *= Math.max(0, d) ** o.sigmaN;
              const dist = Math.hypot(i * s, j * s);
              const zden = o.sigmaZ * Math.max(dz * dist, 1e-3 * Math.abs(zp)) + 1e-6;
              w *= Math.exp(-Math.abs(zp - depth[q]) / zden);
              w *= Math.exp(-Math.abs(lp - lum(cur[q * 4], cur[q * 4 + 1], cur[q * 4 + 2])) / lden);
            }
            sr += w * cur[q * 4]; sg += w * cur[q * 4 + 1]; sb += w * cur[q * 4 + 2];
            sv += w * w * cur[q * 4 + 3]; sw += w;
          }
        }
        nxt[p * 4] = sr / sw; nxt[p * 4 + 1] = sg / sw; nxt[p * 4 + 2] = sb / sw; nxt[p * 4 + 3] = sv / (sw * sw);
      }
    }
    cur = nxt;
    stages.push(cur);
  }
  const rgb = new Float32Array(n * 3);
  for (let p = 0; p < n; p++) for (let c = 0; c < 3; c++) rgb[p * 3 + c] = Math.max(0, Math.min(65000, cur[p * 4 + c] * albedo[p * 3 + c]));
  return { rgb, stages };
}
