/* ═══════════════════════════════════════════════════════════════════════════
   Node materials without a GPU (Node + three, no device):

   · createThreeWorld(HIGH scene, { materials: 'node' }) builds a node material
     for EVERY MaterialDesc of the scene, of the expected class, with the
     kernel nodes attached (hull → colour/roughness/normal/emissive, wind →
     WindNodeMaterial.windNode (pre-instancing), fogFade → opacityNode with fog off, sprites → instanced
     THREE.Sprite with positionNode/scaleNode);
   · every material compiles on its real object (instanced meshes with their
     per-object wind attribute, the sprite sets, the hull with and without the
     mirror branch) with three's WGSLNodeBuilder AND GLSLNodeBuilder.

   Headless shims (same trick as core/test/shading-tsl.test.ts): a stub canvas,
   renderer._bindings = undefined and hasFeature() = false (normally set up by\n   init()), and builder.camera /
   builder.scene. Lights are left out of the build scene (the lights node
   needs the initialised renderer); fog is in, so the fog paths compile.
   ═══════════════════════════════════════════════════════════════════════════ */

import { describe, expect, test } from 'vitest';
import * as THREE from 'three/webgpu';
import { buildScene, defaultParams } from '../../../core/scene/build.ts';
import { createThreeWorld, type ThreeWorld } from '../adapt/sceneGraph.ts';
import { setHullNodes, type NodeMaterialContext } from '../materials/node.ts';

const stubRenderer = { isWebGPURenderer: true, getMaxAnisotropy: () => 16 };

function makeWorld(mirror = 0): ThreeWorld {
  const scene = buildScene(defaultParams('HIGH'));
  return createThreeWorld(scene, stubRenderer, { textures: 'none', collider: false, materials: 'node', mirror });
}

type Builder = { material: unknown; camera: unknown; scene: unknown; fragmentShader: string; vertexShader: string; build(): void };

function compile(object: THREE.Object3D, material: THREE.Material, glsl: boolean): { vs: string; fs: string } {
  const canvas = {
    style: {}, width: 1, height: 1,
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, getContext() { return null; }
  };
  const renderer = new THREE.WebGPURenderer({ forceWebGL: glsl, canvas: canvas as unknown as HTMLCanvasElement });
  (renderer as unknown as { _bindings: unknown })._bindings = undefined;
  /* texture sampling asks for 'float32-filterable' (normally after init()) */
  (renderer as unknown as { hasFeature: () => boolean }).hasFeature = () => false;
  const Ctor = (THREE as unknown as Record<string, new (o: unknown, r: unknown) => Builder>)[glsl ? 'GLSLNodeBuilder' : 'WGSLNodeBuilder'];
  const b = new Ctor(object, renderer);
  b.material = material;
  b.camera = new THREE.PerspectiveCamera();
  const sc = new THREE.Scene();
  sc.fog = new THREE.FogExp2(0x808080, 0.002);
  b.scene = sc;
  b.build();
  return { vs: b.vertexShader, fs: b.fragmentShader };
}

/** first rendered object of every material id */
function objectsByMaterial(world: ThreeWorld): Map<string, THREE.Object3D> {
  const out = new Map<string, THREE.Object3D>();
  for (const list of world.objects.values()) {
    for (const o of list) {
      const m = (o as THREE.Mesh).material;
      for (const mm of Array.isArray(m) ? m : [m]) if (mm && !out.has(mm.name)) out.set(mm.name, o);
    }
  }
  return out;
}

