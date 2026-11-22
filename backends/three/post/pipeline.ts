/* The post chain of the WebGPU raster path — three r187 RenderPipeline.

   Same order as the classic chain (js/photo.js renderFrame/composite):

     scene pass (HDR half-float, MSAA 0/2/4/8, resolution scale = ssaa·fsr)
       └ TAA (TRAA, velocity MRT)                       linear HDR, render res
     → upscale: EASU-port + sharpen-port (fsr < 1)   |  box downsample (ssaa > 1)
     → bright pass (½ res) → glow (bloom() or classic blur) + axis rays (½ res)
     → composite: base·exposure + glow·glow/k + rays·rays/k → ACES → sRGB
     → SMAA → FXAA (display-referred, like the classic SMAAPass/FXAA)

   The pipeline does its own tone mapping and sRGB (outputColorTransform =
   false), so renderer.toneMapping / toneMappingExposure are ignored; use
   setExposure(). compositeExternal() swaps the scene pass for an HDR texture
   node (the WebGPU path tracer later) and keeps everything after it.

   Works on WebGPU and on the WebGL2 fallback (forceWebGL). */
import * as THREE from 'three/webgpu';
import {
  pass, mrt, output, velocity, normalView, roughness, uniform, vec2, vec3, vec4, float, uv, rtt, Fn
} from 'three/tsl';
import { denoise } from 'three/addons/tsl/display/DenoiseNode.js';
import { screenRays } from './screenRays.ts';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fsr1 } from 'three/addons/tsl/display/FSR1Node.js';
import {
  type PostOptions, aaParts, bloomRadiusOf, BLOOM_MIP_SUM, defaultPostOptions, renderScaleOf,
  scaleRegime, sharpenFor, STRUCTURAL
} from './options.ts';
import { ScaledTRAANode } from './taa.ts';
import { easu } from './fsrEasu.ts';
import { rcas } from './rcas.ts';
import { axisRays, brightPass, glowBlur } from './axisRays.ts';
import { toScreen } from './tonemap.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TslNode = any;

export type { PostOptions } from './options.ts';

/** Max taps per axis of the SSAA box downsample (scale ≤ SSAA_MAX · SHOT.max). */
const SSAA_MAX_TAPS = 4;
/** Render-target options of the intermediate half-res buffers. */
const HALF_RT = { depthBuffer: false, type: THREE.HalfFloatType };

export interface PipelineInfo {
  /** Active stages in order, e.g. ['scene msaa4 ×1.00', 'traa', 'easu', 'rcas', 'bloom', 'rays', 'smaa', 'fxaa']. */
  stages: string[];
  renderScale: number;
  external: boolean;
}

export interface PostPipeline {
  readonly renderPipeline: THREE.RenderPipeline;
  readonly options: Readonly<PostOptions>;
  /** Render one frame to the current render target (canvas by default).
      three advances its node frame (the once-per-frame updates of every
      pass / effect node) only from its own rAF loop. Inside a
      setAnimationLoop callback call render(); for several frames within one
      task (screenshots, accumulation, tests) call render(true) — otherwise
      the passes are NOT re-run and only the final quad is redrawn. */
  render(advanceFrame?: boolean): void;
  /** Size of the canvas in CSS px and its pixel ratio (sets the renderer). */
  setSize(width: number, height: number, dpr: number): void;
  /** Change options; structural ones rebuild the graph, the rest are uniforms. */
  setOptions(partial: Partial<PostOptions>): void;
  /** Axis "sun" in GL UV (origin bottom-left = NDC·0.5+0.5, as classic setSunScreen). */
  setSunScreen(uvGl: { x: number; y: number }, visible: boolean): void;
  setExposure(exposure: number): void;
  /** Replace the scene pass by an HDR texture node (path tracer), null = back to the scene. */
  compositeExternal(hdrTextureNode: TslNode | null, exposure?: number): void;
  describe(): PipelineInfo;
  dispose(): void;
}

interface Disposable { dispose(): void }

/** Bump three's node frame (what its rAF loop does once per tick). */
function advanceNodeFrame(renderer: THREE.WebGPURenderer): void {
  const r = renderer as unknown as { _nodes?: { nodeFrame?: { update(): void; frameId: number } }; info: { frame: number } };
  const nf = r._nodes?.nodeFrame;
  if (!nf) return;
  nf.update();
  r.info.frame = nf.frameId;
}

