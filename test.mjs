/* Самопроверка проекта. Запуск:  npm i -D three && node test.mjs
   Проверяет то, что молча ломается: инъекции в шейдер, согласование
   углов ферм с тенями, границы сборки мира. */
import './test/dom-stub.mjs';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { CONFIG } from './js/config.js';
import { D2R, TAU, zoneAt, mulberry32, surfacePos, mergeGeos, rod } from './js/util.js';
import { buildWorld, worldMats, hullU, uvSelfTest } from './js/world.js';
import { buildStructures, structMats, updateStructures } from './js/structures.js';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  ok  ' : '  FAIL') + '  ' + m); if (!c) fails++; };
const fakeRenderer = { capabilities: { getMaxAnisotropy: () => 8 } };

/* ══ 1. Инъекции в шейдер корпуса реально попали в цель ══════════════════ */
{
  const group = new THREE.Group();
  const res = buildWorld(group, fakeRenderer, 'LOW');
  const hull = group.children.find(o => o.material?.side === THREE.BackSide);
  ok(!!hull, 'Корпус собран');

  const lib = THREE.ShaderLib.physical;
  const shader = { uniforms: {}, vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader };
  hull.material.onBeforeCompile(shader, fakeRenderer);

  const V = shader.vertexShader, F = shader.fragmentShader;
  ok(V.includes('vTh = atan( position.x, position.y )'), 'Вершинный: θ объекта прокинут во фрагментный');
  ok(F.includes('hullMask = texture2D( uMask'), 'Фрагментный: маска биомов подключена');
  ok(F.includes('uDetailRep'), 'Фрагментный: детальный шум подключён');
  ok(F.includes('roughnessFactor = mix( roughnessFactor, 0.055'), 'Фрагментный: вода зеркальна');
  ok(F.includes('normal = normalize( normal + vec3( r1'), 'Фрагментный: рябь возмущает нормаль');
  ok(F.includes('uSparShade * zt *'), 'Фрагментный: тень фермы считается');
  ok(F.includes('totalEmissiveRadiance += uCityGlow'), 'Фрагментный: ночное свечение улиц подключено');
  ok(F.indexOf('totalEmissiveRadiance += uCityGlow') > F.indexOf('hullMask = texture2D'),
     'Порядок: свечение улиц после чтения маски');

  /* инъекции обязаны стоять ПОСЛЕ своих include, иначе переменных ещё нет */
  ok(F.indexOf('hullMask = texture2D') > F.indexOf('#include <map_fragment>'),
     'Порядок: маска читается после map_fragment');
  ok(F.indexOf('roughnessFactor = mix( roughnessFactor, 0.055') > F.indexOf('hullMask = texture2D'),
     'Порядок: шероховатость воды после чтения маски');

  /* всё, на что опираемся, действительно объявлено в чанках three */
  const resolved = F.replace(/#include <(\w+)>/g, (_, n) => THREE.ShaderChunk[n] ?? '');
  ok(resolved.includes('vMapUv'), 'vMapUv объявлен three (мы им сэмплируем маску)');
  ok(resolved.includes('#define PI'), 'PI объявлен three (используется в развороте угла)');

  /* размеры массивов uniform совпадают с CONFIG */
  ok(F.includes(`uniform float uArm[${CONFIG.AXIS.sparArms}]`), 'Размер uArm[] равен числу трусов');
  ok(F.includes(`uniform float uSparZ[${CONFIG.AXIS.spars.length}]`), 'Размер uSparZ[] равен числу узлов');

  /* --- ветер в кронах --- */
  const crown = group.children.find(o => o.material?.flatShading && o.isInstancedMesh && o.count > 500);
  const ws = { uniforms: {}, vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader };
  crown.material.onBeforeCompile(ws, fakeRenderer);
  ok(ws.vertexShader.includes('transformed.x += sway * amp'), 'Ветер: вершины кроны качаются');
  ok(ws.vertexShader.includes('#ifdef USE_INSTANCING'), 'Ветер: под защитой USE_INSTANCING (WebGL1 не падает)');

  /* --- бюджет отрисовки и заполненность --- */
  buildStructures(group, fakeRenderer, 'LOW', res.panel);
  let draws = 0, emptyInst = 0;
  group.traverse(o => {
    if (o.isMesh || o.isPoints) draws++;
    if (o.isInstancedMesh && o.count === 0) emptyInst++;
  });
  ok(draws <= 30, `Бюджет отрисовки: ${draws} вызовов (лимит 30)`);
  ok(emptyInst === 0, 'Ни один InstancedMesh не пустой');

  /* --- контактные тени: по одной на дерево, куст и здание --- */
  const blob = group.children.find(o => o.material === worldMats.blob);
  const counts = group.children.filter(o => o.isInstancedMesh).map(o => o.count);
  ok(blob && blob.count > 0 && blob.count <= Math.max(...counts) * 6,
     `Контактные тени: ${blob?.count} пятен`);
}

/* ══ 2. Углы теней ферм совпадают с реальными углами трусов ═════════════ */
{
  const arms = hullU.uArm.value;
  ok(arms.length === CONFIG.AXIS.sparArms, 'Углов теней столько же, сколько трусов');
  let worst = 0;
  for (let k = 0; k < CONFIG.AXIS.sparArms; k++) {
    const want = (CONFIG.AXIS.sparAngle + k * 360 / CONFIG.AXIS.sparArms) * D2R;
    let d = Math.abs(((arms[k] - want + Math.PI) % TAU + TAU) % TAU - Math.PI);
    worst = Math.max(worst, d);
  }
  ok(worst < 1e-9, 'Тень каждой фермы ложится ровно на её угол (свет — линия на оси)');
  ok(JSON.stringify(hullU.uSparZ.value) === JSON.stringify(CONFIG.AXIS.spars),
     'Локализация тени по z совпадает с узлами ферм');
}

/* ══ 3. Ферма дотягивается от оси до корпуса, лифт не вылезает ══════════ */
{
  const group = new THREE.Group();
  buildStructures(group, fakeRenderer, 'LOW', null);

  const insts = [];
  group.traverse(o => { if (o.isInstancedMesh) insts.push(o); });
  const arms = insts.find(o => o.count === CONFIG.AXIS.spars.length * CONFIG.AXIS.sparArms);
  ok(!!arms, `Ферм ровно ${CONFIG.AXIS.spars.length * CONFIG.AXIS.sparArms} (узлы × трусы)`);

  /* проверяем габарит одного труса в мировых координатах */
  const m = new THREE.Matrix4();
  arms.setMatrixAt !== undefined && arms.getMatrixAt(0, m);
  arms.geometry.computeBoundingBox();
  const bb = arms.geometry.boundingBox;
  let rMin = 1e9, rMax = 0;
  for (const y of [bb.min.y, bb.max.y]) for (const x of [bb.min.x, bb.max.x]) {
    const p = new THREE.Vector3(x, y, 0).applyMatrix4(m);
    const r = Math.hypot(p.x, p.y);
    rMin = Math.min(rMin, r); rMax = Math.max(rMax, r);
  }
  ok(rMax > CONFIG.R - 3 && rMax <= CONFIG.R,
     `Ферма упирается в корпус (внешний r=${rMax.toFixed(1)} при R=${CONFIG.R})`);
  ok(rMin < CONFIG.AXIS.spineR + 6 && rMin > CONFIG.SUN.r,
     `Ферма приходит к оси, не протыкая светящуюся трубу (внутренний r=${rMin.toFixed(1)})`);

  /* лифт: 10 минут хода — остаётся на рельсе и внутри станции */
  const lift = insts.find(o => o.count === 2);
  ok(!!lift, `Кабин осевого лифта: ${CONFIG.AXIS.railAngles.length}, по одной на монорельс`);
  let outside = 0, wrongR = 0;
  const v = new THREE.Vector3();
  for (let step = 0; step < 3000; step++) {
    updateStructures(0.2);
    for (let k = 0; k < 2; k++) {
      lift.getMatrixAt(k, m);
      v.setFromMatrixPosition(m);
      if (Math.abs(v.z) > CONFIG.L / 2 - 15) outside++;
      if (Math.abs(Math.hypot(v.x, v.y) - (CONFIG.AXIS.spineR + 5.4)) > 0.01) wrongR++;
    }
  }
  ok(outside === 0, 'Лифт разворачивается у торцов, за станцию не уходит');
  ok(wrongR === 0, 'Лифт держится радиуса монорельса');

  /* встречные кабины ходят по разным рельсам и не проходят друг сквозь друга */
  const a1 = new THREE.Vector3(), a2 = new THREE.Vector3();
  let collide = 0, minGap = 1e9;
  for (let step = 0; step < 4000; step++) {
    updateStructures(0.15);
    for (let x = 0; x < 2; x++) for (let y = x + 1; y < 2 + 1 && y < 2; y++) {
      lift.getMatrixAt(x, m); a1.setFromMatrixPosition(m);
      lift.getMatrixAt(y, m); a2.setFromMatrixPosition(m);
      const d = a1.distanceTo(a2);
      minGap = Math.min(minGap, d);
      if (d < 4) collide++;
    }
  }
  ok(collide === 0, `Встречные кабины не сходятся ближе ${minGap.toFixed(1)} юнитов`);

  /* кабина не задевает фермы: угловой зазор на её радиусе */
  const carR = CONFIG.AXIS.spineR + 5.4;
  const nearest = Math.min(...Array.from({ length: CONFIG.AXIS.sparArms }, (_, k) => {
    const a = (CONFIG.AXIS.sparAngle + k * 360 / CONFIG.AXIS.sparArms) * D2R;
    return Math.abs(((a + Math.PI) % TAU + TAU) % TAU - Math.PI);
  }));
  const gap = nearest * carR - CONFIG.AXIS.trussW / 2 - 1.45;
  ok(gap > 0, `Кабина проходит между фермами, зазор ${gap.toFixed(2)} юнита`);

  ok(structMats.glass.length >= 3, 'Стёкла башни и торцов управляются палитрой');
  ok(!!structMats.sun && !!structMats.beacon, 'Солнечная труба и маяк доступны палитре');
}

/* ══ 3b. Город не прорастает сам сквозь себя ═══════════════════════════ */
{
  const group = new THREE.Group();
  buildWorld(group, fakeRenderer, 'HIGH');
  const insts = group.children.filter(o => o.isInstancedMesh);

  /* собираем габариты всего городского: 4 типа зданий + эстакады */
  const boxes = [];
  const m = new THREE.Matrix4(), p = new THREE.Vector3(), s = new THREE.Vector3(), qq = new THREE.Quaternion();
  for (const im of insts) {
    if (!im.material.map) continue;                   // отсекаем зелень: у неё нет карты
    im.geometry.computeBoundingBox();
    const bb = im.geometry.boundingBox;
    if (Math.abs(bb.min.y + 0.5) > 1e-6) continue;    // силуэты города стоят базой на −0.5
    for (let k = 0; k < im.count; k++) {
      im.getMatrixAt(k, m); m.decompose(p, qq, s);
      /* габарит в системе (дуга, z): развороты кратны 90°, оси совпадают */
      const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(qq);
      const along = Math.abs(dir.z) > 0.7;
      boxes.push([Math.atan2(p.x, p.y), p.z,
        (along ? s.x : s.z) * 0.5, (along ? s.z : s.x) * 0.5]);
    }
  }
  ok(boxes.length > 100, `Городских объектов в проверке: ${boxes.length}`);

  const gap = (a, b) => Math.abs(((a - b + Math.PI) % TAU + TAU) % TAU - Math.PI);
  /* прямоугольники, а не круги: эстакада длинная и тонкая */
  let overlaps = 0;
  for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) {
    const dx = gap(boxes[a][0], boxes[b][0]) * CONFIG.R, dz = Math.abs(boxes[a][1] - boxes[b][1]);
    if (dx < (boxes[a][2] + boxes[b][2]) * 0.8 && dz < (boxes[a][3] + boxes[b][3]) * 0.8) overlaps++;
  }
  ok(overlaps === 0,
     `Здания и эстакады не прорастают друг сквозь друга (пересечений ${overlaps} на ${boxes.length})`);

  /* крыши переведены в кровельную полосу текстуры, а не оклеены окнами */
  const bld = insts.find(o => o.material?.emissiveMap);
  const uv = bld.geometry.attributes.uv, nn = bld.geometry.attributes.normal;
  let flat = 0, inBand = 0;
  for (let k = 0; k < uv.count; k++) {
    if (Math.abs(nn.getY(k)) < 0.9) continue;
    flat++;
    if (uv.getY(k) >= 0.87) inBand++;
  }
  ok(flat > 0 && flat === inBand,
     `Все ${flat} горизонтальных вершин смотрят в кровельную полосу, не в окна`);

}

