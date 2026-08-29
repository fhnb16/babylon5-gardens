import * as THREE from 'three';
import { CONFIG } from './config.js';
import { mulberry32, D2R, TAU, surfaceQuat, surfacePos, mergeGeos, rod, panelUV,
  fadeByFog, deepDispose } from './util.js';
import { makeEndCapTexture, heightToNormal } from './textures.js';
import { patchRoughnessAlpha } from './world.js';

/* Материалы, которыми управляет палитра день/ночь */
export const structMats = { sun: null, glass: [], beacon: null,
  liftGlass: null, liftBody: null, liftLamp: null };

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
  /* Торцы закрыты: открытый цилиндр обрывался в воздухе полым кольцом */
  const tube = new THREE.CylinderGeometry(CONFIG.SUN.r, CONFIG.SUN.r, CONFIG.SUN.len, 20, 1, false);
  tube.rotateX(Math.PI / 2);
  /* Труба тоже уходит в дымку: иначе дальний её конец висит поверх тумана */
  structMats.sun = fadeByFog(new THREE.MeshBasicMaterial({
    color: CONFIG.DAY.sunCol, transparent: true,
    side: THREE.DoubleSide, toneMapped: false
  }));
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
  const RB = CONFIG.RAILBEAM;
  for (const side of A.railAngles) {
    const c = Math.cos(side), sn = Math.sin(side);
    const put = (w, len, d, ox, oy, oz = 0, rx = Math.PI / 2) =>
      spine.push(rod(w, len, d, ox * c + oy * sn, -ox * sn + oy * c, oz, rx));

    /* Ходовая балка — решётчатая ферма, а не палка: четыре пояса и раскосы
       по отсекам. Поезд весом в сотни тонн на прямой трубе выглядел
       игрушечно, а ферма сразу читается как несущая конструкция. */
    for (const [ox, oy] of [[-RB.w, RB.h], [RB.w, RB.h], [-RB.w, -RB.h], [RB.w, -RB.h]]) {
      put(RB.chord, CONFIG.SUN.len, RB.chord, ox, railR + oy);
    }
    const bays = Math.round(CONFIG.SUN.len / RB.bay);
    for (let k = 0; k < bays; k++) {
      const z0 = -CONFIG.SUN.len / 2 + k * RB.bay;
      /* раскосы крест-накрест: по бортам и снизу */
      for (const [ax, ay, tilt] of [[-RB.w, 0, 1], [RB.w, 0, -1], [0, -RB.h, 1]]) {
        const d = new THREE.BoxGeometry(RB.brace, RB.brace, Math.hypot(RB.bay, RB.h * 2));
        d.rotateX(Math.atan2(RB.h * 2, RB.bay) * tilt);
        const g0 = rod(0, 0, 0, 0, 0, 0);
        d.translate(0, 0, 0);
        const px = ax || 0, py = railR + ay;
        d.translate(px * c + py * sn, -px * sn + py * c, z0 + RB.bay / 2);
        spine.push(d);
      }
      /* поперечины на границах отсеков */
      const cross = new THREE.BoxGeometry(RB.w * 2, RB.brace, RB.brace);
      cross.translate(0, railR - RB.h, z0);
      cross.rotateZ(-side);
      spine.push(cross);
    }
  }
  add(new THREE.Mesh(panelUV(mergeGeos(spine), CONFIG.PANEL_TILE), metal));

  /* --- кабины осевого лифта --- */
  /* длинная сторона кабины — вдоль оси (локальный Z), +Y смотрит на ось */
  /* Кабина монорельса: не коробка, а салон. Пол, потолок, торцевые стенки и
     стойки между окнами — сплошного борта нет вообще, его место занимает
     остекление. Раньше корпус был закрытым ящиком, а стекло — вторым ящиком
     поверх него: изнутри камера оказывалась внутри стекла и видела бурую
     заливку вместо вида наружу. */
  const CR = CONFIG.LIFTCAR;
  const hw = CR.w / 2, hh = CR.h / 2, hl = CR.len / 2;
  const carParts = [
    rod(CR.w, CR.floor, CR.len, 0, -hh + CR.floor / 2, 0),          // пол
    rod(CR.w, CR.floor, CR.len, 0, hh - CR.floor / 2, 0),           // потолок
    rod(CR.w, CR.h, CR.floor, 0, 0, hl - CR.floor / 2),             // торец
    rod(CR.w, CR.h, CR.floor, 0, 0, -hl + CR.floor / 2),            // торец
    rod(CR.w * 0.34, CR.h * 0.55, CR.len * 0.26, 0, hh + CR.h * 0.2, 0)  // тележка
  ];
  /* стойки между окнами по обоим бортам */
  const pillars = 5;
  for (let k = 0; k <= pillars; k++) {
    const z = -hl + (CR.len / pillars) * k;
    for (const sx of [-1, 1]) {
      carParts.push(rod(CR.floor, CR.h * 0.86, CR.pillar, sx * hw, 0, z));
    }
  }
  /* Борт выше и ниже окон: без него между окном и потолком оставался зазор
     в треть юнита, и салон просвечивал щелями. Окно занимает пояс, всё
     остальное по высоте закрыто. */
  const winTop = CR.h * 0.04 + CR.h * 0.26, winBot = CR.h * 0.04 - CR.h * 0.26;
  for (const sx of [-1, 1]) {
    const upH = (hh - CR.floor) - winTop;
    if (upH > 0.001) {
      carParts.push(rod(CR.floor, upH, CR.len, sx * hw, winTop + upH / 2, 0));
    }
    const dnH = winBot - (-hh + CR.floor);
    if (dnH > 0.001) {
      carParts.push(rod(CR.floor, dnH, CR.len, sx * hw, winBot - dnH / 2, 0));
    }
    /* подоконный пояс и карниз — по ним читается, где окна */
    carParts.push(rod(CR.floor * 1.4, CR.belt, CR.len, sx * hw, winBot, 0));
    carParts.push(rod(CR.floor * 1.4, CR.belt, CR.len, sx * hw, winTop, 0));
  }
  /* катки по рельсу */
  for (const sgn of [-1, 1]) {
    for (const sx of [-1, 1]) {
      const wheel = new THREE.CylinderGeometry(0.3, 0.3, 0.22, 10);
      wheel.rotateZ(Math.PI / 2);
      wheel.translate(sx * CR.w * 0.4, hh + CR.h * 0.42, sgn * CR.len * 0.3);
      carParts.push(wheel);
    }
  }
  /* сиденья вдоль бортов: без них салон читается пустой трубой */
  for (const sx of [-1, 1]) {
    carParts.push(rod(CR.w * 0.22, CR.floor, CR.len * 0.78, sx * (hw - CR.w * 0.13),
      -hh + CR.floor + CR.seat, 0));
    carParts.push(rod(CR.floor, CR.seat, CR.len * 0.78, sx * (hw - CR.w * 0.03),
      -hh + CR.floor + CR.seat / 2, 0));
  }
  const carBody = panelUV(mergeGeos(carParts), CONFIG.PANEL_TILE);
  /* Свой материал у кабины: общий metal имеет металличность 0.62, а металлу
     без карты окружения отражать нечего — он рисуется почти чёрным. Снаружи
     это незаметно, изнутри салон превращался в угольную коробку. */
  structMats.liftBody = new THREE.MeshStandardMaterial({
    map: panel, normalMap: panelNormal || null,
    color: CONFIG.LIFTCAR.color, roughness: 0.6, metalness: 0.12,
    side: THREE.DoubleSide
  });

  /* Лампа по потолку: сплошная полоса, яркость выше единицы — иначе она не
     осветит салон и не попадёт в яркую выборку свечения. */
  const lampGeo = mergeGeos([
    rod(CR.w * 0.3, CR.floor * 0.5, CR.len * 0.9, 0, hh - CR.floor * 1.2, 0)
  ]);
  structMats.liftLamp = new THREE.MeshBasicMaterial({
    color: new THREE.Color(CONFIG.LIFTCAR.lamp, CONFIG.LIFTCAR.lamp * 0.94,
      CONFIG.LIFTCAR.lamp * 0.82),
    toneMapped: false
  });

  /* Остекление — тонкие панели в проёмах бортов, а не второй ящик.
     Камера внутри стоит между ними и смотрит наружу сквозь них. */
  const glassParts = [];
  for (const sx of [-1, 1]) {
    glassParts.push(rod(CR.glass, CR.h * 0.52, CR.len * 0.97, sx * hw, CR.h * 0.04, 0));
  }
  glassParts.push(rod(CR.w * 0.9, CR.h * 0.44, CR.glass, 0, CR.h * 0.04, hl - CR.floor));
  glassParts.push(rod(CR.w * 0.9, CR.h * 0.44, CR.glass, 0, CR.h * 0.04, -hl + CR.floor));
  const carGlass = mergeGeos(glassParts);

  /* Снаружи стекло светится, изнутри почти прозрачно и не пишет глубину:
     иначе оно перекрыло бы вид на проносящийся внизу цилиндр. */
  structMats.liftGlass = new THREE.MeshStandardMaterial({
    color: 0x16283c, roughness: 0.1, metalness: 0.7,
    emissive: 0xffe0b0, emissiveIntensity: 0.35,
    transparent: true, opacity: 1, side: THREE.DoubleSide
  });

  liftCount = A.railAngles.length;
  lifts = {
    body: new THREE.InstancedMesh(carBody, structMats.liftBody, liftCount),
    lamp: new THREE.InstancedMesh(lampGeo, structMats.liftLamp, liftCount),
    glass: new THREE.InstancedMesh(carGlass, structMats.liftGlass, liftCount),
    z: A.railAngles.map((_, k) => k % 2 ? 60 : -40),
    dir: A.railAngles.map((_, k) => k % 2 ? -1 : 1),
    ang: A.railAngles.slice(),
    r: railR + 2.6      // кабина идёт снаружи балки, ниже её по радиусу
  };
  lifts.body.frustumCulled = lifts.glass.frustumCulled = lifts.lamp.frustumCulled = false;
  add(lifts.body); add(lifts.lamp); add(lifts.glass);
  updateStructures(0);

  /* --- силовые узлы и ферма --- */
  const collar = [];
  for (const z of A.spars) {
    const t = new THREE.TorusGeometry(A.spineR + 1.2, 0.8, 8, 20);
    t.translate(0, 0, z);
    collar.push(t);
  }
  add(new THREE.Mesh(panelUV(mergeGeos(collar), CONFIG.PANEL_TILE), metal));

  /* Колонна доводится до САМОЙ спины, а не обрывается в полутора юнитах от
     неё: раньше верх висел в воздухе. Плюс седло — хомут, которым колонна
     обхватывает спину. */
  const trussLen = R - 1 - A.spineR;
  const truss = trussGeo(trussLen, A.trussW);
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

