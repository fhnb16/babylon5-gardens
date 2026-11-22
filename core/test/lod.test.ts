/* classifyLod: port of updateTreeLod — level split by crown-centre distance,
   per-chunk counts and ascending order; applyLod gives the legacy layout. */
import { describe, expect, test } from 'vitest';
import { buildWorldFragment } from '../scene/world.ts';
import { defaultParams } from '../scene/build.ts';
import { applyLod, classifyLod, createLodOut, lodNeedsUpdate } from '../scene/lod.ts';

const lod = buildWorldFragment(defaultParams('LOW')).fragment.lodSets?.[0];

describe('classifyLod', () => {
  test('crowns LOD set exists', () => {
    expect(lod?.role).toBe('crowns');
    expect(lod?.levels.map(l => l.role)).toEqual(['crowns.lod0', 'crowns.lod1', 'crowns.lod2']);
  });

  test('levels by distance; counts sum to chunk size; order ascending', () => {
    if (!lod) throw new Error('no lod');
    const cam = [10, 30, -40];
    const out = classifyLod(lod, cam, false, createLodOut(lod));
    const N = lod.matrices.length / 16;
    const seen = new Uint8Array(N);
    lod.chunks.forEach((ch, c) => {
      let sum = 0;
      for (let li = 0; li < 3; li++) {
        const cnt = out.counts[c * 3 + li];
        sum += cnt;
        let prev = -1;
        for (let i = 0; i < cnt; i++) {
          const k = out.order[li * N + ch.start + i];
          expect(k).toBeGreaterThan(prev);
          expect(k >= ch.start && k < ch.start + ch.count).toBe(true);
          prev = k;
          seen[k]++;
          const dx = lod.centers[k * 3] - cam[0], dy = lod.centers[k * 3 + 1] - cam[1], dz = lod.centers[k * 3 + 2] - cam[2];
          const d2 = dx * dx + dy * dy + dz * dz;
          const want = d2 < lod.near ** 2 ? 0 : d2 < lod.mid ** 2 ? 1 : 2;
          expect(li).toBe(want);
        }
      }
      expect(sum).toBe(ch.count);
    });
    expect(seen.every(v => v === 1)).toBe(true);
    expect(out.counts.some((v, i) => i % 3 === 0 && v > 0)).toBe(true);
    expect(out.counts.some((v, i) => i % 3 === 2 && v > 0)).toBe(true);
  });

  test('full = everything on level 0; applyLod reproduces the build-time lod0 arrays', () => {
    if (!lod) throw new Error('no lod');
    const out = classifyLod(lod, [0, 0, 0], true, createLodOut(lod));
    const N = lod.matrices.length / 16;
    const mats = [0, 1, 2].map(() => new Float32Array(N * 16));
    const cols = [0, 1, 2].map(() => new Float32Array(N * 3));
    applyLod(lod, out, mats, cols);
    expect(mats[0]).toEqual(lod.matrices);
    expect(cols[0]).toEqual(lod.colors);
  });

  test('throttle by step', () => {
    expect(lodNeedsUpdate([0, 0, 0], [0, 0, 5.9], 6)).toBe(false);
    expect(lodNeedsUpdate([0, 0, 0], [0, 0, 6], 6)).toBe(true);
  });
});
