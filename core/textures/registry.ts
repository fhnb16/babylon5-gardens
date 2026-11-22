/* ═══════════════════════════════════════════════════════════════════════════
   Texture registry: TextureSpec → pixels, and TextureSpec → ImageDesc.

   Spec convention (see TextureSpec in core/scene/types.ts):
     gen  = legacy js/textures.js function name without the `make` prefix,
            lowerCamel ('hullMaps', 'facade', 'heightToNormal', …);
     args = the legacy parameters as JSON, `rnd` replaced by the numeric
            `seed` it was created from (mulberry32(seed)), plus `output` for
            multi-output generators:
              hullMaps      → 'albedo' | 'mask'
              facade        → 'map'    | 'emissive'
              endCapTexture → 'map'    | 'emissive'
            Sources of derived maps are nested specs:
              heightToNormal { src: TextureSpec, strength, size }
              waterRoughness { mask: TextureSpec, size }
              waterNormal    { mask: TextureSpec, size, strength }

   generateImage() memoizes by the canonical JSON key of the spec; a
   multi-output generator runs once and caches every output. Returned images
   are shared — treat them as read-only (copy before transferring).
   ═══════════════════════════════════════════════════════════════════════════ */

import type { ImageDesc, TextureSpec } from '../scene/types.ts';
import type { PixelImage, RasterCanvas } from '../raster/index.ts';
import { CORE_CONFIG } from '../config/index.ts';
import { mulberry32 } from '../rng.ts';
import { TEX } from './ids.ts';
import { makeHullMaps } from './hull.ts';
import type { Pond } from './hull.ts';
import { makeDetailTexture, makeLeafTexture } from './nature.ts';
import { makeFacade, makeRoofTexture, makeCarWindows } from './city.ts';
import { makeEndCapTexture, makePanelTexture } from './structures.ts';
import { makeSoftSprite, makeBlobTexture, makeFootprintTexture, makeGlowTexture } from './sprites.ts';
import { makeWaterRoughness, makeWaterNormal } from './water.ts';
import { heightToNormal } from './normals.ts';

type Args = Record<string, unknown>;
type Outputs = Record<string, PixelImage>;

/** Single-output generators store their image under this output name. */
const SINGLE = 'image';

/* ─── args helpers ─── */

function num(args: Args, key: string, gen: string, def?: number): number {
  const v = args[key];
  if (typeof v === 'number' && isFinite(v)) return v;
  if (v === undefined && def !== undefined) return def;
  throw new TypeError(`texture '${gen}': argument '${key}' must be a finite number`);
}

function spec(args: Args, key: string, gen: string): TextureSpec {
  const v = args[key] as TextureSpec | undefined;
  if (!v || typeof v !== 'object' || typeof v.gen !== 'string' || !v.args || typeof v.args !== 'object') {
    throw new TypeError(`texture '${gen}': argument '${key}' must be a TextureSpec`);
  }
  return v;
}

const img = (c: RasterCanvas): PixelImage => c.image;

/* ─── generator table ─── */

interface GenDef {
  /** output names; [SINGLE] for single-output generators */
  outputs: string[];
  run: (args: Args) => Outputs;
  /** pixel size of an output without generating it */
  size: (args: Args, output: string) => [number, number];
}

const fixed = (w: number, h = w) => (): [number, number] => [w, h];

