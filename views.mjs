/* Подбор видовых точек: считает, что реально видно из каждой. */
import './test/dom-stub.mjs';
import { CONFIG } from './js/config.js';

const D2R = Math.PI / 180, R = CONFIG.R, HL = CONFIG.L / 2;
const vec = ([d, r, z]) => [Math.sin(d * D2R) * r, Math.cos(d * D2R) * r, z];

/** Где луч взгляда упирается в корпус */
function hullHit(p, dir) {
  const a = dir[0] ** 2 + dir[1] ** 2;
  if (a < 1e-9) return Infinity;
  const b = 2 * (p[0] * dir[0] + p[1] * dir[1]);
  const c = p[0] ** 2 + p[1] ** 2 - R * R;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return Infinity;
  const t = (-b + Math.sqrt(disc)) / (2 * a);
  const z = p[2] + dir[2] * t;
  return Math.abs(z) > HL ? Infinity : t;   // раньше упрётся в торец — это нормально
}

function report(tp) {
  const p = vec(tp.pos), q = vec(tp.look);
  const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
  const len = Math.hypot(...d);
  const dir = d.map(x => x / len);
  const r = Math.hypot(p[0], p[1]);
  const outward = [p[0] / r, p[1] / r, 0];
  const radial = dir[0] * outward[0] + dir[1] * outward[1];
  const hit = hullHit(p, dir);

  /* внутри Башни? */
  const T = CONFIG.TOWER;
  const dt = Math.abs(((tp.pos[0] - T.deg + 180) % 360 + 360) % 360 - 180) * D2R * R;
  const inTower = Math.hypot(dt, tp.pos[2] - T.z) < 8 && r > R - T.h;

  /* внутри основания фермы? */
  const A = CONFIG.AXIS;
  let inTruss = false;
  for (const z of A.spars) for (let k = 0; k < A.sparArms; k++) {
    const ta = A.sparAngle + k * 360 / A.sparArms;
    const da = Math.abs(((tp.pos[0] - ta + 180) % 360 + 360) % 360 - 180) * D2R * R;
    if (Math.hypot(da, tp.pos[2] - z) < A.trussW + 2 && r > 10) inTruss = true;
  }

  const bad = [];
  if (r < 4 || r > 46) bad.push(`r=${r.toFixed(0)} вне 4…46`);
  if (Math.abs(tp.pos[2]) > 142) bad.push('слишком близко к торцу');
  if (len < 35) bad.push(`цель в ${len.toFixed(0)} юнитах — близко`);
  if (hit < 32) bad.push(`взгляд упирается в корпус через ${hit.toFixed(0)}`);
  if (radial > 0.55) bad.push(`смотрит наружу (радиальная доля ${radial.toFixed(2)})`);
  if (inTower) bad.push('камера внутри Башни');
  if (inTruss) bad.push('камера внутри фермы');

  const mark = bad.length ? 'ПЛОХО' : ' ok  ';
  console.log(`${mark} ${tp.name.padEnd(22)} r=${r.toFixed(0).padStart(2)} ` +
    `дист=${len.toFixed(0).padStart(3)} докорпуса=${(hit === Infinity ? '∞' : hit.toFixed(0)).padStart(3)} ` +
    `радиал=${radial.toFixed(2).padStart(5)}  ${bad.join('; ')}`);
  return bad.length === 0;
}

let allOk = true;
for (const tp of CONFIG.TP) allOk = report(tp) && allOk;

/* Проверка замысла бесполезна, если наведение реализовано неверно: раньше
   все точки были рассчитаны правильно, а камера смотрела ровно назад. */
const { tpVec, aimAt } = await import('./js/util.js');
const { stationUp } = await import('./js/controls.js');
const THREE = await import('three');
const up = new THREE.Vector3(), q = new THREE.Quaternion(), fwd = new THREE.Vector3();
let worst = 0;
for (const tp of CONFIG.TP) {
  const p = tpVec(tp.pos), t = tpVec(tp.look);
  stationUp(p, up); aimAt(p, t, up, q);
  fwd.set(0, 0, -1).applyQuaternion(q);
  const want = t.clone().sub(p).normalize();
  worst = Math.max(worst, Math.acos(Math.max(-1, Math.min(1, fwd.dot(want)))) / D2R);
}
console.log(`\nфактическое наведение: худшая ошибка ${worst.toFixed(3)}°`);
console.log(allOk ? '\nвсе точки в порядке' : '\nесть проблемные точки');
