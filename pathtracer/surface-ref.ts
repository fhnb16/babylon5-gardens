/* ═══════════════════════════════════════════════════════════════════════════
   CPU reference of wgsl/surface.wgsl b5_surface (tests, the pt-surface smoke
   page, and the integrator unit as an oracle). Works on the SAME packed
   buffers the GPU gets (triangle records, instances, attributes, material
   records, texture table, B5SurfaceFrame) and on the level-0 class-square
   images, from which it builds the mip chains with textures.ts mipChainCpu
   (the CPU mirror of mipgen.wgsl). f64 arithmetic.

   Sampling = WebGPU textureSampleLevel with a linear/linear/linear sampler:
   λ clamped to [0, levels−1], trilinear between ⌊λ⌋ and ⌊λ⌋+1, bilinear at
   texel centres (uv·S − 0.5), repeat or clamp-to-edge addressing, sRGB
   texels decoded to linear before filtering, bilinear fractions rounded to
   8 bits (subtexelBits) like GPU samplers. Remaining GPU differences: the
   hardware's trilinear-weight / LOD precision, sRGB-decode LUTs, f32 vs f64
   and mip bytes (≤ 1 LSB per level, see textures.ts roundHalfEven).
   Measured (pt-surface, RTX 3070, 2,000 px of view 0): albedo p99 5.6e-3,
   ns p99 0.66°, ng max 0.03°, roughness / water ≤ 0.016, kind / matId exact.
   ═══════════════════════════════════════════════════════════════════════════ */

import type { PixelImage } from '../core/raster/index.ts';
import { evaluateKernel } from '../core/shading/emit/cpu.ts';
import { hullSurface } from '../core/shading/kernels/hull.ts';
import { farFromFootprint } from '../core/shading/contracts.ts';
import { INST_W, INST_WORDS, TRI_W, TRI_WORDS, decodeRgb9e5 } from './bvh/layout.ts';
import { HIT_FRONT, RAY_WORDS, T_INFINITE, writeRay } from './rays.ts';
import { ATTR_W, ATTR_WORDS, TRACER_HULL_OPTIONS, decodeOct } from './scene-upload.ts';
import { CHANNEL_SLOTS, CH_CITY_GLOW, FRAME_F, MAT_FLAG, MAT_KIND, NO_TEX, readMaterial } from './materials.ts';
import {
  LOC_CLAMP, LOC_CLASS_SHIFT, LOC_SRGB, SIZE_CLASSES, TEXREF_BYTES, mipChainCpu, srgbToLinear01
} from './textures.ts';

export type V3 = [number, number, number];

export interface RefHit {
  t: number;
  u: number;
  v: number;
  inst: number;
  tri: number;
  flags: number;
}

/** Same fields as WGSL B5Surface. */
export interface RefSurface {
  p: V3;
  kind: number;
  ng: V3;
  matId: number;
  ns: V3;
  rough: number;
  albedo: V3;
  metal: number;
  emission: V3;
  water: number;
  tint: V3;
  ior: number;
  slope: [number, number];
  coneW: number;
  frontFace: number;
  /** debug: surface LOD (before the per-texture offset) */
  lod: number;
}

export interface SurfaceRefInput {
  tris: ArrayBuffer;
  instances: ArrayBuffer;
  attrs: ArrayBuffer;
  materials: ArrayBuffer;
  /** texture table (textures.ts packTexTable) */
  texTable: ArrayBuffer;
  /** level-0 class squares in texture-table order */
  images: PixelImage[];
  /** B5SurfaceFrame (materials.ts paletteUniform) */
  frame: Float32Array;
  /** bilinear weight precision: fractions rounded to 2^-bits like GPU samplers
      (D3D12 / Vulkan hardware: 8 bits). Default 8; 0 = exact. */
  subtexelBits?: number;
}

const B5_LOD_MIN_COS = 0.01;

interface CpuTex { mips: PixelImage[]; srgb: boolean; clamp: boolean; offset: number; xform: number[]; lut: Float64Array }

const LIN_LUT = Float64Array.from({ length: 256 }, (_, i) => i / 255);
const SRGB_LUT = Float64Array.from({ length: 256 }, (_, i) => srgbToLinear01(i / 255));

const sub = (a: number[], b: number[]): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: number[], b: number[]): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a: number[], s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const mul = (a: number[], b: number[]): V3 => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
const dot = (a: number[], b: number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: number[], b: number[]): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: number[]): number => Math.hypot(a[0], a[1], a[2]);
const norm = (a: number[]): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/**
 * Pinhole camera rays of a view [θ°, r, z] → look [θ°, r, z] (station frame,
 * up = towards the axis), vertical FOV in degrees, row 0 = top. Returns B5Ray
 * records (rays.ts, tmin 0, tmax T_INFINITE) and the pixel spread angle
 * (primary-ray cone: width at distance t = spread · t).
 */
