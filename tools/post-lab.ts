/* Post lab — standalone bench of backends/three/post (see post-lab.html). */
import * as THREE from 'three/webgpu';
import {
  Fn, uv, vec3, float, sin, abs, smoothstep, texture, positionWorld, normalWorld, max, dot
} from 'three/tsl';
import { createRenderPipeline, type PostPipeline } from '../backends/three/post/pipeline.ts';
import { optionsFromParams, type PostOptions } from '../backends/three/post/options.ts';
import { axisSunScreen } from '../backends/three/post/axisRays.ts';
import { toScreenCpu, type TonemapId } from '../backends/three/post/tonemap.ts';

const q = new URLSearchParams(location.search);
const BACKEND = q.get('backend') === 'webgl' ? 'webgl' : 'webgpu';
let anim = q.get('anim') !== '0';
const HUD = q.get('hud') !== '0';
const hud = document.getElementById('hud') as HTMLDivElement;

/* test rig dimensions (station-like: an axis tube with a hull around it) */
const RIG = { tubeLen: 60, tubeR: 0.6, sunHdr: 2.6, hullR: 9, boxes: 24, spin: 0.15 };
const RAMP = { n: 256, max: 16 };

interface LabApi {
  ready: boolean;
  error?: string;
  errors: string[];
  backend: string;
  isWebGPU: boolean;
  stages: string[];
  setOptions(p: Partial<PostOptions>): string[];
  frames(n: number): Promise<void>;
  time(n: number): Promise<{ wallMs: number; gpuMs: number | null; gpuPasses: number; detail: string[] }>;
  probeRamp(tonemap: TonemapId, exposure: number, canvas?: boolean): Promise<{ maxErr: number; meanErr: number; worst: number[] }>;
  restoreScene(): void;
  setAnim(on: boolean): void;
  frameDiff(warm: number): Promise<number>;
}
declare global { interface Window { __postLab?: Partial<LabApi> } }

const api: Partial<LabApi> = { ready: false, errors: [], backend: BACKEND };
window.__postLab = api;
const errors = api.errors as string[];

function buildScene(): { scene: THREE.Scene; rig: THREE.Group; camera: THREE.PerspectiveCamera } {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05070a);
  const rig = new THREE.Group();
  scene.add(rig);

  /* the "sun": an HDR emissive tube along z (classic: toneMapped false, ×sunHdr) */
  const tubeMat = new THREE.MeshBasicNodeMaterial();
  tubeMat.colorNode = vec3(1.0, 0.97, 0.86).mul(RIG.sunHdr);
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(RIG.tubeR, RIG.tubeR, RIG.tubeLen, 48, 1, true), tubeMat);
  tube.rotation.x = Math.PI / 2;
  rig.add(tube);

  /* hull: BackSide cylinder with fine stripes (aliasing bait) lit by the axis */
  const hullMat = new THREE.MeshStandardNodeMaterial({ side: THREE.BackSide, roughness: 0.8 });
  hullMat.colorNode = Fn(() => {
    const u = uv();
    const stripes = smoothstep(0.35, 0.65, abs(sin(u.x.mul(900.0))));
    const rings = smoothstep(0.9, 0.97, abs(sin(u.y.mul(220.0))));
    return vec3(0.25, 0.42, 0.22).mul(float(0.6).add(stripes.mul(0.4))).add(vec3(0.5).mul(rings));
  })();
  /* axis light: brightness falls with distance from the axis, faces it */
  hullMat.emissiveNode = Fn(() => {
    const p = positionWorld;
    const toAxis = vec3(p.x.negate(), p.y.negate(), 0).normalize();
    return vec3(0.18, 0.2, 0.17).mul(max(dot(normalWorld, toAxis), 0.0));
  })();
  const hull = new THREE.Mesh(new THREE.CylinderGeometry(RIG.hullR, RIG.hullR, RIG.tubeLen, 96, 1, true), hullMat);
  hull.rotation.x = Math.PI / 2;
  rig.add(hull);

  /* hard-edged boxes around the inside + thin spokes (edges, sub-pixel detail) */
  const boxMat = new THREE.MeshStandardNodeMaterial({ color: 0xb8b0a0, roughness: 0.5, metalness: 0.1 });
  const winMat = new THREE.MeshBasicNodeMaterial();
  winMat.colorNode = vec3(1.0, 0.75, 0.4).mul(1.6);
  const spokeMat = new THREE.MeshStandardNodeMaterial({ color: 0x9aa4b0, roughness: 0.4, metalness: 0.6 });
  for (let i = 0; i < RIG.boxes; i++) {
    const a = (i / RIG.boxes) * Math.PI * 2;
    const z = -RIG.tubeLen / 2 + 4 + (i * 37 % 50);
    const r = RIG.hullR - 1.1;
    const b = new THREE.Mesh(new THREE.BoxGeometry(1.4, 2.2, 1.4), boxMat);
    b.position.set(Math.cos(a) * r, Math.sin(a) * r, z);
    b.rotation.z = a + Math.PI / 2;
    rig.add(b);
    const w = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 1.45), winMat);
    w.position.copy(b.position).multiplyScalar(0.93);
    w.rotation.z = a;
    rig.add(w);
    const s = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, RIG.hullR - RIG.tubeR, 6), spokeMat);
    s.position.set(Math.cos(a + 0.13) * (RIG.hullR + RIG.tubeR) / 2, Math.sin(a + 0.13) * (RIG.hullR + RIG.tubeR) / 2, z + 2);
    s.rotation.z = a + 0.13 - Math.PI / 2;
    rig.add(s);
  }
  scene.add(new THREE.HemisphereLight(0x8899aa, 0x223322, 0.6));
  const key = new THREE.PointLight(0xfff2dd, 120, 40, 1.4);
  key.position.set(0, 0, 8);
  scene.add(key);

  const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 200);
  camera.position.set(3.5, -6.2, 24);
  camera.lookAt(0, -1.5, -8);
  return { scene, rig, camera };
}

