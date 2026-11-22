/* core/math vs THREE r165 (used here only as a test oracle). */
import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { mulberry32 } from '../rng.ts';
import * as vec3 from '../math/vec3.ts';
import * as quat from '../math/quat.ts';
import * as mat4 from '../math/mat4.ts';
import * as color from '../math/color.ts';
import { clamp, easeInOut, lerp } from '../math/scalar.ts';
import { natural as legacyNatural, lerp as legacyLerp, clamp as legacyClamp, easeInOut as legacyEase } from '../../test/legacy-oracle/util.js';
import { hexToLinear, srgbToLinear as phasesSrgb } from '../lighting/phases.ts';

const EPS = 1e-12;

function near(a: ArrayLike<number>, b: ArrayLike<number>, eps = EPS): void {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) {
    if (!(Math.abs(a[i] - b[i]) <= eps)) throw new Error(`index ${i}: ${a[i]} vs ${b[i]} (eps ${eps})`);
  }
}

const rnd = mulberry32(2024);
const r = (lo = -1, hi = 1): number => lo + (hi - lo) * rnd();
const rvec = (s = 5): number[] => [r(-s, s), r(-s, s), r(-s, s)];

function randomQuat(): THREE.Quaternion {
  return new THREE.Quaternion(r(), r(), r(), r()).normalize();
}

function randomMatrix(): { m: number[]; t: THREE.Matrix4 } {
  const p = rvec(), s = [r(0.2, 3), r(0.2, 3), r(0.2, 3)];
  const q = randomQuat();
  const t = new THREE.Matrix4().compose(new THREE.Vector3(...p), q, new THREE.Vector3(...s));
  return { m: Array.from(t.elements), t };
}

describe('vec3', () => {
  test('matches THREE.Vector3', () => {
    for (let i = 0; i < 200; i++) {
      const a = rvec(), b = rvec();
      const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
      near(vec3.add(a, b), A.clone().add(B).toArray());
      near(vec3.sub(a, b), A.clone().sub(B).toArray());
      near(vec3.cross(a, b), A.clone().cross(B).toArray());
      near(vec3.normalize(a), A.clone().normalize().toArray());
      near(vec3.lerp(a, b, 0.3), A.clone().lerp(B, 0.3).toArray());
      near(vec3.addScaled(a, b, 1.7), A.clone().addScaledVector(B, 1.7).toArray());
      expect(vec3.dot(a, b)).toBeCloseTo(A.dot(B), 12);
      expect(vec3.length(a)).toBeCloseTo(A.length(), 12);
      expect(vec3.distance(a, b)).toBeCloseTo(A.distanceTo(B), 12);
    }
  });

  test('normalize of zero stays zero; out may alias input', () => {
    near(vec3.normalize([0, 0, 0]), [0, 0, 0]);
    const v = [3, 0, 4];
    vec3.normalize(v, v);
    near(v, [0.6, 0, 0.8]);
  });
});

describe('quat', () => {
  test('fromAxisAngle / multiply / slerp / rotateVec3 match THREE.Quaternion', () => {
    for (let i = 0; i < 100; i++) {
      const axis = new THREE.Vector3(...rvec()).normalize();
      const ang = r(-6, 6);
      const q = quat.fromAxisAngle(axis.toArray(), ang);
      const Q = new THREE.Quaternion().setFromAxisAngle(axis, ang);
      near(q, Q.toArray());

      const a = randomQuat(), b = randomQuat();
      near(quat.multiply(a.toArray(), b.toArray()), a.clone().multiply(b).toArray());
      for (const t of [0, 0.25, 0.5, 0.99, 1]) {
        // r165 returns qb itself at t = 1 (possibly the long way round); r187 always takes the short arc.
        // Same rotation either way, so compare up to the q / -q ambiguity.
        const mine = quat.slerp(a.toArray(), b.toArray(), t), ref = a.clone().slerp(b, t).toArray();
        const sign = Math.abs(mine[0] - ref[0]) + Math.abs(mine[1] - ref[1]) + Math.abs(mine[2] - ref[2]) + Math.abs(mine[3] - ref[3]) < 1e-9 ? 1 : -1;
        near(mine, ref.map(v => v * sign));
      }
      const v = rvec();
      near(quat.rotateVec3(a.toArray(), v), new THREE.Vector3(...v).applyQuaternion(a).toArray());
    }
  });

  // r165 and r187 use different near-parallel branches (EPS vs 0.9995); core follows the installed oracle (r187)
  test.skipIf(THREE.REVISION === '165')('slerp of nearly identical quaternions takes the linear branch', () => {
    const a = new THREE.Quaternion(0, 0, 0, 1), b = new THREE.Quaternion(1e-9, 0, 0, 1).normalize();
    near(quat.slerp(a.toArray(), b.toArray(), 0.5), a.clone().slerp(b, 0.5).toArray());
  });

  test('fromRotationMatrix covers all four branches', () => {
    const rots = [
      new THREE.Matrix4().makeRotationX(0.3),
      new THREE.Matrix4().makeRotationX(Math.PI),     // trace < 0, m22 branch? (x flip)
      new THREE.Matrix4().makeRotationY(Math.PI),
      new THREE.Matrix4().makeRotationZ(Math.PI),
      new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(1, 1, 0).normalize(), 3.0)
    ];
    for (const R of rots) {
      near(quat.fromRotationMatrix(Array.from(R.elements)), new THREE.Quaternion().setFromRotationMatrix(R).toArray());
    }
    for (let i = 0; i < 200; i++) {
      const R = new THREE.Matrix4().makeRotationFromQuaternion(randomQuat());
      near(quat.fromRotationMatrix(Array.from(R.elements)), new THREE.Quaternion().setFromRotationMatrix(R).toArray());
    }
  });

  test('fromUnitVectors incl. opposite vectors', () => {
    const pairs: [number[], number[]][] = [[[1, 0, 0], [-1, 0, 0]], [[0, 0, 1], [0, 0, -1]], [[0, 1, 0], [0, -1, 0]]];
    for (let i = 0; i < 100; i++) {
      pairs.push([new THREE.Vector3(...rvec()).normalize().toArray(), new THREE.Vector3(...rvec()).normalize().toArray()]);
    }
    for (const [a, b] of pairs) {
      near(quat.fromUnitVectors(a, b), new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(...a), new THREE.Vector3(...b)).toArray());
    }
  });
});

