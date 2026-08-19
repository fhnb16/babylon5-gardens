import * as THREE from 'three';
import { CONFIG } from './config.js';
import {
  mulberry32, D2R, TAU, clamp, pick, zoneAt, surfaceQuat, surfacePos, mergeGeos, rod, deepDispose
} from './util.js';
import {
  makeHullMaps, makeDetailTexture, makeFacade, makePanelTexture, makeSoftSprite, makeBlobTexture
} from './textures.js';

/* ═══════════════════════════════════════════════════════════════════════════
   ШЕЙДЕР КОРПУСА
   Расширяем MeshStandardMaterial через onBeforeCompile — всё освещение,
   туман и тонмаппинг three остаются, мы добавляем только своё:
     · детальный шум поверх биомов (иначе тексель = 1.5 м, каша);
     · вода: низкая шероховатость + рябь → настоящий блик от солнца на оси;
     · тени силовых ферм. Свет — линия на оси, ферма радиальна, значит её
       тень ложится ровно на тот же угол θ. Считается аналитически, даром.
   ═══════════════════════════════════════════════════════════════════════════ */
export const hullU = {
  uMask: { value: null }, uDetail: { value: null },
  uTime: { value: 0 }, uDetailRep: { value: CONFIG.DETAIL_REP },
  uArm: { value: [] }, uArmW: { value: 0.055 },
  uSparZ: { value: [] }, uSparZW: { value: 30.0 },
  uSparShade: { value: CONFIG.DAY.sparShade },
  uCityGlow: { value: CONFIG.DAY.cityGlow },
  uWaterTint: { value: new THREE.Color(CONFIG.DAY.waterTint) }
};
export const windU = { uTime: hullU.uTime, uWind: { value: 1 } };

function patchHullMaterial(mat, nArm, nSpar) {
  mat.onBeforeCompile = s => {
    Object.assign(s.uniforms, hullU);

    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>
        varying float vTh;
        varying float vZo;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vTh = atan( position.x, position.y );
        vZo = position.z;`);

    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vTh;
        varying float vZo;
        uniform sampler2D uMask;
        uniform sampler2D uDetail;
        uniform float uTime, uDetailRep, uArmW, uSparZW, uSparShade, uCityGlow;
        uniform float uArm[${nArm}];
        uniform float uSparZ[${nSpar}];
        uniform vec3 uWaterTint;
        vec3 hullMask;`)

      /* --- альбедо: детальный шум + тонировка воды + тени ферм --- */
      .replace('#include <map_fragment>', `#include <map_fragment>
        hullMask = texture2D( uMask, vMapUv ).rgb;
        float dGrass = texture2D( uDetail, vMapUv * uDetailRep ).r;
        float dPave  = texture2D( uDetail, vMapUv * uDetailRep * 0.31 ).r;
        diffuseColor.rgb *= mix( 1.0, 0.70 + 0.60 * dGrass, hullMask.g * 0.9 );
        diffuseColor.rgb *= mix( 1.0, 0.86 + 0.28 * dPave,  hullMask.b * 0.7 );
        diffuseColor.rgb = mix( diffuseColor.rgb, uWaterTint, hullMask.r * 0.75 );

        // тень фермы: угловой створ × локальность по z
        float zt = 0.0;
        for ( int j = 0; j < ${nSpar}; j++ )
          zt = max( zt, 1.0 - smoothstep( 0.0, uSparZW, abs( vZo - uSparZ[j] ) ) );
        float shade = 1.0;
        for ( int i = 0; i < ${nArm}; i++ ) {
          float d = vTh - uArm[i];
          d = mod( d + PI, 2.0 * PI ) - PI;
          shade -= uSparShade * zt * ( 1.0 - smoothstep( 0.0, uArmW, abs( d ) ) );
        }
        diffuseColor.rgb *= clamp( shade, 0.25, 1.0 );`)

      /* --- ночью улицы и площади светятся сами: огни видно, а не только окна --- */
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += uCityGlow * hullMask.b
          * ( 0.35 + 1.1 * dPave ) * vec3( 1.0, 0.78, 0.48 );`)

      /* --- вода зеркальна --- */
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix( roughnessFactor, 0.055, hullMask.r );`)

      /* --- рябь на воде: возмущаем нормаль, блик солнца сам поедет --- */
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        if ( hullMask.r > 0.02 ) {
          vec2 rp = vMapUv * vec2( 1400.0, 900.0 );
          float r1 = sin( rp.y * 0.9 + uTime * 1.4 ) + sin( rp.x * 0.5 - uTime * 0.7 );
          float r2 = sin( rp.y * 0.4 - rp.x * 0.3 + uTime * 1.1 );
          normal = normalize( normal + vec3( r1, r2, 0.0 ) * 0.035 * hullMask.r );
        }`);
  };
  mat.customProgramCacheKey = () => 'b5-hull';
}

/** Ветер в кронах: сдвигаем вершины инстанса, фаза — из его же матрицы */
function patchWindMaterial(mat) {
  mat.onBeforeCompile = s => {
    Object.assign(s.uniforms, windU);
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\n uniform float uTime, uWind;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          float ph = instanceMatrix[3][0] * 0.7 + instanceMatrix[3][2] * 0.3;
          float sway = sin( uTime * 1.7 + ph ) + 0.5 * sin( uTime * 2.9 + ph * 1.7 );
          float amp = 0.035 * uWind * ( transformed.y + 0.9 );
          transformed.x += sway * amp;
          transformed.z += cos( uTime * 1.3 + ph ) * amp * 0.6;
        #endif`);
  };
  mat.customProgramCacheKey = () => 'b5-wind';
}

