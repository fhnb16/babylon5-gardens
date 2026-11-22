/* ═══════════════════════════════════════════════════════════════════════════
   createThreeWorld(scene, renderer, opts): SceneDesc → three.js r187 objects
   with the legacy look, in one of two material flavours (opts.materials):
     'legacy' — classic WebGLRenderer, GLSL onBeforeCompile patches
                (materials/legacy.ts);
     'node'   — WebGPURenderer (WebGPU or its WebGL2 fallback), TSL node
                materials from the shared core kernels (materials/node.ts);
                billboards become instanced sprites (tsl/billboards.ts).
   Default: 'node' for a WebGPURenderer, 'legacy' otherwise. Geometry,
   instancing, LOD, dynamics, lights, textures and the palette are shared.

     stationGroup  — MeshDesc/billboards with parent 'station' (the caller
                     rotates it: stationGroup.rotation.z = station angle);
     sceneGroup    — parent 'scene' (sun glow plane, clouds, motes from
                     core/scene/ambient.ts) + hemisphere/axis lights — fixed,
                     axis-symmetric.

   Object order = legacy creation order (it decides ids, and ids break ties
   when three sorts transparent objects at equal depth): the meshes in
   SceneDesc order — the ambient fragment first (legacy buildAmbient ran
   before buildWorld) — with each LOD set right after the first mesh of the
   same population (the trunks) and each billboard set after the last mesh of
   its fragment (clouds/motes after the glow, nav after traffic, before the
   structures).

   update(dt, camera): time/uniforms, dynamics (traffic + lifts), tree LOD
   (legacy throttle), water-mirror camera, beacon flicker, glow facing.
   applyLighting(state): palette (adapt/palette.ts).
   App helpers: setTraffic, setLiftInside, liftSeat/liftCount (monorail
   ride), setDetailFull (photo mode), materialOf(role).
   ═══════════════════════════════════════════════════════════════════════════ */

import * as THREE from 'three';
import { CORE_CONFIG } from '../../../core/config/index.ts';
import type {
  BillboardSetDesc, LightingState, LodSetDesc, MaterialDesc, MeshDesc, SceneDesc
} from '../../../core/scene/types.ts';
import { liftRadius } from '../../../core/scene/structuresDynamics.ts';
import type { TexturePool } from '../../../app/workers/texturePool.ts';
import {
  createHullUniforms, createLegacyMaterial, createWindUniforms, type HullUniforms, type WindUniforms
} from '../materials/legacy.ts';
import { createTextureSet, type RendererLike, type TextureSet } from './textures.ts';
import { createNodeMaterial, isHullDesc, setHullNodes, type NodeMaterialContext } from '../materials/node.ts';
import { createHullNodeUniforms } from '../tsl/hull.ts';
import { createWindNodeUniforms } from '../tsl/wind.ts';
import { createSpriteBillboard } from '../tsl/billboards.ts';
import { pulled } from '../tsl/kernelBridge.ts';
import { dayState, numOrRef } from '../materials/legacy.ts';
import * as TSL from 'three/tsl';
import type { MeshStandardNodeMaterial, SpriteNodeMaterial } from 'three/webgpu';
import { toBufferGeometry } from './geometry.ts';
import { chunkBuckets, makeInstanced } from './instancing.ts';
import { createLod, type ThreeLod } from './lod.ts';
import { createDynamics, type ThreeDynamics } from './dynamics.ts';
import { createBillboard, faceGlow } from './billboards.ts';
import { createLights, type ThreeLights } from './lights.ts';
import {
  applyLighting as applyPalette, driveFrame, pointsTarget, type DrivenMaterial, type PaletteTargets
} from './palette.ts';
import { createCollision, type Collision } from '../collision.ts';

export type MaterialFlavour = 'legacy' | 'node';

