/* core/geometry vs THREE (test oracle only): vertex order, UVs, indices, groups
   and normals must match. Parameter sets include every `new THREE.*Geometry(`
   call in js/world.js and js/structures.js (values from CORE_CONFIG). */
import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { CORE_CONFIG as C } from '../config/index.ts';
import { mulberry32 } from '../rng.ts';
import {
  box, cylinder, torus, plane, lathe, icosahedron, polyhedron,
  computeVertexNormals, computeBounds, toNonIndexed, mergeMeshes, applyMatrix4,
  translate, rotateX, rotateY, rotateZ, scale, rod, facadeUV, panelUV, splitRoofGroups, toGeometryDesc,
  type MeshData
} from '../geometry/index.ts';
import * as mat4 from '../math/mat4.ts';
import { mergeGeos, rod as legacyRod, facadeUV as legacyFacadeUV, panelUV as legacyPanelUV, splitRoofGroups as legacySplit } from '../../test/legacy-oracle/util.js';

const TOL = 1e-6;
/** Generators whose behaviour changed after r165 take the matching compat flag for the installed three. */
const COMPAT = THREE.REVISION === '165' ? 165 : 187;

/** Max |a-b|; also checks lengths. */
function maxDiff(a: ArrayLike<number>, b: ArrayLike<number>, what: string): number {
  expect(a.length, `${what}: length`).toBe(b.length);
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (!(d <= m)) { if (Number.isNaN(d)) throw new Error(`${what}[${i}]: NaN (${a[i]} vs ${b[i]})`); m = d; }
  }
  return m;
}

const worst: Record<string, number> = {};

function compare(label: string, mine: MeshData, g: THREE.BufferGeometry, opts: { normals?: boolean } = {}): void {
  const pos = g.attributes.position.array as Float32Array;
  const dp = maxDiff(mine.position, pos, `${label} position`);
  expect(dp, `${label} position`).toBeLessThanOrEqual(TOL);
  const du = maxDiff(mine.uv, g.attributes.uv.array, `${label} uv`);
  expect(du, `${label} uv`).toBeLessThanOrEqual(TOL);
  let dn = 0;
  if (opts.normals !== false) {
    dn = maxDiff(mine.normal, g.attributes.normal.array, `${label} normal`);
    expect(dn, `${label} normal`).toBeLessThanOrEqual(TOL);
  }
  // index: exact, including array width
  if (g.index) {
    expect(mine.index, `${label} index present`).toBeDefined();
    expect(mine.index!.constructor.name, `${label} index type`).toBe(g.index.array.constructor.name);
    expect(Array.from(mine.index!), `${label} index`).toEqual(Array.from(g.index.array));
  } else {
    expect(mine.index, `${label} index absent`).toBeUndefined();
  }
  // groups: exact
  expect(mine.groups, `${label} groups`).toEqual(g.groups.map(x => ({ start: x.start, count: x.count, slot: x.materialIndex })));
  const fam = label.split(/[(-]/)[0];
  worst[fam] = Math.max(worst[fam] ?? 0, dp, du, dn);
}

describe('box', () => {
  const W = C.RAILBEAM, S = C.AXIS.saddle;
  const cases: number[][] = [
    [1, 1, 1],
    [W.brace, W.brace, Math.hypot(W.bay, W.h * 2)],             // structures.js:86
    [W.w * 2, W.brace, W.brace],                                // :95
    [S.w * 0.22, S.r * 1.7, S.r * 2.1],                         // :289
    [0.7, 5.6, 1.5],                                            // :297
    [1.7, 1.2, 14.7],                                           // :448 spoke
    [2, 3, 4, 2, 3, 4], [1.5, 0.5, 2.5, 5, 1, 2], [3, 3, 3, 1, 4, 1],
    [-1, 2, 3]
  ];
  test.each(cases)('box(%j)', (...p) => {
    compare(`box(${p})`, box(...(p as [number, number, number])), new THREE.BoxGeometry(...(p as [number, number, number])));
  });
});

describe('cylinder', () => {
  const A = C.AXIS, col = A.column, w = A.trussW, len = 41, B = A.baseR;
  const cases: (number | boolean)[][] = [
    [C.SUN.r, C.SUN.r, C.SUN.len, 20, 1, false],                        // structures.js:39
    [0.3, 0.3, 0.22, 10],                                                // :147 wheel
    [w * col.top, w * col.bottom, len, col.seg, 1, false],               // :258 shaft
    [3.0 * 1.14, 3.0 * 1.14, col.ringH, col.seg, 1, false],             // :267 band
    [B, B * 1.06, 1.4, 20, 1, false],                                    // :274 disc
    [B * 0.78, B * 0.94, 1.1, 20, 1, false],
    [w * col.bottom * 1.6, B * 0.74, 4.2, 20, 1, false],
    [A.saddle.r, A.saddle.r, A.saddle.w, 16, 1, true],                   // :284 yoke
    [0.38, 0.75, 14, 8],                                                 // :350
    [4.6, 4.6, 18, 18, 1, false],                                        // :438 hub
    [0.075, 0.13, 1, 6],                                                 // world.js:1097 trunk
    [0.3, 0.44, 0.56, 12], [0.5, 0.84, 1, 14, 1, false], [0.26, 0.1, 0.9, 10],   // world.js cyl()
    [C.R, C.R, C.L, 128, 40, true],                                      // hull LOW (rings 40)
    [C.R, C.R, C.L, C.HULL_SEG, C.HULL_RINGS, true],                     // hull HIGH
    [C.R, C.R, C.L, 128, 128, true],
    // not used by the app but part of the contract
    [1, 0, 2, 7, 3, false], [0, 1, 2, 7, 3, false], [1, 2, 3, 9, 2, false, 0.5, 4.2],
    [1, 1, 1, 8.7, 2.2, false]
  ];
  test.each(cases)('cylinder(%j)', (...p) => {
    const a = p as [number, number, number, number, number, boolean, number, number];
    compare(`cylinder(${p})`, cylinder(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], COMPAT), new THREE.CylinderGeometry(...a));
  });
});

