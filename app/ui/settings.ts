import { CONFIG } from '../cfg.ts';
import { $ } from '../dom.ts';
import { app, renderer, camera, world } from '../state.ts';
import { prefs } from '../prefs.ts';
import { rebuild, setWind } from '../scene.ts';
import { applyDpr, resetDpr, resize } from '../perf.ts';
import { TAU } from '../../core/math/scalar.ts';
import { ctl, syncFromCamera } from '../../js/controls.js';
import { setVolume } from '../../js/audio.js';
import { setPathScale, setNoiseTarget, samplesNeeded } from '../path-session.ts';
import { setPost, setDenoiseMode, setSharpen, setUpscaleFrom } from '../../js/photo.js';
import {
  isClassic, rendererInfo, rendererFromUrl, setPostOptions, wantedRendererMode, RENDERER_LABELS
} from '../boot.ts';
import { RENDERER_MODES, type RendererMode } from '../../backends/three/renderer.ts';
import type { AaFilterId, MsaaSamples } from '../../backends/three/post/options.ts';

/* setPost в photo.js объявлен с mode = null: выведенный из JS тип уже
   настоящего значения (объект режима или null) */
const setPostMode = setPost as (r: unknown, o: { mode: unknown; glow: boolean; rays: boolean }) => void;

/* ═══════════════════════════════════════════════════════════════════════════
   ШТОРКА НАСТРОЕК
   Каждая настройка: значение из prefs → первая покраска → обработчик,
   который меняет состояние, сохраняет его и перекрашивает строку.
   ═══════════════════════════════════════════════════════════════════════════ */
/** Пересборка мира из настроек: асинхронная, ошибка — на экран */
function reworld() {
  rebuild().catch(err => { console.error(err); $('fatal').classList.add('show'); });
}

/* «Рендерер»: строка создаётся здесь, рядом с качеством (первая вкладка).
   Смена — перезагрузка: канвас, материалы и цепочка кадра привязаны к
   рендереру при запуске. ?renderer= в адресе перебивает выбор; выбор в
   настройках снимает его из адреса. */
function initRendererRow() {
  const qual = $('sQual') as HTMLSelectElement | null;
  const anchor = qual?.closest('.row');
  if (!anchor || $('sRend')) return;
  const row = document.createElement('div');
  row.className = 'row';
  const label = document.createElement('label');
  label.textContent = 'Рендерер';
  const small = document.createElement('small');
  small.id = 'sRendV';
  label.appendChild(small);
  const sel = document.createElement('select');
  sel.id = 'sRend';
  for (const m of RENDERER_MODES) {
    const op = document.createElement('option');
    op.value = m; op.textContent = RENDERER_LABELS[m].toUpperCase();
    sel.appendChild(op);
  }
  row.append(label, sel);
  anchor.after(row);

  const want = wantedRendererMode();
  sel.value = want;
  const info = rendererInfo();
  const now = info ? RENDERER_LABELS[info.kind] : '';
  small.textContent = (info && info.kind !== want ? `сейчас ${now} (${info.fallback || 'откат'})` : `сейчас ${now}`)
    + (rendererFromUrl() ? ' · задан адресом' : '')
    + (info?.kind === 'webgl2' ? ' · экранные лучи доступны в WebGPU и classic' : '');
  sel.onchange = () => {
    prefs.set('renderer', sel.value as RendererMode);
    const u = new URL(location.href);
    u.searchParams.delete('renderer');
    location.replace(u.toString());
  };
}

