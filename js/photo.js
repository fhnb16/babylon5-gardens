import * as THREE from 'three';
import { CONFIG } from './config.js';
import { SMAA_AREA, SMAA_SEARCH } from './smaa-lut.js';
import {
  SMAA_EDGES_VERT, SMAA_EDGES_FRAG, SMAA_EDGES_DEFINES,
  SMAA_WEIGHTS_VERT, SMAA_WEIGHTS_FRAG, SMAA_WEIGHTS_DEFINES,
  SMAA_BLEND_VERT, SMAA_BLEND_FRAG
} from './smaa-shaders.js';

/* ═══════════════════════════════════════════════════════════════════════════
   ТРАССИРОВКА ДЛЯ ФОТО-РЕЖИМА

   Что здесь считается лучами: затенение. Для каждого пикселя из его точки
   выпускается пучок лучей по косинусному распределению в полусфере вокруг
   нормали, и каждый проверяется на пересечение со сценой через буфер
   глубины. За кадр — RAYS лучей, кадры накапливаются, результат сходится.

   Заодно каждый кадр смещается на долю пикселя, поэтому накопление даёт
   ещё и полноценное сглаживание: кроны перестают рябить на краях.

   Ограничение честное: лучи видят только то, что попало на экран. Объект за
   спиной камеры тени не отбросит. Полный трассировщик здесь дал бы результат
   хуже, а не лучше: главный источник — прямая труба на оси, её мягкая тень
   и так считается аналитически и точно.
   ═══════════════════════════════════════════════════════════════════════════ */

export const trace = { active: false, sample: 0, total: 0, debug: 0 };
/* 0 — обычный кадр, 1 — затенение, 2 — переотражённый свет,
   3 — отражения, 4 — шероховатость из альфы кадра */
export const DEBUG_NAMES = ['кадр', 'затенение', 'переотражения', 'отражения',
  'прямой свет', 'шероховатость', 'куда попал луч'];
export function setTraceDebug(v) {
  trace.debug = v;
  if (aoMat) { aoMat.uniforms.uDebug.value = v; trace.sample = 0; }
}

let R = null, S = null, C = null;                    // renderer, scene, camera
let rtNormal, rtBeauty, accum = [], quad, aoMat, showMat, qCam, qScene;
let hidden = [], savedWind = 1, normalMat = null;

/* Гальтоново-подобная последовательность для субпиксельного смещения:
   равномернее случайной и не даёт «комков» при малом числе кадров */
function halton(index, base) {
  let f = 1, r = 0, i = index;
  while (i > 0) { f /= base; r += f * (i % base); i = Math.floor(i / base); }
  return r;
}

const VERT = `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }
`;

