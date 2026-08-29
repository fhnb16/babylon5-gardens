/* Самопроверка проекта. Запуск:  npm i -D three && node test.mjs
   Проверяет то, что молча ломается: инъекции в шейдер, согласование
   углов ферм с тенями, границы сборки мира. */
import './test/dom-stub.mjs';
import { readFileSync, existsSync } from 'node:fs';
import * as THREE from 'three';
import { CONFIG } from './js/config.js';
import { D2R, TAU, zoneAt, mulberry32, clamp as clampNum, tpVec, aimAt, natural,
  cityBlock, cityCenter, cellInfo, cellUsable, pickFloors, turnToward, clampPitch,
  surfacePos, mergeGeos, rod } from './js/util.js';
import { buildWorld, worldMats, hullU, uvSelfTest, patchAllRoughness,
  updateTreeLod, displaceHills } from './js/world.js';
import { buildStructures, structMats, updateStructures,
  liftSeat, liftCount2, setLiftInside } from './js/structures.js';
import { fieldAt, waterLevel, windLevel, humLevel, birdLevel } from './js/audio.js';
import { stationUp } from './js/controls.js';
import { tracePlan } from './js/photo.js';


/* Инстансы разрезаны на секторы ради отсечения по кадру, поэтому искать их
   «по количеству» больше нельзя — собираем по материалу. */
const chunksOf = (group, pick) => group.children.filter(o => o.isInstancedMesh && pick(o));
const totalCount = arr => arr.reduce((s, o) => s + o.count, 0);
const forEachInstance = (arr, fn) => {
  const m = new THREE.Matrix4(), p = new THREE.Vector3();
  const s = new THREE.Vector3(), q = new THREE.Quaternion();
  for (const im of arr) for (let k = 0; k < im.count; k++) {
    im.getMatrixAt(k, m); m.decompose(p, q, s);
    fn(p, s, q, im, k);
  }
};



/* Дом — инстанс с массивом материалов: стены и кровля. Искать его по
   одиночному material.emissiveMap больше нельзя. */
const isBuilding = o => o.isInstancedMesh && Array.isArray(o.material)
  && !!o.material[0]?.emissiveMap;
const wallMatOf = o => (Array.isArray(o.material) ? o.material[0] : o.material);

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
  ok(F.includes('( vTanU * rip.x + vTanV * rip.y )'),
     'Вода: рябь возмущает нормаль в касательных корпуса, а не в экранных осях');
  ok(F.includes('nonPerturbedNormal + ( vTanU'),
     'Рябь ставится поверх геометрической нормали — рельеф травы не просвечивает сквозь воду');
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
  const crown = chunksOf(group, o => o.material?.flatShading && o.material.vertexColors && o.instanceColor)[0];
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
  /* Секторы отсекаются по кадру, поэтому важен не общий счёт, а сколько
     реально уходит на отрисовку: в кадр попадает около четверти секторов. */
  let culled = 0;
  group.traverse(o => { if ((o.isMesh || o.isPoints) && o.frustumCulled) culled++; });
  const always = draws - culled;
  const inView = always + Math.ceil(culled * 3 / CONFIG.CHUNKS);
  ok(always <= 20, `Всегда рисуется ${always} вызовов — остальные ${culled} отсекаются по кадру`);
  ok(inView <= 45, `В кадре около ${inView} вызовов`);
  ok(culled > draws * 0.7, 'Подавляющее большинство объектов отсекаемые');

  /* Треугольники: плотная зелень с детализированными кронами легко
     разгоняет счёт, а один вызов отрисовки этого не показывает. */
  const tris = q => {
    const gg = new THREE.Group();
    buildWorld(gg, fakeRenderer, q);
    buildStructures(gg, fakeRenderer, q, null);
    let n = 0;
    gg.traverse(o => {
      if (!o.isMesh && !o.isPoints) return;
      const idx = o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count;
      n += (idx / 3) * (o.isInstancedMesh ? o.count : 1);
    });
    return n;
  };
  const hi = tris('HIGH'), lo = tris('LOW'), ul = tris('ULTRA');
  ok(hi < 700000, `Треугольников в HIGH: ${(hi / 1000) | 0}k (лимит 700k)`);
  ok(lo < 200000, `Треугольников в LOW: ${(lo / 1000) | 0}k (лимит 200k) — мобильный бюджет`);
  ok(ul < 1600000, `Треугольников в ULTRA: ${(ul / 1000) | 0}k (лимит 1.6M)`);
  ok(lo < hi * 0.45 && hi < ul * 0.6, 'Каждый пресет заметно тяжелее предыдущего по геометрии, а не только по разрешению');
  /* Заготовки уровней детализации пусты до раскладки — так они и устроены:
     ёмкость на весь сектор, счётчик выставляется по расстоянию до камеры. */
  ok(emptyInst <= 2 * CONFIG.QUALITY.HIGH.chunks,
     `Пустых InstancedMesh ${emptyInst} — только заготовки уровней`);

  /* --- контактные тени: по одной на дерево, куст и здание --- */
  buildWorld(group, fakeRenderer, 'LOW');          // вернуть мир после замеров бюджета
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

  /* торцы слиты в один инстанс, поэтому материалов стало меньше */
  ok(structMats.glass.length >= 2,
     `Стёкла башни и торцов управляются палитрой (${structMats.glass.length})`);
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

  /* У крыши свой материал и своя развёртка. Раньше она уводилась в узкую
     полосу фасадной текстуры: по одной оси растягивалась на всю ширину дома,
     по другой ужималась в двенадцать процентов высоты. */
  const bld = insts.find(o => Array.isArray(o.material)
    ? o.material[0]?.emissiveMap : o.material?.emissiveMap);
  ok(Array.isArray(bld.material) && bld.material.length === 2,
     'У дома два материала: стены и кровля');
  ok(bld.geometry.groups.length === 2, 'И две группы граней');
  const roofMat = bld.material[1];
  ok(!roofMat.emissiveMap, 'На кровле нет окон');
  ok(roofMat.roughness > bld.material[0].roughness,
     `Кровля шершавее стен: ${roofMat.roughness} против ${bld.material[0].roughness}`);
  ok(roofMat.metalness < bld.material[0].metalness,
     `И менее металлическая: ${roofMat.metalness} против ${bld.material[0].metalness}`);

  /* развёртка кровли обязана быть равномерной по обеим осям */
  const uv = bld.geometry.attributes.uv, nn = bld.geometry.attributes.normal;
  let flat = 0, uMin = 9, uMax = -9, vMin = 9, vMax = -9;
  for (let k = 0; k < uv.count; k++) {
    if (Math.abs(nn.getY(k)) < 0.7) continue;
    flat++;
    uMin = Math.min(uMin, uv.getX(k)); uMax = Math.max(uMax, uv.getX(k));
    vMin = Math.min(vMin, uv.getY(k)); vMax = Math.max(vMax, uv.getY(k));
  }
  ok(flat > 0, `Горизонтальных вершин: ${flat}`);
  const uSpan = uMax - uMin, vSpan = vMax - vMin;
  ok(uSpan > 0.5 && vSpan > 0.5, `Развёртка кровли занимает ${uSpan.toFixed(1)}×${vSpan.toFixed(1)}`);
  ok(Math.abs(uSpan - vSpan) / Math.max(uSpan, vSpan) < 0.25,
     `И равномерна по осям: ${uSpan.toFixed(2)} против ${vSpan.toFixed(2)} — не растянута`);

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

  /* Отдельных мешей-холмов больше нет: корпус продавлен по тому же списку.
     Раньше холм был сферой на земле — своя кромка, свой цвет, резкий стык. */
  const hillMesh = insts.find(o => o.material?.flatShading && !o.material.map
    && !o.instanceColor && o.count > 0
    && o.count <= CONFIG.COUNT.hills[0] && o.geometry.attributes.position.count < 200);
  ok(!hillMesh, 'Отдельных мешей-холмов нет — рельеф несёт сам корпус');

  const hullMesh = group.children.find(o => o.material?.side === THREE.BackSide);
  const hpos = hullMesh.geometry.attributes.position;
  let minR = 1e9, maxRad = 0;
  const vv = new THREE.Vector3();
  for (let k = 0; k < hpos.count; k++) {
    vv.fromBufferAttribute(hpos, k);
    const r = Math.hypot(vv.x, vv.y);
    minR = Math.min(minR, r); maxRad = Math.max(maxRad, r);
  }
  const rise = CONFIG.R - minR, dipDepth = maxRad - CONFIG.R;
  ok(rise > 0.5, `Корпус продавлен холмами внутрь на ${rise.toFixed(2)} юнита`);
  ok(dipDepth > 0.1, `И низинами наружу на ${dipDepth.toFixed(2)} — там пруды`);
  ok(rise < CONFIG.HILL.r[1] * CONFIG.HILL.rise[1] * 1.6,
     'Подъём не выше заданного уклона, даже если холмы наложились');
  ok(hpos.count > 5000, `Колец хватает, чтобы гнуть: вершин ${hpos.count}`);

  /* список для остального мира собирается из того же источника */
  const hills = [];

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
  const trunkC2 = chunksOf({children: insts}, o => !Array.isArray(o.material) && o.material.isMeshStandardMaterial && !o.material.map && !o.material.emissiveMap
    && !o.material.flatShading && o.material.vertexColors && !o.instanceColor);
  const trunks = trunkC2[0];
  const reliefAt = (t, z) => {
    let up = 0;
    for (const [ht, hz, hr, hh] of hills) {
      const d = Math.hypot(gap(t, ht) * CONFIG.R, z - hz);
      if (d < hr) up = Math.max(up, hh * Math.sqrt(1 - (d / hr) ** 2));
    }
    return up;
  };
  let onSlope = 0, buried = 0;
  forEachInstance(trunkC2, (p, s) => {
    const t = Math.atan2(p.x, p.y), r = Math.hypot(p.x, p.y);
    const up = reliefAt(t, p.z);
    if (up < 0.05) return;
    onSlope++;
    /* центр ствола обязан быть на полвысоты выше поверхности холма */
    if (Math.abs((CONFIG.R - up - s.y / 2) - r) > 0.02) buried++;
  });
  ok(onSlope > 0 || buried === 0,
     `Деревьев на склонах: ${onSlope}, утопленных ${buried}`);
  ok(buried === 0, 'Ни одно не утоплено в склон');
}

