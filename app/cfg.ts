/* CONFIG для приложения.

   js/config.js — изменяемый глобальный объект, который приложение читает
   динамически: фазы освещения по имени (CONFIG[P[i]]), пресеты по ключу
   качества, CONFIG.PATH[key] из общих помощников настроек. Выведенный из JS
   литеральный тип такой доступ запрещает, поэтому приложение видит CONFIG
   нестрого. Объект тот же самый: запись сюда меняет CONFIG для всех.

   Реестров материалов (worldMats/structMats) больше нет: мир с v2.12.0
   строит ядро (core/scene) через адаптер backends/three, и материалы живут
   в ThreeWorld (app/state.ts → world). */
import { CONFIG as RAW } from '../js/config.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const CONFIG: any = RAW;