/** Горизонтальные грани переводим в кровельную полосу текстуры фасада:
    иначе крыша здания оказывается оклеена окнами — и сверху это читается
    как непонятная решётчатая плита. Работает и для боксов, и для торцов
    цилиндров: критерий — нормаль вдоль ±Y. */
function roofUV(geo, band = 0.88) {
  const p = geo.attributes.position, n = geo.attributes.normal, uv = geo.attributes.uv;
  for (let k = 0; k < p.count; k++) {
    if (Math.abs(n.getY(k)) < 0.9) continue;
    uv.setXY(k,
      clamp(p.getX(k) + 0.5, 0, 1),
      band + clamp(p.getZ(k) + 0.5, 0, 1) * (1 - band));
  }
  uv.needsUpdate = true;
  return geo;
}

/* ═══════════════════════════════════════════════════════════════════════════
   СИЛУЭТЫ ЗДАНИЙ — 4 типа, каждый склеен из примитивов в единичный куб.
   Разнообразие формы бесплатно: тип по-прежнему один InstancedMesh.
   ═══════════════════════════════════════════════════════════════════════════ */
function buildingGeo(type) {
  const parts = [];
  const cyl = (r, h, y, seg = 14) => {
    const g = new THREE.CylinderGeometry(r, r, h, seg, 1, false);
    g.translate(0, y + h / 2, 0);
    return g;
  };
  if (type === 0) {           // ступенчатая башня
    parts.push(rod(1, 0.5, 1, 0, 0.25, 0));
    parts.push(rod(0.74, 0.34, 0.74, 0, 0.67, 0));
    parts.push(rod(0.46, 0.2, 0.46, 0, 0.94, 0));
    parts.push(rod(0.1, 0.14, 0.1, 0.12, 1.07, 0.12));
  } else if (type === 1) {    // низкая плита с надстройкой
    parts.push(rod(1, 0.5, 1, 0, 0.25, 0));
    parts.push(rod(1.12, 0.06, 1.12, 0, 0.53, 0));      // карниз
    parts.push(cyl(0.3, 0.44, 0.56, 12));
    parts.push(rod(0.06, 0.24, 0.06, 0.2, 1.12, -0.2));  // мачта
  } else if (type === 2) {    // круглая башня-барабан
    parts.push(cyl(0.5, 0.84, 0));
    parts.push(cyl(0.58, 0.06, 0.84));
    parts.push(cyl(0.26, 0.1, 0.9, 10));
  } else {                    // приземистая розетка с террасой
    parts.push(cyl(0.5, 0.56, 0, 18));
    parts.push(cyl(0.62, 0.07, 0.56, 18));
    parts.push(cyl(0.24, 0.37, 0.63, 12));
  }
  const g = mergeGeos(parts);
  g.translate(0, -0.5, 0);    // база в y = -0.5, чтобы масштаб (w,h,d) работал
  return roofUV(g);
}