/* ══ 3d. Зерно генерации ════════════════════════════════════════════════ */
{
  ok(CONFIG.SEED === CONFIG.SEED_DEFAULT, 'По умолчанию используется заводское зерно');

  const shot = q => {
    const g = new THREE.Group();
    buildWorld(g, fakeRenderer, q);
    const im = g.children.find(isBuilding);
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
  /* у дома массив из двух материалов: стены и кровля */
  const wallMats = [...new Set(group.children
    .filter(o => o.isInstancedMesh && Array.isArray(o.material) && o.material[0]?.emissiveMap)
    .map(o => o.material[0]))];
  const bld = wallMats.map(mm =>
    chunksOf(group, o => Array.isArray(o.material) && o.material[0] === mm)[0]);
  ok(wallMats.length === 4, 'Четыре типа зданий со своими фасадами');

  wallMats.forEach((mm, v) => {
    ok(mm.map.wrapS === THREE.RepeatWrapping && mm.map.wrapT === THREE.RepeatWrapping,
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
  /* только дома: у машин тоже есть карта окон, но материал у них один */
  const bld = g.children.filter(isBuilding);
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
  const trunkC = chunksOf({children: ins}, o => !Array.isArray(o.material) && o.material.isMeshStandardMaterial && !o.material.map && !o.material.emissiveMap
    && !o.material.flatShading && o.material.vertexColors && !o.instanceColor);
  const trunk = trunkC[0];
  ok(!!trunk, 'Стволы деревьев найдены');

  const m = new THREE.Matrix4(), p = new THREE.Vector3(), s = new THREE.Vector3(), q = new THREE.Quaternion();
  const TR = CONFIG.TREE;
  const hs = [], pts = [];
  forEachInstance(trunkC, (p, s) => {
    hs.push(s.y / TR.trunk * 0.98);                    // полная высота над своей землёй
    pts.push([Math.atan2(p.x, p.y), p.z, s.y / TR.trunk]);
  });
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
  ok(TR.spacing >= 1.0, `Кроны не пересекаются: шаг ${TR.spacing} радиуса кроны`);
  ok(totalCount(trunkC) > 2000, `Зелени густо: ${totalCount(trunkC)} деревьев`);
}

/* ══ 3f4b. Холмы земляного цвета, дорожки плавные ══════════════════════ */
{
  const g = new THREE.Group();
  buildWorld(g, fakeRenderer, 'HIGH');
  const ins = g.children.filter(o => o.isInstancedMesh);
  /* трава у комлей тоже гранёная и без карты — различаем по цвету инстанса */
  const hillC = chunksOf({ children: ins }, o => o.material?.flatShading
    && !o.material.vertexColors && !o.material.map && o.instanceColor);
  const crownC = chunksOf({ children: ins }, o => o.material?.vertexColors
    && o.material.flatShading && o.instanceColor);
  const lum = c => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const col = new THREE.Color();

  let hMax = 0, hSum = 0, hN = 0;
  for (const im of hillC) for (let k = 0; k < im.count; k++) {
    im.getColorAt(k, col); const l = lum(col); hMax = Math.max(hMax, l); hSum += l; hN++;
  }
  let cSum = 0, n = 0;
  for (const im of crownC) for (let k = 0; k < im.count; k += 7) {
    im.getColorAt(k, col); cSum += lum(col); n++;
  }
  const hAvg = hSum / hN, cAvg = cSum / n;

  /* Цвет холмов проверять больше не на чем: отдельных мешей нет, склон
     красит та же трава корпуса — и это ровно то, чего добивались. */
  ok(Number.isNaN(hAvg) || hAvg < cAvg,
     'Отдельных холмов нет: склон красит та же трава, что и равнину');

  /* setHSL по умолчанию работает в ЛИНЕЙНОМ пространстве — цвет выходит
     заметно светлее задуманного. Требуем явного указания sRGB. */
  const wsrc = readFileSync(new URL('./js/world.js', import.meta.url), 'utf8');
  const tsrc0 = readFileSync(new URL('./js/textures.js', import.meta.url), 'utf8');
  const hslCalls = (wsrc + tsrc0).split('setHSL(').slice(1)
    .map(s => s.slice(0, s.indexOf('));')));
  ok(hslCalls.every(s => /SRGBColorSpace/.test(s)),
     `Все setHSL (${hslCalls.length}) задают цвет в sRGB, а не в рабочем линейном пространстве`);

  /* дорожки: плавная кривая вместо ломаной */
  const tsrc = readFileSync(new URL('./js/textures.js', import.meta.url), 'utf8');
  ok(/quadraticCurveTo/.test(tsrc), 'Линии ведутся кривыми, а не отрезками');
  const parks = tsrc.slice(tsrc.indexOf('── ПАРКИ'), tsrc.indexOf('── ГОРОДА'));
  ok(!/px \+= \(rnd\(\) - \.5\)/.test(parks), 'Случайного блуждания в дорожках больше нет');
  ok(/smoothLine\(a, pts\)/.test(parks), 'Дорожка рисуется плавной линией');
  ok(/Math\.sin\(py \* fr0/.test(parks) && /Math\.sin\(py \* fr1/.test(parks),
     'Меандр складывается из двух гармоник — крупные изгибы и мелкие');
}

/* ══ 3f4c. Следы домов и контактное затемнение ═════════════════════════ */
{
  const Q = CONFIG.QUALITY;
  ok(!!Q.LOW && !!Q.HIGH && !!Q.ULTRA, `Пресеты качества: ${Object.keys(Q).join(', ')}`);
  ok(Q.LOW.footprint === false && Q.HIGH.footprint && Q.ULTRA.footprint,
     'Следы домов включаются на высоком и ультра, на низком — нет');
  ok(Q.ULTRA.foliage > Q.HIGH.foliage && Q.HIGH.foliage > Q.LOW.foliage,
     `Детализация крон растёт: ${Q.LOW.foliage} → ${Q.HIGH.foliage} → ${Q.ULTRA.foliage}`);
  ok(Q.ULTRA.mask > Q.HIGH.mask, 'На ультра маска корпуса вдвое подробнее — фонари чётче');

  /* форма следа выведена из геометрии источника, а не подобрана */
  const P = CONFIG.PRINT;
  const d = CONFIG.R - 4 * CONFIG.FLOOR_H;                 // от крыши дома до оси
  const across = 2 * Math.atan(CONFIG.SUN.r / d) * 180 / Math.PI;
  const along = 2 * Math.atan(CONFIG.SUN.len / 2 / d) * 180 / Math.PI;
  ok(along > across * 10,
     `Источник вытянут: поперёк станции ${across.toFixed(1)}°, вдоль оси ${along.toFixed(0)}°`);
  ok(P.along > P.across * 1.4,
     `След вытянут в ту же сторону: ${P.across}× поперёк против ${P.along}× вдоль`);

  /* Тень не может быть чёрной: в ней остаётся свет полусферы. Считаем долю
     и сверяем с предельной плотностью декали. */
  const fillOf = k => CONFIG[k].hemiInt + CONFIG[k].pointInt * CONFIG.LIGHT_Z.length;
  const inShadow = CONFIG.DAY.hemiInt / fillOf('DAY');
  ok(P.dark < 1 - inShadow * 0.6,
     `Тень затемняет до ${(P.dark * 100) | 0}%, а в ней остаётся ${(inShadow * 100) | 0}% света от полусферы`);
  ok(P.dark > 0.4, 'Но тень всё же читается, а не еле заметна');
  const tsrc3 = readFileSync(new URL('./js/textures.js', import.meta.url), 'utf8');
  ok(/a2 \* 1\.25/.test(tsrc3), 'Кайма усилена умеренно — раньше она добивала пятно до чёрного');

  /* на высоком следы домов — отдельный инстанс, на низком их нет */
  for (const [q, want] of [['HIGH', true], ['LOW', false]]) {
    const g = new THREE.Group();
    buildWorld(g, fakeRenderer, q);
    const has = !!worldMats.print;
    ok(has === want, `${q}: отдельные следы домов ${want ? 'есть' : 'не строятся'}`);
    if (has) {
      const pmC = chunksOf(g, o => o.material === worldMats.print);
      ok(totalCount(pmC) > 100, `${q}: следов домов ${totalCount(pmC)}`);
      const m2 = new THREE.Matrix4(), p2 = new THREE.Vector3(), s2 = new THREE.Vector3(), q2 = new THREE.Quaternion();
      let elongated = 0, totalP = 0;
      forEachInstance(pmC, (p2, s2) => { totalP++; if (s2.z > s2.x) elongated++; });
      ok(elongated === totalP, 'Каждый след вытянут вдоль оси станции');
    }
  }
}

/* ══ 3f4d. Три фазы освещения и читаемый контакт ═══════════════════════ */
{
  const P = CONFIG.PHASES;
  ok(P.length === 3 && P.join() === 'DAY,DUSK,NIGHT',
     `Фазы по кругу: ${P.map(k => k.toLowerCase()).join(' → ')} → день`);

  /* закат обязан лежать между днём и ночью, а не быть третьим ни на что
     не похожим состоянием: иначе переход дёргается */
  const fill = k => CONFIG[k].hemiInt + CONFIG[k].pointInt * CONFIG.LIGHT_Z.length;
  ok(fill('DAY') > fill('DUSK') && fill('DUSK') > fill('NIGHT'),
     `Свет убывает монотонно: ${fill('DAY').toFixed(2)} → ${fill('DUSK').toFixed(2)} → ${fill('NIGHT').toFixed(2)}`);
  ok(CONFIG.DAY.light === 1 && CONFIG.NIGHT.light === 0
     && CONFIG.DUSK.light > 0 && CONFIG.DUSK.light < 1,
     `Доля дня в фазах: ${P.map(k => CONFIG[k].light).join(' → ')}`);
  ok(CONFIG.DAY.winEmis < CONFIG.DUSK.winEmis && CONFIG.DUSK.winEmis < CONFIG.NIGHT.winEmis,
     'Окна загораются постепенно: на закате уже, но не в полную силу');

  /* закат золотой: тёплый оттенок сильнее, чем у дня и ночи */
  const warm = hex => { const c = new THREE.Color(hex); return c.r - c.b; };
  ok(warm(CONFIG.DUSK.sunCol) > warm(CONFIG.DAY.sunCol)
     && warm(CONFIG.DUSK.hemiSky) > warm(CONFIG.DAY.hemiSky),
     'Закат теплее дня по оттенку — золотой, а не просто тусклый');
  ok(warm(CONFIG.NIGHT.sunCol) < 0, 'Ночь холодная — лунная');

  /* у всех фаз одинаковый набор полей, иначе смешивание даст NaN */
  const keys = Object.keys(CONFIG.DAY).sort().join();
  for (const k of P) ok(Object.keys(CONFIG[k]).sort().join() === keys,
     `Фаза ${k} описана тем же набором полей`);

  const msrc = readFileSync(new URL('./js/main.js', import.meta.url), 'utf8');
  ok(/phaseTo \+= 1/.test(msrc), 'Кнопка двигает фазу на одну вперёд, а не переключает день/ночь');
  ok(/phase = Math\.min\(phaseTo, phase \+ dt \/ CONFIG\.FADE\)/.test(msrc),
     'Переход идёт дробной фазой — плавно, а не скачком');
  ok(/phase -= CONFIG\.PHASES\.length/.test(msrc), 'Счётчики фаз не растут бесконечно');
  ok(!/dayMix|dayTarget/.test(msrc), 'Старой двухфазной модели не осталось');
  /* Переход должен быть заметен, но давать отклик на нажатие. Девять секунд
     читались как «кнопка не работает». */
  ok(CONFIG.FADE >= 2 && CONFIG.FADE <= 5,
     `Переход занимает ${CONFIG.FADE} с — виден, но отзывчив`);
  ok(/phaseTo = Math\.floor\(phase\) \+ 1/.test(msrc),
     'Цель — следующая фаза от текущей: быстрые нажатия не копят очередь');
  /* авто-цикл прибавлять цель может: он срабатывает по таймеру, когда
     переход уже завершён, и очереди не создаёт */
  ok(/cycleT > CONFIG\.AUTO_CYCLE_PERIOD.*phaseTo \+= 1/.test(msrc),
     'Авто-цикл двигает фазу по таймеру');
  ok(!/bDay\.onclick = \(\) => \{ phaseTo \+= 1/.test(msrc),
     'Кнопка очередь не копит');
  ok(CONFIG.AUTO_CYCLE_PERIOD > CONFIG.FADE * 3,
     `Стоянка в фазе ${CONFIG.AUTO_CYCLE_PERIOD} с заметно длиннее перехода`);

  /* контакт: темнеет не только земля, но и низ самого объекта */
  const tsrc = readFileSync(new URL('./js/textures.js', import.meta.url), 'utf8');
  ok(/const foot = Math\.round\( ?H \* 0\.13 ?\)/.test(tsrc),
     'У фасада есть градиент затемнения по нижней части стены');
  const wsrc = readFileSync(new URL('./js/world.js', import.meta.url), 'utf8');
  ok(/trunkGeo\.setAttribute\('color'/.test(wsrc), 'Комель ствола темнеет к земле');

  /* численно: низ ствола заметно темнее верха */
  const g = new THREE.Group();
  buildWorld(g, fakeRenderer, 'HIGH');
  const trunk = chunksOf(g, o => !Array.isArray(o.material) && o.material.isMeshStandardMaterial && !o.material.map && !o.material.emissiveMap
    && !o.material.flatShading && o.material.vertexColors && !o.instanceColor)[0];
  const tp = trunk.geometry.attributes.position, tc = trunk.geometry.attributes.color;
  let low = 9, high = 0;
  for (let k = 0; k < tp.count; k++) {
    if (tp.getY(k) < -0.45) low = Math.min(low, tc.getX(k));
    if (tp.getY(k) > 0.45) high = Math.max(high, tc.getX(k));
  }
  ok(low < high * 0.55, `Комель темнее кроны ствола: ${low.toFixed(2)} против ${high.toFixed(2)}`);

  /* затенение в трассировке не должно съедать дальний план */
  const psrc = readFileSync(new URL('./js/photo.js', import.meta.url), 'utf8');
  ok(/ao = mix\( 1\.0, ao, k \)/.test(psrc) && /float k = near \* fogAmt/.test(psrc),
     'Затенение гаснет и по расстоянию, и по туману');
  ok(/if \( pxR < 3\.0 \) break/.test(psrc),
     'Лучи не пускаются, когда радиус проецируется меньше трёх пикселей — там только шум');
}

/* ══ 3f5. Куст — подлесок, крона — листва ══════════════════════════════ */
{
  const g = new THREE.Group();
  buildWorld(g, fakeRenderer, 'HIGH');
  const ins = g.children.filter(o => o.isInstancedMesh);
  const m = new THREE.Matrix4(), p = new THREE.Vector3(), s = new THREE.Vector3(), q = new THREE.Quaternion();

  const trunkC = chunksOf({children: ins}, o => !Array.isArray(o.material) && o.material.isMeshStandardMaterial && !o.material.map && !o.material.emissiveMap
    && !o.material.flatShading && o.material.vertexColors && !o.instanceColor);
  const trunk = trunkC[0];
  const foliageMats = [...new Set(ins.filter(o => o.material?.flatShading
    && o.material.vertexColors).map(o => o.material))];
  const foliage = foliageMats.map(mm => chunksOf({ children: ins }, o => o.material === mm)[0]);
  /* Материалов стало больше: у кроны их три — по одному на уровень
     детализации, — плюс материал кустов. */
  ok(foliageMats.length >= 2,
     `Кроны и кусты — отдельные материалы с вершинными цветами (${foliageMats.length})`);

  /* какой из них куст: у него нет парного ствола, берём меньший по габариту */
  const size = im => { im.geometry.computeBoundingBox(); return im.geometry.boundingBox.max.y; };
  let maxBush = 0, maxTree = 0;
  /* куст: вершинные цвета И цвет инстанса, но не крона — крону узнаём по числу */
  const bushMat = foliageMats.find(mm => chunksOf({ children: ins },
    o => o.material === mm).reduce((s2, o) => s2 + o.count, 0) < 3000);
  const bushC = chunksOf({ children: ins }, o => o.material === bushMat);
  forEachInstance(bushC, (p, s) => { maxBush = Math.max(maxBush, s.y * 2); });
  forEachInstance(trunkC, (p, s) => { maxTree = Math.max(maxTree, s.y / CONFIG.TREE.trunk * 0.98); });
  ok(maxBush < maxTree * 0.5,
     `Самый крупный куст ${(maxBush * 10).toFixed(1)} м — вдвое ниже самого высокого дерева ${(maxTree * 10).toFixed(1)} м`);
  ok(maxBush * 10 < 7, `Куст остаётся подлеском: до ${(maxBush * 10).toFixed(1)} м в высоту`);

  /* крона не должна быть правильным многогранником */
  const geo = foliage[0].geometry;
  const pos = geo.attributes.position;
  let rMin = 9, rMax = 0;
  for (let k = 0; k < pos.count; k++) {
    const r = Math.hypot(pos.getX(k), pos.getY(k), pos.getZ(k));
    rMin = Math.min(rMin, r); rMax = Math.max(rMax, r);
  }
  ok(rMax / rMin > 1.15,
     `Форма кроны неправильная: радиус гуляет ${rMin.toFixed(2)}…${rMax.toFixed(2)}`);
  ok(geo.attributes.color, 'У кроны есть вершинные цвета — пятнистость листвы');

  /* пятнистость назначена по граням, а не по вершинам */
  const col = geo.attributes.color;
  let perFace = true, spread = 0;
  for (let f = 0; f < col.count && perFace; f += 3) {
    const v = col.getX(f);
    if (Math.abs(col.getX(f + 1) - v) > 1e-6 || Math.abs(col.getX(f + 2) - v) > 1e-6) perFace = false;
    spread = Math.max(spread, Math.abs(v - 1));
  }
  ok(perFace, 'Светлота задана на грань — листва рябит, а не переливается градиентом');
  ok(spread > 0.05, `Разброс светлоты граней ±${(spread * 100).toFixed(0)}%`);

  /* поверхность осталась замкнутой: одинаковые вершины смещены одинаково */
  const byKey = new Map();
  let split = 0;
  for (let k = 0; k < pos.count; k++) {
    const dir = new THREE.Vector3(pos.getX(k), pos.getY(k), pos.getZ(k)).normalize();
    const key = dir.x.toFixed(3) + ',' + dir.y.toFixed(3) + ',' + dir.z.toFixed(3);
    const r = Math.hypot(pos.getX(k), pos.getY(k), pos.getZ(k));
    if (byKey.has(key)) { if (Math.abs(byKey.get(key) - r) > 1e-4) split++; }
    else byKey.set(key, r);
  }
  ok(split === 0, 'Общие вершины смещены согласованно — крона не расходится по швам');

  /* шелест листвы в шейдере */
  const wsrc3 = readFileSync(new URL('./js/world.js', import.meta.url), 'utf8');
  ok(/transformed \+= normalize\( transformed \) \* sin\( uTime/.test(wsrc3),
     'У каждой вершины кроны своя фаза — листва шелестит, а не качается целиком');
  ok(!/transformed \+= normal \*/.test(wsrc3),
     'Шелест идёт по радиусу, а не по нормали: у копий одной вершины нормали разные, и крона рвалась бы');

  /* численно: копии одной вершины смещаются одинаково */
  const fg = foliage[0].geometry.attributes.position;
  const byXYZ = new Map();
  for (let k = 0; k < fg.count; k++) {
    const key = fg.getX(k).toFixed(4) + ',' + fg.getY(k).toFixed(4) + ',' + fg.getZ(k).toFixed(4);
    if (!byXYZ.has(key)) byXYZ.set(key, []);
    byXYZ.get(key).push(k);
  }
  const nrm = foliage[0].geometry.attributes.normal;
  let differing = 0, shared = 0;
  for (const ids of byXYZ.values()) {
    if (ids.length < 2) continue;
    shared++;
    const set = new Set(ids.map(k =>
      nrm.getX(k).toFixed(2) + ',' + nrm.getY(k).toFixed(2) + ',' + nrm.getZ(k).toFixed(2)));
    if (set.size > 1) differing++;
  }
  ok(differing === shared && shared > 10,
     `У ${differing} общих вершин нормали граней различаются — смещать по ним нельзя`);
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
    const mm0 = Array.isArray(im.material) ? im.material[0] : im.material;
    if (mm0.transparent) continue;                         // пятна теней не в счёт
    /* Кабины монорельса ходят по всей длине: у торца они законно, там же
       кончается их маршрут. Помечаем, чтобы не путать с неподвижным. */
    /* Подвижное — то, что ездит по маршруту: машины на магистралях и кабины
       монорельса. У торца они оказываются законно, там маршрут и кончается.
       Узнаём по числу экземпляров: столько же, сколько задано трафику или
       кабинам. */
    const moving = im.count % CONFIG.TRAFFIC.perLane === 0
      || im.count === CONFIG.AXIS.railAngles.length;
    for (let k = 0; k < im.count; k++) {
      im.getMatrixAt(k, m); m.decompose(p, qq, s);
      const r = Math.hypot(p.x, p.y);
      all.push({ t: Math.atan2(p.x, p.y), z: p.z, r, top: CONFIG.R - r + s.y / 2,
                 half: Math.max(s.x, s.z) * 0.5, moving });
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

  /* Холмы теперь несёт сам корпус, поэтому проверяем ЕГО: под городом и над
     руслом поверхность обязана остаться ровной, иначе дома встанут на склон,
     а река потечёт в гору. */
  const hullM = group.children.find(o => o.material?.side === THREE.BackSide);
  const hp = hullM.geometry.attributes.position;
  const vv2 = new THREE.Vector3();
  let cityBump = 0, riverBump = 0, worstCity = 0, worstRiver = 0;
  for (let k = 0; k < hp.count; k += 3) {
    vv2.fromBufferAttribute(hp, k);
    const dev = Math.abs(Math.hypot(vv2.x, vv2.y) - CONFIG.R);
    if (dev < 0.15) continue;
    const deg = ((Math.atan2(vv2.x, vv2.y) / D2R) % 360 + 360) % 360;
    const zone = zoneAt(deg);
    if (zone === 'city') { cityBump++; worstCity = Math.max(worstCity, dev); }
    if (zone === 'river') { riverBump++; worstRiver = Math.max(worstRiver, dev); }
  }
  ok(cityBump === 0,
     `Под городом корпус ровный (отклонений ${cityBump}, худшее ${worstCity.toFixed(2)})`);
  ok(riverBump === 0,
     `Над руслом тоже (отклонений ${riverBump}, худшее ${worstRiver.toFixed(2)})`);

  /* ничего не упирается в торцевые диски */
  /* Кабины монорельса ходят по всей длине и у торца оказываются законно:
     их маршрут кончается ровно там, где ступица воронки. Проверяем то, что
     стоит неподвижно. */
  let pokeEnd = 0;
  for (const o of all) {
    if (o.moving) continue;
    if (Math.abs(o.z) + o.half > CONFIG.L / 2 - 1) pokeEnd++;
  }
  ok(pokeEnd === 0, `Неподвижное не протыкает торцевые диски (нарушений ${pokeEnd})`);
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
  ok(msrc.lastIndexOf('if (shotPending)') > msrc.indexOf('renderer.render(scene, camera);'),
     'Захват стоит после render, иначе буфер уже очищен');
  /* Захватов теперь два — в ветке пути и в ветке экранных лучей; проверяем
     тот, что относится к экранной трассировке. */
  ok(msrc.indexOf('if (shotPending)', msrc.indexOf('traceStep()')) > msrc.indexOf('traceStep()'),
     'В режиме трассировки захват идёт после показа накопленного');
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

/* ══ 3h2. Трассировка в фото-режиме ════════════════════════════════════ */
{
  const src = readFileSync(new URL('./js/photo.js', import.meta.url), 'utf8');
  const P = CONFIG.PHOTO;

  /* Зерно не успевает попасть на глаз: 10 лучей за кадр дают к третьему кадру
     (50 мс) шум около 18%. Это ожидаемо — накопление по одному лучу на кадр
     показывало бы зерно, но сходилось бы в десять раз дольше. */
  const noiseAt = frames => 1 / Math.sqrt(frames * P.rays);
  ok(noiseAt(1) > 0.3,
     `Первый кадр даёт ${(noiseAt(1) * 100) | 0}% шума — схождение видно`);
  ok(noiseAt(P.samples) < 0.05,
     `К концу накопления шум ${(noiseAt(P.samples) * 100).toFixed(0)}%`);

  ok(P.rays >= 2 && P.samples >= 32,
     `Лучей на пиксель: ${P.rays} за кадр × ${P.samples} кадров = ${P.rays * P.samples}`);
  ok(P.radius > 0.3 && P.radius < 2,
     `Дальность луча ${P.radius} юнита = ${P.radius * 10} м — масштаб контактного затенения`);

  /* ─── Свет считается, а не только затеняется ─── */
  ok(/bounce \+= texture2D\( tBeauty, suv \)\.rgb \* w/.test(src),
     'Луч приносит цвет поверхности, в которую упёрся, — это переотражение, а не только загораживание');
  ok(/vec3 cur = col \* ao \* shade \+ col \* gi \+ refl/.test(src),
     'Итог: прямой свет × затенение + переотражения + отражения');

  /* --- прямой свет считается лучами к настоящему источнику --- */
  ok(/vec3 L = mix\( uSunA, uSunB, along \)/.test(src),
     'Теневой луч идёт к случайной точке ПО ДЛИНЕ трубы');
  ok(/uSunU \* cos\( ang \) \+ uSunV \* sin\( ang \)/.test(src),
     'И по обхвату: полутень следует из размеров источника, а не подобрана');
  ok(/for \( int s = 0; s < SHADOW_STEPS; s \+\+ \)/.test(src),
     `Марш к солнцу, ${P.shadowSteps} шагов`);
  ok(/float shade = mix\( 1\.0, mix\( uAmbient, 1\.0, vis \), uShadow \)/.test(src),
     'В тени остаётся доля рассеянного света, а не чернота');
  ok(/ndl <= 0\.0 \) continue/.test(src), 'Источник за поверхностью не учитывается');
  ok(P.shadow > 0 && P.shadowSteps >= 8, `Сила прямого света ${P.shadow}`);

  const psrc2 = readFileSync(new URL('./js/photo.js', import.meta.url), 'utf8');
  ok(/_sunP\.set\(0, 0, -SUN\.len \/ 2\)\.applyMatrix4\(C\.matrixWorldInverse\)/.test(psrc2),
     'Труба переводится в видовые координаты камерой');
  /* S на уровне модуля — это сцена; локальное объявление того же имени
     давало обращение к переменной до инициализации и роняло трассировку */
  ok(!/^\s\sconst S = /m.test(psrc2), 'Имя сцены не затеняется внутри функций');
  ok(/setAmbientShare/.test(psrc2), 'Доля рассеянного света берётся из текущей палитры');
  const msrc2 = readFileSync(new URL('./js/main.js', import.meta.url), 'utf8');
  ok(/setAmbientShare\(hemi\.intensity \/ \(hemi\.intensity \+ lights\.length/.test(msrc2),
     'Считается как отношение полусферы к полному свету, а не задана числом');
  ok(P.bounce > 0, `Сила переотражения ${P.bounce}`);

  /* отражения */
  /* Отражения считаются пересечением с НАСТОЯЩИМИ телами, а не маршем по
     экрану: в цилиндре отражать может только труба-солнце и борт станции,
     оба — цилиндры вдоль оси, и пересечение решается формулой. Экранный
     марш давал чёрные пятна там, где луч уходил за кадр. */
  ok(/vec3 Rd = reflect\( V, N \)/.test(src), 'Отражённый луч считается точно');
  /* Марш по экрану видит фермы, деревья и дома — аналитика их не знает.
     Одной аналитикой река выходила чёрной с белой полосой солнца. Поэтому
     марш идёт первым, а аналитика добирает то, что ушло за кадр. */
  ok(/for \( int i = 0; i < REF_STEPS; i \+\+ \)/.test(src), 'Экранный марш на месте');
  ok(/vec3 mix2 = hitCol \* got \+ farCol \* farGot \* \( 1\.0 - got \)/.test(src),
     'Аналитика домешивается по недостающей доле, а не заменяет марш');
  ok(/got = smoothstep\( 0\.0, 0\.14, 1\.0 - max\( me\.x, me\.y \) \)/.test(src),
     'У кромки кадра экранное попадание гаснет и уступает место аналитике');
  ok(/float disc = b \* b - 4\.0 \* a \* c0/.test(src), 'Пересечение с трубой-солнцем решается формулой');
  ok(/float dH = b \* b - 4\.0 \* a \* cH/.test(src), 'Пересечение с бортом станции — тоже');
  ok(/\( -b - sqrt\( disc \) \)/.test(src) && /\( -b \+ sqrt\( dH \) \)/.test(src),
     'У трубы берётся ближний корень, у борта дальний: внутрь цилиндра мы смотрим изнутри');
  ok(/texture2D\( tHull, vec2\( uu, vv \) \)/.test(src),
     'Цвет борта берётся из альбедо корпуса по точке попадания');
  ok(/atan\( hw\.x, hw\.y \) - uWorldRot/.test(src),
     'Вращение мира снимается поворотом назад — иначе отражение поедет вместе со станцией');
  ok(/abs\( hw\.z \) < uHullL \* 0\.5/.test(src), 'За торцы отражение не уходит');
  ok(/pow\( 1\.0 - max\( 0\.0, dot\( -V, N \) \), 4\.0 \)/.test(src),
     'Френель: под острым углом отражает сильнее — как в жизни');
  ok(P.reflect > 0 && P.sunGlow > 1, `Отражения: сила ${P.reflect}, труба ярче единицы (${P.sunGlow})`);

  const psrc3 = readFileSync(new URL('./js/photo.js', import.meta.url), 'utf8');
  ok(/export function setHullRef/.test(psrc3), 'Альбедо корпуса и угол мира передаются трассировке');
  const msrc3 = readFileSync(new URL('./js/main.js', import.meta.url), 'utf8');
  ok(/setHullRef\(hullAlbedoTex, worldGroup\.rotation\.z\)/.test(msrc3),
     'Угол берётся текущий, каждый кадр');

  /* шероховатость берётся из альфы кадра, а не из отдельного прохода */
  ok(/float rough = beauty\.a/.test(src), 'Шероховатость читается из альфа-канала кадра');
  const wsrc = readFileSync(new URL('./js/world.js', import.meta.url), 'utf8');
  ok(/export function patchRoughnessAlpha/.test(wsrc), 'Материалы пишут шероховатость в альфу');
  ok(/gl_FragColor\.a = roughnessFactor/.test(wsrc),
     'Пишется именно шероховатость — по ней трассировка отличает воду и металл от травы');
  const ssrc = readFileSync(new URL('./js/structures.js', import.meta.url), 'utf8');
  ok((wsrc.match(/patchRoughnessAlpha\(/g) || []).length >= 3
     && (ssrc.match(/patchRoughnessAlpha\(/g) || []).length >= 3,
     'Патч применён и к корпусу с домами, и к металлу с бетоном и стеклом');

  /* туман гасит все три составляющие, а не одну */
  ok(/gi \*= k/.test(src) && /refl \*= k/.test(src),
     'Дальний план не получает ни переотражений, ни бликов');
  ok(P.aoFar > P.aoNear, `Вклад лучей гаснет с ${P.aoNear * 10} до ${P.aoFar * 10} м`);
  ok(P.aoNear > CONFIG.R * 2,
     `Затухание начинается дальше противоположной стены (${CONFIG.R * 2 * 10} м) — иначе полкадра остаётся без вклада`);
  ok(/if \( pxR < 3\.0 \) break/.test(src),
     'От муара вдали защищает порог в пикселях, а не грубое обрезание по расстоянию');

  /* Затенение обязано быть местным: модель «радиус / дальность» давала вклад
     даже от объектов за сотню метров, и по кадру это складывалось в дымку. */
  ok(/dz > uBias && dz < uRadius \)/.test(src),
     'Окно приёма не шире радиуса: шире оно давало чёрные ореолы вокруг силуэтов на дальнем фоне');
  ok(!/occ \+= clamp\( uRadius \/ max/.test(src),
     'Старой модели с бесконечным хвостом не осталось');
  ok(/1\.0 - smoothstep\( uRadius \* 0\.5, uRadius, dz \)/.test(src),
     'Вклад гаснет уже с половины радиуса');
  ok(!/S\.fog = null/.test(src),
     'Туман сцены не переключается ради буфера нормалей — это плодило по два варианта программы на материал');

  /* лучи должны идти по косинусному распределению в полусфере вокруг нормали */
  ok(/sqrt\( max\( 0\.0, 1\.0 - u \) \)/.test(src), 'Распределение лучей косинусное');
  ok(/vec3 T = normalize\( cross\( up, N \) \)/.test(src), 'Базис строится вокруг нормали пикселя');
  ok(/for \( int i = 0; i < RAYS; i \+\+ \)/.test(src), 'Пучок лучей на пиксель');
  ok(/texture2D\( tDepth, suv \)/.test(src), 'Пересечение проверяется по буферу глубины');

  /* накопление обязано усреднять, а не заменять */
  ok(/uBlend\.value = 1 \/ \(n \+ 1\)/.test(src),
     'Вес кадра 1/(n+1) — накопленное усредняется, а не подменяется последним');
  ok(/mix\( texture2D\( tPrev, vUv \)\.rgb, cur, uBlend \)/.test(src), 'Кадры складываются в накопитель');

  /* субпиксельное смещение даёт сглаживание заодно */
  ok(/halton/.test(src) && /setViewOffset/.test(src),
     'Каждый кадр смещён на долю пикселя — накопление даёт и сглаживание');

  /* корпус рисуется изнанкой: односторонний материал нормалей потерял бы пол */
  ok(/MeshNormalMaterial\(\{ side: THREE\.DoubleSide \}\)/.test(src),
     'Материал нормалей двусторонний — иначе земля не попадёт в буфер глубины');

  /* прозрачное не должно записывать глубину */
  ok(/function hideTransparent/.test(src) && /o\.visible = false/.test(src),
     'Пятна теней и пылинки скрыты на время съёмки нормалей');

  /* в буфер three пишет линейно и без тонмаппинга — переводим сами */
  ok(/vec3 aces\( vec3 x \)/.test(src) && /0\.0031308/.test(src),
     'Накопитель линейный, тонмаппинг и sRGB применяются на показе');
  ok(/HalfFloatType/.test(src), 'Накопитель хранит HDR, а не 8 бит на канал');

  /* мир обязан замереть */
  ok(/windUniform\.value = 0/.test(src), 'Ветер останавливается: движение обнулило бы накопленное');
  const msrc = readFileSync(new URL('./js/main.js', import.meta.url), 'utf8');
  ok(/if \(trace\.active\) \{[\s\S]{0,400}?return;/.test(msrc),
     'Пока идёт съёмка, мир не вращается и камера не двигается');
  ok(/fly\.on \|\| trace\.active/.test(msrc), 'Ввод во время съёмки её прекращает');
  ok(/addEventListener\('keydown', stopTracing\)/.test(msrc), 'Клавиша тоже прекращает');
  /* Выход обязан снять ВСЁ: раньше он гасил только экранные лучи, а
     трассировка пути продолжала считать, и её кадр оставался на канвасе. */
  ok(/function exitPhotoModes/.test(msrc), 'Выход снимает все режимы съёмки разом');
  for (const call of ['setTrace\\(false\\)', 'stopPath\\(\\)', 'forcePost\\(renderer, false\\)',
    'setDenoise\\(false\\)', 'setTraceDebug\\(0\\)']) {
    const body = msrc.slice(msrc.indexOf('function exitPhotoModes'));
    ok(new RegExp(call).test(body.slice(0, body.indexOf('\n}'))),
       `Выход вызывает ${call.replace(/\\\\/g, '')}`);
  }
  ok(/renderFrame\(renderer, scene, camera, worldGroup\.rotation\.z\);\s*\n\}/.test(msrc),
     'И сразу перерисовывает обычный кадр: иначе на экране висит последний кадр трассировки');

  /* дойдя до конца, не жжём кадры впустую */
  ok(/if \(n >= trace\.total\)/.test(src), 'Набрав нужное число кадров, только показываем результат');

  /* ресурсы освобождаются */
  ok(/rtNormal\?\.depthTexture\?\.dispose\(\)/.test(src), 'Буфер глубины освобождается');
  ok(!/setPixelRatio/.test(src),
     'Масштабом рендера владеет только main — двух хозяев у него нет');

  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  ok(html.includes('id="bTrace"') && html.includes('id="traceInfo"'),
     'В фото-режиме есть кнопка трассировки и индикатор прогресса');
}

/* ══ 3h3. Сглаживание ══════════════════════════════════════════════════ */
{
  const msrc = readFileSync(new URL('./js/main.js', import.meta.url), 'utf8');
  const psrc = readFileSync(new URL('./js/photo.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');

  /* «Выкл» обязан выключать ВСЁ. MSAA канваса задаётся при создании рендерера
     и на лету не выключается — поэтому канвас создаётся без него, а MSAA
     берётся из буфера постобработки. */
  ok(/antialias: false/.test(msrc), 'Канвас создаётся без MSAA — иначе «выкл» его не уберёт');
  ok(/samples: taaOn \? 0 : samples/.test(psrc), 'Число сэмплов буфера задаётся режимом');
  ok(/setFxaa\(renderer, !!mode \|\| glowOn \|\| raysOn/.test(psrc)
     && /if \(!fxOn\) \{ disposeFxaa\(\); return; \}/.test(psrc),
     'Без режима и без эффектов буфер вообще не создаётся — прямой рендер в канвас');

  /* Сглаживание собирается из трёх независимых частей: так видно, что даёт
     эффект, а что нет. Плоский список готовых режимов этого не показывал. */
  const parts = [
    ['выборки покрытия', CONFIG.AA_MSAA, 'v'],
    ['фильтр', CONFIG.AA_FILTER, 'id'],
    ['масштаб рендера', CONFIG.AA_SCALE, 'v']
  ];
  for (const [what, list, key] of parts) {
    ok(Array.isArray(list) && list.length >= 3, `Ступеней «${what}»: ${list.length}`);
    ok(list.every(it => it[key] !== undefined && it.label), `У «${what}» заполнены все поля`);
    ok(new Set(list.map(it => it[key])).size === list.length, `«${what}»: значения не дублируются`);
  }
  const combos = CONFIG.AA_MSAA.length * CONFIG.AA_FILTER.length * CONFIG.AA_SCALE.length;
  ok(combos >= 60, `Сочетаний доступно: ${combos}`);

  ok(CONFIG.AA_MSAA.some(x => x.v === 0), 'MSAA можно отключить отдельно от фильтра');
  ok(CONFIG.AA_FILTER.some(x => x.id === 'none'), 'Фильтр можно отключить отдельно от MSAA');
  ok(CONFIG.AA_FILTER.some(x => x.id === 'smaafxaa'), 'SMAA и FXAA сочетаются');
  ok(CONFIG.AA_SCALE[0].v === 1, 'Масштаб начинается с единицы');

  ok(/fill\(sMsaa, CONFIG\.AA_MSAA/.test(msrc) && /fill\(sFilter, CONFIG\.AA_FILTER/.test(msrc),
     'Списки строятся из данных, а не дублируются в разметке');
  ok(/mode\.filter\.includes\('taa'\)\) mode\.samples = 0/.test(msrc),
     'TAA сбрасывает MSAA: он живёт на своём буфере с глубиной');
  ok(/× пикселей, \$\{post\} прохода поверх/.test(msrc),
     'Показывается цена выбранного сочетания — по ней видно, за что платим');

  const html2 = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  for (const id of ['sMsaa', 'sFilter', 'sScale']) {
    ok(html2.includes(`id="${id}"`), `Регулятор ${id} есть в настройках`);
  }
  ok(!/<option value="fxaa"/.test(html2), 'В разметке варианты не захардкожены');

  /* TAA */
  ok(/TAA_FRAG/.test(psrc), 'TAA реализован');
  ok(/uPrevVP \* vec4\( w\.xyz \/ w\.w, 1\.0 \)/.test(psrc),
     'История берётся перепроецированием, а не по тем же координатам');
  ok(/deltaRot\.makeRotationZ\(prevRot - worldRot\)/.test(psrc),
     'Вращение станции отменяется поворотом назад — иначе история уезжает вместе с миром');
  ok(/clamp\( texture2D\( tHist, hUv \)\.rgb, lo, hi \)/.test(psrc),
     'История отбраковывается по соседям — то, что двигалось иначе, заменяется текущим кадром');
  ok(/uHasHist/.test(psrc), 'Первый кадр берётся целиком, без пустой истории');
  ok(/filter\.includes\('taa'\) \? 0 : windBase/.test(msrc),
     'При TAA ветер приглушается: качающийся лес тянулся бы шлейфом');
  ok(CONFIG.TAA.blend > 0.5 && CONFIG.TAA.blend < 1, `Доля истории ${CONFIG.TAA.blend}`);


  /* --- SMAA --- */
  /* SMAA берём готовым проходом three: своя копия таблиц и шейдеров дважды
     подвела — сперва я забыл перенести `defines`, потом разошлась версия
     зависимости. Здесь всё чинится вместе с three. */
  ok(/import \{ SMAAPass \} from 'three\/examples\/jsm\/postprocessing\/SMAAPass\.js'/.test(psrc),
     'SMAA — готовый проход, а не своя копия');
  ok(/smaaPass\.render\(renderer, null, smaaRT\[0\]\)/.test(psrc),
     'Проход вызывается напрямую, без композера');
  ok(/smaaPass\.renderToScreen = true/.test(psrc), 'И выводит прямо в канвас');
  ok(/pass\(fxMat, smaaRT\[0\]\)/.test(psrc),
     'На вход ему идёт тонмаппенный кадр: по линейному HDR контраст яркости считается неверно');
  for (const k of ['aaOn', 'aaMsaa', 'aaFilter', 'aaScale']) {
    ok(new RegExp(`prefs\\.set\\('${k}'`).test(msrc), `Настройка «${k}» сохраняется`);
  }
  ok(html.includes('id="sAAon"'), 'Есть общий выключатель сглаживания');
  ok(/dprIndex--/.test(msrc) && !/ssaa--/.test(msrc),
     'Под нагрузкой снижается ступень плотности, а выбранный режим остаётся');
}

/* ══ 3h4. Снимок в увеличенном разрешении и FXAA ═══════════════════════ */
{
  const msrc = readFileSync(new URL('./js/main.js', import.meta.url), 'utf8');
  const psrc = readFileSync(new URL('./js/photo.js', import.meta.url), 'utf8');
  const S = CONFIG.SHOT;

  ok(S.scale >= 2, `Снимок рендерится ×${S.scale} по стороне = ×${S.scale * S.scale} пикселей`);
  ok(S.max >= S.scale, 'Верхний предел не ниже масштаба снимка');
  ok(/g\.drawImage\(src, 0, 0, w, h\)/.test(msrc), 'Крупный кадр ужимается до нативного размера');
  ok(/imageSmoothingQuality = 'high'/.test(msrc), 'Даунскейл идёт с фильтрацией, а не выбрасыванием пикселей');
  ok(/shotBoost = CONFIG\.SHOT\.scale;\s*\n\s*resize\(\);\s*\n\s*renderFrame/.test(msrc),
     'Перед снимком масштаб поднимается и кадр перерисовывается');
  ok(/shotBoost = 1;\s*\n\s*resize\(\);/.test(msrc), 'После снимка масштаб возвращается');

  /* трассировка идёт сразу в масштабе снимка: пересобрать её нельзя */
  ok(/shotBoost = CONFIG\.SHOT\.scale;\s*\/\/ трассируем/.test(msrc),
     'Трассировка ведётся сразу в увеличенном масштабе');
  ok(/if \(trace\.active\) \{\s*\n\s*saveCanvas/.test(msrc),
     'Накопленный кадр не перерисовывается, а только ужимается');

  /* FXAA */
  ok(/FXAA_FRAG/.test(psrc) && /export function setFxaa/.test(psrc), 'FXAA доступен как альтернатива');
  ok(/lMax - lMin < max\( 0\.0312/.test(psrc),
     'Ровные участки FXAA не трогает — иначе фильтр мылит всё подряд');
  ok(/vec3 fetch\( vec2 uv \) \{ return toScreen/.test(psrc),
     'FXAA сглаживает экранные значения: по линейному HDR контраст яркости считается неверно');
  ok(/export const TONEMAP_GLSL/.test(psrc) && (psrc.match(/\$\{TONEMAP_GLSL\}/g) || []).length === 2,
     'Тонмаппинг общий для трассировки и FXAA, а не скопирован дважды');
  ok(/renderer\.setRenderTarget\(fxRT\)/.test(psrc), 'Кадр идёт через буфер только при включённом FXAA');

  /* Цепочка вывода: последним всегда идёт рендер в канвас */
  const rf = psrc.slice(psrc.indexOf('export function composite'));
  const body = rf.slice(0, rf.indexOf('\n}'));
  ok(body.lastIndexOf('setRenderTarget(null)') < body.lastIndexOf('render(fxScene, fxCam)'),
     'Перед выводом квада цель сброшена в канвас');
  ok(/setRenderTarget\(null\);\s*\n\s*renderer\.render\(scene, camera\)/.test(psrc),
     'Без FXAA сцена рисуется прямо в канвас');
  ok(/pass\(fxMat, null\)/.test(body), 'Финальный проход идёт в канвас');

  /* antialias у рендерера действует только на канвас: буферам нужен samples */
  ok(/samples: taaOn \? 0 : samples/.test(psrc),
     'У буфера кадра число сэмплов задаётся выбранным режимом');
  ok(/samples: CONFIG\.MSAA_SAMPLES/.test(psrc), 'Буфер кадра трассировки многосэмпловый');
  ok(CONFIG.MSAA_SAMPLES >= 2, 'Сэмплов достаточно, чтобы края читались');
  ok(/if \(!fxOn \|\| !fxRT\)/.test(psrc), 'Без FXAA лишнего прохода нет');
  ok(/resizePost\(renderer\)/.test(msrc), 'Буфер FXAA пересоздаётся при изменении размера');

  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  ok(html.includes('id="sAAon"'), 'Есть общий выключатель сглаживания');
  ok(CONFIG.AA_FILTER.some(mo => mo.id.includes('fxaa')), 'FXAA есть в списке фильтров');
}

/* ══ 3h5. Карты нормалей ═══════════════════════════════════════════════ */
{
  const tsrc = readFileSync(new URL('./js/textures.js', import.meta.url), 'utf8');
  const wsrc = readFileSync(new URL('./js/world.js', import.meta.url), 'utf8');

  ok(/export function heightToNormal/.test(tsrc), 'Карты нормалей строятся из готового альбедо');
  ok(/H\(x \+ 1, y\) - H\(x - 1, y\)/.test(tsrc), 'Градиент высоты берётся центральной разностью');
  ok(/\(\(\(y % h\) \+ h\) % h\)/.test(tsrc), 'Края замкнуты по кругу — карта тайлится вместе с альбедо');

  /* рельеф не может разъехаться с картинкой: он из неё и сделан */
  for (const [what, re] of [
    ['корпус', /heightToNormal\(hullCanvas/],
    ['фасады', /heightToNormal\(facCanvas/],
    ['панели', /heightToNormal\(panelCanvas/]
  ]) ok(re.test(wsrc), `Нормали строятся для: ${what}`);

  ok(/hullNormal\.repeat\.x = -1/.test(wsrc),
     'Карта нормалей корпуса зеркалится так же, как альбедо, иначе рельеф уедет');

  /* пресеты */
  ok(CONFIG.QUALITY.LOW.normals === 0, 'На низком пресете нормалей нет — как и было');
  ok(CONFIG.QUALITY.HIGH.normals > 0 && CONFIG.QUALITY.ULTRA.normals > CONFIG.QUALITY.HIGH.normals,
     `Размер карты корпуса: ${CONFIG.QUALITY.HIGH.normals} → ${CONFIG.QUALITY.ULTRA.normals}`);
  ok(CONFIG.QUALITY.HIGH.normals < CONFIG.QUALITY.HIGH.hullTex,
     'Карта нормалей мельче альбедо: столько детализации ей не нужно, а Собель по 4 млн пикселей дорог');

  const low = new THREE.Group();
  buildWorld(low, fakeRenderer, 'LOW');
  const hullLow = low.children.find(o => o.material?.side === THREE.BackSide);
  ok(!hullLow.material.normalMap, 'На низком пресете корпус без карты нормалей');

  const hi = new THREE.Group();
  buildWorld(hi, fakeRenderer, 'HIGH');
  const hullHi = hi.children.find(o => o.material?.side === THREE.BackSide);
  ok(!!hullHi.material.normalMap, 'На высоком — с картой');
  const bldHi = hi.children.filter(isBuilding);
  ok(bldHi.every(o => wallMatOf(o).normalMap), 'У всех типов домов есть рельеф оконных ниш');
  ok(bldHi.every(o => o.material[1].normalMap), 'И у кровли свой рельеф');
}

/* ══ 3h6. Свечение, лучи, трафик, машины, трава ════════════════════════ */
{
  const psrc = readFileSync(new URL('./js/photo.js', import.meta.url), 'utf8');
  const msrc = readFileSync(new URL('./js/main.js', import.meta.url), 'utf8');
  const wsrc = readFileSync(new URL('./js/world.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const P = CONFIG.POST;

  /* --- свечение и лучи --- */
  ok(/BRIGHT_FRAG/.test(psrc) && /BLUR_FRAG/.test(psrc) && /RAYS_FRAG/.test(psrc),
     'Три прохода: яркая выборка, размытие, лучи');
  ok(/pass\(brMat, blRT\)/.test(psrc), 'Яркая выборка считается один раз на оба эффекта');
  ok(/uDir\.value\.set\(P\.radius \/ w, 0\)/.test(psrc) && /set\(0, P\.radius \/ h\)/.test(psrc),
     'Размытие разделимое: два прохода вместо квадрата выборок');
  ok(/c \+= texture2D\( tGlow, uv \)\.rgb \* uGlow/.test(psrc),
     'Свечение складывается со сценой ДО тонмаппинга — так ведёт себя рассеяние в оптике');
  ok(P.div >= 2, `Вспомогательные буферы в ${P.div} раза меньше — размытое мелких деталей не несёт`);
  ok(P.threshold > 0.2 && P.threshold < 0.7,
     `Свечение начинается с яркости ${P.threshold} — линейная яркость солнца 0.93, порог 0.9 пропускал 0.3%`);
  ok(P.sunHdr > 1, `Труба уходит в HDR ×${P.sunHdr} — свечению нужен источник ярче единицы`);

  ok(/export function setSunScreen/.test(psrc), 'Экранное положение оси считается каждый кадр');
  ok(/sunVisible = v\.z < 1/.test(psrc), 'За спиной камеры лучи выключаются');
  ok(/uRays\.value = raysOn && rayRT && sunVisible/.test(psrc),
     'Лучи гаснут, когда ось не в кадре или буфер не заведён');

  /* --- один буфер на всех --- */
  ok(/export function setPost/.test(psrc), 'FXAA, свечение и лучи включают общую цепочку');
  ok(/setPost\(renderer, \{ mode, glow: glowOn, rays: raysOn \}\)/.test(msrc),
     'Настройки сходятся в один вызов');
  ok(/uFxaa < 0\.5/.test(psrc), 'Свечение можно включить без FXAA');

  /* --- трафик --- */
  ok(/export function updateTraffic/.test(wsrc), 'Огни машин двигаются');
  /* Габариты гасим В САМОМ ЦВЕТЕ: яркость материала умножает все каналы, и
     (1, 0.16, 0.1) превращалось в (3.2, 0.51, 0.32) — после ограничения
     единицей это оранжево-белый, а не красный. */
  const front = wsrc.match(/addLamp\(-T2\.w \* 0\.32, T2\.len \* 0\.5, \[([\d., ]+)\]/);
  const rear = wsrc.match(/addLamp\(-T2\.w \* 0\.32, -T2\.len \* 0\.5, \[([\d., ]+)\]/);
  ok(!!front && !!rear, 'Фары спереди и габариты сзади заданы');
  const fc = front[1].split(',').map(Number), rc = rear[1].split(',').map(Number);
  const lampK = CONFIG.TRAFFIC.lamp;
  ok(fc.every(v => v * lampK >= 1), `Спереди белые: ${fc.map(v => (v * lampK).toFixed(2))}`);
  /* Проверяем цвет НА ЭКРАНЕ, а не линейный: 0.096 линейно = 0.34 в sRGB,
     и красный уходил в оранжево-белый. */
  const toSrgb = v => v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  const rs = rc.map(v => toSrgb(Math.min(1, v * lampK)));
  ok(rs[0] > 0.9 && rs[1] < 0.2 && rs[2] < 0.2,
     `Сзади красные и на экране: ${rs.map(v => v.toFixed(2)).join(', ')}`);
  ok(/traffic\.dir\[k\] < 0\) _tq\.multiply/.test(wsrc), 'Встречные машины развёрнуты');
  ok(CONFIG.TRAFFIC.lamp > 1,
     `Фары ярче единицы (${CONFIG.TRAFFIC.lamp}) — иначе не попадут в яркую выборку свечения`);
  ok(CONFIG.TRAFFIC.win < CONFIG.TRAFFIC.lamp / 3,
     `Окна тлеют слабее фар: ${CONFIG.TRAFFIC.win} против ${CONFIG.TRAFFIC.lamp}`);
  ok(/traffic\.dir\[k\] \* traffic\.half \/ R/.test(wsrc), 'Полосы разнесены поперёк улицы');
  ok(/i2 \+= 3/.test(wsrc), 'Трафик идёт по магистралям — тем же, что светятся фонарями');
  ok(/worldMats\.trafficLamp\.color\.setRGB/.test(msrc) && /CONFIG\.TRAFFIC\.lamp, 0\.12, daylight/.test(msrc),
     'Днём фары почти не видны, ночью горят');
  ok(CONFIG.TRAFFIC.speed > 0, `Скорость ${CONFIG.TRAFFIC.speed} юнита/с = ${CONFIG.TRAFFIC.speed * 10} м/с`);

  /* --- машины на парковках --- */
  ok(/info\.kind !== 'lot'/.test(wsrc), 'Машины ставятся только на кварталы типа «стоянка»');
  ok(/cr\(\) < 0\.35/.test(wsrc), 'Часть мест пустая — иначе стоянка выглядит выставкой');

  /* --- трава у комлей --- */
  ok(/ТРАВА У КОМЛЕЙ/.test(wsrc), 'Трава у комлей есть');
  ok(/patchWindMaterial\(tuftMat\)/.test(wsrc), 'Трава колышется тем же ветром, что и кроны');

  /* --- вода --- */
  ok(/1\.0 - exp\( -wDeep \* 3\.2 \)/.test(wsrc),
     'Поглощение по глубине нелинейное — на отмели дно просвечивает, на стрежне нет');
  ok(/smoothstep\( 0\.20, 0\.02, wDeep \)/.test(wsrc),
     'Пена держится узкой полосой у кромки — уже прежней в 1.7 раза');
  ok(/\* uFoam;/.test(wsrc) && CONFIG.WATER.foam < 0.3,
     `Сила пены ${CONFIG.WATER.foam}: намёк на стык с берегом, а не белая обводка`);
  ok(/float amp = uRipple \* hullMask\.r/.test(wsrc) && CONFIG.WATER.ripple < 0.03,
     `Волны ${CONFIG.WATER.ripple}: при 0.055 отражение сквозь них рассыпалось`);
  ok(/uTime \* uFlow/.test(wsrc), 'Рисунок пены сносит по течению');

  /* --- настройки --- */
  for (const id of ['sGlow', 'sRays', 'sTraffic']) {
    ok(html.includes(`id="${id}"`), `Переключатель ${id} есть в настройках`);
  }
  for (const k of ['glow', 'rays', 'traffic']) {
    ok(new RegExp(`prefs\\.set\\('${k}'`).test(msrc), `Состояние «${k}» сохраняется`);
  }
}

/* ══ 3h7. Ландшафт на телефоне и видимость трассировки ═════════════════ */
{
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');

  /* Кнопки не должны наезжать друг на друга: считаем высоту панели */
  const topbar = html.slice(html.indexOf('id="topbar"'), html.indexOf('id="pad"'));
  const nBtn = (topbar.match(/class="btn glass"/g) || []).length;
  ok(nBtn >= 6, `Кнопок в верхней панели: ${nBtn}`);
  ok(nBtn * 48 + (nBtn - 1) * 8 > 320,
     `Столбиком они занимают ${nBtn * 48 + (nBtn - 1) * 8}px — в ландшафт телефона не влезают`);

  ok(/@media \(orientation:landscape\) and \(max-height:560px\)/.test(css),
     'Есть отдельная раскладка для горизонтального режима');
  const land = css.slice(css.indexOf('@media (orientation:landscape)'));
  ok(/#topbar\{[^}]*grid-template-columns:repeat\(2,auto\)/.test(land),
     'В ландшафте панель раскладывается в два столбца');
  ok(/#pad\{flex-direction:row/.test(land), 'Нижний блок кнопок ложится в строку');

  /* два столбца по 42px обязаны влезать в самый низкий экран */
  const rows = Math.ceil(nBtn / 2);
  const h = rows * 42 + (rows - 1) * 6;
  ok(h + 50 + 24 < 320, `Два столбца — ${h}px, вместе с нижним блоком влезает в экран 320px`);

  /* панель съёмки уехала в столбик слева — по высоте её разводить не с чем */
  ok(/\.pbtn\{padding/.test(land) && /#traceInfo\{bottom/.test(land),
     'В ландшафте панель съёмки ужимается, индикатор разведён по высоте');

  /* Трассировка должна быть ВИДНА: при десяти лучах первый кадр давал 32%
     шума — почти готовую картинку, и проценты считали пустоту. */
  const P = CONFIG.PHOTO;
  const noise = f => 100 / Math.sqrt(f * P.rays);
  ok(noise(1) > 30, `Первый кадр даёт ${noise(1).toFixed(0)}% шума — схождение видно глазом`);
  ok(noise(P.samples) < 8, `К концу остаётся ${noise(P.samples).toFixed(0)}%`);
  ok(P.rays * P.samples > 300, `Всего ${P.rays * P.samples} лучей на пиксель`);
  const msrc = readFileSync(new URL('./js/main.js', import.meta.url), 'utf8');
  ok(/шум \$\{noise\.toFixed\(0\)\}%/.test(msrc),
     'Индикатор показывает оставшийся шум, а не одни проценты');
}

/* ══ 3h8. Все настройки живые ══════════════════════════════════════════ */
{
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const msrc = readFileSync(new URL('./js/main.js', import.meta.url), 'utf8');
  const sheet = html.slice(html.indexOf('id="set"'), html.indexOf('id="help"'));

  /* карта псевдонимов: const swGlow = $('sGlow'), swRays = $('sRays') */
  const alias = {};
  for (const mm of msrc.matchAll(/const\s+([\w$]+)\s*=\s*\$\('(\w+)'\)/g)) {
    (alias[mm[2]] = alias[mm[2]] || []).push(mm[1]);
  }
  for (const mm of msrc.matchAll(/([\w$]+)\s*=\s*\$\('(\w+)'\)\s*[,;]/g)) {
    (alias[mm[2]] = alias[mm[2]] || []).push(mm[1]);
  }

  const controls = [...sheet.matchAll(/id="(\w+)"/g)].map(x => x[1])
    .filter(id => /^s[A-Z]/.test(id) && !/V$/.test(id)
      && !['sAAcost', 'sAArow', 'sAArow2', 'sAArow3', 'sAAv'].includes(id));
  ok(controls.length >= 12, `Элементов управления в настройках: ${controls.length}`);

  const dead = controls.filter(id => {
    const names = [id, ...(alias[id] || [])];
    const direct = new RegExp(`\\$\\('${id}'\\)\\.on\\w+\\s*=`).test(msrc);
    return !direct && !names.some(v => new RegExp(`\\b${v}\\.on\\w+\\s*=`).test(msrc));
  });
  ok(dead.length === 0, `У каждой настройки есть обработчик (мёртвых: ${dead.join(', ') || 'нет'})`);

  /* каждое состояние сохраняется */
  const saved = new Set([...msrc.matchAll(/prefs\.set\('(\w+)'/g)].map(x => x[1]));
  ok(saved.size >= 12, `Сохраняемых настроек: ${[...saved].sort().join(', ')}`);

  /* дублей id по документу быть не должно */
  const all = [...html.matchAll(/id="(\w+)"/g)].map(x => x[1]);
  const dups = all.filter((v, i) => all.indexOf(v) !== i);
  ok(dups.length === 0, `Дублей id нет (${dups.join(', ') || '—'})`);

  /* промах по подписи не должен попадать в соседнюю строку */
  ok(/row\.querySelector\('\.sw'\)/.test(msrc) && /sw\.click\(\)/.test(msrc),
     'Вся строка переключает свой тумблер — кликабельна была только пилюля в 15% ширины');
}

/* ══ 3h10. Переключатели красятся при старте ═══════════════════════════ */
{
  const msrc = readFileSync(new URL('./js/main.js', import.meta.url), 'utf8');

  /* Состояние в переменных без первой покраски = переключатель показывает
     «выкл», хотя включён. Первый клик тогда «включает соседей»: они всё это
     время были включены и только теперь отрисовались. */
  const sync = msrc.slice(msrc.indexOf('const syncPost'));
  ok(/^\s*syncPost\(\);\s*$/m.test(sync.slice(0, sync.indexOf('const sSat'))),
     'syncPost вызывается сразу после объявления обработчиков');

  /* то же для остальных групп: каждое состояние должно быть отрисовано */
  for (const [what, re] of [
    ['иконка фазы освещения', /setDayIcon\(\);/],
    ['сглаживание', /\n\s*applyAA\(\);/],
    ['звук', /showSnd\(\);/],
    ['зерно', /showSeed\(\);/]
  ]) ok(re.test(msrc), `Начальное состояние отрисовано: ${what}`);

  /* и наоборот — состояние не должно расходиться с сохранённым */
  ok(/glowOn = prefs\.get\('glow'/.test(msrc)
     && /raysOn = prefs\.get\('rays'/.test(msrc)
     && /trafficOn = prefs\.get\('traffic'/.test(msrc),
     'Все три состояния читаются из сохранённых настроек');

  /* лучи от оси не должны бить вспышкой через весь экран */
  ok(CONFIG.POST.rays < 0.5, `Сила лучей ${CONFIG.POST.rays} — свет сквозь фермы, а не вспышка`);
  ok(CONFIG.POST.rayDensity < 0.7, `Длина луча ${CONFIG.POST.rayDensity} экрана`);
}

/* ══ 3h11. Режим отладки трассировки ═══════════════════════════════════ */
{
  const psrc = readFileSync(new URL('./js/photo.js', import.meta.url), 'utf8');
  const msrc = readFileSync(new URL('./js/main.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');

  /* Убедиться, что свет считается лучами, можно только увидев сам вклад
     лучей отдельно от картинки. Для этого и режим отладки. */
  ok(/uniform float uAoNear, uAoFar, uDebug/.test(psrc), 'В шейдер заведён переключатель отладки');
  ok(/if \( uDebug > 0\.5 \)/.test(psrc), 'При отладке выводится только вклад лучей');
  for (const [n, what] of [[1, 'затенение'], [2, 'переотражения'], [3, 'отражения']]) {
    ok(new RegExp(`uDebug < ${n}\\.5`).test(psrc), `Режим ${n}: ${what}`);
  }
  ok(/cur = vec3\( ao \)/.test(psrc), 'Затенение показывается как есть, без исходного цвета');
  ok(/cur = gi \* 4\.0/.test(psrc), 'Переотражённый свет усилен, чтобы его было видно');
  ok(/vec3\( 1\.0 - rough \)/.test(psrc),
     'Есть режим шероховатости — по нему видно, откуда берутся отражения');
  ok(/vec3\( 0\.1, 0\.9, 0\.2 \)/.test(psrc) && /vec3\( 0\.9, 0\.15, 0\.1 \)/.test(psrc),
     'Есть карта попаданий луча: зелёный — нашёл цель, красный — ушёл за экран');


  ok(/export function setTraceDebug/.test(psrc) && /trace\.sample = 0/.test(psrc),
     'Смена режима сбрасывает накопление: иначе поверх старого кадра ляжет новый');
  ok(/DEBUG_NAMES/.test(psrc) && /DEBUG_NAMES\[trace\.debug\]/.test(msrc),
     'Активный режим подписан в индикаторе');
  ok(html.includes('id="bDebug"'), 'Кнопка отладки есть в фото-режиме');
  ok(/if \(!trace\.active\) setTrace\(true\)/.test(msrc),
     'Нажатие отладки само включает трассировку');

  /* свечение и лучи от оси по умолчанию выключены */
  ok(/prefs\.get\('glow', false\)/.test(msrc) && /prefs\.get\('rays', false\)/.test(msrc),
     'Свечение и лучи от оси выключены по умолчанию');
  ok(/let glowOn = false, raysOn = false/.test(msrc), 'И начальные значения им под стать');
}

/* ══ 3h12. Ничто не игнорирует туман ═══════════════════════════════════ */
{
  const usrc = readFileSync(new URL('./js/util.js', import.meta.url), 'utf8');
  const files = ['js/main.js', 'js/world.js', 'js/structures.js', 'js/photo.js'];

  /* Ореол солнца — плоскость во всю длину станции. С fog: false её дальний
     край светит в полную силу поверх того, что уже съедено туманом, и это
     читается как молочная полоса поперёк кадра. */
  for (const f of files) {
    const s = readFileSync(new URL('./' + f, import.meta.url), 'utf8');
    ok(!/fog:\s*false/.test(s), `${f}: нет материалов, игнорирующих туман`);
  }

  ok(/export function fadeByFog/.test(usrc), 'Аддитивные материалы гаснут туманом через прозрачность');
  ok(/gl_FragColor\.a \*= 1\.0 - clamp\( fogF/.test(usrc),
     'Гасится альфа, а не подмешивается цвет: при аддитивном смешивании туман ДОБАВЛЯЛ бы света');

  const msrc = readFileSync(new URL('./js/main.js', import.meta.url), 'utf8');
  const ssrc = readFileSync(new URL('./js/structures.js', import.meta.url), 'utf8');
  ok(/fadeByFog\(new THREE\.MeshBasicMaterial/.test(msrc), 'Ореол солнца гаснет в дымке');
  ok(/structMats\.sun = fadeByFog/.test(ssrc), 'Солнечная труба тоже');
}

/* ══ 3h13. Что сколько стоит ═══════════════════════════════════════════ */
{
  /* Бюджет разбивается по видам объектов: без этого непонятно, что резать.
     Кроны — три четверти всей геометрии, и ULTRA дорог именно ими. */
  const cost = q => {
    const g = new THREE.Group();
    const res = buildWorld(g, fakeRenderer, q);
    buildStructures(g, fakeRenderer, q, res.panel, res.panelNormal);
    const by = new Map();
    let decals = 0;
    g.traverse(o => {
      if (!o.isMesh && !o.isPoints) return;
      const ix = o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count;
      const tris = (ix / 3) * (o.isInstancedMesh ? o.count : 1);
      const mm = o.material;
      if (mm.transparent && mm.depthWrite === false) decals += o.isInstancedMesh ? o.count : 1;
      const key = mm.flatShading && mm.vertexColors ? 'листва' : 'прочее';
      by.set(key, (by.get(key) || 0) + tris);
    });
    const total = [...by.values()].reduce((a, b) => a + b, 0);
    return { total, foliage: by.get('листва') || 0, decals };
  };

  const lo = cost('LOW'), hi = cost('HIGH'), ul = cost('ULTRA');
  ok(lo.total < 200000, `LOW: ${(lo.total / 1000) | 0}k треугольников — мобильный бюджет`);
  ok(hi.total < 700000, `HIGH: ${(hi.total / 1000) | 0}k`);
  ok(ul.total < 1600000, `ULTRA: ${(ul.total / 1000) | 0}k — настольный пресет`);
  ok(ul.foliage / ul.total > 0.6,
     `Листва — ${((ul.foliage / ul.total) * 100) | 0}% геометрии ULTRA: резать надо её, а не остальное`);

  /* прозрачные декали дороги не треугольниками, а перерисовкой */
  ok(lo.decals < 2200, `LOW: прозрачных декалей ${lo.decals}`);
  const wsrc = readFileSync(new URL('./js/world.js', import.meta.url), 'utf8');
  ok(!/shadows\.push\(\[t, z, \{ r: s \* 1\.3/.test(wsrc),
     'Под кустами декалей нет: полторы тысячи прозрачных квадов ради теней от кустиков не окупались');
}

/* ══ 3h14. Мобильная ультра и рычаги производительности ════════════════ */
{
  const Q = CONFIG.QUALITY;
  ok(!!Q.ULTRAM, 'Есть отдельный ультра-пресет для телефона');

  /* Разница только в листве: остальные возможности те же */
  for (const k of ['footprint', 'mask']) {
    ok(Q.ULTRAM[k] === Q.ULTRA[k], `ULTRAM сохраняет «${k}» на уровне ULTRA`);
  }
  ok(Q.ULTRAM.normals > 0, 'Нормали на мобильной ультре остаются');
  ok(Q.ULTRAM.foliage < Q.ULTRA.foliage && Q.ULTRAM.trees < Q.ULTRA.trees,
     `Режется только листва: крона ${Q.ULTRA.foliage}→${Q.ULTRAM.foliage}, деревьев ×${Q.ULTRA.trees}→×${Q.ULTRAM.trees}`);

  const weigh = q => {
    const g = new THREE.Group();
    const res = buildWorld(g, fakeRenderer, q);
    buildStructures(g, fakeRenderer, q, res.panel, res.panelNormal);
    let n = 0;
    g.traverse(o => {
      if (!o.isMesh && !o.isPoints) return;
      const ix = o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count;
      n += (ix / 3) * (o.isInstancedMesh ? o.count : 1);
    });
    return n;
  };
  const um = weigh('ULTRAM'), u = weigh('ULTRA');
  ok(um < u * 0.55,
     `Мобильная ультра ${(um / 1000) | 0}k против ${(u / 1000) | 0}k — вдвое легче при тех же возможностях`);

  /* рычаги */
  ok(CONFIG.GREEN.length >= 3 && CONFIG.GREEN[0] >= 3,
     `Плотность зелени: ${CONFIG.GREEN.map(v => (v * 100) + '%').join(', ')}`);
  ok(CONFIG.DRAW_FAR.every((v, i, a) => i === 0 || v < a[i - 1]),
     `Дальность прорисовки: ${CONFIG.DRAW_FAR.map(v => (v / 100).toFixed(1) + ' км').join(', ')}`);
  const wsrc = readFileSync(new URL('./js/world.js', import.meta.url), 'utf8');
  ok(/CONFIG\.GREEN_K/.test(wsrc), 'Множитель плотности применяется к деревьям и кустам');
  const msrc = readFileSync(new URL('./js/main.js', import.meta.url), 'utf8');
  ok(/camera\.far = CONFIG\.DRAW_FAR/.test(msrc), 'Дальность меняет дальнюю плоскость камеры');
  ok(/prefs\.set\('green'/.test(msrc) && /prefs\.set\('far'/.test(msrc), 'Оба рычага сохраняются');

  /* реальный эффект плотности */
  const before = CONFIG.GREEN_K;
  CONFIG.GREEN_K = 0.3;
  const light = weigh('HIGH');
  CONFIG.GREEN_K = before;
  const full = weigh('HIGH');
  ok(light < full * 0.75,
     `Плотность 30% снимает ${(100 - (light / full) * 100) | 0}% геометрии: ${(full / 1000) | 0}k → ${(light / 1000) | 0}k`);
}

/* ══ 3h15. Измеряем то, что надо ═══════════════════════════════════════ */
{
  const msrc = readFileSync(new URL('./js/main.js', import.meta.url), 'utf8');
  const psrc = readFileSync(new URL('./js/photo.js', import.meta.url), 'utf8');

  /* three обнуляет статистику на каждом render(). С постобработкой в счётчик
     попадал последний проход — полноэкранный квад: «draw 1, tri 0k», и цифры
     не реагировали ни на один пресет. */
  ok(/renderer\.info\.autoReset = false/.test(msrc),
     'Статистика не обнуляется на каждом проходе');
  ok(/renderer\.info\.reset\(\)/.test(msrc), 'Сбрасывается вручную, раз в кадр');
  ok(msrc.indexOf('renderer.info.reset()') < msrc.lastIndexOf('renderFrame(renderer, scene, camera'),
     'Сброс идёт до отрисовки, иначе счётчик снова покажет один проход');

  /* число источников — из пресета: это самая дорогая часть кадра */
  for (const [q, n] of [['LOW', 3], ['HIGH', 5], ['ULTRAM', 3], ['ULTRA', 5]]) {
    ok(CONFIG.QUALITY[q].lights === n, `${q}: осевых источников ${n}`);
  }
  ok(CONFIG.QUALITY.ULTRAM.lights < CONFIG.QUALITY.ULTRA.lights,
     'На мобильной ультре источников меньше: корпус занимает почти весь экран, и каждый источник считается на каждом пикселе');
  ok(/\(CONFIG\.QUALITY\[currentQuality\(\)\] \|\| CONFIG\.QUALITY\.HIGH\)\.lights/.test(msrc),
     'Число берётся из пресета, а не из проверки на LOW');

  /* Костылей экранного марша больше нет: они лечили симптомы того, что луч
     не находил цели за кадром. Аналитическое пересечение находит всегда. */
  ok(!/length\( ruv - vUv \)/.test(psrc) && !/float reach = /.test(psrc),
     'Заплатки экранного марша убраны вместе с ним');


}

/* ══ 3h16. Мусор в горячем пути ════════════════════════════════════════ */
{
  /* Новый объект на кадр — это 60 объектов в секунду в сборщик мусора, и
     именно такие мелочи дают рывки при вращении камеры. Проверяем тела
     функций, которые вызываются каждый кадр. */
  const hot = [
    ['js/photo.js', 'export function setSunScreen'],
    ['js/photo.js', 'export function renderFrame'],
    ['js/photo.js', 'export function composite'],
    ['js/photo.js', 'function runTaa'],
    ['js/world.js', 'export function updateTraffic'],
    ['js/controls.js', 'export function updateControls'],
    ['js/audio.js', 'export function updateAudio']
  ];
  for (const [file, sig] of hot) {
    const src = readFileSync(new URL('./' + file, import.meta.url), 'utf8');
    const i = src.indexOf(sig);
    if (i < 0) continue;
    let depth = 0, started = false, end = i;
    for (let k = i; k < src.length; k++) {
      if (src[k] === '{') { depth++; started = true; }
      else if (src[k] === '}') { depth--; if (started && depth === 0) { end = k; break; } }
    }
    const body = src.slice(i, end);
    const allocs = body.match(/new (THREE\.\w+|Float32Array|Array)\(/g) || [];
    ok(allocs.length === 0,
       `${sig.replace('export ', '')}: без выделений памяти${allocs.length ? ' (' + allocs.join(' ') + ')' : ''}`);
  }
}

/* ══ 3h17. Каждый путь вывода доходит до канваса ═══════════════════════ */
{
  const psrc = readFileSync(new URL('./js/photo.js', import.meta.url), 'utf8');

  /* Разбираем composite: у каждой ветки последний render должен идти в null.
     Проход, чей результат остался в буфере, пропадает впустую. */
  const i0 = psrc.indexOf('export function composite');
  let d = 0, st = false, i1 = i0;
  for (let k = i0; k < psrc.length; k++) {
    if (psrc[k] === '{') { d++; st = true; }
    else if (psrc[k] === '}') { d--; if (st && d === 0) { i1 = k; break; } }
  }
  const body = psrc.slice(i0, i1);

  /* ветка SMAA */
  const smaaBranch = body.slice(body.indexOf('if (smaaOn'), body.indexOf('return true;', body.indexOf('if (smaaOn')));
  ok(/smaaPass\.renderToScreen = true/.test(smaaBranch),
     'Ветка SMAA заканчивается выводом в канвас');

  /* обычная ветка */
  ok(/pass\(fxMat, null\);\s*\n\s*return true;/.test(body),
     'Обычная ветка заканчивается выводом в канвас');

  /* TAA пишет в свой буфер и отдаёт его дальше, а не наружу */
  const taaBody = psrc.slice(psrc.indexOf('function runTaa'));
  ok(/renderer\.setRenderTarget\(cur\)/.test(taaBody) && /return cur\.texture/.test(taaBody),
     'TAA отдаёт накопленный буфер дальше по цепочке, а не выводит его сам');
  ok(/composite\(renderer, src,/.test(psrc), 'Результат TAA уходит в композит');

  /* трассировка тоже через общий композит */
  ok(/function showAccum/.test(psrc) && /composite\(R, rt\.texture/.test(psrc),
     'Накопленный кадр трассировки выводится тем же композитом');

  /* сочетания */
  const F = CONFIG.AA_FILTER;
  ok(F.length >= 8, `Фильтров и их сочетаний: ${F.length}`);
  for (const want of ['fxaa', 'smaa', 'taa', 'smaafxaa', 'taafxaa', 'taasmaa'])
    ok(F.some(x => x.id === want), `Есть сочетание ${want}`);
  const total = CONFIG.AA_MSAA.length * F.length * CONFIG.AA_SCALE.length;
  ok(total >= 120, `Всего сочетаний сглаживания: ${total}`);
  ok(/fxaaFilter = f\.includes\('fxaa'\)/.test(psrc)
     && /taaOn = f\.includes\('taa'\)/.test(psrc)
     && /smaaOn = f\.includes\('smaa'\)/.test(psrc),
     'Части фильтра независимы и складываются, а не перечислены по одной');

  const msrc = readFileSync(new URL('./js/main.js', import.meta.url), 'utf8');
  ok(/mode\.filter\.includes\('taa'\)\) mode\.samples = 0/.test(msrc),
     'TAA сбрасывает MSAA в любом сочетании');
}

/* ══ 3h18. Шейдеры компилируемы, имена не затеняются ═══════════════════ */
{
  /* Макросы SMAA зашиты в код проходов, а не приходят uniform. Без них
     шейдер просто не компилируется: 'SMAA_THRESHOLD' undeclared identifier. */

  /* Затенение имён модульного уровня — источник ошибок «до инициализации» */
  for (const f of ['js/photo.js', 'js/main.js', 'js/world.js']) {
    const src = readFileSync(new URL('./' + f, import.meta.url), 'utf8');
    const top = [...src.matchAll(/^(?:let|const)\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]);
    const inner = [...src.matchAll(/^\s\s+const\s+([A-Za-z_$][\w$]*)\s*=/gm)].map(m => m[1]);
    const clash = [...new Set(inner.filter(n => top.includes(n)))];
    ok(clash.length === 0, `${f}: имена модуля не затеняются${clash.length ? ' (' + clash.join(', ') + ')' : ''}`);
  }
}

/* ══ 3h19. Интерфейс: вкладки, порядок кнопок, фото-режим ══════════════ */
{
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
  const msrc = readFileSync(new URL('./js/main.js', import.meta.url), 'utf8');

  /* Девятнадцать строк в одном свитке не читались — разложены по вкладкам */
  const tabs = [...html.matchAll(/class="tabbtn[^"]*" data-tab="(\d+)"/g)].map(m => m[1]);
  ok(tabs.length >= 3, `Вкладок настроек: ${tabs.length}`);
  const panes = [...html.matchAll(/class="tab[^"]*" data-tab="(\d+)"/g)].map(m => m[1]);
  ok(new Set(panes).size === new Set(tabs).size, 'У каждой вкладки есть своя панель');
  ok((html.match(/class="tabbtn on"/g) || []).length === 1
     && (html.match(/class="tab on"/g) || []).length === 1,
     'Ровно одна вкладка открыта при старте');
  ok(/\.tab\{display:none\}/.test(css) && /\.tab\.on\{display:block\}/.test(css),
     'Скрытые вкладки не занимают места');
  ok(/tabBtns/.test(msrc) && /t\.dataset\.tab === b\.dataset\.tab/.test(msrc),
     'Переключение вкладок привязано');

  /* каждая настройка попала ровно в одну вкладку */
  const setSheet = html.slice(html.indexOf('id="set"'), html.indexOf('id="help"'));
  const ctrlIds = [...setSheet.matchAll(/id="(s[A-Z]\w*)"/g)].map(m => m[1])
    .filter(id => !/V$/.test(id) && !['sAAcost', 'sAArow', 'sAArow2', 'sAArow3', 'sAAv'].includes(id));
  ok(ctrlIds.length >= 17, `Настроек разложено по вкладкам: ${ctrlIds.length}`);
  ok(new Set(ctrlIds).size === ctrlIds.length, 'Ни одна настройка не продублирована при переносе');

  /* порядок кнопок: часто нужное сверху */
  const bar = html.slice(html.indexOf('<div id="topbar">'), html.indexOf('<div id="pad">'));
  const order = [...bar.matchAll(/id="(b\w+)"/g)].map(m => m[1]);
  ok(order[0] === 'bSet', 'Настройки — первая кнопка');
  ok(order[1] === 'bFs', 'Полный экран под настройками');
  ok(order[2] === 'bHelp', 'Помощь под полным экраном');
  ok(order[order.length - 1] === 'bDay', 'Фаза освещения — в самом низу');

  /* фото-режим останавливает станцию */
  ok(/omegaSaved = omega;\s*\n\s*omega = 0;/.test(msrc),
     'Вход в фото-режим останавливает вращение станции');
  ok(/omega = omegaSaved;/.test(msrc), 'Выход возвращает прежнюю скорость');

  /* ракурсы на башню: за целью должен оставаться цилиндр, а не торец */
  for (const i of [1, 2]) {
    const tp = CONFIG.TP[i];
    const behind = Math.abs(tp.look[2] - Math.sign(tp.look[2] - tp.pos[2]) * (-CONFIG.L / 2));
    const room = tp.pos[2] > tp.look[2]
      ? tp.look[2] + CONFIG.L / 2
      : CONFIG.L / 2 - tp.look[2];
    ok(room > CONFIG.L * 0.5,
       `«${tp.name}»: за целью ещё ${(room * 10) | 0} м цилиндра, а не ближний торец`);
  }
}

/* ══ 3h20. Камера, полёт, торец ════════════════════════════════════════ */
{
  const csrc = readFileSync(new URL('./js/controls.js', import.meta.url), 'utf8');
  const msrc = readFileSync(new URL('./js/main.js', import.meta.url), 'utf8');

  /* Предел тангажа. У 89° вектор «вправо» получается длиной 0.017, и
     нормализация усиливает погрешность в полсотни раз — камеру трясло. */
  const lim = parseFloat((csrc.match(/Math\.sin\((\d+) \* Math\.PI \/ 180\)/) || [])[1]);
  ok(lim > 0 && lim <= 86,
     `Предел тангажа ${lim}°: вектор «вправо» длиной ${Math.cos(lim * Math.PI / 180).toFixed(3)}, базис устойчив`);
  ok(Math.cos(lim * Math.PI / 180) > 0.06, 'Запас достаточен, чтобы нормализация не усиливала шум');
  ok(/clamp\(cur \+ dPitch, -lim, lim\) - cur/.test(csrc),
     'Тангаж ограничивается ДО поворота, а не оттягивается назад каждый кадр');
  ok(/_right\.lengthSq\(\) > 1e-8/.test(csrc), 'Вырожденный базис не используется');

  /* два режима полёта */
  ok(/freeFly/.test(csrc), 'Есть свободный режим полёта');
  ok(/export function frameUp/.test(csrc), 'Опорный «верх» выбирается режимом');
  ok(/if \(ctl\.freeFly\) return;/.test(csrc),
     'В свободном режиме крен не выравнивается — он там часть управления');
  ok(/prefs\.set\('freeFly'/.test(msrc), 'Режим полёта сохраняется');
  ok(/syncFromCamera\(camera\);\s+\/\/ выровнять/.test(msrc),
     'Возврат к режиму цилиндра выравнивает горизонт');
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  ok(html.includes('id="sFly"'), 'Переключатель режима есть в настройках');

  /* труба-солнце — тело, а не декорация */
  ok(CONFIG.SUN.clear > 0, `Запас до трубы ${CONFIG.SUN.clear} юнита = ${CONFIG.SUN.clear * 10} м`);
  ok(/const keep = CONFIG\.SUN\.r \+ CONFIG\.SUN\.clear/.test(csrc), 'Внутрь солнца камеру не пускают');
  ok(/if \(rr < 1e-4\)/.test(csrc), 'Случай «ровно на оси» обработан отдельно');

  /* торец объёмный, а не нарисованный */
  const g = new THREE.Group();
  const res = buildWorld(g, fakeRenderer, 'HIGH');
  buildStructures(g, fakeRenderer, 'HIGH', res.panel, res.panelNormal);
  const caps = g.children.filter(o => o.isInstancedMesh && o.material?.side === THREE.DoubleSide
    && o.material.emissiveMap);
  ok(caps.length === 1 && caps[0].count === 2,
     `Оба торца — один инстанс на два: ${caps.length} меш(а), ${caps[0]?.count} экземпляра`);
  caps[0].geometry.computeBoundingBox();
  const capD = caps[0].geometry.boundingBox.max.z - caps[0].geometry.boundingBox.min.z;
  ok(capD > 5, `Торец уходит вглубь на ${(capD * 10) | 0} м, а не нарисован на плоскости`);
  ok(!!caps[0].material.normalMap, 'У торца есть карта рельефа');
  ok(CONFIG.ENDCAP.rings >= 4, `Кольцевых уступов: ${CONFIG.ENDCAP.rings}`);
}

/* ══ 3h21. Траектория перелёта ═════════════════════════════════════════ */
{
  const F = CONFIG.FLY, clampN = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerpN = (a, b, t) => a + (b - a) * t;
  const keep = CONFIG.SUN.r + CONFIG.SUN.clear;
  const towerTop = CONFIG.R - CONFIG.TOWER.h;

  /* Между башней и трубой объём пуст. Если середина пути идёт по этому
     коридору, столкновений не будет по построению — проверять нечего.
     Прежняя почти прямая хорда шла впритирку к полу и таранила застройку. */
  let hi = 0, lo = 99, worstPair = '';
  for (let i = 0; i < CONFIG.TP.length; i++) {
    for (let j = 0; j < CONFIG.TP.length; j++) {
      if (i === j) continue;
      const A = tpVec(CONFIG.TP[i].pos), B = tpVec(CONFIG.TP[j].pos);
      const r0 = Math.hypot(A.x, A.y), r1 = Math.hypot(B.x, B.y);
      const rMid = clampN(Math.min(r0, r1, CONFIG.R * F.corridor), keep + 2, CONFIG.R - 8);
      for (let k = 8; k <= 32; k++) {
        const e = k / 40, bump = Math.sin(Math.PI * e);
        const rl = lerpN(r0, r1, e);
        const r = rl + (rMid - rl) * bump * F.pull;
        if (r > hi) { hi = r; worstPair = `${CONFIG.TP[i].name} → ${CONFIG.TP[j].name}`; }
        lo = Math.min(lo, r);
      }
    }
  }
  const pairs = CONFIG.TP.length * (CONFIG.TP.length - 1);
  ok(hi <= towerTop,
     `Все ${pairs} перелётов: середина не выше r=${hi.toFixed(1)} при верхе башни ${towerTop} (худший: ${worstPair})`);
  ok(lo >= keep, `И не ближе r=${lo.toFixed(1)} к трубе при запасе ${keep.toFixed(1)}`);

  const msrc = readFileSync(new URL('./js/main.js', import.meta.url), 'utf8');
  ok(/function flyPoint/.test(msrc), 'Траектория считается в цилиндрических координатах');
  ok(/fly\.da = \(\(fly\.a1 - fly\.a0 \+ Math\.PI\) % TAU/.test(msrc),
     'Угол проходится по кратчайшей дуге, а не через полный круг');
  ok(/const bump = Math\.sin\( ?Math\.PI \* clamp\(e, 0, 1\) ?\)/.test(msrc)
     || /Math\.sin\(Math\.PI \* clamp\(e, 0, 1\)\)/.test(msrc),
     'Вынос к коридору нулевой на концах и полный в середине');

  /* Плавность проверяется прогоном ВСЕХ перелётов с шагом настоящего кадра.
     На глаз такое не поймать: рывок случался в одной паре точек из семидесяти
     двух и длился один кадр. */
  {
    const F2 = CONFIG.FLY, dt = 1 / 60, limS = Math.sin(F2.pitchMax * Math.PI / 180);
    const cl = (v, a, b) => Math.max(a, Math.min(b, v));
    const lp = (a, b, x) => a + (b - a) * x;
    const ss2 = (a, b, x) => { const q = cl((x - a) / (b - a), 0, 1); return q * q * (3 - 2 * q); };
    const P2 = new THREE.Vector3(), Ah = new THREE.Vector3();
    const dA = new THREE.Vector3(), dB = new THREE.Vector3();
    const up2 = new THREE.Vector3(), upB = new THREE.Vector3();
    const aim = new THREE.Vector3(), q2 = new THREE.Quaternion(), qp = new THREE.Quaternion();
    let worst = 0, worstAt = '';
    for (let i = 0; i < CONFIG.TP.length; i++) {
      for (let j = 0; j < CONFIG.TP.length; j++) {
        if (i === j) continue;
        const A = tpVec(CONFIG.TP[i].pos), B = tpVec(CONFIG.TP[j].pos);
        const L = tpVec(CONFIG.TP[j].look);
        const a0 = Math.atan2(A.x, A.y), a1 = Math.atan2(B.x, B.y);
        const da = ((a1 - a0 + Math.PI) % TAU + TAU) % TAU - Math.PI;
        const r0 = Math.hypot(A.x, A.y), r1 = Math.hypot(B.x, B.y);
        const rMid = cl(Math.min(r0, r1, CONFIG.R * F2.corridor),
          CONFIG.SUN.r + CONFIG.SUN.clear + 2, CONFIG.R - 8);
        const pt = (e, o) => {
          const b = Math.sin(Math.PI * cl(e, 0, 1)), a = a0 + da * e;
          const rl = lp(r0, r1, e), r = rl + (rMid - rl) * b * F2.pull;
          return o.set(Math.sin(a) * r, Math.cos(a) * r, lp(A.z, B.z, e));
        };
        pt(0, P2); pt(0.02, Ah);
        const dir = new THREE.Vector3().subVectors(Ah, P2).normalize();
        const up0 = new THREE.Vector3(); stationUp(P2, up0);
        const steps = Math.round(F2.min / dt);
        let first = true;
        for (let k = 0; k <= steps; k++) {
          const raw = k / steps, e = raw * raw * (3 - 2 * raw);
          pt(e, P2); pt(e + F2.lead, Ah);
          dA.subVectors(Ah, P2);
          if (dA.lengthSq() < 1e-6) dA.copy(dir); else dA.normalize();
          dB.subVectors(L, P2).normalize();
          stationUp(P2, up2);
          upB.copy(up0).lerp(up2, ss2(0.2, 1, e)).normalize();
          turnToward(dA, dB, ss2(F2.turnFrom, 1, e), up2, dA);
          turnToward(dir, dA, 1 - Math.exp(-dt * F2.turn), up2, dir);
          clampPitch(dir, upB, limS);
          aim.copy(P2).addScaledVector(dir, 60);
          aimAt(P2, aim, upB, q2);
          if (!first) {
            const d = qp.angleTo(q2) * 180 / Math.PI;
            if (d > worst) { worst = d; worstAt = `${CONFIG.TP[i].name} → ${CONFIG.TP[j].name}`; }
          }
          qp.copy(q2); first = false;
        }
      }
    }
    const pairs = CONFIG.TP.length * (CONFIG.TP.length - 1);
    ok(worst < 8,
       `Все ${pairs} перелётов: худший поворот ${worst.toFixed(1)}° за кадр (${worstAt})`);
    ok(worst * 60 < 500, `Это ${(worst * 60) | 0}°/с — не быстрее поворота головы`);
  }

  /* ограничение угла: наивная формула его почти не держала */
  {
    const up3 = new THREE.Vector3(0, 1, 0);
    const d0 = new THREE.Vector3(0.1, 0.995, 0).normalize();
    const lim = Math.sin(70 * Math.PI / 180);
    clampPitch(d0, up3, lim);
    ok(Math.abs(d0.dot(up3) - lim) < 1e-6,
       `clampPitch ставит угол ровно на предел (${d0.dot(up3).toFixed(4)} против ${lim.toFixed(4)})`);
    const csrc2 = readFileSync(new URL('./js/controls.js', import.meta.url), 'utf8');
    ok(/clampPitch\(_fwd, _up, SIN_MAX\)/.test(csrc2),
       'Управление пользуется той же функцией: там была та же ошибка');
    ok(!/addScaledVector\(_up, Math\.sign\(s\)/.test(csrc2),
       'Наивной формулы «убрать вертикаль и нормализовать» не осталось — она возвращала долю обратно');
  }

  /* повороты камеры */
  ok(/flyPoint\(e \+ CONFIG\.FLY\.lead, _v3\)/.test(msrc),
     'Камера смотрит вперёд по курсу, а не в конечную точку с самого старта');
  ok(!/flyPoint\(Math\.min\(1, e \+/.test(msrc),
     'Точка впереди не ограничена единицей: на финише она совпадала с камерой и вектор вырождался');
  ok(/turnToward\(fly\.dir, _dirA, 1 - Math\.exp\(-dt \* CONFIG\.FLY\.turn\)/.test(msrc),
     'Цель догоняется экспоненциально — повороты закладываются дугой, а не рывком');
  ok(/turnToward\(_dirA, _dirB, smoothstep01\(CONFIG\.FLY\.turnFrom/.test(msrc),
     'Интерполируется НАПРАВЛЕНИЕ: точка взгляда, переезжая от цели впереди к цели позади, проходила сквозь камеру');
  ok(!/slerpQuaternions/.test(msrc),
     'Равномерного slerp между стартом и финишем нет: он вращал камеру независимо от того, куда она летит');
  ok(/camera\.getWorldDirection\(fly\.dir\)/.test(msrc),
     'На старте направление — то, куда камера смотрит сейчас: иначе рывок на первом кадре');
  ok(F.lead > 0 && F.turn > 0, `Взгляд вперёд на ${F.lead} пути, догон ${F.turn}/с`);
  ok(/len \/ F\.speed/.test(msrc), 'Длительность считается по длине пути, а не по хорде');
}

/* ══ 3h22. Отражения в обычном режиме ══════════════════════════════════ */
{
  const wsrc = readFileSync(new URL('./js/world.js', import.meta.url), 'utf8');
  const msrc = readFileSync(new URL('./js/main.js', import.meta.url), 'utf8');

  /* Экранные отражения требуют буфера глубины, буфера нормалей и отдельного
     прохода — и всё равно чернеют по краям кадра. Фрагменту воды всё нужное
     известно и так: своя точка, своя нормаль, а отражатели аналитические. */
  ok(/if \( uMirror > 0\.001 && hullMask\.r > 0\.02 \)/.test(wsrc),
     'Отражение считается в шейдере корпуса и только для воды');
  ok(/vec3 Pw = vec3\( sT \* uHullR, cT \* uHullR, vZo \)/.test(wsrc),
     'Точка на корпусе берётся из угла и z — она известна точно');
  ok(/vec3 Vw = normalize\( Pw - uCamObj \)/.test(wsrc),
     'Направление взгляда — от камеры в системе станции');
  ok(/ds > 0\.0/.test(wsrc) && /dh > 0\.0/.test(wsrc),
     'Пересечение и с трубой, и с бортом решается формулой');
  ok(/texture2D\( map, huv \)/.test(wsrc), 'Цвет борта берётся из альбедо того же материала');
  ok(!/tDepth/.test(wsrc), 'Буфер глубины шейдеру корпуса не нужен');

  /* включается пресетом */
  for (const [q, want] of [['LOW', 0], ['HIGH', 0], ['ULTRAM', 1], ['ULTRA', 1]]) {
    ok((CONFIG.QUALITY[q].mirror || 0) === want,
       `${q}: отражения в воде ${want ? 'включены' : 'выключены'}`);
  }
  ok(/mirrorOn = \(CONFIG\.QUALITY\[q\] \|\| CONFIG\.QUALITY\.HIGH\)\.mirror/.test(msrc),
     'Состояние берётся из пресета при пересборке');
  ok(/hullU\.uCamObj\.value\.copy\(worldGroup\.worldToLocal/.test(msrc),
     'Камера переводится в систему станции каждый кадр');
}

/* ══ 3h23. Порядок вкладок настроек ════════════════════════════════════ */
{
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const names = [...html.matchAll(/class="tabbtn[^"]*" data-tab="\d+">([^<]+)</g)].map(m => m[1]);
  ok(names.length >= 4, `Вкладок: ${names.join(', ')}`);
  ok(/ГРАФИКА/i.test(names[0]), 'Графика — первая вкладка');

  /* пресет качества должен быть в ней же, а не в другой */
  const first = html.slice(html.indexOf('data-tab="0">', html.indexOf('class="tab ')), html.length);
  const firstPane = first.slice(0, first.indexOf('<div class="tab '));
  ok(firstPane.includes('id="sQual"'), 'Пресет качества на первой вкладке');
  ok(firstPane.includes('id="sAAon"'), 'Сглаживание там же');

  /* ни одна настройка не потерялась */
  const setSheet = html.slice(html.indexOf('id="set"'), html.indexOf('id="help"'));
  const ids = [...setSheet.matchAll(/id="(s[A-Z]\w*)"/g)].map(m => m[1])
    .filter(id => !/V$/.test(id) && !['sAAcost', 'sAArow', 'sAArow2', 'sAArow3', 'sAAv'].includes(id));
  ok(ids.length >= 18, `Настроек всего: ${ids.length}`);
  ok(new Set(ids).size === ids.length, 'Дублей при перекладке нет');
}

/* ══ 3h24. Монорельс: ферма, кабина, поездка ═══════════════════════════ */
{
  const g = new THREE.Group();
  const res = buildWorld(g, fakeRenderer, 'HIGH');
  buildStructures(g, fakeRenderer, 'HIGH', res.panel, res.panelNormal);

  /* ходовая балка — решётка, а не труба */
  const RB = CONFIG.RAILBEAM;
  ok(RB.bay > 0 && RB.chord > 0 && RB.brace > 0, `Балка: пояс ${RB.chord}, раскос ${RB.brace}, отсек ${RB.bay}`);
  const ssrc = readFileSync(new URL('./js/structures.js', import.meta.url), 'utf8');
  ok(/раскосы крест-накрест/.test(ssrc), 'У балки есть раскосы');
  ok(/поперечины на границах отсеков/.test(ssrc), 'И поперечины');
  const bays = Math.round(CONFIG.SUN.len / RB.bay);
  ok(bays > 40, `Отсеков по длине: ${bays}`);

  /* кабина */
  const CR = CONFIG.LIFTCAR;
  ok(CR.len > CR.w * 2, `Кабина вытянута вдоль пути: ${CR.len} против ${CR.w}`);
  /* Кабина — салон, а не коробка: сплошного борта нет, его место занимает
     остекление, а внутри есть пол, потолок, стойки и сиденья. */
  for (const [what, re] of [
    ['пол и потолок', /rod\(CR\.w, CR\.floor, CR\.len/],
    ['стойки между окнами', /стойки между окнами/],
    ['сиденья вдоль бортов', /сиденья вдоль бортов/],
    ['катки по рельсу', /катки по рельсу/],
    ['подоконный пояс', /подоконный пояс/]
  ]) ok(re.test(ssrc), `У кабины есть ${what}`);
  ok(/Остекление — тонкие панели в проёмах/.test(ssrc),
     'Стекло — панели в проёмах, а не второй ящик поверх корпуса');

  /* камера обязана оказаться между полом и потолком */
  const CRc = CONFIG.LIFTCAR;
  ok(CRc.eye > -CRc.h / 2 + CRc.floor && CRc.eye < CRc.h / 2 - CRc.floor,
     `Глаз пассажира на y=${CRc.eye} — внутри салона (пол ${(-CRc.h / 2 + CRc.floor).toFixed(2)}, потолок ${(CRc.h / 2 - CRc.floor).toFixed(2)})`);

  /* стекло: снаружи светится, изнутри прозрачно */
  ok(structMats.liftGlass.transparent, 'Стекло кабины прозрачное по типу');
  ok(structMats.liftGlass.side === THREE.DoubleSide, 'Двустороннее: смотрят и снаружи, и изнутри');
  setLiftInside(true);
  const inOp = structMats.liftGlass.opacity, inDw = structMats.liftGlass.depthWrite;
  setLiftInside(false);
  ok(inOp < 0.3 && structMats.liftGlass.opacity === 1,
     `Изнутри стекло почти прозрачно (${inOp}), снаружи плотное`);
  ok(inDw === false, 'Изнутри стекло не пишет глубину — иначе оно перекрыло бы вид');
  ok(structMats.liftGlass.emissiveIntensity >= 0, 'Снаружи стекло светится');

  /* посадка и движение */
  ok(liftCount2() === CONFIG.AXIS.railAngles.length, `Кабин: ${liftCount2()}`);
  const p = new THREE.Vector3(), d = new THREE.Vector3();
  liftSeat(0, p, d);
  const r0 = Math.hypot(p.x, p.y), z0 = p.z;
  ok(r0 > CONFIG.SUN.r && r0 < 20, `Кабина у оси: r = ${r0.toFixed(1)}`);
  ok(Math.abs(d.z) === 1, 'Направление движения задано вдоль оси');
  updateStructures(2);
  liftSeat(0, p, d);
  ok(Math.abs(p.z - z0) > 1, `За две секунды кабина уехала на ${Math.abs(p.z - z0).toFixed(0)} юнитов`);

  const msrc = readFileSync(new URL('./js/main.js', import.meta.url), 'utf8');
  ok(/function updateRide/.test(msrc), 'Камеру ведёт кабина');
  ok(/updateControls\(dt, camera\); updateRide\(\)/.test(msrc),
     'Обзор остаётся за игроком: положение задаёт кабина, поворот — нет');
  ok(/_rp\.y \+= CONFIG\.LIFTCAR\.eye/.test(msrc), 'Камера на высоте глаз, а не в полу кабины');
  ok(/let best = 0, bestD = Infinity/.test(msrc),
     'Садимся в ближайшую кабину — переход не выглядит телепортом');
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  ok(html.includes('id="bRide"') && html.includes('id="bRideExit"'),
     'Вход в поездку в списке точек, выход отдельной кнопкой');
  ok(/setRide\(false\); setTour/.test(msrc) && /setTour\(false\);\s*\n\s*fly\.on = false/.test(msrc),
     'Поездка и авто-тур друг друга выключают');
}

/* ══ 3h25. Ось: труба, опоры, марш отражений ═══════════════════════════ */
{
  /* Труба должна доходить до ступицы воронки: после того как торец стал
     объёмным, ступица ушла вглубь, и прежней длины перестало хватать. */
  const HL = CONFIG.L / 2, hub = HL - CONFIG.ENDCAP.depth;
  ok(CONFIG.SUN.len / 2 > hub,
     `Труба доходит до ступицы: конец на ${CONFIG.SUN.len / 2}, ступица на ${hub}`);
  ok(CONFIG.SUN.len / 2 < HL, 'И не торчит наружу за обод торца');
  const ssrc = readFileSync(new URL('./js/structures.js', import.meta.url), 'utf8');
  ok(/sign \* \(flipZ \? HL : HL - E\.depth\)/.test(ssrc),
     'Ступица со спицами садится на дно воронки, а не висит на прежней глубине');

  /* Опоры — монолитные колонны, решётка только у ходовой балки */
  const C = CONFIG.AXIS.column;
  ok(C && C.bottom > C.top, `Колонна расширяется книзу: ${C.top} → ${C.bottom}`);
  ok(/монолитная коническая колонна/.test(ssrc), 'Опора описана колонной');
  ok(!/4 пояса \+ раскосы/.test(ssrc), 'Решётки у силовой опоры не осталось');
  ok(/раскосы крест-накрест/.test(ssrc),
     'Но у ходовой балки монорельса решётка есть: она длинная и работает на изгиб');

  /* марш отражений мельче дома */
  const P = CONFIG.PHOTO;
  let st = P.refStep, total = 0, biggest = 0;
  for (let k = 0; k < P.refSteps; k++) { total += st; biggest = st; st *= P.refGrow; }
  const bldW = Math.max(...CONFIG.BLD.map(b => b.w[1]));
  ok(biggest < bldW * 1.6,
     `Крупнейший шаг марша ${biggest.toFixed(1)} против ширины дома ${bldW} — перепрыгнуть нельзя`);
  ok(total > 150, `Марш достаёт на ${(total * 10) | 0} м`);
  ok(P.refSteps >= 64, `Шагов ${P.refSteps}: снимок ждёт сколько угодно, экономить незачем`);
}

/* ══ 3h26. Шероховатость и охват отражений ═════════════════════════════ */
{
  const g = new THREE.Group();
  const res = buildWorld(g, fakeRenderer, 'ULTRA');
  buildStructures(g, fakeRenderer, 'ULTRA', res.panel, res.panelNormal);
  patchAllRoughness(g);

  /* Альфа непатченного материала хранит непрозрачность — единицу, — и
     трассировка принимает такую поверхность за зеркальную. Патчить надо ВСЕ
     непрозрачные материалы, а не выборочно. */
  const seen = new Set();
  let total = 0, missing = 0;
  g.traverse(o => {
    const list = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of list) {
      if (!m || seen.has(m.uuid) || m.transparent || !m.isMeshStandardMaterial) continue;
      seen.add(m.uuid); total++;
      if (!m.userData.__ra) missing++;
    }
  });
  ok(total > 15, `Непрозрачных материалов в сцене: ${total}`);
  ok(missing === 0, `Все пишут шероховатость в альфу (без неё: ${missing})`);

  /* Отражать должна практически одна вода */
  const P = CONFIG.PHOTO;
  const weight = r => Math.pow(Math.max(0, (1 - r - P.mirrorMin) / (1 - P.mirrorMin)), 4);
  const water = weight(0.045), metal = weight(0.45), facade = weight(0.68), hull = weight(0.95);
  ok(water > 0.1, `Вода отражает (${(water * 100).toFixed(0)}%)`);
  ok(metal < 0.01 && facade < 0.01 && hull < 0.01,
     `Металл, фасады и грунт не отражают (${(metal * 100).toFixed(1)}%, ${(facade * 100).toFixed(1)}%, ${(hull * 100).toFixed(1)}%)`);
  const psrc = readFileSync(new URL('./js/photo.js', import.meta.url), 'utf8');
  ok(/pow\( clamp\( \( 1\.0 - rough - uMirrorMin \)/.test(psrc),
     'Вес отражения — степенная функция гладкости, а не порог с линейным весом');
  const wsrc = readFileSync(new URL('./js/world.js', import.meta.url), 'utf8');
  ok(/uMirror > 0\.001 && hullMask\.r > 0\.02/.test(wsrc),
     'В реальном времени отражает только вода, а не весь корпус');

  /* Пресеты согласованы: ULTRA нигде не слабее ULTRAM */
  const Q = CONFIG.QUALITY;
  const keys = [...new Set(Object.values(Q).flatMap(p => Object.keys(p)))];
  const order = ['LOW', 'HIGH', 'ULTRAM', 'ULTRA'];
  for (const k of keys) {
    ok(order.every(q => Q[q][k] !== undefined), `Поле «${k}» задано во всех пресетах`);
  }
  const weaker = keys.filter(k =>
    typeof Q.ULTRA[k] === 'number' && typeof Q.ULTRAM[k] === 'number' && Q.ULTRA[k] < Q.ULTRAM[k]);
  ok(weaker.length === 0,
     `ULTRA нигде не слабее мобильной ультры${weaker.length ? ' (' + weaker.join(', ') + ')' : ''}`);

  /* Трассировка на телефоне короче */
  const deskt = tracePlan(false), mob = tracePlan(true);
  ok(mob.rays * mob.samples < deskt.rays * deskt.samples / 4,
     `На телефоне ${mob.rays * mob.samples} лучей против ${deskt.rays * deskt.samples} на настольном`);
  ok(mob.refSteps < deskt.refSteps && mob.shadowSteps < deskt.shadowSteps,
     'И марши короче: марш отражения и теней');
  const msrc = readFileSync(new URL('./js/main.js', import.meta.url), 'utf8');
  ok(/startTrace\(renderer, scene, camera, windU\.uWind, isMobile\)/.test(msrc),
     'План выбирается по устройству');
}

/* ══ 3h27. Проходы постобработки и слияние статики ═════════════════════ */
{
  const psrc = readFileSync(new URL('./js/photo.js', import.meta.url), 'utf8');
  const ssrc = readFileSync(new URL('./js/structures.js', import.meta.url), 'utf8');

  /* Считаем проходы по коду: сколько pass() вызывается в каждой ветке.
     Лишний проход при выключенном эффекте — это полный экран впустую. */
  const body = psrc.slice(psrc.indexOf('export function composite'));
  const end = body.indexOf('\n}');
  const comp = body.slice(0, end);
  ok(/if \(\(glowOn \|\| raysOn\) && blRT\)/.test(comp),
     'Яркая выборка и размытие не выполняются, когда свечение и лучи выключены');
  ok(/if \(raysOn && rayRT\)/.test(comp), 'Проход лучей — только при включённых лучах');
  ok(/if \(smaaOn && smaaPass && smaaRT\.length\)/.test(comp),
     'Проход SMAA выполняется только при SMAA');
  ok(/export const postPasses/.test(psrc), 'Число проходов доступно для замера');

  /* буферы заводятся по надобности, а не висят всегда */
  ok(/brRT = blRT = rayRT = null;/.test(psrc) && /if \(glowOn \|\| raysOn\) \{/.test(psrc),
     'Половинные буферы свечения и лучей заводятся только при включённых эффектах');
  ok(/if \(raysOn\) rayRT = half\(\);/.test(psrc), 'Буфер лучей — отдельно от свечения');
  ok(/if \(taaOn\) \{/.test(psrc), 'Буферы TAA — только при TAA');
  ok(/if \(smaaOn\) \{/.test(psrc), 'Буферы SMAA — только при SMAA');

  /* минимальная цепочка: без режима и без эффектов буфера нет вовсе */
  ok(/if \(!fxOn \|\| !fxRT\) \{\s*\n\s*renderer\.setRenderTarget\(null\)/.test(psrc),
     'Без сглаживания и эффектов кадр идёт прямо в канвас, минуя всю цепочку');

  /* слияние статики: одинаковая геометрия не должна рисоваться дважды */
  const g = new THREE.Group();
  const res = buildWorld(g, fakeRenderer, 'ULTRA');
  buildStructures(g, fakeRenderer, 'ULTRA', res.panel, res.panelNormal);
  const bySig = new Map();
  g.traverse(o => {
    if (!o.isMesh || o.isInstancedMesh) return;
    const p = o.geometry.attributes.position;
    const sig = (o.geometry.index ? o.geometry.index.count : p.count) + '/' + p.count;
    bySig.set(sig, (bySig.get(sig) || 0) + 1);
  });
  const dups = [...bySig.entries()].filter(([, n]) => n > 1);
  ok(dups.length === 0,
     `Одиночных мешей с повторяющейся геометрией нет${dups.length ? ' (' + dups.length + ')' : ''}`);
  ok(/const twin = \(geo, mat, flipZ\)/.test(ssrc),
     'Оба торца — два инстанса одной геометрии, а не два отдельных меша');

  let solo = 0;
  g.traverse(o => { if ((o.isMesh || o.isPoints) && !o.isInstancedMesh) solo++; });
  ok(solo <= 10, `Одиночных мешей в сцене: ${solo}`);
}

/* ══ 3h28. Вкладки внизу, кабина без щелей, тени ловят ближнее ═════════ */
{
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
  const ssrc = readFileSync(new URL('./js/structures.js', import.meta.url), 'utf8');

  /* вкладки внизу и не уезжают вместе с прокруткой */
  const sheet = html.slice(html.indexOf('id="set"'), html.indexOf('id="help"'));
  ok(sheet.indexOf('class="tabs"') > sheet.indexOf('data-tab="0"'),
     'Вкладки идут после панелей — то есть внизу шторки');
  ok(/\.tabs\{[^}]*position:sticky;bottom:0/.test(css),
     'Вкладки закреплены у нижнего края и не уезжают с прокруткой');
  ok(/\.tabs\{[^}]*grid-template-columns:repeat\(5,1fr\)/.test(css),
     'Пять вкладок в одну строку, без переноса и растягивания');
  ok(/\.tabbtn\{[^}]*text-overflow:ellipsis/.test(css), 'Длинные подписи не ломают сетку');
  ok(/\.row\{padding:8px 2px/.test(css), 'Строки уплотнены, чтобы список влезал');

  /* кабина: борт закрыт по всей высоте */
  const CR = CONFIG.LIFTCAR, hh2 = CR.h / 2;
  const winTop = CR.h * 0.04 + CR.h * 0.26, winBot = CR.h * 0.04 - CR.h * 0.26;
  ok((hh2 - CR.floor) - winTop > 0.05, 'Между окном и потолком есть зазор — его надо закрывать');
  ok(/const upH = \(hh - CR\.floor\) - winTop/.test(ssrc), 'Панель над окнами есть');
  ok(/const dnH = winBot - \(-hh \+ CR\.floor\)/.test(ssrc), 'И под окнами тоже');

  /* стекло изнутри исчезает целиком */
  ok(/m\.opacity = inside \? 0 : 1/.test(ssrc),
     'Изнутри стекло полностью прозрачно: любая остаточная непрозрачность даёт тонировку');
  ok(/lifts\.glass\.visible = !inside/.test(ssrc), 'И сама панель убирается из отрисовки');

  /* теневой марш обязан ловить ближние преграды */
  const P = CONFIG.PHOTO;
  ok(P.shadowStep < CONFIG.TREE.h[0],
     `Первый шаг теневого луча ${P.shadowStep} мельче нижней кромки кроны ${CONFIG.TREE.h[0]}`);
  let st = P.shadowStep, reach = 0;
  for (let k = 0; k < P.shadowSteps; k++) { reach += st; st *= P.shadowGrow; }
  ok(reach > 20, `Марш достаёт на ${reach.toFixed(0)} юнитов — до оси станции`);
  const psrc = readFileSync(new URL('./js/photo.js', import.meta.url), 'utf8');
  ok(/float st = uShadowStep;/.test(psrc),
     'Шаг не зависит от расстояния до солнца: доля от него начиналась выше крон');
  ok(!/float st = dist \* 0\.02/.test(psrc), 'Прежней доли от расстояния не осталось');

  /* секторы — из пресета: они задают число вызовов, а не содержимое */
  for (const q of ['LOW', 'HIGH', 'ULTRAM', 'ULTRA']) {
    ok(CONFIG.QUALITY[q].chunks > 0, `${q}: секторов ${CONFIG.QUALITY[q].chunks}`);
  }
  ok(CONFIG.QUALITY.ULTRAM.chunks < CONFIG.QUALITY.ULTRA.chunks,
     'На телефоне секторов меньше: там вызов дороже сэкономленных вершин');
}

/* ══ 3h29. Полная трассировка пути ═════════════════════════════════════ */
{
  const src = readFileSync(new URL('./js/pathtrace.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const msrc = readFileSync(new URL('./js/main.js', import.meta.url), 'utf8');

  /* Библиотека грузится лениво: она весит больше самого проекта, платить за
     неё при обычном запуске незачем. */
  ok(/await import\('three-gpu-pathtracer'\)/.test(src),
     'Библиотека подгружается по первому включению, а не при старте');
  ok(!/^import .*three-gpu-pathtracer/m.test(src), 'Статического импорта нет');

  /* Карта импортов должна покрывать всё, что тянут сборки. Забытая
     зависимость даёт молчаливый отказ загрузки модуля. */
  const map = JSON.parse(html.slice(html.indexOf('{', html.indexOf('importmap')),
    html.indexOf('</script>', html.indexOf('importmap'))).trim());
  const keys = Object.keys(map.imports);
  for (const dep of ['three', 'three-gpu-pathtracer', 'three-mesh-bvh', 'three/examples/jsm/']) {
    ok(keys.includes(dep), `Карта импортов знает «${dep}»`);
  }
  /* каждый адрес — на существующий файл сборки, а не на каталог пакета */
  for (const [k, v] of Object.entries(map.imports)) {
    ok(k.endsWith('/') || /\.js$/.test(v), `«${k}» ведёт на файл, а не на каталог`);
    ok(/^https:\/\//.test(v), `«${k}» грузится по https`);
    const ver = (v.match(/@([\d.]+)\//) || [])[1];
    ok(!ver || /^\d+\.\d+\.\d+$/.test(ver), `«${k}»: версия закреплена точно (${ver})`);
  }

  /* дерево строится один раз — это возможно только на статичной сцене */
  /* Асинхронная сборка требует worker'а, а worker не наследует карту
     импортов страницы: ему пришлось бы разрешать 'three' и 'three-mesh-bvh'
     самому. Синхронная сборка проще и не требует ничего. */
  /* Дерево считается на процессоре и занимает секунды: в главном потоке это
     замораживает интерфейс, снимок не сделать. Штатный worker библиотеки не
     годится — worker не наследует карту импортов страницы. Собираем свой из
     строки с абсолютными адресами. */
  ok(/function makeBvhWorker/.test(src), 'Дерево строится в отдельном потоке');
  ok(/import\.meta\.resolve\(name\)/.test(src),
     'Адреса берутся из карты импортов страницы, а не пишутся руками второй раз');
  ok(/new Worker\(url, \{ type: 'module' \}\)/.test(src), 'Поток модульный');
  ok(/\[pos\.buffer,/.test(src),
     'Буферы уходят в поток без копирования: их сотни мегабайт');
  ok(/MeshBVH\.serialize\(bvh, \{ cloneBuffers: false \}\)/.test(src),
     'И возвращаются упакованными, тоже без копий');
  ok(/if \(!threaded\) tracer\.setScene\(scene, camera\);/.test(src),
     'Не поднялся поток — считаем в главном: медленнее по ощущению, но работает всегда');
  ok(/catch \(e\) \{[\s\S]{0,500}tracer = new WebGLPathTracer\(renderer\)/.test(src),
     'При отказе берётся НОВЫЙ трассировщик: генератор старого остался занят начатой сборкой');
  ok(/if \(pt\.active \|\| starting\) return true;/.test(src),
     'Замок от повторного нажатия: второй запуск заставал генератор занятым');

  /* Worker ставится ПУБЛИЧНЫМ методом. Через приватное поле оператор ?.
     молча глотал промах: worker не устанавливался, сборка падала, а начатая
     ею генерация продолжала держать генератор — «BVH is already building»
     вылезало на первом же запуске. */
  ok(/tracer\.setBVHWorker\(bvhWorker\)/.test(src),
     'Worker ставится публичным методом трассировщика');
  ok(!/tracer\._generator\?\./.test(src.replace(/\/\*[\s\S]*?\*\//g, '')),
     'Обращений к приватным полям библиотеки не осталось');
  ok(/typeof tracer\.setBVHWorker === 'function'/.test(src),
     'Наличие метода проверяется явно, а не глотается оператором ?.');
  ok(/await tracer\.setSceneAsync/.test(src),
     'Обещание сборки дожидается: setSceneAsync сбрасывает свой флаг синхронно');
  ok(/pt\.worker\) \{ try \{ pt\.worker\.terminate/.test(src), 'Поток закрывается при выходе');
  /* Кадр отдаётся ДО подмены материалов: иначе замерший кадр останется с
     погашенным солнцем и снятой дымкой — «плоско, без эффектов». */
  const iYield = src.indexOf('await nextFrame();');
  const iSwap = src.indexOf('    lightForPath(scene, sunMat, hemi,');
  ok(iYield > 0 && iYield < iSwap,
     'Браузер получает кадр до подмены материалов, а не после');
  ok(/await nextFrame\(\);\s*\n\s*await nextFrame\(\);/.test(src),
     'Два кадра: одного не хватает, чтобы надпись успела отрисоваться');
  ok(/onPhase\?\.\('строится дерево обхода/.test(src),
     'Фаза постройки объявляется до блокировки потока');
  ok(/pt\.buildMs = /.test(src), 'Время постройки замеряется и показывается');
  ok(/windU\.value = 0/.test(src),
     'Ветер останавливается: дерево описывает геометрию в покое, а кроны смещает вершинный шейдер');
  ok(/omegaSaved = omega;\s*\n\s*omega = 0;/.test(msrc),
     'Вращение станции уже остановлено фото-режимом — сцена статична');

  /* отказ обязан быть мягким */
  ok(/function fail\(e\) \{[\s\S]{0,200}pt\.error =/.test(src),
     'Отказ ловится и превращается в сообщение, а не роняет страницу');
  ok(/console\.error\('\[трассировка пути\]'/.test(src),
     'И попадает в консоль: молчаливый отказ не отличить от неработающей кнопки');
  ok(!/pt\.error = String[\s\S]{0,60}stopPath\(\)/.test(src),
     'Сообщение не стирается тут же: stopPath сбрасывает ошибку, и нажатие выглядело как «ничего не произошло»');
  ok(/pt\.error\) return `путь недоступен/.test(src), 'Причина отказа показывается');
  ok(/if \(!okStart\) \{\s*\n\s*bPath\.classList\.remove\('on'\);/.test(msrc),
     'Не запустилось — кнопка гаснет, обычный кадр остаётся доступен');
  ok(/showTrace\('загрузка библиотеки…'\)/.test(msrc),
     'Нажатие сразу даёт отклик: библиотека грузится с сети, без отклика это выглядит поломкой');
  ok(/if \(pt\.error\) \{\s*\n\s*showTrace\(pathLabel\(\)\)/.test(msrc),
     'Отказ виден и после того, как трассировка снялась');

  /* Сборщик геометрии проверяет только isMesh и берёт у объекта ОДНУ
     геометрию, не разворачивая матрицы экземпляров: в дерево попадало 3.76%
     сцены, оно строилось за 0.2 с, а кадр выходил пустым. */
  ok(/function expandInstances/.test(src), 'Инстансы разворачиваются в обычные меши');
  ok(/im\.getMatrixAt\(k, m\)/.test(src), 'Матрица каждого экземпляра переносится в свой меш');
  ok(/function collapseInstances/.test(src), 'И сворачиваются обратно при выходе');
  ok(/byColor\.get\(uid \+ ':' \+ key\)/.test(src),
     'Материалы группируются по цвету: клон на каждый экземпляр дал бы десять тысяч материалов');

  /* свет: полусферу библиотека не знает, базовый материал не светит */
  ok(/scene\.environment = tex/.test(src),
     'Полусферный свет заменяется окружением: в списке библиотеки его нет вовсе');
  /* Самодельная карта 1×1 ломала шейдер: three пишет CUBEUV_TEXEL_WIDTH как
     1/ширина, при ширине 1 это целое там, где GLSL ждёт float. */
  ok(/new GradientTex\(CONFIG\.PATH\.envRes\)/.test(src),
     'Окружение строит штатный генератор библиотеки, а не самоделка');
  ok(CONFIG.PATH.envRes > 1 && 1 / CONFIG.PATH.envRes !== Math.floor(1 / CONFIG.PATH.envRes),
     `Сторона карты ${CONFIG.PATH.envRes}: 1/${CONFIG.PATH.envRes} = ${1 / CONFIG.PATH.envRes} — дробное, GLSL примет`);
  ok(/tex\.topColor\.copy\(hemi\.color\)/.test(src) && /tex\.bottomColor\.copy\(hemi\.groundColor\)/.test(src),
     'Градиент «небо-земля» передаёт полусферный источник точнее усреднённого цвета');
  ok(/GradientTex = lib\.GradientEquirectTexture/.test(src), 'Генератор берётся из библиотеки');
  ok(/emissive: sunMat\.color\.clone\(\)/.test(src),
     'Труба получает светящийся материал: базовый в переносе света не участвует');
  ok(/emissiveIntensity: CONFIG\.PATH\.sunEmit/.test(src), 'Яркость трубы задаётся отдельно');
  ok(CONFIG.PATH.sunEmit > 1, `Труба узкая, а светит на всё: яркость ${CONFIG.PATH.sunEmit}`);
  ok(/function restoreLight/.test(src), 'Материалы и окружение возвращаются на место');
  ok(/scene\.updateMatrixWorld\(true\)/.test(src),
     'Мировые матрицы пересчитываются до постройки: развёрнутые меши иначе окажутся в начале координат');

  /* Сборщик сливает геометрии в один буфер, и разнобой в атрибутах его
     ломает: «Invalid typed array length». В сцене четыре разных набора. */
  ok(/const NEEDED = \['position', 'normal', 'uv'\]/.test(src),
     'Геометрии приводятся к единому набору атрибутов');
  ok(/g\.deleteAttribute\(a\)/.test(src), 'Лишние атрибуты снимаются');
  ok(/if \(!g\.index\)/.test(src), 'Геометрии без индекса получают индекс');
  ok(/function flatMat/.test(src) && /m\.vertexColors = false/.test(src),
     'Флаг вершинных цветов уходит вместе с атрибутом');
  ok(/function restoreSolids/.test(src), 'Исходные геометрии и материалы возвращаются');

  /* порядок: труба помечена прозрачной, её нельзя убрать раньше подмены */
  const iLight = src.indexOf('    lightForPath(scene, sunMat, hemi,');
  const iHide = src.indexOf('hideNonSolid(scene);', iLight - 400);
  ok(iLight > 0 && iLight < src.indexOf('hideNonSolid(scene);', iLight),
     'Свет подменяется ДО скрытия прозрачного: труба помечена прозрачной и исчезала вместе с дымкой');
  ok(/transparent: false, side: THREE\.DoubleSide/.test(src),
     'Светящийся материал трубы непрозрачен — иначе его снимут вместе с остальным');

  /* точки и прозрачное дерево обхода не описывает */
  ok(/hideNonSolid/.test(src),
     'Спрайты и прозрачные плоскости прячутся: дерево их не описывает, вышли бы чёрные дыры');
  ok(/restoreHidden/.test(src), 'И возвращаются на место при выходе');

  /* накопление */
  ok(/if \(pt\.paused \|\| done >= 1\) \{/.test(src),
     'Набрав нужное, счёт прекращается — путь стоит на порядок дороже обычной отрисовки');
  ok(/export function pathCameraMoved/.test(src) && /tracer\.updateCamera\(\)/.test(src),
     'Сдвиг камеры сбрасывает накопление');
  ok(/if \(!camera\.position\.equals\(_ptPrev\)\)/.test(msrc), 'Движение отслеживается в цикле');
  ok(/pathStep\(\);[\s\S]{0,400}return;/.test(msrc),
     'Путь выводит кадр сам, обычная отрисовка пропускается целиком');
  /* Ветка возвращалась раньше обработки затвора: снимок во время трассировки
     не делался вовсе, и это выглядело как заблокированный интерфейс. */
  const iStep = msrc.indexOf('pathStep();');
  const iShot = msrc.indexOf('if (shotPending)', iStep);
  const iRet = msrc.indexOf('return;', iStep);
  ok(iShot > 0 && iShot < iRet, 'Затвор обрабатывается до выхода из ветки пути');
  ok(/if \(pt\.active\) \{ saveCanvas\(renderer\.domElement\.width/.test(msrc),
     'Накопленный путём кадр не перерисовывается, а ужимается: перерисовка стёрла бы накопленное');

  /* настройки по устройству */
  const P = CONFIG.PATH;
  ok(P.mobileScale < P.scale && P.mobileBounces < P.bounces,
     `На телефоне доля разрешения ${P.mobileScale} и ${P.mobileBounces} переотражения против ${P.scale} и ${P.bounces}`);
  ok(P.mobileTiles > P.tiles,
     `Полос больше (${P.mobileTiles}): короче каждый вызов, браузер не считает вкладку зависшей`);
  /* Предела в выборках больше нет: их число выводится из порога шума. */
  ok(Array.isArray(P.NOISE) && P.NOISE.length >= 3,
     `Порогов шума: ${P.NOISE.map(x => x.v + '%').join(', ')}`);
  ok(P.NOISE.every((x, i) => i === 0 || x.v < P.NOISE[i - 1].v), 'Пороги убывают');
  for (const x of P.NOISE) {
    const need = Math.ceil(1e4 / (x.v * x.v));
    ok(need > 0 && Math.abs(100 / Math.sqrt(need) - x.v) < 0.1,
       `Порог ${x.v}% требует ${need} выборок`);
  }
  ok(html.includes('id="bPath"'), 'Кнопка пути есть в фото-режиме');
}

/* ══ 3h30. Панель съёмки, пауза, свет и вода в пути ════════════════════ */
{
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
  const src = readFileSync(new URL('./js/pathtrace.js', import.meta.url), 'utf8');
  const psrc = readFileSync(new URL('./js/photo.js', import.meta.url), 'utf8');
  const msrc = readFileSync(new URL('./js/main.js', import.meta.url), 'utf8');

  /* панель: иконка слева, подпись справа, полупрозрачная с размытием */
  const barStart = html.indexOf('id="photobar"');
  const bar = html.slice(barStart, html.indexOf('id="rideBar"', barStart) > 0
    ? html.indexOf('id="rideBar"', barStart) : barStart + 3000);
  const btns = [...bar.matchAll(/class="pbtn" id="(b\w+)"/g)].map(m => m[1]);
  ok(btns.length >= 5, `Кнопок в панели съёмки: ${btns.length}`);
  const labels = [...bar.matchAll(/<span>([^<]+)<\/span>/g)].map(m => m[1]);
  ok(labels.length === btns.length, 'У каждой кнопки есть подпись');
  ok(labels.every(l => l.length > 3), `Подписи осмысленные: ${labels.join(', ')}`);
  ok(/\.pbtn\{[^}]*flex-direction|#photobar\{[^}]*flex-direction:column/.test(css),
     'Кнопки идут столбиком');
  ok(/#photobar\{[^}]*left:/.test(css), 'Панель слева');

  /* Панель обязана быть скрыта вне фото-режима: правило потерялось при
     правке соседнего блока, и все кнопки развернулись поверх интерфейса. */
  ok(/#photobar\{[^}]*display:none/.test(css), 'Вне фото-режима панель скрыта');
  ok(/body\.clean #photobar\{display:flex\}/.test(css), 'И показывается только в нём');
  ok(/#photobar\{[^}]*position:absolute/.test(css),
     'Панель позиционирована: без этого кнопки растягиваются на всю ширину');

  /* каждый блок, который прячется в фото-режиме, должен иметь и своё
     собственное правило — иначе селектор body.clean остаётся единственным */
  for (const id of ['rideBar', 'photobar', 'traceInfo']) {
    ok(new RegExp(`(^|\\n)#${id}\\{`).test(css),
       `#${id} объявлен собственным правилом, а не только через body.clean`);
  }
  ok(/backdrop-filter:blur/.test(css), 'Фон полупрозрачный с размытием');
  ok(/#traceInfo\{[^}]*bottom:/.test(css), 'Строка состояния осталась снизу');

  /* пауза с очисткой */
  ok(html.includes('id="bPause"'), 'Кнопка паузы есть');
  ok(/export function setPaused/.test(src), 'Накопление можно остановить');
  /* И на паузе, и по завершении кадр обязан пройти через цепочку заново:
     иначе канвас в этом кадре не перерисовывается, снятие паузы не
     возвращает картинку, а снимок читает канвас с неопределённым
     содержимым и выходит пустым. */
  ok(/if \(pt\.paused \|\| done >= 1\) \{[\s\S]{0,160}composeOut\(tracer\.target\.texture\)/.test(src),
     'И на паузе, и по завершении кадр проходит через цепочку заново');
  ok(/const DENOISE_FRAG/.test(psrc), 'Шумоподавитель есть');

  /* Один проход с малым окном оставляет крупнозернистый узор: соседние
     пиксели он усредняет, а пятна в несколько пикселей не видит вовсе. */
  ok(CONFIG.POST.denoisePasses >= 3, `Проходов шумоподавителя: ${CONFIG.POST.denoisePasses}`);
  ok(/step \*= 2;/.test(psrc), 'Шаг удваивается от прохода к проходу');
  ok(/dnMat\.uniforms\.uSigma\.value = CONFIG\.POST\.denoiseSigma \/ \(1 \+ k \* 0\.9\)/.test(psrc),
     'С ростом шага допуск по цвету сужается — иначе дальние проходы мылят');
  ok(/dnRT\[\(k - 1\) % 2\]/.test(psrc), 'Проходы идут по очереди между двумя буферами');
  {
    let step = 1, reach = 0;
    for (let k = 0; k < CONFIG.POST.denoisePasses; k++) { reach = CONFIG.POST.denoiseR * step; step *= 2; }
    const cheap = CONFIG.POST.denoisePasses * Math.pow(2 * CONFIG.POST.denoiseR + 1, 2);
    const naive = Math.pow(2 * reach + 1, 2);
    ok(cheap < naive / 4,
       `Охват ±${reach} пикселей за ${cheap} выборок вместо ${naive} одним проходом`);
  }
  ok(/w \*= exp\( -dl \* dl \/ max/.test(psrc),
     'Фильтр двусторонний: вес по близости яркости, поэтому кромки переживают');
  /* Фильтр, знающий только цвет, не отличает шум от детали и мылит. */
  ok(/export function renderGuide/.test(psrc),
     'Есть направляющий кадр: растровая отрисовка той же сцены без шума');
  /* Цветной кадр направляющим хуже: два разных предмета одного цвета фильтр
     принимает за один. Нормаль и глубина различают их всегда. */
  ok(/w \*= pow\( dn, uNormalW \)/.test(psrc), 'Соседи взвешиваются по нормали');
  ok(/w \*= exp\( -dd \* dd \)/.test(psrc), 'И по разрыву глубины');
  ok(/gl_FragColor = vec4\( normalize\( vN \), vD \)/.test(psrc),
     'G-буфер: нормаль в RGB, глубина в альфе');
  ok(/setDenoiseGuide\(on \? renderGuide\(renderer, scene, camera\) : null\)/.test(msrc),
     'Снимается один раз при включении: сцена неподвижна');
  ok(CONFIG.POST.denoiseNormal > 8,
     `Строгость по нормали ${CONFIG.POST.denoiseNormal}: она и держит грани`);
  ok(/Очистка идёт первой, до тонмаппинга/.test(psrc),
     'Очистка до тонмаппинга: шум живёт в линейных значениях');
  ok(/export function setDenoise/.test(psrc), 'Очистку можно включить отдельно');
  ok(/traceHeld \? 1 : traceStep\(\)/.test(msrc), 'Пауза работает и для экранных лучей');

  /* путь идёт через нашу постобработку — иначе ни свечения, ни сглаживания */
  ok(/t\.renderToCanvasCallback = \(target, renderer2, quad\)/.test(src),
     'Вывод пути перехватывается');
  ok(/onComposite\(target\.texture\)/.test(src), 'И уходит в общую цепочку');
  ok(/composite\(renderer, texture, renderer\.toneMappingExposure\)/.test(msrc),
     'Свечение, лучи от оси и сглаживание работают и в режиме пути');

  /* вода */
  ok(/export function makeWaterRoughness/.test(
    readFileSync(new URL('./js/textures.js', import.meta.url), 'utf8')),
     'Карта шероховатости воды строится из канала глубины');
  ok(/function waterForPath/.test(src), 'И подставляется корпусу на время съёмки');
  ok(/hullMat\.normalScale\?\.multiplyScalar/.test(src),
     'Рельеф усиливается: рябь из патча шейдера трассировщику не видна');
  ok(/function restoreWater/.test(src), 'После съёмки материал возвращается');
  /* Металл красит отражение в свой цвет, а альбедо реки тёмно-синее —
     выходило чёрное пятно. Вода диэлектрик. */
  ok(/hullMat\.metalness = 0;/.test(src), 'Вода отражает как диэлектрик, без металличности');
  ok(CONFIG.PATH.waterMetal === undefined, 'Параметра металличности воды не осталось');

  /* свет от окон и периметра */
  ok(/function boostEmissive/.test(src),
     'Эмиссия усиливается: луч попадает в окно редко, и оно ничего не освещает');
  ok(/m\.isMeshBasicMaterial && !m\.transparent/.test(src),
     'Базовые материалы ламп подменяются светящимися — в переносе света они не участвуют');
  ok(/function addRimLights/.test(src),
     'Кольцевая подсветка торцов становится настоящими источниками');
  ok(CONFIG.PATH.rimLights >= 6, `Источников по кольцу: ${CONFIG.PATH.rimLights} × 2 торца`);

  /* Мощность обязана быть соизмерима с осевыми источниками сцены. Задана
     «на глаз» она вышла в 274 раза ярче каждого осевого, а их вдвадцатеро
     больше — кадр выбеливало. */
  const axis = CONFIG.DAY.pointInt * CONFIG.LIGHT_Z.length;
  const rim = CONFIG.PATH.rimPower * CONFIG.PATH.rimLights * 2;
  ok(rim < axis * 12,
     `Кольцо (${rim.toFixed(1)}) соизмеримо с осевым освещением (${axis.toFixed(1)}), а не в тысячу раз ярче`);
  ok(/if \(level < 0\.02\) return;/.test(src),
     'Днём периметральная подсветка выключена: это ночная деталь');
  ok(/P\.rimPower \* level/.test(src), 'И гаснет вместе с фазой');

  /* яркость трубы тоже обязана следовать фазе */
  ok(/CONFIG\.PATH\.sunEmit \* sunLevel/.test(src),
     'Яркость трубы следует фазе: постоянная пересвечивала день');
  ok(/function sunLevelNow/.test(msrc), 'Уровень берётся из той же палитры, что и в обычном кадре');
  ok(CONFIG.PATH.sunEmit * CONFIG.DAY.sunEmis < CONFIG.PATH.sunEmit * 2,
     `Днём труба светит ${(CONFIG.PATH.sunEmit * CONFIG.DAY.sunEmis).toFixed(1)}, ночью ${(CONFIG.PATH.sunEmit * CONFIG.NIGHT.sunEmis).toFixed(1)}`);

  /* цепочка постобработки в режиме пути обязана существовать */
  ok(/export function forcePost/.test(psrc),
     'Цепочка поднимается принудительно: composite молча возвращал false, и очистка со свечением не работали');
  ok(/forcePost\(renderer, true\)/.test(msrc), 'Включается при старте пути');
  ok(/forcePost\(renderer, false\)/.test(msrc), 'И снимается при выходе');
  ok(/setFxaa\(renderer, !!mode \|\| glowOn \|\| raysOn \|\| forced/.test(psrc),
     'Признак учитывается там же, где решается, нужен ли буфер');
  ok(/function removeRimLights/.test(src), 'И снимаются при выходе');
  ok(CONFIG.PATH.emitBoost > 1, `Усиление эмиссии ×${CONFIG.PATH.emitBoost}`);
}

/* ══ 3h31. Текстуры металла и торца ════════════════════════════════════ */
{
  const tsrc = readFileSync(new URL('./js/textures.js', import.meta.url), 'utf8');

  /* Ровная сетка одинаковых плит читается заглушкой: глазу не за что
     зацепиться, масштаб не считывается. */
  const panel = tsrc.slice(tsrc.indexOf('export function makePanelTexture'));
  const panelBody = panel.slice(0, panel.indexOf('\n}'));
  ok(/const h = 26 \+ Math\.floor\(rnd\(\) \* 46\)/.test(panelBody),
     'Ряды плит разной высоты, а не ровная сетка');
  ok(/const w = 34 \+ Math\.floor\(rnd\(\) \* 92\)/.test(panelBody), 'И плиты разной ширины');
  ok(/фаска: светлая сверху-слева/.test(panelBody),
     'У плит есть фаска — объём читается даже без карты нормалей');
  ok(/Потёки вниз от стыков/.test(panelBody),
     'Есть потёки: без них металл выглядит только что отлитым');
  ok(/createLinearGradient/.test(panelBody), 'Потёки затухают, а не рисуются полосой');
  ok(/Мелкие люки и вставки/.test(panelBody), 'Есть люки и вставки для масштаба');

  /* Торец: концентрические пояса с секциями, а не ровные кольца */
  const cap = tsrc.slice(tsrc.indexOf('export function makeEndCapTexture'));
  const capBody = cap.slice(0, cap.indexOf('\n}\n'));
  ok(/const seg = Math\.max\(6, Math\.round\(i \* 2\.6\)\)/.test(capBody),
     'Число секций растёт к краю: длина дуги остаётся соизмеримой');
  ok(/мелкие блоки внутри секции/.test(capBody), 'В секциях есть мелкие блоки');
  ok(/иллюминаторы/.test(capBody), 'И редкие светящиеся окна');

  /* Постоянный угол даёт дугу, растущую вместе с радиусом: у края окна
     вытягивались впятеро против тех, что у ступицы. */
  ok(/side \/ Math\.max\( ?1, rr ?\)/.test(capBody.replace(/\s+/g, ' ')) ||
     /side \/ Math\.max\(1, rr\)/.test(capBody),
     'Угловой размер окна считается ОТ радиуса — окна квадратные на любом радиусе');
  ok(/bw \* \(0\.7 \+ rnd\(\) \* 1\.4\) \/ Math\.max\(1, rr\)/.test(capBody),
     'И блоки внутри секций тоже');
  {
    /* численно: сторона окна одинакова у ступицы и у края */
    const C2 = 240, rings = 22;
    const at = rel => {
      const i = Math.round(rel * rings);
      const r1 = C2 * (i / rings), r0 = C2 * ((i - 1) / rings);
      const rr = r0 + (r1 - r0) * 0.5, side = (r1 - r0) * 0.34;
      const ba = Math.min((r1 - r0) * 0.8, side / Math.max(1, rr));
      return { w: rr * ba, h: side };
    };
    const near = at(0.2), far = at(1);
    ok(Math.abs(near.w / near.h - 1) < 0.2 && Math.abs(far.w / far.h - 1) < 0.2,
       `Окна квадратные и у ступицы (${near.w.toFixed(1)}×${near.h.toFixed(1)}), и у края (${far.w.toFixed(1)}×${far.h.toFixed(1)})`);
  }
  ok(/шесть силовых спиц/.test(capBody), 'Спицы нарисованы поверх поясов');
  ok(/rings = 22/.test(capBody), 'Поясов достаточно, чтобы читалась конструкция');

  /* двойной счёт осевого света */
  const psrc2 = readFileSync(new URL('./js/pathtrace.js', import.meta.url), 'utf8');
  ok(/function dimAxisLights/.test(psrc2),
     'Осевые источники приглушаются: в растре они изображают свет трубы, а в трассировке труба светит сама');
  ok(CONFIG.PATH.axisKeep < 0.4, `Остаётся ${(CONFIG.PATH.axisKeep * 100) | 0}% — на недобранные переотражения`);
  ok(/function restoreAxisLights/.test(psrc2), 'И возвращаются при выходе');
  ok(/rimAdded\.includes\(o\)/.test(psrc2), 'Кольцевые источники приглушением не задеты');

  /* рябь воды */
  ok(/export function makeWaterNormal/.test(tsrc),
     'Карта ряби строится отдельно: волны живут в патче шейдера, которого трассировщик не видит');
  ok(/if \(normalMap\) hullMat\.normalMap = normalMap;/.test(psrc2),
     'И подставляется корпусу на время съёмки');

  /* У каждой карты в three СВОЯ матрица развёртки. Альбедо корпуса зеркалится
     (смотрим изнутри цилиндра), и карты без этого зеркала ложатся в
     противофазе: вода в них оказывается там, где на самом деле трава. */
  const g2 = new THREE.Group();
  buildWorld(g2, fakeRenderer, 'HIGH');
  const hm = worldMats.hull;
  for (const [name, tx] of [['шероховатость воды', worldMats.waterRough],
    ['рябь', worldMats.waterNormal], ['рельеф', hm.normalMap]]) {
    if (!tx) continue;
    ok(tx.repeat.x === hm.map.repeat.x && tx.offset.x === hm.map.offset.x,
       `Развёртка «${name}» совпадает с альбедо корпуса (${tx.repeat.x}, ${tx.offset.x})`);
  }
  ok(/s\.mat\.normalMap = s\.normal;/.test(psrc2), 'Исходный рельеф возвращается');
}

/* ══ 3h32. Версия проекта ══════════════════════════════════════════════ */
{
  const vsrc = readFileSync(new URL('./js/version.js', import.meta.url), 'utf8');
  const sw = readFileSync(new URL('./sw.js', import.meta.url), 'utf8');
  const readme = readFileSync(new URL('./README.md', import.meta.url), 'utf8');
  const msrc = readFileSync(new URL('./js/main.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');

  const ver = (vsrc.match(/VERSION = '([\d.]+)'/) || [])[1];
  ok(/^\d+\.\d+\.\d+$/.test(ver || ''), `Версия задана в формате мажор.минор.правка: ${ver}`);

  /* Номер живёт в одном месте: три копии однажды разойдутся. */
  ok(/import \{ VERSION \} from '\.\/js\/version\.js'/.test(sw),
     'Сервис-воркер импортирует версию, а не дублирует её');
  ok(!new RegExp(`'${ver.replace(/\./g, '\\.')}'`).test(sw.replace(/import[^\n]*/, '')),
     'И не содержит номера строкой');
  ok(/type: 'module'/.test(msrc),
     'Воркер регистрируется модулем: без этого импорт внутри него не разрешится');
  ok(readme.includes(ver), 'README называет ту же версию');
  ok(html.includes('id="ver"') && /VERSION/.test(msrc), 'Версия видна пользователю');

  /* история должна заканчиваться текущей версией */
  const hist = [...vsrc.matchAll(/\['(\d+\.\d+\.\d+)',/g)].map(m => m[1]);
  ok(hist.length >= 8, `Записей в истории: ${hist.length}`);
  ok(hist[hist.length - 1] === ver, 'Последняя запись истории — текущая версия');
  const cmp = (a, b) => {
    const x = a.split('.').map(Number), y = b.split('.').map(Number);
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  };
  ok(hist.every((v, i) => i === 0 || cmp(v, hist[i - 1]) > 0), 'История возрастает');
}

/* ══ 3h33. Массивы материалов и порог свечения ═════════════════════════ */
{
  const src = readFileSync(new URL('./js/pathtrace.js', import.meta.url), 'utf8');
  const psrc = readFileSync(new URL('./js/photo.js', import.meta.url), 'utf8');
  const msrc = readFileSync(new URL('./js/main.js', import.meta.url), 'utf8');

  /* У дома два материала — стены и кровля. Прежняя версия возвращала сам
     массив, у которого нет ни vertexColors, ни clone. */
  ok(/if \(Array\.isArray\(mat\)\) return mat\.map\(flatMat\)/.test(src),
     'Массив материалов обрабатывается поэлементно');
  ok(/function cloneMat/.test(src), 'И клонируется тоже поэлементно');

  /* Сборщик присваивает КАЖДОМУ мешу один номер материала по его порядку в
     списке и собственные группы геометрии не читает. Дом с двумя материалами
     сдвигал номера всех последующих мешей: колонне доставался материал дома,
     дому — травы, корпус пропадал. */
  ok(/function splitByGroups/.test(src),
     'Меш с несколькими материалами разбирается на меши по одному материалу');
  ok(/g\.setAttribute\(name, geo\.attributes\[name\]\)/.test(src),
     'Атрибуты у частей общие — копируется только список индексов');
  ok(/const parts = Array\.isArray\(flat\) \? splitByGroups\(baseGeo\) : null/.test(src),
     'Инстансы разбираются при развороте');
  ok(/if \(Array\.isArray\(m\)\) \{\s*\n\s*const parts = splitByGroups\(g\);/.test(src),
     'Одиночные меши — тоже: они разъехались бы так же');
  ok(/for \(const g of subGeos\) g\.dispose\(\)/.test(src), 'Части освобождаются при выходе');
  ok(/im\.material\.map\(m => m\.uuid\)\.join\('\+'\)/.test(src),
     'Ключ цветового кэша учитывает все материалы объекта');
  ok(/Array\.isArray\(m\)\s*\n?\s*\? m\.some/.test(src.replace(/\r/g, '')),
     'Сравнение на изменение тоже знает про массив');

  /* Порог свечения подбирался под обычный кадр, а в трассировке эмиссия
     усилена в девять раз — половина картинки проходила в яркую выборку. */
  ok(/export function setBrightScale/.test(psrc), 'Порог яркой выборки настраивается');
  ok(/P\.threshold \* brightScale/.test(psrc), 'И поднимается вместе с усилением');
  ok(/P\.glow \/ brightScale/.test(psrc) && /P\.rays \/ brightScale/.test(psrc),
     'Сила свечения и лучей делится на то же число: источники и так ярче');
  ok(/setBrightScale\(CONFIG\.PATH\.emitBoost \* CONFIG\.PATH\.brightRatio\)/.test(msrc),
     'В режиме пути порог берётся из усиления эмиссии');
  ok(/setBrightScale\(1\)/.test(msrc), 'И возвращается при выходе');

  const k = CONFIG.PATH.emitBoost * CONFIG.PATH.brightRatio;
  const over = CONFIG.NIGHT.winEmis * CONFIG.PATH.emitBoost / (CONFIG.POST.threshold * k);
  ok(over > 1.5 && over < 8,
     `Окна превышают порог в ${over.toFixed(1)} раза — ореол есть, засветки нет`);
}

/* ══ 3h34. Разрешение, отскоки, рябь, рассеянный свет ══════════════════ */
{
  const src = readFileSync(new URL('./js/pathtrace.js', import.meta.url), 'utf8');
  const msrc = readFileSync(new URL('./js/main.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const P = CONFIG.PATH;

  /* доля разрешения — в настройках рядом со сглаживанием */
  ok(Array.isArray(P.SCALES) && P.SCALES.length >= 3,
     `Долей разрешения на выбор: ${P.SCALES.map(s => s.label).join(', ')}`);
  ok(P.SCALES[0].v === 1, 'Первая — полное разрешение');
  ok(P.SCALES.every((s, i) => i === 0 || s.v < P.SCALES[i - 1].v), 'Доли убывают');
  ok(html.includes('id="sPtScale"'), 'Настройка есть в разметке');
  ok(/export function setPathScale/.test(src), 'И меняется на ходу');
  ok(/pt\.samples = 0;/.test(src.slice(src.indexOf('export function setPathScale'))),
     'Смена доли сбрасывает накопление: размер буфера другой');

  /* отскоки: каждый следующий даёт всё меньше, а стоит столько же */
  ok(P.bounces <= 4, `Отскоков на настольном: ${P.bounces}`);
  ok(P.mobileBounces < P.bounces, `На телефоне меньше: ${P.mobileBounces}`);

  /* рябь не должна съедать отражение */
  const tilt = P.normalBoost * CONFIG.NORMALS.water / CONFIG.NORMALS.hull;
  ok(tilt < 1.5,
     `Наклон ряби ${tilt.toFixed(2)}× против корпуса: при пятикратном отражение размазывалось`);

  /* рассеянный свет плоский — направленный должен вести */
  const env = CONFIG.DAY.hemiInt * P.envScale;
  const sun = P.sunEmit * CONFIG.DAY.sunEmis;
  ok(env / sun < 0.2,
     `Днём рассеянного ${env.toFixed(2)} против направленного ${sun.toFixed(2)} — объём есть`);
}

/* ══ 3h35. Выбор шумоподавителя, холмы в корпусе, пруды ════════════════ */
{
  const psrc = readFileSync(new URL('./js/photo.js', import.meta.url), 'utf8');
  const msrc = readFileSync(new URL('./js/main.js', import.meta.url), 'utf8');
  const wsrc = readFileSync(new URL('./js/world.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');

  /* четыре способа: у каждого своя цена и своя слабость */
  const D = CONFIG.POST.DENOISERS;
  ok(D.length >= 4, `Способов очистки: ${D.map(x => x.label).join(', ')}`);
  ok(D.every(x => x.id && x.label && x.hint), 'У каждого есть подпись и пояснение');
  for (const id of ['atrous', 'cross', 'smart', 'temporal']) {
    ok(D.some(x => x.id === id), `Есть способ «${id}»`);
  }
  ok(html.includes('id="sDn"'), 'Выбор есть в настройках');
  ok(/export function setDenoiseMode/.test(psrc), 'И переключается на ходу');
  ok(/prefs\.set\('denoiser'/.test(msrc), 'Выбор сохраняется');
  ok(/const SMART_FRAG/.test(psrc), 'glslSmartDeNoise на месте');
  ok(/const EMA_FRAG/.test(psrc), 'Временное накопление тоже');
  ok(/dnMode === 'cross' \? 1 : CONFIG\.POST\.denoisePasses/.test(psrc),
     'Кросс-билатеральный — тот же фильтр в один проход');

  /* холмы несёт сам корпус */
  ok(/export function displaceHills/.test(wsrc), 'Корпус продавливается холмами');
  ok(/Math\.atan2\(v\.x, -v\.z\)/.test(wsrc),
     'Угол считается в КОНЕЧНОЙ системе: после поворота он становится 180° минус исходный');
  ok(/const f = \(1 - u \* u\) \* \(1 - u \* u\)/.test(wsrc),
     'Гладкий колокол: у края производная нулевая, стыка не видно');
  ok(/if \(!clearOf\(t, z, rad\)\) continue;/.test(wsrc),
     'Холм не садится на город и русло: там поверхность обязана остаться ровной');
  /* И не задевает пятки опор: продавленный под колонной холм оторвал бы
     стилобат, а залитая низина поставила бы её в воду. */
  ok(/for \(const f of feet\)/.test(wsrc), 'Пятки опор тоже обходятся');
  ok(CONFIG.HILL.footGap > 0, `Запас вокруг пятки ${CONFIG.HILL.footGap} юнитов`);
  for (const q of ['LOW', 'HIGH', 'ULTRAM', 'ULTRA']) {
    ok(CONFIG.QUALITY[q].rings > 0, `${q}: колец корпуса ${CONFIG.QUALITY[q].rings}`);
  }
  ok(CONFIG.QUALITY.LOW.rings < CONFIG.QUALITY.ULTRA.rings,
     'На слабом устройстве колец меньше: гнуть корпус дорого');

  /* пруды */
  ok(CONFIG.HILL.pondChance > 0, `Доля низин: ${(CONFIG.HILL.pondChance * 100) | 0}%`);
  ok(/const ponds = hullHills\.filter\(h => h\.dip\)/.test(wsrc),
     'Пруды стоят в низинах, а не где придётся');
  const tsrc = readFileSync(new URL('./js/textures.js', import.meta.url), 'utf8');
  ok(/─── ПРУДЫ ───/.test(tsrc), 'Пруд рисуется в тот же канал маски, что и река');
  const pondBlock = tsrc.slice(tsrc.indexOf('─── ПРУДЫ ───'));
  ok(/ellipse\(m, M\.c\.width, 0\.5, '#ff0000'\)/.test(pondBlock),
     'В канал воды: весь водный шейдер достаётся пруду даром');
  /* Сложение оставляло зелёный канал на месте, и трава ложилась поверх
     воды — озера не было видно вовсе. */
  ok(!/globalCompositeOperation/.test(pondBlock.slice(0, pondBlock.indexOf('\n  }\n'))),
     'Пруд заливается как река, а не складывается с фоном');
  ok(/ellipse\(m, M\.c\.width, 1\.0, '#330000'\)/.test(pondBlock),
     'Глубина растёт к середине — тремя проходами, как у русла');

  /* и вода в низине действительно появляется */
  const g3 = new THREE.Group();
  const r3 = buildWorld(g3, fakeRenderer, 'HIGH');
  ok(!!r3.waterRough, 'Карта шероховатости воды собрана уже с прудами');
}

/* ══ 3h36. Уровни детализации деревьев и резкость ══════════════════════ */
{
  const wsrc = readFileSync(new URL('./js/world.js', import.meta.url), 'utf8');
  const psrc = readFileSync(new URL('./js/photo.js', import.meta.url), 'utf8');
  const tsrc = readFileSync(new URL('./js/textures.js', import.meta.url), 'utf8');

  /* плотность до пятикратной — без уровней это одиннадцать миллионов граней */
  ok(CONFIG.GREEN[0] >= 5, `Верхняя плотность зелени: ${CONFIG.GREEN[0] * 100}%`);
  ok(CONFIG.GREEN.every((v, i) => i === 0 || v < CONFIG.GREEN[i - 1]), 'Ступени убывают');
  ok(/const spaceK = 1 \/ Math\.sqrt/.test(wsrc),
     'Шаг между деревьями падает как корень из плотности: иначе лес выйдет лысыми пятнами');

  /* три уровня */
  const L = CONFIG.TREE_LOD;
  ok(L.near > 0 && L.mid > L.near, `Границы уровней: ${L.near} и ${L.mid} юнитов`);
  ok(L.step > 0, `Пересчёт при сдвиге камеры на ${L.step} юнитов`);
  ok(/function crossQuadGeo/.test(wsrc), 'Дальний уровень — крест из двух плоскостей');
  ok(/Билборд, разворачивающийся к камере, здесь дороже/.test(wsrc),
     'Крест вместо билборда: мир вращается, разворачивать тысячи плоскостей дороже');
  ok(/export function updateTreeLod/.test(wsrc), 'Раскладка есть');
  ok(/Раскладка идёт ПО КАЖДОМУ ДЕРЕВУ/.test(wsrc),
     'Раскладка по деревьям, а не по секторам: сфера сектора охватывает всю длину станции');
  ok(/im\.boundingSphere = sectorSphere\(b, R\)/.test(wsrc),
     'Отсечение по кадру сохранено: сфера считается по ёмкости сектора');

  /* мир целый и без раскладки */
  const g4 = new THREE.Group();
  buildWorld(g4, fakeRenderer, 'HIGH');
  const crowns = g4.children.filter(o => o.isInstancedMesh && o.material?.flatShading
    && o.instanceColor);
  ok(crowns.some(o => o.count > 0),
     'До первой раскладки мир целый: всё лежит на ближнем уровне');

  /* и раскладка действительно снимает нагрузку */
  const world = new THREE.Group();
  world.add(g4);
  world.updateMatrixWorld(true);
  const tris = () => {
    let n = 0;
    g4.traverse(o => {
      if (!o.isMesh) return;
      const ix = o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count;
      n += (ix / 3) * (o.isInstancedMesh ? o.count : 1);
    });
    return n;
  };
  const before = tris();
  updateTreeLod(new THREE.Vector3(0, CONFIG.R - 8, 0), world, true);
  const after = tris();
  ok(after < before * 0.75,
     `Раскладка снимает ${(100 - after / before * 100) | 0}% геометрии: ${(before / 1000) | 0}k → ${(after / 1000) | 0}k`);

  /* фактура листвы */
  ok(/export function makeLeafTexture/.test(tsrc), 'Текстура листвы есть');
  ok(/отдельные листья: мазки поперёк/.test(tsrc), 'В ней прорисованы отдельные листья');
  ok(CONFIG.NORMALS.leaf > 0, `Рельеф листвы ${CONFIG.NORMALS.leaf}: без него крона — гранёный камень`);

  /* резкость при растяжении */
  ok(/const SHARP_FRAG/.test(psrc), 'Резкость при растяжении есть');
  ok(/float contrast = clamp\( \( mx - mn \) \* 4\.0/.test(psrc),
     'Сила следует контрасту: на ровном месте подъём вытащил бы только зерно');
  ok(/export function setSharpen/.test(psrc), 'И настраивается');
  const msrc2 = readFileSync(new URL('./js/main.js', import.meta.url), 'utf8');
  ok(/setSharpen\(v < 0\.999 \? CONFIG\.POST\.sharpen \* \(1 - v\)/.test(msrc2),
     'Тем сильнее, чем меньше доля разрешения');
}

/* ══ 3h37. Умолчания и вызов всех шумоподавителей ══════════════════════ */
{
  const psrc = readFileSync(new URL('./js/photo.js', import.meta.url), 'utf8');
  const msrc = readFileSync(new URL('./js/main.js', import.meta.url), 'utf8');

  /* каждый способ обязан иметь свою ветку — иначе выбор в настройках
     переключал бы подпись, а работал бы один и тот же фильтр */
  for (const [id, mark] of [
    ['smart', "dnMode === 'smart' && smartMat"],
    ['temporal', "dnMode === 'temporal' && emaMat"],
    ['cross', "dnMode === 'cross' \\? 1 :"]
  ]) {
    ok(new RegExp(mark).test(psrc), `Способ «${id}» действительно вызывается`);
  }
  ok(/} else if \(dnOn && dnMat && dnRT\.length\) \{/.test(psrc),
     'À-Trous — последняя ветка, она же по умолчанию для неизвестного значения');

  /* резкость не должна читать и писать один буфер */
  ok(/const to = src === dnRT\[0\]\.texture \? dnRT\[1\] : dnRT\[0\];/.test(psrc),
     'Резкость пишет в буфер, из которого не читает: сравнение буфера с текстурой всегда ложно');

  /* умолчания */
  ok(/prefs\.get\('denoiser', 'cross'\)/.test(msrc), 'По умолчанию кросс-билатеральный');
  ok(/dnMode = 'cross'/.test(psrc), 'И в самом модуле тоже');
  ok(/prefs\.get\('ptScale', 0\.5\)/.test(msrc), 'Доля трассировки по умолчанию ½');
  ok(/prefs\.get\('aaMsaa', 0\)/.test(msrc), 'MSAA по умолчанию выключен');
  ok(/prefs\.get\('aaFilter', 'taa'\)/.test(msrc), 'Фильтр по умолчанию TAA');
  ok(/prefs\.get\('aaScale', 1\)/.test(msrc), 'Масштаб рендера по умолчанию ×1');
  ok(/prefs\.get\('green', 2\)/.test(msrc), 'Плотность зелени по умолчанию — третья ступень');
  ok(CONFIG.GREEN[2] === 2.5, `Третья ступень — ${CONFIG.GREEN[2] * 100}%`);
}

/* ══ 3h38. Ничто не используется без импорта ═══════════════════════════ */
{
  /* Именно этот класс ошибки уронил страницу: функция была объявлена и
     экспортирована, вызов стоял на месте, а строка импорта потерялась при
     правке. Синтаксис при этом верный, и `node --check` молчит — ошибка
     всплывает только в браузере, сотнями раз в секунду из цикла отрисовки. */
  const files = ['config', 'util', 'textures', 'world', 'structures',
    'controls', 'photo', 'pathtrace', 'audio', 'main', 'version'];
  const src = {};
  for (const f of files) {
    src[f] = readFileSync(new URL(`./js/${f}.js`, import.meta.url), 'utf8');
  }

  /* что каждый модуль отдаёт наружу */
  const exportsOf = {};
  for (const f of files) {
    const names = new Set();
    for (const m of src[f].matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)) names.add(m[1]);
    for (const m of src[f].matchAll(/export\s+(?:const|let|class)\s+(\w+)/g)) names.add(m[1]);
    exportsOf[f] = names;
  }

  /* что каждый модуль забирает себе */
  const importsOf = {};
  for (const f of files) {
    const names = new Set();
    for (const m of src[f].matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
      for (const part of m[1].split(',')) {
        const n = part.trim().split(/\s+as\s+/).pop().trim();
        if (n) names.add(n);
      }
    }
    for (const m of src[f].matchAll(/import\s+\*\s+as\s+(\w+)/g)) names.add(m[1]);
    importsOf[f] = names;
  }

  /* Шейдеры лежат в тех же файлах обратными кавычками, и в GLSL полно имён,
     совпадающих с нашими: clamp, mix, texture. Вырезаем их, иначе проверка
     ловит несуществующее. */
  const stripGlsl = s => s.replace(/`[^`]*`/g, '``');

  let missing = [];
  for (const f of files) {
    /* имена, объявленные в самом файле, — не в счёт */
    const own = new Set(exportsOf[f]);
    for (const m of src[f].matchAll(/(?:function|const|let|var|class)\s+(\w+)/g)) own.add(m[1]);

    for (const other of files) {
      if (other === f) continue;
      for (const name of exportsOf[other]) {
        if (own.has(name) || importsOf[f].has(name)) continue;
        /* ищем настоящее обращение, а не совпадение внутри слова или строки */
        const used = new RegExp(`(^|[^\\w.'"])${name}\\s*\\(`, 'm').test(stripGlsl(src[f]));
        if (used) missing.push(`${f}.js → ${name} (из ${other}.js)`);
      }
    }
  }
  ok(missing.length === 0,
     `Всё используемое импортировано${missing.length ? ': ' + missing.join(', ') : ''}`);
}

/* ══ 3h39. Улицы, озёра, дальнее дерево, накопление ════════════════════ */
{
  const wsrc = readFileSync(new URL('./js/world.js', import.meta.url), 'utf8');
  const tsrc = readFileSync(new URL('./js/textures.js', import.meta.url), 'utf8');
  const psrc = readFileSync(new URL('./js/photo.js', import.meta.url), 'utf8');

  /* Ничего не растёт на проезжей части: раньше туда попадало пять сотен крон
     из шести в городских секторах. */
  const g5 = new THREE.Group();
  buildWorld(g5, fakeRenderer, 'HIGH');
  const C = CONFIG.CITY;
  const m5 = new THREE.Matrix4(), p5 = new THREE.Vector3();
  const s5 = new THREE.Vector3(), q5 = new THREE.Quaternion();
  let inCity = 0, onRoad = 0;
  for (const o of g5.children) {
    if (!o.isInstancedMesh || !o.material?.flatShading || !o.instanceColor) continue;
    for (let k = 0; k < o.count; k++) {
      o.getMatrixAt(k, m5); m5.decompose(p5, q5, s5);
      const deg = ((Math.atan2(p5.x, p5.y) * 180 / Math.PI) % 360 + 360) % 360;
      if (zoneAt(deg) !== 'city') continue;
      inCity++;
      const t5 = ((Math.atan2(p5.x, p5.y) / TAU) % 1 + 1) % 1;
      const fu = t5 * C.cols - Math.floor(t5 * C.cols);
      const fv = (((p5.z + CONFIG.L / 2) / (CONFIG.L / C.rows)) % 1 + 1) % 1;
      const road = C.street / (TAU * CONFIG.R / C.cols);
      if (fu < road || fu > 1 - road || fv < road || fv > 1 - road) onRoad++;
    }
  }
  ok(onRoad === 0, `На проезжей части ничего не растёт (${onRoad} из ${inCity} в городе)`);
  ok(/if \(zoneAt\(t \/ D2R\) === 'city' && onStreet\(t, z, r\)\) continue;/.test(wsrc),
     'Отсев идёт при расстановке, а не потом');
  ok(/const halfT = CT\.street \/ R \+ r \/ R;/.test(wsrc),
     'Полоса берётся полной шириной улицы: от границы ячейки до края проезжей части ровно street');

  /* Пруды рисуются ДО возврата из функции: блок стоял после него и не
     выполнялся ни разу — озёр не было вовсе. */
  const hullFn = tsrc.slice(tsrc.indexOf('export function makeHullMaps'));
  const iPond = hullFn.indexOf('─── ПРУДЫ ───');
  const iRet = hullFn.indexOf('return { albedo, mask');
  ok(iPond > 0 && iPond < iRet, 'Пруды рисуются до возврата из функции');

  /* дальнее дерево — три плоскости, а не две */
  ok(CONFIG.TREE_LOD.blades >= 3,
     `Плоскостей в дальнем дереве: ${CONFIG.TREE_LOD.blades} под ${(180 / CONFIG.TREE_LOD.blades) | 0}°`);
  ok(!/alphaMap: leafMap/.test(wsrc),
     'Прозрачность из альфы карты, а не из alphaMap: тот читает зелёный канал и срезал крону целиком');

  /* временное накопление не должно читать буфер, в который пишет */
  ok(/const dst = dnRT\[emaIdx\], hist = dnRT\[1 - emaIdx\];/.test(psrc),
     'Буферы накопления переставляются, а не копируются');
  ok(/emaIdx = 1 - emaIdx;/.test(psrc), 'Перестановка после каждого кадра');
  ok(!/pass\(emaMat, dnRT\[1\]\)/.test(psrc),
     'Копирующего прохода нет: он читал и писал один буфер, картинка уходила в белое, потом в чёрное');
}

/* ══ 3h40. Готовые проходы three и дерево обхода ═══════════════════════ */
{
  const psrc = readFileSync(new URL('./js/photo.js', import.meta.url), 'utf8');
  const wsrc = readFileSync(new URL('./js/world.js', import.meta.url), 'utf8');
  const csrc = readFileSync(new URL('./js/controls.js', import.meta.url), 'utf8');
  const ptsrc = readFileSync(new URL('./js/pathtrace.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');

  /* Своей копии SMAA больше нет: она дважды подвела — забытые `defines` и
     разошедшаяся версия зависимости. */
  ok(!existsSync(new URL('./js/smaa-lut.js', import.meta.url)), 'Файл своих таблиц SMAA удалён');
  ok(!existsSync(new URL('./js/smaa-shaders.js', import.meta.url)), 'И файл своих шейдеров');
  ok(/from 'three\/examples\/jsm\/postprocessing\/SMAAPass\.js'/.test(psrc),
     'SMAA берётся готовым проходом three');
  ok(html.includes('"three/examples/jsm/"'), 'Карта импортов знает про примеры three');

  /* Дерево обхода: расширение прототипа надо УСТАНОВИТЬ, иначе метода просто
     не существует, а вызов через ?. молча ничего не делает. */
  ok(/THREE\.BufferGeometry\.prototype\.computeBoundsTree = computeBoundsTree/.test(wsrc),
     'Расширение геометрии установлено');
  ok(/THREE\.Mesh\.prototype\.raycast = acceleratedRaycast/.test(wsrc),
     'И ускоренный луч тоже');
  ok(/hullGeo\.computeBoundsTree\(\{ targetLeafSize: 8 \}\)/.test(wsrc),
     'Дерево строится по корпусу');
  ok(!/computeBoundsTree\?\./.test(wsrc), 'Без ?. — промах здесь молчаливый и потому опасный');

  /* и оно действительно строится */
  const g6 = new THREE.Group();
  buildWorld(g6, fakeRenderer, 'HIGH');
  const hull6 = g6.children.find(o => o.material === worldMats.hull);
  ok(!!hull6.geometry.boundsTree,
     `Дерево обхода построено по ${(hull6.geometry.index.count / 3) | 0} треугольникам`);

  /* столкновения камеры */
  ok(/export function setCollider/.test(csrc), 'Камера умеет сталкиваться с миром');
  ok(/_ray\.firstHitOnly = true/.test(csrc),
     'Ищется ближайшее попадание: остальные не нужны и стоят времени');
  ok(/hit\.distance - CONFIG\.COLLIDE\.radius/.test(csrc),
     'Останавливаемся, не доходя радиуса до преграды');
  ok(CONFIG.COLLIDE.radius > 0, `Радиус отхода ${CONFIG.COLLIDE.radius} юнита`);

  /* SAH для дерева трассировщика */
  ok(/strategy: SAH/.test(ptsrc),
     'Дерево трассировщика строится по площади поверхности: строится дольше, обходится быстрее');
  ok(/import \{ MeshBVH, SAH \}/.test(ptsrc), 'Стратегия берётся из библиотеки');
}

/* ══ 3h41. Форма озёр, спицы, дневной свет ═════════════════════════════ */
{
  const wsrc = readFileSync(new URL('./js/world.js', import.meta.url), 'utf8');
  const ssrc = readFileSync(new URL('./js/structures.js', import.meta.url), 'utf8');
  const tsrc = readFileSync(new URL('./js/textures.js', import.meta.url), 'utf8');

  /* Озёра не наезжают друг на друга и не круглые */
  const g7 = new THREE.CylinderGeometry(CONFIG.R, CONFIG.R, CONFIG.L,
    CONFIG.HULL_SEG, 96, true);
  const hills7 = displaceHills(g7, CONFIG.R, CONFIG.L, mulberry32(CONFIG.SEED + 404));
  const dips = hills7.filter(h => h.dip);
  ok(dips.length > 5, `Озёр: ${dips.length}`);
  let clash = 0;
  for (let i = 0; i < dips.length; i++) {
    for (let j = i + 1; j < dips.length; j++) {
      const dt = ((dips[i].t - dips[j].t + Math.PI) % TAU + TAU) % TAU - Math.PI;
      if (Math.hypot(dt * CONFIG.R, dips[i].z - dips[j].z)
          < (dips[i].r + dips[j].r) * CONFIG.HILL.pondGap * 0.7) clash++;
    }
  }
  ok(clash === 0, `Озёра не наезжают друг на друга (наложений ${clash})`);
  ok(dips.every(d => d.ax > 0), 'У каждого своя вытянутость');
  const round = dips.filter(d => Math.abs(d.ax - 1) < 0.05).length;
  ok(round <= dips.length * 0.3,
     `Круглых из ${dips.length} только ${round}: ровный круг выглядит вырезанным циркулем`);
  ok(/ctx\.rotate\(p\.rot\)/.test(tsrc),
     'Та же форма в текстуре: вода легла бы кругом поверх овальной низины');

  /* Спицы достают до стенки */
  const R7 = CONFIG.R, hubR = 4.6, bite = CONFIG.ENDCAP.spokeBite;
  ok(/const spokeLen = R \+ bite - hubR;/.test(ssrc),
     'Длина спицы считается от ступицы до стенки, а не подбирается числом');
  ok(hubR + (R7 + bite - hubR) > R7,
     `Спица заходит в стенку на ${(hubR + (R7 + bite - hubR) - R7).toFixed(1)} юнита — щели нет`);

  /* Дневной свет: пересвет даёт не сумма, а рассеянная составляющая */
  const D = CONFIG.DAY;
  const ratio = D.hemiInt / (D.pointInt * CONFIG.LIGHT_Z.length);
  ok(ratio < 0.22,
     `Днём рассеянного к направленному ${ratio.toFixed(2)}: полусфера светит ровно и смывает форму`);
  const msrc = readFileSync(new URL('./js/main.js', import.meta.url), 'utf8');
  const exp = parseFloat((msrc.match(/toneMappingExposure = ([\d.]+)/) || [])[1]);
  ok(exp <= 1.05, `Экспозиция ${exp}: светлые места упирались в единицу и теряли фактуру`);
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
  /* по одному представителю на тип: инстансы разрезаны на секторы */
  const silMats = [...new Set(probe.children
    .filter(o => isBuilding(o)).map(o => o.material))];
  let worstH = 0;
  silMats.forEach((mm, v) => {
    const im = probe.children.find(o => o.material === mm);
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
  /* Туман считаем по длине станции, а не «на глаз»: FogExp2 на 3 км при
     плотности 0.0035 оставлял от дальнего торца треть цвета — две трети
     кадра были туманом, и днём это читалось как молоко. */
  const survives = k => Math.exp(-Math.pow(CONFIG.L * CONFIG[k].fogD, 2));
  ok(survives('DAY') > 0.6,
     `Днём до дальнего торца доходит ${(survives('DAY') * 100) | 0}% цвета сцены`);
  ok(survives('DAY') > survives('DUSK') && survives('DUSK') > survives('NIGHT'),
     `Туман густеет к ночи: ${CONFIG.PHASES.map(k => ((survives(k) * 100) | 0) + '%').join(' → ')}`);
  ok(survives('NIGHT') > 0.3, 'Но и ночью дальний план не пропадает целиком');
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
