/* Vose alias table (Vose 1991, "A linear algorithm for generating random
   numbers with a given distribution") — the L1 light selector: O(1) sampling
   proportional to the emitted power, position independent. Mirror of
   b5_alias_sample (light_tree.wgsl). */

export interface AliasTable {
  /** acceptance probability per bin */
  q: Float32Array;
  /** alias index per bin */
  alias: Uint32Array;
  /** normalised pmf per entry */
  pmf: Float32Array;
  total: number;
}

export function buildAlias(weights: ArrayLike<number>): AliasTable {
  const n = weights.length;
  const q = new Float32Array(n), alias = new Uint32Array(n), pmf = new Float32Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) total += Math.max(0, weights[i]);
  if (!(total > 0)) return { q, alias, pmf, total: 0 };
  const scaled = new Float64Array(n);
  const small: number[] = [], large: number[] = [];
  for (let i = 0; i < n; i++) {
    pmf[i] = Math.max(0, weights[i]) / total;
    scaled[i] = (Math.max(0, weights[i]) / total) * n;
    (scaled[i] < 1 ? small : large).push(i);
  }
  while (small.length && large.length) {
    const s = small.pop()!, l = large.pop()!;
    q[s] = scaled[s];
    alias[s] = l;
    scaled[l] = scaled[l] + scaled[s] - 1;
    (scaled[l] < 1 ? small : large).push(l);
  }
  for (const i of large) { q[i] = 1; alias[i] = i; }
  for (const i of small) { q[i] = 1; alias[i] = i; } // numerical leftovers
  return { q, alias, pmf, total };
}

/** Sample an index with u ∈ [0, 1) (one dimension, like the WGSL). */
export function sampleAlias(t: AliasTable, u: number): number {
  const n = t.q.length;
  const x = u * n;
  const i = Math.min(Math.floor(x), n - 1);
  const v = x - i;
  return v < t.q[i] ? i : t.alias[i];
}
