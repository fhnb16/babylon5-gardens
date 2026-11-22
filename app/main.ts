import { $, stage } from './dom.ts';
import { app, renderer, camera } from './state.ts';
import { prefs, applyStoredWorld } from './prefs.ts';
import { probeWebGL, boot, bootRenderer } from './boot.ts';
import { fly } from './flight.ts';
import { tour } from './tour.ts';
import { stopTracing, markPhotoButtons } from './photo-mode.ts';
import { resetDpr, resize } from './perf.ts';
import { loop, clock } from './loop.ts';
import { initCommands } from './commands.ts';
import { parseTvMode } from './tv-mode.ts';
import { startTvMode } from './tv.ts';
import { initHud } from './ui/hud.ts';
import { initTeleportMenu } from './ui/teleport-menu.ts';
import { initSettings } from './ui/settings.ts';
import { initHelp } from './ui/help.ts';
import { initTvOverlay, isOverlayOpen } from './ui/tv-overlay.ts';
import { dispatch, type Action } from './input/actions.ts';
import { initKeyboard } from './input/keyboard.ts';
import { initPointer } from './input/pointer.ts';
import { initTouch } from './input/touch.ts';
import { suspendAudio } from '../js/audio.js';
import { trace } from '../js/photo.js';

/* ═══════════════════════════════════════════════════════════════════════════
   ЗАПУСК
   Точка входа (index.html). Порядок: настройки мира из prefs → рендерер
   (WebGPU поднимается асинхронно — его ждём) → сцена (мир строится
   асинхронно) → действия и ввод → интерфейс → размер → цикл.
   ═══════════════════════════════════════════════════════════════════════════ */
declare global {
  interface Window {
    GardensAndroid?: { close(): void; checkUpdates(): void; screenSaverSettings(): void };
    /** первый кадр отрисован — сигнал браузерному тесту */
    __b5ready?: boolean;
    /** отладочный вход: состояние и действия (браузерный тест ТВ-режима) */
    __b5?: { state: () => Record<string, unknown>; dispatch: (a: Action, arg?: number) => boolean };
  }
}

app.tv = parseTvMode(location.search, prefs.get('tvMode', false));
applyStoredWorld(app);

async function start() {
  probeWebGL();
  await bootRenderer();
  /* мир догружается асинхронно (текстуры в workers); цикл ждёт его сам */
  boot().catch(err => {
    console.error(err);
    $('fatal').classList.add('show');
  });
  initCommands();
  initKeyboard();
  initPointer(renderer.domElement, stage, () => fly.on || trace.active,
    () => dispatch('cancel'));
  initTouch();
  initHud();
  markPhotoButtons();
  initTeleportMenu();
  initSettings();
  initHelp();
  if (window.GardensAndroid && !app.tv) {
    const update = $('androidUpdate');
    update.hidden = false;
    update.addEventListener('click', () => dispatch('checkUpdates'));
  }
  initTvOverlay();

  resetDpr();
  resize();

  if ('ResizeObserver' in window) new ResizeObserver(resize).observe(stage);
  addEventListener('resize', resize);
  visualViewport?.addEventListener('resize', resize);
  addEventListener('orientationchange', () => setTimeout(resize, 250));
  for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) {
    document.addEventListener(ev, () => setTimeout(resize, 80));
  }
  document.addEventListener('visibilitychange', () => {
    app.paused = document.hidden;
    suspendAudio(app.paused);
    if (!app.paused) clock.update();
  });
  addEventListener('keydown', stopTracing);
  renderer.domElement.addEventListener('webglcontextlost', e => {
    e.preventDefault(); app.paused = true;
    $('fatal').classList.add('show');
    $('fatal').firstElementChild.innerHTML =
      '<b>Графический контекст потерян</b><br>Обновите страницу — сцена соберётся заново.';
  });

  /* PWA: worker нужен только для критерия устанавливаемости, кеша в нём нет */
  if (!window.GardensAndroid && 'serviceWorker' in navigator && location.protocol !== 'file:') {
    /* воркер импортирует версию, значит регистрируется как модуль */
    addEventListener('load', () => navigator.serviceWorker
      .register('sw.js', { type: 'module' }).catch(() => {}));
  }

  if (app.tv) startTvMode();

  window.__b5 = {
    state: () => ({
      tv: app.tv, flying: fly.on, flights: app.flights, view: app.view,
      tour: tour.on, phaseTo: app.phaseTo, autoCycle: app.autoCycle, held: app.held,
      tourHold: app.tourHold, overlay: isOverlayOpen(),
      camera: camera.position.toArray()
    }),
    dispatch
  };

  loop();
}

start().catch(err => {
  console.error(err);
  $('fatal').classList.add('show');
});