/* ══ 3e. Каналы маски корпуса не смешиваются ═══════════════════════════ */
{
  /* R = вода, G = растительность, B = покрытие. Смешанный цвет вроде #3366ff
     подмешивал 20% воды в каждую городскую площадь: асфальт бликовал днём,
     а ночью весь сектор заливало кремовым. */
  const src = readFileSync(new URL('./js/textures.js', import.meta.url), 'utf8');
  const fills = [...src.matchAll(/[ms]\.(?:fill|stroke)Style = '(#[0-9a-f]{6})'/g)].map(x => x[1]);
  const maskFills = [...src.matchAll(/\bm\.(?:fill|stroke)Style = '(#[0-9a-f]{6})'/g)].map(x => x[1]);
  /* Важно не «полная яркость», а отсутствие протечки: в заливке маски
     допустим ровно один ненулевой канал любой силы. */
  const channels = c => [c.slice(1, 3), c.slice(3, 5), c.slice(5, 7)]
    .map(x => parseInt(x, 16)).filter(x => x > 0).length;
  const dirty = maskFills.filter(c => channels(c) > 1);
  ok(maskFills.length > 0, `Заливок маски найдено: ${maskFills.length}`);
  ok(dirty.length === 0, `Каналы маски не протекают друг в друга (смешанных: ${dirty.join(', ') || 'нет'})`);
  ok(fills.length >= maskFills.length, 'Разбор исходника нашёл и остальные заливки');
}