describe('torus', () => {
  const A = C.AXIS;
  const cases: number[][] = [
    [A.spineR + 0.6, 0.42, 6, 16],        // structures.js:51
    [A.spineR + 1.2, 0.8, 8, 20],         // :217
    [1, 0.4, 12, 48],
    [3, 1, 5, 7, Math.PI], [2, 0.3, 3, 3, 1.1]
  ];
  test.each(cases)('torus(%j)', (...p) => {
    const a = p as [number, number, number, number, number];
    compare(`torus(${p})`, torus(...a), new THREE.TorusGeometry(...a));
  });
});

describe('plane', () => {
  const cases: number[][] = [
    [2, 2], [0.16, 0.34], [1, 1], [12, C.SUN.len], [12, 12, 4, 3], [3, 5, 1, 7], [1.5, 2.5, 6, 6]
  ];
  test.each(cases)('plane(%j)', (...p) => {
    const a = p as [number, number, number, number];
    compare(`plane(${p})`, plane(...a), new THREE.PlaneGeometry(...a));
  });
});

describe('icosahedron / polyhedron', () => {
  for (const radius of [1, 1.5, 0.35]) {
    for (let detail = 0; detail <= 5; detail++) {
      test(`icosahedron(${radius}, ${detail})`, () => {
        compare(`icosahedron(${radius},${detail})`, icosahedron(radius, detail), new THREE.IcosahedronGeometry(radius, detail));
      });
    }
  }
  test('icosahedron uses CORE_CONFIG quality detail levels (foliage 0..2, beacon 1.0/1)', () => {
    for (const q of Object.values(C.QUALITY)) {
      for (const d of [q.foliage + 1, q.foliage, Math.max(0, q.foliage - 1), 0]) {
        compare(`icosahedron(1,${d}) q`, icosahedron(1, d), new THREE.IcosahedronGeometry(1, d));
      }
    }
  });
  test('polyhedron: octahedron / tetrahedron match THREE', () => {
    const oct = [1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1];
    const octI = [0, 2, 4, 0, 4, 3, 0, 3, 5, 0, 5, 2, 1, 2, 5, 1, 5, 3, 1, 3, 4, 1, 4, 2];
    for (const d of [0, 1, 3]) {
      compare(`polyhedron-oct(${d})`, polyhedron(oct, octI, 2, d), new THREE.OctahedronGeometry(2, d));
    }
    const tet = [1, 1, 1, -1, -1, 1, -1, 1, -1, 1, -1, -1];
    const tetI = [2, 1, 0, 0, 3, 2, 1, 3, 0, 2, 3, 1];
    for (const d of [0, 2]) {
      compare(`polyhedron-tet(${d})`, polyhedron(tet, tetI, 1.2, d), new THREE.TetrahedronGeometry(1.2, d));
    }
  });
});