export function createRenderPipeline(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera,
  opts: Partial<PostOptions> = {}): PostPipeline {
  let o: PostOptions = { ...defaultPostOptions(), ...opts };
  const rp = new THREE.RenderPipeline(renderer);
  rp.outputColorTransform = false;

  /* uniforms survive graph rebuilds */
  const U = {
    exposure: uniform(o.exposure),
    clean: uniform(o.traceClean),
    threshold: uniform(0),
    glowW: uniform(0),
    raysW: uniform(0),
    sun: uniform(new THREE.Vector2(0.5, 0.5)),
    density: uniform(o.rayDensity),
    decay: uniform(o.rayDecay),
    radius: uniform(o.radius),
    bloomRadius: uniform(0),
    bloomStrength: uniform(1 / BLOOM_MIP_SUM),
    sharpen: uniform(0),
    invOut: uniform(new THREE.Vector2(1, 1))
  };
  let sunVisible = false;
  let external: TslNode | null = null;
  let owned: Disposable[] = [];
  let scenePass: TslNode | null = null;
  let traaNode: ScaledTRAANode | null = null;
  let info: PipelineInfo = { stages: [], renderScale: 1, external: false };
  let builtKey = '';
  const size = new THREE.Vector2();

  const keep = <T extends Disposable>(n: T): T => { owned.push(n); return n; };

  function syncUniforms(): void {
    const k = o.brightScale > 0 ? o.brightScale : 1;
    U.exposure.value = o.exposure;
    U.clean.value = o.traceClean;
    U.threshold.value = o.threshold * k;
    U.glowW.value = o.bloom ? o.glow / k : 0;
    U.raysW.value = o.rays && sunVisible ? o.rayStrength / k : 0;
    U.density.value = o.rayDensity;
    U.decay.value = o.rayDecay;
    U.radius.value = o.radius;
    U.bloomRadius.value = bloomRadiusOf(o);
    const frac = Math.min(1, o.fsr > 0 ? o.fsr : 1);
    U.sharpen.value = o.sharpen ?? sharpenFor(frac);
    const s = external ? 1 : renderScaleOf(o);
    scenePass?.setResolutionScale(s);
    if (traaNode) traaNode.renderScale = s;
  }

  const structuralKey = (): string =>
    STRUCTURAL.map(k => String(o[k])).join('|') + '|' + scaleRegime(o) + '|' + (external ? 'ext' : 'scene');

  function disposeGraph(): void {
    for (const n of owned) n.dispose();
    owned = [];
    scenePass = null;
    traaNode = null;
  }

  function build(): void {
    disposeGraph();
    const parts = aaParts(o.aa);
    const regime = external ? (o.fsr < 0.999 ? 'up' : 'native') : scaleRegime(o);
    const scale = external ? 1 : renderScaleOf(o);
    const stages: string[] = [];

    /* ── source: HDR texture node at render resolution ─────────────────── */
    let src: TslNode;
    if (external) {
      src = external;
      stages.push('external');
    } else {
      const tracing = o.screenTrace >= 0;
      const samples = parts.taa || tracing ? 0 : o.msaa;
      scenePass = keep(pass(scene, camera, { samples }) as unknown as Disposable) as TslNode;
      scenePass.setResolutionScale(scale);
      stages.push(`scene msaa${samples} ×${scale.toFixed(2)}`);
      if (tracing) {
        scenePass.setMRT(mrt({ output, velocity, surface: vec4(normalView, roughness) }));
        src = screenRays(scenePass, camera as THREE.PerspectiveCamera, o.screenTrace, keep);
        stages.push('ssgi', 'ssr');
      } else {
        if (parts.taa) scenePass.setMRT(mrt({ output, velocity }));
        src = scenePass.getTextureNode('output');
      }
      if (parts.taa || tracing) {
        traaNode = keep(new ScaledTRAANode(src,
          scenePass.getTextureNode('depth'), scenePass.getTextureNode('velocity'), camera));
        traaNode.renderScale = scale;
        src = traaNode.getTextureNode();
        stages.push('traa');
      }
      if (tracing) {
        // Keep the same temporal history when the user pauses for guided cleanup.
        const filtered = keep(denoise(src, scenePass.getTextureNode('depth'), scenePass.getTextureNode('surface'), camera));
        src = keep(rtt(U.clean.select(filtered, src)));
      }
    }

    /* ── base(uv): HDR at output resolution ────────────────────────────── */
    let baseAt: (uvN: TslNode) => TslNode;
    if (regime === 'up') {
      if (o.fsrImpl === 'three') {
        const f = keep(fsr1(src) as unknown as Disposable) as TslNode;
        const ft = f.getTextureNode();
        baseAt = (uvN) => ft.sample(uvN).rgb;
        stages.push('fsr1(three)');
      } else {
        const up = keep(rtt(Fn(() => vec4(easu(src, uv()), 1.0))(), null, null, { depthBuffer: false }) as unknown as Disposable) as TslNode;
        baseAt = (uvN) => rcas(up, U.sharpen, uvN);
        stages.push('easu', 'rcas');
      }
    } else if (regime === 'down') {
      const n = Math.min(SSAA_MAX_TAPS, Math.max(2, Math.ceil(scale)));
      baseAt = (uvN) => {
        let acc: TslNode = vec3(0.0);
        for (let j = 0; j < n; j++) {
          for (let i = 0; i < n; i++) {
            const off = vec2((i + 0.5) / n - 0.5, (j + 0.5) / n - 0.5).mul(U.invOut);
            acc = acc.add(src.sample(uvN.add(off)).rgb);
          }
        }
        return acc.div(n * n);
      };
      stages.push(`ssaa-down ${n}×${n}`);
    } else {
      baseAt = (uvN) => src.sample(uvN).rgb;
    }
    const exposedAt = (uvN: TslNode): TslNode => baseAt(uvN).mul(U.exposure);

    /* ── bright pass, glow, rays (½ res) ───────────────────────────────── */
    const fraction = 1 / Math.max(1, o.div);
    let glowTex: TslNode | null = null;
    let raysTex: TslNode | null = null;
    let bright: TslNode | null = null;
    const needBright = o.rays || (o.bloom && o.bloomImpl === 'classic');
    if (needBright) {
      bright = keep(rtt(Fn(() => vec4(brightPass(exposedAt(uv()), U.threshold), 1.0))(), null, null,
        { ...HALF_RT, resolutionScale: fraction }) as unknown as Disposable) as TslNode;
      stages.push('bright');
    }
    if (o.bloom) {
      if (o.bloomImpl === 'classic') {
        const h = keep(rtt(Fn(() => vec4(glowBlur(bright, vec2(U.radius, 0.0).div(vec2(bright.size()))), 1.0))(),
          null, null, { ...HALF_RT, resolutionScale: fraction }) as unknown as Disposable) as TslNode;
        glowTex = keep(rtt(Fn(() => vec4(glowBlur(h, vec2(0.0, U.radius).div(vec2(h.size()))), 1.0))(),
          null, null, { ...HALF_RT, resolutionScale: fraction }) as unknown as Disposable) as TslNode;
        stages.push('glow-blur(classic)');
      } else {
        const b = keep(bloom(Fn(() => vec4(exposedAt(uv()), 1.0))(), U.bloomStrength, U.bloomRadius, U.threshold) as unknown as Disposable) as TslNode;
        b.smoothWidth = U.threshold;          // smoothstep(t, 2t) like BRIGHT_FRAG
        b.setResolutionScale(fraction);
        glowTex = b.getTextureNode();
        stages.push('bloom(three)');
      }
    }
    if (o.rays) {
      raysTex = keep(rtt(Fn(() => vec4(axisRays(bright, U.sun, U.density, U.decay, o.raySteps), 1.0))(), null, null,
        { ...HALF_RT, resolutionScale: fraction }) as unknown as Disposable) as TslNode;
      stages.push('rays');
    }

    /* ── composite + tone map ──────────────────────────────────────────── */
    const tonemap = o.tonemap;
    const composite = Fn(() => {
      const hdr = exposedAt(uv()).toVar();
      if (glowTex) hdr.addAssign(glowTex.sample(uv()).rgb.mul(U.glowW));
      if (raysTex) hdr.addAssign(raysTex.sample(uv()).rgb.mul(U.raysW));
      return vec4(toScreen(hdr, tonemap), float(1.0));
    })();
    stages.push(`tonemap(${tonemap})`);

    /* ── edge filters on display-referred values ───────────────────────── */
    let out: TslNode = composite;
    if (parts.smaa) {
      const s = keep(smaa(out) as unknown as Disposable) as TslNode;
      /* SMAA's own convertToTexture made an RTT of the composite: own it too */
      if (s.textureNode?.isRTTNode) owned.push(s.textureNode);
      out = parts.fxaa ? s.getTextureNode() : s;
      stages.push('smaa');
    }
    if (parts.fxaa) {
      const f = fxaa(out) as TslNode;
      if (f.textureNode?.isRTTNode) owned.push(f.textureNode);
      out = f;
      stages.push('fxaa');
    }

    rp.outputNode = out;
    rp.needsUpdate = true;
    info = { stages, renderScale: scale, external: !!external };
    builtKey = structuralKey();
    syncUniforms();
  }

  function ensureBuilt(): void {
    if (structuralKey() !== builtKey) build();
  }

  build();

  return {
    renderPipeline: rp,
    get options() { return o; },
    render(advanceFrame = false) {
      ensureBuilt();
      if (advanceFrame) advanceNodeFrame(renderer);
      renderer.getDrawingBufferSize(size);
      U.invOut.value.set(1 / Math.max(1, size.x), 1 / Math.max(1, size.y));
      rp.render();
    },
    setSize(width, height, dpr) {
      renderer.setPixelRatio(dpr);
      renderer.setSize(width, height, false);
    },
    setOptions(partial) {
      o = { ...o, ...partial };
      if (structuralKey() !== builtKey) build();
      else syncUniforms();
    },
    setSunScreen(uvGl, visible) {
      /* GL UV (origin bottom-left) → TSL quad UV (origin top-left) */
      U.sun.value.set(uvGl.x, 1 - uvGl.y);
      sunVisible = visible;
      syncUniforms();
    },
    setExposure(exposure) {
      o = { ...o, exposure };
      U.exposure.value = exposure;
    },
    compositeExternal(hdrTextureNode, exposure) {
      external = hdrTextureNode;
      if (exposure !== undefined) { o = { ...o, exposure }; U.exposure.value = exposure; }
      build();
    },
    describe() { return { ...info, stages: [...info.stages] }; },
    dispose() {
      disposeGraph();
      rp.dispose();
    }
  };
}
