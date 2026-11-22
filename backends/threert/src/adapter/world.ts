import {
  BufferAttribute, Color, CylinderGeometry, ExponentialHeightFog, InstancedBufferAttribute,
  InstancedMesh, Matrix4, Mesh, MeshGeometry, PerspectiveCamera, Scene, SkyColor
} from '@threert/scene';
import { CORE_CONFIG } from '../../../../core/config/index.ts';
import { stepDynamics, type DynamicsOut } from '../../../../core/scene/dynamics.ts';
import type { GeometryDesc, InstanceSet, MeshDesc, SceneDesc } from '../../../../core/scene/types.ts';
import { makeMaterials } from './materials.ts';

// ThreeRT's live tone curve and two-bounce lighting render the calibrated
// daylight and dusk darker than the web reference. Compensate at the camera.
const DISPLAY_EV_OFFSET = [1.5, 0.75, 0] as const;

/** ThreeRT renders a single material per InstancedMesh. Select the slot's
 * triangles before instancing, including repeated and non-contiguous groups. */
export function geometryForSlot(g: GeometryDesc, slot: number | null) {
  const all = g.index ?? Uint32Array.from({ length: g.position.length / 3 }, (_, i) => i);
  const index = slot === null ? all : g.groups.filter(x => x.slot === slot)
    .flatMap(x => Array.from(all.subarray(x.start, x.start + x.count)));
  if (!index.length) return null;
  const geo = new MeshGeometry(g.position, index, g.normal, g.uv);
  if (g.color) geo.setAttribute('color', new BufferAttribute(g.color, 3));
  return geo;
}

export function buildWorld(desc: SceneDesc, milestone: number) {
  const scene = new Scene();
  scene.environment = new SkyColor(0x000000, 0);
  const fog = new ExponentialHeightFog(0, 0, 0xffffff);
  scene.fog = fog;
  const camera = new PerspectiveCamera(62, 16 / 9, 0.2, 2 * CORE_CONFIG.L);
  scene.add(camera);
  const materials = makeMaterials(desc);
  const updates: { key: 'lifts' | 'traffic'; mesh: InstancedMesh }[] = [];
  const out: DynamicsOut = {};
  const geos = new Map<string, MeshGeometry>();
  function add(m: MeshDesc) {
    if (m.only === 'raster') return;
    for (let slot = 0; slot < m.materials.length; slot++) {
      const d = desc.materials[m.materials[slot]];
      if (d.rasterOnly || d.model === 'sprite' || d.model === 'decal') continue;
      const mat = materials.get(d);
      const key = m.geometry + (m.materials.length === 1 ? '*' : ':' + slot);
      let geometry = geos.get(key);
      if (!geometry) {
        const next = geometryForSlot(desc.geometries[m.geometry], m.materials.length > 1 ? slot : null);
        if (!next) continue;
        geos.set(key, next);
        geometry = next;
      }
      let mesh: InstancedMesh | Mesh;
      if (m.instances) {
        const pop = m.instances;
        const inst = new InstancedMesh(geometry, mat, pop.count);
        inst.instanceMatrix.array.set(pop.matrices);
        inst.instanceMatrix.needsUpdate = true;
        if (pop.colors) inst.instanceColor = new InstancedBufferAttribute(pop.colors, 3);
        if (m.dynamic) { updates.push({ key: m.dynamic, mesh: inst }); out[m.dynamic] = pop.matrices; }
        mesh = inst;
      } else mesh = new Mesh(geometry, mat);
      if (m.transform) new Matrix4().fromArray(m.transform).decompose(mesh.position, mesh.quaternion, mesh.scale);
      mesh.id = m.role + (m.materials.length === 1 ? '' : '.' + slot);
      scene.add(mesh);
    }
  }
  for (const m of desc.meshes) {
    if (milestone === 1 && m.role !== 'hull' && !m.role.startsWith('endcap.') && m.role !== 'axis.sun') continue;
    if (m.role === 'axis.sun') {
      const e = desc.emitters.find(x => x.kind === 'tube');
      if (!e || e.kind !== 'tube') throw new Error('Missing axial emitter');
      const mesh = new Mesh(new CylinderGeometry(e.radius, e.radius, e.length, 32, Math.ceil(e.length / 5), true),
        materials.get(desc.materials[m.materials[0]]));
      mesh.rotation.x = Math.PI / 2;
      mesh.position.z = e.z0 + e.length / 2;
      mesh.id = m.role;
      scene.add(mesh);
    } else add(m);
  }
  if (milestone >= 2) for (const lod of desc.lodSets) {
    const l = lod.levels[0];
    const instances: InstanceSet = { matrices: lod.matrices, colors: lod.colors, count: lod.colors.length / 3, chunks: lod.chunks };
    add({ geometry: l.geometry, role: l.role, materials: [l.material], parent: 'station', instances });
  }
  function phase(index: number) {
    const phys = materials.phase(index);
    camera.setManualExposure(phys.ev100 - DISPLAY_EV_OFFSET[index % DISPLAY_EV_OFFSET.length]);
    fog.density = phys.fogDensity;
    fog.color = new Color().setRGB(...phys.fogColor);
  }
  function move(dt: number) {
    stepDynamics(desc.dynamics, dt, out);
    for (const { key, mesh } of updates) {
      mesh.instanceMatrix.array.set(out[key]!);
      mesh.instanceMatrix.needsUpdate = true;
    }
  }
  phase(0);
  return { scene, camera, phase, move, lifts: out.lifts };
}
