/* ═══════════════════════════════════════════════════════════════════════════
   Axis tube emitter sampling — CPU mirror of wgsl/light_tube.wgsl.

   Tube: the lateral surface of the cylinder x² + y² = r², z ∈ [z0, z0 + len],
   outward normal n = (cos φ, sin φ, 0), point X(φ, z) = (r cos φ, r sin φ, z),
   area element dA = r dφ dz. Caps and the inner side are not sampled.

   Visible region from a shading point P (ρ = |P.xy| > r): the outer side
   faces P where n·(P − X) > 0 ⇔ ρ cos Δφ > r, Δφ = φ − φ_P, i.e.
   |Δφ| < φmax = acos(r/ρ) — independent of z. So the visible region is the
   rectangle Δφ ∈ (−φmax, φmax) × z ∈ [z0, z1] and both coordinates are
   sampled independently:

   • φ — uniform in the PROJECTED width s = sin Δφ ∈ [−sin φmax, sin φmax]
     (what a distant viewer sees of the tube): pdf_φ(Δφ) = cos Δφ / (2 sin φmax);
   • z — equiangular (Kulla & Fajardo 2012) about P's foot on a line at
     distance h = sqrt(ρ² − r²) (the tangent lines of the visible band):
       θ ∈ [θ0, θ1], θi = atan((zi − P.z)/h), z = P.z + h tan θ,
       pdf_z(z) = h / ((θ1 − θ0)(h² + (z − P.z)²)).
   Area pdf = pdf_z · pdf_φ / r; solid-angle pdf = pdf_A · d² / cos θ_l
   (θ_l between n and the direction toward P). tubePdf() evaluates the same
   density for a point X on the tube (MIS of BSDF-sampled hits): 0 outside
   the visible region.
   ═══════════════════════════════════════════════════════════════════════════ */

import { LIGHTS_PT } from '../config.ts';

export type V3 = [number, number, number];

export interface TubeGeom {
  radius: number;
  length: number;
  z0: number;
}

export interface TubeSample {
  /** point on the tube */
  x: V3;
  /** outward normal at x */
  n: V3;
  /** unit direction P → x */
  wi: V3;
  /** squared distance P → x */
  d2: number;
  /** cos between n and −wi (> 0 inside the visible band) */
  cosL: number;
  /** area pdf (1/units²) */
  pdfA: number;
  /** solid-angle pdf (1/sr) */
  pdfW: number;
}

interface Frame {
  rho: number;
  ex: number;
  ey: number;
  sinMax: number;
  h: number;
  th0: number;
  th1: number;
}

function frameOf(P: ArrayLike<number>, t: TubeGeom): Frame | null {
  const rho = Math.hypot(P[0], P[1]);
  const r = t.radius;
  if (!(rho > r * (1 + LIGHTS_PT.tubeInsideEps))) return null;
  const q = r / rho;
  const sinMax = Math.sqrt(Math.max(0, 1 - q * q));
  const h = Math.sqrt(Math.max(rho * rho - r * r, 0));
  const th0 = Math.atan((t.z0 - P[2]) / h);
  const th1 = Math.atan((t.z0 + t.length - P[2]) / h);
  if (!(th1 > th0) || !(sinMax > 0)) return null;
  return { rho, ex: P[0] / rho, ey: P[1] / rho, sinMax, h, th0, th1 };
}

const pdfZ = (f: Frame, dz: number) => f.h / ((f.th1 - f.th0) * (f.h * f.h + dz * dz));

/** Sample a point on the visible part of the tube from P with u ∈ [0,1)². null: P inside / degenerate. */
export function tubeSample(P: ArrayLike<number>, t: TubeGeom, u1: number, u2: number): TubeSample | null {
  const f = frameOf(P, t);
  if (!f) return null;
  const s = (2 * u1 - 1) * f.sinMax;
  const c = Math.sqrt(Math.max(0, 1 - s * s));
  // rotate (ex, ey) by Δφ: cos Δφ = c, sin Δφ = s
  const nx = f.ex * c - f.ey * s, ny = f.ey * c + f.ex * s;
  const th = f.th0 + u2 * (f.th1 - f.th0);
  const z = P[2] + f.h * Math.tan(th);
  const x: V3 = [nx * t.radius, ny * t.radius, z];
  const wx = x[0] - P[0], wy = x[1] - P[1], wz = x[2] - P[2];
  const d2 = wx * wx + wy * wy + wz * wz;
  const d = Math.sqrt(d2);
  const wi: V3 = [wx / d, wy / d, wz / d];
  const cosL = -(nx * wi[0] + ny * wi[1]);
  const pdfA = (pdfZ(f, z - P[2]) * c) / (2 * f.sinMax) / t.radius;
  return { x, n: [nx, ny, 0], wi, d2, cosL, pdfA, pdfW: cosL > 0 ? (pdfA * d2) / cosL : 0 };
}

