/* PT-U3: material packing round trip, palette / frame uniform values. */
import { describe, expect, test } from 'vitest';
import { buildScene, defaultParams } from '../../core/scene/build.ts';
import { exposureFromEv100, lightingAt } from '../../core/lighting/phases.ts';
import { CORE_CONFIG } from '../../core/config/index.ts';
import {
  CHANNELS, CH_NONE, CH_TUBE, FRAME_F, FRAME_FLOATS, MAT_BYTES, MAT_FLAG, MAT_KIND, NO_TEX, describeMaterial,
  fromHalf, isEmissiveMaterial, isRasterOnlyMaterial, paletteUniform, readMaterial, toHalf, writeMaterial
} from '../materials.ts';

const scene = buildScene({ ...defaultParams('HIGH'), seed: 1337 });
const f = Math.fround;

describe('material record', () => {
  test('f16 helpers', () => {
    for (const x of [0, 1, -1, 0.5, 1.1, 0.8, 65504, 2 ** -14, 2 ** -24, -0.333]) {
      expect(fromHalf(toHalf(x))).toBeCloseTo(x, Math.abs(x) > 1000 ? -2 : 3);
    }
    expect(toHalf(1)).toBe(0x3c00);
    expect(toHalf(-2)).toBe(0xc000);
    expect(toHalf(1e6)).toBe(0x7c00);
  });

  test('every traced material of the real scene survives pack → unpack', () => {
    const ids = Object.keys(scene.materials).filter((id) => !isRasterOnlyMaterial(scene.materials[id]));
    expect(ids.length).toBeGreaterThan(20);
    const buf = new ArrayBuffer(ids.length * MAT_BYTES);
    const recs = ids.map((id, i) => {
      const tex = { albedo: (i * 3) % 7, normal: i % 2 ? NO_TEX : 40 + i, rough: NO_TEX, emissive: 255, mask: 1, detail: 2 };
      const p = describeMaterial(scene.materials[id], Object.keys(scene.materials).indexOf(id), tex);
      writeMaterial(buf, i, p);
      return p;
    });
    recs.forEach((p, i) => {
      const q = readMaterial(buf, i);
      const m = scene.materials[ids[i]];
      expect(q.kind).toBe(p.kind);
      expect(q.flags).toBe(p.flags);
      expect(q.channel).toBe(p.channel);
      expect(q.id).toBe(p.id);
      expect(q.baseColor).toEqual(p.baseColor.map(f));
      expect(q.emissive).toEqual(p.emissive.map(f));
      expect(q.tint).toEqual(p.tint.map(f));
      expect(q.rough).toBe(f(m.roughness));
      expect(q.metal).toBe(f(m.metalness));
      expect(q.ior).toBe(f(m.ior ?? 1.5));
      expect(q.normalScale[0]).toBeCloseTo(m.normalScale?.[0] ?? 1, 3);
      expect(q.tex.albedo).toBe(p.tex.albedo);
      expect(q.tex.normal).toBe(p.tex.normal);
      if (p.kind === MAT_KIND.hull) {
        expect(q.tex.mask).toBe(1);
        expect(q.tex.detail).toBe(2);
      } else {
        expect(q.tex.rough).toBe(NO_TEX);
        expect(q.tex.emissive).toBe(255);
      }
    });
  });

  test('kinds, flags, channels and emission colours', () => {
    const d = (id: string) => describeMaterial(scene.materials[id], 0, { albedo: NO_TEX, normal: NO_TEX, rough: NO_TEX, emissive: NO_TEX });
    expect(d('w.hull').kind).toBe(MAT_KIND.hull);
    expect(d('s.lift.glass').kind).toBe(MAT_KIND.thinGlass);
    expect(d('s.lift.glass').tint).toEqual([0.9, 0.94, 0.97]);
    expect(d('w.traffic.lamp.front').kind).toBe(MAT_KIND.unlit);
    expect(d('w.traffic.lamp.front').emissive).toEqual([1, 0.96, 0.85]); // unlit: base colour emits
    expect(d('s.sun').channel).toBe(CH_TUBE);
    expect(d('s.sun').emissive).toEqual([1, 1, 1]);                      // colour comes from the palette
    expect(d('w.bld.wall.0').channel).toBe(CHANNELS.indexOf('windows'));
    expect(d('w.crowns.lod0').flags).toBe(MAT_FLAG.vertexColors | MAT_FLAG.instanceColors | MAT_FLAG.flatShading);
    expect(d('w.tufts').flags & MAT_FLAG.doubleSided).toBeTruthy();
    expect(d('s.metal').channel).toBe(CH_NONE);
    expect(d('s.metal').emissive).toEqual([0, 0, 0]);
    expect(isEmissiveMaterial(scene.materials['w.bld.wall.0'])).toBe(true);
    expect(isEmissiveMaterial(scene.materials['s.metal'])).toBe(false);
    expect(isEmissiveMaterial(scene.materials['w.nav'])).toBe(false); // sprite: raster only
    expect(() => describeMaterial(scene.materials['w.blob'], 0, { albedo: 0, normal: 0, rough: 0, emissive: 0 })).toThrow(/raster-only/);
    // static emitter without a channel: colour × emissiveNits
    const p = describeMaterial({ ...scene.materials['s.metal'], emissive: [0.5, 1, 0], emissiveNits: 100 }, 0,
      { albedo: NO_TEX, normal: NO_TEX, rough: NO_TEX, emissive: NO_TEX });
    expect(p.emissive).toEqual([50, 100, 0]);
  });
});

