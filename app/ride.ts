import * as THREE from 'three';
import { CONFIG } from './cfg.ts';
import { $ } from './dom.ts';
import { camera, worldGroup, world } from './state.ts';
import { fly } from './flight.ts';
import { setTour } from './tour.ts';
import { ctl, syncFromCamera } from '../js/controls.js';

/* ═══════════════════════════════════════════════════════════════════════════
   ПОЕЗДКА НА МОНОРЕЛЬСЕ

   Камера садится в кабину и едет вместе с ней, обзор при этом свободный —
   как из глаз пассажира. Управление положением отдаётся кабине, а поворот
   остаётся за игроком: перехватывать ещё и взгляд значило бы отобрать у него
   единственное, ради чего в поездку и садятся.
   ═══════════════════════════════════════════════════════════════════════════ */
export const ride = { on: false, car: 0 };
const _rp = new THREE.Vector3(), _rd = new THREE.Vector3();
/* кабины монорельса живут в мире (backends/three ThreeWorld) */
const liftCount = () => world?.liftCount() ?? 0;
const liftSeat = (k: number, p: THREE.Vector3, d: THREE.Vector3) => !!world && world.liftSeat(k, p, d);

export function setRide(on: boolean) {
  ride.on = on && liftCount() > 0;
  $('rideBar').classList.toggle('show', ride.on);
  $('bRide').classList.toggle('on', ride.on);
  world?.setLiftInside(ride.on);
  if (ride.on) {
    setTour(false);
    fly.on = false;
    ctl.enabled = true;
    /* садимся в ближайшую кабину: так переход не выглядит телепортом */
    let best = 0, bestD = Infinity;
    for (let k = 0; k < liftCount(); k++) {
      liftSeat(k, _rp, _rd);
      worldGroup.localToWorld(_rp);
      const d = _rp.distanceToSquared(camera.position);
      if (d < bestD) { bestD = d; best = k; }
    }
    ride.car = best;
  } else {
    syncFromCamera(camera);
  }
}

/** Камеру ведёт кабина, взгляд остаётся за игроком */
export function updateRide() {
  if (!ride.on) return;
  if (!liftSeat(ride.car, _rp, _rd)) { setRide(false); return; }
  _rp.y += CONFIG.LIFTCAR.eye;              // глаз пассажира выше пола кабины
  worldGroup.localToWorld(_rp);
  camera.position.copy(_rp);
}