describe('node materials (no GPU)', () => {
  const world = makeWorld();
  const scene = buildScene(defaultParams('HIGH'));
  const byMat = objectsByMaterial(world);

  test('every MaterialDesc gets a node material of the right class and kernel nodes', () => {
    expect(world.materialKind).toBe('node');
    const ids = Object.keys(scene.materials);
    expect(ids.length).toBeGreaterThan(20);
    for (const id of ids) {
      const d = scene.materials[id];
      const m = world.materials.get(id);
      if (!m) {
        /* a material only trace-only meshes use is never created */
        const used = scene.meshes.some(x => x.only !== 'trace' && x.materials.includes(id)) ||
          scene.lodSets.some(l => l.levels.some(v => v.material === id)) ||
          scene.billboards.some(b => b.material === id);
        expect(used, id).toBe(false);
        continue;
      }
      expect((m as THREE.NodeMaterial).isNodeMaterial, id).toBe(true);
      const want = d.model === 'sprite' ? 'SpriteNodeMaterial'
        : d.model === 'unlit' || d.model === 'decal' ? 'MeshBasicNodeMaterial' : 'MeshStandardNodeMaterial';
      expect(m.type, id).toBe(want);
      const nm = m as THREE.MeshStandardNodeMaterial;
      const k = d.kernels ?? [];
      if (d.model === 'hull') {
        for (const slot of ['colorNode', 'roughnessNode', 'normalNode', 'emissiveNode'] as const) expect(nm[slot], `${id} ${slot}`).toBeTruthy();
      }
      if (k.includes('wind')) expect((m as unknown as { windNode: unknown }).windNode, id).toBeTruthy();
      if (k.includes('fogFade')) {
        expect(nm.opacityNode, id).toBeTruthy();
        expect(nm.fog, id).toBe(false);
      }
      if (d.model === 'sprite') {
        const sm = m as THREE.SpriteNodeMaterial;
        expect(sm.positionNode && sm.scaleNode, id).toBeTruthy();
      }
    }
  });

  test('wind populations carry a per-object wind attribute; billboards are instanced sprites', () => {
    for (const role of ['tufts', 'bushes']) {
      const list = world.objects.get(role) ?? [];
      expect(list.length, role).toBeGreaterThan(0);
      for (const o of list) {
        const im = o as THREE.InstancedMesh;
        const w = o.userData.b5Wind as THREE.InstancedBufferAttribute;
        expect(w?.itemSize, role).toBe(2);
        expect(w.count, role).toBe(im.instanceMatrix.count);
      }
    }
    const crowns = world.lods[0];
    for (const row of crowns.meshes) for (const im of row) expect((im.userData.b5Wind as THREE.BufferAttribute).count).toBe(im.instanceMatrix.count);
    for (const b of scene.billboards) {
      const s = world.objects.get(b.role)?.[0] as THREE.Sprite;
      expect(s?.isSprite, b.role).toBe(true);
      expect(s.count, b.role).toBe(b.positions.length / 3);
    }
  });

  test.each([['WGSL', false], ['GLSL', true]] as const)('every material compiles with the %s node builder', (_l, glsl) => {
    expect(byMat.size).toBe(world.materials.size);
    for (const [id, o] of byMat) {
      const m = world.materials.get(id) as THREE.Material;
      let res: { vs: string; fs: string };
      try {
        res = compile(o, m, glsl);
      } catch (e) {
        throw new Error(`${id}: ${(e as Error).message}`);
      }
      expect(res.vs.length, id).toBeGreaterThan(100);
      expect(res.fs.length, id).toBeGreaterThan(100);
    }
  });

  test.each([['WGSL', false], ['GLSL', true]] as const)('hull: truss shadow, ripple and mirror branch lower to %s', (_l, glsl) => {
    const hull = byMat.get('w.hull') as THREE.Mesh;
    const mat = world.materials.get('w.hull') as THREE.MeshStandardNodeMaterial;
    const plain = compile(hull, mat, glsl).fs;
    /* the floored mod of the truss gate and atan of the vertex θ */
    expect(plain).toMatch(glsl ? /\bmod\(/ : /tsl_mod_float/);
    const ctx = world.nodeContext as NodeMaterialContext;
    expect(ctx).toBeTruthy();
    setHullNodes(mat, scene.materials['w.hull'], ctx, true);
    const mirrored = compile(hull, mat, glsl).fs;
    expect(mirrored.length).toBeGreaterThan(plain.length);
    expect(mirrored).toMatch(glsl ? /\batan\(/ : /\batan2\(/);
    setHullNodes(mat, scene.materials['w.hull'], ctx, false);
  });

  test('wind vertex stage reads the instance matrix and the wind attribute', () => {
    const o = world.objects.get('bushes')![0];
    const m = (o as THREE.Mesh).material as THREE.Material;
    for (const glsl of [false, true]) {
      const { vs } = compile(o, m, glsl);
      expect(vs, glsl ? 'GLSL' : 'WGSL').toMatch(/sin\(/);
    }
  });

  test('wind is added before instancing: no second read of the instance matrix', () => {
    const o = world.objects.get('bushes')![0] as THREE.Mesh;
    const m = o.material as THREE.MeshStandardNodeMaterial & { windNode: unknown };
    const attrs = (vs: string) => (vs.match(/^\s*(layout\s*\([^)]*\)\s*)?in\s+\w+\s+\w+;/gm) ?? []).length;
    const withWind = compile(o, m, true).vs;
    const node = m.windNode;
    m.windNode = null;
    m.needsUpdate = true;
    const without = compile(o, m, true).vs;
    m.windNode = node;
    m.needsUpdate = true;
    /* exactly one more vertex input: the per-object wind attribute (phase, amplitude) */
    expect(attrs(withWind)).toBe(attrs(without) + 1);
  });

  test("'display' output mode: every material compiles with its outputNode (WGSL, GLSL)", () => {
    const scene2 = buildScene(defaultParams('HIGH'));
    const w = createThreeWorld(scene2, stubRenderer, {
      textures: 'none', collider: false, materials: 'node', output: { mode: 'display', exposure: 1.22 }
    });
    for (const [id, o] of objectsByMaterial(w)) {
      const m = w.materials.get(id) as THREE.MeshBasicNodeMaterial;
      expect(m.outputNode, id).toBeTruthy();
      expect(m.fog, id).toBe(false);
      for (const glsl of [false, true]) expect(compile(o, m, glsl).fs.length, id).toBeGreaterThan(100);
    }
    w.dispose();
  });

  test('mirror switch: update() swaps the hull branch only when the mirror toggles', () => {
    const w = makeWorld(0);
    const mat = w.materials.get('w.hull') as THREE.MeshStandardNodeMaterial;
    const cam = new THREE.PerspectiveCamera(62, 16 / 9, 0.2, 1000);
    expect(mat.userData.b5Mirror).toBe(false);
    const n0 = mat.emissiveNode;
    w.update(0, cam);
    expect(mat.emissiveNode).toBe(n0);
    w.mirror = 1;
    w.update(0, cam);
    expect(mat.userData.b5Mirror).toBe(true);
    expect(mat.emissiveNode).not.toBe(n0);
    w.dispose();
  });
});