/** Силовая опора вдоль локальной +Y: монолитная коническая колонна с
    массивным основанием у корпуса.

    Решётка тут не к месту: это несущая колонна, держащая станцию, а не
    мостовая ферма. Решётчатой осталась только ходовая балка монорельса —
    она длинная и работает на изгиб, там решётка оправдана. */
function trussGeo(len, w) {
  const g = [];
  const B = CONFIG.AXIS.baseR;
  const C = CONFIG.AXIS.column;

  /* ствол: конус, расширяющийся к основанию */
  const shaft = new THREE.CylinderGeometry(w * C.top, w * C.bottom, len, C.seg, 1, false);
  shaft.translate(0, len / 2, 0);
  g.push(shaft);

  /* бандажи по длине — по ним читается масштаб */
  const rings = Math.max(2, Math.round(len / C.ringStep));
  for (let k = 1; k < rings; k++) {
    const u = k / rings;
    const r = w * (C.bottom + (C.top - C.bottom) * u);
    const band = new THREE.CylinderGeometry(r * 1.14, r * 1.14, C.ringH, C.seg, 1, false);
    band.translate(0, len * u, 0);
    g.push(band);
  }

  /* стилобат, ступень и воротник у корпуса */
  const disc = (r0, r1, hh, y, seg = 20) => {
    const c = new THREE.CylinderGeometry(r0, r1, hh, seg, 1, false);
    c.translate(0, y + hh / 2, 0);
    return c;
  };
  g.push(disc(B, B * 1.06, 1.4, -0.7));
  g.push(disc(B * 0.78, B * 0.94, 1.1, 0.7));
  g.push(disc(w * C.bottom * 1.6, B * 0.74, 4.2, 1.8));

  /* седло: хомут, которым колонна садится на спину станции */
  const sd = CONFIG.AXIS.saddle;
  const yoke = new THREE.CylinderGeometry(sd.r, sd.r, sd.w, 16, 1, true);
  yoke.rotateZ(Math.PI / 2);
  yoke.translate(0, len - sd.r * 0.2, 0);
  g.push(yoke);
  for (const sx of [-1, 1]) {
    const cheek = new THREE.BoxGeometry(sd.w * 0.22, sd.r * 1.7, sd.r * 2.1);
    cheek.translate(sx * sd.w * 0.42, len - sd.r * 0.9, 0);
    g.push(cheek);
  }

  /* контрфорсы у основания */
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * TAU + 0.26;
    const fin = new THREE.BoxGeometry(0.7, 5.6, 1.5);
    fin.rotateZ(0.44);
    fin.translate(B * 0.62, 2.6, 0);
    fin.rotateY(a);
    g.push(fin);
  }
  return mergeGeos(g);
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
function buildEndCaps(group, renderer, low, normals) {
  const R = CONFIG.R, HL = CONFIG.L / 2;
  const { map, emis, canvas } = makeEndCapTexture(low ? 512 : 1024, mulberry32(CONFIG.SEED + 99));
  map.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  /* Рельеф торца берётся из его же рисунка — как у корпуса и фасадов */
  const nrm = normals ? heightToNormal(canvas, CONFIG.NORMALS.endcap, 1024) : null;

  /* Оба торца — одна геометрия и один материал на двоих. Раньше на каждый
     заводились свои: четыре вызова отрисовки и три лишних материала там,
     где хватает двух инстансов. */
  const E = CONFIG.ENDCAP;

  /* Ступенчатая воронка: кольцевые уступы уходят вглубь к ступице. Плоский
     диск выдавал себя сразу — вся глубина была нарисована. */
  const prof = [];
  for (let k = 0; k <= E.rings; k++) {
    const u = k / E.rings;
    const r = R * (1 - u);
    const depth = E.depth * Math.pow(u, E.curve);
    prof.push(new THREE.Vector2(Math.max(0.6, r), depth));
    if (k < E.rings) prof.push(new THREE.Vector2(Math.max(0.6, r - R / E.rings * E.step), depth));
  }
  const cap = new THREE.LatheGeometry(prof, 72);
  cap.rotateX(-Math.PI / 2);
  /* UV вдоль радиуса: текстура нарисована кольцами от края к ступице */
  {
    const pos = cap.attributes.position, uv = cap.attributes.uv;
    for (let k = 0; k < pos.count; k++) {
      const rr = Math.hypot(pos.getX(k), pos.getY(k)) / R;
      const ang = Math.atan2(pos.getY(k), pos.getX(k));
      uv.setXY(k, 0.5 + Math.cos(ang) * rr * 0.5, 0.5 + Math.sin(ang) * rr * 0.5);
    }
    uv.needsUpdate = true;
  }
  cap.computeVertexNormals();

  const capMat = new THREE.MeshStandardMaterial({
    map, emissiveMap: emis, emissive: 0xffffff, emissiveIntensity: 0,
    normalMap: nrm, normalScale: new THREE.Vector2(1, 1),
    side: THREE.DoubleSide, roughness: 0.85, metalness: 0.12
  });
  structMats.glass.push(capMat);

  /* ступица со спицами — тоже одна геометрия на оба торца */
  const hubParts = [];
  const hub = new THREE.CylinderGeometry(4.6, 4.6, 18, 18, 1, false);
  hub.rotateX(Math.PI / 2);
  hubParts.push(hub);
  /* Спица идёт от ступицы ДО СТЕНКИ и заходит в неё: прежняя кончалась в
     трёх юнитах от корпуса и висела в воздухе. Длина считается от радиуса
     ступицы до радиуса цилиндра с заходом, а не подбирается числом. */
  const hubR = 4.6, bite = CONFIG.ENDCAP.spokeBite;
  const spokeLen = R + bite - hubR;
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * TAU + 0.26;
    const spoke = new THREE.BoxGeometry(1.7, 1.2, spokeLen);
    spoke.rotateX(Math.PI / 2);
    spoke.translate(0, hubR + spokeLen / 2, 0);
    spoke.rotateZ(-a);
    hubParts.push(spoke);
  }
  const hubGeo = panelUV(mergeGeos(hubParts), CONFIG.PANEL_TILE);
  const hubMat = new THREE.MeshStandardMaterial({
    color: 0xa7b0ba, roughness: 0.45, metalness: 0.55
  });

  /* по два инстанса на каждую геометрию: у −z воронка развёрнута */
  const twin = (geo, mat, flipZ) => {
    const im = new THREE.InstancedMesh(geo, mat, 2);
    const m = new THREE.Matrix4();
    [-1, 1].forEach((sign, k) => {
      m.identity();
      if (flipZ) m.makeScale(1, 1, -sign);
      m.setPosition(0, 0, sign * (flipZ ? HL : HL - E.depth));
      im.setMatrixAt(k, m);
    });
    im.instanceMatrix.needsUpdate = true;
    im.frustumCulled = false;
    group.add(im); parts.push(im);
  };
  twin(cap, capMat, true);
  twin(hubGeo, hubMat, false);
}