/* ══ 3c. Холмы — рельеф, а не блямба ═══════════════════════════════════ */
{
  const group = new THREE.Group();
  buildWorld(group, fakeRenderer, 'HIGH');
  const insts = group.children.filter(o => o.isInstancedMesh);
  const m = new THREE.Matrix4(), p = new THREE.Vector3(), s = new THREE.Vector3(), qq = new THREE.Quaternion();

  const hill = insts.find(o => o.count === CONFIG.COUNT.hills[0] || o.count <= CONFIG.COUNT.hills[0]);
  const hillMesh = insts.find(o => o.material?.flatShading && !o.material.map && o.count <= CONFIG.COUNT.hills[0]);
  ok(!!hillMesh, `Холмов поставлено: ${hillMesh?.count}`);
  ok(hillMesh.material.flatShading, 'Холм гранёный — в одном стиле с остальным миром');

  let maxR = 0, maxH = 0, tooSteep = 0;
  const hills = [];
  for (let k = 0; k < hillMesh.count; k++) {
    hillMesh.getMatrixAt(k, m); m.decompose(p, qq, s);
    maxR = Math.max(maxR, s.x); maxH = Math.max(maxH, s.y);
    if (s.y / s.x > CONFIG.HILL.rise[1] + 1e-6) tooSteep++;
    hills.push([Math.atan2(p.x, p.y), p.z, s.x, s.y]);
  }
  ok(maxR <= CONFIG.HILL.r[1] + 1e-6, `Самый широкий холм ${maxR.toFixed(1)} юнитов = ${(maxR * 10) | 0} м в радиусе`);
  ok(maxH < 4, `Самый высокий подъём ${maxH.toFixed(1)} юнитов = ${(maxH * 10) | 0} м — возвышенность, не купол`);
  ok(tooSteep === 0, 'Ни один холм не круче заданного уклона');

  /* холм не должен садиться на застройку */
  const gap = (a, b) => Math.abs(((a - b + Math.PI) % TAU + TAU) % TAU - Math.PI);
  const city = [];
  for (const im of insts) {
    if (!im.material.map) continue;
    im.geometry.computeBoundingBox();
    if (Math.abs(im.geometry.boundingBox.min.y + 0.5) > 1e-6) continue;
    for (let k = 0; k < im.count; k++) {
      im.getMatrixAt(k, m); m.decompose(p, qq, s);
      city.push([Math.atan2(p.x, p.y), p.z, Math.max(s.x, s.z) * 0.5]);
    }
  }
  let swallowed = 0;
  for (const [ht, hz, hr] of hills) for (const [ct, cz, cr] of city) {
    if (Math.hypot(gap(ht, ct) * CONFIG.R, hz - cz) < hr * 0.6) swallowed++;
  }
  ok(swallowed === 0, `Холмы не наезжают на застройку (проглоченных зданий ${swallowed})`);

  /* дерево на склоне должно стоять НА земле: сравниваем с профилем купола */
  const trunks = insts.find(o => !o.material.map && !o.material.flatShading && o.count > 300);
  const reliefAt = (t, z) => {
    let up = 0;
    for (const [ht, hz, hr, hh] of hills) {
      const d = Math.hypot(gap(t, ht) * CONFIG.R, z - hz);
      if (d < hr) up = Math.max(up, hh * Math.sqrt(1 - (d / hr) ** 2));
    }
    return up;
  };
  let onSlope = 0, buried = 0;
  for (let k = 0; k < trunks.count; k++) {
    trunks.getMatrixAt(k, m); m.decompose(p, qq, s);
    const t = Math.atan2(p.x, p.y), r = Math.hypot(p.x, p.y);
    const up = reliefAt(t, p.z);
    if (up < 0.05) continue;
    onSlope++;
    /* центр ствола обязан быть на полвысоты выше поверхности холма */
    if (Math.abs((CONFIG.R - up - s.y / 2) - r) > 0.02) buried++;
  }
  ok(onSlope > 0, `Деревьев на склонах холмов: ${onSlope}`);
  ok(buried === 0, 'Все они стоят на склоне, а не утоплены в холм');
}