async function main(): Promise<void> {
  const renderer = new THREE.WebGPURenderer({
    antialias: false, forceWebGL: BACKEND === 'webgl',
    /* WebGL timer queries in three r187 nest badly with RTT passes inside a
       pipeline render ('a query is already active') — WebGPU only */
    trackTimestamp: BACKEND === 'webgpu'
  });
  /* r187 calls onError({ api, type, message }) for uncaptured GPU errors; @types says string */
  (renderer as unknown as { onError: (e: unknown) => void }).onError = (e: unknown) => {
    const o = (typeof e === 'object' && e) ? e as { api?: string; type?: string; message?: string } : { message: String(e) };
    errors.push(`${o.api ?? ''} ${o.type ?? ''}: ${o.message ?? ''}`);
  };
  document.body.appendChild(renderer.domElement);
  await renderer.init();
  const backend = renderer.backend as unknown as { isWebGPUBackend?: boolean; device?: GPUDevice; gl?: WebGL2RenderingContext };
  api.isWebGPU = !!backend.isWebGPUBackend;

  const { scene, rig, camera } = buildScene();
  const opts = optionsFromParams(q);
  const pp: PostPipeline = createRenderPipeline(renderer, scene, camera, opts);
  const resize = () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    pp.setSize(innerWidth, innerHeight, 1);
  };
  resize();
  addEventListener('resize', resize);

  const sun = { uv: new THREE.Vector2(), visible: false };
  let t = 0;
  const step = (dt: number, advance = true) => {
    if (anim) { t += dt; rig.rotation.z = t * RIG.spin; }
    axisSunScreen(camera, RIG.tubeLen / 2, sun);
    pp.setSunScreen(sun.uv, sun.visible);
    pp.render(advance);
  };
  const updateHud = () => {
    api.stages = pp.describe().stages;
    hud.textContent = HUD ? `${api.isWebGPU ? 'WebGPU' : 'WebGL2'}  ${api.stages.join(' → ')}` : '';
  };

  /* GPU-synchronous wait: queue drain on WebGPU, a 1-px readback on WebGL */
  const px = new Uint8Array(4);
  const gpuSync = async () => {
    if (backend.device) await backend.device.queue.onSubmittedWorkDone();
    else if (backend.gl) {
      /* read from the default framebuffer (the bound one may be MSAA);
         restore the READ binding so three's state cache stays valid */
      const gl = backend.gl;
      const prev = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prev);
    }
  };

  api.setOptions = (p) => { pp.setOptions(p); updateHud(); return pp.describe().stages; };
  api.frames = async (n) => {
    for (let i = 0; i < n; i++) {
      step(1 / 60);
      if (backend.device && i % 8 === 7) await backend.device.queue.onSubmittedWorkDone();
    }
    await gpuSync();
    updateHud();
  };
  /* Frame cost. wall: n frames back to back + a GPU drain, per frame (bounded
     by max(CPU, GPU), includes the scene). gpu: WebGPU timestamp queries,
     summed over every render context (pass): three's resolveTimestampsAsync()
     returns the last node-frame only, the per-uid map sees every pass. */
  const pool = () => (backend as unknown as { timestampQueryPool?: { render?: { timestamps?: Map<string, number> } } })
    .timestampQueryPool?.render;
  api.time = async (n) => {
    await api.frames!(4);
    const t0 = performance.now();
    for (let i = 0; i < n; i++) step(1 / 60);
    await gpuSync();
    const wall = (performance.now() - t0) / n;
    let gpu: number | null = null, passes = 0;
    const detail: string[] = [];
    const p = pool();
    if (backend.device && p) {
      try {
        /* every resolved pass goes through timestamps.set(uid, ms) exactly
           once (uids are unique per render call): accumulate there */
        await renderer.resolveTimestampsAsync('render');
        const acc = { sum: 0, n: 0 };
        const orig = p.timestamps;
        p.timestamps = new (class extends Map<string, number> {
          set(k: string, v: number) { acc.sum += v; acc.n++; return super.set(k, v); }
        })();
        const m = Math.max(1, Math.round(n / 4));
        for (let i = 0; i < m; i++) {
          step(1 / 60);
          if (i % 4 === 3) await renderer.resolveTimestampsAsync('render');
        }
        await gpuSync();
        for (let k = 0; k < 4; k++) await renderer.resolveTimestampsAsync('render');
        p.timestamps = orig;
        gpu = acc.n ? acc.sum / m : null;
        passes = Math.round(acc.n / m);
      } catch { gpu = null; }
    }
    return { wallMs: wall, gpuMs: gpu, gpuPasses: passes, detail };
  };

  /* Tone-map probe: a fixed HDR ramp through compositeExternal, read back. */
  api.probeRamp = async (tonemap, exposure, toCanvas = false) => {
    const N = RAMP.n;
    const data = new Uint16Array(N * 4);
    const vals: number[][] = [];
    for (let i = 0; i < N; i++) {
      const v = RAMP.max * Math.pow(i / (N - 1), 2);
      const rgb = [v, v * 0.55, v * 0.2];
      const h = rgb.map(c => THREE.DataUtils.toHalfFloat(c));
      vals.push(h.map(x => THREE.DataUtils.fromHalfFloat(x)));
      data.set([h[0], h[1], h[2], THREE.DataUtils.toHalfFloat(1)], i * 4);
    }
    const tex = new THREE.DataTexture(data, N, 1, THREE.RGBAFormat, THREE.HalfFloatType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    const prev = pp.options;
    pp.setOptions({ aa: 'none', bloom: false, rays: false, tonemap, fsr: 1, ssaa: 1 });
    pp.compositeExternal(texture(tex), exposure);
    let got: Uint8Array | Uint8ClampedArray;
    if (!toCanvas) {
      const rt = new THREE.RenderTarget(N, 1, { depthBuffer: false });
      renderer.setRenderTarget(rt);
      pp.render();
      renderer.setRenderTarget(null);
      got = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, N, 1) as Uint8Array;
      rt.dispose();
    } else {
      /* through the canvas: same task as the render, then a 2D readback */
      pp.render();
      const c2 = document.createElement('canvas');
      c2.width = renderer.domElement.width; c2.height = 1;
      const ctx = c2.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(renderer.domElement, 0, Math.floor(renderer.domElement.height / 2), c2.width, 1, 0, 0, c2.width, 1);
      const row = ctx.getImageData(0, 0, c2.width, 1).data;
      const stride = c2.width / N;
      got = new Uint8ClampedArray(N * 4);
      for (let i = 0; i < N; i++) {
        const x = Math.floor((i + 0.5) * stride);
        got.set(row.subarray(x * 4, x * 4 + 4), i * 4);
      }
    }
    let maxErr = 0, sum = 0, worst: number[] = [];
    for (let i = 0; i < N; i++) {
      const ref = toScreenCpu(vals[i], exposure);
      for (let c = 0; c < 3; c++) {
        const e = Math.abs(got[i * 4 + c] / 255 - ref[c]) * 255;
        sum += e;
        if (e > maxErr) { maxErr = e; worst = [i, c, got[i * 4 + c], ref[c] * 255]; }
      }
    }
    pp.compositeExternal(null, prev.exposure);
    pp.setOptions(prev);
    tex.dispose();
    updateHud();
    return { maxErr, meanErr: sum / (N * 3), worst };
  };
  api.restoreScene = () => { pp.compositeExternal(null); updateHud(); };
  api.setAnim = (on) => { anim = on; };
  /* Temporal stability: mean |Δ| (0..255, RGB) between two consecutive
     frames of a static scene after warm frames. With TAA the jitter must
     be absorbed by accepted history; a rejected history shows up as the raw
     jittered frame flickering at every edge. */
  const grab = (): Uint8ClampedArray => {
    const c = renderer.domElement;
    const c2 = document.createElement('canvas');
    c2.width = c.width; c2.height = c.height;
    const ctx = c2.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(c, 0, 0);
    return ctx.getImageData(0, 0, c2.width, c2.height).data;
  };
  api.frameDiff = async (warm) => {
    await api.frames!(warm);
    step(0);
    const a = grab();
    step(0);
    const b = grab();
    let s = 0;
    for (let i = 0; i < a.length; i += 4) {
      s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    }
    return s / (a.length / 4 * 3);
  };

  const warm = Math.max(1, Number(q.get('frames') ?? 3));
  await api.frames(warm);
  updateHud();
  api.ready = true;

  if (q.get('loop') === '1') {
    let last = performance.now();
    renderer.setAnimationLoop(() => {
      const now = performance.now();
      step((now - last) / 1000, false);
      last = now;
    });
  }
}

main().catch((e: unknown) => {
  api.error = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
  hud.textContent = api.error;
});