const GENERATORS: Record<string, GenDef> = {
  hullMaps: {
    outputs: ['albedo', 'mask'],
    run: a => {
      const seed = num(a, 'seed', 'hullMaps');
      const r = makeHullMaps(num(a, 'size', 'hullMaps'), num(a, 'maskSize', 'hullMaps'), mulberry32(seed),
        (a.ponds as Pond[] | undefined) || [],
        { worldSeed: num(a, 'worldSeed', 'hullMaps', seed - 7), debugUvMarker: !!a.debugUvMarker });
      return { albedo: img(r.albedo), mask: img(r.mask) };
    },
    size: (a, o) => {
      const s = num(a, o === 'mask' ? 'maskSize' : 'size', 'hullMaps');
      return [s, s];
    }
  },
  detailTexture: {
    outputs: [SINGLE],
    run: a => ({ [SINGLE]: img(makeDetailTexture(mulberry32(num(a, 'seed', 'detailTexture')))) }),
    size: fixed(256)
  },
  facade: {
    outputs: ['map', 'emissive'],
    run: a => {
      const variant = num(a, 'variant', 'facade');
      if (!(variant >= 0 && variant <= 3 && (variant | 0) === variant)) throw new RangeError("texture 'facade': variant must be 0..3");
      const r = makeFacade(mulberry32(num(a, 'seed', 'facade')), variant);
      return { map: img(r.map), emissive: img(r.emis) };
    },
    size: fixed(256)
  },
  endCapTexture: {
    outputs: ['map', 'emissive'],
    run: a => {
      const r = makeEndCapTexture(num(a, 'size', 'endCapTexture'), mulberry32(num(a, 'seed', 'endCapTexture')));
      return { map: img(r.map), emissive: img(r.emis) };
    },
    size: a => { const s = num(a, 'size', 'endCapTexture'); return [s, s]; }
  },
  panelTexture: {
    outputs: [SINGLE],
    run: a => ({ [SINGLE]: img(makePanelTexture(mulberry32(num(a, 'seed', 'panelTexture')))) }),
    size: fixed(512)
  },
  softSprite: {
    outputs: [SINGLE],
    run: a => ({ [SINGLE]: img(makeSoftSprite(num(a, 'hardness', 'softSprite', 0))) }),
    size: fixed(128)
  },
  blobTexture: {
    outputs: [SINGLE],
    run: () => ({ [SINGLE]: img(makeBlobTexture()) }),
    size: fixed(128)
  },
  footprintTexture: {
    outputs: [SINGLE],
    run: () => ({ [SINGLE]: img(makeFootprintTexture()) }),
    size: fixed(256)
  },
  waterRoughness: {
    outputs: [SINGLE],
    run: a => ({
      [SINGLE]: img(makeWaterRoughness(generateImage(spec(a, 'mask', 'waterRoughness')), num(a, 'size', 'waterRoughness')))
    }),
    size: a => { const s = num(a, 'size', 'waterRoughness'); return [s, s]; }
  },
  waterNormal: {
    outputs: [SINGLE],
    run: a => ({
      [SINGLE]: img(makeWaterNormal(generateImage(spec(a, 'mask', 'waterNormal')),
        num(a, 'size', 'waterNormal'), num(a, 'strength', 'waterNormal', CORE_CONFIG.NORMALS.water)))
    }),
    size: a => { const s = num(a, 'size', 'waterNormal'); return [s, s]; }
  },
  roofTexture: {
    outputs: [SINGLE],
    run: a => ({ [SINGLE]: img(makeRoofTexture(mulberry32(num(a, 'seed', 'roofTexture')))) }),
    size: fixed(256)
  },
  leafTexture: {
    outputs: [SINGLE],
    run: a => ({ [SINGLE]: img(makeLeafTexture(mulberry32(num(a, 'seed', 'leafTexture')))) }),
    size: fixed(256)
  },
  carWindows: {
    outputs: [SINGLE],
    run: () => ({ [SINGLE]: img(makeCarWindows()) }),
    size: fixed(32)
  },
  glowTexture: {
    outputs: [SINGLE],
    run: () => ({ [SINGLE]: img(makeGlowTexture()) }),
    size: fixed(64, 8)
  },
  heightToNormal: {
    outputs: [SINGLE],
    run: a => ({
      [SINGLE]: img(heightToNormal(generateImage(spec(a, 'src', 'heightToNormal')),
        num(a, 'strength', 'heightToNormal', 1), num(a, 'size', 'heightToNormal', 0)))
    }),
    size: a => {
      const s = num(a, 'size', 'heightToNormal', 0);
      if (s) return [s, s];
      const sz = specSize(spec(a, 'src', 'heightToNormal'));
      return [sz.width, sz.height];
    }
  }
};

/** Names of all registered generators. */
export const TEXTURE_GENERATORS: readonly string[] = Object.keys(GENERATORS);

/** Output names of a generator (['image'] for single-output ones). */
export function generatorOutputs(gen: string): readonly string[] {
  return def(gen).outputs;
}

function def(gen: string): GenDef {
  const d = Object.prototype.hasOwnProperty.call(GENERATORS, gen) ? GENERATORS[gen] : undefined;
  if (!d) throw new Error(`unknown texture generator '${gen}'`);
  return d;
}

function outputOf(d: GenDef, s: TextureSpec): string {
  if (d.outputs.length === 1) return SINGLE;
  const o = s.args.output;
  if (typeof o !== 'string' || d.outputs.indexOf(o) < 0) {
    throw new Error(`texture '${s.gen}': args.output must be one of ${d.outputs.join(', ')}`);
  }
  return o;
}

/* ─── canonical keys ─── */

function canon(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && !isFinite(v)) throw new TypeError('TextureSpec: non-finite number');
    const s = JSON.stringify(v);
    return s === undefined ? 'null' : s;
  }
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter(k => o[k] !== undefined).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canon(o[k])).join(',') + '}';
}

/** Canonical JSON key of a spec (object keys sorted, undefined dropped). */
export function specKey(s: TextureSpec): string {
  return canon({ gen: s.gen, args: s.args });
}