export function primaryRays(pos: readonly number[], look: readonly number[], width: number, height: number, fovDeg = 70):
  { rays: Float32Array; spread: number; eye: V3 } {
  const D = Math.PI / 180;
  const eye: V3 = [Math.sin(pos[0] * D) * pos[1], Math.cos(pos[0] * D) * pos[1], pos[2]];
  const tgt: V3 = [Math.sin(look[0] * D) * look[1], Math.cos(look[0] * D) * look[1], look[2]];
  const fw = norm(sub(tgt, eye));
  let up: V3 = Math.hypot(eye[0], eye[1]) > 1e-2 ? norm([-eye[0], -eye[1], 0]) : [0, 1, 0];
  up = norm(sub(up, scl(fw, dot(up, fw))));
  const right = cross(fw, up);
  const th = Math.tan((fovDeg * D) / 2);
  const rays = new Float32Array(width * height * RAY_WORDS);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = ((x + 0.5) / width * 2 - 1) * th * (width / height);
      const sy = (1 - (y + 0.5) / height * 2) * th;
      const d = norm(add(add(fw, scl(right, sx)), scl(up, sy)));
      writeRay(rays, y * width + x, eye[0], eye[1], eye[2], d[0], d[1], d[2], 0, T_INFINITE);
    }
  }
  return { rays, spread: (2 * th) / height, eye };
}

export interface SurfaceRef {
  surface(hit: RefHit, rayO: number[], rayD: number[], coneW: number): RefSurface;
  /** textureSampleLevel mirror for texture-table entry idx (mesh uv, surface LOD) */
  sample(idx: number, uv: [number, number], lod: number): [number, number, number, number];
}

