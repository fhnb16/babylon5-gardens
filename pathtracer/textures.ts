/* ═══════════════════════════════════════════════════════════════════════════
   Textures of the path tracer: ImageDesc → texture_2d_array per size class.

   • Size classes 256 / 512 / 1024 / 2048 (SIZE_CLASSES). An image goes to
     the smallest class ≥ max(width, height) (capped at 2048) and is
     resampled to that square: integer up-scales with 'nearest' (keeps
     texels sharp), everything else with 'bilinear'; non-square images are
     stretched (UVs are unaffected — they address the whole image).
   • Two formats: colour images (colorSpace 'srgb') live in arrays sampled
     through an 'rgba8unorm-srgb' view (hardware decode before filtering),
     data images ('linear': normal, mask, detail, roughness) in plain
     'rgba8unorm'. → 8 arrays: [srgb 256, 512, 1024, 2048, linear 256, …].
     Every array exists (1×1×1 placeholder when empty) so bind group 2 is
     always complete. Textures are created as 'rgba8unorm' with view format
     'rgba8unorm-srgb': storage views (mip generation) need a non-sRGB format.
   • Full mip chains, generated on the GPU by wgsl/mipgen.wgsl (2×2 box; sRGB
     arrays average in linear space). mipChainCpu() is the bit-for-bit
     CPU mirror (up to pow() ulps) used by surface-ref.ts.
   • Texture table (uniform `b5_texrefs`, MAX_TEX entries × 32 B):
       byte  0  loc       u32   layer (bits 0..11) | class (12..13) |
                                srgb (bit 14) | clamp-to-edge wrap (bit 15)
       byte  4  lodOffset f32   log2(class size) + 0.5·log2|sx·sy|: ray-cone
                                LOD of the texture = surface LOD + lodOffset
       byte  8  r0, r1    u32   reserved
       byte 16  xform     vec4f uv' = uv · xform.xy + xform.zw. Includes the
                                v flip: images are stored top row first
                                (origin 'top-left') and UVs are v-up, so the
                                identity mapping is (1, −1, 0, 1).
   ═══════════════════════════════════════════════════════════════════════════ */

import type { ImageDesc, ImageId, TextureSpec } from '../core/scene/types.ts';
import type { PixelImage } from '../core/raster/index.ts';
import { resamplePixelImage } from '../core/raster/index.ts';
import { generateImage, specKey } from '../core/textures/index.ts';
import { TEXTURE, STAGE, BUFFER } from './gpu-flags.ts';
import { compileShader, type WgslSources } from './kernels.ts';

export const SIZE_CLASSES = [256, 512, 1024, 2048] as const;
export const CLASS_COUNT = SIZE_CLASSES.length;
/** max texture-table entries (uniform array length) */
export const MAX_TEX = 256;
export const MAX_LAYERS = 4096;

export const TEXREF_BYTES = 32;
export const TEXREF_OFFSETS = { loc: 0, lodOffset: 4, r0: 8, r1: 12, xform: 16 } as const;
export const TEXTABLE_BYTES = MAX_TEX * TEXREF_BYTES;

export const LOC_LAYER_MASK = 0xfff;
export const LOC_CLASS_SHIFT = 12;
export const LOC_SRGB = 1 << 14;
export const LOC_CLAMP = 1 << 15;

/** Index of the size class of a width × height image. */
export function sizeClassOf(width: number, height: number): number {
  const m = Math.max(width, height, 1);
  for (let i = 0; i < CLASS_COUNT; i++) if (m <= SIZE_CLASSES[i]) return i;
  return CLASS_COUNT - 1;
}

/** Array slot of (srgb, class): srgb arrays 0..3, linear arrays 4..7. */
export function arraySlot(srgb: boolean, cls: number): number {
  return (srgb ? 0 : CLASS_COUNT) + cls;
}