describe('lathe', () => {
  test('endcap profile (structures.js:415) with CORE_CONFIG.ENDCAP, R = 50, 72 segments', () => {
    const E = C.ENDCAP, R = C.R;
    const prof: [number, number][] = [];
    for (let k = 0; k <= E.rings; k++) {
      const u = k / E.rings;
      const r = R * (1 - u);
      const depth = E.depth * Math.pow(u, E.curve);
      prof.push([Math.max(0.6, r), depth]);
      if (k < E.rings) prof.push([Math.max(0.6, r - R / E.rings * E.step), depth]);
    }
    compare('lathe(endcap)', lathe(prof, 72, 0, Math.PI * 2, COMPAT), new THREE.LatheGeometry(prof.map(p => new THREE.Vector2(p[0], p[1])), 72));
  });

  test('other profiles / phi ranges', () => {
    const profs: [number, number][][] = [
      [[0, -0.5], [0.5, 0], [0, 0.5]],                                   // three default
      [[1, 0], [1, 1]], [[0.2, 0], [1, 0.3], [0.8, 0.9], [0.1, 1.4], [0.5, 2]],
      [[1, 0], [0.5, 0.5], [0.5, 1], [1, 1.5], [1.2, 2]]
    ];
    for (const p of profs) {
      for (const [seg, ps, pl] of [[12, 0, Math.PI * 2], [5, 0.7, 4], [9, 0, 10], [3, 1, -1]] as number[][]) {
        compare(`lathe(${JSON.stringify(p)},${seg},${ps},${pl})`, lathe(p, seg, ps, pl, COMPAT),
          new THREE.LatheGeometry(p.map(q => new THREE.Vector2(q[0], q[1])), seg, ps, pl));
      }
    }
    compare('lathe(default)', lathe(undefined, 12, 0, Math.PI * 2, COMPAT), new THREE.LatheGeometry());
  });
});