export interface ThreeWorldOptions {
  /** material flavour; default 'node' for a WebGPURenderer, 'legacy' otherwise */
  materials?: MaterialFlavour;
  /** attach both groups to this scene and set its fog/background */
  scene?: THREE.Scene;
  /** texture pixels: 'pool' (workers, sync fallback), 'sync' (main thread), 'none' (placeholders only) */
  textures?: 'pool' | 'sync' | 'none';
  /** worker pool for 'pool' (created by the caller; app/workers/texturePool.ts) */
  pool?: TexturePool | null;
  /** extra image ids to create (and fill) although no material uses them —
      e.g. the water maps the photo-mode path tracer swaps in */
  extraTextures?: readonly string[];
  /** build the hull BVH collider (default true) */
  collider?: boolean;
  /**
   * node flavour, output semantics (tsl/displayOutput.ts):
   *   'hdr' (default) — linear HDR frame, three's fog, tone mapping by the
   *     renderer or the RenderPipeline (= the classic app through its post chain);
   *   { mode: 'display', exposure } — classic DIRECT-to-canvas semantics: the
   *     materials tone-map (ACES at `exposure`), encode sRGB and fog in display
   *     space; the caller runs the renderer with NoToneMapping and
   *     LinearSRGBColorSpace output (tools/core-world.ts). `exposure` is read
   *     every render (mutable).
   */
  output?: 'hdr' | { mode: 'display'; exposure: number; toneMapping?: 'aces' | 'none' };
  /** roughness → frame alpha on opaque standard materials, for photo mode (default true; legacy only) */
  roughnessAlpha?: boolean;
  /** water mirror strength; default = the quality preset's `mirror` */
  mirror?: number;
}

export interface ThreeWorld {
  /** material flavour in use */
  materialKind: MaterialFlavour;
  /** node flavour: the material context (node uniforms, textures); null for legacy */
  nodeContext: NodeMaterialContext | null;
  stationGroup: THREE.Group;
  sceneGroup: THREE.Group;
  /** materials by MatId */
  materials: Map<string, THREE.Material>;
  /** objects by role (sector meshes share their role) */
  objects: Map<string, THREE.Object3D[]>;
  textures: TextureSet;
  fog: THREE.FogExp2;
  background: THREE.Color;
  lights: ThreeLights;
  hullUniforms: HullUniforms;
  windUniforms: WindUniforms;
  lods: ThreeLod[];
  dynamics: ThreeDynamics;
  /** hull mesh with a BVH (hand it to js/controls.js setCollider), null if disabled */
  collider: THREE.Mesh | null;
  collision: Collision | null;
  /** resolves when every texture has its pixels */
  ready: Promise<void>;
  /** seconds of world time (hull/wind uTime) */
  readonly time: number;
  /** cars move (legacy app.trafficOn); see setTraffic for visibility */
  trafficOn: boolean;
  mirror: number;
  update(dt: number, camera: THREE.Camera): void;
  applyLighting(state: LightingState): void;
  setDetailFull(on: boolean, camera?: THREE.Camera): void;
  /** traffic on/off: cars move and are visible (legacy settings switch) */
  setTraffic(on: boolean): void;
  /** monorail ride: the cabin glass disappears from inside (legacy setLiftInside) */
  setLiftInside(inside: boolean): void;
  /** number of monorail cabins */
  liftCount(): number;
  /** cabin k in station space: centre and direction of travel; false if there are none */
  liftSeat(k: number, outPos: THREE.Vector3, outDir: THREE.Vector3): boolean;
  /** first material of the first object with this role (null if none) */
  materialOf(role: string): THREE.Material | null;
  dispose(): void;
}

type BuildItem =
  | { kind: 'mesh'; desc: MeshDesc }
  | { kind: 'lod'; desc: LodSetDesc }
  | { kind: 'billboard'; desc: BillboardSetDesc };

const prefixOf = (id: string): string => id.slice(0, id.indexOf('.') + 1);

/** Legacy creation order (see header). */
function buildOrder(scene: SceneDesc): BuildItem[] {
  const items: BuildItem[] = scene.meshes.map(desc => ({ kind: 'mesh', desc }));
  for (const lod of scene.lodSets) {
    const n = lod.matrices.length / 16;
    let at = items.findIndex(it => it.kind === 'mesh' && !it.desc.dynamic && it.desc.instances?.count === n);
    at = at < 0 ? items.length : at + 1;
    items.splice(at, 0, { kind: 'lod', desc: lod });
  }
  for (const b of scene.billboards) {
    const pre = prefixOf(b.material);
    let at = -1;
    items.forEach((it, i) => { if (it.kind === 'mesh' && prefixOf(it.desc.geometry) === pre) at = i; });
    if (at >= 0) {
      /* after billboards already placed behind that mesh (keep SceneDesc order) */
      while (at + 1 < items.length && items[at + 1].kind === 'billboard') at++;
    }
    items.splice(at < 0 ? items.length : at + 1, 0, { kind: 'billboard', desc: b });
  }
  return items;
}

