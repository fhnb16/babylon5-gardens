import * as legacy from '../js/pathtrace.js';
import { app, camera, renderer, world, worldGroup } from './state.ts';
import { photoScene, photoImages } from './scene.ts';
import { ride } from './ride.ts';
import { snapshotForPath } from '../pathtracer/scene-snapshot.ts';
import { pathSurface } from './boot.ts';
import { pathOutput } from '../backends/three/post/path-output.ts';
import { createDevice, type PtDevice } from '../pathtracer/device.ts';
import { CONFIG } from './cfg.ts';
import { isMobile } from '../js/controls.js';

type Tracer = typeof import('../pathtracer/index.ts');
let tracer: Tracer | null = null;
let standalone: PtDevice | null = null;
let active: Tracer | null = null;
let overlay: HTMLCanvasElement | null = null;
let sink: ReturnType<typeof pathOutput> | null = null;
let generation = 0;
let scale = 0;
let noise = CONFIG.PATH.noise;
export let pathStarting = false;
export let pt: Tracer['pt'] | typeof legacy.pt = legacy.pt;

export const modernPath = () => active;
export const overlayPath = () => overlay;
export const samplesNeeded = () => (active ?? legacy).samplesNeeded();
export const pathClock = () => (active ?? legacy).pathClock();
export function pathLabel() {
  if (active?.pt.error) detach();
  return (active ?? legacy).pathLabel();
}
export const noiseNow = () => (active ?? legacy).noiseNow();
export function pathStep() {
  if (overlay && renderer.domElement.width !== overlay.width) overlay.width = renderer.domElement.width;
  if (overlay && renderer.domElement.height !== overlay.height) overlay.height = renderer.domElement.height;
  return (active ?? legacy).pathStep();
}
export function setNoiseTarget(value: number) {
  noise = value;
  legacy.setNoiseTarget(value);
  tracer?.setNoiseTarget(value);
}
export function setPathScale(value: number) {
  scale = value;
  legacy.setPathScale(value);
  tracer?.setPathScale(value);
}
function readCamera() {
  return { position: camera.position.toArray(), orientation: camera.quaternion.toArray(), rotation: worldGroup.rotation.z, fov: camera.fov };
}
function pathCamera(t: Tracer, frame = readCamera()) {
  return { pose: t.stationPose(frame.position, frame.orientation, frame.rotation), fovY: frame.fov };
}
export function pathCameraMoved() {
  if (active) active.pathCameraMoved(pathCamera(active));
  else legacy.pathCameraMoved();
}
function detach() {
  sink?.dispose(); sink = null;
  overlay?.remove(); overlay = null;
}
export function stopPath() {
  generation++;
  pathStarting = false;
  detach();
  (active ?? legacy).stopPath();
  active = null;
  pt = legacy.pt;
}

/** null selects the classic renderer's legacy tracer on a WebGL-only device. */
export async function startModern(onPhase: (msg: string) => void): Promise<boolean | null> {
  if (!photoScene || !world) return false;
  const gen = ++generation;
  pathStarting = true;
  try {
    const shared = pathSurface();
    if (!shared && !navigator.gpu) return null;
    const scene = snapshotForPath(photoScene, world.dynamics.arrays, world.trafficOn, ride.on);
    const frame = readCamera();
    const phase = app.phase;
    let device = shared?.device;
    if (!device) {
      try {
        if (!standalone || standalone.isLost()) standalone = await createDevice();
        device = standalone;
      } catch { return null; }
    }
    const t = tracer ??= await import('../pathtracer/index.ts');
    if (gen !== generation) return false;
    active = t;
    pt = t.pt;
    t.setNoiseTarget(noise);
    t.setPathScale(scale);
    if (shared) sink = pathOutput(shared.post);
    else {
      overlay = t.createOverlayCanvas(renderer.domElement.parentElement!);
      overlay.width = renderer.domElement.width;
      overlay.height = renderer.domElement.height;
    }
    const result = await t.startPath(scene, pathCamera(t, frame), {
      canvas: overlay ?? renderer.domElement, device, presentHdr: sink?.present,
      images: photoImages, lighting: phase, onPhase, maxDepth: isMobile ? CONFIG.PATH.mobileBounces : CONFIG.PATH.bounces,
      oidn: { load: () => import('oidn-webgpu'), weightsUrl:
        new URL('oidn/' + (isMobile ? 'rt_hdr_alb_nrm_small.tza' : 'rt_hdr_alb_nrm.tza'), document.baseURI).href }
    });
    if (gen === generation && !result) detach();
    return result;
  } finally { if (gen === generation) pathStarting = false; }
}
