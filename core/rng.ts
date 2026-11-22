/* ═══════════════════════════════════════════════════════════════════════════
   Deterministic PRNG. Exact port of js/util.js `mulberry32` / `pick`:
   the sequences are bit-identical, so the call order of rnd() in world
   generation stays the single source of truth (see AGENTS.md, Determinism).
   ═══════════════════════════════════════════════════════════════════════════ */

/** Seeded generator returning floats in [0, 1). */
export type Rng = () => number;

export function mulberry32(a: number): Rng {
  return function (): number {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform element of `arr`; consumes exactly one rnd() call. */
export const pick = <T>(rnd: Rng, arr: ArrayLike<T>): T => arr[(rnd() * arr.length) | 0];