export function createSurfaceRef(inp: SurfaceRefInput): SurfaceRef {
  const TF = new Float32Array(inp.tris), TU = new Uint32Array(inp.tris);
  const IF = new Float32Array(inp.instances), IU = new Uint32Array(inp.instances);
  const AF = new Float32Array(inp.attrs), AU = new Uint32Array(inp.attrs);
  const XU = new Uint32Array(inp.texTable), XF = new Float32Array(inp.texTable);
  const F = inp.frame;
  const texCache = new Map<number, CpuTex>();
  const qs = inp.subtexelBits === undefined ? 256 : inp.subtexelBits > 0 ? 2 ** inp.subtexelBits : 0;
  const qf = (f: number): number => (qs ? Math.round(f * qs) / qs : f);

  const tex = (idx: number): CpuTex => {
    let t = texCache.get(idx);
    if (t) return t;
    const w = (idx * TEXREF_BYTES) / 4;
    const loc = XU[w];
    const srgb = (loc & LOC_SRGB) !== 0;
    const img = inp.images[idx];
    if (!img) throw new Error(`surface-ref: no image for texture ${idx}`);
    const size = SIZE_CLASSES[(loc >>> LOC_CLASS_SHIFT) & 3];
    if (img.width !== size) throw new Error(`surface-ref: texture ${idx} is ${img.width}², class ${size}`);
    t = {
      mips: mipChainCpu(img, srgb), srgb, clamp: (loc & LOC_CLAMP) !== 0,
      offset: XF[w + 1], xform: [XF[w + 4], XF[w + 5], XF[w + 6], XF[w + 7]], lut: srgb ? SRGB_LUT : LIN_LUT
    };
    texCache.set(idx, t);
    return t;
  };

  const bilinear = (t: CpuTex, level: number, u: number, v: number, out: number[], wgt: number) => {
    const im = t.mips[level], S = im.width, d = im.data, lut = t.lut;
    const x = u * S - 0.5, y = v * S - 0.5;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = qf(x - x0), fy = qf(y - y0);
    const ax = (i: number) => (t.clamp ? Math.min(S - 1, Math.max(0, i)) : ((i % S) + S) % S);
    const xs = [ax(x0), ax(x0 + 1)], ys = [ax(y0), ax(y0 + 1)];
    const ws = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy];
    for (let k = 0; k < 4; k++) {
      const o = (ys[k >> 1] * S + xs[k & 1]) * 4, ww = ws[k] * wgt;
      out[0] += lut[d[o]] * ww; out[1] += lut[d[o + 1]] * ww; out[2] += lut[d[o + 2]] * ww; out[3] += (d[o + 3] / 255) * ww;
    }
  };

  const sample = (idx: number, uv: [number, number], lod: number): [number, number, number, number] => {
    const t = tex(idx);
    const u = uv[0] * t.xform[0] + t.xform[2], v = uv[1] * t.xform[1] + t.xform[3];
    const maxL = t.mips.length - 1;
    const l = Math.min(maxL, Math.max(0, lod + t.offset));
    const l0 = Math.floor(l), f = l - l0, l1 = Math.min(maxL, l0 + 1);
    const out = [0, 0, 0, 0];
    bilinear(t, l0, u, v, out, 1 - f);
    if (f > 0) bilinear(t, l1, u, v, out, f);
    return out as [number, number, number, number];
  };

  const surface = (hit: RefHit, rayO: number[], rayD: number[], coneW: number): RefSurface => {
    const tw = hit.tri * TRI_WORDS, iw = hit.inst * INST_WORDS, aw = hit.tri * ATTR_WORDS;
    const v0 = [TF[tw + TRI_W.v0], TF[tw + TRI_W.v0 + 1], TF[tw + TRI_W.v0 + 2]];
    const v1 = [TF[tw + TRI_W.v1], TF[tw + TRI_W.v1 + 1], TF[tw + TRI_W.v1 + 2]];
    const v2 = [TF[tw + TRI_W.v2], TF[tw + TRI_W.v2 + 1], TF[tw + TRI_W.v2 + 2]];
    const slot = TU[tw + TRI_W.slot];
    const m = readMaterial(inp.materials, IU[iw + INST_W.matBase] + slot);
    const ch = Math.min(m.channel, CHANNEL_SLOTS - 1);
    const p = add(rayO, scl(rayD, hit.t));
    const d = norm(rayD);

    const r0 = [IF[iw], IF[iw + 1], IF[iw + 2]], r1 = [IF[iw + 4], IF[iw + 5], IF[iw + 6]], r2 = [IF[iw + 8], IF[iw + 9], IF[iw + 10]];
    const nrm = (n: number[]): V3 => add(add(scl(r0, n[0]), scl(r1, n[1])), scl(r2, n[2]));
    const c12 = cross(r1, r2), c20 = cross(r2, r0), c01 = cross(r0, r1);
    const det = dot(r0, c12);
    const invDet = 1 / (det === 0 ? 1e-30 : det);
    const dir = (v: number[]): V3 => scl(add(add(scl(c12, v[0]), scl(c20, v[1])), scl(c01, v[2])), invDet);

    const e1 = sub(v1, v0), e2 = sub(v2, v0);
    const ngW = norm(nrm(cross(e1, e2)));
    const flip = dot(ngW, d) > 0;
    const sgn = flip ? -1 : 1;
    const ng = scl(ngW, sgn);

    const w0 = 1 - hit.u - hit.v;
    const n0 = decodeOct(AU[aw + ATTR_W.n0]), n1 = decodeOct(AU[aw + ATTR_W.n1]), n2 = decodeOct(AU[aw + ATTR_W.n2]);
    let nI = norm(nrm(add(add(scl(n0, w0), scl(n1, hit.u)), scl(n2, hit.v))));
    if (m.flags & MAT_FLAG.flatShading) nI = ngW;
    const uvs = [0, 1, 2].map((k) => [AF[aw + ATTR_W.uv0 + 2 * k], AF[aw + ATTR_W.uv0 + 2 * k + 1]]);
    const uv: [number, number] = [
      uvs[0][0] * w0 + uvs[1][0] * hit.u + uvs[2][0] * hit.v,
      uvs[0][1] * w0 + uvs[1][1] * hit.u + uvs[2][1] * hit.v
    ];
    const duv1 = [uvs[1][0] - uvs[0][0], uvs[1][1] - uvs[0][1]], duv2 = [uvs[2][0] - uvs[0][0], uvs[2][1] - uvs[0][1]];
    const uvDet = duv1[0] * duv2[1] - duv1[1] * duv2[0];
    const hasFrame = Math.abs(uvDet) > 1e-20;
    const r = 1 / (hasFrame ? uvDet : 1);
    const tW = dir(scl(sub(scl(e1, duv2[1]), scl(e2, duv1[1])), r));
    const bW = dir(scl(sub(scl(e2, duv1[0]), scl(e1, duv2[0])), r));

    const cosT = Math.max(Math.abs(dot(ngW, d)), B5_LOD_MIN_COS);
    const lod = AF[aw + ATTR_W.lodConst] + Math.log2(Math.max(Math.abs(det), 1e-30)) / 3 + Math.log2(Math.max(coneW, 1e-12)) -
      Math.log2(cosT) + F[FRAME_F.lodBias];

    const ok = (i: number | undefined): i is number => i !== undefined && i !== NO_TEX;
    let albedoTex: V3 = [1, 1, 1];
    if (ok(m.tex.albedo)) albedoTex = sample(m.tex.albedo, uv, lod).slice(0, 3) as V3;
    let base = mul(mul(m.baseColor, albedoTex), decodeRgb9e5(IU[iw + INST_W.tint], [0, 0, 0]) as number[]);
    if (m.flags & MAT_FLAG.vertexColors) {
      const c = [ATTR_W.c0, ATTR_W.c1, ATTR_W.c2].map((k) => decodeRgb9e5(AU[aw + k], [0, 0, 0]) as number[]);
      base = mul(base, add(add(scl(c[0], w0), scl(c[1], hit.u)), scl(c[2], hit.v)));
    }
    let nMap = nI;
    if (ok(m.tex.normal) && hasFrame) {
      const s = sample(m.tex.normal, uv, lod);
      const sc = m.normalScale;
      const mm = [(s[0] * 2 - 1) * sc[0], (s[1] * 2 - 1) * sc[1], s[2] * 2 - 1];
      const tt = sub(tW, scl(nI, dot(nI, tW))), bb = sub(bW, scl(nI, dot(nI, bW)));
      const lt = len(tt), lb = len(bb);
      if (lt >= 1e-12 && lb >= 1e-12) nMap = norm(add(add(scl(tt, mm[0] / lt), scl(bb, mm[1] / lb)), scl(nI, mm[2])));
    }
    let rough = m.rough;
    let emission: V3;
    let water = 0;
    let slope: [number, number] = [0, 0];
    let ns = nMap;
    const chS = (c: number): V3 => [F[c * 4], F[c * 4 + 1], F[c * 4 + 2]];

    if (m.kind === MAT_KIND.hull) {
      const rep = F[FRAME_F.detailRep];
      const mask = ok(m.tex.mask) ? sample(m.tex.mask, uv, lod).slice(0, 3) : [0, 0, 0];
      let dGrass = 1, dPave = 1;
      if (ok(m.tex.detail)) {
        dGrass = sample(m.tex.detail, [uv[0] * rep, uv[1] * rep], lod + Math.log2(rep))[0];
        dPave = sample(m.tex.detail, [uv[0] * rep * 0.31, uv[1] * rep * 0.31], lod + Math.log2(rep * 0.31))[0];
      }
      const o = evaluateKernel(hullSurface, {
        base, mask, dGrass, dPave, baseRough: rough,
        p: [uv[0] * 2 * Math.PI * F[FRAME_F.hullR], uv[1] * F[FRAME_F.hullL]],
        far: farFromFootprint(coneW), theta: 0, z: 0
      }, {
        time: F[FRAME_F.time], flow: F[FRAME_F.flow], foam: F[FRAME_F.foam], ripple: F[FRAME_F.ripple],
        waterTint: [F[FRAME_F.waterTint], F[FRAME_F.waterTint + 1], F[FRAME_F.waterTint + 2]],
        cityGlow: 1, citySpill: F[FRAME_F.citySpill],
        sparShade: 0, armW: 0, sparZW: 0,
        arms: new Array<number>(TRACER_HULL_OPTIONS.nArm).fill(0), sparZ: new Array<number>(TRACER_HULL_OPTIONS.nSpar).fill(0)
      }, TRACER_HULL_OPTIONS);
      base = o.albedo as V3;
      rough = o.roughness as number;
      water = o.water as number;
      slope = o.slope as [number, number];
      emission = mul(o.emissive as number[], chS(CH_CITY_GLOW));
      if (hasFrame && water > 0) {
        const nRip = norm(add(add(nI, scl(norm(tW), slope[0])), scl(norm(bW), slope[1])));
        ns = norm(add(scl(nMap, 1 - water), scl(nRip, water)));
      }
    } else if (m.kind === MAT_KIND.unlit) {
      emission = mul(mul(m.emissive, albedoTex), chS(ch));
      rough = 1;
    } else {
      let emTex: V3 = [1, 1, 1];
      if (ok(m.tex.emissive)) emTex = sample(m.tex.emissive, uv, lod).slice(0, 3) as V3;
      emission = mul(mul(m.emissive, emTex), chS(ch));
      if (ok(m.tex.rough)) rough *= sample(m.tex.rough, uv, lod)[1];
    }

    ns = scl(ns, sgn);
    const dn = dot(ns, ng);
    if (dn < 1e-3) ns = norm(add(ns, scl(ng, 1e-3 - dn)));
    return {
      p, kind: m.kind, ng, matId: m.id, ns, rough, albedo: base,
      metal: m.kind === MAT_KIND.unlit ? 0 : m.metal,
      emission, water, tint: m.tint, ior: m.ior, slope, coneW, frontFace: hit.flags & HIT_FRONT, lod
    };
  };
  return { surface, sample };
}