/** Area pdf of tubeSample() at a tube point x (0 when x is not on the visible band). */
export function tubePdfA(P: ArrayLike<number>, x: ArrayLike<number>, t: TubeGeom): number {
  const f = frameOf(P, t);
  if (!f) return 0;
  if (x[2] < t.z0 || x[2] > t.z0 + t.length) return 0;
  const l = Math.hypot(x[0], x[1]) || 1;
  const c = (x[0] * f.ex + x[1] * f.ey) / l; // cos Δφ
  if (!(f.rho * c > t.radius)) return 0;
  return (pdfZ(f, x[2] - P[2]) * c) / (2 * f.sinMax) / t.radius;
}

/** Solid-angle pdf of tubeSample() for the direction P → x (x on the tube). */
export function tubePdfW(P: ArrayLike<number>, x: ArrayLike<number>, t: TubeGeom): number {
  const pa = tubePdfA(P, x, t);
  if (!(pa > 0)) return 0;
  const wx = x[0] - P[0], wy = x[1] - P[1], wz = x[2] - P[2];
  const d2 = wx * wx + wy * wy + wz * wz;
  const l = Math.hypot(x[0], x[1]) || 1;
  const cosL = -(x[0] * wx + x[1] * wy) / (l * Math.sqrt(d2));
  return cosL > 0 ? (pa * d2) / cosL : 0;
}

/** Uniform-area sample of the whole lateral surface (the M1 strategy) — reference for variance comparisons. */
export function tubeSampleUniform(P: ArrayLike<number>, t: TubeGeom, u1: number, u2: number): TubeSample {
  const phi = 2 * Math.PI * u1;
  const nx = Math.cos(phi), ny = Math.sin(phi);
  const x: V3 = [nx * t.radius, ny * t.radius, t.z0 + t.length * u2];
  const wx = x[0] - P[0], wy = x[1] - P[1], wz = x[2] - P[2];
  const d2 = wx * wx + wy * wy + wz * wz;
  const d = Math.sqrt(d2);
  const wi: V3 = [wx / d, wy / d, wz / d];
  const cosL = -(nx * wi[0] + ny * wi[1]);
  const pdfA = 1 / (2 * Math.PI * t.radius * t.length);
  return { x, n: [nx, ny, 0], wi, d2, cosL, pdfA, pdfW: cosL > 0 ? (pdfA * d2) / cosL : 0 };
}

/**
 * Irradiance at P (receiver normal nP) from the tube of radiance Le, by
 * numerical quadrature over the visible band (midpoint rule in (Δφ, θ) with
 * the equiangular substitution, so the integrand is smooth). Unoccluded.
 */
export function tubeIrradianceQuad(P: ArrayLike<number>, nP: ArrayLike<number>, t: TubeGeom, Le = 1, nPhi = 256, nTh = 1024): number {
  const f = frameOf(P, t);
  if (!f) return 0;
  const phiMax = Math.acos(t.radius / f.rho);
  let sum = 0;
  for (let i = 0; i < nPhi; i++) {
    const dphi = -phiMax + ((i + 0.5) / nPhi) * 2 * phiMax;
    const c = Math.cos(dphi), s = Math.sin(dphi);
    const nx = f.ex * c - f.ey * s, ny = f.ey * c + f.ex * s;
    for (let j = 0; j < nTh; j++) {
      const th = f.th0 + ((j + 0.5) / nTh) * (f.th1 - f.th0);
      const z = P[2] + f.h * Math.tan(th);
      const dzdth = f.h / (Math.cos(th) ** 2);
      const wx = nx * t.radius - P[0], wy = ny * t.radius - P[1], wz = z - P[2];
      const d2 = wx * wx + wy * wy + wz * wz, d = Math.sqrt(d2);
      const cosL = -(nx * wx + ny * wy) / d;
      const cosP = (nP[0] * wx + nP[1] * wy + nP[2] * wz) / d;
      if (cosL <= 0 || cosP <= 0) continue;
      sum += (cosL * cosP / d2) * t.radius * dzdth;
    }
  }
  return Le * sum * (2 * phiMax / nPhi) * ((f.th1 - f.th0) / nTh);
}

/**
 * Cheap analytic estimate of the irradiance-like importance of the tube at P
 * (light selection between the tube and the triangle lights): radiance ×
 * the solid angle of a 2r-wide strip along the axis,
 *   Ω ≈ 2r/ρ · [(z1 − z)/D1 − (z0 − z)/D0],  Di = sqrt(ρ² + (zi − z)²).
 * Mirrors b5_tube_importance (light_tube.wgsl).
 */
export function tubeImportance(P: ArrayLike<number>, t: TubeGeom, lum: number): number {
  const rho = Math.hypot(P[0], P[1]);
  if (!(rho > t.radius * (1 + LIGHTS_PT.tubeInsideEps))) return 0;
  const a = t.z0 - P[2], b = t.z0 + t.length - P[2];
  const om = (2 * t.radius / rho) * (b / Math.hypot(rho, b) - a / Math.hypot(rho, a));
  return lum * Math.max(om, 0);
}
