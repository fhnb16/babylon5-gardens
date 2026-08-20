import * as THREE from 'three';
import { CONFIG } from './config.js';
import { mulberry32, D2R, TAU, surfaceQuat, surfacePos, mergeGeos, rod, panelUV, deepDispose } from './util.js';
import { makeEndCapTexture } from './textures.js';
import { patchRoughnessAlpha } from './world.js';

/* Материалы, которыми управляет палитра день/ночь */
export const structMats = { sun: null, glass: [], beacon: null, liftGlass: null };

let parts = [];
let lifts = null, liftCount = 0;

export function disposeStructures(group) {
  for (const o of parts) { group.remove(o); deepDispose(o); }
  parts = []; lifts = null;
  structMats.sun = null; structMats.glass = []; structMats.beacon = null; structMats.liftGlass = null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   ОСЕВАЯ КОНСТРУКЦИЯ
   Светящаяся труба — это и есть «солнце»: вдоль неё идут рёбра, монорельс
   осевого лифта и силовые узлы, от которых ферма расходится к корпусу.
   Всё живёт в worldGroup: цилиндр на оси симметричен, вращение не ломает,
   зато тени ферм честно едут по земле.
   ═══════════════════════════════════════════════════════════════════════════ */
function buildAxis(group, panel, panelNormal) {
  const A = CONFIG.AXIS, R = CONFIG.R, HL = CONFIG.L / 2;
  const add = o => { group.add(o); parts.push(o); return o; };
  const metal = new THREE.MeshStandardMaterial({
    map: panel, normalMap: panelNormal || null, color: 0x9099a3,
    roughness: 0.45, metalness: 0.62
  });
  patchRoughnessAlpha(metal);

  /* --- светящаяся труба на оси --- */
  const tube = new THREE.CylinderGeometry(CONFIG.SUN.r, CONFIG.SUN.r, CONFIG.SUN.len, 20, 1, true);
  tube.rotateX(Math.PI / 2);
  structMats.sun = new THREE.MeshBasicMaterial({
    color: CONFIG.DAY.sunCol, fog: false, side: THREE.DoubleSide, toneMapped: false
  });
  add(new THREE.Mesh(tube, structMats.sun));

  /* --- спина: рёбра, продольные лонжероны, монорельс лифта --- */
  const spine = [];
  for (let z = -HL + 8; z <= HL - 8; z += A.ribEvery) {
    const t = new THREE.TorusGeometry(A.spineR + 0.6, 0.42, 6, 16);
    t.translate(0, 0, z);
    spine.push(t);
    /* короткие радиальные кронштейны у каждого ребра */
    for (let k = 0; k < 4; k++) {
      const a = k * Math.PI / 2 + Math.PI / 4;
      spine.push(rod(0.3, 1.9, 0.3, Math.sin(a) * (A.spineR + 1.3), Math.cos(a) * (A.spineR + 1.3), z, 0, 0, -a));
    }
  }
  for (let k = 0; k < 4; k++) {
    const a = k * Math.PI / 2;
    spine.push(rod(0.5, CONFIG.SUN.len, 0.5,
      Math.sin(a) * (A.spineR + 0.6), Math.cos(a) * (A.spineR + 0.6), 0, Math.PI / 2));
  }
  /* Два монорельса на противоположных сторонах оси — по одному на каждое
     направление. С единственным рельсом встречные кабины проходили сквозь
     друг друга. Углы (0° и 180°) выбраны между фермами. */
  const railR = A.spineR + 2.8;
  for (const side of A.railAngles) {
    const c = Math.cos(side), sn = Math.sin(side);
    const put = (w, d, ox, oy) => spine.push(rod(w, CONFIG.SUN.len, d,
      ox * c + oy * sn, -ox * sn + oy * c, 0, Math.PI / 2));
    put(1.5, 0.7, 0, railR);
    put(0.34, 0.34, -0.8, railR + 0.55);
    put(0.34, 0.34, 0.8, railR + 0.55);
  }
  add(new THREE.Mesh(panelUV(mergeGeos(spine), CONFIG.PANEL_TILE), metal));

  /* --- кабины осевого лифта --- */
  /* длинная сторона кабины — вдоль оси (локальный Z), +Y смотрит на ось */
  const carBody = panelUV(mergeGeos([
    rod(2.6, 2.2, 6.4, 0, 0, 0),
    rod(2.9, 2.5, 0.5, 0, 0, 3.3),
    rod(2.9, 2.5, 0.5, 0, 0, -3.3),
    rod(0.5, 2.6, 0.5, 0, 1.6, 0)           // токосъёмник вверх, к рельсу
  ]), CONFIG.PANEL_TILE);
  const carGlass = mergeGeos([
    rod(2.72, 1.4, 4.6, 0, 0.15, 0),        // поясные окна по бортам
    rod(2.3, 1.4, 0.1, 0, 0.15, 3.35)
  ]);
  structMats.liftGlass = new THREE.MeshStandardMaterial({
    color: 0x16283c, roughness: 0.1, metalness: 0.7,
    emissive: 0xffe0b0, emissiveIntensity: 0.35
  });
  liftCount = A.railAngles.length;
  lifts = {
    body: new THREE.InstancedMesh(carBody, metal, liftCount),
    glass: new THREE.InstancedMesh(carGlass, structMats.liftGlass, liftCount),
    z: A.railAngles.map((_, k) => k % 2 ? 60 : -40),
    dir: A.railAngles.map((_, k) => k % 2 ? -1 : 1),
    ang: A.railAngles.slice(),
    r: railR + 2.6      // кабина идёт снаружи балки, ниже её по радиусу
  };
  lifts.body.frustumCulled = lifts.glass.frustumCulled = false;
  add(lifts.body); add(lifts.glass);
  updateStructures(0);

  /* --- силовые узлы и ферма --- */
  const collar = [];
  for (const z of A.spars) {
    const t = new THREE.TorusGeometry(A.spineR + 1.2, 0.8, 8, 20);
    t.translate(0, 0, z);
    collar.push(t);
  }
  add(new THREE.Mesh(panelUV(mergeGeos(collar), CONFIG.PANEL_TILE), metal));

  const trussLen = R - 1 - (A.spineR + 2.4);
  const truss = trussGeo(trussLen, A.trussW, A.trussBay);
  const arms = new THREE.InstancedMesh(truss, metal, A.spars.length * A.sparArms);
  arms.frustumCulled = false;
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v3 = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  let n = 0;
  for (const z of A.spars) {
    for (let k = 0; k < A.sparArms; k++) {
      const t = (A.sparAngle + k * 360 / A.sparArms) * D2R;
      /* +Y локального базиса смотрит на ось → ферма растёт от корпуса внутрь */
      m4.compose(surfacePos(t, R - 1, z, v3), surfaceQuat(t, q), one);
      arms.setMatrixAt(n++, m4);
    }
  }
  arms.instanceMatrix.needsUpdate = true;
  add(arms);
}

/** Решётчатая ферма вдоль локальной +Y: 4 пояса + раскосы по отсекам.
    У корпуса — массивное основание: три опоры держат всю станцию, и голая
    решётка, воткнутая в грунт, выглядела бы несерьёзно. */
function trussGeo(len, w, bay) {
  const g = [], h = w / 2, chord = 0.34;
  const B = CONFIG.AXIS.baseR;

  /* стилобат, утопленный в корпус, и сужающийся воротник над ним */
  const disc = (r0, r1, hh, y, seg = 20) => {
    const c = new THREE.CylinderGeometry(r0, r1, hh, seg, 1, false);
    c.translate(0, y + hh / 2, 0);
    return c;
  };
  g.push(disc(B, B * 1.06, 1.4, -0.7));          // плита в грунте
  g.push(disc(B * 0.78, B * 0.94, 1.1, 0.7));    // ступень
  g.push(disc(w * 1.5, B * 0.74, 4.2, 1.8));     // воротник к ферме

  /* контрфорсы: от края плиты наклонно к воротнику */
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * TAU + 0.26;
    const fin = new THREE.BoxGeometry(0.7, 5.6, 1.5);
    fin.rotateZ(0.44);
    fin.translate(B * 0.62, 2.6, 0);
    fin.rotateY(a);
    g.push(fin);
  }
  for (const [sx, sz] of [[-h, -h], [h, -h], [-h, h], [h, h]]) {
    g.push(rod(chord, len, chord, sx, len / 2, sz));
  }
  const bays = Math.max(2, Math.round(len / bay));
  for (let i = 0; i <= bays; i++) {
    const y = (i / bays) * len;
    g.push(rod(w, 0.2, 0.2, 0, y, -h));
    g.push(rod(w, 0.2, 0.2, 0, y, h));
    g.push(rod(0.2, 0.2, w, -h, y, 0));
    g.push(rod(0.2, 0.2, w, h, y, 0));
    if (i < bays) {
      const dy = len / bays, d = Math.hypot(w, dy), a = Math.atan2(w, dy);
      g.push(rod(0.17, d, 0.17, 0, y + dy / 2, -h, 0, 0, i % 2 ? a : -a));
      g.push(rod(0.17, d, 0.17, 0, y + dy / 2, h, 0, 0, i % 2 ? -a : a));
    }
  }
  return panelUV(mergeGeos(g), CONFIG.PANEL_TILE);
}