describe('computeVertexNormals', () => {
  const rnd = mulberry32(77);

  test('indexed (smooth) and non-indexed (flat) after random displacement, like foliageGeo/displaceHills', () => {
    // indexed: displaced hull-like cylinder and a plane
    for (const mk of [
      (): [MeshData, THREE.BufferGeometry] => [cylinder(2, 2, 10, 24, 6, true), new THREE.CylinderGeometry(2, 2, 10, 24, 6, true)],
      (): [MeshData, THREE.BufferGeometry] => [plane(4, 4, 9, 7), new THREE.PlaneGeometry(4, 4, 9, 7)],
      (): [MeshData, THREE.BufferGeometry] => [torus(3, 1, 8, 12), new THREE.TorusGeometry(3, 1, 8, 12)]
    ]) {
      const [m, g] = mk();
      const p = g.attributes.position;
      for (let k = 0; k < p.count; k++) {
        const dx = (rnd() - 0.5) * 0.4, dy = (rnd() - 0.5) * 0.4, dz = (rnd() - 0.5) * 0.4;
        p.setXYZ(k, p.getX(k) + dx, p.getY(k) + dy, p.getZ(k) + dz);
        m.position[3 * k] = p.getX(k); m.position[3 * k + 1] = p.getY(k); m.position[3 * k + 2] = p.getZ(k);
      }
      g.computeVertexNormals();
      computeVertexNormals(m);
      compare('cvn-indexed', m, g);
    }
    // non-indexed: foliage-like icosahedron with wobble
    for (const det of [0, 1, 2]) {
      const m = icosahedron(1, det), g = new THREE.IcosahedronGeometry(1, det);
      const p = g.attributes.position;
      for (let k = 0; k < p.count; k++) {
        const s = 1 + (rnd() - 0.5) * 0.44;
        p.setXYZ(k, p.getX(k) * s, p.getY(k) * s, p.getZ(k) * s);
        m.position[3 * k] = p.getX(k); m.position[3 * k + 1] = p.getY(k); m.position[3 * k + 2] = p.getZ(k);
      }
      g.computeVertexNormals();
      computeVertexNormals(m);
      compare(`cvn-flat(${det})`, m, g);
    }
  });

  test('computeVertexNormals on an unmodified indexed box gives THREE result (fresh normals array)', () => {
    const m = box(1, 2, 3, 2, 2, 2), g = new THREE.BoxGeometry(1, 2, 3, 2, 2, 2);
    g.computeVertexNormals();
    computeVertexNormals(m);
    compare('cvn-box', m, g);
  });
});