describe('mat4', () => {
  test('identity / makeRotationX/Y/Z / makeTranslation / makeScale / makeRotationAxis', () => {
    near(mat4.identity(), new THREE.Matrix4().elements);
    for (let i = 0; i < 50; i++) {
      const a = r(-7, 7);
      near(mat4.makeRotationX(a), new THREE.Matrix4().makeRotationX(a).elements);
      near(mat4.makeRotationY(a), new THREE.Matrix4().makeRotationY(a).elements);
      near(mat4.makeRotationZ(a), new THREE.Matrix4().makeRotationZ(a).elements);
      const [x, y, z] = rvec();
      near(mat4.makeTranslation(x, y, z), new THREE.Matrix4().makeTranslation(x, y, z).elements);
      near(mat4.makeScale(x, y, z), new THREE.Matrix4().makeScale(x, y, z).elements);
      const ax = new THREE.Vector3(x, y, z).normalize();
      near(mat4.makeRotationAxis(ax.toArray(), a), new THREE.Matrix4().makeRotationAxis(ax, a).elements);
    }
  });

  test('multiply, invert, determinant, transpose match THREE (and out may alias)', () => {
    for (let i = 0; i < 100; i++) {
      const A = randomMatrix(), B = randomMatrix();
      near(mat4.multiply(A.m, B.m), A.t.clone().multiply(B.t).elements, 1e-10);
      near(mat4.invert(A.m), A.t.clone().invert().elements, 1e-10);
      expect(mat4.determinant(A.m)).toBeCloseTo(A.t.determinant(), 6);
      near(mat4.transpose(A.m), A.t.clone().transpose().elements);
      const alias = A.m.slice();
      mat4.multiply(alias, B.m, alias);
      near(alias, A.t.clone().multiply(B.t).elements, 1e-10);
      const inv = A.m.slice();
      mat4.invert(inv, inv);
      near(inv, A.t.clone().invert().elements, 1e-10);
      // M * M^-1 = I
      near(mat4.multiply(A.m, mat4.invert(A.m)), mat4.identity(), 1e-9);
    }
  });

  test('invert of a singular matrix gives zeros (THREE behaviour)', () => {
    near(mat4.invert(mat4.makeScale(1, 0, 1)), new Array(16).fill(0));
  });

  test('compose / decompose round trip and THREE parity', () => {
    for (let i = 0; i < 100; i++) {
      const p = rvec(), s = [r(0.2, 3), r(0.2, 3), r(0.2, 3)];
      const q = randomQuat();
      const m = mat4.compose(p, q.toArray(), s);
      near(m, new THREE.Matrix4().compose(new THREE.Vector3(...p), q, new THREE.Vector3(...s)).elements);

      const d = mat4.decompose(m);
      const P = new THREE.Vector3(), Q = new THREE.Quaternion(), S = new THREE.Vector3();
      new THREE.Matrix4().fromArray(m).decompose(P, Q, S);
      near(d.position, P.toArray(), 1e-12);
      near(d.quaternion, Q.toArray(), 1e-12);
      near(d.scale, S.toArray(), 1e-12);
      near(d.position, p, 1e-9);
      near(d.scale, s, 1e-9);
    }
  });

  test('decompose handles mirrored (negative determinant) matrices like THREE', () => {
    const m = mat4.compose([1, 2, 3], quat.identity(), [-2, 1, 1]);
    const d = mat4.decompose(m);
    const S = new THREE.Vector3();
    new THREE.Matrix4().fromArray(m).decompose(new THREE.Vector3(), new THREE.Quaternion(), S);
    near(d.scale, S.toArray());
  });

  test('makeBasis and lookAt match THREE', () => {
    for (let i = 0; i < 100; i++) {
      const x = rvec(), y = rvec(), z = rvec();
      near(mat4.makeBasis(x, y, z), new THREE.Matrix4().makeBasis(new THREE.Vector3(...x), new THREE.Vector3(...y), new THREE.Vector3(...z)).elements);

      const eye = rvec(), target = rvec(), up = new THREE.Vector3(...rvec()).normalize().toArray();
      near(
        mat4.lookAt(eye, target, up),
        new THREE.Matrix4().lookAt(new THREE.Vector3(...eye), new THREE.Vector3(...target), new THREE.Vector3(...up)).elements
      );
    }
    // degenerate: eye == target, up parallel to view
    const E = new THREE.Vector3(1, 2, 3);
    near(mat4.lookAt([1, 2, 3], [1, 2, 3], [0, 1, 0]), new THREE.Matrix4().lookAt(E, E, new THREE.Vector3(0, 1, 0)).elements);
    near(mat4.lookAt([0, 5, 0], [0, 0, 0], [0, 1, 0]), new THREE.Matrix4().lookAt(new THREE.Vector3(0, 5, 0), new THREE.Vector3(), new THREE.Vector3(0, 1, 0)).elements);
    near(mat4.lookAt([0, 0, 5], [0, 0, 0], [0, 0, 1]), new THREE.Matrix4().lookAt(new THREE.Vector3(0, 0, 5), new THREE.Vector3(), new THREE.Vector3(0, 0, 1)).elements);
  });

  test('station-up basis (legacy surfaceQuat): makeBasis → quaternion matches THREE', () => {
    for (let k = 0; k < 40; k++) {
      const t = (k / 40) * Math.PI * 2;
      const up = [-Math.sin(t), -Math.cos(t), 0];
      const zAx = [0, 0, 1];
      const xAx = vec3.cross(up, zAx);
      const q = quat.fromRotationMatrix(mat4.makeBasis(xAx, up, zAx));
      const U = new THREE.Vector3(...up), X = new THREE.Vector3().crossVectors(U, new THREE.Vector3(0, 0, 1));
      const Q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, U, new THREE.Vector3(0, 0, 1)));
      near(q, Q.toArray());
    }
  });

  test('transformPoint / transformDirection / normalMatrix match THREE', () => {
    for (let i = 0; i < 100; i++) {
      const { m, t } = randomMatrix();
      const p = rvec();
      near(mat4.transformPoint(m, p), new THREE.Vector3(...p).applyMatrix4(t).toArray());
      near(mat4.transformDirection(m, p), new THREE.Vector3(...p).transformDirection(t).toArray());
      const nm = mat4.normalMatrix(m);
      near(nm, new THREE.Matrix3().getNormalMatrix(t).elements, 1e-10);
      near(mat4.applyNormalMatrix(nm, p), new THREE.Vector3(...p).applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(t)).toArray(), 1e-10);
    }
  });

  test('projective transformPoint divides by w', () => {
    const P = new THREE.Matrix4().makePerspective(-1, 1, 1, -1, 0.1, 100);
    const p = [0.3, -0.2, -5];
    near(mat4.transformPoint(Array.from(P.elements), p), new THREE.Vector3(...p).applyMatrix4(P).toArray());
  });

  test('Float32Array output works', () => {
    const out = new Float32Array(16);
    mat4.compose([1, 2, 3], quat.identity(), [1, 1, 1], out);
    expect(Array.from(out.slice(12, 15))).toEqual([1, 2, 3]);
  });
});

