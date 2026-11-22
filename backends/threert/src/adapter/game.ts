import { audio, defineGame, host, hud } from '@threert/gameplay';
import { CORE_CONFIG } from '../../../../core/config/index.ts';
import { loadLayout } from '../layout.ts';
import {
  counterRotate, goToInstant, newPose, newControlState, readIntent, stepControls, hasMotion,
  newFly, startFly, stepFly, newTour, startTour, stepTour, newRide, startRide, stepRide,
  tpVec, OMEGA_DEFAULT, type SeatFn
} from '../sim/index.ts';
import { buildWorld } from './world.ts';
import { milestone } from '../../generated/station.ts';

const PHASES = CORE_CONFIG.PHASES;
const VIEW_NAMES = ['1 Garden panorama', '2 City square', '3 Command office', '4 Axis lift', '5 Truss', '6 Above the sun', '7 Endcap', '8 Park avenue', '9 Along the river'];
const pose = newPose(), control = newControlState(), fly = newFly(), tour = newTour(), ride = newRide();
let world: ReturnType<typeof buildWorld>, desc: ReturnType<typeof loadLayout>;
let hills: ReturnType<typeof loadLayout>['hull']['hills'] = [];
let view = 0, phase = 0, lastRevision = -1, showList = false, sound = false;
let autoCycle = false, cycleTime = 0, lastViewRevision = -1;
const seat: SeatFn = (i, pos, dir) => {
  const matrices = world.lifts;
  if (!matrices || i * 16 + 15 >= matrices.length) return false;
  for (let j = 0; j < 3; j++) { pos[j] = matrices[i * 16 + 12 + j]; dir[j] = matrices[i * 16 + 8 + j]; }
  return true;
};

function go(i: number) {
  view = (i + desc.views.length) % desc.views.length;
  const v = desc.views[view];
  ride.on = false;
  startFly(fly, pose, tpVec(v.pos), tpVec(v.look));
}

export default defineGame({
  state: { phase: 0, revision: 0, view: 0, fov: 62, viewRevision: 0 },
  pointer: 'look',
  handlers: {
    setPhase(tx, payload: { phase?: string }) {
      const index = PHASES.findIndex(x => x === payload?.phase);
      if (index >= 0) { tx.state.phase = index; tx.state.revision++; }
    },
    setView(tx, payload: { view?: number; fov?: number }) {
      const index = payload?.view;
      if (index === undefined || !Number.isInteger(index) || index < 0 || index >= CORE_CONFIG.TP.length) return;
      tx.state.view = index;
      tx.state.fov = typeof payload.fov === 'number' && payload.fov > 0 && payload.fov < 180 ? payload.fov : 62;
      tx.state.viewRevision++;
    }
  },
  setup() {
    desc = loadLayout();
    // The CLI sends launch after setup. Milestone builds select their scene
    // at bake time so the first TLAS already contains the requested geometry.
    world = buildWorld(desc, milestone);
    hills = desc.hull.hills.map(h => ({ ...h, aspect: h.ax }));
    fly.on = tour.on = ride.on = showList = sound = autoCycle = false;
    cycleTime = 0; lastViewRevision = -1;
    lastRevision = -1; view = 0; phase = 0;
    goToInstant(pose, desc.views[0].pos, desc.views[0].look);
    world.camera.position.fromArray(pose.pos);
    world.camera.quaternion.fromArray(pose.quat);
    console.log('Station layout ' + desc.layoutHash);
    return { scene: world.scene, camera: world.camera };
  },
  frame(f) {
    if (lastRevision !== f.state.revision) {
      lastRevision = f.state.revision;
      phase = f.state.phase;
      world.phase(phase);
    }
    if (host.launch.shots === true) {
      if (lastViewRevision !== f.state.viewRevision) {
        lastViewRevision = f.state.viewRevision;
        const v = desc.views[f.state.view];
        goToInstant(pose, v.pos, v.look);
        f.camera.fov = f.state.fov;
        f.camera.position.fromArray(pose.pos);
        f.camera.quaternion.fromArray(pose.quat);
      }
      return;
    }
    if (milestone < 3) return;
    const input = f.input, intent = readIntent(input);
    if (intent.cancel || hasMotion(intent) && !ride.on) { tour.on = false; fly.on = false; }
    if (intent.cancel) ride.on = false;
    if (input.pressed('T')) {
      if (tour.on) tour.on = false;
      else { startTour(tour); go(0); }
    }
    if (input.pressed('Y')) {
      if (ride.on) ride.on = false;
      else { fly.on = tour.on = false; startRide(ride, pose, seat, desc.dynamics.lifts.count); }
    }
    if (input.pressed('H')) showList = !showList;
    if (input.pressed('C')) { autoCycle = !autoCycle; cycleTime = 0; }
    if (autoCycle) cycleTime += f.dt;
    if (input.pressed('L') || cycleTime >= CORE_CONFIG.AUTO_CYCLE_PERIOD) {
      phase = (phase + 1) % PHASES.length; world.phase(phase); cycleTime = 0;
    }
    if (input.pressed('M')) {
      sound = !sound;
      if (sound) audio.play('assets/sound/station.wav', { loop: true, key: 'station' });
      else audio.stop('station');
    }
    for (let i = 0; i < desc.views.length; i++) if (input.pressed(String(i + 1))) { tour.on = false; go(i); }
    world.move(f.dt);
    const next = stepTour(tour, f.dt, fly.on);
    if (next.type === 'goTo') go(next.idx);
    if (fly.on) stepFly(fly, pose, f.dt, control.freeFly);
    else {
      stepControls(pose, control, intent, f.dt, hills);
      if (ride.on) stepRide(ride, pose, seat);
      counterRotate(pose, OMEGA_DEFAULT * f.dt, ride.on);
    }
    f.camera.position.fromArray(pose.pos);
    f.camera.quaternion.fromArray(pose.quat);
    hud.set({ items: [{
      type: 'list', anchor: 'top-left', lines: showList ? VIEW_NAMES : [
        'Babylon 5 Gardens  |  ' + PHASES[phase] + '  |  View ' + (view + 1),
        '1-9 Travel   T Tour   Y Monorail   L Light   C Cycle   M Sound   H Views'
      ]
    }] });
  }
});

