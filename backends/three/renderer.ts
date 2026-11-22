/* ═══════════════════════════════════════════════════════════════════════════
   createRenderer({ mode }) — one factory for the three renderer flavours:

     'webgpu'  WebGPURenderer on a GPUDevice from pathtracer/device.ts
               createDevice({ forThree: true }) — the WGSL path tracer can later
               share it (docs/ROADMAP.md §2.8). If that device cannot be made
               (no adapter, limits too low for the tracer), three requests its
               own; if WebGPU is missing altogether, WebGPURenderer falls back
               to its WebGL2 backend (kind reports what actually runs).
     'webgl2'  WebGPURenderer({ forceWebGL: true }) — node materials on WebGL2.
     'classic' the classic WebGLRenderer (GLSL patches, js/photo.js post chain).

   Always `await`ed: WebGPURenderer needs `await renderer.init()` before
   anything reads its backend (capabilities, hasFeature, compileAsync).

   Import strategy (see README.md): 'three' (three.module.js) and
   'three/webgpu' (three.webgpu.js) both import ONE shared three.core.js, so
   every core class (Object3D, Mesh, BufferGeometry, Texture, Color, …) is the
   same class object whichever entry it is imported from. Only the renderers
   and the material flavours differ: WebGLRenderer exists only in 'three',
   WebGPURenderer and *NodeMaterial only in 'three/webgpu'. assertSingleThree()
   checks that at runtime (a bundler that duplicated three.core would break
   instanceof checks and the shared adapter).
   ═══════════════════════════════════════════════════════════════════════════ */

import * as THREE from 'three';
import * as WEBGPU from 'three/webgpu';
import { createDevice, describeDevice, type PtDevice } from '../../pathtracer/device.ts';

export type RendererMode = 'webgpu' | 'webgl2' | 'classic';
export const RENDERER_MODES: readonly RendererMode[] = ['webgpu', 'webgl2', 'classic'];

/** Parse a mode string (URL / prefs); null if not a mode. */
export function parseRendererMode(s: string | null | undefined): RendererMode | null {
  const v = (s || '').toLowerCase();
  return (RENDERER_MODES as readonly string[]).includes(v) ? v as RendererMode : null;
}

export type AnyRenderer = THREE.WebGLRenderer | WEBGPU.WebGPURenderer;

export interface RendererInfo {
  /** the mode asked for */
  requested: RendererMode;
  /** what runs: 'webgpu' | 'webgl2' (WebGPURenderer's WebGL2 backend) | 'classic' */
  kind: RendererMode;
  /** node materials (WebGPURenderer of either backend) vs classic GLSL */
  nodeMaterials: boolean;
  /** the WebGPU device came from pathtracer/device.ts (shareable with the tracer) */
  sharedDevice: boolean;
  /** why a fallback happened (empty if none) */
  fallback: string;
  /** adapter / device description (WebGPU) or WebGL renderer string */
  adapter: string;
  maxAnisotropy: number;
  /** MSAA samples of the canvas output (classic: antialias flag) */
  samples: number;
}

export interface B5Renderer {
  renderer: AnyRenderer;
  info: RendererInfo;
  /** the shared path-tracer device (webgpu + createDevice succeeded), else null */
  device: PtDevice | null;
  readonly kind: RendererMode;
  readonly isNode: boolean;
  dispose(): void;
}

export interface CreateRendererOptions {
  mode: RendererMode;
  canvas?: HTMLCanvasElement;
  /** MSAA on the canvas (classic: WebGLRenderer antialias; node: 4 samples) */
  antialias?: boolean;
  powerPreference?: GPUPowerPreference;
  /** skip pathtracer/device.ts and let three request its own device */
  ownDevice?: boolean;
}

/** Throws if 'three' and 'three/webgpu' resolved to different three.core instances. */
export function assertSingleThree(): void {
  const same = THREE.Object3D === WEBGPU.Object3D && THREE.Mesh === WEBGPU.Mesh &&
    THREE.BufferGeometry === WEBGPU.BufferGeometry && THREE.Texture === WEBGPU.Texture;
  if (!same) throw new Error('three: "three" and "three/webgpu" load different three.core instances');
}

function glAdapter(r: THREE.WebGLRenderer): string {
  const gl = r.getContext();
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
}

export async function createRenderer(o: CreateRendererOptions): Promise<B5Renderer> {
  assertSingleThree();
  const powerPreference = o.powerPreference ?? 'high-performance';

  if (o.mode === 'classic') {
    const r = new THREE.WebGLRenderer({
      canvas: o.canvas, antialias: !!o.antialias, powerPreference, stencil: false
    });
    const info: RendererInfo = {
      requested: 'classic', kind: 'classic', nodeMaterials: false, sharedDevice: false, fallback: '',
      adapter: glAdapter(r), maxAnisotropy: r.capabilities.getMaxAnisotropy(), samples: o.antialias ? 4 : 0
    };
    return {
      renderer: r, info, device: null, kind: 'classic', isNode: false,
      dispose() { r.dispose(); }
    };
  }

  let device: PtDevice | null = null;
  let fallback = '';
  const wantGpu = o.mode === 'webgpu';
  if (wantGpu && !o.ownDevice) {
    try {
      device = await createDevice({ forThree: true, powerPreference, label: 'b5 three + path tracer' });
    } catch (e) {
      fallback = `shared device: ${(e as Error).message}`;
    }
  }
  const samples = o.antialias ? 4 : 0;
  const r = new WEBGPU.WebGPURenderer({
    canvas: o.canvas, antialias: !!o.antialias, samples, powerPreference, stencil: false,
    forceWebGL: !wantGpu,
    ...(device ? { device: device.device } : {})
  });
  await r.init();
  const backend = r.backend as unknown as { isWebGPUBackend?: boolean; isWebGLBackend?: boolean; gl?: WebGL2RenderingContext };
  const kind: RendererMode = backend.isWebGPUBackend ? 'webgpu' : 'webgl2';
  if (wantGpu && kind !== 'webgpu') fallback = (fallback ? fallback + '; ' : '') + 'WebGPU unavailable → WebGL2 backend';
  let adapter: string;
  if (device) adapter = describeDevice(device);
  else if (backend.gl) {
    const ext = backend.gl.getExtension('WEBGL_debug_renderer_info');
    adapter = String(ext ? backend.gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : backend.gl.getParameter(backend.gl.RENDERER));
  } else adapter = 'WebGPU (own device)';
  const info: RendererInfo = {
    requested: o.mode, kind, nodeMaterials: true, sharedDevice: !!device, fallback, adapter,
    maxAnisotropy: r.getMaxAnisotropy(), samples
  };
  return {
    renderer: r, info, device, kind, isNode: true,
    dispose() { r.dispose(); device?.destroy(); }
  };
}

/** Narrowing helper: is this the node-material renderer? */
export const isWebGPURenderer = (r: AnyRenderer): r is WEBGPU.WebGPURenderer =>
  (r as { isWebGPURenderer?: boolean }).isWebGPURenderer === true;