const AO_FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tBeauty, tNormal, tDepth, tPrev;
  uniform mat4 uProj, uProjInv;
  uniform vec2 uRes;
  uniform float uRadius, uIntensity, uSeed, uBlend, uBias, uFogD, uBounce, uReflect, uRefStep, uRefGrow;
  uniform float uAoNear, uAoFar, uDebug;
  uniform vec3 uSunA, uSunB, uSunU, uSunV;   // труба-солнце в видовых координатах
  uniform float uSunR, uShadow, uAmbient;
  uniform mat4 uInvView;                     // видовые → мировые
  uniform sampler2D tHull;                   // альбедо корпуса
  uniform float uHullR, uHullL, uWorldRot, uSunGlow;

  vec3 viewPos( vec2 uv, float d ) {
    vec4 c = uProjInv * vec4( uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );
    return c.xyz / c.w;
  }
  float hash( vec3 p ) {
    return fract( sin( dot( p, vec3( 127.1, 311.7, 74.7 ) ) ) * 43758.5453 );
  }

  void main() {
    vec4 beauty = texture2D( tBeauty, vUv );
    vec3 col = beauty.rgb;
    float rough = beauty.a;                 // шероховатость записана материалами
    float d = texture2D( tDepth, vUv ).x;
    float ao = 1.0;
    vec3 gi = vec3( 0.0 );
    vec3 refl = vec3( 0.0 );
    float vis = 1.0;

    if ( d < 1.0 ) {
      vec3 P = viewPos( vUv, d );
      vec3 N = normalize( texture2D( tNormal, vUv ).xyz * 2.0 - 1.0 );
      /* базис вокруг нормали для косинусного распределения */
      vec3 up = abs( N.z ) < 0.9 ? vec3( 0.0, 0.0, 1.0 ) : vec3( 1.0, 0.0, 0.0 );
      vec3 T = normalize( cross( up, N ) );
      vec3 B = cross( N, T );

      /* радиус в пикселях: если меньше пары пикселей, все лучи попадут в тот
         же тексель и дадут только шум */
      float pxR = uRadius / max( 0.001, -P.z ) * uProj[1][1] * uRes.y * 0.5;
      float occ = 0.0;
      vec3 bounce = vec3( 0.0 );
      for ( int i = 0; i < RAYS; i ++ ) {
        if ( pxR < 3.0 ) break;
        vec3 seed = vec3( vUv * uRes, uSeed + float( i ) * 1.618 );
        float u = hash( seed );
        float phi = hash( seed + 17.0 ) * 6.28318531;
        float len = 0.15 + 0.85 * hash( seed + 41.0 );

        float sr = sqrt( u );
        vec3 dir = T * ( sr * cos( phi ) ) + B * ( sr * sin( phi ) )
                 + N * sqrt( max( 0.0, 1.0 - u ) );
        vec3 Sp = P + dir * uRadius * len;

        vec4 cp = uProj * vec4( Sp, 1.0 );
        vec2 suv = ( cp.xy / cp.w ) * 0.5 + 0.5;
        if ( suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0 ) continue;

        float sd = texture2D( tDepth, suv ).x;
        if ( sd >= 1.0 ) continue;
        vec3 hit = viewPos( suv, sd );
        float dz = hit.z - Sp.z;                 // вид: −z вперёд, ближе = больше
        /* Затенение обязано быть МЕСТНЫМ. Прежняя модель (радиус / дальность)
           давала 10% затемнения даже от объекта в полутора сотнях метров —
           по всему кадру это складывалось в равномерную дымку, а не в тени.
           Считаем только тех, кто ближе двух радиусов. */
        /* Окно приёма шире радиуса давало чёрные ореолы: дом в 15–28 м перед
           дальним фоном попадал в него и затемнял фон вокруг своего силуэта.
           Принимаем только то, что ближе радиуса, и гасим уже с половины. */
        if ( dz > uBias && dz < uRadius ) {
          float w = 1.0 - smoothstep( uRadius * 0.5, uRadius, dz );
          occ += w;
          /* Луч не просто «загорожен» — он принёс свет с той поверхности.
             Это и есть переотражение: трава подкрашивает стену зелёным,
             ночная улица — тёплым. Тот же пучок лучей, лишняя выборка цвета. */
          bounce += texture2D( tBeauty, suv ).rgb * w;
        }
      }
      ao = 1.0 - clamp( occ / float( RAYS ) * uIntensity, 0.0, 1.0 );
      gi = bounce / float( RAYS ) * uBounce;

      /* ─── ПРЯМОЙ СВЕТ ЛУЧАМИ ───
         Источник задан аналитически — труба радиусом uSunR на оси станции.
         Поэтому теневой луч идёт к НАСТОЯЩЕЙ точке на ней, а не к выдуманной:
         каждая выборка берёт случайную точку по длине и по обхвату трубы.
         Отсюда и мягкая полутень — она следует из размеров источника, а не
         подобрана. Растеризатор здесь не помощник: в three точечный источник
         без карты теней просто светит сквозь всё, и теней от солнца в кадре
         не было вовсе. */
      float lit = 0.0, wsum = 0.0;
      for ( int i = 0; i < RAYS; i ++ ) {
        vec3 sd3 = vec3( vUv * uRes, uSeed + float( i ) * 2.399 );
        float along = hash( sd3 );
        float ang = hash( sd3 + 5.0 ) * 6.28318531;
        vec3 L = mix( uSunA, uSunB, along )
               + ( uSunU * cos( ang ) + uSunV * sin( ang ) ) * uSunR;

        vec3 toL = L - P;
        float dist = length( toL );
        vec3 dir = toL / dist;
        float ndl = dot( N, dir );
        if ( ndl <= 0.0 ) continue;              // источник за поверхностью
        wsum += ndl;

        /* марш к источнику: шаг растёт, вблизи важна точность, вдали нет */
        float blocked = 0.0;
        float st = dist * 0.02;
        float travel = st * ( 1.0 + hash( sd3 + 11.0 ) );
        for ( int s = 0; s < SHADOW_STEPS; s ++ ) {
          vec3 sp = P + dir * travel;
          vec4 cp = uProj * vec4( sp, 1.0 );
          vec2 suv = ( cp.xy / cp.w ) * 0.5 + 0.5;
          if ( suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0 ) break;
          float sdp = texture2D( tDepth, suv ).x;
          if ( sdp < 1.0 ) {
            vec3 hp2 = viewPos( suv, sdp );
            float gap2 = hp2.z - sp.z;
            /* преграда between точкой и источником — но не бесконечно
               толстая: за экраном её толщину знать неоткуда */
            if ( gap2 > uBias && gap2 < uRadius * 6.0 ) { blocked = 1.0; break; }
          }
          travel += st;
          st *= 1.25;
          if ( travel > dist ) break;
        }
        lit += ndl * ( 1.0 - blocked );
      }
      if ( wsum > 0.0 ) vis = lit / wsum;

      /* ─── Отражения: пересечение с настоящими телами ───
         Отражать здесь может только то, что есть в цилиндре: труба-солнце и
         борт станции. Оба — цилиндры вдоль оси, и луч пересекается с ними
         ФОРМУЛОЙ, а не маршем по экрану. Экранный марш давал чёрные пятна
         там, где луч уходил за кадр, хотя борт в той стороне есть. */
      float smoothness = 1.0 - rough;
      if ( smoothness > 0.25 ) {
        vec3 V = normalize( P );
        vec3 Rd = reflect( V, N );

        /* в мировые координаты: тела заданы там */
        vec3 wo = ( uInvView * vec4( P, 1.0 ) ).xyz;
        vec3 wd = normalize( ( uInvView * vec4( Rd, 0.0 ) ).xyz );

        vec3 hitCol = vec3( 0.0 );
        float got = 0.0;

        /* Сперва марш по экрану: только он видит фермы, деревья и дома —
           всё, что стоит между водой и бортом. Аналитика их не знает, и
           одной ею река выходила чёрной с белой полосой солнца. */
        vec3 mp = P;
        float mst = uRefStep * ( 0.6 + 0.8 * hash( vec3( vUv * uRes, uSeed ) ) );
        for ( int i = 0; i < REF_STEPS; i ++ ) {
          mp += Rd * mst;
          vec4 mc = uProj * vec4( mp, 1.0 );
          vec2 muv = ( mc.xy / mc.w ) * 0.5 + 0.5;
          if ( muv.x < 0.0 || muv.x > 1.0 || muv.y < 0.0 || muv.y > 1.0 ) break;
          float md = texture2D( tDepth, muv ).x;
          if ( md < 1.0 ) {
            vec3 mh = viewPos( muv, md );
            float mg = mh.z - mp.z;
            if ( mg > 0.0 && mg < mst * 2.0 && mh.z < P.z
                 && length( muv - vUv ) * uRes.y > 2.0 ) {
              vec2 me = abs( muv - 0.5 ) * 2.0;
              /* у кромки кадра гасим и уступаем место аналитике */
              got = smoothstep( 0.0, 0.14, 1.0 - max( me.x, me.y ) );
              hitCol = texture2D( tBeauty, muv ).rgb;
              break;
            }
          }
          mst *= uRefGrow;
        }

        /* труба-солнце: ближний корень, луч идёт снаружи внутрь */
        vec3 farCol = vec3( 0.0 );
        float farGot = 0.0;
        float a = dot( wd.xy, wd.xy );
        if ( a > 1e-6 ) {
          float b = 2.0 * dot( wo.xy, wd.xy );
          float c0 = dot( wo.xy, wo.xy ) - uSunR * uSunR;
          float disc = b * b - 4.0 * a * c0;
          if ( disc > 0.0 ) {
            float tS = ( -b - sqrt( disc ) ) / ( 2.0 * a );
            if ( tS > 0.02 && abs( wo.z + wd.z * tS ) < uHullL * 0.5 ) {
              farCol = vec3( 1.0, 0.94, 0.78 ) * uSunGlow;
              farGot = 1.0;
            }
          }

          /* борт станции: дальний корень, мы внутри цилиндра */
          if ( farGot < 0.5 ) {
            float cH = dot( wo.xy, wo.xy ) - uHullR * uHullR;
            float dH = b * b - 4.0 * a * cH;
            if ( dH > 0.0 ) {
              float tH = ( -b + sqrt( dH ) ) / ( 2.0 * a );
              vec3 hw = wo + wd * tH;
              if ( tH > 0.02 && abs( hw.z ) < uHullL * 0.5 ) {
                /* Цвет берём из альбедо корпуса по UV точки попадания.
                   Мир вращается — угол снимаем поворотом назад. */
                float th = atan( hw.x, hw.y ) - uWorldRot;
                float uu = fract( 0.5 - th / 6.28318531 );
                float vv = hw.z / uHullL + 0.5;
                farCol = texture2D( tHull, vec2( uu, vv ) ).rgb;
                farGot = 1.0;
              }
            }
          }
        }

        /* Экранное попадание в приоритете, аналитика добирает остаток:
           там, где луч ушёл за кадр, борт цилиндра всё равно есть. */
        vec3 mix2 = hitCol * got + farCol * farGot * ( 1.0 - got );
        float any = max( got, farGot );
        if ( any > 0.001 ) {
          float fres = pow( 1.0 - max( 0.0, dot( -V, N ) ), 4.0 );
          refl = mix2 * smoothness * ( 0.05 + 0.95 * fres ) * uReflect;
        }
      }

      /* Затенение — местный эффект. На дальнем плане цвет уже определяется
         туманом, и умножать его на AO нельзя: картинка сереет и теряет
         контраст. Гасим ровно тем же законом, что и туман сцены. */
      /* Контактное затенение — эффект вблизи. На дальнем плане радиус
         проецируется в доли пикселя, и остаётся только низкочастотный мусор:
         на корпусе он читается как пятна. Гасим по расстоянию, а туман
         добавляет второе затухание — там цвет и так им определяется. */
      float dist = length( P );
      float near = 1.0 - smoothstep( uAoNear, uAoFar, dist );
      float fogAmt = exp( - ( dist * uFogD ) * ( dist * uFogD ) );
      float k = near * fogAmt;
      ao = mix( 1.0, ao, k );
      gi *= k;
      refl *= k;
    }

    /* Отражённый свет красится в цвет самой поверхности — так и работает
       диффузное переотражение. Зеркальная составляющая добавляется поверх. */
    /* В тени остаётся только рассеянный свет полусферы — его доля uAmbient.
       Так теневой луч и превращается в освещение: не в тёмное пятно поверх
       картинки, а в отсутствие прямого света. */
    float shade = mix( 1.0, mix( uAmbient, 1.0, vis ), uShadow );
    vec3 cur = col * ao * shade + col * gi + refl;

    /* Отладка: показать ТОЛЬКО вклад лучей, без исходной картинки. Накопление
       идёт как обычно, поэтому видно и схождение, и что именно посчитано. */
    if ( uDebug > 0.5 ) {
      if ( uDebug < 1.5 )      cur = vec3( ao );
      else if ( uDebug < 2.5 ) cur = gi * 4.0;
      else if ( uDebug < 3.5 ) cur = refl * 4.0;
      else if ( uDebug < 4.5 ) cur = vec3( vis );
      else if ( uDebug < 5.5 ) cur = vec3( d < 1.0 ? 1.0 : 0.0 ) * vec3( 1.0 - rough );
      else {
        /* куда попал отражённый луч: зелёный — нашёл цель, красный — ушёл
           за экран, чёрный — поверхность не отражает */
        float sm = 1.0 - rough;
        cur = sm > 0.25
          ? ( length( refl ) > 0.0001 ? vec3( 0.1, 0.9, 0.2 ) : vec3( 0.9, 0.15, 0.1 ) )
          : vec3( 0.0 );
      }
    }
    gl_FragColor = vec4( mix( texture2D( tPrev, vUv ).rgb, cur, uBlend ), 1.0 );
  }
