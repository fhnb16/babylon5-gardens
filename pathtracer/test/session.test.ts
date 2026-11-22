import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SceneDesc } from '../../core/scene/types.ts';
import type { PtDevice } from '../device.ts';
import type { GpuScene } from '../scene-upload.ts';
import type { Integrator } from '../integrator.ts';
import { uploadSceneDesc } from '../scene-upload.ts';
import { createIntegrator } from '../integrator.ts';
import { createPresenter } from '../three-interop.ts';
import { cleanPath, pathIdle, pathStep, pt, setPaused, startPath, stopPath, type PathCamera, type StartPathOptions } from '../index.ts';
import { createOidnDenoiser } from '../oidn.ts';
import { createAtrousDenoiser, type AtrousDenoiser } from '../denoise.ts';

vi.mock('../scene-upload.ts', () => ({ uploadSceneDesc: vi.fn() }));
vi.mock('../integrator.ts', () => ({ createIntegrator: vi.fn() }));
vi.mock('../three-interop.ts', () => ({ createPresenter: vi.fn() }));
vi.mock('../oidn.ts', () => ({ createOidnDenoiser: vi.fn() }));
vi.mock('../denoise.ts', () => ({ createAtrousDenoiser: vi.fn() }));

const options: StartPathOptions = {
  canvas: { width: 32, height: 16 } as HTMLCanvasElement,
  device: { device: {}, info: { description: 'test' } } as PtDevice,
  presentHdr: vi.fn(), oidn: { load: vi.fn(), weightsUrl: '/oidn/model.tza' }
};
const camera: PathCamera = { pose: { pos: [0, 0, 0], quat: [0, 0, 0, 1] } };
const scene = {} as SceneDesc;
const uploaded = { destroy: vi.fn() } as unknown as GpuScene;
const integrator = {
  width: 32, height: 16, output: {}, aovs: {}, setCamera: vi.fn(), setLighting: vi.fn(),
  setAdaptive: vi.fn(), lightsReady: vi.fn(), dispose: vi.fn(), step: vi.fn()
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(uploadSceneDesc).mockResolvedValue(uploaded);
  vi.mocked(createIntegrator).mockResolvedValue(integrator as unknown as Integrator);
});
afterEach(async () => {
  stopPath();
  vi.restoreAllMocks();
  await Promise.resolve();
});

it('discards an upload that completes after exit without touching the next session', async () => {
  let finish!: (scene: GpuScene) => void;
  const abandoned = { destroy: vi.fn() } as unknown as GpuScene;
  vi.mocked(uploadSceneDesc).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const first = startPath(scene, camera, options);
  stopPath();
  expect(await startPath(scene, camera, options)).toBe(true);
  finish(abandoned);
  expect(await first).toBe(false);
  expect(abandoned.destroy).toHaveBeenCalledOnce();
  expect(uploaded.destroy).not.toHaveBeenCalled();
  expect(pt.ready).toBe(true);
});

it('presents raw and denoised HDR frames without configuring a second canvas', async () => {
  integrator.step.mockResolvedValue({ spp: 1, ms: 1, done: false, waves: 1 });
  const clean = { output: {} as GPUTexture, denoise: vi.fn().mockResolvedValue(8), dispose: vi.fn(), cancel: vi.fn() };
  vi.mocked(createOidnDenoiser).mockResolvedValue(clean);
  expect(await startPath(scene, camera, options)).toBe(true);
  pathStep();
  await pathIdle();
  expect(options.presentHdr).toHaveBeenLastCalledWith(integrator.output);
  expect(await cleanPath('oidn')).toBe(true);
  expect(options.presentHdr).toHaveBeenLastCalledWith(clean.output);
  expect(pt.showing).toBe('oidn');
  expect(createPresenter).not.toHaveBeenCalled();
});

it('keeps the accumulation and falls back to à-trous if OIDN weights cannot load', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.mocked(createOidnDenoiser).mockRejectedValue(new Error('weights unavailable'));
  const atrous = { output: {}, run: vi.fn().mockResolvedValue(1), dispose: vi.fn() };
  vi.mocked(createAtrousDenoiser).mockReturnValue(atrous as unknown as AtrousDenoiser);
  integrator.step.mockResolvedValue({ spp: 3, ms: 1, done: false, waves: 1 });
  await startPath(scene, camera, options);
  pathStep();
  await pathIdle();
  setPaused(true, 'oidn');
  await vi.waitFor(() => expect(pt.showing).toBe('atrous'));
  expect(pt.samples).toBe(3);
  expect(options.presentHdr).toHaveBeenLastCalledWith(atrous.output);
  setPaused(false);
  expect(options.presentHdr).toHaveBeenLastCalledWith(integrator.output);
});
