import * as THREE from 'three';
import { CONFIG } from './config.js';
import {
  mulberry32, D2R, TAU, clamp, pick, zoneAt, surfaceQuat, surfacePos, mergeGeos,
  rod, facadeUV, splitRoofGroups, natural, cityBlock, cityCenter, cellInfo,
  cellUsable, pickFloors, deepDispose
} from './util.js';
import {
  makeHullMaps, makeDetailTexture, makeFacade, makePanelTexture, makeSoftSprite,
  makeBlobTexture, makeFootprintTexture, heightToNormal, makeCarWindows,
  makeWaterRoughness, makeWaterNormal, makeRoofTexture, makeLeafTexture
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
  uFlow: { value: 0 },
  uMirror: { value: 0 },
  uSunR: { value: CONFIG.SUN.r }, uHullR: { value: CONFIG.R },
  uHullL: { value: CONFIG.L }, uSunGlow: { value: 3.2 },
  uCamObj: { value: new THREE.Vector3() },
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
        varying float vZo;
        varying vec3 vTanU;
        varying vec3 vTanV;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vTh = atan( position.x, position.y );
        vZo = position.z;
        // касательные корпуса в видовом пространстве: вдоль дуги и вдоль оси.
        // Возмущать нормаль без них нельзя — во фрагментном шейдере normal
        // задан в видовых координатах, и рябь поехала бы вместе с камерой.
        vTanU = normalize( normalMatrix * vec3( cos( vTh ), -sin( vTh ), 0.0 ) );
        vTanV = normalize( normalMatrix * vec3( 0.0, 0.0, 1.0 ) );`);

    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vTh;
        varying float vZo;
        varying vec3 vTanU;
        varying vec3 vTanV;
        uniform sampler2D uMask;
        uniform sampler2D uDetail;
        uniform float uTime, uDetailRep, uArmW, uSparZW, uSparShade, uCityGlow, uFlow;
        uniform float uMirror, uSunR, uHullR, uHullL, uSunGlow;
        uniform vec3 uCamObj;   // камера в системе станции
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
        // hullMask.r — глубина: 0 у берега, 1 на стрежне. Толща воды поглощает
        // свет по глубине, поэтому на отмели дно просвечивает почти целиком,
        // а на стрежне остаётся один цвет воды. Показатель нелинейный —
        // так работает поглощение.
        float wDeep = hullMask.r;
        float absorb = 1.0 - exp( -wDeep * 3.2 );
        diffuseColor.rgb = mix( diffuseColor.rgb, uWaterTint, absorb );

        // Пена у кромки: узкая полоса на самой отмели, с бегущим по течению
        // рисунком. Без неё вода стыкуется с берегом линией, как аппликация.
        if ( wDeep > 0.001 ) {
          float edge = smoothstep( 0.34, 0.02, wDeep );
          vec2 fp = vec2( vMapUv.x * 314.0, vMapUv.y * 300.0 - uTime * uFlow );
          float f = sin( fp.x * 14.0 + sin( fp.y * 3.1 ) * 2.0 ) * 0.5 + 0.5;
          diffuseColor.rgb += vec3( 0.55, 0.62, 0.66 ) * edge * ( 0.35 + 0.65 * f ) * 0.5;
        }

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
        // Фонарь освещает покрытие, а не подменяет его цвет: множим на
        // альбедо, иначе улица превращается в ровное светящееся пятно и
        // разметка на ней пропадает.
        float lamps = smoothstep( 0.34, 0.92, hullMask.b );
        totalEmissiveRadiance += uCityGlow * lamps * diffuseColor.rgb
          * ( 0.5 + 0.8 * dPave ) * vec3( 1.0, 0.86, 0.66 );`)

      /* --- вода зеркальна --- */
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        float wFar = smoothstep( 25.0, 90.0, length( vViewPosition ) );
        roughnessFactor = mix( roughnessFactor, mix( 0.045, 0.20, wFar ), hullMask.r );`)

      /* --- рябь на воде: возмущаем нормаль, блик солнца сам поедет --- */
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        if ( hullMask.r > 0.02 ) {
          // Координаты в юнитах мира: по дуге и вдоль оси. Так длины волн
          // задаются в метрах, а не в долях текстуры.
          vec2 P = vec2( vMapUv.x * 314.0, vMapUv.y * 300.0 );
          P.y -= uTime * uFlow;                      // рябь сносит вниз по течению
          float t = uTime;

          // Мелкая рябь гаснет с расстоянием: на дальних пикселях её период
          // короче пикселя, и без затухания она превращается в муар — тот
          // самый крестообразный узор.
          float near = 1.0 - wFar;

          // Волны идут преимущественно поперёк русла (большая компонента по
          // дуге, малая вдоль оси). Поэтому отражение вытягивается в полосу
          // вдоль оси — как и положено бликам от линейного источника.
          vec2 rip = vec2( 0.0 );
          rip += vec2( 1.00, 0.14 ) * cos( dot( P, vec2(  7.9,  1.1 ) ) + t * 2.1 );
          rip += vec2( 0.74, -0.11 ) * cos( dot( P, vec2( 12.7, -1.9 ) ) - t * 2.8 );
          rip += vec2( 0.46, 0.08 ) * cos( dot( P, vec2( 23.3,  3.1 ) ) + t * 4.2 ) * near;
          rip += vec2( 0.28, -0.06 ) * cos( dot( P, vec2( 41.1, -4.7 ) ) - t * 5.9 ) * near;

          // Продольные струи: медленная низкочастотная составляющая, которая
          // и читается как течение.
          rip += vec2( 0.22, 0.55 ) * cos( dot( P, vec2( 1.7, 0.9 ) ) + t * 0.8 );

          float amp = 0.055 * hullMask.r * ( 0.45 + 0.55 * near );
          /* Рябь ставится поверх ГЕОМЕТРИЧЕСКОЙ нормали, а не поверх карты:
             иначе рельеф травы и швов плит просвечивал бы сквозь воду. */
          vec3 wn = normalize( nonPerturbedNormal + ( vTanU * rip.x + vTanV * rip.y ) * amp );
          normal = normalize( mix( normal, wn, hullMask.r ) );

          /* ─── Отражение в воде без единого буфера ───
             Фрагменту всё известно: своя точка на корпусе, своя нормаль с
             рябью, и оба отражателя — труба-солнце и борт станции — цилиндры
             вдоль оси. Пересечение решается формулой прямо здесь. Экранный
             марш потребовал бы буфера глубины, буфера нормалей и отдельного
             прохода, а на краях кадра всё равно оставлял бы чёрные пятна. */
          /* Отражает только вода: раньше условие пропускало весь корпус,
             и трава с асфальтом получали зеркальную составляющую. */
          if ( uMirror > 0.001 && hullMask.r > 0.02 ) {
            float sT = sin( vTh ), cT = cos( vTh );
            vec3 Pw = vec3( sT * uHullR, cT * uHullR, vZo );
            vec3 up = vec3( -sT, -cT, 0.0 );
            vec3 tu = vec3( cT, -sT, 0.0 );
            vec3 tv = vec3( 0.0, 0.0, 1.0 );
            vec3 Nw = normalize( up + ( tu * rip.x + tv * rip.y ) * amp );
            vec3 Vw = normalize( Pw - uCamObj );
            vec3 Rw = reflect( Vw, Nw );

            vec3 got = vec3( 0.0 );
            float found = 0.0;
            float qa = dot( Rw.xy, Rw.xy );
            if ( qa > 1e-6 ) {
              float qb = 2.0 * dot( Pw.xy, Rw.xy );
              /* труба: ближний корень */
              float ds = qb * qb - 4.0 * qa * ( dot( Pw.xy, Pw.xy ) - uSunR * uSunR );
              if ( ds > 0.0 ) {
                float ts = ( -qb - sqrt( ds ) ) / ( 2.0 * qa );
                if ( ts > 0.05 && abs( Pw.z + Rw.z * ts ) < uHullL * 0.5 ) {
                  got = vec3( 1.0, 0.94, 0.78 ) * uSunGlow;
                  found = 1.0;
                }
              }
              /* борт: дальний корень, мы внутри цилиндра */
              if ( found < 0.5 ) {
                float dh = qb * qb - 4.0 * qa * ( dot( Pw.xy, Pw.xy ) - uHullR * uHullR );
                if ( dh > 0.0 ) {
                  float th2 = ( -qb + sqrt( dh ) ) / ( 2.0 * qa );
                  vec3 hw = Pw + Rw * th2;
                  if ( th2 > 0.05 && abs( hw.z ) < uHullL * 0.5 ) {
                    vec2 huv = vec2( fract( 0.5 - atan( hw.x, hw.y ) / 6.28318531 ),
                                     hw.z / uHullL + 0.5 );
                    got = texture2D( map, huv ).rgb;
                    found = 1.0;
                  }
                }
              }
            }
            /* Френель: под острым углом отражает почти всё */
            float fr = pow( 1.0 - max( 0.0, dot( -Vw, Nw ) ), 4.0 );
            totalEmissiveRadiance += got * found * hullMask.r * uMirror
              * ( 0.04 + 0.96 * fr );
          }
        }`);
  };
  mat.customProgramCacheKey = () => 'b5-hull';
}