/* ══ 3d. Зерно генерации ════════════════════════════════════════════════ */
{
  ok(CONFIG.SEED === CONFIG.SEED_DEFAULT, 'По умолчанию используется заводское зерно');

  const shot = q => {
    const g = new THREE.Group();
    buildWorld(g, fakeRenderer, q);
    const im = g.children.find(o => o.isInstancedMesh && o.material.emissiveMap);
    const m = new THREE.Matrix4(), out = [];
    for (let k = 0; k < im.count; k++) { im.getMatrixAt(k, m); out.push(m.elements[12].toFixed(4)); }
    return out.join('|');
  };
  const a = shot('LOW'), b = shot('LOW');
  ok(a === b, 'Одно зерно — одинаковая планировка при каждой сборке');

  CONFIG.SEED = 987654321;
  const other = shot('LOW');
  ok(other !== a, 'Другое зерно — другая планировка');

  CONFIG.SEED = CONFIG.SEED_DEFAULT;
  ok(shot('LOW') === a, 'Возврат к заводскому зерну восстанавливает исходный мир');
}

/* ══ 3f. Плотность текселей одинакова на всех формах ═══════════════════ */
{
  const group = new THREE.Group();
  buildWorld(group, fakeRenderer, 'LOW');
  const bld = group.children.filter(o => o.isInstancedMesh && o.material?.emissiveMap);
  ok(bld.length === 4, 'Четыре типа зданий со своими фасадами');

  bld.forEach((im, v) => {
    ok(im.material.map.wrapS === THREE.RepeatWrapping && im.material.map.wrapT === THREE.RepeatWrapping,
       `Тип ${v}: фасад тайлится, а не растягивается один раз на всю деталь`);
  });

  /* Горизонтально: сколько метров стены приходится на единицу U. Должно
     совпадать у плоской стены, барабана и тонкого карниза одного здания. */
  const S = CONFIG.BLD, T = CONFIG.FACADE_TILE;
  let worstU = 0, edges = 0;
  bld.forEach((im, v) => {
    const W = (S[v].w[0] + S[v].w[1]) / 2;
    const g = im.geometry, p = g.attributes.position, uv = g.attributes.uv, n = g.attributes.normal;
    const ix = g.index;
    for (let k = 0; k < ix.count; k += 3) {
      const a = ix.getX(k), b = ix.getX(k + 1);
      if (Math.abs(n.getY(a)) > 0.9) continue;                       // кровля мапится отдельно
      if (Math.abs(p.getY(a) - p.getY(b)) > 1e-4) continue;          // берём горизонтальные рёбра
      const dw = Math.hypot(p.getX(a) - p.getX(b), p.getZ(a) - p.getZ(b)) * W;
      const du = Math.abs(uv.getX(a) - uv.getX(b));
      if (dw < 0.05 || du < 1e-4) continue;
      edges++;
      worstU = Math.max(worstU, Math.abs(dw / du / T - 1));
    }
  });
  ok(edges > 50, `Горизонтальных рёбер в проверке: ${edges}`);
  ok(worstU < 0.15, `Горизонтальная плотность ровная: худшее отклонение ${(worstU * 100) | 0}%`);

  /* Вертикально: текстура обязана ложиться ровно на высоту здания, иначе
     парапет из верхних процентов текстуры окажется не наверху стены. */
  let topV = 0, baseV = 9;
  bld.forEach(im => {
    const g = im.geometry, p = g.attributes.position, uv = g.attributes.uv, n = g.attributes.normal;
    for (let k = 0; k < p.count; k++) {
      if (Math.abs(n.getY(k)) > 0.9) continue;
      topV = Math.max(topV, uv.getY(k));
      baseV = Math.min(baseV, uv.getY(k));
    }
  });
  ok(Math.abs(baseV) < 0.01, 'Низ стены приходится на низ текстуры');
  ok(topV > 0.95 && topV < 1.25, `Верх стены попадает в полосу парапета (v = ${topV.toFixed(2)})`);
}

