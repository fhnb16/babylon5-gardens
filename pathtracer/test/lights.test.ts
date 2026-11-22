/* PT-W4a light sampling, CPU side: tube equiangular sampling (pdf
   normalisation, sample/eval consistency, MC irradiance vs quadrature,
   variance vs the M1 uniform-area strategy), Vose alias table (χ²), light
   BVH (pmf sums to 1, sample/pmf consistency, χ² of the traversal), the
   light data layout, and the WGSL sources (parse). GPU agreement:
   tests/browser/pt-unit.spec.ts. */
import { describe, expect, test } from 'vitest';
import { mulberry32 } from '../../core/rng.ts';
import { buildAlias, sampleAlias } from '../lights/alias.ts';
import { LDATA_HEADER_ROWS, LIGHT_ROWS, LNODE_ROWS, packLights } from '../lights/light-data.ts';
import { NO_NODE, buildLightTree, coneUnion, importance, treePmf, treeSample, triangleBounds } from '../lights/light-tree.ts';
import { pTube } from '../lights/select.ts';
import { tubeIrradianceQuad, tubePdfA, tubePdfW, tubeSample, tubeSampleUniform, type TubeGeom, type V3 } from '../lights/tube.ts';
import { LIGHT_MODE } from '../config.ts';

const TUBE: TubeGeom = { radius: 2.2, length: 276, z0: -138 };

/** χ² statistic and a generous critical value (Wilson–Hilferty, p ≈ 1e-4) */
function chi2(counts: number[], expected: number[]): { stat: number; crit: number } {
  let stat = 0, dof = -1;
  for (let i = 0; i < counts.length; i++) {
    if (expected[i] < 5) continue;
    stat += (counts[i] - expected[i]) ** 2 / expected[i];
    dof++;
  }
  const z = 3.72;
  const crit = dof * (1 - 2 / (9 * dof) + z * Math.sqrt(2 / (9 * dof))) ** 3;
  return { stat, crit };
}

/* hull points: floor (ρ = 50) at several z, plus points nearer the axis */
const POINTS: { p: V3; n: V3 }[] = [
  { p: [0, -50, 0], n: [0, 1, 0] },
  { p: [35.36, 35.36, 90], n: [-0.7071, -0.7071, 0] },
  { p: [-48, 10, -130], n: [0.979, -0.204, 0] },
  { p: [0, -49, 150], n: [0, 1, 0] },          // beyond the tube end
  { p: [6, 3, 20], n: [-0.894, -0.447, 0] },    // near the axis (truss / spine)
  { p: [12, -20, -60], n: [0, 0, 1] }            // vertical surface
];

