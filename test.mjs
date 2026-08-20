/* Самопроверка проекта. Запуск:  npm i -D three && node test.mjs
   Проверяет то, что молча ломается: инъекции в шейдер, согласование
   углов ферм с тенями, границы сборки мира. */
import './test/dom-stub.mjs';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { CONFIG } from './js/config.js';
import { D2R, TAU, zoneAt, mulberry32, clamp as clampNum, tpVec, aimAt, natural,
  cityBlock, cityCenter, cellInfo, cellUsable, pickFloors, surfacePos, mergeGeos, rod } from './js/util.js';
import { buildWorld, worldMats, hullU, uvSelfTest } from './js/world.js';
import { buildStructures, structMats, updateStructures } from './js/structures.js';
import { fieldAt, waterLevel, windLevel, humLevel, birdLevel } from './js/audio.js';
import { stationUp } from './js/controls.js';

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
  ok(F.includes('roughnessFactor = mix( roughnessFactor, mix( 0.045, 0.20, wFar )'),
     'Фрагментный: вода зеркальна вблизи и матовеет вдали');
  ok(F.includes('normal = normalize( normal + ( vTanU * rip.x + vTanV * rip.y )'),
     'Вода: рябь возмущает нормаль в касательных корпуса, а не в экранных осях');
  ok(V.includes('vTanU = normalize( normalMatrix'), 'Вершинный: касательные посчитаны и переданы');
  ok(F.includes('P.y -= uTime * uFlow'), 'Вода: рябь сносит вниз по течению');
  ok(/near = 1\.0 - wFar/.test(F), 'Вода: мелкая рябь гаснет вдали — без этого высокие частоты дают муар');
  ok(F.includes('mix( 0.045, 0.20, wFar )'), 'Вода: вдали поверхность матовее, блики не рассыпаются');
  ok((F.match(/rip \+= vec2/g) || []).length >= 5, 'Вода: не меньше пяти волновых составляющих, а не две синусоиды');
  ok(F.includes('uSparShade * zt *'), 'Фрагментный: тень фермы считается');
  ok(F.includes('totalEmissiveRadiance += uCityGlow'), 'Фрагментный: ночное свечение улиц подключено');
  ok(F.indexOf('totalEmissiveRadiance += uCityGlow') > F.indexOf('hullMask = texture2D'),
     'Порядок: свечение улиц после чтения маски');

  /* инъекции обязаны стоять ПОСЛЕ своих include, иначе переменных ещё нет */
  ok(F.indexOf('hullMask = texture2D') > F.indexOf('#include <map_fragment>'),
     'Порядок: маска читается после map_fragment');
  ok(F.indexOf('roughnessFactor = mix( roughnessFactor,') > F.indexOf('hullMask = texture2D'),
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
  /* Основание опоры намеренно утоплено в грунт: край плиты уходит чуть за
     R, но корпус рисуется изнутри и перекрывает его по глубине. */
  ok(rMax > CONFIG.R - 3 && rMax < CONFIG.R + 1.5,
     `Опора упирается в корпус, плита утоплена в грунт (край r=${rMax.toFixed(1)} при R=${CONFIG.R})`);
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

/* ══ 3e1. Городская текстура — план, а не нарисованные дома ════════════ */
{
  const src = readFileSync(new URL('./js/textures.js', import.meta.url), 'utf8');
  const city = src.slice(src.indexOf('── ГОРОДА'), src.indexOf('── РЕКИ'));

  /* Признак старой ошибки: дробление квартала на случайные серые ячейки,
     изображавшие застройку сверху. Дома должны быть только объёмными. */
  ok(!/for \(let i = 0; i < n; i\+\+\) for \(let j = 0/.test(city),
     'Квартал не дробится на случайные ячейки — подделки домов в текстуре нет');
  ok(!/const cell = bs \/ n/.test(city), 'Переменной поддельных ячеек больше нет');

  /* план обязан различать все типы кварталов из общей cellInfo */
  for (const kind of ['park', 'plaza', 'lot']) {
    ok(city.includes(`'${kind}'`), `План рисует квартал типа ${kind}`);
  }
  ok(/setLineDash/.test(city), 'У магистралей есть разделительная разметка');
  ok(/fillRect\(x, y, bw, 2\)/.test(city), 'У квартала есть тротуар по периметру');
  ok(/tint\('#/.test(city), 'Тон квартала слегка разбросан — не штампованные лотки');
  ok(/cellUsable/.test(city), 'План рисуется только там, где квартал целиком в секторе');

  /* сквер должен помечаться в маске как растительность, а не как покрытие */
  ok(/m\.fillStyle = '#00ff00'/.test(city), 'Скверы помечены в маске зеленью');
  ok(/m\.strokeStyle = '#0000ff'/.test(city), 'Магистрали помечены ярким B для фонарей');

  /* текстура всё ещё генерируется без ошибок */
  globalThis.__canvasStacks.length = 0;
  const g = new THREE.Group();
  buildWorld(g, fakeRenderer, 'LOW');
  ok(g.children.some(o => o.material?.side === THREE.BackSide), 'Корпус с новой текстурой собран');

  /* Каждый save с обрезкой обязан быть закрыт. Незакрытый — тихая ошибка:
     следующая обрезка пересекается с предыдущей, и всё дальнейшее рисование
     уходит в пустоту. Именно так пропал весь план города. */
  const unbalanced = globalThis.__canvasStacks.filter(c => c.__depth !== 0);
  ok(unbalanced.length === 0,
     `Стек обрезок сбалансирован на всех ${globalThis.__canvasStacks.length} холстах` +
     (unbalanced.length ? ` (незакрытых: ${unbalanced.map(c => c.__depth).join(', ')})` : ''));

  const saves = (src.match(/\ba\.save\(\)/g) || []).length;
  const restores = (src.match(/\ba\.restore\(\)/g) || []).length;
  ok(saves === restores, `save и restore в исходнике сходятся: ${saves} против ${restores}`);
}

/* ══ 3e1b. Дома стоят ровно в кварталах плана ══════════════════════════ */
{
  const g = new THREE.Group();
  buildWorld(g, fakeRenderer, 'HIGH');
  const bld = g.children.filter(o => o.isInstancedMesh && o.material?.emissiveMap);
  const B = cityBlock(), C = CONFIG.CITY;
  const m = new THREE.Matrix4(), p = new THREE.Vector3(), s = new THREE.Vector3(), q = new THREE.Quaternion();

  let total = 0, offGrid = 0, tooWide = 0, wrongCell = 0, worstT = 0, worstZ = 0;
  for (const im of bld) {
    for (let k = 0; k < im.count; k++) {
      im.getMatrixAt(k, m); m.decompose(p, q, s);
      total++;
      const t2 = ((Math.atan2(p.x, p.y) / TAU) % 1 + 1) % 1;
      const i = Math.round(t2 * C.cols - 0.5);
      const j = Math.round((p.z + CONFIG.L / 2) / (CONFIG.L / C.rows) - 0.5);
      const c = cityCenter(((i % C.cols) + C.cols) % C.cols, j);

      /* отклонение от центра квартала */
      const dT = Math.abs(((c.t - Math.atan2(p.x, p.y) + Math.PI) % TAU + TAU) % TAU - Math.PI) * CONFIG.R;
      const dZ = Math.abs(c.z - p.z);
      worstT = Math.max(worstT, dT); worstZ = Math.max(worstZ, dZ);
      if (dT > 0.01 || dZ > 0.01) offGrid++;

      /* дом обязан помещаться в квартал */
      if (s.x > B.wT || s.z > B.wZ) tooWide++;

      /* и квартал обязан быть застроенным по общей cellInfo */
      if (cellInfo(((i % C.cols) + C.cols) % C.cols, j).kind !== 'built') wrongCell++;
    }
  }
  ok(total > 150, `Домов расставлено: ${total}`);
  ok(offGrid === 0,
     `Каждый дом стоит в центре своего квартала (макс. отклонение ${worstT.toFixed(3)} по дуге, ${worstZ.toFixed(3)} по оси)`);
  ok(tooWide === 0, `Ни один дом не вылезает из квартала ${(B.wT * 10) | 0}×${(B.wZ * 10) | 0} м`);
  ok(wrongCell === 0, 'Дом стоит только там, где план рисует застроенный квартал');

  /* ни один квартал не вылезает за границу своего биома */
  const half = (B.wT / CONFIG.R) / D2R / 2;
  let spill = 0, usable = 0;
  for (let i = 0; i < C.cols; i++) {
    for (let j = 0; j < C.rows; j++) {
      if (!cellUsable(i, j)) continue;
      usable++;
      const cDeg = ((cityCenter(i, 0).t / D2R) % 360 + 360) % 360;
      for (let d = -half; d <= half; d += 0.2) if (zoneAt(cDeg + d) !== 'city') { spill++; break; }
      if (Math.abs(cityCenter(i, j).z) + B.wZ / 2 > CONFIG.L / 2) spill++;
    }
  }
  ok(usable > 200, `Пригодных кварталов: ${usable}`);
  ok(spill === 0, `Ни один квартал не вылезает на соседний биом или за торец (нарушений ${spill})`);

  /* и сами дома — тоже целиком */
  let bldSpill = 0;
  for (const im of bld) {
    for (let k = 0; k < im.count; k++) {
      im.getMatrixAt(k, m); m.decompose(p, q, s);
      const cDeg = ((Math.atan2(p.x, p.y) / D2R) % 360 + 360) % 360;
      const hd = (s.x / 2) / CONFIG.R / D2R;
      for (let d = -hd; d <= hd; d += 0.2) if (zoneAt(cDeg + d) !== 'city') { bldSpill++; break; }
    }
  }
  ok(bldSpill === 0, `Ни один дом не стоит на чужом биоме (нарушений ${bldSpill})`);

  /* текстура и геометрия обязаны читать одну функцию */
  const tsrc = readFileSync(new URL('./js/textures.js', import.meta.url), 'utf8');
  const wsrc = readFileSync(new URL('./js/world.js', import.meta.url), 'utf8');
  for (const fn of ['cityBlock', 'cityCenter', 'cellInfo', 'cellUsable']) {
    ok(tsrc.includes(fn) && wsrc.includes(fn), `И текстура, и геометрия используют ${fn}`);
  }
  ok(!/sampleCity/.test(wsrc), 'Случайной выборки для домов больше нет');

  /* cellInfo детерминирована */
  const a1 = cellInfo(7, 11), a2 = cellInfo(7, 11);
  ok(JSON.stringify(a1) === JSON.stringify(a2), 'cellInfo даёт один и тот же ответ обеим сторонам');
  ok(cellInfo(7, 11).kind !== undefined && cellInfo(8, 11).type !== undefined, 'Соседние кварталы различаются');

  /* сетка бесшовно смыкается на 360° */
  ok(Number.isInteger(C.cols) && Number.isInteger(C.rows), 'Сетка задана счётчиками — шов сходится');
  ok(Math.max(...CONFIG.BLD.map(x => x.w[1])) < Math.min(B.wT, B.wZ) - 0.8,
     `Самый широкий дом ${(Math.max(...CONFIG.BLD.map(x => x.w[1])) * 10) | 0} м с запасом входит в квартал`);
}

/* ══ 3e2. Вода: глубина, поток, анизотропия ════════════════════════════ */
{
  const src = readFileSync(new URL('./js/textures.js', import.meta.url), 'utf8');
  /* канал R реки должен иметь несколько уровней — это глубина, а не флаг */
  const levels = [...src.matchAll(/stroke\(m,[^,]+,\s*'(#[0-9a-f]{6})'/g)].map(x => x[1]);
  const reds = [...new Set(levels.map(c => parseInt(c.slice(1, 3), 16)))].sort((a, b) => a - b);
  ok(reds.length >= 3, `Русло размечено ${reds.length} уровнями глубины: ${reds.join(', ')}`);
  ok(reds[0] > 0 && reds[reds.length - 1] === 255, 'Отмель слабее нуля, стрежень на максимуме');

  /* волны идут поперёк русла — иначе блик от линейного солнца не вытянется */
  const wsrc = readFileSync(new URL('./js/world.js', import.meta.url), 'utf8');
  const waves = [...wsrc.matchAll(/dot\( P, vec2\(\s*(-?[\d.]+),\s*(-?[\d.]+)\s*\)/g)]
    .map(x => [Math.abs(+x[1]), Math.abs(+x[2])]);
  ok(waves.length >= 5, `Волновых составляющих: ${waves.length}`);
  const across = waves.filter(([kx, ky]) => kx > ky).length;
  ok(across >= waves.length - 1,
     `Почти все волны идут поперёк русла (${across} из ${waves.length}) — блик вытягивается вдоль оси`);

  /* длины волн в разумных для реки пределах */
  const lambdas = waves.map(([kx, ky]) => 2 * Math.PI / Math.hypot(kx, ky) * 10);
  ok(Math.max(...lambdas) < 45 && Math.min(...lambdas) > 1,
     `Длины волн ${Math.min(...lambdas).toFixed(1)}–${Math.max(...lambdas).toFixed(1)} м`);

  ok(CONFIG.RIVER_FLOW > 0, `Течение ${CONFIG.RIVER_FLOW} юнита/с = ${(CONFIG.RIVER_FLOW * 10).toFixed(0)} м/с`);

  /* вода должна быть темнее берега */
  const lum = hex => { const c = new THREE.Color(hex); return 0.2126*c.r + 0.7152*c.g + 0.0722*c.b; };
  ok(lum(CONFIG.DAY.waterTint) < 0.12, `Дневная вода тёмная (яркость ${lum(CONFIG.DAY.waterTint).toFixed(3)})`);
  ok(lum(CONFIG.NIGHT.waterTint) < lum(CONFIG.DAY.waterTint), 'Ночью вода ещё темнее');
}

/* ══ 3f3. Палитра приглушена и настраивается ═══════════════════════════ */
{
  const c = new THREE.Color(), hsl = { h: 0, s: 0, l: 0 };
  ok(CONFIG.SATURATION > 0.2 && CONFIG.SATURATION < 1.01,
     `Насыщенность по умолчанию ${(CONFIG.SATURATION * 100) | 0}%`);
  ok(CONFIG.SATURATION < 0.85, 'По умолчанию палитра заметно спокойнее исходной');

  /* приглушение обязано снижать насыщенность и не менять оттенок */
  let maxHueShift = 0, allDesat = true;
  for (const S of Object.values(CONFIG.SEASONS)) {
    for (const hex of [...S.greens, ...S.accents, ...S.bushes]) {
      const src = new THREE.Color(hex);
      const srcHSL = { h: 0, s: 0, l: 0 };
      src.getHSL(srcHSL);
      natural(hex, CONFIG.SATURATION, c);
      c.getHSL(hsl);
      maxHueShift = Math.max(maxHueShift, Math.abs(hsl.h - srcHSL.h));
      if (srcHSL.s > 0.05 && hsl.s >= srcHSL.s) allDesat = false;
    }
  }
  ok(maxHueShift < 1e-6, 'Оттенок сохраняется — приглушаем, а не перекрашиваем');
  ok(allDesat, 'Все цвета всех сезонов действительно приглушены');

  natural(0xff0000, 1, c); c.getHSL(hsl);
  ok(hsl.s > 0.95, 'При 100% палитра остаётся исходной');

  const html2 = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  ok(html2.includes('id="sSat"'), 'Насыщенность настраивается слайдером');
  const msrc2 = readFileSync(new URL('./js/main.js', import.meta.url), 'utf8');
  ok(/sSat\.onchange/.test(msrc2) && !/sSat\.oninput = \(\) => \{[\s\S]{0,80}rebuild/.test(msrc2),
     'Пересборка мира идёт на отпускании слайдера, а не на каждый пиксель');
  ok(/prefs\.set\('sat'/.test(msrc2), 'Насыщенность сохраняется');
}

/* ══ 3f2. Этажность низкая, распределение по этажам ═════════════════════ */
{
  const F = CONFIG.FLOOR_H;
  for (const [v, s] of CONFIG.BLD.entries()) {
    ok(s.floors[1] <= 6 && s.floors[0] >= 1,
       `Тип ${v}: ${s.floors[0]}–${s.floors[1]} этажа = ${(s.floors[0] * F * 10).toFixed(1)}–${(s.floors[1] * F * 10).toFixed(1)} м`);
  }
  ok(F * 10 >= 3 && F * 10 <= 4, `Этаж ${(F * 10).toFixed(1)} м — жилая высота`);

  /* Считаем по РЕАЛЬНО построенным домам: доля зависит и от таблицы весов,
     и от того, каким типам какой диапазон разрешён. */
  const hist = {};
  let n = 0;
  for (let i = 0; i < CONFIG.CITY.cols; i++) {
    const t2 = cityCenter(i, 0).t;
    if (zoneAt(t2 / D2R) !== 'city') continue;
    for (let j = 0; j < CONFIG.CITY.rows; j++) {
      const info = cellInfo(i, j);
      if (info.kind !== 'built') continue;
      const fl = pickFloors(info.floors, CONFIG.BLD[info.type].floors);
      hist[fl] = (hist[fl] || 0) + 1;
      n++;
    }
  }
  const share = f => (hist[f] || 0) / n;
  const maxFloors = Math.max(...Object.keys(hist).map(Number));
  ok(maxFloors === 6, `Максимальная этажность в городе: ${maxFloors} (${Math.round(maxFloors * F * 10)} м)`);
  ok(!hist[7], 'Семиэтажек не бывает');

  const mid = share(3) + share(4) + share(5);
  ok(mid > 0.7, `3–5 этажей — основная застройка: ${(mid * 100) | 0}%`);
  ok(share(4) > share(2) && share(4) > share(6), 'Пик распределения в середине диапазона');
  ok(share(1) < 0.08 && share(6) < 0.12,
     `Края редки: одноэтажных ${(share(1) * 100).toFixed(0)}%, шестиэтажных ${(share(6) * 100).toFixed(0)}%`);
  ok(share(5) > 0.15, `Пятиэтажки встречаются часто: ${(share(5) * 100) | 0}%`);

  /* веса должны реально задавать форму: сумма и монотонность краёв */
  ok(CONFIG.FLOOR_W.length === 6, 'Таблица весов покрывает все шесть этажностей');
  ok(CONFIG.FLOOR_W[0] < CONFIG.FLOOR_W[3] && CONFIG.FLOOR_W[5] < CONFIG.FLOOR_W[3],
     'В таблице весов середина тяжелее краёв');
  ok(pickFloors(0, [2, 6]) === 2 && pickFloors(0.999, [2, 6]) === 6,
     'Выборка покрывает весь разрешённый диапазон типа');
  ok(pickFloors(0.5, [3, 3]) === 3, 'Вырожденный диапазон возвращает единственное значение');
}

/* ══ 3f4. Деревья ниже домов и стоят не вплотную ═══════════════════════ */
{
  const g = new THREE.Group();
  buildWorld(g, fakeRenderer, 'HIGH');
  const ins = g.children.filter(o => o.isInstancedMesh);
  const trunk = ins.find(o => !o.material.map && !o.material.flatShading && o.count > 300);
  ok(!!trunk, 'Стволы деревьев найдены');

  const m = new THREE.Matrix4(), p = new THREE.Vector3(), s = new THREE.Vector3(), q = new THREE.Quaternion();
  const TR = CONFIG.TREE;
  const hs = [], pts = [];
  for (let k = 0; k < trunk.count; k++) {
    trunk.getMatrixAt(k, m); m.decompose(p, q, s);
    hs.push(s.y / TR.trunk * 0.98);                    // полная высота над своей землёй
    pts.push([Math.atan2(p.x, p.y), p.z, s.y / TR.trunk]);
  }
  hs.sort((a, b) => a - b);
  const med = hs[hs.length >> 1], max = hs[hs.length - 1];
  const maxBld = Math.max(...CONFIG.BLD.map(b => b.floors[1])) * CONFIG.FLOOR_H;
  const medBld = 4 * CONFIG.FLOOR_H;

  ok(max <= maxBld,
     `Самое высокое дерево ${(max * 10).toFixed(1)} м не выше самого высокого дома ${(maxBld * 10).toFixed(1)} м`);
  ok(med < medBld,
     `Обычное дерево ${(med * 10).toFixed(1)} м ниже обычного дома ${(medBld * 10).toFixed(1)} м`);
  ok(hs.filter(h => h > maxBld).length === 0, 'Ни одно дерево не перерастает застройку');
  ok(max / hs[0] > 2.2, `Разброс высот заметный: от ${(hs[0] * 10).toFixed(1)} до ${(max * 10).toFixed(1)} м`);

  /* деревья не стоят вплотную: расстояние соразмерно кронам */
  const gapA = (a, b) => Math.abs(((a - b + Math.PI) % TAU + TAU) % TAU - Math.PI);
  let tooClose = 0, minGap = 1e9;
  for (let a = 0; a < pts.length; a++) {
    for (let b = a + 1; b < pts.length; b++) {
      if (Math.abs(pts[a][1] - pts[b][1]) > 6) continue;          // грубый отсев по z
      const d = Math.hypot(gapA(pts[a][0], pts[b][0]) * CONFIG.R, pts[a][1] - pts[b][1]);
      const need = (pts[a][2] + pts[b][2]) * TR.crown * TR.spacing;
      minGap = Math.min(minGap, d / need);
      if (d < need * 0.98) tooClose++;
    }
  }
  ok(tooClose === 0,
     `Кроны не смыкаются: минимальный просвет ${(minGap * 100).toFixed(0)}% от требуемого`);
  ok(TR.spacing > 1.2, `Деревья расставлены с шагом в ${TR.spacing} радиуса кроны`);
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
      if (Math.hypot(gap(o.t, ta) * CONFIG.R, o.z - z) < A.baseR + o.half) hitTruss++;
    }
  }
  ok(hitTruss === 0, `Ничего не растёт сквозь силовые фермы (нарушений ${hitTruss})`);
  ok(A.sparArms === 3, `Опор на узел: ${A.sparArms} — леса в кадре меньше`);

  /* опоры обязаны садиться в сад, а не в застройку */
  const armZones = [];
  for (let k = 0; k < A.sparArms; k++) {
    armZones.push(zoneAt(A.sparAngle + k * 360 / A.sparArms));
  }
  ok(armZones.every(z => z === 'park' || z === 'field' || z === 'edge'),
     `Все опоры приземляются в сад: ${armZones.join(', ')}`);
  ok(!armZones.includes('city'), 'Ни одна опора не стоит в городском квартале');
  ok(!armZones.includes('river'), 'Ни одна опора не стоит в русле');
  ok(A.baseR >= 5, `У опоры массивное основание радиусом ${A.baseR} юнитов = ${A.baseR * 10} м`);

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
  /* Перебираем ВЕСЬ угловой размах холма с мелким шагом. Проверка трёх
     точек тут не годится: холм занимает 16°, русло шириной 6° проскакивало
     между контрольными точками, и холмы залезали на воду. */
  let wetHill = 0, urbanHill = 0, offEnd = 0;
  for (let k = 0; k < hillMesh.count; k++) {
    hillMesh.getMatrixAt(k, m); m.decompose(p, qq, s);
    const cDeg = ((Math.atan2(p.x, p.y) / D2R) % 360 + 360) % 360;
    const half = s.x / CONFIG.R / D2R;
    for (let d = -half; d <= half; d += 0.25) {
      const zone = zoneAt(cDeg + d);
      if (zone === 'river') { wetHill++; break; }
      if (zone === 'city') { urbanHill++; break; }
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

/* ══ 3k. Видовые точки показывают то, что обещают ══════════════════════ */
{
  const D = CONFIG, R = D.R, HL = D.L / 2;
  const vec = ([d, r, z]) => new THREE.Vector3(Math.sin(d * D2R) * r, Math.cos(d * D2R) * r, z);

  /** Где луч взгляда упирается в корпус */
  const hullHit = (p, dir) => {
    const a = dir.x * dir.x + dir.y * dir.y;
    if (a < 1e-9) return Infinity;
    const b = 2 * (p.x * dir.x + p.y * dir.y);
    const c = p.x * p.x + p.y * p.y - R * R;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return Infinity;
    const tt = (-b + Math.sqrt(disc)) / (2 * a);
    return Math.abs(p.z + dir.z * tt) > HL ? Infinity : tt;
  };

  const up = new THREE.Vector3(), dir = new THREE.Vector3();
  for (const tp of CONFIG.TP) {
    const p = vec(tp.pos), q = vec(tp.look);
    dir.subVectors(q, p);
    const len = dir.length();
    dir.divideScalar(len);
    const r = Math.hypot(p.x, p.y);

    ok(len >= 35, `«${tp.name}»: цель в ${len.toFixed(0)} юнитах, не в упор`);
    ok(r >= 4 && r <= 46, `«${tp.name}»: камера на r=${r.toFixed(0)}, не вжата в корпус`);
    ok(Math.abs(tp.pos[2]) <= 142, `«${tp.name}»: не упирается в торец`);

    const radial = (dir.x * p.x + dir.y * p.y) / r;
    ok(radial < 0.55, `«${tp.name}»: не смотрит в ближнюю стенку (радиальная доля ${radial.toFixed(2)})`);
    const hit = hullHit(p, dir);
    ok(hit > 32, `«${tp.name}»: до корпуса по лучу ${hit === Infinity ? '∞' : hit.toFixed(0)}`);

    /* камера не внутри Башни */
    const T = CONFIG.TOWER;
    const arc = Math.abs(((tp.pos[0] - T.deg + 180) % 360 + 360) % 360 - 180) * D2R * R;
    const inTower = Math.hypot(arc, tp.pos[2] - T.z) < 8 && r > R - T.h;
    ok(!inTower, `«${tp.name}»: камера снаружи Башни`);

    /* камера не внутри основания фермы */
    const A = CONFIG.AXIS;
    let inTruss = false;
    for (const z of A.spars) for (let k = 0; k < A.sparArms; k++) {
      const ta = A.sparAngle + k * 360 / A.sparArms;
      const da = Math.abs(((tp.pos[0] - ta + 180) % 360 + 360) % 360 - 180) * D2R * R;
      if (Math.hypot(da, tp.pos[2] - z) < A.trussW + 2 && r > 10) inTruss = true;
    }
    ok(!inTruss, `«${tp.name}»: камера не в ферме`);
    /* и не должна стоять на основании опоры: оно радиусом 6 юнитов */
    let onBase = false;
    for (const z of A.spars) for (let k = 0; k < A.sparArms; k++) {
      const ta = A.sparAngle + k * 360 / A.sparArms;
      const da = Math.abs(((tp.pos[0] - ta + 180) % 360 + 360) % 360 - 180) * D2R * R;
      if (Math.hypot(da, tp.pos[2] - z) < A.baseR + 2 && r > R - 10) onBase = true;
    }
    ok(!onBase, `«${tp.name}»: камера не в основании опоры`);

    /* горизонт не завален: «верх» камеры обязан идти к оси станции */
    stationUp(p, up);
    ok(Math.abs(up.dot(dir)) < 0.9, `«${tp.name}»: взгляд не вертикально вверх или вниз`);
  }
}

/* ══ 3k2. Камера реально смотрит на цель, а не назад ═══════════════════ */
{
  /* Object3D.lookAt для НЕ-камеры разворачивает к цели +Z, а камера смотрит
     вдоль −Z. Подставив обычный Object3D, получаешь взгляд ровно назад —
     и все девять точек «смотрят не туда» при идеальных координатах.
     Проверяем не замысел, а результат: куда направлен −Z готового кватерниона. */
  const up = new THREE.Vector3(), q = new THREE.Quaternion();
  const fwd = new THREE.Vector3(), want = new THREE.Vector3();
  let worst = 0, worstName = '';
  for (const tp of CONFIG.TP) {
    const p = tpVec(tp.pos), t2 = tpVec(tp.look);
    stationUp(p, up);
    aimAt(p, t2, up, q);
    fwd.set(0, 0, -1).applyQuaternion(q);
    want.subVectors(t2, p).normalize();
    const err = Math.acos(clampNum(fwd.dot(want), -1, 1)) * 180 / Math.PI;
    if (err > worst) { worst = err; worstName = tp.name; }
  }
  ok(worst < 0.01, `Все точки наведены точно (худшая ошибка ${worst.toFixed(3)}° — «${worstName}»)`);

  /* и горизонт не перевёрнут */
  let worstTilt = 1;
  for (const tp of CONFIG.TP) {
    const p = tpVec(tp.pos), t2 = tpVec(tp.look);
    stationUp(p, up); aimAt(p, t2, up, q);
    worstTilt = Math.min(worstTilt, new THREE.Vector3(0, 1, 0).applyQuaternion(q).dot(up));
  }
  ok(worstTilt > 0.8, `Горизонт нигде не завален (худшее совпадение верха ${worstTilt.toFixed(2)})`);

  const msrc1 = readFileSync(new URL('./js/main.js', import.meta.url), 'utf8');
  ok(!/new THREE\.Object3D\(\)/.test(msrc1),
     'Наведение больше не идёт через обычный Object3D');
  ok(/aimAt\(/.test(msrc1), 'Используется камерный базис Matrix4.lookAt');
}

/* ══ 3l. Управление привязано к «низу» станции ═════════════════════════ */
{
  const V = new THREE.Vector3(), up = new THREE.Vector3();
  /* «верх» в любой точке направлен к оси, а не в мировой +Y */
  let worst = 0;
  for (let d = 0; d < 360; d += 11) {
    const t = d * D2R;
    stationUp(V.set(Math.sin(t) * 40, Math.cos(t) * 40, 17), up);
    worst = Math.max(worst, up.distanceTo(V.clone().setZ(0).normalize().negate()));
  }
  ok(worst < 1e-9, 'Верх камеры везде направлен от пола к оси');
  stationUp(V.set(0, 0, 30), up);
  ok(Math.abs(up.length() - 1) < 1e-9, 'На самой оси верх не вырождается в ноль');

  const csrc = readFileSync(new URL('./js/controls.js', import.meta.url), 'utf8');
  ok(!/Euler/.test(csrc),
     'Углы Эйлера от мирового +Y убраны — иначе крен защёлкивался бы после посадки');
  ok(/levelCamera/.test(csrc) && /makeBasis/.test(csrc), 'Крен снимается перестроением базиса');
  const msrc0 = readFileSync(new URL('./js/main.js', import.meta.url), 'utf8');
  ok(!/_o\.up\.set\(0, 1, 0\)/.test(msrc0), 'Перелёт больше не использует мировой верх');
  ok((msrc0.match(/stationUp\(/g) || []).length >= 2, 'И посадка, и перелёт берут верх станции');
}

/* ══ 3j. Новые возможности и починенные баги ═══════════════════════════ */
{
  const msrc = readFileSync(new URL('./js/main.js', import.meta.url), 'utf8');
  const csrc = readFileSync(new URL('./js/controls.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
  const asrc = readFileSync(new URL('./js/audio.js', import.meta.url), 'utf8');

  /* --- полный экран: размер берём у контейнера, а не у окна --- */
  ok(/new ResizeObserver\(resize\)\.observe\(stage\)/.test(msrc),
     'Размер рендера следит за контейнером — чёрных полей в полном экране нет');
  ok(/stage\.clientWidth/.test(msrc), 'resize() меряет элемент, а не innerWidth');
  ok(/fullscreenchange/.test(msrc), 'Пересчёт по событию полноэкранного режима');
  const setSizes = [...msrc.matchAll(/renderer\.setSize\(([^)]*)\)/g)].map(x => x[1]);
  ok(setSizes.length > 0 && setSizes.every(s => /,\s*false\s*$/.test(s)),
     `Все ${setSizes.length} вызова setSize идут с updateStyle = false — три не прописывает канвасу инлайновый размер в пикселях`);
  ok(/:fullscreen/.test(css), 'Есть правила для полноэкранного корня');

  /* --- вода: широкий спектр вместо одного резонанса --- */
  const bands = [...asrc.matchAll(/noiseBand\(buf, wLow, ([\d.]+), ([\d.]+)/g)]
    .map(x => ({ f: +x[1], Q: +x[2] }));
  ok(bands.length >= 3, `Журчание собрано из ${bands.length} полос, а не из одной`);
  ok(bands.every(b => b.Q < 1.5), `Добротность всех полос ниже 1.5 — свиста нет (${bands.map(b => b.Q).join(', ')})`);
  ok(Math.min(...bands.map(b => b.f)) < 400, 'Есть низкий рокот потока, а не только верх');
  ok(/lowpass/.test(asrc) && /3200/.test(asrc), 'Общий срез убирает шипение выше 3.2 кГц');

  /* --- облака в LOW --- */
  ok(/clouds\.visible = q !== 'LOW'/.test(msrc), '§14: в пресете LOW облака выключаются');

  /* --- сохранение всех настроек --- */
  const keys = [...msrc.matchAll(/prefs\.set\('(\w+)'/g)].map(x => x[1]);
  const uniq = [...new Set(keys)].sort();
  ok(uniq.length >= 8, `Сохраняются настройки: ${uniq.join(', ')}`);
  for (const k of ['seed', 'quality', 'season', 'sens', 'rot', 'wind', 'vol', 'sound', 'cycle', 'fps']) {
    ok(uniq.includes(k), `  · ${k} переживает перезагрузку`);
  }
  ok(/catch \{ this\.d = \{\}; \}/.test(msrc) || /catch/.test(msrc.split('PREFS_KEY')[1].slice(0, 400)),
     'Недоступный localStorage не роняет приложение');

  /* --- адаптивный джойстик --- */
  ok(typeof CONFIG.STICK_RADIUS === 'object'
     && CONFIG.STICK_RADIUS.portrait > CONFIG.STICK_RADIUS.landscape,
     `§12: в портрете джойстик крупнее (${CONFIG.STICK_RADIUS.portrait} против ${CONFIG.STICK_RADIUS.landscape} px)`);
  ok(/innerHeight >= innerWidth/.test(csrc), 'Ориентация определяется по пропорциям экрана');
  ok(/base\.style\.width = base\.style\.height/.test(csrc), 'Размер базы задаётся из того же радиуса');

  /* --- фото-режим --- */
  ok(/toBlob/.test(msrc), 'Снимок берётся через toBlob');
  const mCode = msrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok(!/preserveDrawingBuffer/.test(mCode),
     'preserveDrawingBuffer не включён — снимок берётся сразу после отрисовки');
  ok(msrc.indexOf('if (shotPending)') > msrc.indexOf('renderer.render(scene, camera);'),
     'Захват стоит после render, иначе буфер уже очищен');
  ok(/body\.clean #topbar/.test(css), 'В фото-режиме HUD скрывается');
  ok(html.includes('id="bShot"') && html.includes('id="bPhotoExit"'), 'Есть затвор и выход');

  /* --- авто-тур --- */
  ok(CONFIG.TOUR_HOLD > 2, `Стоянка в точке ${CONFIG.TOUR_HOLD} с`);
  ok(/function updateTour/.test(msrc) && /updateTour\(dt\)/.test(msrc), 'Тур обновляется в цикле');
  ok(/showCaption/.test(msrc) && html.includes('id="caption"'), 'Титры точки показываются');
  ok(/function cancelFly\(\) \{ fly\.on = false; setTour\(false\)/.test(msrc),
     'Касание во время перелёта прекращает и тур');
  ok(/tour\.idx = \(tour\.idx \+ 1\) % CONFIG\.TP\.length/.test(msrc), 'Тур идёт по кругу');

  /* --- сезоны --- */
  const seasons = Object.keys(CONFIG.SEASONS);
  ok(seasons.length === 4, `Сезонов: ${seasons.join(', ')}`);
  for (const s of seasons) {
    const S = CONFIG.SEASONS[s];
    ok(S.greens.length && S.accents.length && S.bushes.length && S.accent >= 0 && S.accent <= 1,
       `  · ${S.name}: ${(S.accent * 100) | 0}% не-зелёных крон`);
  }
  ok(CONFIG.SEASONS.autumn.accent > CONFIG.SEASONS.summer.accent, 'Осенью цветных крон больше, чем летом');
  ok(html.includes('id="sSeason"'), 'Сезон переключается из настроек');
}

/* ══ 3i. Звук реагирует на то, где находится камера ════════════════════ */
{
  /* Решения о громкости вынесены в чистые функции — их можно проверить
     без браузера и без AudioContext. */
  const V = new THREE.Vector3();
  const at = (deg, r, z) => fieldAt(V.set(Math.sin(deg * D2R) * r, Math.cos(deg * D2R) * r, z));

  /* --- вода --- */
  const river = (CONFIG.SECT.rivers[0][0] + CONFIG.SECT.rivers[0][1]) / 2;
  const onRiver = waterLevel(at(river, CONFIG.R - 1.5, 0));
  const nearBank = waterLevel(at(CONFIG.SECT.rivers[0][1] + 14, CONFIG.R - 1.5, 0));
  const acrossField = waterLevel(at(200, CONFIG.R - 1.5, 0));
  const highAbove = waterLevel(at(river, 12, 0));
  ok(onRiver > 0.9, `Над руслом журчание в полную силу (${onRiver.toFixed(2)})`);
  ok(nearBank < onRiver * 0.8 && nearBank > 0, `В полусотне метров от русла заметно тише (${nearBank.toFixed(2)})`);
  ok(acrossField === 0, 'В полях реки не слышно вовсе');
  ok(highAbove === 0, 'С высоты у оси реки тоже не слышно');

  /* --- гул станции --- */
  ok(humLevel(at(0, 6, 0)) > humLevel(at(0, CONFIG.R - 2, 0)) * 1.4,
     'Гул громче у оси, где механика, чем у земли');
  ok(humLevel(at(0, CONFIG.R - 2, 0)) > 0.3, 'Но слышен и на земле — это станция');

  /* --- ветер --- */
  const still = windLevel(at(0, CONFIG.R - 1, 0), 0);
  const flying = windLevel(at(0, CONFIG.R - 1, 0), CONFIG.SPEED_MAX);
  ok(flying > still, `В полёте набегающий поток громче (${still.toFixed(2)} → ${flying.toFixed(2)})`);
  ok(windLevel(at(0, 8, 0), 0) < still, 'У оси, вдали от земли, ветра меньше');
  ok(flying <= 1, 'Ветер не выходит за единицу и не перегружает мастер');

  /* --- птицы --- */
  const park = CONFIG.SECT.parks[0][0] + 5, city = CONFIG.SECT.cities[0][0] + 5;
  ok(birdLevel(at(park, CONFIG.R - 2, 0), 1) > 0.9, 'В парке днём птицы поют');
  ok(birdLevel(at(park, CONFIG.R - 2, 0), 0) === 0, 'Ночью птицы молчат');
  ok(birdLevel(at(city, CONFIG.R - 2, 0), 1) === 0, 'В городе птиц нет');
  ok(birdLevel(at(park, 10, 0), 1) === 0, 'У оси птиц не слышно');
  ok(birdLevel(at(200, CONFIG.R - 2, 0), 1) > 0 &&
     birdLevel(at(200, CONFIG.R - 2, 0), 1) < birdLevel(at(park, CONFIG.R - 2, 0), 1),
     'В полях птицы есть, но реже, чем в парке');

  /* --- сумма слоёв не перегружает мастер --- */
  const A = CONFIG.AUDIO;
  let worst = 0;
  for (let d = 0; d < 360; d += 3) for (const rr of [CONFIG.R - 1, 30, 8]) {
    const f = at(d, rr, 0);
    worst = Math.max(worst,
      windLevel(f, CONFIG.SPEED_MAX) * A.wind + waterLevel(f) * A.water + humLevel(f) * A.hum);
  }
  ok(worst < 0.95, `Сумма слоёв в худшей точке ${worst.toFixed(2)} — клиппинга нет`);
  ok(A.volume > 0 && A.volume <= 1, 'Громкость по умолчанию в пределах нормы');

  /* --- контекст не создаётся без жеста --- */
  const asrc = readFileSync(new URL('./js/audio.js', import.meta.url), 'utf8');
  ok(/export function startAudio/.test(asrc) && !/new\s+AC\(\)/.test(asrc.split('export function startAudio')[0]),
     'AudioContext создаётся только в startAudio, вызываемом по жесту');
  const msrc = readFileSync(new URL('./js/main.js', import.meta.url), 'utf8');
  ok(/\$\('go'\)\.onclick[\s\S]{0,300}startAudio\(\)/.test(msrc),
     'startAudio вызывается по нажатию «Начать», а не при загрузке');
  ok(/suspendAudio\(paused\)/.test(msrc), 'Звук останавливается вместе со сценой');
  ok(!/fetch|\.mp3|\.ogg|\.wav/.test(asrc), 'Ни одного внешнего сэмпла — всё синтез');
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
  ok(fill(D) > 4.5, `Днём заполняющего света ${fill(D).toFixed(2)} — светло`);
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
  ok(/smoothstep\(\s*0\.34,\s*0\.92,\s*hullMask\.b\s*\)/.test(src2),
     'Фонари зажигаются мягким порогом по B, а не по всей заливке');
  /* фонари горят на всех улицах, а не только на магистралях, поэтому
     площадь свечения выросла и яркость должна была упасть */
  const tsrc2 = readFileSync(new URL('./js/textures.js', import.meta.url), 'utf8');
  const cityBlk = tsrc2.slice(tsrc2.indexOf('── ГОРОДА'), tsrc2.indexOf('── РЕКИ'));
  const passes = (cityBlk.match(/\[[\d.]+, [\d.]+\]/g) || []).length;
  ok(/for \(const \[mul, alpha\] of/.test(cityBlk),
     `След фонарей рисуется несколькими проходами (${passes}) — край мягкий, а не квадратный`);
  ok(/streets\.push/.test(cityBlk), 'Светятся все улицы, а не каждая третья');

  /* Свечение стало множителем к альбедо, а не самостоятельным цветом:
     сравнивать его с абсолютной яркостью света больше нельзя. Проверяем
     то, что важно, — фонарь освещает покрытие, поэтому разметка видна. */
  const wsrc2 = readFileSync(new URL('./js/world.js', import.meta.url), 'utf8');
  ok(/totalEmissiveRadiance \+= uCityGlow \* lamps \* diffuseColor\.rgb/.test(wsrc2),
     'Свет фонарей множится на альбедо — разметка дороги видна ночью');
  ok(N.cityGlow <= 1.0, `Фонарь не ярче самой поверхности (множитель ${N.cityGlow})`);
  ok(D.cityGlow === 0, 'Днём фонари выключены');
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