/* ══ 3f2. Этажность низкая, распределение по этажам ═════════════════════ */
{
  const F = CONFIG.FLOOR_H;
  for (const [v, s] of CONFIG.BLD.entries()) {
    ok(s.floors[1] <= 4 && s.floors[0] >= 1,
       `Тип ${v}: ${s.floors[0]}–${s.floors[1]} этажа = ${(s.floors[0] * F * 10).toFixed(1)}–${(s.floors[1] * F * 10).toFixed(1)} м`);
  }
  ok(F * 10 >= 3 && F * 10 <= 4, `Этаж ${(F * 10).toFixed(1)} м — жилая высота`);

  /* треугольное распределение: середина диапазона должна доминировать */
  const rnd = mulberry32(42);
  const hist = {};
  for (let k = 0; k < 60000; k++) {
    const mid = (rnd() + rnd()) / 2;
    const f = Math.round(1 + mid * 3);
    hist[f] = (hist[f] || 0) + 1;
  }
  const share = f => (hist[f] || 0) / 60000;
  ok(share(2) + share(3) > 0.8,
     `2–3 этажа выпадают в ${((share(2) + share(3)) * 100) | 0}% случаев`);
  ok(share(1) < 0.12 && share(4) < 0.12, 'Одноэтажные и четырёхэтажные — редкость');
  ok(!(5 in hist), 'Выше четырёх этажей не бывает');
}