describe('paletteUniform', () => {
  const exp = (ev: number) => 1 / (1.2 * 2 ** ev);

  test('DAY', () => {
    const st = lightingAt(0);
    const u = paletteUniform(st, { time: 12.5 });
    expect(u.length).toBe(FRAME_FLOATS);
    const e = exp(CORE_CONFIG.PHYS.DAY.ev100);
    expect(exposureFromEv100(12.5)).toBeCloseTo(e, 12);
    const tube = CHANNELS.indexOf('tube') * 4;
    const P = CORE_CONFIG.PHYS.DAY;
    for (let k = 0; k < 3; k++) expect(u[tube + k]).toBeCloseTo(f(st.phys.tubeColor[k] * P.tubeNits * e), 4);
    expect(u[tube]).toBeCloseTo(f(P.tubeNits * e), 4); // tube colour max = 1 (red)
    expect(u[CHANNELS.indexOf('windows') * 4]).toBe(0);
    expect(u[CHANNELS.indexOf('liftLamp') * 4 + 1]).toBeCloseTo(f(P.channelNits.liftLamp * e), 6);
    expect(u[CH_NONE * 4]).toBeCloseTo(f(e), 9);
    expect(u[FRAME_F.exposure]).toBeCloseTo(f(e), 9);
    expect(u[FRAME_F.time]).toBe(12.5);
    expect(u[FRAME_F.flow]).toBe(f(CORE_CONFIG.RIVER_FLOW));
    expect(u[FRAME_F.foam]).toBe(f(CORE_CONFIG.WATER.foam));
    expect(u[FRAME_F.ripple]).toBe(f(CORE_CONFIG.WATER.ripple));
    expect(u[FRAME_F.citySpill]).toBe(f(CORE_CONFIG.CITY.spill));
    expect(u[FRAME_F.detailRep]).toBe(CORE_CONFIG.DETAIL_REP);
    expect(u[FRAME_F.hullR]).toBe(50);
    expect(u[FRAME_F.hullL]).toBe(300);
    for (let k = 0; k < 3; k++) expect(u[FRAME_F.waterTint + k]).toBe(f(st.phys.waterTint[k]));
  });

  test('NIGHT', () => {
    const st = lightingAt(2);
    const u = paletteUniform(st);
    const e = exp(CORE_CONFIG.PHYS.NIGHT.ev100);
    expect(u[FRAME_F.exposure]).toBeCloseTo(f(e), 9);
    const P = CORE_CONFIG.PHYS.NIGHT;
    expect(u[CHANNELS.indexOf('windows') * 4]).toBeCloseTo(f(P.channelNits.windows * e), 6);
    expect(u[CHANNELS.indexOf('cityGlow') * 4 + 2]).toBeCloseTo(f(P.channelNits.cityGlow * e), 6);
    expect(u[CHANNELS.indexOf('tube') * 4 + 3]).toBeCloseTo(f(P.tubeNits * e), 5);
    // calibrated: night windows = raster winEmis (0.9) in tonemap units
    expect(u[CHANNELS.indexOf('windows') * 4]).toBeCloseTo(0.9, 2);
    expect(u[FRAME_F.time]).toBe(0);
  });
});