export interface TexRef {
  /** texture-table index */
  index: number;
  image: ImageId;
  cls: number;
  size: number;
  srgb: boolean;
  clamp: boolean;
  layer: number;
  /** uv transform (sx, sy, ox, oy), v flip included */
  xform: [number, number, number, number];
  /** source size */
  width: number;
  height: number;
}

export interface TexturePlan {
  refs: TexRef[];
  byImage: Map<ImageId, number>;
  /** layers per array slot (8) */
  layers: number[];
  /** GPU bytes incl. full mip chains */
  bytes: number;
}

/** Assign every image a class, array and layer (pure; order = `ids` order). */
export function planTextures(images: Record<ImageId, ImageDesc>, ids: Iterable<ImageId>): TexturePlan {
  const refs: TexRef[] = [];
  const byImage = new Map<ImageId, number>();
  const layers = new Array<number>(2 * CLASS_COUNT).fill(0);
  let bytes = 0;
  for (const id of ids) {
    if (byImage.has(id)) continue;
    const im = images[id];
    if (!im) throw new Error(`texture plan: image '${id}' not in SceneDesc.images`);
    if (refs.length >= MAX_TEX) throw new RangeError(`texture plan: more than ${MAX_TEX} textures`);
    const cls = sizeClassOf(im.width, im.height);
    const srgb = im.colorSpace === 'srgb';
    const slot = arraySlot(srgb, cls);
    const layer = layers[slot]++;
    if (layer >= MAX_LAYERS) throw new RangeError(`texture plan: class ${SIZE_CLASSES[cls]} has more than ${MAX_LAYERS} layers`);
    const size = SIZE_CLASSES[cls];
    bytes += Math.round((size * size * 4 * 4) / 3);
    const ref: TexRef = {
      index: refs.length, image: id, cls, size, srgb, clamp: im.wrap === 'clamp', layer,
      xform: [1, -1, 0, 1], width: im.width, height: im.height
    };
    byImage.set(id, ref.index);
    refs.push(ref);
  }
  return { refs, byImage, layers, bytes };
}

export function texRefLoc(r: TexRef): number {
  return ((r.layer & LOC_LAYER_MASK) | (r.cls << LOC_CLASS_SHIFT) | (r.srgb ? LOC_SRGB : 0) | (r.clamp ? LOC_CLAMP : 0)) >>> 0;
}

export function texRefLodOffset(r: TexRef): number {
  return Math.log2(r.size) + 0.5 * Math.log2(Math.abs(r.xform[0] * r.xform[1]) || 1);
}

/** Texture table uniform contents (MAX_TEX entries). */
export function packTexTable(plan: TexturePlan): ArrayBuffer {
  const buf = new ArrayBuffer(TEXTABLE_BYTES);
  const U = new Uint32Array(buf), F = new Float32Array(buf);
  for (const r of plan.refs) {
    const w = (r.index * TEXREF_BYTES) / 4;
    U[w] = texRefLoc(r);
    F[w + 1] = texRefLodOffset(r);
    F.set(r.xform, w + 4);
  }
  return buf;
}

/** WGSL declarations of the texture table. */
export function emitWgslTextures(): string {
  return [
    '// generated by pathtracer/textures.ts — do not edit',
    `const B5_MAX_TEX: u32 = ${MAX_TEX}u;`,
    `const B5_LOC_LAYER_MASK: u32 = 0x${LOC_LAYER_MASK.toString(16)}u;`,
    `const B5_LOC_CLASS_SHIFT: u32 = ${LOC_CLASS_SHIFT}u;`,
    `const B5_LOC_SRGB: u32 = 0x${LOC_SRGB.toString(16)}u;`,
    `const B5_LOC_CLAMP: u32 = 0x${LOC_CLAMP.toString(16)}u;`,
    '',
    `// size ${TEXREF_BYTES} B`,
    'struct B5TexRef {',
    '  loc: u32, // @0',
    '  lodOffset: f32, // @4',
    '  r0: u32, // @8',
    '  r1: u32, // @12',
    '  xform: vec4f, // @16',
    '}',
    '',
    'struct B5TexTable {',
    `  e: array<B5TexRef, ${MAX_TEX}>,`,
    '}',
    ''
  ].join('\n');
}