/* ══ 3g. Ничего не торчит из холмов и конструкций ══════════════════════ */
{
  const group = new THREE.Group();
  buildWorld(group, fakeRenderer, 'HIGH');
  const insts = group.children.filter(o => o.isInstancedMesh);
  const m = new THREE.Matrix4(), p = new THREE.Vector3(), s = new THREE.Vector3(), qq = new THREE.Quaternion();
  const gap = (a, b) => Math.abs(((a - b + Math.PI) % TAU + TAU) % TAU - Math.PI);

  const all = [];
  for (const im of insts) {
    if (im.material.transparent) continue;                 // пятна теней не в счёт
    for (let k = 0; k < im.count; k++) {
      im.getMatrixAt(k, m); m.decompose(p, qq, s);
      const r = Math.hypot(p.x, p.y);
      all.push({ t: Math.atan2(p.x, p.y), z: p.z, r, top: CONFIG.R - r + s.y / 2,
                 half: Math.max(s.x, s.z) * 0.5 });
    }
  }

  /* пятки силовых ферм */
  const A = CONFIG.AXIS;
  let hitTruss = 0;
  for (const z of A.spars) for (let k = 0; k < A.sparArms; k++) {
    const ta = (A.sparAngle + k * 360 / A.sparArms) * D2R;
    for (const o of all) {
      if (o.top < 0.6) continue;
      if (Math.hypot(gap(o.t, ta) * CONFIG.R, o.z - z) < A.trussW / 2 + o.half) hitTruss++;
    }
  }
  ok(hitTruss === 0, `Ничего не растёт сквозь силовые фермы (нарушений ${hitTruss})`);

  /* спицы торцов идут в трёх метрах над землёй */
  let hitSpoke = 0;
  for (const sign of [-1, 1]) for (let k = 0; k < 6; k++) {
    const ta = (k / 6) * TAU + 0.26, zz = sign * (CONFIG.L / 2 - 8);
    for (const o of all) {
      if (o.top < 0.6) continue;
      if (Math.hypot(gap(o.t, ta) * CONFIG.R, o.z - zz) < 1.0 + o.half) hitSpoke++;
    }
  }
  ok(hitSpoke === 0, `Ничего не растёт сквозь спицы торцов (нарушений ${hitSpoke})`);

  /* холм не накрывает реку и не залезает в город */
  const hillMesh = insts.find(o => o.material?.flatShading && !o.material.map && o.count <= CONFIG.COUNT.hills[0]);
  let wetHill = 0, urbanHill = 0, offEnd = 0;
  for (let k = 0; k < hillMesh.count; k++) {
    hillMesh.getMatrixAt(k, m); m.decompose(p, qq, s);
    const t = Math.atan2(p.x, p.y), dt = s.x / CONFIG.R;
    for (const tt of [t - dt, t, t + dt]) {
      const zone = zoneAt(tt / D2R);
      if (zone === 'river') wetHill++;
      if (zone === 'city') urbanHill++;
    }
    if (Math.abs(p.z) + s.x > CONFIG.L / 2) offEnd++;
  }
  ok(wetHill === 0, `Ни один холм не выпирает в реку (нарушений ${wetHill})`);
  ok(urbanHill === 0, `Ни один холм не заезжает в город (нарушений ${urbanHill})`);
  ok(offEnd === 0, 'Ни один холм не вылезает за торец станции');

  /* ничего не упирается в торцевые диски */
  let pokeEnd = 0;
  for (const o of all) if (Math.abs(o.z) + o.half > CONFIG.L / 2 - 1) pokeEnd++;
  ok(pokeEnd === 0, `Ничего не протыкает торцевые диски (нарушений ${pokeEnd})`);
}

