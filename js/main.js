import * as THREE from 'three';
import { CONFIG } from './config.js';
import { VERSION } from './version.js';
import { mulberry32, clamp, lerp, easeInOut, tpVec, aimAt, fadeByFog,
  turnToward, clampPitch, TAU } from './util.js';
import { makeSoftSprite, makeGlowTexture } from './textures.js';
import { buildWorld, worldMats, hullU, windU, updateTraffic, trafficMeshes,
  patchAllRoughness, updateTreeLod } from './world.js';
import { buildStructures, structMats, updateStructures,
  liftSeat, liftCount2, setLiftInside } from './structures.js';
import { ctl, isMobile, initControls, updateControls, syncFromCamera, resetStick, stationUp } from './controls.js';
import { audio, startAudio, updateAudio, setVolume, setEnabled, suspendAudio } from './audio.js';
import { pt, startPath, pathStep, stopPath, pathLabel, pathCameraMoved,
  setPaused, setPathScale, setNoiseTarget, samplesNeeded } from './pathtrace.js';
import { trace, startTrace, traceStep, stopTrace,
  setPost, setSunScreen, resizePost, renderFrame, composite, setDenoise, forcePost,
  setBrightScale, setDenoiseGuide, renderGuide, setDenoiseMode, setSharpen,
  setTraceDebug, DEBUG_NAMES, setAmbientShare, setHullRef } from './photo.js';

const $ = id => document.getElementById(id);
const stage = $('stage');

/* Настройки переживают перезагрузку одним объектом. localStorage может быть
   недоступен (приватный режим, отключённые куки) — тогда просто работаем без
   него: всё в try/catch, ни один вызов не обязан удаться. */
const PREFS_KEY = 'b5.prefs';
const prefs = {
  d: {},
  load() {
    try { this.d = JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { this.d = {}; }
    return this;
  },
  get(k, dflt) { const v = this.d[k]; return v === undefined ? dflt : v; },
  set(k, v) {
    this.d[k] = v;
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(this.d)); } catch { /* без сохранения */ }
  },
  drop(k) {
    delete this.d[k];
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(this.d)); } catch { /* без сохранения */ }
  }
}.load();

CONFIG.SEED = prefs.get('seed', CONFIG.SEED_DEFAULT) >>> 0;
CONFIG.SEASON = prefs.get('season', CONFIG.SEASON);
CONFIG.SATURATION = prefs.get('sat', CONFIG.SATURATION * 100) / 100;

let renderer, scene, camera, worldGroup, fog;
let hemi, lights = [], glow, clouds, motes, moteMat, panel;

/* ═══════════════════════════════════════════════════════════════════════════
   СЦЕНА
   ═══════════════════════════════════════════════════════════════════════════ */