`;

/* При рендере в буфер three не применяет ни тонмаппинг, ни перевод в sRGB —
   это делается только при выводе на канвас. Значит, любой постпроцесс обязан
   выполнить их сам. Общий кусок для трассировки и для FXAA. */
export const TONEMAP_GLSL = `
  vec3 aces( vec3 x ) {
    const mat3 inM = mat3(
      0.59719, 0.07600, 0.02840,
      0.35458, 0.90834, 0.13383,
      0.04823, 0.01566, 0.83777 );
    const mat3 outM = mat3(
       1.60475, -0.10208, -0.00327,
      -0.53108,  1.10813, -0.07276,
      -0.07367, -0.00605,  1.07602 );
    vec3 v = inM * x;
    vec3 a = v * ( v + 0.0245786 ) - 0.000090537;
    vec3 b = v * ( 0.983729 * v + 0.4329510 ) + 0.238081;
    return clamp( outM * ( a / b ), 0.0, 1.0 );
  }
  vec3 toScreen( vec3 linear, float exposure ) {
    vec3 c = aces( linear * exposure );
    return mix( c * 12.92, 1.055 * pow( max( c, vec3( 0.0 ) ), vec3( 0.41666 ) ) - 0.055,
                step( 0.0031308, c ) );
  }
`;

const SHOW_FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tAccum;
  uniform float uExposure;
  ${TONEMAP_GLSL}
  void main() {
    gl_FragColor = vec4( toScreen( texture2D( tAccum, vUv ).rgb, uExposure ), 1.0 );
  }
`;

function makeTargets(w, h) {
  const depth = new THREE.DepthTexture(w, h);
  depth.format = THREE.DepthFormat;
  depth.type = THREE.UnsignedIntType;
  rtNormal = new THREE.WebGLRenderTarget(w, h, {
    depthTexture: depth, depthBuffer: true,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter
  });
  rtBeauty = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType, depthBuffer: true, samples: CONFIG.MSAA_SAMPLES,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter
  });
  accum = [0, 1].map(() => new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType, depthBuffer: false,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter
  }));
}

function dispose() {
  for (const t of [rtNormal, rtBeauty, ...accum]) t?.dispose();
  rtNormal?.depthTexture?.dispose();
  accum = [];
  quad?.geometry.dispose();
  aoMat?.dispose(); showMat?.dispose(); normalMat?.dispose();
  normalMat = null;
  quad = aoMat = showMat = qScene = qCam = null;
}

/** Прозрачное в буфер нормалей не пускаем: пятна теней и пылинки записали бы
    глубину прямо над землёй и залили бы кадр ложным затенением. */