/* ══ 3h. PWA ставится и ничего не кеширует ═════════════════════════════ */
{
  const here = new URL('.', import.meta.url);
  const mf = JSON.parse(readFileSync(new URL('manifest.webmanifest', here), 'utf8'));
  ok(mf.display === 'standalone' && !!mf.name && !!mf.start_url, 'Манифест: имя, start_url, standalone');
  const sizes = mf.icons.map(i => i.sizes);
  ok(sizes.includes('192x192') && sizes.includes('512x512'), 'Иконки 192 и 512 объявлены');
  ok(mf.icons.some(i => i.purpose === 'maskable'), 'Есть maskable-иконка для Android');
  for (const ic of mf.icons) {
    const buf = readFileSync(new URL(ic.src, here));
    ok(buf.length > 500 && buf[1] === 0x50 && buf[2] === 0x4e, `Иконка ${ic.src} существует и это PNG`);
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    ok(`${w}x${h}` === ic.sizes, `Иконка ${ic.src} действительно ${ic.sizes}`);
  }

  const sw = readFileSync(new URL('sw.js', here), 'utf8');
  ok(/addEventListener\(\s*'fetch'/.test(sw), 'Worker имеет обработчик fetch — без него Chrome не предложит установку');
  const swCode = sw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok(!/caches|respondWith|CacheStorage/.test(swCode),
     'В коде worker нет ни кеша, ни перехвата — всё идёт из сети');

  const html = readFileSync(new URL('index.html', here), 'utf8');
  ok(html.includes('rel="manifest"'), 'Манифест подключён в разметке');
  ok(html.includes('apple-touch-icon'), 'Иконка для iOS указана');
}

/* ══ 4. Гравитация: крыши стоят там, где по ним можно ходить ════════════ */
{
  /* центробежная g на высоте h от пола: доля земной = (R − h) / R */
  const G = h => (CONFIG.R - h) / CONFIG.R;
  ok(Math.abs(G(0) - 1) < 1e-9, 'На полу ровно 1 g — это и есть проектная точка');

  /* мачты и надстройки торчат выше номинала — берём реальный габарит силуэта */
  const probe = new THREE.Group();
  buildWorld(probe, fakeRenderer, 'LOW');
  const silhouettes = probe.children.filter(o => o.isInstancedMesh && o.material.emissiveMap);
  let worstH = 0;
  silhouettes.forEach((im, v) => {
    im.geometry.computeBoundingBox();
    const top = (im.geometry.boundingBox.max.y + 0.5) * CONFIG.BLD[v].floors[1] * CONFIG.FLOOR_H;
    worstH = Math.max(worstH, top);
  });
  ok(G(worstH) >= CONFIG.G_MIN,
     `Самый высокий дом: ${(worstH * 10) | 0} м, крыша при ${G(worstH).toFixed(2)} g (порог ${CONFIG.G_MIN})`);
  ok(G(worstH) > 0.38, 'Крыша выше марсианской гравитации — жить и работать можно');

  /* верх остеклённого кабинета коммандора: 27.55 в чертёжных единицах башни */
  const officeTop = 27.55 * CONFIG.TOWER.h / CONFIG.TOWER.modelH;
  ok(G(officeTop) >= CONFIG.G_MIN,
     `Кабинет коммандора на ${officeTop.toFixed(1)} юнитах, ${G(officeTop).toFixed(2)} g`);
  ok(CONFIG.TOWER.h <= CONFIG.R * (1 - 0.38),
     'Даже мачта башни не заходит за марсианскую гравитацию');

  /* точка обзора «Кабинет коммандора» должна смотреть на сам кабинет */
  const office = CONFIG.TP.find(p => p.name.includes('коммандора'));
  ok(Math.abs((CONFIG.R - office.pos[1]) - officeTop) < 6,
     'Телепорт к кабинету стоит на высоте кабинета, а не в пустоте');
}

/* ══ 5. Ночь читается ═══════════════════════════════════════════════════ */
{
  const D = CONFIG.DAY, N = CONFIG.NIGHT;
  /* Свет считаем суммарно: осевых источников пять, судить по одному нельзя */
  const fill = p => p.hemiInt + p.pointInt * CONFIG.LIGHT_Z.length;
  const ratio = fill(N) / fill(D);
  ok(ratio > 0.12 && ratio < 0.40,
     `Ночь темнее дня: заполняющий свет ${(ratio * 100) | 0}% от дневного`);

  /* Источники стоят на оси: нормаль пола смотрит на них, стены домов — нет.
     Значит ночная полусфера обязана работать как рассеянный свет, иначе
     дома превращаются в чёрные силуэты с окнами. */
  const lum = hex => {
    const c = new THREE.Color(hex);
    return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  };
  const contrast = lum(N.hemiSky) / lum(N.hemiGround);
  ok(contrast < 1.8,
     `Ночная полусфера почти равномерна (контраст верх/низ ${contrast.toFixed(2)}) — стены домов освещены`);
  ok(lum(D.hemiSky) / lum(D.hemiGround) > 2,
     'Днём полусфера, наоборот, направленная — небо ярче земли');

  /* Эмиссия не освещается: ночью она обязана быть слабее отражённого света,
     иначе улицы светятся сами и красят пол в кремовый. */
  const src2 = readFileSync(new URL('./js/world.js', import.meta.url), 'utf8');
  ok(/smoothstep\(\s*0\.5,\s*0\.95,\s*hullMask\.b\s*\)/.test(src2),
     'Фонари зажигаются порогом по B: светятся магистрали, а не весь сектор');
  ok(N.cityGlow * 1.35 < fill(N) * 0.25,
     `Уличное свечение (${(N.cityGlow * 1.35).toFixed(2)}) слабее заполняющего света (${fill(N).toFixed(2)})`);
  ok(N.cityGlow > 0, 'Улицы ночью светятся сами: видно, где стоят огни');
  ok(N.navSize > D.navSize, 'Габаритные огни ночью крупнее');
  ok(N.sunEmis > 0.3, 'Солнечная труба ночью тлеет как ночник, а не гаснет');
  ok(N.fogD < 0.005, 'Туман ночью не съедает дальний план');
  for (const k of Object.keys(D)) ok(k in N, `Поле палитры «${k}» задано и для ночи`);
}

/* ══ 6. Базис, UV и слияние — регресс от первой версии ══════════════════ */
{
  const hull = new THREE.CylinderGeometry(CONFIG.R, CONFIG.R, CONFIG.L, CONFIG.HULL_SEG, 1, true);
  hull.rotateX(Math.PI / 2);
  ok(uvSelfTest(hull, true) && !uvSelfTest(hull, false),
     'Самотест UV: зеркало BackSide есть и снимается repeat.x = -1');

  const g = mergeGeos([rod(1, 2, 1, 0, 1, 0), rod(1, 2, 1, 3, 1, 0)]);
  let maxI = 0;
  for (let i = 0; i < g.index.count; i++) maxI = Math.max(maxI, g.index.getX(i));
  ok(maxI === g.attributes.position.count - 1, 'Слияние: индексы в границах буфера');

  const p = surfacePos(30 * D2R, CONFIG.R, 0);
  ok(Math.abs(Math.hypot(p.x, p.y) - CONFIG.R) < 1e-9, 'Расстановка: точка ровно на корпусе');
}

console.log(fails ? `\n${fails} проверок провалено` : '\nВсе проверки пройдены');
process.exit(fails ? 1 : 0);