/* ═══════════════════════════════════════════════════════════════════════════
   СБОРКА МИРА
   ═══════════════════════════════════════════════════════════════════════════ */
export const worldMats = { bld: [], nav: null, blob: null };
let parts = [];

export function disposeWorld(group) {
  for (const o of parts) { group.remove(o); deepDispose(o); }
  parts = [];
  worldMats.bld = []; worldMats.nav = null; worldMats.blob = null;
}

export function buildWorld(group, renderer, quality) {
  disposeWorld(group);
  const LOW = quality === 'LOW';
  const i = LOW ? 1 : 0;
  const rnd = mulberry32(CONFIG.SEED);
  const R = CONFIG.R, L = CONFIG.L, HL = L / 2;
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const add = o => { group.add(o); parts.push(o); return o; };

  /* ─────────── КОРПУС ─────────── */
  const hullGeo = new THREE.CylinderGeometry(R, R, L, CONFIG.HULL_SEG, 1, true);
  hullGeo.rotateX(Math.PI / 2);
  const { albedo, mask } = makeHullMaps(LOW ? CONFIG.HULL_TEX.LOW : CONFIG.HULL_TEX.HIGH,
    mulberry32(CONFIG.SEED + 7));

  /* BackSide зеркалит U. Самотест сверяет реальные UV геометрии с мировым θ. */
  const flip = uvSelfTest(hullGeo, true);
  if (!flip && !uvSelfTest(hullGeo, false)) console.warn('UV корпуса: самотест не сошёлся');
  for (const t of [albedo, mask]) {
    if (flip) { t.repeat.x = -1; t.offset.x = 0.5; }
    t.anisotropy = Math.min(8, maxAniso);
  }
  const detail = makeDetailTexture(mulberry32(CONFIG.SEED + 11));
  detail.anisotropy = Math.min(4, maxAniso);

  /* углы силовых ферм — те же, что у structures.js, тени обязаны совпасть */
  const arms = [];
  for (let k = 0; k < CONFIG.AXIS.sparArms; k++) {
    arms.push((CONFIG.AXIS.sparAngle + k * 360 / CONFIG.AXIS.sparArms) * D2R);
  }
  hullU.uMask.value = mask;
  hullU.uDetail.value = detail;
  hullU.uArm.value = arms;
  hullU.uSparZ.value = CONFIG.AXIS.spars.slice();
  hullU.uArmW.value = CONFIG.AXIS.trussW / R * 1.4;

  const hullMat = new THREE.MeshStandardMaterial({
    map: albedo, side: THREE.BackSide, roughness: 0.95, metalness: 0.02
  });
  patchHullMaterial(hullMat, arms.length, CONFIG.AXIS.spars.length);
  add(new THREE.Mesh(hullGeo, hullMat));
  hullMat.userData.extra = [mask, detail];   // чтобы освободить при пересборке

  /* ─────────── ЗОНИРОВАННАЯ ВЫБОРКА ─────────── */
  const towerT = CONFIG.TOWER.deg * D2R;
  const free = (t, z) => {
    const arc = Math.abs(((t - towerT + Math.PI) % TAU + TAU) % TAU - Math.PI) * R;
    return Math.hypot(arc, z - CONFIG.TOWER.z) > CONFIG.TOWER_CLEAR;
  };
  const W_TREE = { park: 1.0, edge: 0.5, field: 0.13, city: 0.14, river: 0 };
  const W_BUSH = { park: 1.0, edge: 0.6, field: 0.24, city: 0.22, river: 0 };
  const W_HILL = { park: 0.9, edge: 0.9, field: 0.8, city: 0.04, river: 0 };

  /* Занятые пятна: раньше четыре типа зданий и эстакады выбирались
     независимо и свободно прорастали друг сквозь друга — отсюда странные
     плиты, торчащие из башен. Теперь всё городское резервирует место.
     ponytail: наивный O(n²) перебор по ~350 пятнам. Сетка, если станет тысячи. */
  const taken = [];
  const angGap = (a, b) => Math.abs(((a - b + Math.PI) % TAU + TAU) % TAU - Math.PI);
  const fits = (t, z, r) => {
    for (let k = 0; k < taken.length; k++) {
      const o = taken[k];
      if (Math.hypot(angGap(t, o[0]) * R, z - o[1]) < r + o[2]) return false;
    }
    return true;
  };

  /** rad — либо число, либо функция, возвращающая радиус конкретной попытки
      (холму нужен его собственный, иначе он резервирует не свой размер) */
  const sample = (w, n, rad = 0, claim = false) => {
    const out = [];
    for (let guard = 0; out.length < n && guard < n * 60; guard++) {
      const t = rnd() * TAU, z = -HL + rnd() * L;
      const p = w[zoneAt(t / D2R)];
      if (p <= 0 || rnd() > p) continue;
      const r = typeof rad === 'function' ? rad() : rad;
      if (!free(t, z) || !fits(t, z, r)) continue;
      out.push([t, z, r]);
      if (claim) taken.push([t, z, r]);
    }
    return out;
  };
  const cityWidth = CONFIG.SECT.cities.reduce((s, [a, b]) => s + (b - a), 0);
  /** offs — точки вдоль z, которые объект занимает (эстакада длинная) */
  const sampleCity = (n, rad, offs = [0]) => {
    const out = [];
    for (let guard = 0; out.length < n && guard < n * 150; guard++) {
      let v = rnd() * cityWidth, deg = 0;
      for (const [a, b] of CONFIG.SECT.cities) { if (v < b - a) { deg = a + v; break; } v -= b - a; }
      const t = deg * D2R, z = -HL + 10 + rnd() * (L - 20);
      if (!free(t, z) || !offs.every(o => fits(t, z + o, rad))) continue;
      out.push([t, z]);
      for (const o of offs) taken.push([t, z + o, rad]);
    }
    return out;
  };

  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v3 = new THREE.Vector3();
  const sc = new THREE.Vector3(), qs = new THREE.Quaternion(), UP = new THREE.Vector3(0, 1, 0);
  const shadows = [];   // [θ, z, радиус пятна]

  const instance = (geo, mat, list, fn) => {
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    im.frustumCulled = false;
    for (let k = 0; k < list.length; k++) fn(k, list[k][0], list[k][1], im, list[k][2]);
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    return add(im);
  };

  /* ─────────── ЗДАНИЯ: 4 силуэта × свой фасад ─────────── */
  const tints = [0x9fb0c4, 0xb6c2cf, 0x8c9db2, 0xc3ccd6, 0x7f90a5, 0xc9b7a4];
  const shape = CONFIG.BLD;
  for (let v = 0; v < 4; v++) {
    const { map, emis } = makeFacade(mulberry32(CONFIG.SEED + 31 * (v + 1)), v);
    map.anisotropy = Math.min(4, maxAniso);
    const mat = new THREE.MeshStandardMaterial({
      map, emissiveMap: emis, emissive: 0xffffff, emissiveIntensity: 0,
      roughness: 0.68, metalness: 0.1
    });
    worldMats.bld.push(mat);
    instance(buildingGeo(v), mat, sampleCity(CONFIG.COUNT.bld[i], shape[v].w[1] * 0.55), (k, t, z, im) => {
      const s = CONFIG.BLD[v];
      const h = s.h[0] + rnd() * (s.h[1] - s.h[0]);
      const w = s.w[0] + rnd() * (s.w[1] - s.w[0]), d = s.w[0] + rnd() * (s.w[1] - s.w[0]);
      surfaceQuat(t, q).multiply(qs.setFromAxisAngle(UP, ((rnd() * 4) | 0) * Math.PI / 2));
      m4.compose(surfacePos(t, R - h / 2, z, v3), q, sc.set(w, h, d));
      im.setMatrixAt(k, m4);
      im.setColorAt(k, new THREE.Color(pick(rnd, tints)));
      shadows.push([t, z, Math.max(w, d) * 0.75, 0]);
    });
  }

  /* Панельная текстура нужна конструкциям на оси и башне */
  const panel = makePanelTexture(mulberry32(CONFIG.SEED + 53));
  panel.anisotropy = Math.min(4, maxAniso);

  /* ─────────── ХОЛМЫ ───────────
     Раньше это была гладкая сфера радиусом до 340 м и высотой 100 м,
     резервировавшая место всего на 9 юнитов: зелёная блямба, глотавшая
     деревья и дома. Теперь пологая гранёная возвышенность, которая
     резервирует свой настоящий радиус, а зелень встаёт НА неё. */
  const HILL = CONFIG.HILL;
  const hills = [];   // [θ, z, радиус, высота] — рельеф для всего остального
  instance(
    new THREE.SphereGeometry(1, 12, 7),
    new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true }),
    /* холм СЧИТАЕТСЯ с застройкой, но сам места не занимает: зелень должна
       вырасти прямо на его склоне, а не быть отброшена от него */
    sample(W_HILL, CONFIG.COUNT.hills[i],
      () => HILL.r[0] + rnd() * (HILL.r[1] - HILL.r[0]), false),
    (k, t, z, im, rad) => {
      const h = rad * (HILL.rise[0] + rnd() * (HILL.rise[1] - HILL.rise[0]));
      hills.push([t, z, rad, h]);
      m4.compose(surfacePos(t, R, z, v3), surfaceQuat(t, q), sc.set(rad, h, rad));
      im.setMatrixAt(k, m4);
      im.setColorAt(k, new THREE.Color().setHSL(0.24 + rnd() * 0.07, 0.3 + rnd() * 0.2, 0.23 + rnd() * 0.13));
    });

  /** Высота купола холма в точке — чтобы дерево стояло на склоне, а не в нём */
  const relief = (t, z) => {
    let up = 0;
    for (let k = 0; k < hills.length; k++) {
      const [ht, hz, hr, hh] = hills[k];
      const d = Math.hypot(angGap(t, ht) * R, z - hz);
      if (d < hr) up = Math.max(up, hh * Math.sqrt(1 - (d / hr) * (d / hr)));
    }
    return up;
  };

  /* ─────────── ДЕРЕВЬЯ ─────────── */
  const treePts = sample(W_TREE, CONFIG.COUNT.trees[i], 1.6);
  const th = new Float32Array(treePts.length), tr = new Float32Array(treePts.length);
  const tu = new Float32Array(treePts.length);          // подъём по склону холма
  for (let k = 0; k < treePts.length; k++) {
    th[k] = 1.7 + rnd() * 2.8; tr[k] = 1.1 + rnd() * 1.7;
    tu[k] = relief(treePts[k][0], treePts[k][1]);
  }

  instance(
    new THREE.CylinderGeometry(0.13, 0.22, 1, 6),
    new THREE.MeshStandardMaterial({ color: 0x6b5236, roughness: 1 }),
    treePts,
    (k, t, z, im) => {
      m4.compose(surfacePos(t, R - tu[k] - th[k] / 2, z, v3), surfaceQuat(t, q), sc.set(1, th[k], 1));
      im.setMatrixAt(k, m4);
    });

  const greens = [0x3f6b2a, 0x4c7c33, 0x355c25, 0x598a3c, 0x2c5320, 0x6a9a44, 0x7ba851];
  const autumn = [0xc8562a, 0xd8792c, 0xb03a22, 0xe0973a, 0xa8452b];
  const crownMat = new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true });
  patchWindMaterial(crownMat);
  instance(new THREE.IcosahedronGeometry(1, 0), crownMat, treePts, (k, t, z, im) => {
    const r = tr[k];
    surfaceQuat(t, q).multiply(qs.setFromAxisAngle(UP, rnd() * TAU));
    m4.compose(surfacePos(t, R - tu[k] - (th[k] + r * 0.55), z, v3), q, sc.set(r, r * (0.85 + rnd() * 0.45), r));
    im.setMatrixAt(k, m4);
    im.setColorAt(k, new THREE.Color(rnd() < CONFIG.AUTUMN ? pick(rnd, autumn) : pick(rnd, greens)));
    shadows.push([t, z, r * 1.5, tu[k]]);
  });

  /* ─────────── КУСТЫ ─────────── */
  const bushMat = new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true });
  patchWindMaterial(bushMat);
  const bushCols = [0x3d6b2c, 0x4f7f38, 0x2f5424, 0xa63a2c, 0xbf5a2e, 0x6f9440, 0xd07a34];
  instance(new THREE.IcosahedronGeometry(1, 0), bushMat, sample(W_BUSH, CONFIG.COUNT.bushes[i], 1.0),
    (k, t, z, im) => {
      const s = 0.55 + rnd() * 1.0, up = relief(t, z);
      surfaceQuat(t, q).multiply(qs.setFromAxisAngle(UP, rnd() * TAU));
      m4.compose(surfacePos(t, R - up - s * 0.45, z, v3), q, sc.set(s, s * 0.7, s));
      im.setMatrixAt(k, m4);
      im.setColorAt(k, new THREE.Color(pick(rnd, bushCols)));
      shadows.push([t, z, s * 1.4, up]);
    });

  /* ─────────── КОНТАКТНЫЕ ТЕНИ ─────────── */
  const blobGeo = new THREE.PlaneGeometry(1, 1);
  blobGeo.rotateX(-Math.PI / 2);                  // нормаль в локальный +Y
  const blobMat = new THREE.MeshBasicMaterial({
    map: makeBlobTexture(), transparent: true, opacity: 0.85,
    depthWrite: false, fog: true
  });
  worldMats.blob = blobMat;
  const blobs = new THREE.InstancedMesh(blobGeo, blobMat, shadows.length);
  blobs.frustumCulled = false;
  blobs.renderOrder = 1;
  for (let k = 0; k < shadows.length; k++) {
    const [t, z, r, up] = shadows[k];
    m4.compose(surfacePos(t, R - up - 0.04, z, v3), surfaceQuat(t, q), sc.set(r * 2, 1, r * 2));
    blobs.setMatrixAt(k, m4);
  }
  blobs.instanceMatrix.needsUpdate = true;
  add(blobs);

  /* ─────────── ГАБАРИТНЫЕ ОГНИ ─────────── */
  const np = [];
  for (let deg = 0; deg < 360; deg += 15) {
    const t = deg * D2R;
    for (let z = -HL + 6; z <= HL - 6; z += 15) np.push(Math.sin(t) * 49.5, Math.cos(t) * 49.5, z);
  }
  for (const zc of [-HL + 2, HL - 2]) {
    for (let deg = 0; deg < 360; deg += 6) {
      const t = deg * D2R;
      np.push(Math.sin(t) * 49.2, Math.cos(t) * 49.2, zc);
    }
  }
  const ng = new THREE.BufferGeometry();
  ng.setAttribute('position', new THREE.Float32BufferAttribute(np, 3));
  worldMats.nav = new THREE.PointsMaterial({
    size: 1.1, map: makeSoftSprite(0.5), color: 0xffcf8a, transparent: true,
    opacity: CONFIG.DAY.navInt, depthWrite: false, blending: THREE.AdditiveBlending
  });
  add(new THREE.Points(ng, worldMats.nav));

  return { panel, drawn: parts.length };
}

/** Самотест ориентации UV: сверяем реальные UV геометрии с мировым θ */
export function uvSelfTest(geo, flip) {
  const p = geo.attributes.position, u = geo.attributes.uv;
  let worst = 0;
  for (let k = 0; k < p.count; k += 7) {
    let th = Math.atan2(p.getX(k), p.getY(k));
    if (th < 0) th += TAU;
    let uu = flip ? (-u.getX(k) + 0.5) : u.getX(k);
    uu -= Math.floor(uu);
    let d = Math.abs(uu - th / TAU);
    worst = Math.max(worst, Math.min(d, 1 - d));
  }
  return worst < 0.02;
}
