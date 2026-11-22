import * as THREE from 'three';
import { CONFIG } from './cfg.ts';
import { TAU } from '../core/math/scalar.ts';
import type { ThreeWorld } from '../backends/three/adapt/sceneGraph.ts';
import type { AnyRenderer } from '../backends/three/renderer.ts';
import { isMobile } from '../js/controls.js';

/* ═══════════════════════════════════════════════════════════════════════════
   ОБЩЕЕ СОСТОЯНИЕ ПРИЛОЖЕНИЯ

   В main.js всё это было переменными модуля. После разбора по app/* их
   читают и пишут разные модули, поэтому состояние собрано в одном месте:

   • сцена (renderer, scene, camera) создаётся один раз в boot.ts (рендерер —\n     одного из трёх видов, см. там же) и
     отдаётся сюда через initScene(). Экспорт через let — живая привязка
     ES-модулей: каждый модуль видит текущее значение по имени, а
     переприсвоить его может только этот файл;
   • мир (world: ThreeWorld из backends/three) пересобирается при смене
     качества, сезона, зерна, насыщенности, зелени — setWorld(). worldGroup
     — его stationGroup: группа, которая вращается вместе со станцией (как
     прежний worldGroup); до первой сборки — пустая группа-заглушка;
   • всё изменяемое по ходу работы — поля объекта app.
   ═══════════════════════════════════════════════════════════════════════════ */
/** классический WebGLRenderer или WebGPURenderer (WebGPU / откат WebGL2) — см. boot.ts */
export let renderer!: AnyRenderer;
export let scene!: THREE.Scene;
export let camera!: THREE.PerspectiveCamera;
export let worldGroup!: THREE.Group;
export let world: ThreeWorld | null = null;

export function initScene(h: {
  renderer: AnyRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera;
  /** заглушка станции до первой сборки (тесты подставляют свою) */
  worldGroup?: THREE.Group;
}) {
  ({ renderer, scene, camera } = h);
  worldGroup = h.worldGroup ?? new THREE.Group();
}

/** Новый мир становится текущим: worldGroup — его вращающаяся группа */
export function setWorld(w: ThreeWorld) {
  world = w;
  worldGroup = w.stationGroup;
}

export const app = {
  /** ТВ-режим: без интерфейса, управление с пульта (см. tv.ts) */
  tv: false,
  /** выбранный пресет качества; 'AUTO' решается по устройству */
  quality: 'AUTO',

  /* Фаза освещения идёт по кругу: 0 день → 1 закат → 2 ночь → снова день.
     Хранится дробной, поэтому переход всегда плавный, а не переключением. */
  phase: 0, phaseTo: 0, daylight: 1,
  autoCycle: false,

  /** угловая скорость станции, рад/с */
  omega: TAU / CONFIG.ROT_PERIOD_DEFAULT,
  omegaSaved: 0,
  /** вкладка скрыта или потерян контекст — цикл стоит целиком */
  paused: false,
  /** пауза по действию togglePause: мир, тур и цикл замирают, кадр рисуется */
  held: false,

  /** последняя точка обзора, куда летели или сели */
  view: 0,
  /** счётчик перелётов — по нему тесты видят, что перелёт начался */
  flights: 0,
  /** стоянка в точке авто-тура, с */
  tourHold: CONFIG.TOUR_HOLD as number,

  /* фото-режим и съёмка */
  cleanView: false, shotPending: false, traceHeld: false,
  /** текущий порог шума: сводка читает его снаружи, регулятор — в настройках */
  noiseWant: 3,

  /* производительность */
  dprIndex: 0, dprCap: 0,
  /** заданная вручную доля масштабирования; 0 — за неё отвечает адаптация */
  fsrFixed: 0,
  ssaa: 1, shotBoost: 1, aaLabel: 'MSAA',
  showFps: false,

  /* то, что настройки сообщают кадру (и каждому новому миру) */
  windBase: 1, mirrorOn: 0,
  /** ветер, который сейчас стоит в шейдере: windBase, а под TAA — 0 */
  windNow: 1,
  glowOn: false, raysOn: false, trafficOn: true,
  /** деревья на полной детализации (фото-режим): переживает пересборку */
  detailFull: false
};

export const currentQuality = (): string =>
  app.quality === 'AUTO' ? (isMobile || app.tv ? 'LOW' : 'HIGH') : app.quality;
