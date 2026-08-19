import * as THREE from 'three';
import { CONFIG } from './config.js';
import { mulberry32, clamp, lerp, easeInOut, tpVec, TAU } from './util.js';
import { makeSoftSprite, makeGlowTexture } from './textures.js';
import { buildWorld, worldMats, hullU, windU } from './world.js';
import { buildStructures, structMats, updateStructures } from './structures.js';
import { ctl, isMobile, initControls, updateControls, syncFromCamera, resetStick } from './controls.js';

const $ = id => document.getElementById(id);
const stage = $('stage');

/* Зерно переживает перезагрузку. localStorage может быть недоступен
   (приватный режим, отключённые куки) — тогда просто работаем без него. */
const SEED_KEY = 'b5.seed';
const seedStore = {
  load() {
    try {
      const v = Number(localStorage.getItem(SEED_KEY));
      return Number.isFinite(v) && v >= 0 ? v >>> 0 : null;
    } catch { return null; }
  },
  save(v) {
    try {
      if (v === CONFIG.SEED_DEFAULT) localStorage.removeItem(SEED_KEY);
      else localStorage.setItem(SEED_KEY, String(v));
    } catch { /* без сохранения, но работаем */ }
  }
};
CONFIG.SEED = seedStore.load() ?? CONFIG.SEED_DEFAULT;

let renderer, scene, camera, worldGroup, fog;
let hemi, lights = [], glow, clouds, motes, moteMat, panel;

/* ═══════════════════════════════════════════════════════════════════════════
   СЦЕНА
   ═══════════════════════════════════════════════════════════════════════════ */
