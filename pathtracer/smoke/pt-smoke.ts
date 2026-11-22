/* Browser entry of the traversal smoke test (pt-smoke.html). Runs
   smoke-core.ts on a device of our own, presents the debug image, and
   publishes the result on window.__ptSmoke for Playwright
   (tests/browser/pt-smoke.spec.ts). */
import { createDevice } from '../device.ts';
import { createPresenter } from '../three-interop.ts';
import { WGSL_SOURCES } from '../wgsl/index.ts';
import hitviz from './k_hitviz.wgsl?raw';
import { runSmoke, type SmokeReport } from './smoke-core.ts';

interface PtSmokeState {
  done: boolean;
  pass?: boolean;
  report?: SmokeReport;
  error?: string;
  log: string[];
}

declare global {
  interface Window { __ptSmoke?: PtSmokeState }
}

const state: PtSmokeState = { done: false, log: [] };
window.__ptSmoke = state;

const logEl = document.getElementById('log')!;
const statusEl = document.getElementById('status')!;
const canvas = document.getElementById('view') as HTMLCanvasElement;

function log(line: string): void {
  state.log.push(line);
  logEl.textContent += line + '\n';
  console.log('[pt-smoke] ' + line);
}

async function main(): Promise<void> {
  const q = new URLSearchParams(location.search);
  if (!('gpu' in navigator) || !navigator.gpu) throw new Error('navigator.gpu is undefined: WebGPU is not available in this browser');
  const pt = await createDevice();
  pt.onLost((info) => log(`DEVICE LOST: ${info.reason} ${info.message}`));
  log(`adapter limits: ${JSON.stringify(pt.adapterLimits)}`);
  log(`device limits: ${JSON.stringify(pt.limits)}`);
  const res = await runSmoke(pt, { ...WGSL_SOURCES, 'k_hitviz.wgsl': hitviz }, {
    log,
    camera: [canvas.width, canvas.height],
    bench: q.get('bench') !== '0',
    workgroupSize: q.has('wg') ? Number(q.get('wg')) : undefined
  });
  const presenter = createPresenter(pt.device, canvas);
  presenter.present(res.viz, { mode: 'linear' });
  await pt.device.queue.onSubmittedWorkDone();
  state.report = res.report;
  state.pass = res.report.pass;
  statusEl.textContent = res.report.pass ? 'PASS' : 'FAIL';
  statusEl.className = res.report.pass ? 'pass' : 'fail';
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  state.error = msg;
  state.pass = false;
  statusEl.textContent = 'FAIL — ' + msg;
  statusEl.className = 'fail';
  log('ERROR ' + msg);
}).finally(() => {
  state.done = true;
});