function hideTransparent(root) {
  hidden = [];
  root.traverse(o => {
    const m = o.material;
    if (o.visible && m && (Array.isArray(m) ? m[0]?.transparent : m.transparent)) {
      hidden.push(o); o.visible = false;
    }
  });
}
const restoreTransparent = () => { for (const o of hidden) o.visible = true; hidden = []; };

export function startTrace(renderer, scene, camera, windUniform) {
  if (trace.active) return;
  R = renderer; S = scene; C = camera;
  const P = CONFIG.PHOTO;

  /* Плотность пикселей задаёт main: во время съёмки он поднимает её до
     масштаба снимка, и буферы здесь просто повторяют текущий размер. */
  const size = new THREE.Vector2();
  renderer.getDrawingBufferSize(size);
  makeTargets(size.x, size.y);

  /* мир должен замереть: любое движение обнуляет накопленное */
  savedWind = windUniform.value;
  windUniform.value = 0;

  qCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  qScene = new THREE.Scene();
  aoMat = new THREE.ShaderMaterial({
    defines: { RAYS: P.rays, REF_STEPS: P.refSteps, SHADOW_STEPS: P.shadowSteps },
    vertexShader: VERT, fragmentShader: AO_FRAG,
    uniforms: {
      tBeauty: { value: rtBeauty.texture }, tNormal: { value: rtNormal.texture },
      tDepth: { value: rtNormal.depthTexture }, tPrev: { value: accum[1].texture },
      uProj: { value: new THREE.Matrix4() }, uProjInv: { value: new THREE.Matrix4() },
      uRes: { value: new THREE.Vector2(size.x, size.y) },
      uRadius: { value: P.radius }, uIntensity: { value: P.intensity },
      uBias: { value: P.bias }, uSeed: { value: 0 }, uBlend: { value: 1 },
      uFogD: { value: 0 }, uBounce: { value: P.bounce },
      uReflect: { value: P.reflect }, uRefStep: { value: P.refStep },
      uRefGrow: { value: P.refGrow },
      uAoNear: { value: P.aoNear }, uAoFar: { value: P.aoFar },
      uDebug: { value: 0 },
      uSunA: { value: new THREE.Vector3() }, uSunB: { value: new THREE.Vector3() },
      uSunU: { value: new THREE.Vector3() }, uSunV: { value: new THREE.Vector3() },
      uSunR: { value: CONFIG.SUN.r }, uShadow: { value: P.shadow },
      uAmbient: { value: 0.22 },
      uInvView: { value: new THREE.Matrix4() },
      tHull: { value: null }, uHullR: { value: CONFIG.R },
      uHullL: { value: CONFIG.L }, uWorldRot: { value: 0 },
      uSunGlow: { value: P.sunGlow }
    }
  });
  showMat = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: SHOW_FRAG,
    uniforms: { tAccum: { value: accum[0].texture }, uExposure: { value: renderer.toneMappingExposure } }
  });
  /* DoubleSide обязателен: корпус станции рисуется изнанкой, и односторонний
     материал не записал бы землю в буфер глубины — лучи проходили бы сквозь
     пол, и затенения на земле не было бы вовсе. */
  normalMat = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });

  quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), aoMat);
  quad.frustumCulled = false;
  qScene.add(quad);

  trace.active = true;
  trace.sample = 0;
  trace.total = P.samples;
}

/** Один шаг накопления. Возвращает долю готовности 0…1 */
export function traceStep() {
  if (!trace.active) return 1;
  const P = CONFIG.PHOTO;
  const n = trace.sample;

  /* набрали нужное — дальше только показываем, не жжём кадры впустую */
  if (n >= trace.total) {
    showAccum(accum[(n - 1) % 2 === 0 ? 0 : 1]);
    return 1;
  }

  /* субпиксельное смещение — оно же даёт сглаживание */
  const w = R.domElement.width, h = R.domElement.height;
  C.setViewOffset(w, h, halton(n + 1, 2) - 0.5, halton(n + 1, 3) - 0.5, w, h);
  C.updateProjectionMatrix();

  /* нормали и глубина */
  /* Туман и фон не трогаем: MeshNormalMaterial их не читает, а переключение
     scene.fog заставляло three держать по два варианта программы на каждый
     материал и менять их каждый кадр. */
  hideTransparent(S);
  S.overrideMaterial = normalMat;
  R.setRenderTarget(rtNormal);
  R.render(S, C);
  S.overrideMaterial = null;
  restoreTransparent();

  /* сам кадр — в линейном пространстве, без тонмаппинга */
  R.setRenderTarget(rtBeauty);
  R.render(S, C);

  /* Труба-солнце в видовых координатах. Ось станции неподвижна относительно
     вращения мира (вращение идёт вокруг неё же), поэтому достаточно перевести
     её концы камерой. uSunU и uSunV — перпендикуляры для обхвата трубы. */
  const SUN = CONFIG.SUN;
  _sunP.set(0, 0, -SUN.len / 2).applyMatrix4(C.matrixWorldInverse);
  aoMat.uniforms.uSunA.value.copy(_sunP);
  _sunP.set(0, 0, SUN.len / 2).applyMatrix4(C.matrixWorldInverse);
  aoMat.uniforms.uSunB.value.copy(_sunP);
  _sunAxis.subVectors(aoMat.uniforms.uSunB.value, aoMat.uniforms.uSunA.value).normalize();
  _sunU.set(1, 0, 0).cross(_sunAxis);
  if (_sunU.lengthSq() < 1e-6) _sunU.set(0, 1, 0).cross(_sunAxis);
  _sunU.normalize();
  _sunV.crossVectors(_sunAxis, _sunU).normalize();
  aoMat.uniforms.uSunU.value.copy(_sunU);
  aoMat.uniforms.uSunV.value.copy(_sunV);
  aoMat.uniforms.uAmbient.value = ambientShare;
  aoMat.uniforms.uInvView.value.copy(C.matrixWorld);
  aoMat.uniforms.uWorldRot.value = traceWorldRot;
  aoMat.uniforms.tHull.value = hullAlbedo;

  /* трассировка затенения и накопление */
  const src = accum[n % 2 === 0 ? 1 : 0], dst = accum[n % 2 === 0 ? 0 : 1];
  aoMat.uniforms.tPrev.value = src.texture;
  aoMat.uniforms.uProj.value.copy(C.projectionMatrix);
  aoMat.uniforms.uProjInv.value.copy(C.projectionMatrixInverse);
  aoMat.uniforms.uSeed.value = n * 7.31;
  aoMat.uniforms.uDebug.value = trace.debug;
  aoMat.uniforms.uFogD.value = S.fog ? S.fog.density : 0;
  aoMat.uniforms.uBlend.value = 1 / (n + 1);
  quad.material = aoMat;
  R.setRenderTarget(dst);
  R.render(qScene, qCam);

  /* Показать накопленное — через ту же постобработку, что и обычный кадр:
     иначе включение трассировки выключало бы свечение и лучи. */
  showAccum(dst);

  C.clearViewOffset();
  trace.sample = Math.min(n + 1, trace.total);
  return trace.sample / trace.total;
}

