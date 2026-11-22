/* ═══════════════════════════════════════════════════════════════════════════
   ImageDesc + pixels → THREE.DataTexture with the legacy CanvasTexture
   sampling:
     · colour space from the descriptor (sRGB albedo / linear data maps);
     · wrap repeat | clamp;
     · trilinear: LinearMipmapLinear + Linear, generateMipmaps (CanvasTexture
       defaults — DataTexture defaults to Nearest without mips);
     · anisotropy = min(anisotropyHint, renderer max) — the hint already holds
       the legacy min(Q.aniso / 4 / 8, …) choice;
     · rows flipped on upload: ImageDesc rows are top-first and UVs are v-up,
       exactly what CanvasTexture's flipY = true did. DataTexture uploads
       row 0 at v = 0, so the pixel rows are reversed on the CPU (flipY stays
       false — it is unsupported on some upload paths, and the copy is cheap);
     · NO hull repeat/offset mirror: the core bakes θ-correct hull UVs.

   Textures are created immediately as placeholders (so materials compile
   with the right maps and USE_* defines) and filled when pixels arrive:
   from ImageDesc.data, from the worker pool, or synchronously.
   ═══════════════════════════════════════════════════════════════════════════ */

import * as THREE from 'three';
import type { ImageDesc, TextureSpec } from '../../../core/scene/types.ts';
import type { PixelImage } from '../../../core/raster/index.ts';
import { generateImage, specKey } from '../../../core/textures/index.ts';
import type { TexturePool } from '../../../app/workers/texturePool.ts';

/** Classic WebGLRenderer (capabilities.getMaxAnisotropy) or WebGPURenderer (getMaxAnisotropy). */
export interface RendererLike {
  capabilities?: { getMaxAnisotropy(): number };
  getMaxAnisotropy?(): number;
}

/** Max anisotropy of either renderer flavour (1 if unknown). */
export function maxAnisotropyOf(r: RendererLike): number {
  const v = r.capabilities ? r.capabilities.getMaxAnisotropy() : r.getMaxAnisotropy ? r.getMaxAnisotropy() : 1;
  return Math.max(1, v || 1);
}

/** Rows reversed (top-first → bottom-first), RGBA8. */
export function flipRows(data: ArrayLike<number>, width: number, height: number): Uint8Array {
  const row = width * 4;
  const out = new Uint8Array(row * height);
  const src = data instanceof Uint8Array || data instanceof Uint8ClampedArray
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : Uint8Array.from(data);
  for (let y = 0; y < height; y++) out.set(src.subarray(y * row, y * row + row), (height - 1 - y) * row);
  return out;
}

/** Placeholder texture with the legacy sampling of `desc` (no pixels yet). */
export function createTexture(desc: ImageDesc, maxAnisotropy: number): THREE.DataTexture {
  const t = new THREE.DataTexture(null, desc.width, desc.height, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = desc.colorSpace === 'srgb' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  const wrap = desc.wrap === 'repeat' ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.wrapS = t.wrapT = wrap;
  t.generateMipmaps = desc.mipmaps;
  t.minFilter = desc.mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = Math.max(1, Math.min(desc.anisotropyHint, maxAnisotropy));
  t.flipY = false;
  t.unpackAlignment = 4;
  /* version stays 0 until pixels arrive: three binds nothing and the shader
     samples black — no warning about a null image */
  return t;
}

/** Upload pixels (top-first rows, RGBA8) into a texture made by createTexture. */
export function fillTexture(t: THREE.DataTexture, img: PixelImage | { width: number; height: number; data: ArrayLike<number> }): void {
  t.image = { data: flipRows(img.data, img.width, img.height), width: img.width, height: img.height };
  t.needsUpdate = true;
}

/** A set of textures for SceneDesc images, created on demand. */
export interface TextureSet {
  /** placeholder/filled texture for an image id (created on first use); null if unknown */
  get(id: string | undefined): THREE.DataTexture | null;
  /** ids that have a texture object */
  ids(): string[];
  /**
   * Fill every created texture: ImageDesc.data if present, otherwise the
   * pool (workers) or a synchronous generateImage fallback.
   */
  load(opts?: { pool?: TexturePool | null; sync?: boolean }): Promise<void>;
  dispose(): void;
}

export function createTextureSet(images: Record<string, ImageDesc>, renderer: RendererLike): TextureSet {
  const maxAniso = maxAnisotropyOf(renderer);
  const made = new Map<string, THREE.DataTexture>();
  return {
    get(id) {
      if (!id) return null;
      let t = made.get(id);
      if (t) return t;
      const d = images[id];
      if (!d) return null;
      t = createTexture(d, maxAniso);
      t.name = id;
      made.set(id, t);
      return t;
    },
    ids: () => [...made.keys()],
    async load(opts = {}) {
      const want: [THREE.DataTexture, ImageDesc][] = [];
      for (const [id, t] of made) {
        const d = images[id];
        if (d.data) fillTexture(t, { width: d.width, height: d.height, data: d.data });
        else want.push([t, d]);
      }
      if (!want.length) return;
      const specs: TextureSpec[] = want.map(([, d]) => d.source);
      let px: Map<string, PixelImage>;
      if (opts.pool && !opts.sync) {
        px = await opts.pool.generate(specs, { clear: true });
      } else {
        px = new Map();
        for (const s of specs) px.set(specKey(s), generateImage(s));
      }
      for (const [t, d] of want) {
        const im = px.get(specKey(d.source));
        if (!im) throw new Error(`textures: no pixels for '${t.name}'`);
        fillTexture(t, im);
      }
    },
    dispose() {
      for (const t of made.values()) t.dispose();
      made.clear();
    }
  };
}