describe('transforms', () => {
  test('translate / rotateX/Y/Z / scale / applyMatrix4 (incl. non-uniform scale: normal matrix)', () => {
    const mk = (): [MeshData, THREE.BufferGeometry] => [cylinder(1, 2, 5, 11, 3, false), new THREE.CylinderGeometry(1, 2, 5, 11, 3, false)];
    const ops: [string, (m: MeshData) => unknown, (g: THREE.BufferGeometry) => unknown][] = [
      ['translate', m => translate(m, 1, -2, 3.5), g => g.translate(1, -2, 3.5)],
      ['rotateX', m => rotateX(m, 0.77), g => g.rotateX(0.77)],
      ['rotateY', m => rotateY(m, -2.1), g => g.rotateY(-2.1)],
      ['rotateZ', m => rotateZ(m, Math.PI / 2), g => g.rotateZ(Math.PI / 2)],
      ['scale', m => scale(m, 2, 0.5, 3), g => g.scale(2, 0.5, 3)],
      ['scale-mirror', m => scale(m, -1, 1, 1), g => g.scale(-1, 1, 1)],
      ['applyMatrix4', m => applyMatrix4(m, mat4.compose([1, 2, 3], [0.1, 0.5, -0.3, 0.8], [1, 2, 0.4])),
        g => g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(1, 2, 3), new THREE.Quaternion(0.1, 0.5, -0.3, 0.8), new THREE.Vector3(1, 2, 0.4)))]
    ];
    for (const [name, f, h] of ops) {
      const [m, g] = mk();
      f(m); h(g);
      compare(`transform-${name}`, m, g);
    }
    // hull: rotateX(PI/2) of the displaced cylinder (world.js:704)
    const m = cylinder(C.R, C.R, C.L, 64, 16, true), g = new THREE.CylinderGeometry(C.R, C.R, C.L, 64, 16, true);
    rotateX(m, Math.PI / 2); g.rotateX(Math.PI / 2);
    compare('transform-hull', m, g);
    // endcap: lathe then rotateX(-PI/2)
    const prof: [number, number][] = [[50, 0], [40, 1], [10, 10], [0.6, 16]];
    const lm = lathe(prof, 72, 0, Math.PI * 2, COMPAT), lg = new THREE.LatheGeometry(prof.map(p => new THREE.Vector2(p[0], p[1])), 72);
    rotateX(lm, -Math.PI / 2); lg.rotateX(-Math.PI / 2);
    compare('transform-endcap', lm, lg);
  });

  test('toNonIndexed matches THREE (attributes and groups)', () => {
    for (const [m, g] of [
      [box(1, 2, 3, 2, 1, 2), new THREE.BoxGeometry(1, 2, 3, 2, 1, 2)],
      [cylinder(1, 2, 3, 8, 2, false), new THREE.CylinderGeometry(1, 2, 3, 8, 2, false)],
      [lathe([[1, 0], [2, 1], [1, 2]], 6, 0, Math.PI * 2, COMPAT), new THREE.LatheGeometry([new THREE.Vector2(1, 0), new THREE.Vector2(2, 1), new THREE.Vector2(1, 2)], 6)]
    ] as [MeshData, THREE.BufferGeometry][]) {
      compare('toNonIndexed', toNonIndexed(m), g.toNonIndexed());
    }
    // non-indexed input is returned unchanged
    const ico = icosahedron(1, 1);
    expect(toNonIndexed(ico)).toBe(ico);
  });

  test('computeBounds matches THREE boundingSphere / boundingBox', () => {
    for (const [m, g] of [
      [cylinder(3, 1, 7, 13, 2, false), new THREE.CylinderGeometry(3, 1, 7, 13, 2, false)],
      [icosahedron(2, 2), new THREE.IcosahedronGeometry(2, 2)],
      [torus(4, 1, 5, 9), new THREE.TorusGeometry(4, 1, 5, 9)]
    ] as [MeshData, THREE.BufferGeometry][]) {
      translate(m, 1, 2, 3); g.translate(1, 2, 3);
      g.computeBoundingSphere(); g.computeBoundingBox();
      const b = computeBounds(m);
      expect(b.center).toEqual(g.boundingSphere!.center.toArray());
      expect(b.radius).toBeCloseTo(g.boundingSphere!.radius, 12);
      expect(b.min).toEqual(g.boundingBox!.min.toArray());
      expect(b.max).toEqual(g.boundingBox!.max.toArray());
    }
    expect(computeBounds({ position: new Float32Array(0), normal: new Float32Array(0), uv: new Float32Array(0), groups: [] }).radius).toBe(0);
  });

  test('toGeometryDesc yields a valid GeometryDesc', () => {
    const d = toGeometryDesc(box(2, 2, 2));
    expect(d.bounds.radius).toBeCloseTo(Math.sqrt(3), 6);
    expect(d.groups).toHaveLength(6);
    expect(d.index).toBeInstanceOf(Uint16Array);
    expect(d.color).toBeUndefined();
  });
});

