/* Золотые снимки мира. Эталоны test/golden/ сняты с ПРЕЖНЕГО мира
   (js/world.js + js/structures.js, до v2.12.0) и остаются эталоном.

   С v2.12.0 мир снимается с того, что рисует приложение: core buildScene()
   → backends/three createThreeWorld() (без пикселей текстур), группа
   stationGroup. Задокументированные отличия от прежних объектов
   приводятся к прежнему виду при снятии (normalizeHull) или сравниваются
   по смыслу (compareCase):
     · корпус: ядро отдаёт его лицом внутрь (FrontSide, нормали внутрь,
       u ↦ 0.5 − u, обход обращён) с normalScale «как отрисовано» (−1, −1);
       прежний — BackSide, нормали наружу, (1, 1) в материале (three сам
       обращал его для BackSide). Снятие возвращает прежний вид; индекс
       корпуса сравнивается как МНОЖЕСТВО треугольников (обе стороны прошли
       перестройку three-mesh-bvh);
     · группы 'tower' нет: ядро запекает её матрицу в tower.*; объекты
       сравниваются матрицей в системе станции (допуск TOL_BAKED);
     · прозрачность по ParamRef (blob, print): прежние конструкторы
       говорили 0.85, applyPalette(0) перебивал её до первого кадра; у
       адаптера она сразу дневная — не сравнивается;
     · normalScale без карты нормалей (LOW) инертен — выбрасывается;
     · порядок объявления атрибутов — как множество.

   Матрица случаев «зерно × пресет × сезон». По каждому объекту (имя — его
   роль) пишется:
     · тип, счётчики вершин/индексов/инстансов, группы, drawRange;
     · сводка материалов (тип, цвет, шероховатость, металличность, эмиссия,
       наличие карт и т.п.);
     · локальное преобразование, сфера отсечения инстансов;
     · ДАННЫЕ: атрибуты геометрии, индекс, instanceMatrix, instanceColor.
   Плюс список холмов и прудов.

   Хранение (test/golden/<case>/):
     manifest.json  — всё описание, у каждого массива: тип, длина, точный
                      FNV-1a хэш сырых байтов (exact) и FNV-1a хэш значений,
                      квантованных до 1e-4 (quant);
     data.bin.gz    — только для «полных» случаев (LOW, HIGH): все массивы
                      подряд, выровнены по 8 байт; смещения — в manifest.

   Проверка:
     · счётчики, порядок и имена объектов, материалы — точно;
     · полные случаи: массивы с допуском 1e-5 по модулю (целые — точно);
     · крупные случаи (ULTRAM, ULTRA): квантованный хэш обязан совпасть;
     · расхождение точного хэша при совпавшем квантованном — «не бит в бит»,
       сообщается отдельно (провал только в строгом режиме). */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import * as THREE from 'three';
import { CONFIG } from '../js/config.js';
import { CORE_CONFIG } from '../core/config/index.ts';
import { buildScene } from '../core/scene/build.ts';
import { createThreeWorld } from '../backends/three/adapt/sceneGraph.ts';

export const FORMAT = 1;
export const TOL = 1e-5;
export const QUANT = 1e-4;
/** запечённые матрицы (группа 'tower' умножена на детей во float32) */
export const TOL_BAKED = 1e-4;
export const GOLDEN_DIR = fileURLToPath(new URL('../test/golden/', import.meta.url));

/** Роль объекта: имя без суффикса сектора `.s<N>` */
export const roleOf = name => String(name || '').replace(/\.s\d+$/, '');

/* Матрица случаев. Заводское зерно (SEED_DEFAULT) совпадает с 1337, поэтому
   второе зерно — 42, иначе вторая половина матрицы повторяла бы первую. */
