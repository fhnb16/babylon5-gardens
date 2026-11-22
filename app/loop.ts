import * as THREE from 'three';
import { CONFIG } from './cfg.ts';
import { $ } from './dom.ts';
import { app, renderer, scene, camera, worldGroup, world } from './state.ts';
import { applyPalette } from './palette.ts';
import { fly, updateFly } from './flight.ts';
import { updateTour } from './tour.ts';
import { ride, updateRide } from './ride.ts';
import { showTrace, traceReport } from './photo-mode.ts';
import { grabShot } from './shot.ts';
import { adaptFrame } from './perf.ts';
import { setDayIcon } from './ui/hud.ts';
import { pollGamepads } from './input/gamepad.ts';
import { TEX } from '../core/textures/ids.ts';
import { ctl, updateControls } from '../js/controls.js';
import { updateAudio } from '../js/audio.js';
import { pt, pathStarting, pathStep, pathLabel, pathCameraMoved } from './path-session.ts';
import { trace, traceStep, setSunScreen, renderFrame, DEBUG_NAMES, setHullRef } from '../js/photo.js';
import { isClassic, renderNow, startLoop } from './boot.ts';

/* ═══════════════════════════════════════════════════════════════════════════
   ЦИКЛ
   ═══════════════════════════════════════════════════════════════════════════ */
/* THREE.Clock с r183 устарел и пишет предупреждение в консоль; Timer — его
   замена: update() раз в кадр, getDelta() отдаёт шаг в секундах. */
export const clock = new THREE.Timer();
let cycleT = 0;
const _vAudio = new THREE.Vector3(), _ptPrev = new THREE.Vector3();
const _ptOrient = new THREE.Quaternion();

/** Запуск цикла: классический — requestAnimationFrame, WebGPURenderer —
    setAnimationLoop (только в нём three двигает кадр узлов: см. boot.ts) */
export function loop() {
  startLoop(renderer, frame);
}

function frame() {
  if (app.paused) return;
  /* мир собирается асинхронно (текстуры в workers): до него кадр не рисуется */
  if (!world) return;
  clock.update();
  const frameDt = Math.min(0.05, clock.getDelta());
  /* Пауза по действию: мир, тур и цикл фаз стоят, кадр рисуется дальше —
     полёт тоже стоит, обзор мышью и стиком геймпада работает. */
  const dt = app.held ? 0 : frameDt;
  renderer.info.reset();          // за кадр целиком, а не за последний проход
  pollGamepads(frameDt);
  // Keep the displayed pose and the captured dynamics aligned during device acquisition.
  if (pathStarting && !pt.active) return;

  /* Путь выводит кадр сам, поэтому обычная отрисовка пропускается целиком.
     Сдвиг камеры сбрасывает накопление: считается новый ракурс. */
  if (pt.active) {
    if (!camera.position.equals(_ptPrev) || !camera.quaternion.equals(_ptOrient)) {
      _ptPrev.copy(camera.position);
      _ptOrient.copy(camera.quaternion);
      pathCameraMoved();
    }
    pathStep();
    showTrace(traceReport());
    /* Затвор обязан работать и здесь. Раньше ветка возвращалась раньше его
       обработки, и снимок во время трассировки не делался вовсе — это
       выглядело как «интерфейс заблокирован нагрузкой», хотя поток свободен. */
    if (app.shotPending) { app.shotPending = false; grabShot(); }
    return;
  }
  /* Отказ показывается и после того, как трассировка снялась: иначе нажатие
     выглядит как «ничего не произошло». */
  if (pt.error) {
    showTrace(pathLabel());
    $('bPath').classList.remove('on');
  }

  if (trace.active) {
    let done = 1;
    if (!app.traceHeld) {
      if (isClassic()) done = traceStep();
      else if (trace.sample < trace.total) {
        renderNow(renderer, scene, camera, worldGroup.rotation.z);
        done = ++trace.sample / trace.total;
      }
    }
    /* Показываем не только проценты, но и оставшийся шум: по нему видно,
       что именно ещё уточняется, а проценты сами по себе ни о чём не говорят. */
    const noise = 100 / Math.sqrt(Math.max(1, trace.sample) * trace.rays);
    const what = trace.debug ? `только ${DEBUG_NAMES[trace.debug]} · ` : '';
    if (!isClassic()) {
      const status = app.traceHeld ? 'пауза · очистка' : done >= 1 ? 'готово' : 'накопление';
      $('traceInfo').textContent = `${what}${status} · кадр ${trace.sample} из ${trace.total}`;
    } else $('traceInfo').textContent = done >= 1
      ? `${what}готово · ${trace.total * trace.rays} лучей на пиксель`
      : `${what}${(done * 100) | 0}% · шум ${noise.toFixed(0)}%`;
    if (app.shotPending) { app.shotPending = false; grabShot(); }
    return;
  }

  worldGroup.rotation.z += app.omega * dt;
  /* Мир за кадр: время шейдеров, кабины монорельса и машины, раскладка
     деревьев по уровням (пересчёт, только когда камера заметно сдвинулась),
     ореол трубы к камере, камера в системе станции для отражений в воде,
     мигание маяка. */
  world.mirror = app.mirrorOn;
  world.update(dt, camera);
  setSunScreen(camera, worldGroup);
  /* отражениям нужно альбедо корпуса и текущий угол поворота мира */
  setHullRef(world.textures.get(TEX.hullAlbedo), worldGroup.rotation.z);

  /* Авто-режим гонит фазу по кругу непрерывно: день сам перетекает в закат,
     закат в ночь, ночь снова в день. Ручное переключение двигает цель на одну
     фазу вперёд — переход всё равно идёт плавно, а не скачком. */
  if (app.autoCycle) {
    cycleT += dt;
    if (cycleT > CONFIG.AUTO_CYCLE_PERIOD) { cycleT = 0; app.phaseTo += 1; setDayIcon(); }
  }
  if (app.phase < app.phaseTo) {
    app.phase = Math.min(app.phaseTo, app.phase + dt / CONFIG.FADE);
    applyPalette(app.phase);
  } else if (app.phase > app.phaseTo) {
    /* назад — только по действию prevPhase (пульт ↓), тоже плавно */
    app.phase = Math.max(app.phaseTo, app.phase - dt / CONFIG.FADE);
    applyPalette(app.phase);
  } else if (app.phase >= CONFIG.PHASES.length) {
    /* держим счётчики в пределах круга, чтобы не росли бесконечно */
    app.phase -= CONFIG.PHASES.length; app.phaseTo -= CONFIG.PHASES.length;
  }

  updateTour(dt);
  updateFly(dt);
  if (!fly.on && !ride.on) updateControls(dt, camera);
  else if (ride.on) { updateControls(dt, camera); updateRide(); }

  /* звуку нужна позиция камеры в системе станции: и река, и ось живут там */
  worldGroup.worldToLocal(_vAudio.copy(camera.position));
  updateAudio(dt, _vAudio, ctl.speed * (ctl.boost ? CONFIG.SPEED_BOOST : 1), app.daylight);

  /* классический — цепочка js/photo.js, новый путь — RenderPipeline (boot.ts) */
  if (isClassic()) renderFrame(renderer, scene, camera, worldGroup.rotation.z);
  else renderNow(renderer, scene, camera, worldGroup.rotation.z);
  /* Сигнал готовности для браузерного дымового теста: первый кадр отрисован */
  if (!window.__b5ready) window.__b5ready = true;
  if (app.shotPending) { app.shotPending = false; grabShot(); }

  adaptFrame(frameDt);
}