describe('merge (legacy mergeGeos) and util helpers', () => {
  /** Same construction as structures.js trussGeo(), once in THREE + legacy mergeGeos, once in core. */
  function trussThree(len: number, w: number): THREE.BufferGeometry {
    const A = C.AXIS, col = A.column, B = A.baseR, TAU = Math.PI * 2;
    const g: THREE.BufferGeometry[] = [];
    const shaft = new THREE.CylinderGeometry(w * col.top, w * col.bottom, len, col.seg, 1, false);
    shaft.translate(0, len / 2, 0); g.push(shaft);
    const rings = Math.max(2, Math.round(len / col.ringStep));
    for (let k = 1; k < rings; k++) {
      const u = k / rings, r = w * (col.bottom + (col.top - col.bottom) * u);
      const band = new THREE.CylinderGeometry(r * 1.14, r * 1.14, col.ringH, col.seg, 1, false);
      band.translate(0, len * u, 0); g.push(band);
    }
    const disc = (r0: number, r1: number, hh: number, y: number, seg = 20): THREE.BufferGeometry => {
      const c = new THREE.CylinderGeometry(r0, r1, hh, seg, 1, false); c.translate(0, y + hh / 2, 0); return c;
    };
    g.push(disc(B, B * 1.06, 1.4, -0.7), disc(B * 0.78, B * 0.94, 1.1, 0.7), disc(w * col.bottom * 1.6, B * 0.74, 4.2, 1.8));
    const sd = A.saddle;
    const yoke = new THREE.CylinderGeometry(sd.r, sd.r, sd.w, 16, 1, true);
    yoke.rotateZ(Math.PI / 2); yoke.translate(0, len - sd.r * 0.2, 0); g.push(yoke);
    for (const sx of [-1, 1]) {
      const cheek = new THREE.BoxGeometry(sd.w * 0.22, sd.r * 1.7, sd.r * 2.1);
      cheek.translate(sx * sd.w * 0.42, len - sd.r * 0.9, 0); g.push(cheek);
    }
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * TAU + 0.26;
      const fin = new THREE.BoxGeometry(0.7, 5.6, 1.5);
      fin.rotateZ(0.44); fin.translate(B * 0.62, 2.6, 0); fin.rotateY(a); g.push(fin);
    }
    return mergeGeos(g);
  }
  function trussCore(len: number, w: number): MeshData {
    const A = C.AXIS, col = A.column, B = A.baseR, TAU = Math.PI * 2;
    const g: MeshData[] = [];
    g.push(translate(cylinder(w * col.top, w * col.bottom, len, col.seg, 1, false), 0, len / 2, 0));
    const rings = Math.max(2, Math.round(len / col.ringStep));
    for (let k = 1; k < rings; k++) {
      const u = k / rings, r = w * (col.bottom + (col.top - col.bottom) * u);
      g.push(translate(cylinder(r * 1.14, r * 1.14, col.ringH, col.seg, 1, false), 0, len * u, 0));
    }
    const disc = (r0: number, r1: number, hh: number, y: number, seg = 20): MeshData =>
      translate(cylinder(r0, r1, hh, seg, 1, false), 0, y + hh / 2, 0);
    g.push(disc(B, B * 1.06, 1.4, -0.7), disc(B * 0.78, B * 0.94, 1.1, 0.7), disc(w * col.bottom * 1.6, B * 0.74, 4.2, 1.8));
    const sd = A.saddle;
    g.push(translate(rotateZ(cylinder(sd.r, sd.r, sd.w, 16, 1, true), Math.PI / 2), 0, len - sd.r * 0.2, 0));
    for (const sx of [-1, 1]) g.push(translate(box(sd.w * 0.22, sd.r * 1.7, sd.r * 2.1), sx * sd.w * 0.42, len - sd.r * 0.9, 0));
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * TAU + 0.26;
      g.push(rotateY(translate(rotateZ(box(0.7, 5.6, 1.5), 0.44), B * 0.62, 2.6, 0), a));
    }
    return mergeMeshes(g);
  }

  test('trussGeo pipeline: translate/rotate + merge == THREE + legacy mergeGeos (layout, no groups)', () => {
    for (const [len, w] of [[40, 2.6], [23, 2.6], [61.5, 1.9]] as [number, number][]) {
      compare(`merge-truss(${len})`, trussCore(len, w), trussThree(len, w));
    }
  });

  test('merge: > 65535 vertices switches to Uint32 and offsets indices; missing attributes stay zero', () => {
    const big = (): MeshData => plane(1, 1, 150, 150); // 151*151 = 22801 verts
    const parts = [big(), big(), big()];               // 68403 > 65535
    const merged = mergeMeshes(parts);
    expect(merged.index).toBeInstanceOf(Uint32Array);
    expect(merged.position.length).toBe(68403 * 3);
    const legacy = mergeGeos([0, 1, 2].map(() => new THREE.PlaneGeometry(1, 1, 150, 150)));
    expect(Array.from(merged.index!)).toEqual(Array.from(legacy.index!.array));
    expect(maxDiff(merged.position, legacy.attributes.position.array, 'big merge')).toBe(0);

    const a = box(1, 1, 1);
    const noUv: MeshData = { ...box(1, 1, 1), uv: new Float32Array(0), normal: new Float32Array(0) };
    const m = mergeMeshes([a, noUv]);
    expect(Array.from(m.uv.slice(48))).toEqual(new Array(48).fill(0));
    expect(m.index).toBeInstanceOf(Uint16Array);
    expect(() => mergeMeshes([icosahedron(1, 0)])).toThrow();
  });

  test('merge: groupPerMesh and vertex colours', () => {
    const a = box(1, 1, 1), b = box(2, 2, 2);
    a.color = new Float32Array(24 * 3).fill(0.5);
    const m = mergeMeshes([a, b], { groupPerMesh: true });
    expect(m.groups).toEqual([{ start: 0, count: 36, slot: 0 }, { start: 36, count: 36, slot: 1 }]);
    expect(m.color!.length).toBe(48 * 3);
    expect(m.color![0]).toBe(0.5);
    expect(m.color![24 * 3]).toBe(1);
    expect(mergeMeshes([a, b]).groups).toEqual([]);
  });

  test('rod == legacy rod (box + rotate X, Z, Y order + translate)', () => {
    for (const p of [[1, 2, 3, 1, 2, 3, 0, 0, 0], [0.2, 4, 0.2, 5, 1, -2, 0.3, 0, 0.5], [0.2, 4, 0.2, 5, 1, -2, 0.3, 1.2, -0.5], [1, 1, 1, 0, 0, 0, 0, 0.7, 0]] as number[][]) {
      compare(`rod(${p})`, rod(...(p as [number, number, number, number, number, number])), legacyRod(...p));
    }
  });

  test('facadeUV / panelUV / splitRoofGroups equal the legacy implementations', () => {
    const mkPair = (): [MeshData, THREE.BufferGeometry] => {
      const parts = [rod(2, 3, 2, 1, 1.5, 0), rod(3, 0.4, 3, 0, 3.2, 1), rod(0.3, 5, 0.3, -2, 2, 2, 0.4, 0.2, 0.1)];
      const gparts = [legacyRod(2, 3, 2, 1, 1.5, 0), legacyRod(3, 0.4, 3, 0, 3.2, 1), legacyRod(0.3, 5, 0.3, -2, 2, 2, 0.4, 0.2, 0.1)];
      return [mergeMeshes(parts), mergeGeos(gparts)];
    };
    let [m, g] = mkPair();
    facadeUV(m, 1.7); legacyFacadeUV(g, 1.7);
    compare('facadeUV', m, g);
    [m, g] = mkPair();
    panelUV(m, 2.5, 0.8); legacyPanelUV(g, 2.5, 0.8);
    compare('panelUV', m, g);
    [m, g] = mkPair();
    splitRoofGroups(m); legacySplit(g);
    expect(m.groups.length).toBe(2);
    compare('splitRoofGroups', m, g);
    // wall-only geometry is returned untouched
    const wallOnly = box(1, 1, 1);
    wallOnly.normal.fill(0);
    wallOnly.normal.forEach((_, i) => { if (i % 3 === 0) wallOnly.normal[i] = 1; });
    const before = wallOnly.groups.length;
    expect(splitRoofGroups(wallOnly).groups.length).toBe(before);
  });
});

test('summary: worst |diff| per primitive family (informational)', () => {
  // eslint-disable-next-line no-console
  console.log('geometry parity worst abs diff:', JSON.stringify(worst));
  for (const v of Object.values(worst)) expect(v).toBeLessThanOrEqual(TOL);
});
