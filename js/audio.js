import { CONFIG } from './config.js';
import { clamp, D2R } from '../core/math/scalar.ts';
import { zoneAt } from '../core/layout/zones.ts';

/* ═══════════════════════════════════════════════════════════════════════════
   ЗВУК — целиком синтезируется на WebAudio, ни одного сэмпла.
   Слои: гул станции, ветер, журчание воды и редкие птицы.

   Решения о громкости вынесены в чистые функции: они не трогают AudioContext,
   поэтому их можно проверить тестом, не запуская браузер.
   ═══════════════════════════════════════════════════════════════════════════ */

const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Локальная точка worldGroup → координаты станции */
export function fieldAt(p) {
  const r = Math.hypot(p.x, p.y);
  return { t: Math.atan2(p.x, p.y), r, z: p.z, alt: CONFIG.R - r };
}

/** Угловое расстояние до ближайшего русла, в юнитах дуги */
function riverArc(tDeg) {
  let best = Infinity;
  for (const [a, b] of CONFIG.SECT.rivers) {
    const d = tDeg < a ? a - tDeg : tDeg > b ? tDeg - b : 0;
    best = Math.min(best, Math.min(d, 360 - d));
  }
  return best * D2R * CONFIG.R;
}

/** Журчание слышно только вблизи русла — и по дуге, и по высоте */
export function waterLevel(f) {
  const tDeg = ((f.t / D2R) % 360 + 360) % 360;
  const d = Math.hypot(riverArc(tDeg), f.alt);
  return 1 - smooth(CONFIG.AUDIO.waterNear, CONFIG.AUDIO.waterFar, d);
}

/** Ветер: сильнее у земли на открытом месте, плюс набегающий поток в полёте */
export function windLevel(f, speed) {
  const open = 1 - smooth(3, 34, f.alt);
  const rush = clamp(speed / CONFIG.SPEED_MAX, 0, 1);
  return clamp(0.22 + 0.5 * open + 0.35 * rush, 0, 1);
}

/** Гул станции слышен везде, но у оси, среди механики, заметно громче */
export function humLevel(f) {
  return 0.42 + 0.58 * (1 - smooth(8, 46, f.r));
}

/** Птицы поют днём, у земли и только там, где есть чему расти */
export function birdLevel(f, dayMix) {
  const zone = zoneAt(f.t / D2R);
  if (zone === 'city' || zone === 'river') return 0;
  const near = 1 - smooth(4, 30, f.alt);
  return near * clamp(dayMix, 0, 1) * (zone === 'park' ? 1 : 0.55);
}

/* ═══════════════════════════════════════════════════════════════════════════
   СИНТЕЗ
   ═══════════════════════════════════════════════════════════════════════════ */
let ac = null, master = null, layers = null;
let birdTimer = 0, running = false;

export const audio = { on: true, volume: CONFIG.AUDIO.volume, ready: false };

/** Розоватый шум: белый через однополюсный фильтр. Один буфер на всё. */
function noiseBuffer(sec) {
  const buf = ac.createBuffer(1, Math.floor(ac.sampleRate * sec), ac.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < d.length; i++) {
    last = (last + 0.024 * (Math.random() * 2 - 1)) / 1.024;
    d[i] = clamp(last * 3.2, -1, 1);
  }
  return buf;
}

/** Полоса шума с медленным «дыханием» фильтра. Без модуляции шум звучит
    как статичное шипение, а с высокой добротностью — как свист. */
function noiseBand(buf, dest, freq, Q, level, lfoRate, lfoDepth) {
  const src = ac.createBufferSource();
  src.buffer = buf; src.loop = true;
  src.playbackRate.value = 0.8 + Math.random() * 0.4;   // расстройка слоёв
  const filt = ac.createBiquadFilter();
  filt.type = 'bandpass'; filt.frequency.value = freq; filt.Q.value = Q;
  const g = ac.createGain(); g.gain.value = level;
  src.connect(filt).connect(g).connect(dest);
  src.start();

  const lfo = ac.createOscillator(), lfoGain = ac.createGain();
  lfo.frequency.value = lfoRate; lfoGain.gain.value = lfoDepth;
  lfo.connect(lfoGain).connect(filt.frequency);
  lfo.start();
}