/* ═══════════════════════════════════════════════════════════════════════════
   БАШНЯ КОМАНДОВАНИЯ — здание, а не пипка.
   Стилобат, террасы, барабан, колоннада и остеклённая ротонда кабинета
   коммандора наверху, мачта с маяком, три контрфорса у основания.
   ═══════════════════════════════════════════════════════════════════════════ */
function buildTower(group, panel, panelNormal) {
  const T = CONFIG.TOWER;
  const g = new THREE.Group();
  g.quaternion.copy(surfaceQuat(T.deg * D2R));
  g.position.copy(surfacePos(T.deg * D2R, CONFIG.R, T.z));
  /* башня начерчена на modelH, живёт на h — силуэт становится горизонтальнее */
  g.scale.set(1, T.h / T.modelH, 1);
  group.add(g); parts.push(g);

  const cyl = (r0, r1, h, y, seg = 24) => {
    const c = new THREE.CylinderGeometry(r0, r1, h, seg, 1, false);
    c.translate(0, y + h / 2, 0);
    return c;
  };

  /* --- бетон --- */
  const shell = [
    cyl(T.plinthR, T.plinthR, 1.2, 0, 28),
    cyl(8.2, 8.2, 1.0, 1.2, 28),
    rod(15.5, 0.7, 6.4, 0, 2.55, 3.2),
    rod(6.4, 0.7, 14.0, -3.0, 2.55, -2.2),
    cyl(5.6, 5.2, 12.0, 2.2),
    cyl(6.7, 6.7, 0.55, 14.2, 28),
    cyl(4.3, 4.0, 8.0, 14.75),
    cyl(6.3, 6.3, 0.6, 22.75, 28),
    cyl(6.8, 6.8, 0.75, 27.6, 28),          // кровля кабинета
    cyl(0.9, 0.3, 5.2, 28.35, 12),          // мачта
    rod(1.2, 0.25, 9.0, 0, 8.4, 5.6),       // консольный балкон
    rod(9.0, 0.25, 1.2, 5.6, 11.4, 0)
  ];
  /* колоннада кабинета */
  for (let k = 0; k < 22; k++) {
    const a = (k / 22) * TAU;
    shell.push(rod(0.4, 4.3, 0.4, Math.sin(a) * 5.9, 25.45, Math.cos(a) * 5.9));
  }
  /* три контрфорса */
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * TAU + 0.4;
    const l = new THREE.CylinderGeometry(0.38, 0.75, 14, 8);
    l.rotateZ(0.42); l.translate(6.4, 6.6, 0); l.rotateY(a);
    shell.push(l);
  }
  const concrete = new THREE.MeshStandardMaterial({
    map: panel, normalMap: panelNormal || null, color: 0xc0a993,
    roughness: 0.78, metalness: 0.06
  });
  patchRoughnessAlpha(concrete);
  g.add(new THREE.Mesh(panelUV(mergeGeos(shell), CONFIG.PANEL_TILE, T.h / T.modelH), concrete));

  /* --- стекло: поясное остекление барабанов и ротонда кабинета --- */
  const glass = [
    cyl(5.65, 5.5, 1.5, 4.2), cyl(5.5, 5.4, 1.5, 7.6), cyl(5.4, 5.3, 1.5, 11.0),
    cyl(4.35, 4.3, 1.6, 16.6), cyl(4.3, 4.2, 1.6, 20.0),
    cyl(5.5, 5.5, 4.2, 23.35, 28)            // кабинет коммандора
  ];
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x16283c, roughness: 0.09, metalness: 0.72,
    emissive: 0xffe6bd, emissiveIntensity: 0
  });
  patchRoughnessAlpha(glassMat);
  structMats.glass.push(glassMat);
  g.add(new THREE.Mesh(panelUV(mergeGeos(glass), CONFIG.PANEL_TILE * 0.5, T.h / T.modelH), glassMat));

  /* --- маяк на мачте --- */
  structMats.beacon = new THREE.MeshStandardMaterial({
    color: 0x30414f, emissive: 0xff5c3a, emissiveIntensity: 0.2, roughness: 0.4
  });
  const beacon = new THREE.Mesh(new THREE.IcosahedronGeometry(1.0, 1), structMats.beacon);
  beacon.position.y = 34.2;
  g.add(beacon);
}