/* ─── generation with memoization ─── */

let cache = new Map<string, PixelImage>();

/** Generate (or fetch from the cache) the pixels of a spec. Read-only result. */
export function generateImage(s: TextureSpec): PixelImage {
  const key = specKey(s);
  const hit = cache.get(key);
  if (hit) return hit;
  const d = def(s.gen);
  const want = outputOf(d, s);
  const outs = d.run(s.args);
  for (const o of d.outputs) {
    const k = o === SINGLE ? key : specKey({ gen: s.gen, args: { ...s.args, output: o } });
    cache.set(k, outs[o]);
  }
  return outs[want];
}

/** Drop every memoized image (e.g. after a seed/quality change). */
export function clearImageCache(): void {
  cache = new Map();
}

/** Number of memoized images (diagnostics/tests). */
export function imageCacheSize(): number {
  return cache.size;
}

/** Pixel size of a spec's image, without generating it. */
export function specSize(s: TextureSpec): { width: number; height: number } {
  const d = def(s.gen);
  const [width, height] = d.size(s.args, outputOf(d, s));
  return { width, height };
}

/* ─── ImageDesc ─── */

interface Sampling { colorSpace: 'srgb' | 'linear'; wrap: 'repeat' | 'clamp'; anisotropyHint: number }

/* How the legacy app configured each CanvasTexture (js/textures.js `tex`
   flags + the overrides in world.js / structures.js / main.js). All legacy
   CanvasTextures used three's defaults: mipmaps on, trilinear filtering. */
const SAMPLING: Record<string, Sampling> = {
  'hullMaps/albedo': { colorSpace: 'srgb', wrap: 'repeat', anisotropyHint: 8 },     // min(Q.aniso, max)
  'hullMaps/mask': { colorSpace: 'linear', wrap: 'repeat', anisotropyHint: 8 },     // min(Q.aniso, max)
  detailTexture: { colorSpace: 'linear', wrap: 'repeat', anisotropyHint: 4 },
  'facade/map': { colorSpace: 'srgb', wrap: 'repeat', anisotropyHint: 4 },
  'facade/emissive': { colorSpace: 'srgb', wrap: 'repeat', anisotropyHint: 1 },
  'endCapTexture/map': { colorSpace: 'srgb', wrap: 'clamp', anisotropyHint: 8 },
  'endCapTexture/emissive': { colorSpace: 'srgb', wrap: 'clamp', anisotropyHint: 1 },
  panelTexture: { colorSpace: 'srgb', wrap: 'repeat', anisotropyHint: 4 },
  roofTexture: { colorSpace: 'srgb', wrap: 'repeat', anisotropyHint: 4 },
  leafTexture: { colorSpace: 'srgb', wrap: 'clamp', anisotropyHint: 1 },
  softSprite: { colorSpace: 'srgb', wrap: 'clamp', anisotropyHint: 1 },
  blobTexture: { colorSpace: 'srgb', wrap: 'clamp', anisotropyHint: 1 },
  footprintTexture: { colorSpace: 'srgb', wrap: 'clamp', anisotropyHint: 1 },
  glowTexture: { colorSpace: 'srgb', wrap: 'clamp', anisotropyHint: 1 },
  carWindows: { colorSpace: 'srgb', wrap: 'clamp', anisotropyHint: 1 },
  waterRoughness: { colorSpace: 'linear', wrap: 'repeat', anisotropyHint: 1 },
  waterNormal: { colorSpace: 'linear', wrap: 'repeat', anisotropyHint: 1 },
  heightToNormal: { colorSpace: 'linear', wrap: 'repeat', anisotropyHint: 1 }
};

export interface ImageDescOptions {
  colorSpace?: 'srgb' | 'linear';
  wrap?: 'repeat' | 'clamp';
  mipmaps?: boolean;
  anisotropyHint?: number;
  /** generate the pixels now and attach them as `data` */
  withData?: boolean;
}

/**
 * ImageDesc for a spec, with the legacy sampling defaults (colour space,
 * wrap, anisotropy); `opts` overrides them. `id` is only validated (must be
 * non-empty) — ids live in ./ids.ts (TEX).
 */
export function imageDesc(id: string, s: TextureSpec, opts: ImageDescOptions = {}): ImageDesc {
  if (!id) throw new Error('imageDesc: empty image id');
  const d = def(s.gen);
  const out = outputOf(d, s);
  const smp = SAMPLING[out === SINGLE ? s.gen : `${s.gen}/${out}`];
  const { width, height } = specSize(s);
  const desc: ImageDesc = {
    width, height,
    format: 'rgba8',
    colorSpace: opts.colorSpace || smp.colorSpace,
    wrap: opts.wrap || smp.wrap,
    mipmaps: opts.mipmaps !== undefined ? opts.mipmaps : true,
    origin: 'top-left',
    anisotropyHint: opts.anisotropyHint !== undefined ? opts.anisotropyHint : smp.anisotropyHint,
    source: s
  };
  if (opts.withData) desc.data = generateImage(s).data;
  return desc;
}