/** Шероховатость пишем в альфа-канал кадра. Непрозрачные материалы альфу не
    используют — смешивание им выключено, — а трассировке она нужна: без неё
    негде взять, что зеркально (вода, металл), а что нет. Одна строка на
    материал вместо отдельного G-буфера с ещё одним проходом сцены. */
export function patchRoughnessAlpha(mat) {
  if (mat.userData.__ra) return mat;
  mat.userData.__ra = true;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (s, r) => {
    prev?.call(mat, s, r);
    s.fragmentShader = s.fragmentShader.replace('#include <dithering_fragment>',
      '#include <dithering_fragment>\n gl_FragColor.a = roughnessFactor;');
  };
  const key = mat.customProgramCacheKey;
  mat.customProgramCacheKey = () => (key ? key.call(mat) : '') + '-ra';
  return mat;
}

/** Пройтись по всему поддереву и записать шероховатость в альфу каждому
    непрозрачному материалу. Выборочный патч оставлял альфу непрозрачности —
    единицу, — и трассировка принимала такие поверхности за зеркальные:
    отражало колонны, фермы и дома, а должно было только воду. */
export function patchAllRoughness(root) {
  const seen = new Set();
  root.traverse(o => {
    const list = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of list) {
      if (!m || seen.has(m.uuid) || m.transparent || !m.isMeshStandardMaterial) continue;
      seen.add(m.uuid);
      patchRoughnessAlpha(m);
    }
  });
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
          // Своя фаза у каждой вершины: крона шелестит, а не качается целиком.
          // Смещаем ВДОЛЬ РАДИУСА, а не вдоль нормали: геометрия
          // неиндексированная, у шести копий одной вершины шесть разных
          // нормалей граней, и сдвиг по ним растаскивал копии — крона
          // расходилась щелями. Радиус у всех копий общий.
          float leafPh = ph + transformed.y * 5.3 + transformed.x * 3.1 + transformed.z * 2.7;
          transformed += normalize( transformed ) * sin( uTime * 3.6 + leafPh ) * 0.055 * uWind;
        #endif`);
  };
  mat.customProgramCacheKey = () => 'b5-wind';
}

/** Крона: правильный икосаэдр читается как гранёный камень. Смещаем вершины
    по их направлению — форма перестаёт быть правильным телом, — и раскрашиваем
    каждую грань своей светлотой. Получается рябь листвы, а не многогранник.
    Вершины дедуплицируются по координатам, иначе поверхность разойдётся. */