/* ─── CPU images ──────────────────────────────────────────────────────────── */

/** Image source: generate the pixels of the given specs (keyed by specKey). */
export type ImageGenerator = (specs: TextureSpec[]) => Promise<Map<string, PixelImage>> | Map<string, PixelImage>;

/** Synchronous generator: core/textures generateImage (main thread / Node). */
export const syncImageGenerator: ImageGenerator = (specs) => {
  const out = new Map<string, PixelImage>();
  for (const s of specs) out.set(specKey(s), generateImage(s));
  return out;
};

/** Resample to the class square (see header). Returns the input when it already fits. */
export function toClassSquare(img: PixelImage, size: number): PixelImage {
  if (img.width === size && img.height === size) return img;
  const intUp = size % img.width === 0 && size % img.height === 0 && size >= img.width && size >= img.height;
  return resamplePixelImage(img, size, size, intUp ? 'nearest' : 'bilinear');
}

/** Level-0 squares of every planned texture (generates missing pixels). */
export async function loadTextureImages(
  plan: TexturePlan, images: Record<ImageId, ImageDesc>, gen: ImageGenerator = syncImageGenerator
): Promise<PixelImage[]> {
  const need: TextureSpec[] = [];
  for (const r of plan.refs) if (!images[r.image].data) need.push(images[r.image].source);
  const got = need.length ? await gen(need) : new Map<string, PixelImage>();
  return plan.refs.map((r) => {
    const im = images[r.image];
    let px: PixelImage;
    if (im.data) px = { width: im.width, height: im.height, data: im.data instanceof Uint8ClampedArray ? im.data : new Uint8ClampedArray(im.data.buffer, im.data.byteOffset, im.data.byteLength) };
    else {
      const g = got.get(specKey(im.source));
      if (!g) throw new Error(`texture '${r.image}': generator returned no image`);
      px = g;
    }
    if (px.width !== im.width || px.height !== im.height) {
      throw new Error(`texture '${r.image}': ${px.width}×${px.height} ≠ declared ${im.width}×${im.height}`);
    }
    return toClassSquare(px, r.size);
  });
}

/* ─── CPU mip chain (mirror of mipgen.wgsl) ───────────────────────────────── */

export function srgbToLinear01(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
export function linearToSrgb01(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

export function mipLevelCount(size: number): number {
  return Math.floor(Math.log2(size)) + 1;
}

/**
 * f32 → unorm8 rounding of the CPU mirror: nearest, ties to even. Measured
 * against mipgen.wgsl on D3D12 / RTX 3070: ties-to-even is the closest
 * model (8 % of linear bytes differ by 1 at level 1 vs 14 % with ties-up;
 * the shader's f32 sums round ties both ways), sRGB levels add pow() ulps:
 * ≤ 1 LSB per level, ≤ 3 LSB at level 5 (accumulated). See pt-surface.
 */
export function roundHalfEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 ? 2 * Math.round(x / 2) : r;
}

/** Full chain of a square power-of-two image; level 0 is the input. */
export function mipChainCpu(level0: PixelImage, srgb: boolean): PixelImage[] {
  const out = [level0];
  let src = level0;
  const lut = new Float64Array(256);
  for (let i = 0; i < 256; i++) lut[i] = srgb ? srgbToLinear01(i / 255) : i / 255;
  while (src.width > 1) {
    const S = src.width >> 1, sw = src.width;
    const d = new Uint8ClampedArray(S * S * 4);
    const s = src.data;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const a = ((2 * y) * sw + 2 * x) * 4, b = a + 4, c = a + sw * 4, e = c + 4;
        const o = (y * S + x) * 4;
        for (let k = 0; k < 4; k++) {
          if (srgb && k < 3) {
            const v = (lut[s[a + k]] + lut[s[b + k]] + lut[s[c + k]] + lut[s[e + k]]) * 0.25;
            d[o + k] = roundHalfEven(Math.min(1, Math.max(0, linearToSrgb01(v))) * 255);
          } else {
            d[o + k] = roundHalfEven((s[a + k] + s[b + k] + s[c + k] + s[e + k]) / 4);
          }
        }
      }
    }
    src = { width: S, height: S, data: d };
    out.push(src);
  }
  return out;
}

