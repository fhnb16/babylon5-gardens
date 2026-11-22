/* mulberry32 / pick must be bit-identical to the legacy js/util.js versions. */
import { describe, expect, test } from 'vitest';
import { mulberry32 as legacyMulberry, pick as legacyPick } from '../../test/legacy-oracle/util.js';
import { mulberry32, pick } from '../rng.ts';

const SEEDS = [0, 1, 7, 42, 1337, 0xdeadbeef, 2 ** 31, -1, 4294967295, 123456789, 20241118];

describe('rng', () => {
  test('mulberry32: 10k draws match legacy bit-for-bit on many seeds', () => {
    for (const seed of SEEDS) {
      const a = mulberry32(seed), b = legacyMulberry(seed);
      for (let i = 0; i < 10000; i++) {
        const x = a(), y = b();
        // Object.is: exact equality, no tolerance
        if (!Object.is(x, y)) throw new Error(`seed ${seed} draw ${i}: ${x} !== ${y}`);
      }
    }
  });

  test('mulberry32: range is [0, 1) and generators are independent', () => {
    const r1 = mulberry32(5), r2 = mulberry32(5);
    r1(); r1();
    const v = r2();
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
    expect(mulberry32(5)()).toBe(v);
  });

  test('pick: same element and same rnd consumption as legacy', () => {
    const arr = ['a', 'b', 'c', 'd', 'e', 0x123456];
    const a = mulberry32(99), b = legacyMulberry(99);
    for (let i = 0; i < 1000; i++) expect(pick(a, arr)).toBe(legacyPick(b, arr));
    expect(a()).toBe(b());
  });
});