/* ═══════════════════════════════════════════════════════════════════════════
   FXAA — альтернатива суперсэмплингу для слабых устройств

   Сглаживает по контрасту яркости постфильтром: дёшево, но замыливает мелкие
   детали (разметку дорог, окна фасадов, решётку ферм). Суперсэмплинг честнее,
   зато стоит квадрат масштаба. Выбор за пользователем.

   Кадр идёт через буфер, поэтому тонмаппинг здесь свой — тот же, что у
   трассировки. Сглаживать нужно именно экранные значения: по линейному HDR
   контраст яркости считается неверно.
   ═══════════════════════════════════════════════════════════════════════════ */
const FXAA_FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tScene, tGlow, tRays;
  uniform vec2 uRes;
  uniform float uExposure, uGlow, uRays, uFxaa;
  ${TONEMAP_GLSL}

  /* Свечение и лучи складываются с яркостью сцены ДО тонмаппинга —
     так ведёт себя рассеяние света в оптике. */
  vec3 sceneAt( vec2 uv ) {
    vec3 c = texture2D( tScene, uv ).rgb * uExposure;
    c += texture2D( tGlow, uv ).rgb * uGlow;
    c += texture2D( tRays, uv ).rgb * uRays;
    return c;
  }
  vec3 fetch( vec2 uv ) { return toScreen( sceneAt( uv ), 1.0 ); }
  float luma( vec3 c ) { return dot( c, vec3( 0.299, 0.587, 0.114 ) ); }

  void main() {
    vec2 rcp = 1.0 / uRes;
    vec3 rgbM = fetch( vUv );
    float lM  = luma( rgbM );
    float lNW = luma( fetch( vUv + vec2( -1.0, -1.0 ) * rcp ) );
    float lNE = luma( fetch( vUv + vec2(  1.0, -1.0 ) * rcp ) );
    float lSW = luma( fetch( vUv + vec2( -1.0,  1.0 ) * rcp ) );
    float lSE = luma( fetch( vUv + vec2(  1.0,  1.0 ) * rcp ) );

    float lMin = min( lM, min( min( lNW, lNE ), min( lSW, lSE ) ) );
    float lMax = max( lM, max( max( lNW, lNE ), max( lSW, lSE ) ) );
    /* ровный участок не трогаем — иначе фильтр мылит всё подряд */
    if ( uFxaa < 0.5 || lMax - lMin < max( 0.0312, lMax * 0.125 ) ) {
      gl_FragColor = vec4( rgbM, 1.0 );
      return;
    }

    vec2 dir = vec2( -( ( lNW + lNE ) - ( lSW + lSE ) ), ( lNW + lSW ) - ( lNE + lSE ) );
    float red = max( ( lNW + lNE + lSW + lSE ) * 0.25 * 0.125, 0.0078 );
    float rcpDir = 1.0 / ( min( abs( dir.x ), abs( dir.y ) ) + red );
    dir = clamp( dir * rcpDir, -8.0, 8.0 ) * rcp;

    vec3 rgbA = 0.5 * ( fetch( vUv + dir * ( 1.0 / 3.0 - 0.5 ) )
                      + fetch( vUv + dir * ( 2.0 / 3.0 - 0.5 ) ) );
    vec3 rgbB = rgbA * 0.5 + 0.25 * ( fetch( vUv + dir * -0.5 ) + fetch( vUv + dir * 0.5 ) );
    float lB = luma( rgbB );
    gl_FragColor = vec4( ( lB < lMin || lB > lMax ) ? rgbA : rgbB, 1.0 );
  }
`;

/* ═══════════════════════════════════════════════════════════════════════════
   СВЕЧЕНИЕ И ЛУЧИ ОТ ОСИ

   Оба берут одну и ту же выборку ярких мест и стоят на ней вдвоём: свечение
   размывает её крестом, лучи растягивают от источника. Считать яркое дважды
   незачем, поэтому проход общий.

   Работают ДО тонмаппинга, в линейном HDR: свечение — физически рассеяние
   света в оптике, оно складывается с яркостью сцены, а не с готовой картинкой.
   ═══════════════════════════════════════════════════════════════════════════ */
const BRIGHT_FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tScene;
  uniform float uThreshold, uExposure;
  void main() {
    vec3 c = texture2D( tScene, vUv ).rgb * uExposure;
    float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
    gl_FragColor = vec4( c * smoothstep( uThreshold, uThreshold * 2.0, l ), 1.0 );
  }
`;

const BLUR_FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tSrc;
  uniform vec2 uDir;
  void main() {
    /* пятиточечный гаусс: веса 6/4/1 из биномиальных коэффициентов */
    vec3 c = texture2D( tSrc, vUv ).rgb * 0.375;
    c += ( texture2D( tSrc, vUv + uDir ).rgb + texture2D( tSrc, vUv - uDir ).rgb ) * 0.25;
    c += ( texture2D( tSrc, vUv + uDir * 2.0 ).rgb + texture2D( tSrc, vUv - uDir * 2.0 ).rgb ) * 0.0625;
    gl_FragColor = vec4( c, 1.0 );
  }
`;

const RAYS_FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tSrc;
  uniform vec2 uSun;
  uniform float uDensity, uDecay;
  void main() {
    vec2 dir = ( uSun - vUv ) * uDensity / float( RAY_STEPS );
    vec2 uv = vUv;
    float w = 1.0;
    vec3 sum = vec3( 0.0 );
    for ( int i = 0; i < RAY_STEPS; i ++ ) {
      uv += dir;
      sum += texture2D( tSrc, uv ).rgb * w;
      w *= uDecay;
    }
    gl_FragColor = vec4( sum / float( RAY_STEPS ), 1.0 );
  }
`;