/** Контекст можно создать только по жесту пользователя */
export function startAudio() {
  if (ac) { if (ac.state === 'suspended') ac.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ac = new AC();

  master = ac.createGain();
  master.gain.value = audio.on ? audio.volume : 0;
  master.connect(ac.destination);

  const buf = noiseBuffer(5);

  /* --- ветер: широкая мягкая полоса --- */
  const wind = ac.createGain(); wind.gain.value = 0; wind.connect(master);
  noiseBand(buf, wind, 380, 0.55, 1.0, 0.06, 190);
  noiseBand(buf, wind, 1100, 0.5, 0.35, 0.041, 320);

  /* --- вода ---
     Один узкий резонанс на 1500 Гц давал не ручей, а свист. Ручей — это
     широкий спектр: низкий рокот потока, средний перекат и лёгкая пена
     сверху, все три с малой добротностью и разными периодами дыхания.
     Общий срез на 3.2 кГц убирает шипение. */
  const water = ac.createGain(); water.gain.value = 0;
  const wLow = ac.createBiquadFilter();
  wLow.type = 'lowpass'; wLow.frequency.value = 3200; wLow.Q.value = 0.5;
  wLow.connect(water); water.connect(master);
  noiseBand(buf, wLow, 220, 0.6, 0.85, 0.17, 70);    // рокот потока
  noiseBand(buf, wLow, 720, 0.9, 0.70, 0.29, 210);   // перекат
  noiseBand(buf, wLow, 1750, 1.1, 0.34, 0.43, 380);  // пена

  /* --- гул станции: две расстроенные низкие волны через фильтр --- */
  const humGain = ac.createGain();
  humGain.gain.value = 0;
  const humFilt = ac.createBiquadFilter();
  humFilt.type = 'lowpass'; humFilt.frequency.value = 190; humFilt.Q.value = 0.8;
  humFilt.connect(humGain).connect(master);
  for (const [f, type] of [[51, 'triangle'], [51.4, 'triangle'], [102, 'sine']]) {
    const o = ac.createOscillator();
    o.type = type; o.frequency.value = f;
    const g = ac.createGain(); g.gain.value = type === 'sine' ? 0.25 : 0.5;
    o.connect(g).connect(humFilt);
    o.start();
  }
  /* биения: два источника чуть расходятся, гул «плывёт» */
  const beat = ac.createOscillator(), beatGain = ac.createGain();
  beat.frequency.value = 0.11; beatGain.gain.value = 0.35;
  beat.connect(beatGain).connect(humGain.gain);
  beat.start();

  layers = { wind, water, hum: humGain };
  running = true;
  audio.ready = true;
}

/** Одна птичья трель: несколько щебетов с падающим тоном */
function birdCall(level) {
  const now = ac.currentTime;
  const notes = 2 + ((Math.random() * 3) | 0);
  const pan = Math.random() * 2 - 1;
  for (let k = 0; k < notes; k++) {
    const when = now + 0.05 + k * (0.07 + Math.random() * 0.09);
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = 'sine';
    const f0 = 1900 + Math.random() * 1700;
    o.frequency.setValueAtTime(f0, when);
    o.frequency.exponentialRampToValueAtTime(f0 * (0.55 + Math.random() * 0.8), when + 0.09);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(0.28 * level, when + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.13);
    let tail = g;
    if (ac.createStereoPanner) {
      const p = ac.createStereoPanner();
      p.pan.value = pan;
      g.connect(p); tail = p;
    }
    o.connect(g); tail.connect(master);
    o.start(when); o.stop(when + 0.2);
  }
}

/**
 * @param dt      секунды
 * @param local   позиция камеры в локальных координатах worldGroup
 * @param speed   текущая скорость полёта
 * @param dayMix  1 день, 0 ночь
 */
export function updateAudio(dt, local, speed, dayMix) {
  if (!running || !layers) return;
  const f = fieldAt(local);
  const A = CONFIG.AUDIO;
  const ramp = v => Math.min(1, dt * 3);   // плавно, чтобы не щёлкало

  const set = (node, target) => {
    node.gain.value += (target - node.gain.value) * ramp();
  };
  set(layers.wind, windLevel(f, speed) * A.wind);
  set(layers.water, waterLevel(f) * A.water);
  set(layers.hum, humLevel(f) * A.hum);

  const birds = birdLevel(f, dayMix);
  birdTimer -= dt;
  if (birdTimer <= 0) {
    if (birds > 0.05) birdCall(birds);
    birdTimer = A.birdGap[0] + Math.random() * (A.birdGap[1] - A.birdGap[0]);
    if (birds > 0.05) birdTimer /= (0.4 + birds);
  }
}

export function setVolume(v) {
  audio.volume = clamp(v, 0, 1);
  if (master) master.gain.value = audio.on ? audio.volume : 0;
}
export function setEnabled(on) {
  audio.on = on;
  if (master) master.gain.value = on ? audio.volume : 0;
}
export function suspendAudio(pause) {
  if (!ac) return;
  if (pause) ac.suspend(); else ac.resume();
}