/* ═══════════════════════════════════════════════════════════════════════════
   ТОРЦЫ: диск с кольцевой текстурой, ступица и 6 спиц одной геометрией
   ═══════════════════════════════════════════════════════════════════════════ */
function buildEndCaps(group, renderer, low) {
  const R = CONFIG.R, HL = CONFIG.L / 2;
  const { map, emis } = makeEndCapTexture(low ? 512 : 1024, mulberry32(CONFIG.SEED + 99));
  map.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  for (const sign of [-1, 1]) {
    const mat = new THREE.MeshStandardMaterial({
      map, emissiveMap: emis, emissive: 0xffffff, emissiveIntensity: 0,
      side: THREE.DoubleSide, roughness: 0.85, metalness: 0.12
    });
    structMats.glass.push(mat);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(R, 72), mat);
    disc.position.z = sign * HL;
    if (sign > 0) disc.rotation.y = Math.PI;
    group.add(disc); parts.push(disc);

    const p = [];
    const hub = new THREE.CylinderGeometry(4.6, 4.6, 18, 18, 1, false);
    hub.rotateX(Math.PI / 2);
    p.push(hub);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * TAU + 0.26;
      const spoke = new THREE.BoxGeometry(1.7, 1.2, R - 6);
      spoke.rotateX(Math.PI / 2);
      spoke.translate(0, (R + 4) / 2 - 2, 0);
      spoke.rotateZ(-a);
      p.push(spoke);
    }
    const merged = panelUV(mergeGeos(p), CONFIG.PANEL_TILE);
    merged.translate(0, 0, sign * (HL - 8));
    const mesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({
      color: 0xa7b0ba, roughness: 0.45, metalness: 0.55
    }));
    group.add(mesh); parts.push(mesh);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   ПУБЛИЧНОЕ API
   ═══════════════════════════════════════════════════════════════════════════ */
