/* Until js/config.js is retired, the core copy must not drift from it. */
import { describe, expect, test } from 'vitest';
import { CONFIG } from '../../js/config.js';
import { CORE_CONFIG } from '../config/index.ts';

/** Keys whose names are identical in both configs. */
const SAME = [
  'R', 'L', 'HULL_SEG', 'HULL_RINGS', 'HULL_TEX', 'MASK_TEX', 'DETAIL_REP', 'SECT', 'AXIS',
  'TOWER', 'G_MIN', 'FLOOR_H', 'FLOOR_W', 'RIVER_FLOW', 'ROOF_TILE', 'FACADE_TILE', 'PANEL_TILE',
  'CITY', 'BLD', 'COUNT', 'HILL', 'TREE', 'BUSH', 'FOLIAGE', 'SEASONS', 'TOWER_CLEAR', 'SUN',
  'LIGHT_Z', 'LIGHT_Z_3', 'PHASES', 'DAY', 'DUSK', 'NIGHT', 'FADE', 'AUTO_CYCLE_PERIOD',
  'ROT_PERIOD_DEFAULT', 'ROT_PERIOD_CANON', 'TP', 'FLY', 'TOUR_HOLD', 'WATER', 'RAILBEAM',
  'LIFTCAR', 'COLLIDE', 'TREE_LOD', 'ENDCAP', 'PRINT', 'QUALITY', 'NORMALS', 'TRAFFIC',
  'CHUNKS', 'GREEN', 'AUDIO',
] as const;

describe('core config mirrors js/config.js', () => {
  for (const k of SAME) {
    test(k, () => {
      expect((CORE_CONFIG as Record<string, unknown>)[k]).toEqual((CONFIG as Record<string, unknown>)[k]);
    });
  }
  test('renamed defaults', () => {
    expect(CORE_CONFIG.SEED_DEFAULT).toBe(CONFIG.SEED_DEFAULT);
    expect(CORE_CONFIG.SEASON_DEFAULT).toBe(CONFIG.SEASON);
    expect(CORE_CONFIG.SATURATION_DEFAULT).toBe(CONFIG.SATURATION);
    expect(CORE_CONFIG.GREEN_K_DEFAULT).toBe(CONFIG.GREEN_K);
    expect(CORE_CONFIG.SUN_HDR).toBe(CONFIG.POST.sunHdr);
  });
});