/* ─── the legacy image set ─── */

export interface StandardImagesOptions {
  /** CONFIG.SEED */
  seed: number;
  /** quality preset id (CORE_CONFIG.QUALITY key) */
  quality: keyof typeof CORE_CONFIG.QUALITY;
  /** pond list from the hull layout (world.js: dips of displaceHills) */
  ponds?: Pond[];
}

/**
 * Every image the legacy app creates for a seed/quality, keyed by TEX id —
 * exactly the generator calls of js/world.js, js/structures.js, js/main.js.
 * Normal maps are omitted when the preset has `normals: 0`, like legacy.
 */
export function standardImages(o: StandardImagesOptions): Record<string, ImageDesc> {
  const Q = CORE_CONFIG.QUALITY[o.quality];
  const N = CORE_CONFIG.NORMALS;
  const S = o.seed;
  const out: Record<string, ImageDesc> = {};
  const put = (id: string, s: TextureSpec, opts?: ImageDescOptions): TextureSpec => {
    out[id] = imageDesc(id, s, opts);
    return s;
  };
  const nrm = (id: string, src: TextureSpec, strength: number, size: number): void => {
    if (Q.normals) put(id, { gen: 'heightToNormal', args: { src, strength, size } });
  };

  /* hull (world.js) */
  const hullArgs = { size: Q.hullTex, maskSize: Q.mask, seed: S + 7, worldSeed: S, ponds: o.ponds || [] };
  const albedo = put(TEX.hullAlbedo, { gen: 'hullMaps', args: { ...hullArgs, output: 'albedo' } }, { anisotropyHint: Q.aniso });
  const mask = put(TEX.hullMask, { gen: 'hullMaps', args: { ...hullArgs, output: 'mask' } }, { anisotropyHint: Q.aniso });
  nrm(TEX.hullNormal, albedo, N.hull, Q.normals);
  put(TEX.detail, { gen: 'detailTexture', args: { seed: S + 11 } });
  const wsize = Math.min(1024, Q.mask);
  put(TEX.waterRough, { gen: 'waterRoughness', args: { mask, size: wsize } });
  put(TEX.waterNormal, { gen: 'waterNormal', args: { mask, size: wsize, strength: N.water } });

  /* city (world.js) */
  const roof = put(TEX.roof, { gen: 'roofTexture', args: { seed: S + 77 } });
  nrm(TEX.roofNormal, roof, N.roof, 256);
  for (let v = 0; v < 4; v++) {
    const fa = { seed: S + 31 * (v + 1), variant: v };
    const map = put(TEX.facade(v), { gen: 'facade', args: { ...fa, output: 'map' } });
    put(TEX.facadeEmissive(v), { gen: 'facade', args: { ...fa, output: 'emissive' } });
    nrm(TEX.facadeNormal(v), map, N.facade, 0);
  }
  put(TEX.carWindows, { gen: 'carWindows', args: {} });

  /* structures (world.js panel, structures.js end caps) */
  const panel = put(TEX.panel, { gen: 'panelTexture', args: { seed: S + 53 } });
  nrm(TEX.panelNormal, panel, N.panel, 0);
  const ea = { size: o.quality === 'LOW' ? 512 : 1024, seed: S + 99 };
  const cap = put(TEX.endcap, { gen: 'endCapTexture', args: { ...ea, output: 'map' } });
  put(TEX.endcapEmissive, { gen: 'endCapTexture', args: { ...ea, output: 'emissive' } });
  nrm(TEX.endcapNormal, cap, N.endcap, 1024);

  /* greenery */
  const leaf = put(TEX.leaf, { gen: 'leafTexture', args: { seed: S + 61 } });
  nrm(TEX.leafNormal, leaf, N.leaf, 256);

  /* decals & sprites (world.js, main.js) */
  put(TEX.blob, { gen: 'blobTexture', args: {} });
  if (Q.footprint) put(TEX.footprint, { gen: 'footprintTexture', args: {} });
  put(TEX.spriteNav, { gen: 'softSprite', args: { hardness: 0.5 } });
  put(TEX.spriteCloud, { gen: 'softSprite', args: { hardness: 0 } });
  put(TEX.spriteMote, { gen: 'softSprite', args: { hardness: 0.3 } });
  put(TEX.glow, { gen: 'glowTexture', args: {} });
  return out;
}