function boot() {
  renderer = new THREE.WebGLRenderer({
    antialias: !isMobile, powerPreference: 'high-performance', stencil: false
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = false;   // тени — контактные пятна и аналитика в шейдере
  renderer.setSize(innerWidth, innerHeight);
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
  applyPalette(1);
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
  glow = new THREE.Mesh(pg, new THREE.MeshBasicMaterial({
    map: makeGlowTexture(), color: CONFIG.DAY.sunCol, transparent: true,
    opacity: CONFIG.DAY.glowOp, blending: THREE.AdditiveBlending,
    depthWrite: false, fog: false, side: THREE.DoubleSide, toneMapped: false
  }));
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
  for (const z of CONFIG.LIGHT_Z) {
    const l = new THREE.PointLight(CONFIG.DAY.pointCol, CONFIG.DAY.pointInt, 380, 1.05);
    l.position.set(0, 0, z);
    lights.push(l); scene.add(l);
  }
}

function rebuild() {
  const q = currentQuality();
  const res = buildWorld(worldGroup, renderer, q);
  panel = res.panel;
  buildStructures(worldGroup, renderer, q, panel);
}

/* ═══════════════════════════════════════════════════════════════════════════
   ПАЛИТРА ДЕНЬ / НОЧЬ
   Ночью солнечная трубка не гаснет, а тлеет холодным — ночник на оси,
   который даёт эмбиентную подсветку вместо чёрной пустоты.
   ═══════════════════════════════════════════════════════════════════════════ */
let dayMix = 1, dayTarget = 1;
const _a = new THREE.Color(), _b = new THREE.Color(), _r = new THREE.Color();
const mix = (d, n, t, out = _r) => out.copy(_a.setHex(d)).lerp(_b.setHex(n), 1 - t);

function applyPalette(t) {
  const D = CONFIG.DAY, N = CONFIG.NIGHT;

  mix(D.fog, N.fog, t);
  fog.color.copy(_r); scene.background.copy(_r);
  fog.density = lerp(N.fogD, D.fogD, t);

  hemi.color.copy(mix(D.hemiSky, N.hemiSky, t));
  hemi.groundColor.copy(mix(D.hemiGround, N.hemiGround, t));
  hemi.intensity = lerp(N.hemiInt, D.hemiInt, t);

  mix(D.pointCol, N.pointCol, t);
  for (const l of lights) { l.color.copy(_r); l.intensity = lerp(N.pointInt, D.pointInt, t); }

  const sunE = lerp(N.sunEmis, D.sunEmis, t);
  mix(D.sunCol, N.sunCol, t);
  if (structMats.sun) structMats.sun.color.copy(_r).multiplyScalar(sunE);
  glow.material.color.copy(_r);
  glow.material.opacity = lerp(N.glowOp, D.glowOp, t);

  const emis = lerp(N.winEmis, D.winEmis, t);
  for (const m of worldMats.bld) m.emissiveIntensity = emis;
  for (const m of structMats.glass) m.emissiveIntensity = emis * 0.8;
  if (structMats.liftGlass) structMats.liftGlass.emissiveIntensity = lerp(1.4, 0.3, t);

  if (worldMats.nav) {
    worldMats.nav.opacity = clamp(lerp(N.navInt, D.navInt, t), 0, 1);
    worldMats.nav.size = lerp(N.navSize, D.navSize, t);
  }
  /* контактные тени слабеют вместе с источником */
  if (worldMats.blob) worldMats.blob.opacity = lerp(0.22, 0.85, t);

  moteMat.color.copy(mix(D.moteCol, N.moteCol, t));
  moteMat.opacity = lerp(N.moteOp, D.moteOp, t);
  moteMat.size = lerp(0.95, 0.55, t);
  clouds.material.opacity = lerp(0.06, 0.22, t);

  hullU.uSparShade.value = lerp(N.sparShade, D.sparShade, t);
  hullU.uCityGlow.value = lerp(N.cityGlow, D.cityGlow, t);
  hullU.uWaterTint.value.copy(mix(D.waterTint, N.waterTint, t));
}

/* ═══════════════════════════════════════════════════════════════════════════
   ТЕЛЕПОРТЫ: цели живут в локальных координатах и каждый кадр
   переводятся в мировые — посадочная точка честно едет с вращением
   ═══════════════════════════════════════════════════════════════════════════ */
const fly = {
  on: false, t: 0, dur: 3,
  p0: new THREE.Vector3(), p1: new THREE.Vector3(), p2: new THREE.Vector3(),
  look: new THREE.Vector3(), q0: new THREE.Quaternion(), rot0: 0
};
const _o = new THREE.Object3D(), _qA = new THREE.Quaternion(), _qB = new THREE.Quaternion();
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _Z = new THREE.Vector3(0, 0, 1);

function goTo(i, instant = false) {
  const tp = CONFIG.TP[i];
  const target = tpVec(tp.pos), look = tpVec(tp.look);
  worldGroup.updateMatrixWorld();

  if (instant) {
    camera.position.copy(worldGroup.localToWorld(target.clone()));
    _o.position.copy(camera.position);
    _o.up.set(0, 1, 0);
    _o.lookAt(worldGroup.localToWorld(look.clone()));
    camera.quaternion.copy(_o.quaternion);
    syncFromCamera(camera);
    return;
  }

  fly.p0.copy(worldGroup.worldToLocal(camera.position.clone()));
  fly.p2.copy(target);
  fly.look.copy(look);

  /* дуга: контрольная точка приподнята к оси */
  fly.p1.addVectors(fly.p0, fly.p2).multiplyScalar(0.5);
  const rad = Math.hypot(fly.p1.x, fly.p1.y);
  if (rad > 1e-3) {
    const nr = Math.max(CONFIG.FLY.arcMinR, rad - CONFIG.FLY.arc);
    fly.p1.x *= nr / rad; fly.p1.y *= nr / rad;
  }

  fly.dur = clamp(CONFIG.FLY.min + fly.p0.distanceTo(fly.p2) / 90, CONFIG.FLY.min, CONFIG.FLY.max);
  fly.q0.copy(camera.quaternion);
  fly.rot0 = worldGroup.rotation.z;
  fly.t = 0; fly.on = true;
  resetStick();
}

function updateFly(dt) {
  if (!fly.on) return;
  fly.t = Math.min(1, fly.t + dt / fly.dur);
  const e = easeInOut(fly.t), it = 1 - e;
  worldGroup.updateMatrixWorld();

  _v.set(
    it * it * fly.p0.x + 2 * it * e * fly.p1.x + e * e * fly.p2.x,
    it * it * fly.p0.y + 2 * it * e * fly.p1.y + e * e * fly.p2.y,
    it * it * fly.p0.z + 2 * it * e * fly.p1.z + e * e * fly.p2.z
  );
  worldGroup.localToWorld(_v);
  camera.position.copy(_v);

  _v2.copy(fly.look); worldGroup.localToWorld(_v2);
  _o.position.copy(_v); _o.up.set(0, 1, 0); _o.lookAt(_v2);
  _qB.copy(_o.quaternion);
  _qA.setFromAxisAngle(_Z, worldGroup.rotation.z - fly.rot0).multiply(fly.q0);
  camera.quaternion.slerpQuaternions(_qA, _qB, e);

  if (fly.t >= 1) { fly.on = false; syncFromCamera(camera); }
}
function cancelFly() { fly.on = false; syncFromCamera(camera); }

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
    d.addEventListener('click', () => { closeSheets(); goTo(i); });
    list.appendChild(d);
  });

  $('bTp').onclick = () => toggleSheet('tp');
  $('bSet').onclick = () => toggleSheet('set');
  $('bHelp').onclick = () => toggleSheet('help');
  $('tpClose').onclick = $('setClose').onclick = $('helpClose').onclick = closeSheets;

  const bDay = $('bDay'), SUN = bDay.innerHTML;
  const MOON = '<svg viewBox="0 0 24 24"><path d="M20.5 14.6A8.6 8.6 0 0 1 9.4 3.5a8.6 8.6 0 1 0 11.1 11.1z"/></svg>';
  setDayIcon = () => {
    bDay.innerHTML = dayTarget < 0.5 ? MOON : SUN;
    bDay.classList.toggle('on', dayTarget < 0.5);
  };
  bDay.onclick = () => { dayTarget = dayTarget > 0.5 ? 0 : 1; setDayIcon(); };

  $('bFs').onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.()?.catch?.(() => {});
  };

  $('sQual').onchange = e => {
    quality = e.target.value;
    dprCap = capForQuality(); dprIndex = startDpr(); applyDpr();
    rebuild();
    applyPalette(easeInOut(clamp(dayMix, 0, 1)));
  };
  const sSens = $('sSens');
  sSens.oninput = () => { ctl.sens = sSens.value / 100; $('sSensV').textContent = ctl.sens.toFixed(2) + '×'; };
  const sRot = $('sRot');
  sRot.oninput = () => {
    const v = sRot.value / 100;
    omega = v * TAU / CONFIG.ROT_PERIOD_CANON;
    $('sRotV').textContent = v <= 0.001 ? 'остановлено' : 'оборот за ' + Math.round(TAU / omega) + ' с';
  };
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
    seedStore.save(CONFIG.SEED);
    showSeed();
    rebuild();
    applyPalette(easeInOut(clamp(dayMix, 0, 1)));
  };
  showSeed();
  sSeed.onchange = () => applySeed(sSeed.value);
  $('sSeedRnd').onclick = () => applySeed(Math.floor(Math.random() * 4294967296));
  $('sSeedDef').onclick = () => applySeed(CONFIG.SEED_DEFAULT);

  const sWind = $('sWind');
  sWind.oninput = () => {
    windU.uWind.value = sWind.value / 100;
    $('sWindV').textContent = sWind.value > 0 ? sWind.value + '%' : 'штиль';
  };
  const swCycle = $('sCycle'), swFps = $('sFps');
  swCycle.onclick = () => { autoCycle = !autoCycle; swCycle.classList.toggle('on', autoCycle); };
  swFps.onclick = () => {
    showFps = !showFps;
    swFps.classList.toggle('on', showFps);
    $('fps').classList.toggle('show', showFps);
  };

  $('go').onclick = () => {
    $('intro').classList.add('hide');
    setTimeout(() => { $('intro').style.display = 'none'; }, 700);
    ctl.enabled = true;
    if (!isMobile) renderer.domElement.requestPointerLock?.();
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   ПРОИЗВОДИТЕЛЬНОСТЬ
   ═══════════════════════════════════════════════════════════════════════════ */
let dprIndex = 0, dprCap = 0, paused = false, frames = 0, winT = 0, upT = 0;
const capForQuality = () => quality === 'LOW' ? 0 : (isMobile ? 3 : 4);
const startDpr = () => quality === 'AUTO' && isMobile ? Math.min(2, capForQuality()) : capForQuality();
const applyDpr = () => renderer.setPixelRatio(Math.min(devicePixelRatio || 1, CONFIG.DPR_STEPS[dprIndex]));

function resize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight, false);
  applyDpr();
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
  elapsed += dt;

  worldGroup.rotation.z += omega * dt;
  hullU.uTime.value = elapsed;
  glow.rotation.z = Math.atan2(camera.position.x, -camera.position.y);
  updateStructures(dt);

  if (autoCycle) {
    cycleT += dt;
    if (cycleT > CONFIG.AUTO_CYCLE_PERIOD) {
      cycleT = 0; dayTarget = dayTarget > 0.5 ? 0 : 1; setDayIcon();
    }
  }
  if (Math.abs(dayMix - dayTarget) > 5e-4) {
    const step = dt / CONFIG.FADE;
    dayMix += Math.sign(dayTarget - dayMix) * Math.min(step, Math.abs(dayTarget - dayMix));
    applyPalette(easeInOut(clamp(dayMix, 0, 1)));
  }
  if (structMats.beacon) {
    structMats.beacon.emissiveIntensity = 0.2 + (1 - dayMix) * (1 + Math.sin(elapsed * 4) * 0.6);
  }

  updateFly(dt);
  if (!fly.on) updateControls(dt, camera);

  renderer.render(scene, camera);

  frames++; winT += dt;
  if (winT >= CONFIG.ADAPT.window) {
    const fps = frames / winT;
    if (fps < CONFIG.ADAPT.down && dprIndex > 0) { dprIndex--; applyDpr(); upT = 0; }
    else if (fps > CONFIG.ADAPT.up) {
      upT += winT;
      if (upT >= CONFIG.ADAPT.upHold && dprIndex < dprCap) { dprIndex++; applyDpr(); upT = 0; }
    } else upT = 0;
    if (showFps) {
      const r = renderer.info.render;
      $('fps').textContent = `${fps.toFixed(0)} fps   dpr ${CONFIG.DPR_STEPS[dprIndex]}\n`
        + `draw ${r.calls}   tri ${(r.triangles / 1000).toFixed(0)}k`;
    }
    frames = 0; winT = 0;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   ЗАПУСК
   ═══════════════════════════════════════════════════════════════════════════ */
try {
  const probe = document.createElement('canvas');
  if (!(probe.getContext('webgl2') || probe.getContext('webgl'))) throw new Error('WebGL недоступен');

  boot();
  initControls(renderer.domElement, stage, () => fly.on, cancelFly);
  initUI();

  dprCap = capForQuality();
  dprIndex = startDpr();
  resize();

  addEventListener('resize', resize);
  visualViewport?.addEventListener('resize', resize);
  addEventListener('orientationchange', () => setTimeout(resize, 250));
  document.addEventListener('visibilitychange', () => {
    paused = document.hidden;
    if (!paused) clock.getDelta();
  });
  renderer.domElement.addEventListener('webglcontextlost', e => {
    e.preventDefault(); paused = true;
    $('fatal').classList.add('show');
    $('fatal').firstElementChild.innerHTML =
      '<b>Графический контекст потерян</b><br>Обновите страницу — сцена соберётся заново.';
  });

  loop();
} catch (err) {
  console.error(err);
  $('fatal').classList.add('show');
}