function foliageGeo(detail, rnd, wobble, dither) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.attributes.position;
  const seen = new Map();
  for (let k = 0; k < p.count; k++) {
    const x = p.getX(k), y = p.getY(k), z = p.getZ(k);
    const key = x.toFixed(4) + ',' + y.toFixed(4) + ',' + z.toFixed(4);
    let s = seen.get(key);
    if (s === undefined) { s = 1 + (rnd() - 0.5) * 2 * wobble; seen.set(key, s); }
    p.setXYZ(k, x * s, y * s, z * s);
  }
  g.computeVertexNormals();

  /* геометрия неиндексированная — красим по граням, не по вершинам */
  const col = new Float32Array(p.count * 3);
  for (let f = 0; f < p.count; f += 3) {
    const v = 1 - dither / 2 + rnd() * dither;
    for (let k = 0; k < 3; k++) col.fill(v, (f + k) * 3, (f + k) * 3 + 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** Горизонтальные грани переводим в кровельную полосу текстуры фасада:
    иначе крыша здания оказывается оклеена окнами — и сверху это читается
    как непонятная решётчатая плита. Работает и для боксов, и для торцов
    цилиндров: критерий — нормаль вдоль ±Y. */
/** Развёртка кровли. Раньше она уводилась в узкую полосу фасадной текстуры:
    по одной оси растягивалась на всю ширину дома, по другой ужималась в
    двенадцать процентов высоты — отсюда и растянутый нелепый вид. Теперь у
    крыши свой материал, и развёртка обычная: по горизонтальным координатам,
    с постоянной плотностью, одинаковой у домов любого размера. */
function roofUV(geo, tile = CONFIG.ROOF_TILE) {
  const p = geo.attributes.position, n = geo.attributes.normal, uv = geo.attributes.uv;
  for (let k = 0; k < p.count; k++) {
    if (Math.abs(n.getY(k)) < 0.7) continue;
    uv.setXY(k, (p.getX(k) + 0.5) * tile, (p.getZ(k) + 0.5) * tile);
  }
  uv.needsUpdate = true;
  return geo;
}

/* ═══════════════════════════════════════════════════════════════════════════
   СИЛУЭТЫ ЗДАНИЙ — 4 типа, каждый склеен из примитивов в единичный куб.
   Разнообразие формы бесплатно: тип по-прежнему один InstancedMesh.
   ═══════════════════════════════════════════════════════════════════════════ */
function buildingGeo(type) {
  const S = CONFIG.BLD[type], T = CONFIG.FACADE_TILE;
  /* типовая ширина инстанса — по ней считаем горизонтальную плотность */
  const W = (S.w[0] + S.w[1]) / 2;
  const parts = [];
  const box = (w, h, d, x, y, z) => facadeUV(rod(w, h, d, x, y, z), w * W / T);
  /* цилиндр разворачивается по длине окружности, а не «оборот на тайл» */
  const cyl = (r, h, y, seg = 14) => {
    const g = new THREE.CylinderGeometry(r, r, h, seg, 1, false);
    g.translate(0, y + h / 2, 0);
    return facadeUV(g, 2 * Math.PI * r * W / T);
  };
  if (type === 0) {           // ступенчатая башня
    parts.push(box(1, 0.5, 1, 0, 0.25, 0));
    parts.push(box(0.74, 0.34, 0.74, 0, 0.67, 0));
    parts.push(box(0.46, 0.2, 0.46, 0, 0.94, 0));
    parts.push(box(0.1, 0.14, 0.1, 0.12, 1.07, 0.12));
  } else if (type === 1) {    // низкая плита с надстройкой
    parts.push(box(1, 0.5, 1, 0, 0.25, 0));
    parts.push(box(1.12, 0.06, 1.12, 0, 0.53, 0));      // карниз
    parts.push(cyl(0.3, 0.44, 0.56, 12));
    parts.push(box(0.06, 0.24, 0.06, 0.2, 1.12, -0.2));  // мачта
  } else if (type === 2) {    // круглая башня-барабан
    parts.push(cyl(0.5, 0.84, 0));
    parts.push(cyl(0.58, 0.06, 0.84));
    parts.push(cyl(0.26, 0.1, 0.9, 10));
  } else {                    // приземистая розетка с террасой
    parts.push(cyl(0.5, 0.56, 0, 18));
    parts.push(cyl(0.62, 0.07, 0.56, 18));
    parts.push(cyl(0.24, 0.37, 0.63, 12));
  }
  /* Стены и крыша расходятся по материалам: слияние брусьев теряет исходные
     группы, поэтому расставляем их заново по направлению нормали. */
  const g = splitRoofGroups(mergeGeos(parts));
  g.translate(0, -0.5, 0);    // база в y = -0.5, чтобы масштаб (w,h,d) работал
  return roofUV(g);
}

/** Сфера сектора по его деревьям: отсечение по кадру должно работать
    независимо от того, сколько деревьев сейчас на этом уровне детализации. */
function sectorSphere(list, R) {
  const c = new THREE.Vector3();
  const v = new THREE.Vector3();
  for (const [t, z] of list) { surfacePos(t, R, z, v); c.add(v); }
  c.multiplyScalar(1 / Math.max(1, list.length));
  let rad = 0;
  for (const [t, z] of list) {
    surfacePos(t, R, z, v);
    rad = Math.max(rad, c.distanceTo(v));
  }
  return new THREE.Sphere(c, rad + 4);
}

/** Крест из двух плоскостей: дальний уровень кроны.

    Билборд, разворачивающийся к камере, здесь дороже, чем экономит: мир
    вращается, и тысячи плоскостей пришлось бы переориентировать каждый кадр.
    С расстояния, где работает этот уровень, разницы между крестом и
    билбордом не видно. */
function crossQuadGeo() {
  const parts = [];
  const N = CONFIG.TREE_LOD.blades;
  /* Три плоскости под 60°, а не две под 90°: у двух с некоторых углов видно
     ровно ребро, и дерево истончается в нитку. С тремя силуэт остаётся
     плотным с любой стороны, а стоит это один лишний треугольник на пару. */
  for (let k = 0; k < N; k++) {
    const g = new THREE.PlaneGeometry(2, 2);
    /* центр кроны на уровне середины плоскости, ствол уходит вниз */
    g.translate(0, CONFIG.TREE_LOD.lift, 0);
    g.rotateY((k / N) * Math.PI);
    parts.push(g);          // индексированная: mergeGeos другой не принимает
  }
  const merged = mergeGeos(parts);
  /* белый вершинный цвет: оттенок придёт из instanceColor, как у крон */
  const n = merged.attributes.position.count;
  merged.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  return merged;
}

let treeLod = null;

/** Разложить деревья по уровням детализации.

    Считается не каждый кадр: пять тысяч расстояний — не та работа, ради
    которой стоит будить процессор шестьдесят раз в секунду. Пересчёт идёт,
    только когда камера заметно сдвинулась.

    Раскладка меняет ТОЛЬКО счётчики мешей: матрицы у всех трёх уровней уже
    записаны и совпадают, поэтому переписывать нечего. */
export function updateTreeLod(camWorld, worldGroup, force) {
  if (!treeLod || !treeLod.length) return false;
  if (!force && camWorld.distanceToSquared(_lodPrev) < CONFIG.TREE_LOD.step ** 2) return false;
  _lodPrev.copy(camWorld);

  /* камеру переводим в систему мира: точки деревьев записаны в ней */
  worldGroup.worldToLocal(_lodLocal.copy(camWorld));
  const near2 = CONFIG.TREE_LOD.near ** 2, mid2 = CONFIG.TREE_LOD.mid ** 2;
  const cx = _lodLocal.x, cy = _lodLocal.y, cz = _lodLocal.z;

  for (const grp of treeLod) {
    const { trio, mats16, cols, pts, n } = grp;
    let a = 0, b = 0, c = 0;                    // счётчики трёх уровней
    const mA = trio[0].instanceMatrix.array, mB = trio[1].instanceMatrix.array,
      mC = trio[2].instanceMatrix.array;
    const cA = trio[0].instanceColor.array, cB = trio[1].instanceColor.array,
      cC = trio[2].instanceColor.array;

    for (let k = 0; k < n; k++) {
      const dx = pts[k * 3] - cx, dy = pts[k * 3 + 1] - cy, dz = pts[k * 3 + 2] - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      const src = k * 16, srcC = k * 3;
      let dst, dstC, arr, arrC;
      if (d2 < near2) { dst = a * 16; dstC = a * 3; arr = mA; arrC = cA; a++; }
      else if (d2 < mid2) { dst = b * 16; dstC = b * 3; arr = mB; arrC = cB; b++; }
      else { dst = c * 16; dstC = c * 3; arr = mC; arrC = cC; c++; }
      for (let j = 0; j < 16; j++) arr[dst + j] = mats16[src + j];
      arrC[dstC] = cols[srcC];
      arrC[dstC + 1] = cols[srcC + 1];
      arrC[dstC + 2] = cols[srcC + 2];
    }

    const counts = [a, b, c];
    for (let li = 0; li < 3; li++) {
      trio[li].count = counts[li];
      trio[li].instanceMatrix.needsUpdate = true;
      trio[li].instanceColor.needsUpdate = true;
      trio[li].visible = counts[li] > 0;
    }
  }
  return true;
}

/** Продавить корпус холмами.

    Список холмов тот же, что раньше расставлял отдельные меши: место, радиус
    и высота. Вершина смещается внутрь цилиндра на величину, спадающую от
    центра холма к краю по гладкой кривой — стыка не остаётся вовсе.

    Заодно возвращается сам список: по нему потом строятся пруды в низинах и
    красится трава, чтобы холм читался не только формой. */
export function displaceHills(geo, R, L, rnd) {
  const H = CONFIG.HILL;
  const hills = [];
  const want = CONFIG.COUNT.hills.reduce((a, b) => a + b, 0);

  /* Холм не должен попадать на город или русло: под домами поверхность
     обязана остаться ровной, иначе они встанут на склон, а река потечёт в
     гору. Проверяем ВЕСЬ угловой размах с мелким шагом — русло узкое и
     проскакивало между тремя контрольными точками. */
  const A = CONFIG.AXIS;
  /* Пятки силовых опор: двенадцать точек, где колонна упирается в корпус.
     Продавленный под ними холм оторвал бы стилобат от поверхности, а залитая
     низина поставила бы опору в воду. */
  const feet = [];
  for (const sz of A.spars) {
    for (let k = 0; k < A.sparArms; k++) {
      feet.push({ t: (k / A.sparArms) * TAU + A.sparAngle * Math.PI / 180, z: sz });
    }
  }
  const footClear = A.baseR + H.footGap;

  const clearOf = (t, z, rad) => {
    const half = rad / R;
    for (let d = -half; d <= half + 1e-6; d += half / 8) {
      const deg = (((t + d) / TAU * 360) % 360 + 360) % 360;
      const zone = zoneAt(deg);
      if (zone === 'river' || zone === 'city') return false;
    }
    /* и не задеть ни одну пятку: расстояние считаем по поверхности */
    for (const f of feet) {
      const dt = ((t - f.t + Math.PI) % TAU + TAU) % TAU - Math.PI;
      if (Math.hypot(dt * R, z - f.z) < rad + footClear) return false;
    }
    return true;
  };

  for (let i = 0, guard = 0; i < want && guard < want * 60; guard++) {
    const rad = H.r[0] + rnd() * (H.r[1] - H.r[0]);
    const t = rnd() * TAU;
    /* с запасом от торцов: продавленный край не должен упереться в диск */
    const z = (rnd() - 0.5) * (L - rad * 4 - H.endGap * 2);
    if (!clearOf(t, z, rad)) continue;
    hills.push({
      t, z, r: rad,
      h: rad * (H.rise[0] + rnd() * (H.rise[1] - H.rise[0])),
      dip: rnd() < H.pondChance
    });
    i++;
  }

  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let k = 0; k < pos.count; k++) {
    v.fromBufferAttribute(pos, k);
    /* Цилиндр three лежит вдоль Y, а мир получит его после rotateX(90°).
       Угол при этом становится 180° − исходный, и длина переезжает с Y на Z.
       Считаем сразу в КОНЕЧНОЙ системе: иначе холмы садятся в зеркально
       отражённые зоны — под город и на русло. */
    const t = Math.atan2(v.x, -v.z);
    const z = v.y;
    let lift = 0;
    for (const hl of hills) {
      /* угловое расстояние по кратчайшей дуге, в юнитах поверхности */
      let dt = ((t - hl.t + Math.PI) % TAU + TAU) % TAU - Math.PI;
      const dx = dt * R, dz = z - hl.z;
      const d = Math.hypot(dx, dz);
      if (d >= hl.r) continue;
      /* гладкий колокол: у края производная равна нулю, стыка не видно */
      const u = d / hl.r;
      const f = (1 - u * u) * (1 - u * u);
      lift += hl.dip ? -hl.h * H.dipDepth * f : hl.h * f;
    }
    if (lift !== 0) {
      const rr = Math.hypot(v.x, v.z);
      const k2 = (rr - lift) / rr;      // внутрь цилиндра = ближе к оси
      pos.setXYZ(k, v.x * k2, v.y, v.z * k2);
    }
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return hills;
}

/* ═══════════════════════════════════════════════════════════════════════════
   СБОРКА МИРА
   ═══════════════════════════════════════════════════════════════════════════ */
export const worldMats = { bld: [], nav: null, blob: null, print: null,
  hull: null, waterRough: null, waterNormal: null,
  trafficBody: null, trafficLamp: null, trafficMesh: null };
const _lodPrev = new THREE.Vector3(1e9, 1e9, 1e9), _lodLocal = new THREE.Vector3();
let sceneParts = [];
let traffic = null;

export function disposeWorld(group) {
  for (const o of sceneParts) { group.remove(o); deepDispose(o); }
  sceneParts = [];
  worldMats.bld = []; worldMats.nav = null; worldMats.blob = null;
  worldMats.print = null; worldMats.trafficBody = null;
  worldMats.trafficLamp = null; worldMats.trafficMesh = null; traffic = null;
}

export function buildWorld(group, renderer, quality) {
  disposeWorld(group);
  const Q = CONFIG.QUALITY[quality] || CONFIG.QUALITY.HIGH;
  const LOW = quality === 'LOW';
  const i = Q.count;
  const rnd = mulberry32(CONFIG.SEED);
  const R = CONFIG.R, L = CONFIG.L, HL = L / 2;
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const add = o => { group.add(o); sceneParts.push(o); return o; };

  /* ─────────── КОРПУС ─────────── */
  /* Корпус тесселирован по длине, чтобы холмы стали ЕГО частью, а не
     отдельными мешами поверх. Прежде холм был диском, положенным на землю:
     своя кромка, свой цвет, резкий стык — «навалили кучу». Продавленный
     корпус даёт непрерывную поверхность, а трава на нём та же самая. */
  /* Тесселяция корпуса — из пресета: холмы продавливают сам корпус, и на
     слабом устройстве колец нужно меньше. */
  const hullGeo = new THREE.CylinderGeometry(R, R, L,
    Q.rings ? CONFIG.HULL_SEG : 128, Q.rings || CONFIG.HULL_RINGS, true);
  const hullHills = displaceHills(hullGeo, R, L, mulberry32(CONFIG.SEED + 404));
  hullGeo.rotateX(Math.PI / 2);
  /* низины корпуса заливаются водой — тем же каналом маски, что и реки */
  const ponds = hullHills.filter(h => h.dip).map(h => ({ t: h.t, z: h.z, r: h.r * 0.62 }));
  const { albedo, mask, canvas: hullCanvas } = makeHullMaps(Q.hullTex, Q.mask,
    mulberry32(CONFIG.SEED + 7), ponds);

  /* BackSide зеркалит U. Самотест сверяет реальные UV геометрии с мировым θ. */
  const flip = uvSelfTest(hullGeo, true);
  if (!flip && !uvSelfTest(hullGeo, false)) console.warn('UV корпуса: самотест не сошёлся');
  for (const t of [albedo, mask]) {
    if (flip) { t.repeat.x = -1; t.offset.x = 0.5; }
    t.anisotropy = Math.min(Q.aniso, maxAniso);
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
  hullU.uFlow.value = CONFIG.RIVER_FLOW;

  /* Рельеф корпуса берётся из его же альбедо: бордюры тротуаров, швы плит,
     борозды полей уже нарисованы. Карта строится в меньшем разрешении —
     нормалям столько детализации не нужно. */
  const hullNormal = Q.normals ? heightToNormal(hullCanvas, CONFIG.NORMALS.hull, Q.normals) : null;
  if (hullNormal && flip) { hullNormal.repeat.x = -1; hullNormal.offset.x = 0.5; }
  const hullMat = new THREE.MeshStandardMaterial({
    map: albedo, side: THREE.BackSide, roughness: 0.95, metalness: 0.02,
    normalMap: hullNormal,
    normalScale: new THREE.Vector2(1, 1)
  });
  patchHullMaterial(hullMat, arms.length, CONFIG.AXIS.spars.length);
  patchRoughnessAlpha(hullMat);
  worldMats.hull = hullMat;
  /* карта шероховатости воды — только для трассировки пути, в обычном
     кадре рябь и зеркало считает патч шейдера */
  worldMats.waterRough = makeWaterRoughness(mask, Math.min(1024, Q.mask));
  /* карта ряби: волны считает патч шейдера, а трассировщик его не видит */
  worldMats.waterNormal = makeWaterNormal(mask, Math.min(1024, Q.mask), CONFIG.NORMALS.water);
  /* Каждая карта в three несёт СВОЮ матрицу развёртки. Альбедо корпуса
     зеркалится (смотрим изнутри цилиндра), и карты, созданные без этого
     зеркала, ложатся в противофазе: вода в них оказывается там, где на самом
     деле трава. Отсюда и «зеркало не работает». */
  for (const tx of [worldMats.waterRough, worldMats.waterNormal]) {
    if (tx && flip) { tx.repeat.x = -1; tx.offset.x = 0.5; }
  }
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

  /* Неподвижная геометрия тоже занимает землю. Пятки силовых ферм приходят
     к корпусу, спицы торцов проходят в трёх метрах над ним — раньше про них
     никто не знал, и деревья с домами прорастали сквозь конструкции. */
  const A = CONFIG.AXIS;
  for (const z of A.spars) {
    for (let k = 0; k < A.sparArms; k++) {
      taken.push([(A.sparAngle + k * 360 / A.sparArms) * D2R, z, A.baseR + 1.5]);
    }
  }
  for (const sign of [-1, 1]) {
    for (let k = 0; k < 6; k++) taken.push([(k / 6) * TAU + 0.26, sign * (HL - 8), 3.0]);
  }
  const fits = (t, z, r) => {
    for (let k = 0; k < taken.length; k++) {
      const o = taken[k];
      if (Math.hypot(angGap(t, o[0]) * R, z - o[1]) < r + o[2]) return false;
    }
    return true;
  };

  /** rad — либо число, либо функция, возвращающая радиус конкретной попытки
      (холму нужен его собственный, иначе он резервирует не свой размер) */
  /** Пересекается ли угловой размах объекта с сектором запрещённого типа.
      Выборка точек тут не работает: холм радиусом 14 занимает 16°, а русло
      шириной 6° спокойно проскакивает между контрольными точками. Сравниваем
      интервалы целиком, с учётом склейки круга. */
  const spanHits = (t, r, kinds) => {
    const half = (r / R) / D2R;
    const c = ((t / D2R) % 360 + 360) % 360;
    for (const kind of kinds) {
      for (const [a, b] of CONFIG.SECT[kind]) {
        for (const off of [-360, 0, 360]) {
          if (c + half >= a + off && c - half <= b + off) return true;
        }
      }
    }
    return false;
  };

  /* Улица — полоса шириной CITY.street по краю каждой ячейки сетки. Дерево
     считается стоящим на ней, если его крона задевает полосу. */
  const CT = CONFIG.CITY;
  const cellT = TAU / CT.cols, cellZ = L / CT.rows;
  const onStreet = (t, z, r) => {
    /* Полуширина берётся ПОЛНОЙ шириной улицы, а не половиной: полоса идёт
       по обе стороны от границы ячейки, и от границы до края проезжей части
       ровно street, а не street/2. Плюс радиус кроны — задевать тоже нельзя. */
    const halfT = CT.street / R + r / R;
    const halfZ = CT.street + r;
    const fu = (((t % cellT) + cellT) % cellT) / cellT;
    const fv = ((((z + HL) % cellZ) + cellZ) % cellZ) / cellZ;
    const du = Math.min(fu, 1 - fu) * cellT;
    const dv = Math.min(fv, 1 - fv) * cellZ;
    return du < halfT || dv < halfZ;
  };

  const sample = (w, n, rad = 0, claim = false, bad = null) => {
    const out = [];
    for (let guard = 0; out.length < n && guard < n * 80; guard++) {
      const r = typeof rad === 'function' ? rad() : rad;
      const margin = r + 3;
      const t = rnd() * TAU, z = -HL + margin + rnd() * (L - margin * 2);
      const p = w[zoneAt(t / D2R)];
      if (p <= 0 || rnd() > p) continue;
      if (!free(t, z) || !fits(t, z, r)) continue;
      if (bad && spanHits(t, r, bad)) continue;
      /* В городе не встаём на проезжую часть: улица — полоса по краю
         квартала, и дерево посреди неё выглядит ошибкой, а не задумкой.
         Раньше туда попадало пять сотен крон из шести. */
      if (zoneAt(t / D2R) === 'city' && onStreet(t, z, r)) continue;
      out.push([t, z, r]);
      if (claim) taken.push([t, z, r]);
    }
    return out;
  };
  /* Дома встают по кварталам той же сетки, что рисует текстура, и тип
     квартала берётся из общей cellInfo. Случайная выборка была
     принципиально несовместима с регулярным планом на корпусе. */
  const BLK = cityBlock(), C = CONFIG.CITY;
  const blockRad = Math.min(BLK.wT, BLK.wZ) / 2;
  const plots = [[], [], [], []];
  for (let i = 0; i < C.cols; i++) {
    const t = cityCenter(i, 0).t;
    for (let j = 0; j < C.rows; j++) {
      if (!cellUsable(i, j)) continue;                      // весь размах внутри сектора
      const z = cityCenter(i, j).z;
      const info = cellInfo(i, j);
      if (info.kind !== 'built') continue;
      if (!free(t, z) || !fits(t, z, blockRad)) continue;   // Башня, фермы, спицы
      plots[info.type].push([t, z, info]);
      taken.push([t, z, blockRad]);
    }
  }

  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v3 = new THREE.Vector3();
  const sc = new THREE.Vector3(), qs = new THREE.Quaternion(), UP = new THREE.Vector3(0, 1, 0);
  const shadows = [];   // круглые пятна: [θ, z, радиус, подъём]
  const prints = [];    // следы домов: [θ, z, ширина, глубина, поворот]

  /* Инстансы режутся на сектора по дуге. Один меш на весь цилиндр отсечь
     нельзя — он всегда в кадре, поэтому GPU считал вершины всей станции,
     включая половину за спиной камеры. Сектор со своей сферой отсекается
     обычным frustum culling: при обзоре 62° в кадр попадает около шестой
     части окружности. Вызовов больше, но вершинной работы кратно меньше. */
  const CH = Q.chunks || CONFIG.CHUNKS;
  const instance = (geo, mat, list, fn) => {
    const buckets = Array.from({ length: CH }, () => []);
    for (const item of list) {
      const t = ((item[0] % TAU) + TAU) % TAU;
      buckets[Math.min(CH - 1, (t / TAU * CH) | 0)].push(item);
    }
    const made = [];
    for (const b of buckets) {
      if (!b.length) continue;
      const im = new THREE.InstancedMesh(geo, mat, b.length);
      for (let k = 0; k < b.length; k++) fn(k, b[k][0], b[k][1], im, b[k][2]);
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.computeBoundingSphere();          // сфера по реальным матрицам инстансов
      made.push(add(im));
    }
    return made;
  };

  /* ─────────── ЗДАНИЯ: 4 силуэта × свой фасад ─────────── */
  const tints = [0x9fb0c4, 0xb6c2cf, 0x8c9db2, 0xc3ccd6, 0x7f90a5, 0xc9b7a4];
  /* Кровля одна на все типы: она не различает этажность, а фасадная текстура
     с окнами на горизонтальной плоскости выглядела вывернутым домом. */
  const roofMap = makeRoofTexture(mulberry32(CONFIG.SEED + 77));
  roofMap.wrapS = roofMap.wrapT = THREE.RepeatWrapping;
  roofMap.anisotropy = Math.min(4, maxAniso);
  const roofNrm = Q.normals
    ? heightToNormal(roofMap.image, CONFIG.NORMALS.roof, 256) : null;
  if (roofNrm) roofNrm.wrapS = roofNrm.wrapT = THREE.RepeatWrapping;
  for (let v = 0; v < 4; v++) {
    const { map, emis, canvas: facCanvas } = makeFacade(mulberry32(CONFIG.SEED + 31 * (v + 1)), v);
    /* Оконные ниши и пилястры дают глубину проёмов — на закате в них ложится тень */
    const nrm = Q.normals ? heightToNormal(facCanvas, CONFIG.NORMALS.facade) : null;
    for (const tx of [map, emis, nrm]) {
      if (tx) tx.wrapS = tx.wrapT = THREE.RepeatWrapping;
    }
    map.anisotropy = Math.min(4, maxAniso);
    const wallMat = new THREE.MeshStandardMaterial({
      map, emissiveMap: emis, emissive: 0xffffff, emissiveIntensity: 0,
      normalMap: nrm, normalScale: new THREE.Vector2(1, 1),
      roughness: 0.68, metalness: 0.1
    });
    /* Крыше — свой материал. Фасадная текстура с окнами на горизонтальной
       плоскости выглядит вывернутым домом; кровля шершавее стен и почти не
       металлическая: это рубероид, а не панель. */
    const roofMat = new THREE.MeshStandardMaterial({
      map: roofMap, normalMap: roofNrm, normalScale: new THREE.Vector2(0.8, 0.8),
      roughness: 0.92, metalness: 0.04
    });
    const mat = [wallMat, roofMat];
    patchRoughnessAlpha(wallMat);
    patchRoughnessAlpha(roofMat);
    worldMats.bld.push(wallMat);
    instance(buildingGeo(v), mat, plots[v], (k, t, z, im, info) => {
      const s = CONFIG.BLD[v];
      /* среднее двух равномерных даёт треугольное распределение: края
         диапазона этажности выпадают редко, чаще середина */
      const h = pickFloors(info.floors, s.floors) * CONFIG.FLOOR_H;
      const w = s.w[0] + info.w * (s.w[1] - s.w[0]);
      const d = s.w[0] + info.d * (s.w[1] - s.w[0]);
      surfaceQuat(t, q).multiply(qs.setFromAxisAngle(UP, info.spin * Math.PI / 2));
      m4.compose(surfacePos(t, R - h / 2, z, v3), q, sc.set(w, h, d));
      im.setMatrixAt(k, m4);
      im.setColorAt(k, natural(tints[(info.tint * tints.length) | 0],
        0.5 + CONFIG.SATURATION * 0.5, new THREE.Color()));
      prints.push([t, z, w, d, info.spin]);
    });
  }

  /* ─────────── МАШИНЫ НА ПАРКОВКАХ ───────────
     План уже размечает кварталы типа «стоянка», но они стояли пустыми.
     Машины ставятся по той же разметке, что нарисована в текстуре. */
  {
    const cars = [];
    for (let i2 = 0; i2 < C.cols; i2++) {
      for (let j2 = 0; j2 < C.rows; j2++) {
        if (!cellUsable(i2, j2)) continue;
        const info = cellInfo(i2, j2);
        if (info.kind !== 'lot') continue;
        const t = cityCenter(i2, 0).t, z = cityCenter(i2, j2).z;
        if (!free(t, z)) continue;
        const vert = info.spin % 2 === 0;
        const rows2 = 4, cols2 = 3;
        for (let a = 0; a < rows2; a++) {
          for (let b = 0; b < cols2; b++) {
            const cr = mulberry32((CONFIG.SEED ^ (i2 * 911) ^ (j2 * 233) ^ (a * 37) ^ (b * 7)) >>> 0);
            if (cr() < 0.35) continue;                 // часть мест пустая
            const u = (a + 0.5) / rows2 - 0.5, v = (b + 0.5) / cols2 - 0.5;
            const dx = (vert ? u : v) * BLK.wT * 0.66;
            const dz = (vert ? v : u) * BLK.wZ * 0.66;
            cars.push([t + dx / R, z + dz, vert, cr()]);
          }
        }
      }
    }
    if (cars.length) {
      const body = mergeGeos([
        rod(0.22, 0.1, 0.5, 0, 0.05, 0),
        rod(0.19, 0.09, 0.26, 0, 0.14, -0.02)
      ]);
      const carMat = new THREE.MeshStandardMaterial({ roughness: 0.42, metalness: 0.35 });
      const carCols = [0xb9c2cb, 0x8a94a0, 0x6d4f46, 0x39506b, 0xa8564a, 0xd8d2c4];
      instance(body, carMat, cars.map(([t, z, vert, r2]) => [t, z, { vert, r2 }]),
        (k, t, z, m2, o) => {
          surfaceQuat(t, q).multiply(qs.setFromAxisAngle(UP, o.vert ? 0 : Math.PI / 2));
          m4.compose(surfacePos(t, R - 0.07, z, v3), q, sc.set(1, 1, 1));
          m2.setMatrixAt(k, m4);
          m2.setColorAt(k, natural(carCols[(o.r2 * carCols.length) | 0], 0.7, new THREE.Color()));
        });
    }
  }

  /* Панельная текстура нужна конструкциям на оси и башне */
  const { map: panel, canvas: panelCanvas } = makePanelTexture(mulberry32(CONFIG.SEED + 53));
  panel.anisotropy = Math.min(4, maxAniso);
  const panelNormal = Q.normals ? heightToNormal(panelCanvas, CONFIG.NORMALS.panel) : null;
  if (panelNormal) panelNormal.wrapS = panelNormal.wrapT = THREE.RepeatWrapping;

  /* ─────────── ХОЛМЫ ───────────
     Раньше это была гладкая сфера радиусом до 340 м и высотой 100 м,
     резервировавшая место всего на 9 юнитов: зелёная блямба, глотавшая
     деревья и дома. Теперь пологая гранёная возвышенность, которая
     резервирует свой настоящий радиус, а зелень встаёт НА неё. */
  /* ─────────── ХОЛМЫ ───────────
     Отдельных мешей больше нет: корпус уже продавлен по этому же списку
     (см. displaceHills). Раньше холм был сферой, положенной на землю: своя
     кромка, свой цвет, резкий стык — «навалили кучу на цилиндр». Здесь
     остаётся только список, по которому зелень встаёт на склон, а в низинах
     появляются пруды. */
  const HILL = CONFIG.HILL;
  const hills = hullHills.map(h => [h.t, h.z, h.r, h.dip ? -h.h * HILL.dipDepth : h.h]);

  /** Высота купола холма в точке — чтобы дерево стояло на склоне, а не в нём */
  const relief = (t, z) => {
    /* Складываем вклады тем же колоколом, каким продавлен корпус: иначе
       дерево встанет не на той высоте, что сама поверхность. Низины дают
       отрицательный вклад — там вода. */
    let up = 0;
    for (let k = 0; k < hills.length; k++) {
      const [ht, hz, hr, hh] = hills[k];
      const d = Math.hypot(angGap(t, ht) * R, z - hz);
      if (d >= hr) continue;
      const u = d / hr, f = (1 - u * u) * (1 - u * u);
      up += hh * f;
    }
    return up;
  };

  /* ─────────── ДЕРЕВЬЯ ─────────── */
  /* Полная высота дерева — одно число; ствол и крона выводятся из него.
     Раньше они выбирались независимо и в сумме давали до 87 м. Радиус,
     которым дерево резервирует место, пропорционален высоте, поэтому
     высокие стоят просторнее низких, а лес перестаёт быть сплошным. */
  const TR = CONFIG.TREE;
  const treeH = () => {
    const u = Math.pow((rnd() + rnd()) / 2, TR.bias);    // чаще невысокие
    return TR.h[0] + u * (TR.h[1] - TR.h[0]);
  };
  /* Шаг между деревьями падает как корень из плотности: при пятикратной с
     прежним шагом они просто не разместились бы, и лес вышел бы лысыми
     пятнами вместо ровного полога. */
  const density = CONFIG.GREEN_K;
  const spaceK = 1 / Math.sqrt(Math.max(0.2, density));
  const treePts = sample(W_TREE, Math.round(CONFIG.COUNT.trees[i] * Q.trees * density),
    () => treeH() * TR.crown * TR.spacing * spaceK, true);
  const SZ = CONFIG.SEASONS[CONFIG.SEASON] || CONFIG.SEASONS.summer;
  /* Данные дерева кладём В САМ элемент списка, а не в параллельный массив по
     индексу: инстансы режутся на секторы, и колбэк получает номер ВНУТРИ
     сектора — по глобальному индексу читалось бы чужое дерево. */
  for (const item of treePts) {
    const H = item[2] / (TR.crown * TR.spacing);          // восстанавливаем высоту
    item[2] = {
      H, th: H * TR.trunk, tr: H * TR.crown,
      up: relief(item[0], item[1]),
      spin: rnd() * TAU, squash: 0.85 + rnd() * 0.45,
      fall: rnd() < SZ.accent, tint: rnd()
    };
  }

  /* Комель ствола темнеет к земле — та же причина, что и у цоколя дома:
     без затемнения на самом объекте дерево кажется воткнутым в поверхность. */
  const trunkGeo = new THREE.CylinderGeometry(0.075, 0.13, 1, 6);
  {
    const tp = trunkGeo.attributes.position;
    const tc = new Float32Array(tp.count * 3);
    for (let k = 0; k < tp.count; k++) {
      const v = 0.34 + 0.66 * Math.min(1, Math.pow(tp.getY(k) + 0.5, 0.55) * 1.15);
      tc.fill(v, k * 3, k * 3 + 3);
    }
    trunkGeo.setAttribute('color', new THREE.BufferAttribute(tc, 3));
  }
  instance(
    trunkGeo,
    new THREE.MeshStandardMaterial({ color: 0x6b5236, roughness: 1, vertexColors: true }),
    treePts,
    (k, t, z, im, o) => {
      m4.compose(surfacePos(t, R - o.up - o.th / 2, z, v3), surfaceQuat(t, q),
        sc.set(o.H, o.th, o.H));
      im.setMatrixAt(k, m4);
    });

  const FOL = CONFIG.FOLIAGE, det = Q.foliage;
  /* Одна текстура на всё: силуэт для дальнего уровня и фактура листьев
     для ближних — рисунок не зависит от того, на что он натянут. */
  const leafMap = makeLeafTexture(mulberry32(CONFIG.SEED + 61));
  const leafNrm = Q.normals ? heightToNormal(leafMap.image, CONFIG.NORMALS.leaf, 256) : null;
  const crownMat = new THREE.MeshStandardMaterial({
    roughness: 0.9, flatShading: true, vertexColors: true,
    /* фактура листьев: без неё крона читается гранёным камнем */
    normalMap: leafNrm, normalScale: new THREE.Vector2(1.1, 1.1)
  });
  patchWindMaterial(crownMat);
  /* ─────────── КРОНЫ: три уровня детализации ───────────
     Пятикратная плотность без них дала бы одиннадцать миллионов граней. С
     ними — два: вблизи полная крона с ветром, поодаль упрощённая без него,
     вдали крест из двух плоскостей с текстурой листвы.

     Крест, а не билборд к камере: мир вращается, и разворачивать тысячи
     плоскостей каждый кадр дороже, чем сэкономлено. С расстояния, где
     работает этот уровень, разницы не видно.

     Все три меша строятся сразу и полными, а раскладку по уровням делает
     updateTreeLod: он переписывает только счётчики. */
  /* Прозрачность берём из АЛЬФЫ карты, а не из alphaMap: тот читает зелёный
     канал, и у листвы (0.4…0.75) со стволом (0.32) порог 0.42 срезал почти
     всё — дерево пропадало целиком. */
  const crownFar = new THREE.MeshStandardMaterial({
    map: leafMap, alphaTest: 0.5,
    roughness: 0.95, side: THREE.DoubleSide, vertexColors: true
  });
  const crownMid = crownMat.clone();
  crownMid.normalMap = leafNrm;

  const geos = [
    foliageGeo(det, mulberry32(CONFIG.SEED + 5), FOL.wobble, FOL.dither),
    foliageGeo(Math.max(0, det - 1), mulberry32(CONFIG.SEED + 5), FOL.wobble, FOL.dither),
    crossQuadGeo()
  ];
  const mats = [crownMat, crownMid, crownFar];

  /* Раскладка идёт ПО КАЖДОМУ ДЕРЕВУ, а не по сектору. Сектор охватывает всю
     длину станции, камера всегда внутри его сферы — по секторам отсекалось
     полтора десятка процентов вместо восьмидесяти.

     Матрицы и цвета считаются один раз и лежат готовыми; раскладка только
     раскладывает их по трём мешам и правит счётчики. Секторное деление
     остаётся: без него теряется отсечение по кадру. */
  {
    const buckets = Array.from({ length: CH }, () => []);
    for (const item of treePts) {
      const t = ((item[0] % TAU) + TAU) % TAU;
      buckets[Math.min(CH - 1, (t / TAU * CH) | 0)].push(item);
    }

    treeLod = [];
    for (const b of buckets) {
      if (!b.length) continue;
      /* заготовленные матрицы, цвета и точки — общие на все три уровня */
      const mats16 = new Float32Array(b.length * 16);
      const cols = new Float32Array(b.length * 3);
      const pts = new Float32Array(b.length * 3);
      const col = new THREE.Color();
      for (let k = 0; k < b.length; k++) {
        const [t, z, o] = b[k];
        surfaceQuat(t, q).multiply(qs.setFromAxisAngle(UP, o.spin));
        surfacePos(t, R - o.up - (o.th + o.tr * 0.55), z, v3);
        m4.compose(v3, q, sc.set(o.tr, o.tr * o.squash, o.tr));
        m4.toArray(mats16, k * 16);
        pts[k * 3] = v3.x; pts[k * 3 + 1] = v3.y; pts[k * 3 + 2] = v3.z;
        const pal = o.fall ? SZ.accents : SZ.greens;
        natural(pal[(o.tint * pal.length) | 0], CONFIG.SATURATION, col);
        cols[k * 3] = col.r; cols[k * 3 + 1] = col.g; cols[k * 3 + 2] = col.b;
        shadows.push([t, z, { r: o.tr * 1.5, up: o.up }]);
      }

      const trio = [];
      for (let li = 0; li < 3; li++) {
        const im = new THREE.InstancedMesh(geos[li], mats[li], b.length);
        im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(b.length * 3), 3);
        /* Ёмкость на весь сектор, но счётчик выставит раскладка. До неё меш
           пуст, поэтому сразу после сборки она вызывается принудительно. */
        im.count = 0;
        /* Отсечение по кадру оставляем: сфера считается по ёмкости сектора и
           не зависит от того, сколько деревьев в нём сейчас на этом уровне. */
        im.boundingSphere = sectorSphere(b, R);
        im.frustumCulled = true;
        trio.push(add(im));
      }
      treeLod.push({ trio, mats16, cols, pts, n: b.length });

      /* До первой раскладки мир должен быть целым сам по себе: складываем всё
         на ближний уровень. Иначе собранная сцена без вызова раскладки —
         пустые меши, и это ловушка для любого, кто соберёт мир отдельно. */
      const im0 = trio[0];
      im0.instanceMatrix.array.set(mats16);
      im0.instanceColor.array.set(cols);
      im0.count = b.length;
      im0.instanceMatrix.needsUpdate = true;
      im0.instanceColor.needsUpdate = true;
    }
  }

  /* ─────────── ТРАВА У КОМЛЕЙ ───────────
     Кольцо мелких травинок вокруг ствола: именно оно продаёт контакт с
     землёй лучше любой декали — глаз читает, что дерево растёт, а не
     воткнуто. Колышется тем же шейдером ветра, что и кроны. */
  {
    const blades = [];
    const nb = 7;
    for (let k = 0; k < nb; k++) {
      const a = (k / nb) * TAU + 0.4;
      const g0 = new THREE.PlaneGeometry(0.16, 0.34);
      g0.translate(0, 0.17, 0);
      g0.rotateX(-0.22);
      g0.translate(0.2, 0, 0);
      g0.rotateY(a);
      blades.push(g0.toNonIndexed());
      g0.dispose();
    }
    const tuftGeo = mergeGeos(blades.map(b => {
      const idx = [];
      for (let k = 0; k < b.attributes.position.count; k++) idx.push(k);
      b.setIndex(idx);
      return b;
    }));
    const tuftMat = new THREE.MeshStandardMaterial({
      color: 0x5c8a3c, roughness: 1, side: THREE.DoubleSide, flatShading: true
    });
    patchWindMaterial(tuftMat);
    instance(tuftGeo, tuftMat, treePts, (k, t, z, im, o) => {
      const s = CONFIG.TREE.tuft * (0.7 + o.H * 0.5);
      surfaceQuat(t, q).multiply(qs.setFromAxisAngle(UP, o.spin));
      m4.compose(surfacePos(t, R - o.up, z, v3), q, sc.set(s, s, s));
      im.setMatrixAt(k, m4);
    });
  }

  /* ─────────── КУСТЫ ─────────── */
  const bushMat = new THREE.MeshStandardMaterial({
    roughness: 1, flatShading: true, vertexColors: true
  });
  patchWindMaterial(bushMat);
  const bushCols = SZ.bushes;
  const BS = CONFIG.BUSH;
  const bushS = () => BS.s[0] + rnd() * (BS.s[1] - BS.s[0]);
  instance(
    foliageGeo(0, mulberry32(CONFIG.SEED + 6), FOL.wobble * 1.3, FOL.dither),
    bushMat,
    sample(W_BUSH, Math.round(CONFIG.COUNT.bushes[i] * Q.trees * CONFIG.GREEN_K), () => bushS() * BS.spacing, true),
    (k, t, z, im, rad) => {
      const s = rad / BS.spacing, up = relief(t, z);
      surfaceQuat(t, q).multiply(qs.setFromAxisAngle(UP, rnd() * TAU));
      m4.compose(surfacePos(t, R - up - s * BS.flat * 0.45, z, v3), q,
        sc.set(s, s * BS.flat, s));
      im.setMatrixAt(k, m4);
      im.setColorAt(k, natural(pick(rnd, bushCols), CONFIG.SATURATION, new THREE.Color()));
      /* Куст в полметра тень почти не даёт, а декаль — прозрачный квад с
         отключённой записью глубины: на мобильном перерисовка дороже
         треугольников. Полторы тысячи таких квадов не стоят своей цены. */
    });

  /* ─────────── КОНТАКТНЫЕ ТЕНИ ───────────
     Свет — труба на оси, поэтому тень падает прямо под объект. Для крон это
     круглое пятно, для домов — вытянутый след: поперёк улицы источник виден
     под 5°, вдоль оси под 142°, отсюда резкая кромка и длинный шлейф.
     Кайма у кромки работает как контактное затемнение. */
  const decal = new THREE.PlaneGeometry(1, 1);
  decal.rotateX(-Math.PI / 2);                    // нормаль в локальный +Y
  const blobMat = new THREE.MeshBasicMaterial({
    map: makeBlobTexture(), transparent: true, opacity: 0.85,
    depthWrite: false, fog: true
  });
  worldMats.blob = blobMat;

  /* на LOW следы домов не строим — они идут круглыми пятнами вместе с зеленью */
  if (!Q.footprint) for (const [t, z, w2, d2] of prints) {
    shadows.push([t, z, { r: Math.max(w2, d2) * 0.75, up: 0 }]);
  }

  for (const im of instance(decal, blobMat, shadows, (k, t, z, m2, info) => {
    m4.compose(surfacePos(t, R - info.up - 0.04, z, v3), surfaceQuat(t, q),
      sc.set(info.r * 2, 1, info.r * 2));
    m2.setMatrixAt(k, m4);
  })) im.renderOrder = 1;

  if (Q.footprint) {
    const printMat = new THREE.MeshBasicMaterial({
      map: makeFootprintTexture(), transparent: true, opacity: 0.85,
      depthWrite: false, fog: true
    });
    worldMats.print = printMat;
    const P = CONFIG.PRINT;
    const list = prints.map(([t, z, w2, d2, spin]) => [t, z, { w: w2, d: d2, spin }]);
    for (const im of instance(decal, printMat, list, (k, t, z, m2, o) => {
      const along = o.spin % 2;                   // куда развёрнут дом
      surfaceQuat(t, q).multiply(qs.setFromAxisAngle(UP, o.spin * Math.PI / 2));
      m4.compose(surfacePos(t, R - 0.05, z, v3), q,
        sc.set((along ? o.d : o.w) * P.across, 1, (along ? o.w : o.d) * P.along));
      m2.setMatrixAt(k, m4);
    })) im.renderOrder = 1;
  }

  /* ─────────── ТРАФИК ───────────
     Машины на магистралях: кузов с остеклением и отдельные лампы. Свет
     разделён по силе — окна еле тлеют, фары бьют. Точки заменены мешами:
     точка не показывает, куда машина едет, а фара показывает.
     Материал ламп базовый и с цветом ярче единицы: он не зависит от
     освещения и честно попадает в яркую выборку свечения. */
  {
    const lanes = [];
    for (let i2 = 0; i2 < C.cols; i2 += 3) {
      if (!cellUsable(i2, Math.floor(C.rows / 2))) continue;
      lanes.push(cityCenter(i2, 0).t - (BLK.stepT / 2) / R);
    }
    if (lanes.length) {
      const per = CONFIG.TRAFFIC.perLane;
      const n = lanes.length * per;
      const T2 = CONFIG.TRAFFIC;

      const bodyGeo = mergeGeos([
        rod(T2.w, T2.h * 0.62, T2.len, 0, T2.h * 0.31, 0),
        rod(T2.w * 0.86, T2.h * 0.5, T2.len * 0.52, 0, T2.h * 0.72, -T2.len * 0.04)
      ]);
      worldMats.trafficBody = new THREE.MeshStandardMaterial({
        color: 0x2c3340, roughness: 0.35, metalness: 0.5,
        emissiveMap: makeCarWindows(), emissive: 0xffffff, emissiveIntensity: 0
      });

      /* фары спереди, габариты сзади — цвет в вершинах, яркость в материале */
      const lampParts = [];
      const lampCol = [];
      const addLamp = (x, z, col) => {
        const g0 = rod(T2.w * 0.24, T2.h * 0.2, 0.06, x, T2.h * 0.34, z);
        lampParts.push(g0);
        for (let k = 0; k < g0.attributes.position.count; k++) lampCol.push(...col);
      };
      addLamp(-T2.w * 0.32, T2.len * 0.5, [1, 0.96, 0.85]);
      addLamp(T2.w * 0.32, T2.len * 0.5, [1, 0.96, 0.85]);
      /* Габариты гасим В САМОМ ЦВЕТЕ. Яркость материала 3.2 умножает все
         каналы, и (1, 0.16, 0.1) превращалось в (3.2, 0.51, 0.32) — после
         ограничения единицей это оранжево-белый, а не красный. */
      addLamp(-T2.w * 0.32, -T2.len * 0.5, [0.38, 0.03, 0.015]);
      addLamp(T2.w * 0.32, -T2.len * 0.5, [0.38, 0.03, 0.015]);
      const lampGeo = mergeGeos(lampParts);
      lampGeo.setAttribute('color', new THREE.Float32BufferAttribute(lampCol, 3));
      worldMats.trafficLamp = new THREE.MeshBasicMaterial({
        vertexColors: true, toneMapped: false, color: new THREE.Color(0, 0, 0)
      });

      const bodies = new THREE.InstancedMesh(bodyGeo, worldMats.trafficBody, n);
      const lamps = new THREE.InstancedMesh(lampGeo, worldMats.trafficLamp, n);
      bodies.frustumCulled = lamps.frustumCulled = false;
      const tint = [0x9aa4b0, 0x6f7b88, 0x8a5a4e, 0x40566e, 0xb4b0a6, 0x55606c];
      for (let k = 0; k < n; k++) {
        bodies.setColorAt(k, natural(tint[(rnd() * tint.length) | 0], 0.75, new THREE.Color()));
      }
      traffic = {
        lanes, per, bodies, lamps,
        dir: new Float32Array(n), off: new Float32Array(n), half: C.street * 0.22
      };
      for (let k = 0; k < n; k++) {
        traffic.dir[k] = k % 2 ? 1 : -1;
        traffic.off[k] = rnd() * CONFIG.L;
      }
      worldMats.trafficMesh = bodies;
      add(bodies); add(lamps);
      updateTraffic(0);
    }
  }

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

  return { panel, panelNormal, albedo, hullMat: worldMats.hull,
    waterRough: worldMats.waterRough, waterNormal: worldMats.waterNormal,
    drawn: sceneParts.length };
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


/** Кузова и лампы — для переключателя видимости */
export const trafficMeshes = () => traffic ? [traffic.bodies, traffic.lamps] : [];

/** Машины едут вдоль магистралей. Кузов и лампы делят одну матрицу. */
export function updateTraffic(dt) {
  if (!traffic) return;
  const R = CONFIG.R, L = CONFIG.L, HL = L / 2;
  const sp = CONFIG.TRAFFIC.speed;
  const n = traffic.dir.length;
  for (let k = 0; k < n; k++) {
    traffic.off[k] = (traffic.off[k] + traffic.dir[k] * sp * dt + L) % L;
    const z = traffic.off[k] - HL;
    /* встречные полосы разнесены поперёк улицы */
    const t = traffic.lanes[(k / traffic.per) | 0] + traffic.dir[k] * traffic.half / R;
    _tq.copy(surfaceQuat(t, _tq2));
    if (traffic.dir[k] < 0) _tq.multiply(_tqs.setFromAxisAngle(_tup, Math.PI));
    _tm.compose(surfacePos(t, R - CONFIG.TRAFFIC.h * 0.5, z, _tv), _tq, _tone);
    traffic.bodies.setMatrixAt(k, _tm);
    traffic.lamps.setMatrixAt(k, _tm);
  }
  traffic.bodies.instanceMatrix.needsUpdate = true;
  traffic.lamps.instanceMatrix.needsUpdate = true;
}

const _tm = new THREE.Matrix4(), _tq = new THREE.Quaternion(), _tq2 = new THREE.Quaternion();
const _tqs = new THREE.Quaternion(), _tv = new THREE.Vector3();
const _tup = new THREE.Vector3(0, 1, 0), _tone = new THREE.Vector3(1, 1, 1);