describe('color', () => {
  const hexes = [0x000000, 0xffffff, 0x808080, 0x2f5a2c, 0xb8cfe0, 0xc8a050, 0x1f4260, 0x537cb8, 0xff0000, 0x00ff00, 0x0000ff, 0x336699, 0xd2b48c, 0x7a1f1f];

  test('srgbToLinear equals lighting/phases.ts and THREE', () => {
    for (let i = 0; i <= 255; i++) {
      const c = i / 255;
      expect(color.srgbToLinear(c)).toBe(phasesSrgb(c));
      const T = new THREE.Color().setRGB(c, c, c, THREE.SRGBColorSpace);
      expect(color.srgbToLinear(c)).toBe(T.r);
    }
  });

  test('setHex equals THREE.Color.setHex and phases.hexToLinear', () => {
    for (const hex of hexes) {
      const C = new THREE.Color().setHex(hex);
      near(color.setHex(hex), [C.r, C.g, C.b], 0);
      near(color.setHex(hex), hexToLinear(hex), 0);
      expect(color.getHex(color.setHex(hex))).toBe(hex);
      expect(color.getHex(color.setHex(hex))).toBe(C.getHex());
    }
  });

  test('getHSL / setHSL equal THREE (linear working space, no transfer)', () => {
    for (let i = 0; i < 500; i++) {
      const rgb = [rnd(), rnd(), rnd()];
      const C = new THREE.Color(rgb[0], rgb[1], rgb[2]); // number triplet = working space
      const hs = { h: 0, s: 0, l: 0 };
      C.getHSL(hs);
      const mine = color.getHSL(rgb);
      near([mine.h, mine.s, mine.l], [hs.h, hs.s, hs.l], 0);

      const h = r(-2, 3), s = r(-0.2, 1.2), l = r(-0.2, 1.2);
      const D = new THREE.Color().setHSL(h, s, l);
      near(color.setHSL(h, s, l), [D.r, D.g, D.b], 0);

      const E = new THREE.Color(rgb[0], rgb[1], rgb[2]).offsetHSL(0.1, -0.05, 0.07);
      near(color.offsetHSL(rgb, 0.1, -0.05, 0.07), [E.r, E.g, E.b], 0);

      const rgb2 = [rnd(), rnd(), rnd()];
      const F = new THREE.Color(rgb[0], rgb[1], rgb[2]).lerp(new THREE.Color(rgb2[0], rgb2[1], rgb2[2]), 0.37);
      near(color.lerp(rgb, rgb2, 0.37), [F.r, F.g, F.b], 0);
      const G = new THREE.Color(rgb[0], rgb[1], rgb[2]).lerpHSL(new THREE.Color(rgb2[0], rgb2[1], rgb2[2]), 0.37);
      near(color.lerpHSL(rgb, rgb2, 0.37), [G.r, G.g, G.b], 0);
      const H = new THREE.Color(rgb[0], rgb[1], rgb[2]).multiplyScalar(2.5);
      near(color.multiplyScalar(rgb, 2.5), [H.r, H.g, H.b], 0);
    }
    // grey (s == 0) path and hue wrap
    near(color.setHSL(0.3, 0, 0.5), [0.5, 0.5, 0.5], 0);
    expect(color.getHSL([0.4, 0.4, 0.4])).toEqual({ h: 0, s: 0, l: 0.4 });
  });

  test('natural() equals the legacy js/util.js implementation (THREE.Color) for many hex/k', () => {
    const ks = [0, 0.25, 0.5, 0.7, 0.75, 1, 1.3, 0.5 + 0.8 * 0.5];
    for (const hex of hexes) {
      for (const k of ks) {
        const C = legacyNatural(hex, k, new THREE.Color());
        near(color.natural(hex, k), [C.r, C.g, C.b], 0);
      }
    }
    // random hex
    for (let i = 0; i < 300; i++) {
      const hex = (rnd() * 0xffffff) | 0, k = rnd() * 1.4;
      const C = legacyNatural(hex, k, new THREE.Color());
      near(color.natural(hex, k), [C.r, C.g, C.b], 0);
    }
  });

  test('natural() writes into a packed Float32Array at an offset (instance colours)', () => {
    const buf = new Float32Array(9);
    color.natural(0x2f5a2c, 0.75, buf, 3);
    const C = legacyNatural(0x2f5a2c, 0.75, new THREE.Color());
    near(Array.from(buf.slice(3, 6)), [Math.fround(C.r), Math.fround(C.g), Math.fround(C.b)], 0);
    expect(Array.from(buf.slice(0, 3))).toEqual([0, 0, 0]);
  });
});

describe('scalar', () => {
  test('lerp / clamp / easeInOut equal legacy', () => {
    for (let i = 0; i < 100; i++) {
      const a = r(-3, 3), b = r(-3, 3), t = r(-0.5, 1.5);
      expect(lerp(a, b, t)).toBe(legacyLerp(a, b, t));
      expect(clamp(a, -1, 1)).toBe(legacyClamp(a, -1, 1));
      const u = rnd();
      expect(easeInOut(u)).toBe(legacyEase(u));
    }
  });
});