export function buildStructures(group, renderer, quality, panel, panelNormal) {
  disposeStructures(group);
  buildAxis(group, panel, panelNormal);
  buildTower(group, panel, panelNormal);
  buildEndCaps(group, renderer, quality === 'LOW');
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _v = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);

/** Лифт ходит вдоль оси и разворачивается у торцов */
export function updateStructures(dt) {
  if (!lifts) return;
  const lim = CONFIG.L / 2 - 16;
  for (let k = 0; k < liftCount; k++) {
    lifts.z[k] += lifts.dir[k] * CONFIG.AXIS.liftSpeed * dt;
    if (lifts.z[k] > lim) { lifts.z[k] = lim; lifts.dir[k] = -1; }
    if (lifts.z[k] < -lim) { lifts.z[k] = -lim; lifts.dir[k] = 1; }
    /* кабина висит на своём монорельсе: локальный +Y базиса смотрит на ось */
    _m.compose(surfacePos(lifts.ang[k], lifts.r, lifts.z[k], _v),
      surfaceQuat(lifts.ang[k], _q), _one);
    lifts.body.setMatrixAt(k, _m);
    lifts.glass.setMatrixAt(k, _m);
  }
  lifts.body.instanceMatrix.needsUpdate = true;
  lifts.glass.instanceMatrix.needsUpdate = true;
}
