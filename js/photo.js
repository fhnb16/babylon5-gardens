import * as THREE from 'three';
import { CONFIG } from './config.js';

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
    type: THREE.HalfFloatType, depthBuffer: true,
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
    quad.material = showMat;
    R.setRenderTarget(null);
    R.render(qScene, qCam);
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

  /* показать накопленное */
  showMat.uniforms.tAccum.value = dst.texture;
  showMat.uniforms.uExposure.value = R.toneMappingExposure;
  quad.material = showMat;
  R.setRenderTarget(null);
  R.render(qScene, qCam);

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
  uniform sampler2D tScene;
  uniform vec2 uRes;
  uniform float uExposure;
  ${TONEMAP_GLSL}

  vec3 fetch( vec2 uv ) { return toScreen( texture2D( tScene, uv ).rgb, uExposure ); }
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
    if ( lMax - lMin < max( 0.0312, lMax * 0.125 ) ) {
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

let fxOn = false, fxRT = null, fxMat = null, fxQuad = null, fxScene = null, fxCam = null;

export function setFxaa(renderer, on) {
  fxOn = !!on;
  if (!fxOn) { disposeFxaa(); return; }
  if (fxMat) { resizePost(renderer); return; }
  fxCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  fxScene = new THREE.Scene();
  fxMat = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FXAA_FRAG,
    uniforms: { tScene: { value: null }, uRes: { value: new THREE.Vector2(1, 1) },
                uExposure: { value: 1 } }
  });
  fxQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), fxMat);
  fxQuad.frustumCulled = false;
  fxScene.add(fxQuad);
  resizePost(renderer);
}

function disposeFxaa() {
  fxRT?.dispose(); fxMat?.dispose(); fxQuad?.geometry.dispose();
  fxRT = fxMat = fxQuad = fxScene = fxCam = null;
}

export function resizePost(renderer) {
  if (!fxOn || !fxMat) return;
  const s = new THREE.Vector2();
  renderer.getDrawingBufferSize(s);
  fxRT?.dispose();
  fxRT = new THREE.WebGLRenderTarget(s.x, s.y, {
    type: THREE.HalfFloatType, depthBuffer: true,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter
  });
  fxMat.uniforms.tScene.value = fxRT.texture;
  fxMat.uniforms.uRes.value.set(s.x, s.y);
}

/** Обычный кадр: напрямую или через FXAA */
export function renderFrame(renderer, scene, camera) {
  if (!fxOn || !fxRT) {
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
    return;
  }
  renderer.setRenderTarget(fxRT);
  renderer.render(scene, camera);
  fxMat.uniforms.uExposure.value = renderer.toneMappingExposure;
  renderer.setRenderTarget(null);
  renderer.render(fxScene, fxCam);
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