/* ─── GPU ─────────────────────────────────────────────────────────────────── */

export interface GpuTextures {
  plan: TexturePlan;
  /** 8 arrays (arraySlot order) */
  textures: GPUTexture[];
  /** sampling views ('2d-array', srgb view format for colour arrays) */
  views: GPUTextureView[];
  samplerRepeat: GPUSampler;
  samplerClamp: GPUSampler;
  /** texture table uniform (TEXTABLE_BYTES) */
  table: GPUBuffer;
  tableData: ArrayBuffer;
  bytes: number;
  timings: { uploadMs: number; mipMs: number };
  destroy(): void;
}

export interface UploadTexturesOptions {
  /** WGSL sources containing 'mipgen.wgsl' */
  sources: WgslSources;
  log?: (line: string) => void;
}

/** Create the arrays, upload level 0, generate mips on the GPU, build the table. */
export async function uploadTextures(
  device: GPUDevice, plan: TexturePlan, level0: PixelImage[], opts: UploadTexturesOptions
): Promise<GpuTextures> {
  const t0 = performance.now();
  const textures: GPUTexture[] = [];
  const views: GPUTextureView[] = [];
  for (let slot = 0; slot < 2 * CLASS_COUNT; slot++) {
    const srgb = slot < CLASS_COUNT;
    const cls = slot % CLASS_COUNT;
    const n = plan.layers[slot];
    const size = n ? SIZE_CLASSES[cls] : 1;
    const tex = device.createTexture({
      label: `b5 tex ${srgb ? 'srgb' : 'lin'} ${SIZE_CLASSES[cls]}`,
      size: [size, size, Math.max(1, n)],
      mipLevelCount: n ? mipLevelCount(size) : 1,
      format: 'rgba8unorm',
      viewFormats: srgb ? ['rgba8unorm-srgb'] : [],
      usage: TEXTURE.TEXTURE_BINDING | TEXTURE.COPY_DST | TEXTURE.COPY_SRC | (n ? TEXTURE.STORAGE_BINDING : 0)
    });
    textures.push(tex);
    /* sRGB formats cannot be storage formats: the sampling view narrows its
       usage to TEXTURE_BINDING (GPUTextureViewDescriptor.usage) */
    views.push(tex.createView({ dimension: '2d-array', format: srgb ? 'rgba8unorm-srgb' : 'rgba8unorm', usage: TEXTURE.TEXTURE_BINDING }));
  }
  for (const r of plan.refs) {
    const img = level0[r.index];
    const tex = textures[arraySlot(r.srgb, r.cls)];
    device.queue.writeTexture(
      { texture: tex, mipLevel: 0, origin: [0, 0, r.layer] },
      img.data, { bytesPerRow: r.size * 4, rowsPerImage: r.size }, [r.size, r.size, 1]
    );
  }
  const t1 = performance.now();

  /* mip generation */
  const mipLayout = device.createBindGroupLayout({
    label: 'b5 mipgen',
    entries: [
      { binding: 0, visibility: STAGE.COMPUTE, texture: { sampleType: 'unfilterable-float', viewDimension: '2d-array' } },
      { binding: 1, visibility: STAGE.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d-array' } }
    ]
  });
  const mipSrc = opts.sources['mipgen.wgsl'];
  if (mipSrc === undefined) throw new Error('uploadTextures: WGSL source mipgen.wgsl missing');
  const module = await compileShader(device, 'mipgen.wgsl', { code: mipSrc, lines: mipSrc.split('\n').map((_, i) => ({ file: 'mipgen.wgsl', line: i + 1 })) });
  const layout = device.createPipelineLayout({ label: 'b5 mipgen', bindGroupLayouts: [mipLayout] });
  const [pipeSrgb, pipeLin] = await Promise.all([true, false].map((srgb) => device.createComputePipelineAsync({
    label: `b5_k_mipgen ${srgb ? 'srgb' : 'linear'}`, layout,
    compute: { module, entryPoint: 'b5_k_mipgen', constants: { B5_MIP_SRGB: srgb ? 1 : 0 } }
  })));
  const enc = device.createCommandEncoder({ label: 'b5 mipgen' });
  for (let slot = 0; slot < 2 * CLASS_COUNT; slot++) {
    const n = plan.layers[slot];
    if (!n) continue;
    const tex = textures[slot];
    const size = SIZE_CLASSES[slot % CLASS_COUNT];
    const levels = mipLevelCount(size);
    const pass = enc.beginComputePass({ label: `b5 mipgen ${slot}` });
    pass.setPipeline(slot < CLASS_COUNT ? pipeSrgb : pipeLin);
    for (let l = 1; l < levels; l++) {
      const bg = device.createBindGroup({
        layout: mipLayout,
        entries: [
          { binding: 0, resource: tex.createView({ dimension: '2d-array', format: 'rgba8unorm', baseMipLevel: l - 1, mipLevelCount: 1, usage: TEXTURE.TEXTURE_BINDING }) },
          { binding: 1, resource: tex.createView({ dimension: '2d-array', format: 'rgba8unorm', baseMipLevel: l, mipLevelCount: 1, usage: TEXTURE.STORAGE_BINDING }) }
        ]
      });
      pass.setBindGroup(0, bg);
      const s = Math.max(1, size >> l);
      pass.dispatchWorkgroups(Math.ceil(s / 8), Math.ceil(s / 8), n);
    }
    pass.end();
  }
  device.queue.submit([enc.finish()]);
  await device.queue.onSubmittedWorkDone();
  const t2 = performance.now();

  const sampler = (mode: GPUAddressMode) => device.createSampler({
    label: `b5 ${mode}`, addressModeU: mode, addressModeV: mode,
    magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear'
  });
  const tableData = packTexTable(plan);
  const table = device.createBuffer({ label: 'b5 texrefs', size: TEXTABLE_BYTES, usage: BUFFER.UNIFORM | BUFFER.COPY_DST });
  device.queue.writeBuffer(table, 0, tableData);
  const res: GpuTextures = {
    plan, textures, views,
    samplerRepeat: sampler('repeat'),
    samplerClamp: sampler('clamp-to-edge'),
    table, tableData,
    bytes: plan.bytes,
    timings: { uploadMs: t1 - t0, mipMs: t2 - t1 },
    destroy() { for (const t of textures) t.destroy(); table.destroy(); }
  };
  return res;
}

/** One-line budget: layers and MiB per array. */
export function textureBudget(plan: TexturePlan): string {
  const parts: string[] = [];
  for (let slot = 0; slot < 2 * CLASS_COUNT; slot++) {
    const n = plan.layers[slot];
    if (!n) continue;
    const s = SIZE_CLASSES[slot % CLASS_COUNT];
    parts.push(`${slot < CLASS_COUNT ? 'srgb' : 'lin'}${s}×${n} ${((s * s * 4 * 4 / 3) * n / 1048576).toFixed(1)} MiB`);
  }
  return `textures: ${plan.refs.length} images, ${(plan.bytes / 1048576).toFixed(1)} MiB with mips (${parts.join(', ')})`;
}