/* ═══════════════════════════════════════════════════════════════════════════
   TAA — накопление по кадрам с перепроецированием

   Обычное накопление здесь бесполезно: мир непрерывно вращается, и без
   поправки история размажется. Но вращение — жёсткий поворот вокруг оси Z,
   и его можно точно отменить: точка, которая сейчас в P, кадр назад была в
   Rz(−Δ)·P. По ней и берётся история.

   Отбраковка по соседям гасит остальное: всё, что подвинулось иначе
   (машины, лифт, качающиеся кроны), выпадает за диапазон окружающих
   пикселей и заменяется текущим кадром. Ветер при TAA приглушается — иначе
   лес тянется шлейфом.
   ═══════════════════════════════════════════════════════════════════════════ */
const TAA_FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tCur, tHist, tDepth;
  uniform mat4 uInvVP, uPrevVP;
  uniform float uBlend, uClamp, uHasHist;
  uniform vec2 uRes;

  void main() {
    vec3 cur = texture2D( tCur, vUv ).rgb;
    float d = texture2D( tDepth, vUv ).x;

    /* окно соседей: по нему отбраковывается устаревшая история */
    vec3 lo = cur, hi = cur;
    for ( int y = -1; y <= 1; y ++ ) {
      for ( int x = -1; x <= 1; x ++ ) {
        vec3 c = texture2D( tCur, vUv + vec2( float( x ), float( y ) ) / uRes ).rgb;
        lo = min( lo, c ); hi = max( hi, c );
      }
    }
    vec3 mid = ( lo + hi ) * 0.5;
    lo = mid + ( lo - mid ) * uClamp;
    hi = mid + ( hi - mid ) * uClamp;

    /* где этот пиксель был кадр назад */
    vec4 w = uInvVP * vec4( vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );
    vec4 pc = uPrevVP * vec4( w.xyz / w.w, 1.0 );
    vec2 hUv = ( pc.xy / pc.w ) * 0.5 + 0.5;

    float valid = uHasHist
      * step( 0.0, hUv.x ) * step( hUv.x, 1.0 )
      * step( 0.0, hUv.y ) * step( hUv.y, 1.0 );
    vec3 hist = clamp( texture2D( tHist, hUv ).rgb, lo, hi );
    gl_FragColor = vec4( mix( cur, hist, uBlend * valid ), 1.0 );
  }