/** sRGB OETF (three's SRGBTransferOETF / ColorManagement). */
const srgbEncode = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 0.41666) - 0.055);

const isSectored = (m: MeshDesc): boolean => !!m.instances && !m.dynamic && !!m.sectored;

/* the glow axial billboard (core/scene/ambient.ts) */
const GLOW_ROLE = 'glow';

export function createThreeWorld(scene: SceneDesc,
  renderer: RendererLike & { isWebGPURenderer?: boolean; toneMapping?: THREE.ToneMapping; toneMappingExposure?: number },
  opts: ThreeWorldOptions = {}): ThreeWorld {
  const flavour: MaterialFlavour = opts.materials ?? (renderer.isWebGPURenderer ? 'node' : 'legacy');
  const isNode = flavour === 'node';
  const quality = scene.params.quality;
  const Q = CORE_CONFIG.QUALITY[quality] || CORE_CONFIG.QUALITY.HIGH;
  const useCollider = opts.collider !== false;

  const stationGroup = new THREE.Group();
  stationGroup.name = 'station';
  const sceneGroup = new THREE.Group();
  sceneGroup.name = 'scene';

  const textures = createTextureSet(scene.images, renderer);
  const hullU = createHullUniforms(scene.hull);
  const windU = createWindUniforms(hullU);
  hullU.uMask.value = textures.get(scene.hull.mask);
  hullU.uDetail.value = textures.get(scene.hull.detail);
  for (const id of opts.extraTextures ?? []) textures.get(id);

  const fog = new THREE.FogExp2(0xffffff, CORE_CONFIG.DAY.fogD);
  const background = new THREE.Color();
  {
    const c = fog.color.setHex(CORE_CONFIG.DAY.fog);
    background.copy(c);
  }

  const lights = createLights(scene.rasterLights);
  sceneGroup.add(...lights.objects);

  const materials = new Map<string, THREE.Material>();
  const driven: DrivenMaterial[] = [];
  const matCtx = {
    texture: (id: string | undefined) => textures.get(id),
    hull: scene.hull, hullU, windU,
    roughnessAlpha: opts.roughnessAlpha !== false
  };
  /* the world's initial settings (the app overrides mirror every frame) */
  const initial = { mirror: opts.mirror ?? Q.mirror ?? 0 };
  const mirror0 = initial.mirror;
  const displayOut = isNode && typeof opts.output === 'object' && opts.output.mode === 'display' ? opts.output : null;
  /* node flavour: node uniforms pull from hullU / windU / fog (one source of truth) */
  const sizeK = TSL.uniform(Math.tan(Math.PI * 31 / 180));
  const nodeCtx: NodeMaterialContext | null = isNode ? {
    texture: (id: string | undefined) => textures.get(id),
    hull: scene.hull,
    hullN: createHullNodeUniforms(hullU),
    windN: createWindNodeUniforms(windU),
    fogDensity: pulled(() => fog.density),
    mirror: mirror0 > 0,
    display: displayOut ? {
      fogColor: TSL.uniform(fog.color),
      fogDensity: pulled(() => fog.density),
      exposure: pulled(() => displayOut.exposure),
      aces: displayOut.toneMapping !== 'none'
    } : null
  } : null;
  const hullNodeMats: { mat: MeshStandardNodeMaterial; desc: MaterialDesc }[] = [];

  const matOf = (id: string): THREE.Material => {
    let m = materials.get(id);
    if (m) return m;
    const d: MaterialDesc | undefined = scene.materials[id];
    if (!d) throw new Error(`createThreeWorld: unknown material '${id}'`);
    if (nodeCtx) {
      m = createNodeMaterial(d, nodeCtx);
      if (isHullDesc(d)) hullNodeMats.push({ mat: m as MeshStandardNodeMaterial, desc: d });

    } else {
      m = createLegacyMaterial(d, matCtx);
    }
    materials.set(id, m);
    driven.push({ desc: d, mat: m });
    return m;
  };
  const geos = new Map<string, THREE.BufferGeometry>();
  const geoOf = (id: string, copyIndex = false): THREE.BufferGeometry => {
    const key = copyIndex ? id + '#bvh' : id;
    let g = geos.get(key);
    if (g) return g;
    const d = scene.geometries[id];
    if (!d) throw new Error(`createThreeWorld: unknown geometry '${id}'`);
    g = toBufferGeometry(d, { copyIndex });
    geos.set(key, g);
    return g;
  };

  const objects = new Map<string, THREE.Object3D[]>();
  const put = (role: string, o: THREE.Object3D, parent: 'station' | 'scene'): void => {
    (parent === 'scene' ? sceneGroup : stationGroup).add(o);
    let list = objects.get(role);
    if (!list) { list = []; objects.set(role, list); }
    list.push(o);
  };

  const dynamics = createDynamics(scene);
  const lods: ThreeLod[] = [];
  const billboards: PaletteTargets['billboards'] = [];
  const disposables: (() => void)[] = [];
  const glows: THREE.Mesh[] = [];
  let collider: THREE.Mesh | null = null;

  for (const it of buildOrder(scene)) {
    if (it.kind === 'lod') {
      const d = it.desc;
      const lod = createLod(d, d.levels.map(l => geoOf(l.geometry)), d.levels.map(l => matOf(l.material)));
      lods.push(lod);
      for (const o of lod.objects) put(o.name.replace(/\.s\d+$/, ''), o, 'station');
      continue;
    }
    if (it.kind === 'billboard') {
      const d = it.desc;
      if (isNode) {
        const sb = createSpriteBillboard(d, matOf(d.material) as SpriteNodeMaterial, sizeK, numOrRef(d.size, dayState(), 1));
        billboards.push({ desc: d, setSize: sb.setSize, color: sb.color });
        disposables.push(() => sb.dispose());
        put(d.role, sb.object, d.parent);
      } else {
        const p = createBillboard(d, matOf(d.material) as THREE.PointsMaterial);
        billboards.push(pointsTarget(d, p));
        disposables.push(() => p.geometry.dispose());
        put(d.role, p, d.parent);
      }
      continue;
    }
    const m = it.desc;
    if (m.only === 'trace') continue;
    const mats = m.materials.map(matOf);
    const mat = mats.length > 1 ? mats : mats[0];
    const renderOrder = Math.max(0, ...m.materials.map(id => scene.materials[id].renderOrder || 0));
    const wantBvh = !!m.collider && useCollider && !m.instances;
    const geo = geoOf(m.geometry, wantBvh);

    if (m.instances) {
      const I = m.instances;
      if (m.dynamic) {
        const im = makeInstanced(geo, mat, {
          name: m.role, matrices: dynamics.arrays[m.dynamic] as Float32Array, colors: I.colors, wind: I.wind,
          frustumCulled: false, renderOrder
        });
        dynamics.meshes[m.dynamic].push(im);
        put(m.role, im, m.parent);
      } else if (isSectored(m)) {
        const buckets = chunkBuckets(I.chunks);
        I.chunks.forEach((ch, c) => {
          put(m.role, makeInstanced(geo, mat, {
            name: m.role + '.s' + buckets[c],
            matrices: I.matrices.subarray(ch.start * 16, (ch.start + ch.count) * 16),
            colors: I.colors ? I.colors.subarray(ch.start * 3, (ch.start + ch.count) * 3) : null,
            wind: I.wind ? I.wind.subarray(ch.start * 2, (ch.start + ch.count) * 2) : null,
            sphere: ch.sphere, frustumCulled: true, renderOrder
          }), m.parent);
        });
      } else {
        put(m.role, makeInstanced(geo, mat, {
          name: m.role, matrices: I.matrices, colors: I.colors, wind: I.wind, frustumCulled: false, renderOrder
        }), m.parent);
      }
      continue;
    }

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = m.role;
    if (renderOrder) mesh.renderOrder = renderOrder;
    if (m.transform) new THREE.Matrix4().fromArray(m.transform).decompose(mesh.position, mesh.quaternion, mesh.scale);
    put(m.role, mesh, m.parent);
    if (m.role === GLOW_ROLE) glows.push(mesh);
    if (wantBvh && !collider) collider = mesh;
  }

  const collision = collider ? createCollision(collider) : null;

  const targets: PaletteTargets = { fog, background, lights, glows, hullU, materials: driven, billboards };

  if (opts.scene) {
    opts.scene.add(stationGroup, sceneGroup);
    opts.scene.fog = fog;
    opts.scene.background = background;
  }

  const mode = opts.textures ?? 'pool';
  const ready = mode === 'none' ? Promise.resolve()
    : textures.load({ pool: mode === 'pool' ? opts.pool ?? null : null, sync: mode === 'sync' });

  let time = 0;
  let daylight = 1;
  const camW = new THREE.Vector3(), camS = new THREE.Vector3();
  const lifts = scene.dynamics.lifts;
  const liftR = liftRadius();

  /* 'display' output: the background is the ENCODED fog colour, written to the
     canvas as is (classic clear colour semantics) */
  const syncBackground = (): void => {
    if (!displayOut) return;
    background.setRGB(srgbEncode(fog.color.r), srgbEncode(fog.color.g), srgbEncode(fog.color.b));
  };
  /* node flavour: the mirror branch is compiled in only while the mirror is on */
  let mirrorBuilt = mirror0 > 0;
  const syncNode = (camera: THREE.Camera): void => {
    const pc = camera as THREE.PerspectiveCamera;
    if (pc.isPerspectiveCamera) sizeK.value = Math.tan(THREE.MathUtils.degToRad(pc.fov) / 2) / Math.max(1e-6, pc.zoom);
    const want = world.mirror > 0;
    if (nodeCtx && want !== mirrorBuilt) {
      mirrorBuilt = want;
      for (const h of hullNodeMats) setHullNodes(h.mat, h.desc, nodeCtx, want);
    }

  };

  const world: ThreeWorld = {
    materialKind: flavour,
    nodeContext: nodeCtx,
    stationGroup, sceneGroup, materials, objects, textures, fog, background, lights,
    hullUniforms: hullU, windUniforms: windU, lods, dynamics, collider, collision, ready,
    get time() { return time; },
    trafficOn: true,
    mirror: mirror0,

    update(dt, camera) {
      time += dt;
      hullU.uTime.value = time;
      camera.getWorldPosition(camW);
      stationGroup.updateMatrixWorld();
      camS.copy(camW);
      stationGroup.worldToLocal(camS);
      dynamics.step(dt, { traffic: world.trafficOn });
      for (const l of lods) l.update(camW, camS, false);
      for (const g of glows) faceGlow(g, camW);
      hullU.uCamObj.value.copy(camS);
      hullU.uMirror.value = world.mirror;
      if (isNode) syncNode(camera);
      driveFrame(targets, daylight, time);
    },

    applyLighting(state) {
      daylight = state.daylight;
      applyPalette(targets, state);
      syncBackground();
      driveFrame(targets, daylight, time);
    },

    setDetailFull(on, camera) {
      for (const l of lods) l.setFull(on);
      if (camera) {
        camera.getWorldPosition(camW);
        stationGroup.updateMatrixWorld();
        camS.copy(camW);
        stationGroup.worldToLocal(camS);
        for (const l of lods) l.update(camW, camS, true);
      }
    },

    setTraffic(on) {
      world.trafficOn = on;
      for (const im of dynamics.meshes.traffic) im.visible = on;
    },

    setLiftInside(inside) {
      for (const o of objects.get('lift.glass') ?? []) {
        o.visible = !inside;
        const m = (o as THREE.Mesh).material as THREE.Material;
        /* legacy: opacity 0 / no depth from inside, opaque-blend 1 outside */
        m.opacity = inside ? 0 : 1;
        m.depthWrite = !inside;
      }
    },

    liftCount: () => lifts.count,

    liftSeat(k, outPos, outDir) {
      const st = dynamics.state.lifts;
      if (!st || !st.count) return false;
      const i = k % st.count;
      const a = st.railAngles[i];
      outPos.set(Math.sin(a) * liftR, Math.cos(a) * liftR, st.z[i]);
      outDir.set(0, 0, st.dir[i]);
      return true;
    },

    materialOf(role) {
      const o = objects.get(role)?.[0] as THREE.Mesh | undefined;
      if (!o || !o.material) return null;
      return Array.isArray(o.material) ? o.material[0] : o.material;
    },

    dispose() {
      stationGroup.removeFromParent();
      sceneGroup.removeFromParent();
      collision?.dispose();
      for (const g of geos.values()) g.dispose();
      for (const m of materials.values()) m.dispose();
      for (const f of disposables) f();
      for (const list of objects.values()) {
        for (const o of list) {
          if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
          (o.userData.b5Wind as THREE.BufferAttribute | undefined)?.dispose();
        }
      }
      textures.dispose();
    }
  };
  syncBackground();
  return world;
}
