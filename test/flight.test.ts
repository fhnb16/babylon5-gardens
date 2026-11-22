import '../test/dom-stub.mjs';
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { initScene } from '../app/state.ts';
import { fly, goTo, updateFly } from '../app/flight.ts';
import { CONFIG } from '../js/config.js';

/* Перелёт между точками обзора: камера смотрит туда, куда её ведёт fly.dir.
   В main.js цель взгляда (_v2) не заполнялась, и весь перелёт камера
   смотрела на начало координат — посчитанное направление пропадало. */
describe('flight camera', () => {
  it('looks along fly.dir mid-flight', () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.2, 2000);
    const worldGroup = new THREE.Group();
    scene.add(worldGroup);
    initScene({
      renderer: {} as THREE.WebGLRenderer, scene, camera, worldGroup
    });

    const fwd = new THREE.Vector3(), dir = new THREE.Vector3();
    const n = CONFIG.TP.length;
    let worst = 0, samples = 0;
    for (let from = 0; from < n; from++) {
      const to = (from + 3) % n;
      goTo(from, true);
      goTo(to);
      expect(fly.on).toBe(true);
      for (let k = 0; k < 2000 && fly.on; k++) {
        updateFly(1 / 60);
        if (fly.t > 0.2 && fly.t < 0.8) {
          camera.getWorldDirection(fwd);
          dir.copy(fly.dir).normalize();
          worst = Math.max(worst, fwd.angleTo(dir) * 180 / Math.PI);
          samples++;
        }
      }
      expect(fly.on).toBe(false);
    }
    expect(samples).toBeGreaterThan(100);
    expect(worst, `worst deviation ${worst.toFixed(2)}°`).toBeLessThan(3);
  });
});
