/* core/textures: determinism, rnd() call-count parity with js/textures.js,
   golden hashes (seed 1337), sizes/formats per image id, timing of the full
   HIGH set.

   Golden hashes: core/test/golden/textures.json. Regenerate ONLY for an
   intentional change: `$env:UPDATE_GOLDEN='1'; npx vitest run core/test/textures.test.ts`. */
import '../../test/dom-stub.mjs';
import { describe, test, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as L from '../../test/legacy-oracle/textures.js';
import { CONFIG } from '../../js/config.js';
import {
  TEX, generateImage, clearImageCache, imageCacheSize, specKey, specSize, imageDesc, standardImages,
  generatorOutputs, TEXTURE_GENERATORS,
  makeHullMaps, makeDetailTexture, makeFacade, makeEndCapTexture, makePanelTexture, makeRoofTexture, makeLeafTexture
} from '../textures/index.ts';
import type { Pond } from '../textures/index.ts';
import type { TextureSpec } from '../scene/types.ts';
import { mulberry32 } from '../rng.ts';
import type { Rng } from '../rng.ts';

const SEED = 1337;
const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), 'golden', 'textures.json');
const PONDS: Pond[] = [
  { t: 1.31, z: -40, r: 4.2, ax: 1.4, rot: 0.6 },
  { t: 5.40, z: 62, r: 6.1, ax: 0.7, rot: -0.3 },
  { t: 3.05, z: 10, r: 3.3, ax: 1.0, rot: 0 }
];