`;

/* ═══════════════════════════════════════════════════════════════════════════
   SMAA — три прохода по референсной реализации

   Кромки → веса → смешивание. Второй проход и есть весь смысл алгоритма: по
   двум таблицам он узнаёт, какую долю пикселя закрасить при данной паре длин
   соседних кромок. Без таблиц это выродилось бы в MLAA, который проигрывает
   даже FXAA.

   Работает по ЭКРАННЫМ значениям, как и FXAA: контраст яркости по линейному
   HDR считается неверно. Поэтому перед SMAA кадр тонмаппится в отдельный
   буфер, а после — просто выводится.
   ═══════════════════════════════════════════════════════════════════════════ */
let smaaOn = false, smaaRT = [], smaaMat = [], smaaTex = [];

function loadLut(src, format) {
  const tx = new THREE.Texture();
  const img = new Image();
  img.onload = () => { tx.image = img; tx.needsUpdate = true; };
  img.src = src;
  tx.minFilter = THREE.LinearFilter;
  tx.magFilter = THREE.LinearFilter;
  tx.generateMipmaps = false;
  tx.flipY = false;
  if (format) tx.format = format;
  return tx;
}

let fxOn = false, fxRT = null, fxMat = null, fxQuad = null, fxScene = null, fxCam = null;
let taaMat = null, taaRT = [], taaIdx = 0, taaHas = 0;
const prevVP = new THREE.Matrix4(), curVP = new THREE.Matrix4();
const deltaRot = new THREE.Matrix4(), cleanVP = new THREE.Matrix4();
let prevRot = 0, taaFrame = 0;
let glowOn = false, raysOn = false;
let brRT = null, blRT = null, rayRT = null;
let brMat = null, blurMat = null, rayMat = null;
const sunUV = new THREE.Vector2(0.5, 0.5);
let sunVisible = false;

/** Свечение, лучи и любое сглаживание, кроме «выкл», живут на одном буфере.
    Без режима и без эффектов буфер не создаётся вовсе — прямой рендер в канвас. */
export function setPost(renderer, { mode = null, glow = false, rays = false } = {}) {
  glowOn = !!glow; raysOn = !!rays;
  aaMode = mode;
  samples = mode ? mode.samples : 0;
  /* FXAA может идти и сам по себе, и поверх SMAA — фильтр правит то,
     что осталось после сглаживания кромок */
  /* Части фильтра независимы и складываются: имя режима — просто их набор */
  const f = mode ? mode.filter : '';
  fxaaFilter = f.includes('fxaa');
  taaOn = f.includes('taa');
  smaaOn = f.includes('smaa');
  setFxaa(renderer, !!mode || glowOn || raysOn, fxaaFilter);
}

let fxaaFilter = false, aaMode = null, samples = 0, taaOn = false;

export function setFxaa(renderer, on, filter = true) {
  fxOn = !!on;
  fxaaFilter = filter;
  if (!fxOn) { disposeFxaa(); return; }
  if (fxMat) { resizePost(renderer); return; }
  fxCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  fxScene = new THREE.Scene();
  fxMat = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FXAA_FRAG,
    uniforms: {
      tScene: { value: null }, tGlow: { value: null }, tRays: { value: null },
      uRes: { value: new THREE.Vector2(1, 1) },
      uExposure: { value: 1 }, uGlow: { value: 0 }, uRays: { value: 0 },
      uFxaa: { value: 1 }
    }
  });
  const P = CONFIG.POST;
  brMat = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: BRIGHT_FRAG,
    uniforms: { tScene: { value: null }, uThreshold: { value: P.threshold }, uExposure: { value: 1 } }
  });
  blurMat = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: BLUR_FRAG,
    uniforms: { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } }
  });
  rayMat = new THREE.ShaderMaterial({
    defines: { RAY_STEPS: P.raySteps },
    vertexShader: VERT, fragmentShader: RAYS_FRAG,
    uniforms: {
      tSrc: { value: null }, uSun: { value: sunUV },
      uDensity: { value: P.rayDensity }, uDecay: { value: P.rayDecay }
    }
  });

  fxQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), fxMat);
  fxQuad.frustumCulled = false;
  fxScene.add(fxQuad);
  resizePost(renderer);
}

/** Экранное положение оси станции: лучи расходятся от неё, а не от точки */
const _sunF = new THREE.Vector3();
const _sunP = new THREE.Vector3(), _sunAxis = new THREE.Vector3();
const _sunU = new THREE.Vector3(), _sunV = new THREE.Vector3();
const _sunScreen = new THREE.Vector3();
let ambientShare = 0.22, hullAlbedo = null, traceWorldRot = 0;

/** Альбедо корпуса и текущий поворот мира: по ним трассировка находит,
    что отражается в воде, без всякого экранного пространства. */
export function setHullRef(tex2, rot) { hullAlbedo = tex2; traceWorldRot = rot; }

/** Доля рассеянного света: столько остаётся в тени от осевого источника */
export function setAmbientShare(v) { ambientShare = v; }
export function setSunScreen(camera, worldGroup) {
  /* Векторы переиспользуются: функция зовётся каждый кадр, и два новых
     объекта на кадр — это 120 штук в секунду в сборщик мусора. Именно такие
     мелочи и дают рывки при вращении камеры. */
  const f = _sunF;
  camera.getWorldDirection(f);
  const p = camera.position;
  /* ось — прямая x=y=0; ближайшая к лучу взгляда точка по z */
  const denom = 1 - f.z * f.z;
  const zAxis = denom < 1e-4 ? p.z + Math.sign(f.z || 1) * 100
    : p.z + f.z * (-(p.x * f.x + p.y * f.y)) / denom;
  const v = _sunScreen.set(0, 0, THREE.MathUtils.clamp(zAxis, -CONFIG.L / 2, CONFIG.L / 2));
  v.project(camera);
  sunVisible = v.z < 1 && Math.abs(v.x) < 2.5 && Math.abs(v.y) < 2.5;
  sunUV.set(v.x * 0.5 + 0.5, v.y * 0.5 + 0.5);
}

function disposeFxaa() {
  for (const t of [fxRT, brRT, blRT, rayRT, ...taaRT, ...smaaRT]) t?.dispose();
  for (const mm of smaaMat) mm.dispose();
  for (const tx of smaaTex) tx.dispose();
  smaaMat = []; smaaTex = []; smaaRT = [];
  fxRT?.depthTexture?.dispose();
  taaMat?.dispose(); taaMat = null; taaRT = []; taaHas = 0;
  for (const m of [fxMat, brMat, blurMat, rayMat]) m?.dispose();
  fxQuad?.geometry.dispose();
  fxRT = brRT = blRT = rayRT = null;
  fxMat = brMat = blurMat = rayMat = fxQuad = fxScene = fxCam = null;
}

export function resizePost(renderer) {
  if (!fxOn || !fxMat) return;
  const s = new THREE.Vector2();
  renderer.getDrawingBufferSize(s);
  const hw = Math.max(1, Math.round(s.x / CONFIG.POST.div));
  const hh = Math.max(1, Math.round(s.y / CONFIG.POST.div));
  const half = () => new THREE.WebGLRenderTarget(hw, hh, {
    type: THREE.HalfFloatType, depthBuffer: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter
  });
  for (const t of [brRT, blRT, rayRT]) t?.dispose();
  /* Свечение и лучи считаются в половинном разрешении: размытое всё равно
     не несёт мелких деталей, а стоит вчетверо дешевле. */
  brRT = half(); blRT = half(); rayRT = half();
  fxMat.uniforms.tGlow.value = brRT.texture;
  fxMat.uniforms.tRays.value = rayRT.texture;
  fxRT?.dispose();
  /* MSAA берётся отсюда: у канваса он задаётся при создании рендерера и на
     лету не выключается, а «выкл» обязан выключать всё. TAA перепроецирует
     историю и требует глубину; с многосэмпловым буфером глубина доступна не
     везде, но TAA и MSAA в одном режиме и не встречаются. */
  const depth = taaOn ? new THREE.DepthTexture(s.x, s.y) : null;
  if (depth) { depth.format = THREE.DepthFormat; depth.type = THREE.UnsignedIntType; }
  fxRT = new THREE.WebGLRenderTarget(s.x, s.y, {
    type: THREE.HalfFloatType, depthBuffer: true,
    samples: taaOn ? 0 : samples,
    depthTexture: depth || undefined,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter
  });
  fxMat.uniforms.uRes.value.set(s.x, s.y);

  /* SMAA: три прохода, каждому нужен свой буфер. Первый принимает уже
     тонмаппенный кадр — по линейному HDR контраст яркости считается неверно. */
  for (const t of smaaRT) t?.dispose();
  smaaRT = [];
  if (smaaOn) {
    const ldr = () => new THREE.WebGLRenderTarget(s.x, s.y, {
      depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter
    });
    smaaRT = [ldr(), ldr(), ldr()];        // тонмаппенный кадр, кромки, веса
    if (!smaaMat.length) {
      smaaTex = [
        loadLut(SMAA_AREA),
        loadLut(SMAA_SEARCH, THREE.RGBAFormat)
      ];
      smaaTex[1].minFilter = THREE.NearestFilter;
      smaaTex[1].magFilter = THREE.NearestFilter;
      const mk = (vert, frag, uniforms, defines) => new THREE.ShaderMaterial({
        defines: defines || {}, vertexShader: vert, fragmentShader: frag, uniforms
      });
      smaaMat = [
        mk(SMAA_EDGES_VERT, SMAA_EDGES_FRAG, {
          tDiffuse: { value: null }, resolution: { value: new THREE.Vector2() }
        }, SMAA_EDGES_DEFINES),
        mk(SMAA_WEIGHTS_VERT, SMAA_WEIGHTS_FRAG, {
          tDiffuse: { value: null }, tArea: { value: smaaTex[0] },
          tSearch: { value: smaaTex[1] }, resolution: { value: new THREE.Vector2() }
        }, SMAA_WEIGHTS_DEFINES),
        mk(SMAA_BLEND_VERT, SMAA_BLEND_FRAG, {
          tDiffuse: { value: null }, tColor: { value: null },
          resolution: { value: new THREE.Vector2() }
        })
      ];
    }
    for (const mm of smaaMat) mm.uniforms.resolution.value.set(1 / s.x, 1 / s.y);
  }

  for (const t of taaRT) t?.dispose();
  taaRT = [];
  if (taaOn) {
    taaRT = [0, 1].map(() => new THREE.WebGLRenderTarget(s.x, s.y, {
      type: THREE.HalfFloatType, depthBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter
    }));
    taaMat = taaMat || new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: TAA_FRAG,
      uniforms: {
        tCur: { value: null }, tHist: { value: null }, tDepth: { value: null },
        uInvVP: { value: new THREE.Matrix4() }, uPrevVP: { value: new THREE.Matrix4() },
        uBlend: { value: CONFIG.TAA.blend }, uClamp: { value: CONFIG.TAA.clamp },
        uHasHist: { value: 0 }, uRes: { value: new THREE.Vector2() }
      }
    });
    taaMat.uniforms.tDepth.value = fxRT.depthTexture;
    taaMat.uniforms.uRes.value.set(s.x, s.y);
    taaHas = 0;
  }
}

/** Обычный кадр: напрямую или через FXAA */
export function renderFrame(renderer, scene, camera, worldRotZ = 0) {
  if (!fxOn || !fxRT) {
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
    return;
  }
  /* TAA берёт сглаживание ИЗ ДРОЖАНИЯ: без субпиксельного смещения он
     усредняет одинаковые кадры, лесенка стоит в тех же пикселях, и
     усреднять нечего. Смещение по Гальтону — не украшение, а весь смысл.

     Матрицу для перепроецирования снимаем ДО дрожания: искать историю по
     дрожащей матрице значит каждый кадр промахиваться на долю пикселя.
     Отбраковка по соседям такую историю отвергает, остаются сырые
     смещённые кадры — и картинка мелко трясётся. */
  if (taaOn && taaRT.length) {
    cleanVP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const w = renderer.domElement.width, h = renderer.domElement.height;
    taaFrame = (taaFrame + 1) % 8;
    camera.setViewOffset(w, h,
      halton(taaFrame + 1, 2) - 0.5, halton(taaFrame + 1, 3) - 0.5, w, h);
    camera.updateProjectionMatrix();
  }

  renderer.setRenderTarget(fxRT);
  renderer.render(scene, camera);

  let src = fxRT.texture;
  if (taaOn && taaRT.length) {
    src = runTaa(renderer, camera, worldRotZ);
    camera.clearViewOffset();
  }
  composite(renderer, src, renderer.toneMappingExposure);
}

/** Накопление с перепроецированием. worldRot — текущий поворот мира вокруг Z:
    им отменяется вращение станции, иначе история уезжает вместе с ней. */
function runTaa(renderer, camera, worldRot) {
  const cur = taaRT[taaIdx], hist = taaRT[1 - taaIdx];
  curVP.copy(cleanVP);                    // без дрожания

  taaMat.uniforms.tCur.value = fxRT.texture;
  taaMat.uniforms.tHist.value = hist.texture;
  taaMat.uniforms.uInvVP.value.copy(curVP).invert();
  /* прошлый кадр = прошлая камера × поворот мира назад на Δ */
  deltaRot.makeRotationZ(prevRot - worldRot);
  taaMat.uniforms.uPrevVP.value.multiplyMatrices(prevVP, deltaRot);
  taaMat.uniforms.uHasHist.value = taaHas;

  fxQuad.material = taaMat;
  renderer.setRenderTarget(cur);
  renderer.render(fxScene, fxCam);

  prevVP.copy(curVP);
  prevRot = worldRot;
  taaHas = 1;
  taaIdx = 1 - taaIdx;
  return cur.texture;
}

/** Свечение, лучи, тонмаппинг и FXAA поверх готового HDR-кадра.
    Общий для обычного вывода и для накопленного кадра трассировки: раньше
    трассировка шла мимо постобработки, и включение лучей ГАСИЛО свечение
    и лучи от оси — картинка «переставала меняться». */
export function composite(renderer, srcTexture, exposure) {
  if (!fxMat) { return false; }
  const P = CONFIG.POST;
  const pass = (mat, target) => {
    fxQuad.material = mat;
    renderer.setRenderTarget(target);
    renderer.render(fxScene, fxCam);
  };
  fxMat.uniforms.tScene.value = srcTexture;

  if (glowOn || raysOn) {
    /* яркая выборка — общая для свечения и лучей */
    brMat.uniforms.tScene.value = srcTexture;
    brMat.uniforms.uExposure.value = exposure;
    pass(brMat, blRT);

    if (raysOn) {
      rayMat.uniforms.tSrc.value = blRT.texture;
      pass(rayMat, rayRT);
    }
    if (glowOn) {
      /* разделимое размытие: два прохода вместо квадрата выборок */
      const w = blRT.width, h = blRT.height;
      blurMat.uniforms.tSrc.value = blRT.texture;
      blurMat.uniforms.uDir.value.set(P.radius / w, 0);
      pass(blurMat, brRT);
      blurMat.uniforms.tSrc.value = brRT.texture;
      blurMat.uniforms.uDir.value.set(0, P.radius / h);
      pass(blurMat, blRT);
    }
  }

  fxMat.uniforms.tGlow.value = glowOn ? blRT.texture : null;
  fxMat.uniforms.uGlow.value = glowOn ? P.glow : 0;
  fxMat.uniforms.uRays.value = raysOn && sunVisible ? P.rays : 0;
  fxMat.uniforms.uExposure.value = exposure;
  fxMat.uniforms.uFxaa.value = fxaaFilter ? 1 : 0;

  if (smaaOn && smaaRT.length) {
    /* тонмаппим в буфер, сглаживаем экранные значения, выводим */
    pass(fxMat, smaaRT[0]);
    smaaMat[0].uniforms.tDiffuse.value = smaaRT[0].texture;
    pass(smaaMat[0], smaaRT[1]);
    smaaMat[1].uniforms.tDiffuse.value = smaaRT[1].texture;
    pass(smaaMat[1], smaaRT[2]);
    smaaMat[2].uniforms.tDiffuse.value = smaaRT[2].texture;
    smaaMat[2].uniforms.tColor.value = smaaRT[0].texture;
    pass(smaaMat[2], null);
    return true;
  }

  pass(fxMat, null);
  return true;
}

function showAccum(rt) {
  if (composite(R, rt.texture, R.toneMappingExposure)) return;
  /* без цепочки постобработки — свой минимальный вывод */
  showMat.uniforms.tAccum.value = rt.texture;
  showMat.uniforms.uExposure.value = R.toneMappingExposure;
  quad.material = showMat;
  R.setRenderTarget(null);
  R.render(qScene, qCam);
}

export function stopTrace(windUniform) {
  if (!trace.active) return;
  trace.active = false;
  if (windUniform) windUniform.value = savedWind;
  C?.clearViewOffset();
  R?.setRenderTarget(null);
  restoreTransparent();
  if (S) S.overrideMaterial = null;
  dispose();
  R = S = C = null;
}