const SEED_A = CORE_CONFIG.SEED_DEFAULT >>> 0;
const SEED_B = SEED_A === 1337 ? 42 : 1337;
const SEASON0 = CORE_CONFIG.SEASON_DEFAULT;
const ALT_SEASON = SEASON0 === 'winter' ? 'autumn' : 'winter';
const FULL = { LOW: true, HIGH: true, ULTRAM: false, ULTRA: false };

export const CASES = [];
for (const seed of [SEED_A, SEED_B]) {
  for (const quality of ['LOW', 'HIGH', 'ULTRAM', 'ULTRA']) {
    CASES.push({ id: `s${seed}-${quality}-${SEASON0}`, seed, quality, season: SEASON0, full: FULL[quality] });
  }
}
CASES.push({ id: `s${SEED_A}-LOW-${ALT_SEASON}`, seed: SEED_A, quality: 'LOW', season: ALT_SEASON, full: true });

const fakeRenderer = { capabilities: { getMaxAnisotropy: () => 8 } };

/* ───────────── хэши ───────────── */
function fnvBytes(u8, h = 0x811c9dc5) {
  for (let k = 0; k < u8.length; k++) {
    h ^= u8[k];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
const hex = h => h.toString(16).padStart(8, '0');
const bytesOf = a => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
const isFloat = a => a instanceof Float32Array || a instanceof Float64Array;

function quantHash(a) {
  if (!isFloat(a)) return hex(fnvBytes(bytesOf(a)));
  const q = new Int32Array(a.length);
  for (let k = 0; k < a.length; k++) {
    const v = Math.round(a[k] / QUANT);
    q[k] = Number.isFinite(v) ? v : 0x7fffffff;
  }
  return hex(fnvBytes(bytesOf(q)));
}

const TYPES = {
  f32: Float32Array, f64: Float64Array, u32: Uint32Array, u16: Uint16Array,
  u8: Uint8Array, i32: Int32Array, i16: Int16Array, i8: Int8Array
};
const tagOf = a => {
  for (const [t, C] of Object.entries(TYPES)) if (a instanceof C) return t;
  throw new Error('неизвестный тип массива ' + a?.constructor?.name);
};

/** Треугольники как множество: порядок треугольников (его переставляет
    дерево обхода three-mesh-bvh у корпуса) и сдвиг вершин внутри треугольника
    с сохранением обхода не влияют. Ядру без three этот хэш и нужен. */
function triSetHash(index) {
  const n = (index.length / 3) | 0;
  const tri = new Uint32Array(n * 3);
  for (let k = 0; k < n; k++) {
    let a = index[k * 3], b = index[k * 3 + 1], c = index[k * 3 + 2];
    if (b < a && b <= c) [a, b, c] = [b, c, a];
    else if (c < a && c < b) [a, b, c] = [c, a, b];
    tri[k * 3] = a; tri[k * 3 + 1] = b; tri[k * 3 + 2] = c;
  }
  const order = new Uint32Array(n);
  for (let k = 0; k < n; k++) order[k] = k;
  order.sort((x, y) => (tri[x * 3] - tri[y * 3]) || (tri[x * 3 + 1] - tri[y * 3 + 1])
    || (tri[x * 3 + 2] - tri[y * 3 + 2]));
  const out = new Uint32Array(n * 3);
  for (let k = 0; k < n; k++) {
    const s = order[k] * 3;
    out[k * 3] = tri[s]; out[k * 3 + 1] = tri[s + 1]; out[k * 3 + 2] = tri[s + 2];
  }
  return hex(fnvBytes(bytesOf(out)));
}

/* ───────────── сводки ───────────── */
const r6 = v => Math.round(v * 1e6) / 1e6;
const MAPS = ['map', 'normalMap', 'emissiveMap', 'alphaMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'bumpMap'];
function matSummary(m) {
  const s = { type: m.type };
  if (m.color) s.color = '#' + m.color.getHexString();
  if (m.emissive) s.emissive = '#' + m.emissive.getHexString();
  for (const k of ['roughness', 'metalness', 'emissiveIntensity', 'opacity', 'alphaTest', 'size']) {
    if (typeof m[k] === 'number') s[k] = r6(m[k]);
  }
  for (const k of ['transparent', 'vertexColors', 'flatShading', 'depthWrite', 'toneMapped', 'fog']) {
    if (typeof m[k] === 'boolean') s[k] = m[k];
  }
  s.side = m.side;
  s.blending = m.blending;
  s.maps = MAPS.filter(k => m[k]);
  if (m.normalScale) s.normalScale = [r6(m.normalScale.x), r6(m.normalScale.y)];
  return s;
}

/* ───────────── сборка и снятие ───────────── */
const paramsOf = c => ({
  seed: c.seed >>> 0, quality: c.quality, season: c.season,
  saturation: CORE_CONFIG.SATURATION_DEFAULT, greenK: CORE_CONFIG.GREEN_K_DEFAULT
});

/** Корпус ядра → прежний вид: нормали наружу, u ↦ 0.5 − u, обход обращён
    (индекс потом сравнивается только как множество треугольников). */
function normalizeHull(geo) {
  const g = new THREE.BufferGeometry();
  for (const [name, at] of Object.entries(geo.attributes)) {
    let a = at.array;
    if (name === 'normal') a = a.map(v => -v);
    if (name === 'uv') a = a.map((v, i) => (i % 2 ? v : 0.5 - v));
    g.setAttribute(name, new THREE.BufferAttribute(a, at.itemSize, at.normalized));
  }
  if (geo.index) {
    const s = geo.index.array, idx = new s.constructor(s.length);
    for (let i = 0; i < s.length; i += 3) { idx[i] = s[i]; idx[i + 1] = s[i + 2]; idx[i + 2] = s[i + 1]; }
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  for (const gr of geo.groups) g.addGroup(gr.start, gr.count, gr.materialIndex);
  g.setDrawRange(geo.drawRange.start, geo.drawRange.count);
  return g;
}

/** Собрать мир случая (core → адаптер) и снять с него всё: { meta, arrays } —
    arrays[i] соответствует ref i в meta. */
export function captureCase(c) {
  const cfgBefore = JSON.stringify(CONFIG);
  const t0 = performance.now();
  const scene = buildScene(paramsOf(c));
  const world = createThreeWorld(scene, fakeRenderer, { textures: 'none' });
  const group = world.stationGroup;
  const buildMs = performance.now() - t0;
  const configMutated = JSON.stringify(CONFIG) !== cfgBefore;

  const arrays = [];
  const ref = a => {
    const r = { type: tagOf(a), len: a.length, exact: hex(fnvBytes(bytesOf(a))), quant: quantHash(a) };
    r.i = arrays.length;
    arrays.push(a);
    return r;
  };
  const geos = new Map();
  const geoOf = (geo0, user, hull) => {
    if (geos.has(geo0.uuid)) return geos.get(geo0.uuid).id;
    const geo = hull ? normalizeHull(geo0) : geo0;
    const g = { id: 'g' + geos.size, firstUser: user, attributes: {}, attrOrder: [] };
    for (const [name, at] of Object.entries(geo.attributes)) {
      if (at.isInterleavedBufferAttribute) throw new Error(`${user}: чередующийся атрибут ${name}`);
      g.attrOrder.push(name);
      g.attributes[name] = { itemSize: at.itemSize, count: at.count, normalized: at.normalized, data: ref(at.array) };
    }
    g.vertexCount = geo.attributes.position ? geo.attributes.position.count : 0;
    g.index = geo.index ? ref(geo.index.array) : null;
    g.indexCount = geo.index ? geo.index.count : 0;
    if (geo.index) g.triSet = triSetHash(geo.index.array);
    if (hull) g.triSetOnly = true;
    g.groups = geo.groups.map(x => [x.start, x.count, x.materialIndex ?? 0]);
    g.drawRange = [geo.drawRange.start, Number.isFinite(geo.drawRange.count) ? geo.drawRange.count : -1];
    geos.set(geo0.uuid, g);
    return g.id;
  };
  /* материалы, чья прозрачность следует ParamRef (см. шапку) */
  const refOpacity = m => {
    const d = scene.materials[m.name];
    return !!d && typeof d.alpha === 'object' && 'blend' in d.alpha && typeof d.alpha.blend === 'object';
  };
  const summaryOf = (m, hull) => {
    const s = matSummary(m);
    if (hull && s.side === THREE.FrontSide) {
      s.side = THREE.BackSide;
      if (s.normalScale) s.normalScale = s.normalScale.map(v => -v || 0);
    }
    if (refOpacity(m)) s.opacityRef = true;
    return s;
  };

  const objects = [];
  const seen = new Map();
  const unnamed = [];
  let drawn = 0;
  group.traverse(o => {
    if (o === group) return;
    let name = o.name;
    if (!name) { name = `?${o.type}#${objects.length}`; unnamed.push(name); }
    const dup = seen.get(name) || 0;
    seen.set(name, dup + 1);
    if (dup) name += '#' + (dup + 1);
    const hull = roleOf(o.name) === 'hull';
    const e = {
      name, role: roleOf(o.name), type: o.type, parent: o.parent === group ? null : (o.parent.name || '?'),
      visible: o.visible, renderOrder: o.renderOrder, frustumCulled: o.frustumCulled,
      position: o.position.toArray(), quaternion: o.quaternion.toArray(), scale: o.scale.toArray()
    };
    if (o.geometry) e.geo = geoOf(o.geometry, name, hull);
    if (o.material) {
      e.material = Array.isArray(o.material) ? o.material.map(m => summaryOf(m, hull)) : summaryOf(o.material, hull);
      /* прежний buildWorld считал свои объекты (sceneParts): это объекты мира 'w.' */
      const m0 = Array.isArray(o.material) ? o.material[0] : o.material;
      if (String(m0.name).startsWith('w.')) drawn++;
    }
    if (o.isInstancedMesh) {
      e.count = o.count;
      e.capacity = o.instanceMatrix.count;
      e.instanceMatrix = ref(o.instanceMatrix.array);
      e.instanceColor = o.instanceColor ? ref(o.instanceColor.array) : null;
      if (o.boundingSphere) e.boundingSphere = [...o.boundingSphere.center.toArray(), o.boundingSphere.radius];
    }
    objects.push(e);
  });

  /* холмы и пруды в прежнем виде ({t, z, r, h, dip, ax, rot} / {t, z, r, ax, rot}) */
  const dd = CORE_CONFIG.HILL.dipDepth;
  const hills = scene.hull.hills.map(h => ({
    t: h.theta, z: h.z, r: h.r, h: h.rise < 0 ? -h.rise / dd : h.rise, dip: h.rise < 0, ax: h.ax, rot: h.rot
  }));
  const ponds = scene.hull.hills.filter(h => h.pond).map(h => ({ t: h.theta, z: h.z, r: h.pond.r, ax: h.ax, rot: h.rot }));
  world.dispose();

  const meta = {
    format: FORMAT, id: c.id, seed: c.seed, quality: c.quality, season: c.season, full: c.full,
    three: THREE.REVISION, drawn, hills, ponds,
    objects, geometries: [...geos.values()], unnamed, configMutated
  };
  return { meta, arrays, buildMs };
}

/* ───────────── запись ───────────── */
export function writeCase(cap) {
  const dir = GOLDEN_DIR + cap.meta.id + '/';
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const meta = structuredClone(cap.meta);
  let bytes = 0;
  if (meta.full) {
    const chunks = [];
    let off = 0;
    const offs = cap.arrays.map(a => {
      const pad = (8 - (off % 8)) % 8;
      if (pad) chunks.push(Buffer.alloc(pad));
      off += pad;
      const o = off;
      chunks.push(Buffer.from(a.buffer, a.byteOffset, a.byteLength));
      off += a.byteLength;
      return o;
    });
    forEachRef(meta, r => { r.off = offs[r.i]; });
    const gz = gzipSync(Buffer.concat(chunks), { level: 9 });
    writeFileSync(dir + 'data.bin.gz', gz);
    bytes += gz.length;
  }
  forEachRef(meta, r => { delete r.i; });
  const json = JSON.stringify(meta, null, 1);
  writeFileSync(dir + 'manifest.json', json);
  bytes += Buffer.byteLength(json);
  return bytes;
}

/* обходит все ссылки на массивы в описании, в одном и том же порядке */
function forEachRef(meta, fn) {
  for (const g of meta.geometries) {
    for (const n of g.attrOrder) fn(g.attributes[n].data, `${g.firstUser}:${n}`, g.firstUser);
    if (g.index) fn(g.index, `${g.firstUser}:index`, g.firstUser);
  }
  for (const o of meta.objects) {
    if (o.instanceMatrix) fn(o.instanceMatrix, `${o.name}:instanceMatrix`, o.name);
    if (o.instanceColor) fn(o.instanceColor, `${o.name}:instanceColor`, o.name);
  }
}

/* ───────────── сравнение ───────────── */
function loadArray(buf, r) {
  const C = TYPES[r.type];
  const start = buf.byteOffset + r.off;
  return new C(buf.buffer.slice(start, start + r.len * C.BYTES_PER_ELEMENT));
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const maxVecDev = (a, b) => {
  if (!a || !b || a.length !== b.length) return Infinity;
  let d = 0;
  for (let k = 0; k < a.length; k++) d = Math.max(d, Math.abs(a[k] - b[k]));
  return d;
};

/** Сравнить один случай с эталоном. Возвращает строки проблем и сводку по
    ролям: { role: { objects, instances, maxDev, notExact, fail } }. */
export function compareCase(gold, cap, { strict = false } = {}) {
  const problems = [];
  const roles = {};
  const cur = cap.meta;
  const R = name => {
    const role = roleOf(String(name).replace(/#\d+$/, ''));
    return (roles[role] ??= { objects: 0, instances: 0, maxDev: 0, notExact: 0, fail: 0, bigHashOnly: false });
  };
  const bad = (name, msg) => { problems.push(`${cur.id} ${name}: ${msg}`); R(name).fail++; };

  if (cur.unnamed.length) problems.push(`${cur.id}: объекты без имени: ${cur.unnamed.join(', ')}`);
  if (cur.configMutated) problems.push(`${cur.id}: сборка мира изменила CONFIG`);
  if (gold.format !== FORMAT) problems.push(`${cur.id}: формат эталона ${gold.format}, ожидался ${FORMAT}`);

  /* холмы и пруды */
  for (const k of ['hills', 'ponds']) {
    const a = gold[k], b = cur[k];
    if (!a || !b || a.length !== b.length) { bad(k, `число ${a?.length} → ${b?.length}`); continue; }
    let d = 0;
    for (let i = 0; i < a.length; i++) {
      for (const f of Object.keys(a[i])) {
        if (typeof a[i][f] === 'number') d = Math.max(d, Math.abs(a[i][f] - b[i][f]));
        else if (a[i][f] !== b[i][f]) d = Infinity;
      }
    }
    const rr = R(k); rr.objects = a.length; rr.maxDev = Math.max(rr.maxDev, d);
    if (!(d <= TOL)) bad(k, `отклонение ${d}`);
  }
  if (gold.drawn !== cur.drawn) bad('drawn', `${gold.drawn} → ${cur.drawn}`);

  /* состав и порядок объектов (без групп, которых у ядра нет: 'tower') */
  const cByName = new Map(cur.objects.map(o => [o.name, o]));
  const dropped = new Map(gold.objects.filter(o => o.type === 'Group' && !cByName.has(o.name)).map(o => [o.name, o]));
  const gNames = gold.objects.filter(o => !dropped.has(o.name)).map(o => o.name), cNames = cur.objects.map(o => o.name);
  if (!same(gNames, cNames)) {
    const miss = gNames.filter(n => !cNames.includes(n)), extra = cNames.filter(n => !gNames.includes(n));
    problems.push(`${cur.id}: состав объектов изменился` +
      (miss.length ? `; пропали: ${miss.join(', ')}` : '') +
      (extra.length ? `; новые: ${extra.join(', ')}` : '') +
      (!miss.length && !extra.length ? '; изменился порядок' : ''));
  }

  const gGeo = new Map(gold.geometries.map(g => [g.id, g]));
  const cGeo = new Map(cur.geometries.map(g => [g.id, g]));
  const data = gold.full ? gold.__data : null;

  /* сравнение одного массива: эталонная ссылка gr, текущий массив arr */
  const cmpArray = (name, what, gr, cr) => {
    const rr = R(name);
    if (!gr || !cr) { if (gr || cr) bad(name, `${what}: есть только с одной стороны`); return; }
    if (gr.type !== cr.type || gr.len !== cr.len) {
      bad(name, `${what}: ${gr.type}[${gr.len}] → ${cr.type}[${cr.len}]`); return;
    }
    const exact = gr.exact === cr.exact;
    if (!exact) rr.notExact++;
    if (data) {
      const ga = loadArray(data, gr), ca = cap.arrays[cr.i];
      if (isFloat(ga)) {
        let d = 0;
        for (let k = 0; k < ga.length; k++) {
          const x = Math.abs(ga[k] - ca[k]);
          if (!(x <= d)) d = Number.isNaN(x) ? Infinity : x;
        }
        rr.maxDev = Math.max(rr.maxDev, d);
        if (!(d <= TOL)) bad(name, `${what}: отклонение ${d.toExponential(2)} > ${TOL}`);
      } else {
        let n = 0;
        for (let k = 0; k < ga.length; k++) if (ga[k] !== ca[k]) n++;
        if (n) { rr.maxDev = Infinity; bad(name, `${what}: ${n} несовпавших целых`); }
      }
    } else {
      rr.bigHashOnly = true;
      if (gr.quant !== cr.quant) { rr.maxDev = Infinity; bad(name, `${what}: квантованный хэш ${gr.quant} → ${cr.quant}`); }
    }
    if (!exact && strict) bad(name, `${what}: не бит в бит (exact ${gr.exact} → ${cr.exact})`);
  };

  for (const go of gold.objects) {
    const co = cByName.get(go.name);
    if (!co) continue;
    const name = go.name, rr = R(name);
    rr.objects++;
    rr.instances += co.count ?? 0;
    const baked = dropped.get(go.parent);
    for (const k of ['type', 'parent', 'visible', 'renderOrder', 'frustumCulled', 'count', 'capacity']) {
      if (k === 'parent' && baked) { if (co.parent !== null) bad(name, `parent: ${co.parent}`); continue; }
      if (go[k] !== co[k]) bad(name, `${k}: ${go[k]} → ${co[k]}`);
    }
    const gm = sameMaterials(go.material, co.material);
    if (gm) bad(name, `материал: ${gm}`);
    if (baked) {
      /* матрица группы запечена в объект: сравниваем в системе станции */
      const d = maxVecDev(matrixOf(baked).multiply(matrixOf(go)).toArray(), matrixOf(co).toArray());
      rr.maxDev = Math.max(rr.maxDev, d);
      if (!(d <= TOL_BAKED)) bad(name, `матрица в системе станции: отклонение ${d}`);
    }
    for (const k of baked ? ['boundingSphere'] : ['position', 'quaternion', 'scale', 'boundingSphere']) {
      if (!go[k] && !co[k]) continue;
      const d = maxVecDev(go[k], co[k]);
      rr.maxDev = Math.max(rr.maxDev, d);
      if (!(d <= TOL)) bad(name, `${k}: отклонение ${d}`);
    }
    if (go.instanceMatrix || co.instanceMatrix) cmpArray(name, 'instanceMatrix', go.instanceMatrix, co.instanceMatrix);
    if (go.instanceColor || co.instanceColor) cmpArray(name, 'instanceColor', go.instanceColor, co.instanceColor);

    /* геометрию сравниваем у её первого пользователя — дальше она общая */
    if (!!go.geo !== !!co.geo) { bad(name, 'геометрия есть только с одной стороны'); continue; }
    if (!go.geo) continue;
    const gg = gGeo.get(go.geo), cg = cGeo.get(co.geo);
    if (gg.firstUser !== cg.firstUser) { bad(name, `геометрия общая с ${gg.firstUser} → ${cg.firstUser}`); continue; }
    if (gg.firstUser !== name) continue;
    for (const k of ['vertexCount', 'indexCount', 'groups', 'drawRange']) {
      if (!same(gg[k], cg[k])) bad(name, `${k}: ${JSON.stringify(gg[k])} → ${JSON.stringify(cg[k])}`);
    }
    /* атрибуты — как множество: у GeometryDesc порядок полей фиксирован */
    if (!same([...gg.attrOrder].sort(), [...cg.attrOrder].sort())) bad(name, `атрибуты: ${gg.attrOrder} → ${cg.attrOrder}`);
    if (gg.triSet !== cg.triSet) bad(name, `множество треугольников: ${gg.triSet} → ${cg.triSet}`);
    for (const n of gg.attrOrder) {
      const ga = gg.attributes[n], ca = cg.attributes[n];
      if (!ca) continue;
      if (ga.itemSize !== ca.itemSize || ga.normalized !== ca.normalized) bad(name, `${n}: формат атрибута`);
      cmpArray(name, n, ga.data, ca.data);
    }
    /* корпус: обход обращён и треугольники переставлены деревом обхода —
       хватает множества треугольников (сравнено выше) */
    if (!cg.triSetOnly) cmpArray(name, 'index', gg.index, cg.index);
  }
  return { problems, roles };
}

const matrixOf = o => new THREE.Matrix4().compose(
  new THREE.Vector3().fromArray(o.position), new THREE.Quaternion().fromArray(o.quaternion), new THREE.Vector3().fromArray(o.scale));

/** Сводки материалов эталона и текущие; пустая строка — совпали.
    opacityRef: прозрачность по ParamRef не сравнивается; normalScale без
    карты нормалей инертен (см. шапку). */
function sameMaterials(g, c) {
  if (g === undefined && c === undefined) return '';
  const gl = Array.isArray(g) ? g : [g], cl = Array.isArray(c) ? c : [c];
  if (gl.length !== cl.length || Array.isArray(g) !== Array.isArray(c)) return `число ${gl.length} → ${cl.length}`;
  for (let i = 0; i < gl.length; i++) {
    const want = { ...gl[i] }, got = { ...cl[i] };
    if (got.opacityRef) { delete got.opacityRef; want.opacity = got.opacity; }
    if (!(want.maps || []).includes('normalMap') && !(got.maps || []).includes('normalMap')) {
      delete want.normalScale; delete got.normalScale;
    }
    if (!same(want, got)) return `[${i}] ${JSON.stringify(want)} → ${JSON.stringify(got)}`;
  }
  return '';
}

export function readGolden(id) {
  const dir = GOLDEN_DIR + id + '/';
  if (!existsSync(dir + 'manifest.json')) return null;
  const meta = JSON.parse(readFileSync(dir + 'manifest.json', 'utf8'));
  if (meta.full) meta.__data = gunzipSync(readFileSync(dir + 'data.bin.gz'));
  return meta;
}

/* ───────────── публичное API ───────────── */

/** Записать эталоны для всех случаев. */
export function writeWorldSnapshots({ log = console.log, only = null } = {}) {
  let total = 0;
  for (const c of CASES) {
    if (only && !only.includes(c.id)) continue;
    const cap = captureCase(c);
    const bytes = writeCase(cap);
    total += bytes;
    const warn = [cap.meta.unnamed.length ? `безымянных: ${cap.meta.unnamed.length}` : '',
      cap.meta.configMutated ? 'CONFIG изменён сборкой!' : ''].filter(Boolean).join('; ');
    log(`write ${c.id.padEnd(22)} ${String(cap.meta.objects.length).padStart(4)} объектов  ` +
      `${(bytes / 1048576).toFixed(2).padStart(6)} МБ  сборка ${cap.buildMs.toFixed(0)} мс${warn ? '  ' + warn : ''}`);
  }
  writeFileSync(GOLDEN_DIR + 'index.json', JSON.stringify({
    format: FORMAT, tol: TOL, quant: QUANT, three: THREE.REVISION,
    cases: CASES.map(c => ({ ...c }))
  }, null, 1));
  log(`всего ${(total / 1048576).toFixed(2)} МБ в ${GOLDEN_DIR}`);
  return total;
}

/** Сверить мир с эталонами. Случаи собираются в ОБРАТНОМ порядке записи:
    так ловится протечка состояния между сборками (модульные переменные,
    CONFIG). Возвращает { ok, problems, report, roles, cases }. */
export function checkWorldSnapshots({ strict = false, only = null, log = null } = {}) {
  const problems = [];
  const roles = {};
  const cases = [];
  const lines = [];
  for (const c of [...CASES].reverse()) {
    if (only && !only.includes(c.id)) continue;
    const gold = readGolden(c.id);
    if (!gold) { problems.push(`${c.id}: нет эталона — запустите node tools/snapshot-world.mjs --write`); continue; }
    const cap = captureCase(c);
    const r = compareCase(gold, cap, { strict });
    problems.push(...r.problems);
    let notExact = 0;
    for (const [role, s] of Object.entries(r.roles)) {
      const a = (roles[role] ??= { cases: 0, objects: 0, instances: 0, maxDev: 0, notExact: 0, fail: 0, hashOnlyCases: 0 });
      a.cases++; a.objects += s.objects; a.instances += s.instances;
      a.maxDev = Math.max(a.maxDev, s.maxDev); a.notExact += s.notExact; a.fail += s.fail;
      if (s.bigHashOnly) a.hashOnlyCases++;
      notExact += s.notExact;
    }
    const line = `check ${c.id.padEnd(22)} ${r.problems.length ? 'FAIL ' + r.problems.length : 'ok    '}  ` +
      `${c.full ? 'массивы ±' + TOL : 'хэши 1e-4'}  не бит в бит: ${notExact}  сборка ${cap.buildMs.toFixed(0)} мс`;
    lines.push(line); log?.(line);
    cases.push({ id: c.id, ok: !r.problems.length, buildMs: cap.buildMs, notExact });
  }
  lines.push('');
  lines.push('роль                случаев объектов  инстансов  макс.откл  не-бит-в-бит  итог');
  for (const [role, s] of Object.entries(roles).sort(([a], [b]) => a.localeCompare(b))) {
    const dev = s.maxDev === Infinity ? 'хэш≠' : s.maxDev.toExponential(1);
    lines.push(`${role.padEnd(20)}${String(s.cases).padStart(6)}${String(s.objects).padStart(9)}` +
      `${String(s.instances).padStart(11)}${dev.padStart(11)}${String(s.notExact).padStart(14)}  ${s.fail ? 'FAIL' : 'ok'}`);
  }
  if (problems.length) {
    lines.push('', 'проблемы:');
    for (const p of problems.slice(0, 60)) lines.push('  ' + p);
    if (problems.length > 60) lines.push(`  … и ещё ${problems.length - 60}`);
  }
  const report = lines.join('\n');
  return { ok: problems.length === 0, problems, report, roles, cases };
}