/** FNV-1a 32 over the bytes, hex. */
function fnv(data: ArrayLike<number>): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) { h ^= data[i]; h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function counting(seed: number): { rnd: Rng; n: () => number } {
  const r = mulberry32(seed);
  let n = 0;
  return { rnd: () => { n++; return r(); }, n: () => n };
}

describe('rnd() call-count parity with js/textures.js', () => {
  /* the legacy hull reads CONFIG.SEED through cellInfo (park blocks draw with rnd) */
  const withSeed = <T>(fn: () => T): T => {
    const old = CONFIG.SEED; CONFIG.SEED = SEED;
    try { return fn(); } finally { CONFIG.SEED = old; }
  };
  /* [name, legacy(rnd), core(rnd)] */
  const cases: [string, (r: Rng) => unknown, (r: Rng) => unknown][] = [
    ['hullMaps 2048/1024 + ponds', r => withSeed(() => L.makeHullMaps(2048, 1024, r, PONDS)),
      r => makeHullMaps(2048, 1024, r, PONDS, { worldSeed: SEED })],
    ['hullMaps 1024/512', r => withSeed(() => L.makeHullMaps(1024, 512, r, [])),
      r => makeHullMaps(1024, 512, r, [], { worldSeed: SEED })],
    ['detailTexture', r => L.makeDetailTexture(r), r => makeDetailTexture(r)],
    ...[0, 1, 2, 3].map(v => [`facade ${v}`, (r: Rng) => L.makeFacade(r, v), (r: Rng) => makeFacade(r, v)] as
      [string, (r: Rng) => unknown, (r: Rng) => unknown]),
    ['endCapTexture 1024', r => L.makeEndCapTexture(1024, r), r => makeEndCapTexture(1024, r)],
    ['endCapTexture 512', r => L.makeEndCapTexture(512, r), r => makeEndCapTexture(512, r)],
    ['panelTexture', r => L.makePanelTexture(r), r => makePanelTexture(r)],
    ['roofTexture', r => L.makeRoofTexture(r), r => makeRoofTexture(r)],
    ['leafTexture', r => L.makeLeafTexture(r), r => makeLeafTexture(r)]
  ];
  const counts: Record<string, [number, number]> = {};
  for (const [name, legacy, core] of cases) {
    test(name, () => {
      for (const seed of [SEED + 7, 42]) {
        const a = counting(seed), b = counting(seed);
        legacy(a.rnd);
        core(b.rnd);
        expect(b.n(), `${name} seed ${seed}`).toBe(a.n());
        expect(a.n()).toBeGreaterThan(0);
        if (seed !== 42) counts[name] = [a.n(), b.n()];
      }
    });
  }
  test('report', () => {
    console.log('rnd() calls legacy/core:\n' + Object.entries(counts).map(([k, [a, b]]) => `  ${k}: ${a}/${b}`).join('\n'));
  });
});

describe('registry', () => {
  test('specKey is canonical (key order, undefined fields)', () => {
    const a = specKey({ gen: 'facade', args: { seed: 1, variant: 2, output: 'map' } });
    const b = specKey({ gen: 'facade', args: { output: 'map', variant: 2, seed: 1, extra: undefined } });
    expect(a).toBe(b);
    expect(specKey({ gen: 'facade', args: { seed: 1, variant: 2, output: 'emissive' } })).not.toBe(a);
  });

  test('every generator is registered with its outputs', () => {
    expect([...TEXTURE_GENERATORS].sort()).toEqual([
      'blobTexture', 'carWindows', 'detailTexture', 'endCapTexture', 'facade', 'footprintTexture',
      'glowTexture', 'heightToNormal', 'hullMaps', 'leafTexture', 'panelTexture', 'roofTexture',
      'softSprite', 'waterNormal', 'waterRoughness'
    ]);
    expect(generatorOutputs('hullMaps')).toEqual(['albedo', 'mask']);
    expect(generatorOutputs('facade')).toEqual(['map', 'emissive']);
    expect(generatorOutputs('endCapTexture')).toEqual(['map', 'emissive']);
  });

  test('errors: unknown generator, missing output, bad args', () => {
    expect(() => generateImage({ gen: 'nope', args: {} })).toThrow(/unknown texture generator/);
    expect(() => generateImage({ gen: 'facade', args: { seed: 1, variant: 0 } })).toThrow(/output/);
    expect(() => generateImage({ gen: 'facade', args: { seed: 1, variant: 7, output: 'map' } })).toThrow(/variant/);
    expect(() => generateImage({ gen: 'roofTexture', args: {} })).toThrow(/seed/);
    expect(() => generateImage({ gen: 'heightToNormal', args: { strength: 1 } })).toThrow(/TextureSpec/);
  });

  test('memoization: multi-output generators run once, every output cached', () => {
    clearImageCache();
    const args = { seed: SEED + 99, size: 512 };
    const map = generateImage({ gen: 'endCapTexture', args: { ...args, output: 'map' } });
    expect(imageCacheSize()).toBe(2);
    const emis = generateImage({ gen: 'endCapTexture', args: { output: 'emissive', ...args } });
    expect(imageCacheSize()).toBe(2);
    expect(emis).not.toBe(map);
    expect(generateImage({ gen: 'endCapTexture', args: { ...args, output: 'map' } })).toBe(map);
    clearImageCache();
    expect(imageCacheSize()).toBe(0);
  });

  test('determinism: same spec ⇒ identical bytes after a cache flush', () => {
    const specs: TextureSpec[] = [
      { gen: 'hullMaps', args: { size: 512, maskSize: 256, seed: SEED + 7, worldSeed: SEED, ponds: PONDS, output: 'albedo' } },
      { gen: 'panelTexture', args: { seed: SEED + 53 } },
      { gen: 'leafTexture', args: { seed: SEED + 61 } },
      { gen: 'heightToNormal', args: { src: { gen: 'roofTexture', args: { seed: SEED + 77 } }, strength: 1.8, size: 256 } },
      { gen: 'waterNormal', args: { mask: { gen: 'hullMaps', args: { size: 512, maskSize: 256, seed: SEED + 7, worldSeed: SEED, ponds: PONDS, output: 'mask' } }, size: 256, strength: 1.5 } }
    ];
    clearImageCache();
    const first = specs.map(s => fnv(generateImage(s).data));
    clearImageCache();
    const second = specs.map(s => fnv(generateImage(s).data));
    expect(second).toEqual(first);
    /* a different seed gives a different image */
    expect(fnv(generateImage({ gen: 'panelTexture', args: { seed: SEED + 54 } }).data)).not.toBe(first[1]);
    clearImageCache();
  });

  test('worldSeed defaults to seed − 7 (the legacy wiring rnd = SEED + 7)', () => {
    const base = { size: 256, maskSize: 128, seed: SEED + 7, ponds: [], output: 'albedo' };
    const a = generateImage({ gen: 'hullMaps', args: base });
    const b = generateImage({ gen: 'hullMaps', args: { ...base, worldSeed: SEED } });
    expect(fnv(a.data)).toBe(fnv(b.data));
    clearImageCache();
  });
});

describe('image set per id', () => {
  const SRGB = new Set<string>([TEX.hullAlbedo, TEX.roof, TEX.carWindows, TEX.panel, TEX.endcap, TEX.endcapEmissive,
    TEX.leaf, TEX.blob, TEX.footprint, TEX.spriteNav, TEX.spriteCloud, TEX.spriteMote, TEX.glow,
    ...[0, 1, 2, 3].flatMap(v => [TEX.facade(v), TEX.facadeEmissive(v)])]);
  const SIZE_HIGH: Record<string, [number, number]> = {
    [TEX.hullAlbedo]: [2048, 2048], [TEX.hullMask]: [1024, 1024], [TEX.hullNormal]: [1024, 1024],
    [TEX.detail]: [256, 256], [TEX.waterRough]: [1024, 1024], [TEX.waterNormal]: [1024, 1024],
    [TEX.roof]: [256, 256], [TEX.roofNormal]: [256, 256], [TEX.carWindows]: [32, 32],
    [TEX.panel]: [512, 512], [TEX.panelNormal]: [512, 512],
    [TEX.endcap]: [1024, 1024], [TEX.endcapEmissive]: [1024, 1024], [TEX.endcapNormal]: [1024, 1024],
    [TEX.leaf]: [256, 256], [TEX.leafNormal]: [256, 256],
    [TEX.blob]: [128, 128], [TEX.footprint]: [256, 256],
    [TEX.spriteNav]: [128, 128], [TEX.spriteCloud]: [128, 128], [TEX.spriteMote]: [128, 128], [TEX.glow]: [64, 8],
    ...Object.fromEntries([0, 1, 2, 3].flatMap(v => [
      [TEX.facade(v), [256, 256]], [TEX.facadeEmissive(v), [256, 256]], [TEX.facadeNormal(v), [256, 256]]]))
  };

  test('HIGH: every TEX id, sizes, formats, colour spaces, wraps; generated pixels match the desc', () => {
    clearImageCache();
    const set = standardImages({ seed: SEED, quality: 'HIGH', ponds: PONDS });
    expect(Object.keys(set).sort()).toEqual(Object.keys(SIZE_HIGH).sort());
    const t0 = performance.now();
    for (const [id, d] of Object.entries(set)) {
      expect([d.width, d.height], id).toEqual(SIZE_HIGH[id]);
      expect(d.format).toBe('rgba8');
      expect(d.origin).toBe('top-left');
      expect(d.mipmaps).toBe(true);
      expect(d.colorSpace, id).toBe(SRGB.has(id) ? 'srgb' : 'linear');
      const im = generateImage(d.source);
      expect([im.width, im.height], id).toEqual([d.width, d.height]);
      expect(im.data.length).toBe(d.width * d.height * 4);
      expect(specSize(d.source)).toEqual({ width: d.width, height: d.height });
    }
    const ms = performance.now() - t0;
    console.log(`full HIGH texture set (${Object.keys(set).length} images): ${ms.toFixed(0)} ms (target < 2000 ms)`);
    expect(ms).toBeLessThan(10000);   // loose: CI machines vary; the target is printed above
    /* wrap/anisotropy as the legacy app configured them */
    expect(set[TEX.hullAlbedo].wrap).toBe('repeat');
    expect(set[TEX.hullAlbedo].anisotropyHint).toBe(CONFIG.QUALITY.HIGH.aniso);
    expect(set[TEX.endcap].wrap).toBe('clamp');
    expect(set[TEX.endcap].anisotropyHint).toBe(8);
    expect(set[TEX.facade(0)].wrap).toBe('repeat');
    expect(set[TEX.leaf].wrap).toBe('clamp');
    expect(set[TEX.spriteNav].wrap).toBe('clamp');
    expect(set[TEX.hullNormal].wrap).toBe('repeat');
    /* hull maps are NOT flipped (the core hull bakes θ-correct UVs) */
    expect(set[TEX.hullAlbedo].source).toEqual({ gen: 'hullMaps',
      args: { size: 2048, maskSize: 1024, seed: SEED + 7, worldSeed: SEED, ponds: PONDS, output: 'albedo' } });
    clearImageCache();
  });

  test('LOW: no normal maps, no footprint, smaller hull and end cap', () => {
    const set = standardImages({ seed: SEED, quality: 'LOW' });
    expect(set[TEX.hullNormal]).toBeUndefined();
    expect(set[TEX.facadeNormal(0)]).toBeUndefined();
    expect(set[TEX.footprint]).toBeUndefined();
    expect([set[TEX.hullAlbedo].width, set[TEX.hullMask].width, set[TEX.endcap].width]).toEqual([1024, 512, 512]);
    expect(set[TEX.waterRough].width).toBe(512);
    expect(set[TEX.hullAlbedo].anisotropyHint).toBe(CONFIG.QUALITY.LOW.aniso);
  });

  test('ULTRA: hull normal at 2048, water maps capped at 1024', () => {
    const set = standardImages({ seed: SEED, quality: 'ULTRA' });
    expect(set[TEX.hullNormal].width).toBe(2048);
    expect(set[TEX.hullMask].width).toBe(2048);
    expect(set[TEX.waterRough].width).toBe(1024);
  });

  test('imageDesc options override the defaults and can attach data', () => {
    const s: TextureSpec = { gen: 'glowTexture', args: {} };
    const d = imageDesc(TEX.glow, s, { wrap: 'repeat', anisotropyHint: 2, mipmaps: false, withData: true });
    expect(d).toMatchObject({ width: 64, height: 8, wrap: 'repeat', anisotropyHint: 2, mipmaps: false, colorSpace: 'srgb' });
    expect(d.data!.length).toBe(64 * 8 * 4);
    expect(() => imageDesc('', s)).toThrow();
    clearImageCache();
  });
});

describe('golden hashes (seed 1337)', () => {
  test('HIGH + LOW sets match core/test/golden/textures.json', () => {
    const got: Record<string, string> = {};
    /* identical specs in both sets hash the same: LOW lists only what differs */
    const highKeys = new Set(Object.values(standardImages({ seed: SEED, quality: 'HIGH', ponds: PONDS })).map(d => specKey(d.source)));
    for (const q of ['HIGH', 'LOW'] as const) {
      clearImageCache();
      const set = standardImages({ seed: SEED, quality: q, ponds: PONDS });
      for (const [id, d] of Object.entries(set)) {
        if (q === 'LOW' && highKeys.has(specKey(d.source))) continue;
        got[`${q}:${id}`] = `${d.width}x${d.height}:${fnv(generateImage(d.source).data)}`;
      }
    }
    clearImageCache();
    if (process.env.UPDATE_GOLDEN) {
      mkdirSync(dirname(GOLDEN), { recursive: true });
      writeFileSync(GOLDEN, JSON.stringify(got, null, 2) + '\n');
      console.log(`wrote ${GOLDEN} (${Object.keys(got).length} hashes)`);
    }
    const want = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, string>;
    expect(got).toEqual(want);
  });
});