/* ═══════════════════════════════════════════════════════════════════════════
   ПУБЛИЧНОЕ API
   ═══════════════════════════════════════════════════════════════════════════ */
export function buildStructures(group, renderer, quality, panel, panelNormal) {
  disposeStructures(group);
  buildAxis(group, panel, panelNormal);
  buildTower(group, panel, panelNormal);
  buildEndCaps(group, renderer, quality === 'LOW',
    (CONFIG.QUALITY[quality] || CONFIG.QUALITY.HIGH).normals);
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
    lifts.lamp.setMatrixAt(k, _m);
    lifts.glass.setMatrixAt(k, _m);
  }
  lifts.body.instanceMatrix.needsUpdate = true;
  lifts.lamp.instanceMatrix.needsUpdate = true;
  lifts.glass.instanceMatrix.needsUpdate = true;
}


/* ═══════════════════════════════════════════════════════════════════════════
   ПОЕЗДКА НА МОНОРЕЛЬСЕ
   ═══════════════════════════════════════════════════════════════════════════ */
/** Положение кабины k в системе станции: точка и направление движения */
export function liftSeat(k, outPos, outDir) {
  if (!lifts) return false;
  const i = k % lifts.z.length;
  const a = lifts.ang[i];
  outPos.set(Math.sin(a) * lifts.r, Math.cos(a) * lifts.r, lifts.z[i]);
  outDir.set(0, 0, lifts.dir[i]);
  return true;
}
export const liftCount2 = () => (lifts ? lifts.z.length : 0);

/** Изнутри стекло прозрачное, снаружи — светящееся */
/** Изнутри стекло убирается совсем: любая остаточная непрозрачность даёт
    тонировку, а пассажир должен видеть цилиндр без цветного фильтра.
    Снаружи оно на месте и светится. */
export function setLiftInside(inside) {
  const m = structMats.liftGlass;
  if (m) { m.opacity = inside ? 0 : 1; m.depthWrite = !inside; }
  if (lifts && lifts.glass) lifts.glass.visible = !inside;
}