describe('tube: equiangular z × projected-width φ', () => {
  test.each(POINTS.map((x, i) => [i, x] as const))('point %i: area pdf integrates to 1 over the visible band', (_i, { p }) => {
    // quadrature over the visible band in (Δφ, z) with the substitution of tubeIrradianceQuad
    const rho = Math.hypot(p[0], p[1]), phiMax = Math.acos(TUBE.radius / rho);
    const h = Math.sqrt(rho * rho - TUBE.radius ** 2);
    const th0 = Math.atan((TUBE.z0 - p[2]) / h), th1 = Math.atan((TUBE.z0 + TUBE.length - p[2]) / h);
    const N = 400;
    let s = 0;
    for (let i = 0; i < N; i++) {
      const dphi = -phiMax + ((i + 0.5) / N) * 2 * phiMax;
      const ang = Math.atan2(p[1], p[0]) + dphi;
      for (let j = 0; j < N; j++) {
        const th = th0 + ((j + 0.5) / N) * (th1 - th0);
        const z = p[2] + h * Math.tan(th);
        const x: V3 = [TUBE.radius * Math.cos(ang), TUBE.radius * Math.sin(ang), z];
        s += tubePdfA(p, x, TUBE) * TUBE.radius * (h / Math.cos(th) ** 2);
      }
    }
    s *= (2 * phiMax / N) * ((th1 - th0) / N);
    expect(s).toBeCloseTo(1, 4);
  });

  test('sample/eval consistency: tubePdfW(P, sample.x) = sample.pdfW; points on the visible band', () => {
    const rnd = mulberry32(7);
    for (const { p } of POINTS) {
      for (let k = 0; k < 2000; k++) {
        const s = tubeSample(p, TUBE, rnd(), rnd())!;
        expect(Math.hypot(s.x[0], s.x[1])).toBeCloseTo(TUBE.radius, 9);
        expect(s.x[2]).toBeGreaterThanOrEqual(TUBE.z0 - 1e-9);
        expect(s.x[2]).toBeLessThanOrEqual(TUBE.z0 + TUBE.length + 1e-9);
        expect(s.cosL).toBeGreaterThanOrEqual(-1e-12);
        if (s.cosL > 1e-9) expect(tubePdfW(p, s.x, TUBE) / s.pdfW).toBeCloseTo(1, 8);
      }
    }
    // inside the tube radius / on the axis: no sample, pdf 0
    expect(tubeSample([0.5, 0, 0], TUBE, 0.3, 0.3)).toBeNull();
    expect(tubePdfW([0, 0, 0], [2.2, 0, 0], TUBE)).toBe(0);
    // invisible (back) side: pdf 0
    expect(tubePdfW([0, -50, 0], [0, 2.2, 0], TUBE)).toBe(0);
  });

  test('MC irradiance at hull points within 1 % of the quadrature; variance vs uniform area', () => {
    const rnd = mulberry32(11);
    const N = 40000;
    const rows: string[] = [];
    for (const { p, n } of POINTS) {
      const ref = tubeIrradianceQuad(p, n, TUBE);
      const est = (sampler: typeof tubeSample) => {
        let s = 0, s2 = 0;
        for (let k = 0; k < N; k++) {
          const t = sampler(p, TUBE, rnd(), rnd());
          let v = 0;
          if (t && t.pdfW > 0) v = Math.max(0, n[0] * t.wi[0] + n[1] * t.wi[1] + n[2] * t.wi[2]) / t.pdfW;
          s += v; s2 += v * v;
        }
        const m = s / N;
        return { m, varS: Math.max(0, s2 / N - m * m) };
      };
      const eq = est(tubeSample), un = est(tubeSampleUniform);
      if (ref > 0) {
        expect(Math.abs(eq.m / ref - 1)).toBeLessThan(0.01);
        expect(Math.abs(un.m / ref - 1)).toBeLessThan(0.08);
        expect(eq.varS).toBeLessThan(un.varS);
      }
      rows.push(`  P [${p.map((x) => x.toFixed(1))}]: E quad ${ref.toFixed(5)}, equiangular ${eq.m.toFixed(5)} ` +
        `(rel σ/sample ${(Math.sqrt(eq.varS) / ref).toFixed(3)}), uniform area rel σ/sample ${(Math.sqrt(un.varS) / ref).toFixed(3)}, ` +
        `variance ratio ×${(un.varS / Math.max(eq.varS, 1e-30)).toFixed(0)}`);
    }
    console.log('[tube] irradiance (unit radiance) and per-sample variance:\n' + rows.join('\n'));
  });
});

describe('alias table (Vose)', () => {
  test('χ² of 1e6 samples over skewed weights', () => {
    const rnd = mulberry32(3);
    const w = Array.from({ length: 200 }, (_, i) => (i % 17 === 0 ? 0 : (1 + Math.sin(i)) ** 3 + (i === 5 ? 500 : 0)));
    const t = buildAlias(w);
    const N = 1_000_000, counts = new Array(w.length).fill(0);
    for (let k = 0; k < N; k++) counts[sampleAlias(t, rnd())]++;
    const total = w.reduce((a, b) => a + b, 0);
    const { stat, crit } = chi2(counts, w.map((x) => (x / total) * N));
    expect(stat).toBeLessThan(crit);
    for (let i = 0; i < w.length; i += 17) expect(counts[i]).toBe(0); // zero-weight entries never drawn
    expect(t.pmf.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
  });
});

/** random emissive triangles in a station-like volume */
function randomLights(n: number, seed: number) {
  const rnd = mulberry32(seed);
  const verts = new Float32Array(n * 9), phi = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const th = rnd() * 2 * Math.PI, r = 30 + rnd() * 20, z = -140 + rnd() * 280;
    const c = [r * Math.cos(th), r * Math.sin(th), z];
    const s = 0.2 + rnd() * 2;
    for (let v = 0; v < 3; v++) for (let k = 0; k < 3; k++) verts[i * 9 + v * 3 + k] = c[k] + (rnd() - 0.5) * s;
    phi[i] = rnd() < 0.1 ? 0 : rnd() ** 4 * 100;
  }
  return { verts, phi };
}