function boot() {
  renderer = new THREE.WebGLRenderer({
    /* MSAA включаем и на мобильных: у тайловых GPU он почти бесплатен */
    /* MSAA берётся из буфера постобработки: у канваса он задаётся при
       создании и на лету не выключается, а «выкл» обязан выключать всё */
    antialias: false, powerPreference: 'high-performance', stencil: false
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.22;
  renderer.shadowMap.enabled = false;   // тени — контактные пятна и аналитика в шейдере
  /* updateStyle = false обязателен: иначе three прописывает канвасу инлайновые
     style.width/height в пикселях стартового окна, и они навсегда перебивают
     CSS width:100%. Именно поэтому в полном экране оставались чёрные поля. */
  /* Считать статистику сами: three обнуляет её на каждом render(), и с
     постобработкой в счётчик попадал последний проход — полноэкранный квад.
     Отсюда «draw 1, tri 0k» и полное безразличие цифр к пресету. */
  renderer.info.autoReset = false;
  renderer.setSize(innerWidth, innerHeight, false);
  stage.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  fog = new THREE.FogExp2(CONFIG.DAY.fog, CONFIG.DAY.fogD);
  scene.fog = fog;
  scene.background = new THREE.Color(CONFIG.DAY.fog);

  camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.2, CONFIG.FAR);
  worldGroup = new THREE.Group();
  scene.add(worldGroup);

  buildAmbient();
  rebuild();
  applyPalette(0);
  goTo(0, true);
}

/* ═══════════════════════════════════════════════════════════════════════════
   СВЕТ, ОРЕОЛ СОЛНЦА, ОБЛАКА, ПЫЛИНКИ — вне worldGroup
   Пять источников вдоль оси вместо двух: линейный свет спадает по z ровно,
   без тёмной середины и тёмных торцов.
   ═══════════════════════════════════════════════════════════════════════════ */
function buildAmbient() {
  /* Ореол солнца — ОДНА плоскость, которая каждый кадр разворачивается на
     камеру вокруг оси Z. Две скрещенные плоскости, как было раньше, при
     взгляде сбоку показывали себя поперечным световым полотном через весь
     кадр: та самая «засветка». Билборд вокруг оси убирает её по построению
     и заодно экономит вызов отрисовки. */
  const pg = new THREE.PlaneGeometry(12, CONFIG.SUN.len);
  pg.rotateX(Math.PI / 2);          // плоскость лежит вдоль Z, нормаль по −Y
  /* Ореол тянется на всю длину станции. Без затухания дальний его край
     светит в полную силу поверх того, что уже съедено туманом, — и читается
     как молочная полоса поперёк кадра. */
  glow = new THREE.Mesh(pg, fadeByFog(new THREE.MeshBasicMaterial({
    map: makeGlowTexture(), color: CONFIG.DAY.sunCol, transparent: true,
    opacity: CONFIG.DAY.glowOp, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide, toneMapped: false
  })));
  scene.add(glow);

  const rnd = mulberry32(CONFIG.SEED ^ 0x5f5);
  const cp = [];
  for (let i = 0; i < 14; i++) {
    const t = rnd() * TAU, r = 10 + rnd() * 13;
    cp.push(Math.sin(t) * r, Math.cos(t) * r, -140 + rnd() * 280);
  }
  const cg = new THREE.BufferGeometry();
  cg.setAttribute('position', new THREE.Float32BufferAttribute(cp, 3));
  clouds = new THREE.Points(cg, new THREE.PointsMaterial({
    size: 52, map: makeSoftSprite(0), transparent: true, opacity: 0.22,
    depthWrite: false, color: 0xffffff
  }));
  scene.add(clouds);

  const mp = [];
  for (let i = 0; i < 400; i++) {
    const t = rnd() * TAU, r = 4 + rnd() * 44;
    mp.push(Math.sin(t) * r, Math.cos(t) * r, -150 + rnd() * 300);
  }
  const mg = new THREE.BufferGeometry();
  mg.setAttribute('position', new THREE.Float32BufferAttribute(mp, 3));
  moteMat = new THREE.PointsMaterial({
    size: 0.55, map: makeSoftSprite(0.3), transparent: true, opacity: CONFIG.DAY.moteOp,
    color: CONFIG.DAY.moteCol, depthWrite: false, blending: THREE.AdditiveBlending
  });
  motes = new THREE.Points(mg, moteMat);
  scene.add(motes);

  hemi = new THREE.HemisphereLight(CONFIG.DAY.hemiSky, CONFIG.DAY.hemiGround, CONFIG.DAY.hemiInt);
  scene.add(hemi);
  buildLights();
}

/** Источники пересобираются при смене пресета: их число входит в стоимость
    каждого фрагмента, и на слабом устройстве это заметнее любой геометрии. */
function buildLights() {
  for (const l of lights) scene.remove(l);
  lights = [];
  const want = (CONFIG.QUALITY[currentQuality()] || CONFIG.QUALITY.HIGH).lights;
  const zs = want <= 3 ? CONFIG.LIGHT_Z_3 : CONFIG.LIGHT_Z;
  /* суммарная отдача не должна зависеть от числа ламп */
  const k = CONFIG.LIGHT_Z.length / zs.length;
  for (const z of zs) {
    const l = new THREE.PointLight(CONFIG.DAY.pointCol, CONFIG.DAY.pointInt * k, 380, 1.05);
    l.position.set(0, 0, z);
    l.userData.k = k;
    lights.push(l); scene.add(l);
  }
}

function rebuild() {
  const q = currentQuality();
  buildLights();
  /* Отражения в воде считаются прямо в шейдере корпуса и включаются на
     ультре: они стоят два десятка операций, но только на пикселях воды. */
  mirrorOn = (CONFIG.QUALITY[q] || CONFIG.QUALITY.HIGH).mirror || 0;
  /* §14: в пресете LOW облака выключаются */
  if (clouds) clouds.visible = q !== 'LOW';
  const res = buildWorld(worldGroup, renderer, q);
  panel = res.panel;
  hullAlbedoTex = res.albedo || null;
  buildStructures(worldGroup, renderer, q, panel, res.panelNormal);
  /* Шероховатость в альфу — всем непрозрачным материалам сцены разом, а не
     выборочно: пропущенный оставляет там непрозрачность, и трассировка
     принимает поверхность за зеркальную. */
  patchAllRoughness(worldGroup);
  /* Раскладку деревьев зовём сразу: до неё меши уровней пусты. */
  worldGroup.updateMatrixWorld(true);
  updateTreeLod(camera.position, worldGroup, true);
}

/* ═══════════════════════════════════════════════════════════════════════════
   ПАЛИТРА ДЕНЬ / НОЧЬ
   Ночью солнечная трубка не гаснет, а тлеет холодным — ночник на оси,
   который даёт эмбиентную подсветку вместо чёрной пустоты.
   ═══════════════════════════════════════════════════════════════════════════ */
/* Фаза освещения идёт по кругу: 0 день → 1 закат → 2 ночь → снова день.
   Хранится дробной, поэтому переход всегда плавный, а не переключением. */
let phase = 0, phaseTo = 0, daylight = 1;
const _a = new THREE.Color(), _b = new THREE.Color(), _r = new THREE.Color();
const mixC = (a, b, t, out = _r) => out.copy(_a.setHex(a)).lerp(_b.setHex(b), t);

function applyPalette(ph) {
  const P = CONFIG.PHASES;
  const i = Math.floor(ph) % P.length;
  const A = CONFIG[P[i]], B = CONFIG[P[(i + 1) % P.length]];
  const t = ph - Math.floor(ph);
  const f = (k) => lerp(A[k], B[k], t);
  daylight = f('light');

  mixC(A.fog, B.fog, t);
  fog.color.copy(_r); scene.background.copy(_r);
  fog.density = f('fogD');

  hemi.color.copy(mixC(A.hemiSky, B.hemiSky, t));
  hemi.groundColor.copy(mixC(A.hemiGround, B.hemiGround, t));
  hemi.intensity = f('hemiInt');

  mixC(A.pointCol, B.pointCol, t);
  for (const l of lights) { l.color.copy(_r); l.intensity = f('pointInt') * (l.userData.k || 1); }

  const sunE = f('sunEmis');
  mixC(A.sunCol, B.sunCol, t);
  /* Труба уходит выше единицы: в кадре она и так белая, зато свечение
     получает настоящий HDR-источник, а не еле-еле проходящий порог. */
  if (structMats.sun) structMats.sun.color.copy(_r).multiplyScalar(sunE * CONFIG.POST.sunHdr);
  glow.material.color.copy(_r);
  glow.material.opacity = f('glowOp');

  const emis = f('winEmis');
  for (const m of worldMats.bld) m.emissiveIntensity = emis;
  for (const m of structMats.glass) m.emissiveIntensity = emis * 0.45;
  if (structMats.liftGlass) structMats.liftGlass.emissiveIntensity = lerp(1.4, 0.3, daylight);

  /* Свет машин: окна еле тлеют, фары бьют. Днём и то и другое почти не видно. */
  if (worldMats.trafficBody) {
    worldMats.trafficBody.emissiveIntensity = lerp(CONFIG.TRAFFIC.win, 0.05, daylight);
  }
  if (worldMats.trafficLamp) {
    const b = lerp(CONFIG.TRAFFIC.lamp, 0.12, daylight);
    worldMats.trafficLamp.color.setRGB(b, b, b);
  }
  if (worldMats.nav) {
    worldMats.nav.opacity = clamp(f('navInt'), 0, 1);
    worldMats.nav.size = f('navSize');
  }
  /* контактные тени слабеют вместе с источником */
  if (worldMats.blob) worldMats.blob.opacity = lerp(0.22, CONFIG.PRINT.dark * 0.85, daylight);
  if (worldMats.print) worldMats.print.opacity = lerp(0.24, CONFIG.PRINT.dark, daylight);

  moteMat.color.copy(mixC(A.moteCol, B.moteCol, t));
  moteMat.opacity = f('moteOp');
  moteMat.size = lerp(0.72, 0.55, daylight);
  clouds.material.opacity = lerp(0.06, 0.22, daylight);

  /* столько света остаётся в тени от осевых источников — по нему
     трассировка и решает, насколько темнить затенённое */
  setAmbientShare(hemi.intensity / (hemi.intensity + lights.length * f('pointInt') + 1e-6));
  hullU.uSparShade.value = f('sparShade');
  hullU.uCityGlow.value = f('cityGlow');
  hullU.uWaterTint.value.copy(mixC(A.waterTint, B.waterTint, t));
}

/* ═══════════════════════════════════════════════════════════════════════════
   ТЕЛЕПОРТЫ: цели живут в локальных координатах и каждый кадр
   переводятся в мировые — посадочная точка честно едет с вращением
   ═══════════════════════════════════════════════════════════════════════════ */
const fly = {
  a0: 0, a1: 0, da: 0, r0: 0, r1: 0, z0: 0, z1: 0, rMid: 20,
  dir: new THREE.Vector3(0, 0, -1), up: new THREE.Vector3(0, 1, 0),
  on: false, t: 0, dur: 3,
  p0: new THREE.Vector3(), p1: new THREE.Vector3(), p2: new THREE.Vector3(),
  look: new THREE.Vector3(), q0: new THREE.Quaternion(), rot0: 0
};
const _qA = new THREE.Quaternion(), _qB = new THREE.Quaternion();
const _upA = new THREE.Vector3();
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _Z = new THREE.Vector3(0, 0, 1);
const _vAudio = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _upB = new THREE.Vector3(), _dirA = new THREE.Vector3(), _dirB = new THREE.Vector3();
const _qTurn = new THREE.Quaternion(), _qStep = new THREE.Quaternion();
const _vMirror = new THREE.Vector3(), _ptPrev = new THREE.Vector3();

function goTo(i, instant = false) {
  const tp = CONFIG.TP[i];
  const target = tpVec(tp.pos), look = tpVec(tp.look);
  worldGroup.updateMatrixWorld();

  if (instant) {
    camera.position.copy(worldGroup.localToWorld(target.clone()));
    stationUp(camera.position, _upA);
    aimAt(camera.position, worldGroup.localToWorld(look.clone()), _upA, camera.quaternion);
    syncFromCamera(camera);
    return;
  }

  fly.p0.copy(worldGroup.worldToLocal(camera.position.clone()));
  fly.p2.copy(target);
  fly.look.copy(look);

  /* Траектория ведётся в цилиндрических координатах: угол по кратчайшей
     дуге, радиус с выносом к середине. Между башней (r = 28) и трубой
     (r = 3.4) объём пуст, поэтому путь через этот коридор свободен ПО
     ПОСТРОЕНИЮ — проверять столкновения не с чем. Прежняя почти прямая
     хорда шла впритирку к полу и таранила застройку. */
  const F = CONFIG.FLY;
  fly.a0 = Math.atan2(fly.p0.x, fly.p0.y);
  fly.a1 = Math.atan2(fly.p2.x, fly.p2.y);
  /* кратчайшее направление обхода */
  fly.da = ((fly.a1 - fly.a0 + Math.PI) % TAU + TAU) % TAU - Math.PI;
  fly.r0 = Math.hypot(fly.p0.x, fly.p0.y);
  fly.r1 = Math.hypot(fly.p2.x, fly.p2.y);
  fly.z0 = fly.p0.z; fly.z1 = fly.p2.z;
  /* середина коридора, но не дальше того, где мы и так летим */
  fly.rMid = clamp(Math.min(fly.r0, fly.r1, CONFIG.R * F.corridor),
    CONFIG.SUN.r + CONFIG.SUN.clear + 2, CONFIG.TOWER ? CONFIG.R - 8 : CONFIG.R - 8);

  /* длительность — по фактической длине пути, а не по хорде */
  const arc = Math.abs(fly.da) * (fly.r0 + fly.r1) * 0.5;
  const len = Math.hypot(arc, fly.z1 - fly.z0, fly.r1 - fly.r0);
  fly.dur = clamp(F.min + len / F.speed, F.min, F.max);

  /* цель взгляда стартует там, куда камера смотрит сейчас: иначе на первом
     же кадре она рывком развернётся к пункту назначения */
  camera.getWorldDirection(fly.dir);
  fly.up.set(0, 1, 0).applyQuaternion(camera.quaternion).normalize();

  fly.rot0 = worldGroup.rotation.z;
  fly.t = 0; fly.on = true;
  resetStick();
}

/** Точка траектории в локальных координатах мира */
/** Точка траектории. e может выходить за [0,1]: взгляд смотрит вперёд по
    курсу, и на финише ему нужна точка за пределом пути. */
function flyPoint(e, out) {
  const bump = Math.sin(Math.PI * clamp(e, 0, 1));   // 0 на концах, 1 в середине
  const a = fly.a0 + fly.da * e;
  const rLine = lerp(fly.r0, fly.r1, e);
  const r = rLine + (fly.rMid - rLine) * bump * CONFIG.FLY.pull;
  return out.set(Math.sin(a) * r, Math.cos(a) * r, lerp(fly.z0, fly.z1, e));
}

function updateFly(dt) {
  if (!fly.on) return;
  fly.t = Math.min(1, fly.t + dt / fly.dur);
  const e = easeInOut(fly.t);
  worldGroup.updateMatrixWorld();

  flyPoint(e, _v);
  worldGroup.localToWorld(_v);
  camera.position.copy(_v);

  /* Куда смотреть. Интерполируем НАПРАВЛЕНИЕ, а не точку: точка, переезжая
     от цели впереди по курсу к цели позади, проходит ровно сквозь камеру, и
     взгляд переворачивается на 180° за один кадр. Именно от этого камеру и
     выворачивало. Направления же поворачиваются друг к другу по дуге. */
  /* Точку впереди берём БЕЗ ограничения единицей: на финише e + lead
     упиралось в саму себя, вектор вырождался в ноль, и нормализация давала
     мусор — отсюда девяностоградусный скачок на последнем кадре. */
  flyPoint(e + CONFIG.FLY.lead, _v3);
  _dirA.subVectors(_v3, _v);
  if (_dirA.lengthSq() < 1e-6) _dirA.copy(fly.dir); else _dirA.normalize();
  worldGroup.localToWorld(_v3.copy(fly.look));
  _dirB.subVectors(_v3, _v).normalize();
  stationUp(_v, _upA);
  /* Верх плавно переходит от стартового к станционному: у самой оси
     станционный проворачивается на восемь градусов за юнит пути и закручивал
     бы камеру вокруг своей оси в середине траектории. */
  _upB.copy(fly.up).lerp(_upA, smoothstep01(0.2, 1, e)).normalize();
  /* цель: от направления по курсу к направлению на точку прибытия */
  turnToward(_dirA, _dirB, smoothstep01(CONFIG.FLY.turnFrom, 1, e), _upA, _dirA);
  /* и догоняем её экспоненциально — повороты закладываются дугой */
  turnToward(fly.dir, _dirA, 1 - Math.exp(-dt * CONFIG.FLY.turn), _upA, fly.dir);

  /* Не даём взгляду подойти к «верху» вплотную. У dot = 1 базис вырождается
     и камера выворачивается за кадр; порог с переключением на запасной верх
     эту дыру только сдвигает — на самом переключении остаётся скачок.
     Ограничение же непрерывно: тот же приём снял тряску у зенита. */
  clampPitch(fly.dir, _upB, Math.sin(CONFIG.FLY.pitchMax * Math.PI / 180));
  aimAt(_v, _v2, _upB, camera.quaternion);

  if (fly.t >= 1) { fly.on = false; syncFromCamera(camera); }
}

const smoothstep01 = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
function cancelFly() { fly.on = false; setTour(false); syncFromCamera(camera); }
const stopTracing = () => { if (trace.active) setTrace(false); };

/* ═══════════════════════════════════════════════════════════════════════════
   АВТО-ТУР
   Облетает все точки по кругу. Титры показываются после посадки и гаснут
   перед следующим взлётом. Любое вмешательство в управление тур прекращает.
   ═══════════════════════════════════════════════════════════════════════════ */
const tour = { on: false, idx: 0, wait: 0 };
const capEl = () => $('caption');

function showCaption(i) {
  const tp = CONFIG.TP[i], el = capEl();
  el.firstElementChild.textContent = tp.name;
  el.lastElementChild.textContent = tp.hint;
  el.classList.add('show');
}
function hideCaption() { capEl().classList.remove('show'); }

function setTour(on) {
  tour.on = on;
  $('bTour').classList.toggle('on', on);
  if (on) {
    tour.idx = 0;
    goTo(0);
    tour.wait = CONFIG.TOUR_HOLD;
  } else {
    hideCaption();
  }
}
function updateTour(dt) {
  if (!tour.on) return;
  if (fly.on) { hideCaption(); return; }
  if (tour.wait === CONFIG.TOUR_HOLD) showCaption(tour.idx);
  tour.wait -= dt;
  if (tour.wait <= 0) {
    tour.idx = (tour.idx + 1) % CONFIG.TP.length;
    goTo(tour.idx);
    tour.wait = CONFIG.TOUR_HOLD;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   ПОЕЗДКА НА МОНОРЕЛЬСЕ

   Камера садится в кабину и едет вместе с ней, обзор при этом свободный —
   как из глаз пассажира. Управление положением отдаётся кабине, а поворот
   остаётся за игроком: перехватывать ещё и взгляд значило бы отобрать у него
   единственное, ради чего в поездку и садятся.
   ═══════════════════════════════════════════════════════════════════════════ */
const ride = { on: false, car: 0 };
const _rp = new THREE.Vector3(), _rd = new THREE.Vector3();

function setRide(on) {
  ride.on = on && liftCount2() > 0;
  $('rideBar').classList.toggle('show', ride.on);
  $('bRide').classList.toggle('on', ride.on);
  setLiftInside(ride.on);
  if (ride.on) {
    setTour(false);
    fly.on = false;
    ctl.enabled = true;
    /* садимся в ближайшую кабину: так переход не выглядит телепортом */
    let best = 0, bestD = Infinity;
    for (let k = 0; k < liftCount2(); k++) {
      liftSeat(k, _rp, _rd);
      worldGroup.localToWorld(_rp);
      const d = _rp.distanceToSquared(camera.position);
      if (d < bestD) { bestD = d; best = k; }
    }
    ride.car = best;
  } else {
    syncFromCamera(camera);
  }
}

/** Камеру ведёт кабина, взгляд остаётся за игроком */
function updateRide() {
  if (!ride.on) return;
  if (!liftSeat(ride.car, _rp, _rd)) { setRide(false); return; }
  _rp.y += CONFIG.LIFTCAR.eye;              // глаз пассажира выше пола кабины
  worldGroup.localToWorld(_rp);
  camera.position.copy(_rp);
}

/* ═══════════════════════════════════════════════════════════════════════════
   ФОТО-РЕЖИМ
   Снимок берётся сразу после отрисовки кадра: так не нужен
   preserveDrawingBuffer, который стоит производительности всё время.
   ═══════════════════════════════════════════════════════════════════════════ */
let cleanView = false, shotPending = false, omegaSaved = 0;

function setClean(on) {
  cleanView = on;
  document.body.classList.toggle('clean', on);
  if (on) {
    closeSheets();
    /* Станцию останавливаем: снимок делается с неподвижного кадра, а
       вращение к тому же обнуляет накопление трассировки. Скорость
       запоминаем и возвращаем на выходе. */
    omegaSaved = omega;
    omega = 0;
  } else {
    omega = omegaSaved;
    /* Выход обязан снять ВСЁ, что включает фото-режим, иначе трассировка
       продолжает считать в фоне, цепочка постобработки висит поднятой, а на
       экране остаётся последний её кадр. */
    exitPhotoModes();
  }
}

/** Снять все режимы съёмки разом. Раньше выход гасил только экранные лучи:
    трассировка пути оставалась активной, а её результат — на канвасе. */
function exitPhotoModes() {
  setTraceDebug(0);
  setTrace(false);
  stopPath();
  forcePost(renderer, false);
  setBrightScale(1);
  setDenoise(false);
  traceHeld = false;
  for (const id of ['bDebug', 'bPath', 'bPause', 'bTrace']) {
    $(id)?.classList.remove('on');
  }
  $('traceInfo').classList.remove('show');
  /* и сразу перерисовываем обычный кадр: иначе на экране висит последний
     кадр трассировки, пока не наступит следующий тик */
  renderFrame(renderer, scene, camera, worldGroup.rotation.z);
}

/* Трассировка идёт только по неподвижному кадру: любое движение мира или
   камеры обнулило бы накопленное. Поэтому на время съёмки мир замирает. */
/** Единственное место, где пишется строка индикатора: раньше её ставили в
    трёх местах по-разному, и сообщение об отказе терялось. */
/** Насколько ярко светит труба в текущей фазе: то же значение, что управляет
    ею в обычном кадре. По нему трассировка выставляет свой источник. */
function sunLevelNow() {
  const P = CONFIG.PHASES;
  const i = Math.floor(phase) % P.length;
  const A = CONFIG[P[i]], B = CONFIG[P[(i + 1) % P.length]];
  return lerp(A.sunEmis, B.sunEmis, phase - Math.floor(phase));
}

function showTrace(text) {
  const el = $('traceInfo');
  el.textContent = text;
  el.classList.add('show');
}

function setTrace(on) {
  const info = $('traceInfo'), btn = $('bTrace');
  if (on && !trace.active) {
    shotBoost = CONFIG.SHOT.scale;      // трассируем сразу в масштабе снимка
    resize();
    startTrace(renderer, scene, camera, windU.uWind, isMobile);
  } else if (!on && trace.active) {
    stopTrace(windU.uWind);
    shotBoost = 1;
    resize();
  }
  btn.classList.toggle('on', trace.active);
  info.classList.toggle('show', trace.active);
  if (!trace.active) info.textContent = '';
}
function saveCanvas(w, h) {
  /* Ужимаем крупный кадр до нативного размера: каждый пиксель усредняет
     scale² отсчётов — то же, что делает суперсэмплинг, только без платы
     за него в реальном времени. */
  const src = renderer.domElement;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, w, h);
  c.toBlob(blob => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `babylon5-${CONFIG.SEED}-${Date.now()}.png`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }, 'image/png');
}

function grabShot() {
  /* Накопленный кадр — хоть путём, хоть экранными лучами — пересобирать
     нельзя: перерисовка стёрла бы всё накопленное. Просто ужимаем то, что
     уже на канвасе. */
  if (pt.active) { saveCanvas(renderer.domElement.width, renderer.domElement.height); return; }
  if (trace.active) {
    saveCanvas(Math.round(renderer.domElement.width / CONFIG.SHOT.scale),
      Math.round(renderer.domElement.height / CONFIG.SHOT.scale));
    return;
  }
  const nw = renderer.domElement.width, nh = renderer.domElement.height;
  shotBoost = CONFIG.SHOT.scale;
  resize();
  renderFrame(renderer, scene, camera, worldGroup.rotation.z);
  saveCanvas(nw, nh);
  shotBoost = 1;
  resize();
}

/* ═══════════════════════════════════════════════════════════════════════════
   UI
   ═══════════════════════════════════════════════════════════════════════════ */
const sheets = { tp: $('tp'), set: $('set'), help: $('help') };
const closeSheets = () => { for (const k in sheets) sheets[k].classList.remove('open'); };
const toggleSheet = k => {
  const open = sheets[k].classList.contains('open');
  closeSheets();
  if (!open) {
    sheets[k].classList.add('open');
    if (document.pointerLockElement) document.exitPointerLock();
  }
};

let autoCycle = false, showFps = false, quality = 'AUTO';
let omega = TAU / CONFIG.ROT_PERIOD_DEFAULT;
let setDayIcon = () => {};
const currentQuality = () => quality === 'AUTO' ? (isMobile ? 'LOW' : 'HIGH') : quality;

function initUI() {
  const list = $('tpList');
  CONFIG.TP.forEach((tp, i) => {
    const d = document.createElement('div');
    d.className = 'tp';
    d.innerHTML = `<i>${tp.ico}</i><div><b>${tp.name}</b><s>${tp.hint}</s></div>`;
    d.addEventListener('click', () => { closeSheets(); setTour(false); setRide(false); goTo(i); });
    list.appendChild(d);
  });

  $('bTour').onclick = () => { closeSheets(); setRide(false); setTour(!tour.on); };
  $('bRide').onclick = () => { closeSheets(); setRide(!ride.on); };
  $('bRideExit').onclick = () => setRide(false);
  $('bPhoto').onclick = () => setClean(true);
  $('bPhotoExit').onclick = () => setClean(false);
  $('bShot').onclick = () => { shotPending = true; };
  $('bTrace').onclick = () => setTrace(!trace.active);

  /* Полная трассировка пути: считает настоящий путь света по дереву обхода
     всей геометрии, без экранных ограничений. Библиотека грузится по первому
     включению — она весит больше самого проекта. */
  /* Пауза с очисткой: накопление останавливается, кадр проходит через
     шумоподавитель. Деталей, которых ещё нет, он не создаст, но зерно уберёт
     и снимок можно делать раньше. Повторное нажатие возвращает расчёт. */
  const bPause = $('bPause');
  bPause.onclick = () => {
    const on = !pt.paused && !traceHeld;
    if (pt.active) setPaused(on);
    traceHeld = pt.active ? false : on;
    /* Направляющий кадр снимаем один раз при включении: сцена неподвижна,
       пересчитывать его каждый кадр незачем. */
    setDenoiseGuide(on ? renderGuide(renderer, scene, camera) : null);
    setDenoise(on);
    bPause.classList.toggle('on', on);
  };

  const bPath = $('bPath');
  bPath.onclick = async () => {
    if (pt.active || pt.error) {
      stopPath(); forcePost(renderer, false); setBrightScale(1);
      bPath.classList.remove('on'); return;
    }
    setTrace(false);
    setTraceDebug(0);
    bPath.classList.add('on');
    /* сразу показываем, что нажатие принято: библиотека грузится с сети и
       дерево строится не мгновенно, без отклика это выглядит как поломка */
    /* Порядок важен: сперва надпись, потом долгая работа. Постройка дерева
       блокирует поток на секунды, и без заранее отрисованного предупреждения
       это неотличимо от зависшей вкладки. */
    showTrace('загрузка библиотеки…');
    /* Цепочка постобработки должна существовать: результат пути идёт
       через неё, а при выключенном сглаживании её просто не было. */
    forcePost(renderer, true);
    /* эмиссия в трассировке усилена — порог свечения обязан подняться */
    setBrightScale(CONFIG.PATH.emitBoost * CONFIG.PATH.brightRatio);
    /* станцию и ветер уже остановил фото-режим — сцена статична */
    const okStart = await startPath(renderer, scene, camera, windU.uWind, isMobile,
      showTrace, structMats.sun, hemi,
      /* Результат пути идёт через ту же постобработку, что и обычный кадр:
         библиотека рисует прямо в канвас и минует свечение, лучи от оси и
         всё сглаживание. */
      texture => composite(renderer, texture, renderer.toneMappingExposure),
      worldMats.hull, worldMats.waterRough,
      hullU.uCityGlow.value > 0.2 ? 0xffd9a0 : 0xcfe0ff,
      /* яркость трубы берём из текущей фазы, иначе день выбеливает */
      structMats.sun ? Math.max(0.25, sunLevelNow()) : 1,
      /* периметральная подсветка — ночная деталь */
      1 - daylight, worldMats.waterNormal);
    if (!okStart) {
      bPath.classList.remove('on');
      showTrace(pathLabel());
    }
  };

  /* Наглядный ответ на вопрос «а точно ли это считается лучами»: показываем
     ТОЛЬКО вклад трассировки, без исходной картинки. Видно и что посчитано,
     и как оно сходится с каждым кадром. */
  const bDebug = $('bDebug');
  bDebug.onclick = () => {
    if (!trace.active) setTrace(true);
    setTraceDebug((trace.debug + 1) % DEBUG_NAMES.length);
    bDebug.classList.toggle('on', trace.debug > 0);
  };

  $('bTp').onclick = () => toggleSheet('tp');
  $('bSet').onclick = () => toggleSheet('set');
  $('bHelp').onclick = () => toggleSheet('help');
  $('tpClose').onclick = $('setClose').onclick = $('helpClose').onclick = closeSheets;

  const bDay = $('bDay');
  const ICONS = [
    bDay.innerHTML,                                                     // солнце
    '<svg viewBox="0 0 24 24"><path d="M2.6 18.6h18.8M6.4 18.6a5.6 5.6 0 0 1 11.2 0"/><path d="M12 3.4v2.4M4.6 6.9l1.7 1.7M19.4 6.9l-1.7 1.7M2.8 14.2h1.9M19.3 14.2h1.9"/></svg>',
    '<svg viewBox="0 0 24 24"><path d="M20.5 14.6A8.6 8.6 0 0 1 9.4 3.5a8.6 8.6 0 1 0 11.1 11.1z"/></svg>'
  ];
  const NAMES = ['День', 'Закат', 'Ночь'];
  setDayIcon = () => {
    const k = ((Math.round(phaseTo) % CONFIG.PHASES.length) + CONFIG.PHASES.length) % CONFIG.PHASES.length;
    bDay.innerHTML = ICONS[k];
    bDay.title = NAMES[k];
    bDay.classList.toggle('on', k > 0);
  };
  /* По кругу: день → закат → ночь → день. Цель — всегда СЛЕДУЮЩАЯ фаза от
     текущей, а не «плюс один к цели»: иначе быстрые нажатия копили очередь
     и переход растягивался на десятки секунд. */
  bDay.onclick = () => { phaseTo = Math.floor(phase) + 1; setDayIcon(); };

  const bSnd = $('bSnd'), SND_ON = bSnd.innerHTML;
  const SND_OFF = '<svg viewBox="0 0 24 24"><path d="M4 9.2h3.3L12 5.3v13.4l-4.7-3.9H4z"/><path d="M16.2 9.8l5 4.4M21.2 9.8l-5 4.4"/></svg>';
  const showSnd = () => {
    bSnd.innerHTML = audio.on ? SND_ON : SND_OFF;
    bSnd.classList.toggle('on', audio.on);
  };
  setEnabled(prefs.get('sound', true));
  showSnd();
  bSnd.onclick = () => { setEnabled(!audio.on); prefs.set('sound', audio.on); showSnd(); };

  const sVol = $('sVol');
  sVol.value = prefs.get('vol', Math.round(CONFIG.AUDIO.volume * 100));
  sVol.oninput = () => {
    setVolume(sVol.value / 100);
    $('sVolV').textContent = sVol.value + '%';
    prefs.set('vol', +sVol.value);
  };
  sVol.oninput();

  $('bFs').onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.()?.catch?.(() => {});
  };

  const sQual = $('sQual');
  sQual.value = quality = prefs.get('quality', 'AUTO');
  sQual.onchange = e => {
    quality = e.target.value;
    prefs.set('quality', quality);
    dprCap = capForQuality(); dprIndex = startDpr(); applyDpr();
    rebuild();
    applyPalette(phase);
  };

  const sSeason = $('sSeason');
  sSeason.value = CONFIG.SEASON;
  sSeason.onchange = () => {
    CONFIG.SEASON = sSeason.value;
    prefs.set('season', CONFIG.SEASON);
    rebuild();
    applyPalette(phase);
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
    setNoiseTarget(parseFloat(sNoise.value));
    $('sNoiseV').textContent = `${sNoise.value}% · ${samplesNeeded()} выборок`;
  };
  sNoise.onchange = () => { prefs.set('noise', parseFloat(sNoise.value)); showNoise(); };
  showNoise();

  /* Способ очистки. «Лучше» зависит от сцены: направляющий буфер держит
     кромки, но на гладких поверхностях его резкость заметна; фильтр по цвету
     мягче, зато мылит; временное накопление даром, но требует покоя. */
  const sDn = $('sDn');
  for (const it of CONFIG.POST.DENOISERS) {
    const op = document.createElement('option');
    op.value = it.id; op.textContent = it.label.toUpperCase();
    sDn.appendChild(op);
  }
  sDn.value = prefs.get('denoiser', 'cross');
  const showDn = () => {
    const it = CONFIG.POST.DENOISERS.find(x => x.id === sDn.value);
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
    const it = CONFIG.PATH.SCALES.find(x => x.v === parseFloat(sPt.value));
    $('sPtScaleV').textContent = it ? `${it.label} · ${(it.v * it.v * 100) | 0}% пикселей` : '';
  };
  /* Резкость тем сильнее, чем меньше доля: при растяжении вдвое потеряно
     больше высоких частот, чем при растяжении на четверть. */
  const applyPt = () => {
    const v = parseFloat(sPt.value);
    setPathScale(v);
    setSharpen(v < 0.999 ? CONFIG.POST.sharpen * (1 - v) / 0.65 : 0);
    showPt();
  };
  sPt.onchange = () => { prefs.set('ptScale', parseFloat(sPt.value)); applyPt(); };
  applyPt();
  const fill = (el, list, key) => {
    for (const it of list) {
      const op = document.createElement('option');
      op.value = String(it[key]); op.textContent = it.label.toUpperCase();
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
      filter: sFilter.value,
      ssaa: parseFloat(sScale.value)
    } : null;
    /* TAA живёт на своём буфере с глубиной и с MSAA не сочетается */
    /* TAA живёт на своём буфере с глубиной: многосэмпловый буфер с
       прикреплённой глубиной работает не везде */
    if (mode && mode.filter.includes('taa')) mode.samples = 0;
    ssaa = mode ? mode.ssaa : 1;
    setPost(renderer, { mode, glow: glowOn, rays: raysOn });
    windU.uWind.value = mode && mode.filter.includes('taa') ? 0 : windBase;

    sAAon.classList.toggle('on', aaOn);
    for (const id of ['sAArow', 'sAArow2', 'sAArow3']) $(id).classList.toggle('off', !aaOn);
    sMsaa.value = String(mode ? mode.samples : 0);

    const fl = CONFIG.AA_FILTER.find(x => x.id === sFilter.value).label;
    aaLabel = mode ? `MSAA${mode.samples || '—'} ${fl} ×${mode.ssaa}` : 'без сглаживания';
    sAAv.textContent = mode ? aaLabel : 'выключено';
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
  glowOn = prefs.get('glow', false);
  raysOn = prefs.get('rays', false);
  trafficOn = prefs.get('traffic', true);
  const syncPost = () => {
    swGlow.classList.toggle('on', glowOn);
    swRays.classList.toggle('on', raysOn);
    swTraffic.classList.toggle('on', trafficOn);
    for (const o of trafficMeshes()) o.visible = trafficOn;
    applyAA();
  };
  swGlow.onclick = () => { glowOn = !glowOn; prefs.set('glow', glowOn); syncPost(); };
  swRays.onclick = () => { raysOn = !raysOn; prefs.set('rays', raysOn); syncPost(); };
  swTraffic.onclick = () => { trafficOn = !trafficOn; prefs.set('traffic', trafficOn); syncPost(); };
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
    rebuild();
    applyPalette(phase);
  };
  CONFIG.GREEN_K = CONFIG.GREEN[+sGreen.value];
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
    rebuild();
    applyPalette(phase);
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
    omega = v * TAU / CONFIG.ROT_PERIOD_CANON;
    $('sRotV').textContent = v <= 0.001 ? 'остановлено' : 'оборот за ' + Math.round(TAU / omega) + ' с';
    prefs.set('rot', +sRot.value);
  };
  sRot.oninput();
  /* --- зерно генерации: своё, случайное, заводское --- */
  const sSeed = $('sSeed'), sSeedV = $('sSeedV');
  const showSeed = () => {
    sSeed.value = CONFIG.SEED;
    sSeedV.textContent = CONFIG.SEED === CONFIG.SEED_DEFAULT ? 'заводское' : 'своё, сохранено';
  };
  const applySeed = v => {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n) || n < 0) { showSeed(); return; }
    CONFIG.SEED = n >>> 0;
    if (CONFIG.SEED === CONFIG.SEED_DEFAULT) prefs.drop('seed');
    else prefs.set('seed', CONFIG.SEED);
    showSeed();
    rebuild();
    applyPalette(phase);
  };
  showSeed();
  sSeed.onchange = () => applySeed(sSeed.value);
  $('sSeedRnd').onclick = () => applySeed(Math.floor(Math.random() * 4294967296));
  $('sSeedDef').onclick = () => applySeed(CONFIG.SEED_DEFAULT);

  const sWind = $('sWind');
  sWind.value = prefs.get('wind', 100);
  sWind.oninput = () => {
    windBase = sWind.value / 100;
    windU.uWind.value = windBase;
    $('sWindV').textContent = sWind.value > 0 ? sWind.value + '%' : 'штиль';
    prefs.set('wind', +sWind.value);
  };
  sWind.oninput();
  const swCycle = $('sCycle'), swFps = $('sFps');
  autoCycle = prefs.get('cycle', false);
  swCycle.classList.toggle('on', autoCycle);
  swCycle.onclick = () => {
    autoCycle = !autoCycle;
    swCycle.classList.toggle('on', autoCycle);
    prefs.set('cycle', autoCycle);
  };
  showFps = prefs.get('fps', false);
  swFps.classList.toggle('on', showFps);
  $('fps').classList.toggle('show', showFps);
  swFps.onclick = () => {
    showFps = !showFps;
    swFps.classList.toggle('on', showFps);
    $('fps').classList.toggle('show', showFps);
    prefs.set('fps', showFps);
  };

  /* Кликабельна была только сама пилюля переключателя — 15% ширины строки.
     Промах по подписи не делал ничего, второй тык попадал в соседнюю строку,
     и со стороны это выглядело как «включается не то». Вся строка со
     переключателем теперь переключает его. */
  for (const row of document.querySelectorAll('.row')) {
    const sw = row.querySelector('.sw');
    if (!sw) continue;
    row.style.cursor = 'pointer';
    row.addEventListener('click', e => { if (e.target !== sw) sw.click(); });
  }

  /* Вкладки настроек: девятнадцать строк в одном свитке не читались */
  const tabBtns = [...document.querySelectorAll('.tabbtn')];
  const tabs = [...document.querySelectorAll('.tab')];
  for (const b of tabBtns) {
    b.addEventListener('click', () => {
      for (const x of tabBtns) x.classList.toggle('on', x === b);
      for (const t of tabs) t.classList.toggle('on', t.dataset.tab === b.dataset.tab);
      $('set').scrollTop = 0;
    });
  }

  /* версия видна пользователю: по ней он сообщит, что именно у него */
  const vEl = $('ver');
  if (vEl) vEl.textContent = 'v' + VERSION;

  $('go').onclick = () => {
    $('intro').classList.add('hide');
    setTimeout(() => { $('intro').style.display = 'none'; }, 700);
    ctl.enabled = true;
    startAudio();                 // AudioContext можно завести только по жесту
    if (!isMobile) renderer.domElement.requestPointerLock?.();
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   ПРОИЗВОДИТЕЛЬНОСТЬ
   ═══════════════════════════════════════════════════════════════════════════ */
let dprIndex = 0, dprCap = 0, paused = false, frames = 0, winT = 0, upT = 0, worstDt = 0;
const capForQuality = () => Math.min(CONFIG.QUALITY[currentQuality()].dpr, isMobile ? 3 : 4);
const startDpr = () => quality === 'AUTO' && isMobile ? Math.min(2, capForQuality()) : capForQuality();
let ssaa = 1, shotBoost = 1, aaLabel = 'MSAA', windBase = 1;
let hullAlbedoTex = null, mirrorOn = 0, traceHeld = false;
let glowOn = false, raysOn = false, trafficOn = true;
/* Множитель суперсэмплинга применяется ПОВЕРХ плотности экрана. Раньше здесь
   стоял min(devicePixelRatio, шаг) — на обычном мониторе 1× он намертво
   запирал рендер на 1×, и никакого сглаживания сверх MSAA получить было
   нельзя. Адаптив по-прежнему двигает шаг, а не множитель. */
const renderScale = () => Math.min(
  CONFIG.SSAA_MAX * CONFIG.SHOT.max,
  Math.min(devicePixelRatio || 1, CONFIG.DPR_STEPS[dprIndex]) * ssaa * shotBoost);
const applyDpr = () => renderer.setPixelRatio(renderScale());

/* Размер берём у самого контейнера, а не у окна. При входе в полноэкранный
   режим окно ещё не пересчитано в момент события resize, и рендер оставался
   прежнего размера — отсюда чёрные поля справа и снизу. ResizeObserver
   срабатывает тогда, когда элемент действительно изменился. */
function resize() {
  const w = stage.clientWidth || innerWidth;
  const h = stage.clientHeight || innerHeight;
  if (!w || !h) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
  applyDpr();
  resizePost(renderer);
}

/* ═══════════════════════════════════════════════════════════════════════════
   ЦИКЛ
   ═══════════════════════════════════════════════════════════════════════════ */
const clock = new THREE.Clock();
let cycleT = 0, elapsed = 0;

function loop() {
  requestAnimationFrame(loop);
  if (paused) return;
  const dt = Math.min(0.05, clock.getDelta());
  renderer.info.reset();          // за кадр целиком, а не за последний проход

  /* Путь выводит кадр сам, поэтому обычная отрисовка пропускается целиком.
     Сдвиг камеры сбрасывает накопление: считается новый ракурс. */
  if (pt.active) {
    if (!camera.position.equals(_ptPrev)) {
      _ptPrev.copy(camera.position);
      pathCameraMoved();
    }
    pathStep();
    showTrace(pathLabel());
    /* Затвор обязан работать и здесь. Раньше ветка возвращалась раньше его
       обработки, и снимок во время трассировки не делался вовсе — это
       выглядело как «интерфейс заблокирован нагрузкой», хотя поток свободен. */
    if (shotPending) { shotPending = false; grabShot(); }
    return;
  }
  /* Отказ показывается и после того, как трассировка снялась: иначе нажатие
     выглядит как «ничего не произошло». */
  if (pt.error) {
    showTrace(pathLabel());
    $('bPath').classList.remove('on');
  }

  if (trace.active) {
    const done = traceHeld ? 1 : traceStep();
    /* Показываем не только проценты, но и оставшийся шум: по нему видно,
       что именно ещё уточняется, а проценты сами по себе ни о чём не говорят. */
    const noise = 100 / Math.sqrt(Math.max(1, trace.sample) * trace.rays);
    const what = trace.debug ? `только ${DEBUG_NAMES[trace.debug]} · ` : '';
    $('traceInfo').textContent = done >= 1
      ? `${what}готово · ${trace.total * trace.rays} лучей на пиксель`
      : `${what}${(done * 100) | 0}% · шум ${noise.toFixed(0)}%`;
    if (shotPending) { shotPending = false; grabShot(); }
    return;
  }

  elapsed += dt;

  worldGroup.rotation.z += omega * dt;
  hullU.uTime.value = elapsed;
  glow.rotation.z = Math.atan2(camera.position.x, -camera.position.y);
  updateStructures(dt);
  if (trafficOn) updateTraffic(dt);
  /* Раскладка деревьев по уровням: пересчитывается, только когда камера
     заметно сдвинулась — пять тысяч расстояний каждый кадр не нужны. */
  updateTreeLod(camera.position, worldGroup, false);
  setSunScreen(camera, worldGroup);
  /* камера в системе станции — по ней вода считает отражение */
  hullU.uCamObj.value.copy(worldGroup.worldToLocal(_vMirror.copy(camera.position)));
  hullU.uMirror.value = mirrorOn;
  /* отражениям нужно альбедо корпуса и текущий угол поворота мира */
  setHullRef(hullAlbedoTex, worldGroup.rotation.z);

  /* Авто-режим гонит фазу по кругу непрерывно: день сам перетекает в закат,
     закат в ночь, ночь снова в день. Ручное переключение двигает цель на одну
     фазу вперёд — переход всё равно идёт плавно, а не скачком. */
  if (autoCycle) {
    cycleT += dt;
    if (cycleT > CONFIG.AUTO_CYCLE_PERIOD) { cycleT = 0; phaseTo += 1; setDayIcon(); }
  }
  if (phase < phaseTo) {
    phase = Math.min(phaseTo, phase + dt / CONFIG.FADE);
    applyPalette(phase);
  } else if (phase >= CONFIG.PHASES.length) {
    /* держим счётчики в пределах круга, чтобы не росли бесконечно */
    phase -= CONFIG.PHASES.length; phaseTo -= CONFIG.PHASES.length;
  }
  if (structMats.beacon) {
    structMats.beacon.emissiveIntensity =
      0.2 + (1 - daylight) * (1 + Math.sin(elapsed * 4) * 0.6);
  }

  updateTour(dt);
  updateFly(dt);
  if (!fly.on && !ride.on) updateControls(dt, camera);
  else if (ride.on) { updateControls(dt, camera); updateRide(); }

  /* звуку нужна позиция камеры в системе станции: и река, и ось живут там */
  worldGroup.worldToLocal(_vAudio.copy(camera.position));
  updateAudio(dt, _vAudio, ctl.speed * (ctl.boost ? CONFIG.SPEED_BOOST : 1), daylight);

  renderFrame(renderer, scene, camera, worldGroup.rotation.z);
  if (shotPending) { shotPending = false; grabShot(); }

  /* Средний FPS за секунду прячет рывки: один кадр по 60 мс среди
     шестидесяти по 16 даёт «58 fps», а рукой это чувствуется как провал.
     Поэтому копим и худший кадр окна. */
  frames++; winT += dt;
  worstDt = Math.max(worstDt, dt);
  if (winT >= CONFIG.ADAPT.window) {
    const fps = frames / winT;
    if (fps < CONFIG.ADAPT.down && dprIndex > 0) { dprIndex--; applyDpr(); upT = 0; }
    else if (fps > CONFIG.ADAPT.up) {
      upT += winT;
      if (upT >= CONFIG.ADAPT.upHold && dprIndex < dprCap) { dprIndex++; applyDpr(); upT = 0; }
    } else upT = 0;
    if (showFps) {
      const r = renderer.info.render;
      const worstFps = 1 / Math.max(1e-3, worstDt);
      $('fps').textContent =
        `${fps.toFixed(0)} fps   худший кадр ${(worstDt * 1000).toFixed(0)} мс (${worstFps.toFixed(0)} fps)\n`
        + `рендер ×${renderScale().toFixed(2)}   ${aaLabel}\n`
        + `draw ${r.calls}   tri ${(r.triangles / 1000).toFixed(0)}k`;
    }
    frames = 0; winT = 0; worstDt = 0;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   ЗАПУСК
   ═══════════════════════════════════════════════════════════════════════════ */
try {
  const probe = document.createElement('canvas');
  if (!(probe.getContext('webgl2') || probe.getContext('webgl'))) throw new Error('WebGL недоступен');

  boot();
  initControls(renderer.domElement, stage, () => fly.on || trace.active,
    () => { cancelFly(); stopTracing(); });
  initUI();

  dprCap = capForQuality();
  dprIndex = startDpr();
  resize();

  if ('ResizeObserver' in window) new ResizeObserver(resize).observe(stage);
  addEventListener('resize', resize);
  visualViewport?.addEventListener('resize', resize);
  addEventListener('orientationchange', () => setTimeout(resize, 250));
  for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) {
    document.addEventListener(ev, () => setTimeout(resize, 80));
  }
  document.addEventListener('visibilitychange', () => {
    paused = document.hidden;
    suspendAudio(paused);
    if (!paused) clock.getDelta();
  });
  addEventListener('keydown', stopTracing);
  renderer.domElement.addEventListener('webglcontextlost', e => {
    e.preventDefault(); paused = true;
    $('fatal').classList.add('show');
    $('fatal').firstElementChild.innerHTML =
      '<b>Графический контекст потерян</b><br>Обновите страницу — сцена соберётся заново.';
  });

  /* PWA: worker нужен только для критерия устанавливаемости, кеша в нём нет */
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    /* воркер импортирует версию, значит регистрируется как модуль */
    addEventListener('load', () => navigator.serviceWorker
      .register('sw.js', { type: 'module' }).catch(() => {}));
  }

  loop();
} catch (err) {
  console.error(err);
  $('fatal').classList.add('show');
}
