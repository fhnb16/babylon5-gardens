import * as THREE from 'three';
import { CONFIG } from './config.js';
import { SMAA_AREA, SMAA_SEARCH } from './smaa-lut.js';
import {
  SMAA_EDGES_VERT, SMAA_EDGES_FRAG,
  SMAA_WEIGHTS_VERT, SMAA_WEIGHTS_FRAG,
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

export const trace = { active: false, sample: 0, total: 0 };

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
  uniform float uRadius, uIntensity, uSeed, uBlend, uBias, uFogD, uBounce, uReflect, uRefStep;

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
        if ( pxR < 2.0 ) break;
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
        if ( dz > uBias && dz < uRadius * 2.0 ) {
          float w = 1.0 - smoothstep( uRadius, uRadius * 2.0, dz );
          occ += w;
          /* Луч не просто «загорожен» — он принёс свет с той поверхности.
             Это и есть переотражение: трава подкрашивает стену зелёным,
             ночная улица — тёплым. Тот же пучок лучей, лишняя выборка цвета. */
          bounce += texture2D( tBeauty, suv ).rgb * w;
        }
      }
      ao = 1.0 - clamp( occ / float( RAYS ) * uIntensity, 0.0, 1.0 );
      gi = bounce / float( RAYS ) * uBounce;

      /* ─── Отражения ───
         Гладкие поверхности (вода, стекло, металл) отражают. Направление
         считается точно, а вот попадание ищется маршем по буферу глубины:
         шаг растёт, потому что вдали точность всё равно не нужна. Френель
         даёт то, что видно в жизни: под острым углом отражает всё. */
      float smoothness = 1.0 - rough;
      if ( smoothness > 0.25 ) {
        vec3 V = normalize( P );
        vec3 Rd = reflect( V, N );
        vec3 pos = P;
        float st = uRefStep * ( 0.6 + 0.8 * hash( vec3( vUv * uRes, uSeed ) ) );
        for ( int i = 0; i < REF_STEPS; i ++ ) {
          pos += Rd * st;
          vec4 rp = uProj * vec4( pos, 1.0 );
          vec2 ruv = ( rp.xy / rp.w ) * 0.5 + 0.5;
          if ( ruv.x < 0.0 || ruv.x > 1.0 || ruv.y < 0.0 || ruv.y > 1.0 ) break;
          float rd = texture2D( tDepth, ruv ).x;
          if ( rd < 1.0 ) {
            vec3 hp = viewPos( ruv, rd );
            float gap = hp.z - pos.z;
            if ( gap > 0.0 && gap < st * 2.0 ) {
              float fres = pow( 1.0 - max( 0.0, dot( -V, N ) ), 4.0 );
              /* к краю экрана отражение обрывается — гасим, чтобы не резало */
              vec2 e = abs( ruv - 0.5 ) * 2.0;
              float edge = 1.0 - max( e.x, e.y );
              refl = texture2D( tBeauty, ruv ).rgb * smoothness
                   * ( 0.05 + 0.95 * fres ) * uReflect * smoothstep( 0.0, 0.2, edge );
              break;
            }
          }
          st *= 1.35;
        }
      }

      /* Затенение — местный эффект. На дальнем плане цвет уже определяется
         туманом, и умножать его на AO нельзя: картинка сереет и теряет
         контраст. Гасим ровно тем же законом, что и туман сцены. */
      float fogAmt = exp( - ( length( P ) * uFogD ) * ( length( P ) * uFogD ) );
      ao = mix( 1.0, ao, fogAmt );
      gi *= fogAmt;
      refl *= fogAmt;
    }

    /* Отражённый свет красится в цвет самой поверхности — так и работает
       диффузное переотражение. Зеркальная составляющая добавляется поверх. */
    vec3 cur = col * ao + col * gi + refl;
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
    defines: { RAYS: P.rays, REF_STEPS: P.refSteps },
    vertexShader: VERT, fragmentShader: AO_FRAG,
    uniforms: {
      tBeauty: { value: rtBeauty.texture }, tNormal: { value: rtNormal.texture },
      tDepth: { value: rtNormal.depthTexture }, tPrev: { value: accum[1].texture },
      uProj: { value: new THREE.Matrix4() }, uProjInv: { value: new THREE.Matrix4() },
      uRes: { value: new THREE.Vector2(size.x, size.y) },
      uRadius: { value: P.radius }, uIntensity: { value: P.intensity },
      uBias: { value: P.bias }, uSeed: { value: 0 }, uBlend: { value: 1 },
      uFogD: { value: 0 }, uBounce: { value: P.bounce },
      uReflect: { value: P.reflect }, uRefStep: { value: P.refStep }
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

  /* трассировка затенения и накопление */
  const src = accum[n % 2 === 0 ? 1 : 0], dst = accum[n % 2 === 0 ? 0 : 1];
  aoMat.uniforms.tPrev.value = src.texture;
  aoMat.uniforms.uProj.value.copy(C.projectionMatrix);
  aoMat.uniforms.uProjInv.value.copy(C.projectionMatrixInverse);
  aoMat.uniforms.uSeed.value = n * 7.31;
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
const deltaRot = new THREE.Matrix4();
let prevRot = 0;
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
  fxaaFilter = !!mode && mode.filter === 'fxaa';
  taaOn = !!mode && mode.filter === 'taa';
  smaaOn = !!mode && mode.filter === 'smaa';
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
export function setSunScreen(camera, worldGroup) {
  /* Берём точку на оси, ближайшую к направлению взгляда */
  const f = new THREE.Vector3();
  camera.getWorldDirection(f);
  const p = camera.position;
  /* ось — прямая x=y=0; ближайшая к лучу взгляда точка по z */
  const denom = 1 - f.z * f.z;
  const zAxis = denom < 1e-4 ? p.z + Math.sign(f.z || 1) * 100
    : p.z + f.z * (-(p.x * f.x + p.y * f.y)) / denom;
  const v = new THREE.Vector3(0, 0, THREE.MathUtils.clamp(zAxis, -CONFIG.L / 2, CONFIG.L / 2));
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
      const mk = (vert, frag, uniforms) => new THREE.ShaderMaterial({
        vertexShader: vert, fragmentShader: frag, uniforms
      });
      smaaMat = [
        mk(SMAA_EDGES_VERT, SMAA_EDGES_FRAG, {
          tDiffuse: { value: null }, resolution: { value: new THREE.Vector2() }
        }),
        mk(SMAA_WEIGHTS_VERT, SMAA_WEIGHTS_FRAG, {
          tDiffuse: { value: null }, tArea: { value: smaaTex[0] },
          tSearch: { value: smaaTex[1] }, resolution: { value: new THREE.Vector2() }
        }),
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
  renderer.setRenderTarget(fxRT);
  renderer.render(scene, camera);

  let src = fxRT.texture;
  if (taaOn && taaRT.length) src = runTaa(renderer, camera, worldRotZ);
  composite(renderer, src, renderer.toneMappingExposure);
}

/** Накопление с перепроецированием. worldRot — текущий поворот мира вокруг Z:
    им отменяется вращение станции, иначе история уезжает вместе с ней. */
function runTaa(renderer, camera, worldRot) {
  const cur = taaRT[taaIdx], hist = taaRT[1 - taaIdx];
  curVP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

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