describe('light BVH', () => {
  const { verts, phi } = randomLights(3000, 21);
  const bounds = Array.from({ length: 3000 }, (_, i) =>
    triangleBounds(verts.subarray(i * 9, i * 9 + 3), verts.subarray(i * 9 + 3, i * 9 + 6), verts.subarray(i * 9 + 6, i * 9 + 9), phi[i]));
  const tree = buildLightTree(bounds);
  const RX: { p: V3; n: V3 }[] = [
    { p: [0, -50, 0], n: [0, 1, 0] }, { p: [20, 30, 100], n: [0, 0, 0] }, { p: [-40, -10, -120], n: [0.97, 0.24, 0] }
  ];

  test('structure: 2·active − 1 nodes, parents, zero-power lights excluded', () => {
    const active = phi.filter((x) => x > 0).length;
    expect(tree.nodes.length).toBe(2 * active - 1);
    for (let i = 0; i < phi.length; i++) expect(tree.leafOf[i] === NO_NODE).toBe(!(phi[i] > 0));
    tree.nodes.forEach((nd, i) => {
      if (!nd.leaf) { expect(tree.nodes[nd.child0].parent).toBe(i); expect(tree.nodes[nd.child1].parent).toBe(i); }
    });
  });

  test.each(RX.map((x, i) => [i, x] as const))('receiver %i: pmf sums to 1, sample/pmf consistency, χ²', (_i, { p, n }) => {
    let sum = 0;
    const pmf = Array.from({ length: phi.length }, (_, i) => treePmf(tree, p, n, i));
    for (const x of pmf) sum += x;
    expect(sum).toBeCloseTo(1, 9);
    const rnd = mulberry32(5);
    const N = 400_000, counts = new Array(phi.length).fill(0);
    for (let k = 0; k < N; k++) {
      const s = treeSample(tree, p, n, rnd())!;
      expect(s.pmf / pmf[s.light]).toBeCloseTo(1, 9);
      counts[s.light]++;
    }
    const { stat, crit } = chi2(counts, pmf.map((x) => x * N));
    expect(stat).toBeLessThan(crit);
  });

  test('importance: conservative — 0 only when every emitter faces away / no power', () => {
    const b = triangleBounds([0, 0, 0], [1, 0, 0], [0, 1, 0], 1);
    expect(importance(b, [0, 0, 5], [0, 0, 0])).toBeGreaterThan(0);
    expect(importance(b, [0, 0, -5], [0, 0, 0])).toBeGreaterThan(0); // two-sided
    expect(importance({ ...b, twoSided: false }, [0, 0, -5], [0, 0, 0])).toBe(0);
    expect(importance({ ...b, phi: 0 }, [0, 0, 5], [0, 0, 0])).toBe(0);
    const u = coneUnion([0, 0, 1], 1, [1, 0, 0], 1);
    expect(Math.acos(u.cos)).toBeCloseTo(Math.PI / 4, 9);
  });

  test('packLights layout + p_tube selection', () => {
    const list = { count: 3000, verts, inst: new Uint32Array(3000), tri: new Uint32Array(3000).map((_, i) => i), area: new Float32Array(3000).fill(1) };
    const pk = packLights(list, phi);
    const U = new Uint32Array(pk.data), F = new Float32Array(pk.data);
    expect(U[0]).toBe(3000);
    expect(U[1]).toBe(pk.nNodes);
    expect(U[2]).toBe(LDATA_HEADER_ROWS);
    expect(U[3]).toBe(LDATA_HEADER_ROWS + pk.nNodes * LNODE_ROWS);
    expect(U[4]).toBe(U[3] + 3000 * LIGHT_ROWS);
    expect(F[5]).toBeCloseTo(phi.reduce((a, b) => a + b, 0), 0);
    const lw = (U[3] + 7 * LIGHT_ROWS) * 4;
    expect(F[lw + 4]).toBe(verts[7 * 9 + 3]);
    expect(U[lw + 7]).toBe(7);
    // selection probability
    const pt = pTube(TUBE, 10, pk.tree, LIGHT_MODE.tree, [0, -50, 0], [0, 1, 0]);
    expect(pt).toBeGreaterThanOrEqual(0.05);
    expect(pt).toBeLessThanOrEqual(0.95);
    expect(pTube(null, 10, pk.tree, LIGHT_MODE.tree, [0, -50, 0], [0, 1, 0])).toBe(0);
    expect(pTube(TUBE, 10, null, LIGHT_MODE.none, [0, -50, 0], [0, 1, 0])).toBe(1);
    console.log(`[light tree] 3000 lights (${pk.active} with power): ${pk.nNodes} nodes, build+pack ${pk.buildMs.toFixed(0)} ms`);
  });
});