export function initSettings() {
  initRendererRow();
  const sVol = $('sVol');
  sVol.value = prefs.get('vol', Math.round(CONFIG.AUDIO.volume * 100));
  sVol.oninput = () => {
    setVolume(sVol.value / 100);
    $('sVolV').textContent = sVol.value + '%';
    prefs.set('vol', +sVol.value);
  };
  sVol.oninput();

  /* app.quality из prefs ставит applyStoredWorld ещё до первой сборки:
     раньше сохранённое качество применялось только после неё */
  const sQual = $('sQual');
  sQual.value = app.quality;
  sQual.onchange = (e: Event) => {
    app.quality = (e.target as HTMLSelectElement).value;
    prefs.set('quality', app.quality);
    resetDpr(); applyDpr();
    reworld();
  };

  const sSeason = $('sSeason');
  sSeason.value = CONFIG.SEASON;
  sSeason.onchange = () => {
    CONFIG.SEASON = sSeason.value;
    prefs.set('season', CONFIG.SEASON);
    reworld();
  };

  /* Сглаживание: включатель отдельно от способа. MSAA работает всегда —
     он сглаживает края треугольников и стоит почти ничего. Сверху либо FXAA
     (дёшево, мылит мелкое), либо суперсэмплинг (честно, стоит квадрат). */
  /* Сглаживание собирается из трёх независимых частей: выборки покрытия,
     фильтр и масштаб рендера. Так видно, что именно даёт эффект — плоский
     список готовых режимов этого не показывал. «Выкл» гасит всё сразу,
     включая MSAA, поэтому канвас и создаётся без antialias. */
  const sAAon = $('sAAon'), sAAv = $('sAAv'), sAAcost = $('sAAcost');
  const sMsaa = $('sMsaa'), sFilter = $('sFilter'), sScale = $('sScale');

  /* Масштабирование обычного кадра. «Авто» оставляет долю за адаптацией по
     времени кадра, остальные значения задают её жёстко. */
  const sFsr = $('sFsr');
  for (const it of CONFIG.POST.FSR) {
    const op = document.createElement('option');
    op.value = String(it.v); op.textContent = it.label;
    sFsr.appendChild(op);
  }
  sFsr.value = String(prefs.get('fsr', 0));
  const showFsr = () => {
    const v = parseFloat(sFsr.value);
    app.fsrFixed = v > 0 ? v : 0;
    const it = CONFIG.POST.FSR.find((x: { v: number }) => x.v === v);
    $('sFsrV').textContent = it ? it.label.toLowerCase() : '';
    applyDpr();
  };
  sFsr.onchange = () => { prefs.set('fsr', parseFloat(sFsr.value)); showFsr(); };
  showFsr();

  /* ─── Глубокие настройки трассировки ───
     Их держит человек: у каждой своя цена, и «правильного» значения нет —
     оно зависит от того, что снимают. */
  const pick2 = (id: string, valId: string, list: number[], key: string, def: number,
    fmt: (v: number) => string) => {
    const el = $(id);
    if (!el) return;
    for (const v of list) {
      const op = document.createElement('option');
      op.value = String(v); op.textContent = fmt(v);
      el.appendChild(op);
    }
    el.value = String(prefs.get(key, def));
    const show = () => {
      const v = parseFloat(el.value);
      CONFIG.PATH[key] = v;
      if ($(valId)) $(valId).textContent = fmt(v);
    };
    el.onchange = () => { prefs.set(key, parseFloat(el.value)); show(); };
    show();
  };
  pick2('sBounce', 'sBounceV', CONFIG.PATH.BOUNCES, 'bounces', CONFIG.PATH.bounces,
    v => `${v}`);
  pick2('sRaysN', 'sRaysV', [2, 4, 8, 16], 'rays', CONFIG.PATH.rays,
    v => `${v}`);
  pick2('sRef', 'sRefV', CONFIG.PATH.REF_STEPS, 'refSteps', CONFIG.PHOTO.refSteps,
    v => `${v} шагов`);

  /* ползунки: экспозиция трассировки и яркость трубы */
  const slide = (id: string, valId: string, key: string, scale: number, fmt: (v: number) => string) => {
    const el = $(id);
    if (!el) return;
    el.value = String(Math.round(prefs.get(key, CONFIG.PATH[key]) * scale));
    const show = () => {
      const v = parseFloat(el.value) / scale;
      CONFIG.PATH[key] = v;
      if ($(valId)) $(valId).textContent = fmt(v);
    };
    el.oninput = show;
    el.onchange = () => { prefs.set(key, parseFloat(el.value) / scale); show(); };
    show();
  };
  slide('sPtExp', 'sPtExpV', 'exposure', 100, v => `×${v.toFixed(2)}`);
  slide('sSunEmit', 'sSunEmitV', 'sunEmit', 10, v => v.toFixed(1));

  /* Отражения в полёте: аналитические, по трубе и корпусу. Всё, что не
     описывается уравнением цилиндра, они не отражают. */
  const swMirror = $('sMirror');
  if (swMirror) {
    let on = prefs.get('mirror', 1) ? 1 : 0;
    const paint = () => {
      swMirror.classList.toggle('on', !!on);
      app.mirrorOn = on;
      if (world) world.mirror = on;
    };
    swMirror.onclick = () => { on = on ? 0 : 1; prefs.set('mirror', on); paint(); };
    paint();
  }

  /* Порог шума. Предела в выборках нет: их число выводится из порога,
     потому что шум падает как единица на корень из выборок. */
  const sNoise = $('sNoise');
  for (const it of CONFIG.PATH.NOISE) {
    const op = document.createElement('option');
    op.value = String(it.v); op.textContent = it.label.toUpperCase();
    sNoise.appendChild(op);
  }
  sNoise.value = String(prefs.get('noise', CONFIG.PATH.noise));
  const showNoise = () => {
    app.noiseWant = parseFloat(sNoise.value);
    setNoiseTarget(app.noiseWant);
    $('sNoiseV').textContent = `${sNoise.value}% · ${samplesNeeded()} выборок`;
  };
  sNoise.onchange = () => { prefs.set('noise', parseFloat(sNoise.value)); showNoise(); };
  showNoise();

  /* Способ очистки. «Лучше» зависит от сцены: направляющий буфер держит
     кромки, но на гладких поверхностях его резкость заметна; фильтр по цвету
     мягче, зато мылит; временное накопление даром, но требует покоя. */
  const sDn = $('sDn');
  const sPathClean = $('sPathClean');
  sPathClean.value = prefs.get('pathClean', 'oidn');
  sPathClean.onchange = () => prefs.set('pathClean', sPathClean.value);
  for (const it of CONFIG.POST.DENOISERS) {
    const op = document.createElement('option');
    op.value = it.id; op.textContent = it.label.toUpperCase();
    sDn.appendChild(op);
  }
  sDn.value = prefs.get('denoiser', 'cross');
  const showDn = () => {
    const it = CONFIG.POST.DENOISERS.find((x: { id: string }) => x.id === sDn.value);
    $('sDnV').textContent = it ? `${it.label} · ${it.hint}` : '';
  };
  sDn.onchange = () => {
    prefs.set('denoiser', sDn.value);
    setDenoiseMode(sDn.value);
    showDn();
  };
  setDenoiseMode(sDn.value);
  showDn();

  /* Доля разрешения трассировки. Считать в половину разрешения вчетверо
     дешевле, а на снимке разница мала: шум при том же числе выборок падает
     быстрее, потому что на пиксель приходится больше лучей. */
  const sPt = $('sPtScale');
  for (const it of CONFIG.PATH.SCALES) {
    const op = document.createElement('option');
    op.value = String(it.v); op.textContent = it.label.toUpperCase();
    sPt.appendChild(op);
  }
  sPt.value = String(prefs.get('ptScale', 0.5));
  const showPt = () => {
    const it = CONFIG.PATH.SCALES.find((x: { v: number }) => x.v === parseFloat(sPt.value));
    $('sPtScaleV').textContent = it ? `${it.label} · ${(it.v * it.v * 100) | 0}% пикселей` : '';
  };
  /* Резкость тем сильнее, чем меньше доля: при растяжении вдвое потеряно
     больше высоких частот, чем при растяжении на четверть. */
  const applyPt = () => {
    const v = parseFloat(sPt.value);
    setPathScale(v);
    /* Растягиваем с сохранением кромок, потом подчёркиваем резкостью — это и
       есть пространственная половина FSR. Временные варианты (DLSS, XeSS,
       FSR 2) в WebGL недоступны: им нужны либо тензорные ядра, либо
       вычислительные шейдеры WebGPU. */
    setUpscaleFrom(v);
    setSharpen(v < 0.999 ? CONFIG.POST.sharpen * (1 - v) / 0.65 : 0);
    showPt();
  };
  sPt.onchange = () => { prefs.set('ptScale', parseFloat(sPt.value)); applyPt(); };
  applyPt();
  const fill = (el: HTMLSelectElement, list: { label: string }[], key: string) => {
    for (const it of list) {
      const op = document.createElement('option');
      op.value = String((it as Record<string, unknown>)[key]); op.textContent = it.label.toUpperCase();
      el.appendChild(op);
    }
  };
  fill(sMsaa, CONFIG.AA_MSAA, 'v');
  fill(sFilter, CONFIG.AA_FILTER, 'id');
  fill(sScale, CONFIG.AA_SCALE, 'v');

  let aaOn = prefs.get('aaOn', true);
  sMsaa.value = String(prefs.get('aaMsaa', 0));
  sFilter.value = prefs.get('aaFilter', 'taa');
  sScale.value = String(prefs.get('aaScale', 1));

  const applyAA = () => {
    const mode = aaOn ? {
      samples: +sMsaa.value,
      filter: sFilter.value as string,
      ssaa: parseFloat(sScale.value)
    } : null;
    /* TAA живёт на своём буфере с глубиной и с MSAA не сочетается */
    /* TAA живёт на своём буфере с глубиной: многосэмпловый буфер с
       прикреплённой глубиной работает не везде */
    if (mode && mode.filter.includes('taa')) mode.samples = 0;
    app.ssaa = mode ? mode.ssaa : 1;
    if (isClassic()) setPostMode(renderer, { mode, glow: app.glowOn, rays: app.raysOn });
    /* Новый путь: та же раскладка опций в RenderPipeline (backends/three/post).
       Масштаб (SSAA) по-прежнему даёт плотность пикселей канваса (perf.ts). */
    else {
      setPostOptions({
        msaa: (mode ? mode.samples : 0) as MsaaSamples,
        aa: (mode ? mode.filter : 'none') as AaFilterId,
        bloom: app.glowOn, rays: app.raysOn
      });
    }
    setWind(mode && mode.filter.includes('taa') ? 0 : app.windBase);

    sAAon.classList.toggle('on', aaOn);
    for (const id of ['sAArow', 'sAArow2', 'sAArow3']) $(id).classList.toggle('off', !aaOn);
    sMsaa.value = String(mode ? mode.samples : 0);

    const fl = CONFIG.AA_FILTER.find((x: { id: string }) => x.id === sFilter.value).label;
    app.aaLabel = mode ? `MSAA${mode.samples || '—'} ${fl} ×${mode.ssaa}` : 'без сглаживания';
    sAAv.textContent = mode ? app.aaLabel : 'выключено';
    /* цена в полноэкранных проходах — по ней и видно, за что платим */
    const px = mode ? mode.ssaa * mode.ssaa : 1;
    const post = !mode ? 0 : 1 + (mode.filter.includes('taa') ? 1 : 0)
      + (mode.filter.includes('smaa') ? 3 : 0);
    sAAcost.textContent = mode
      ? `${px.toFixed(2)}× пикселей, ${post} прохода поверх`
      : 'прямой рендер в канвас';
    resize();
  };
  sAAon.onclick = () => { aaOn = !aaOn; prefs.set('aaOn', aaOn); applyAA(); };
  sMsaa.onchange = () => { prefs.set('aaMsaa', +sMsaa.value); applyAA(); };
  sFilter.onchange = () => { prefs.set('aaFilter', sFilter.value); applyAA(); };
  sScale.onchange = () => { prefs.set('aaScale', parseFloat(sScale.value)); applyAA(); };
  applyAA();

  /* Свечение и лучи делят одну цепочку постобработки с FXAA: включён любой —
     кадр идёт через буфер, поэтому применяются они вместе. */
  const swGlow = $('sGlow'), swRays = $('sRays'), swTraffic = $('sTraffic');
  app.glowOn = prefs.get('glow', false);
  app.raysOn = prefs.get('rays', false);
  app.trafficOn = prefs.get('traffic', true);
  const syncPost = () => {
    swGlow.classList.toggle('on', app.glowOn);
    swRays.classList.toggle('on', app.raysOn);
    swTraffic.classList.toggle('on', app.trafficOn);
    world?.setTraffic(app.trafficOn);
    applyAA();
  };
  swGlow.onclick = () => { app.glowOn = !app.glowOn; prefs.set('glow', app.glowOn); syncPost(); };
  swRays.onclick = () => { app.raysOn = !app.raysOn; prefs.set('rays', app.raysOn); syncPost(); };
  swTraffic.onclick = () => { app.trafficOn = !app.trafficOn; prefs.set('traffic', app.trafficOn); syncPost(); };
  /* Обязательная первая покраска: без неё состояние в переменных есть, а на
     переключателях его нет — первый же клик «включал» соседей, потому что
     они всё это время были включены и только теперь отрисовались. */
  syncPost();

  /* Два рычага против самого дорогого. Листва — от 62 до 78% геометрии,
     дальность отсекает секторы целиком: за ней объекты не доходят ни до
     вершинного шейдера, ни до фрагментного. */
  const sGreen = $('sGreen'), sFar = $('sFar');
  sGreen.value = String(prefs.get('green', 2));
  sGreen.onchange = () => {
    prefs.set('green', +sGreen.value);
    CONFIG.GREEN_K = CONFIG.GREEN[+sGreen.value];
    $('sGreenV').textContent = (CONFIG.GREEN_K * 100) + '%';
    reworld();
  };
  /* CONFIG.GREEN_K из prefs ставит applyStoredWorld ещё до первой сборки */
  $('sGreenV').textContent = (CONFIG.GREEN_K * 100) + '%';

  sFar.value = String(prefs.get('far', 0));
  const applyFar = () => {
    camera.far = CONFIG.DRAW_FAR[+sFar.value];
    camera.updateProjectionMatrix();
    $('sFarV').textContent = (camera.far / 100).toFixed(1) + ' км';
  };
  sFar.onchange = () => { prefs.set('far', +sFar.value); applyFar(); };
  applyFar();

  const sSat = $('sSat');
  sSat.value = Math.round(CONFIG.SATURATION * 100);
  $('sSatV').textContent = sSat.value + '%';
  /* пересборка мира стоит полсекунды — запускаем на отпускании, а не на каждый пиксель */
  sSat.onchange = () => {
    CONFIG.SATURATION = sSat.value / 100;
    prefs.set('sat', +sSat.value);
    reworld();
  };
  sSat.oninput = () => { $('sSatV').textContent = sSat.value + '%'; };

  /* Два режима полёта. По умолчанию горизонт следует изгибу цилиндра — так
     видно, что стоишь внутри вращающегося тела. Свободный ведёт себя как в
     обычной игре: лево это лево, крен сохраняется. */
  const swFly = $('sFly');
  ctl.freeFly = prefs.get('freeFly', false);
  const showFly = () => {
    swFly.classList.toggle('on', ctl.freeFly);
    $('sFlyV').textContent = ctl.freeFly ? 'Свободный' : 'Горизонт по цилиндру';
  };
  swFly.onclick = () => {
    ctl.freeFly = !ctl.freeFly;
    prefs.set('freeFly', ctl.freeFly);
    showFly();
    syncFromCamera(camera);          // выровнять при возврате к цилиндру
  };
  showFly();

  const sSens = $('sSens');
  sSens.value = prefs.get('sens', 100);
  sSens.oninput = () => {
    ctl.sens = sSens.value / 100;
    $('sSensV').textContent = ctl.sens.toFixed(2) + '×';
    prefs.set('sens', +sSens.value);
  };
  sSens.oninput();

  const sRot = $('sRot');
  sRot.value = prefs.get('rot', 19);
  sRot.oninput = () => {
    const v = sRot.value / 100;
    app.omega = v * TAU / CONFIG.ROT_PERIOD_CANON;
    $('sRotV').textContent = v <= 0.001 ? 'остановлено' : 'оборот за ' + Math.round(TAU / app.omega) + ' с';
    prefs.set('rot', +sRot.value);
  };
  sRot.oninput();
  /* --- зерно генерации: своё, случайное, заводское --- */
  const sSeed = $('sSeed'), sSeedV = $('sSeedV');
  const showSeed = () => {
    sSeed.value = CONFIG.SEED;
    sSeedV.textContent = CONFIG.SEED === CONFIG.SEED_DEFAULT ? 'заводское' : 'своё, сохранено';
  };
  const applySeed = (v: unknown) => {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n) || n < 0) { showSeed(); return; }
    CONFIG.SEED = n >>> 0;
    if (CONFIG.SEED === CONFIG.SEED_DEFAULT) prefs.drop('seed');
    else prefs.set('seed', CONFIG.SEED);
    showSeed();
    reworld();
  };
  showSeed();
  sSeed.onchange = () => applySeed(sSeed.value);
  $('sSeedRnd').onclick = () => applySeed(Math.floor(Math.random() * 4294967296));
  $('sSeedDef').onclick = () => applySeed(CONFIG.SEED_DEFAULT);

  const sWind = $('sWind');
  sWind.value = prefs.get('wind', 100);
  sWind.oninput = () => {
    app.windBase = sWind.value / 100;
    setWind(app.windBase);
    $('sWindV').textContent = sWind.value > 0 ? sWind.value + '%' : 'штиль';
    prefs.set('wind', +sWind.value);
  };
  sWind.oninput();
  const swCycle = $('sCycle'), swFps = $('sFps');
  app.autoCycle = prefs.get('cycle', false);
  swCycle.classList.toggle('on', app.autoCycle);
  swCycle.onclick = () => {
    app.autoCycle = !app.autoCycle;
    swCycle.classList.toggle('on', app.autoCycle);
    prefs.set('cycle', app.autoCycle);
  };
  app.showFps = prefs.get('fps', false);
  swFps.classList.toggle('on', app.showFps);
  $('fps').classList.toggle('show', app.showFps);
  swFps.onclick = () => {
    app.showFps = !app.showFps;
    swFps.classList.toggle('on', app.showFps);
    $('fps').classList.toggle('show', app.showFps);
    prefs.set('fps', app.showFps);
  };

  /* Кликабельна была только сама пилюля переключателя — 15% ширины строки.
     Промах по подписи не делал ничего, второй тык попадал в соседнюю строку,
     и со стороны это выглядело как «включается не то». Вся строка со
     переключателем теперь переключает его. */
  for (const row of document.querySelectorAll<HTMLElement>('.row')) {
    const sw = row.querySelector<HTMLElement>('.sw');
    if (!sw) continue;
    row.style.cursor = 'pointer';
    row.addEventListener('click', e => { if (e.target !== sw) sw.click(); });
  }

  /* Вкладки настроек: девятнадцать строк в одном свитке не читались */
  const tabBtns = [...document.querySelectorAll<HTMLElement>('.tabbtn')];
  const tabs = [...document.querySelectorAll<HTMLElement>('.tab')];
  for (const b of tabBtns) {
    b.addEventListener('click', () => {
      for (const x of tabBtns) x.classList.toggle('on', x === b);
      for (const t of tabs) t.classList.toggle('on', t.dataset.tab === b.dataset.tab);
      $('set').scrollTop = 0;
    });
  }
}
