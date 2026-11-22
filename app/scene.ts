import { CONFIG } from './cfg.ts';
import { app, renderer, scene, camera, world, worldGroup, setWorld, currentQuality } from './state.ts';
import { applyPalette } from './palette.ts';
import { ride } from './ride.ts';
import { buildScene } from '../core/scene/build.ts';
import type { QualityId, WorldParams } from '../core/scene/types.ts';
import { TEX } from '../core/textures/ids.ts';
import { createThreeWorld } from '../backends/three/adapt/sceneGraph.ts';
import { createTexturePool, type TexturePool } from './workers/texturePool.ts';
import { setCollider } from '../js/controls.js';

/* ═══════════════════════════════════════════════════════════════════════════
   МИР: core buildScene(params) → backends/three createThreeWorld.

   Пересборка при смене качества, сезона, зерна, насыщенности, зелени.
   Описание мира строится в главном потоке (чистые данные), пиксели текстур —
   в workers (app/workers/texturePool.ts). Пока они считаются, на экране
   остаётся прежний мир (при запуске — заставка): подмена происходит, только
   когда у нового мира готовы все текстуры, без кадров с пустыми картами.
   Запрос, который успел устареть (настройку крутанули ещё раз), выбрасывается.
   ═══════════════════════════════════════════════════════════════════════════ */
let pool: TexturePool | null = null;
export let photoScene: ReturnType<typeof buildScene> | null = null;
export const photoImages = (specs: Parameters<TexturePool['generate']>[0]) =>
  pool!.generate(specs, { clear: true });
let generation = 0;

/** Параметры мира из CONFIG, который правят настройки (и prefs при запуске) */
export function worldParams(): WorldParams {
  return {
    seed: CONFIG.SEED >>> 0,
    quality: currentQuality() as QualityId,
    season: CONFIG.SEASON,
    saturation: CONFIG.SATURATION,
    greenK: CONFIG.GREEN_K
  };
}

/** Пересобрать мир. true — новый мир на месте, false — запрос устарел. */
export async function rebuild(): Promise<boolean> {
  const my = ++generation;
  const desc = buildScene(worldParams());
  pool ??= createTexturePool();
  const next = createThreeWorld(desc, renderer, {
    textures: 'pool', pool,
    /* воду трассировщику пути подсовывает фото-режим: эти карты ни один
       материал не использует, их надо создать до загрузки пикселей */
    extraTextures: [TEX.waterRough, TEX.waterNormal]
  });
  try {
    await next.ready;
  } catch (e) {
    next.dispose();
    throw e;
  }
  if (my !== generation) { next.dispose(); return false; }

  /* станция продолжает вращаться с того же угла */
  next.stationGroup.rotation.z = worldGroup.rotation.z;
  world?.dispose();
  scene.add(next.stationGroup, next.sceneGroup);
  scene.fog = next.fog;
  scene.background = next.background;
  setWorld(next);
  photoScene = desc;

  /* то, что настройки уже сказали прежнему миру */
  next.mirror = app.mirrorOn;
  next.windUniforms.uWind.value = app.windNow;
  next.setTraffic(app.trafficOn);
  next.setLiftInside(ride.on);
  applyPalette(app.phase);
  /* раскладку деревьев зовём сразу: до неё уровни детализации пусты */
  next.stationGroup.updateMatrixWorld(true);
  next.setDetailFull(app.detailFull, camera);
  /* камера сталкивается с корпусом: рельеф холмов настоящий */
  setCollider(next.collider);
  return true;
}

/** Ветер в шейдере: запоминается и для следующего мира */
export function setWind(v: number) {
  app.windNow = v;
  if (world) world.windUniforms.uWind.value = v;
}

/** Деревья на полной детализации (фото-режим) */
export function setDetailFull(on: boolean) {
  app.detailFull = on;
  world?.setDetailFull(on, camera);
}
