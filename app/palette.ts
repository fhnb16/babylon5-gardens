import { CONFIG } from './cfg.ts';
import { app, world } from './state.ts';
import { lightingAt } from '../core/lighting/phases.ts';
import { setAmbientShare } from '../js/photo.js';

/* ═══════════════════════════════════════════════════════════════════════════
   ПАЛИТРА ДЕНЬ / НОЧЬ
   Ночью солнечная трубка не гаснет, а тлеет холодным — ночник на оси,
   который даёт эмбиентную подсветку вместо чёрной пустоты.

   Сам расчёт — в ядре: core lightingAt(phase) отдаёт состояние освещения
   (прежняя математика main.js, перенесённая один в один), а мир применяет
   его сам — world.applyLighting (backends/three/adapt/palette.ts). Здесь
   остался учёт фазы и то, что нужно приложению вокруг.
   ═══════════════════════════════════════════════════════════════════════════ */
export function applyPalette(ph: number) {
  const s = lightingAt(ph);
  app.daylight = s.daylight;
  if (!world) return;
  world.applyLighting(s);
  /* столько света остаётся в тени от осевых источников — по нему
     трассировка и решает, насколько темнить затенённое */
  const n = world.lights.points.length;
  setAmbientShare(s.hemiIntensity / (s.hemiIntensity + n * s.pointIntensity + 1e-6));
}

/** Насколько ярко светит труба в текущей фазе: то же значение, что управляет
    ею в обычном кадре. По нему трассировка выставляет свой источник. */
export function sunLevelNow() {
  return lightingAt(app.phase).sunEmission;
}

/** Номер фазы, к которой идёт переход: 0 день, 1 закат, 2 ночь */
export function phaseIndex() {
  const n = CONFIG.PHASES.length;
  return ((Math.round(app.phaseTo) % n) + n) % n;
}
