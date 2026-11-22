/* Axis light shafts, the shared bright pass and the classic glow blur —
   TSL ports of RAYS_FRAG, BRIGHT_FRAG and BLUR_FRAG (js/photo.js).

   The rays are a half-resolution radial blur of the bright pass toward the
   screen position of the station axis (the "sun"): every pixel marches
   `steps` taps toward the sun, each tap weighted by decay^k, sum / steps.
   The point is supplied by the app every frame (setSunScreen) — see
   `axisSunScreen` for the classic computation (nearest axis point to the
   view ray, clamped to the cylinder ends).

   UV convention: the classic chain passes the sun in GL UV (origin
   bottom-left, = NDC·0.5+0.5). TSL's quad UV has its origin top-left on both
   backends, so the pipeline flips y once when it writes the uniform. */
import * as THREE from 'three/webgpu';
import { vec2, vec3, float, dot, smoothstep, uv, Loop } from 'three/tsl';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TslNode = any;

const LUMA = [0.2126, 0.7152, 0.0722] as const;
/** Bright pass knee: smoothstep(t, t · KNEE, luma) as in BRIGHT_FRAG. */
const BRIGHT_KNEE = 2.0;
/** 5-tap binomial weights 6/16, 4/16, 1/16 (BLUR_FRAG). */
const BLUR_W = [0.375, 0.25, 0.0625] as const;

/** Bright pass on an exposed linear colour: c · smoothstep(t, 2t, luma). */
export function brightPass(exposed: TslNode, threshold: TslNode): TslNode {
  const c = vec3(exposed).toVar();
  const l = dot(c, vec3(...LUMA));
  const t = float(threshold);
  return c.mul(smoothstep(t, t.mul(BRIGHT_KNEE), l));
}

/** One direction of the separable 5-tap glow blur; `step` is in UV units. */
export function glowBlur(src: TslNode, step: TslNode, uvIn: TslNode = uv()): TslNode {
  const d = vec2(step).toVar();
  return src.sample(uvIn).rgb.mul(BLUR_W[0])
    .add(src.sample(uvIn.add(d)).rgb.add(src.sample(uvIn.sub(d)).rgb).mul(BLUR_W[1]))
    .add(src.sample(uvIn.add(d.mul(2.0))).rgb.add(src.sample(uvIn.sub(d.mul(2.0))).rgb).mul(BLUR_W[2]));
}

/** Radial blur of `bright` toward `sunUv` (TSL UV). `steps` is compile-time. */
export function axisRays(bright: TslNode, sunUv: TslNode, density: TslNode, decay: TslNode,
  steps: number, uvIn: TslNode = uv()): TslNode {
  const n = Math.max(1, Math.round(steps));
  const dir = vec2(sunUv).sub(uvIn).mul(density).div(n).toVar();
  const p = vec2(uvIn).toVar();
  const w = float(1.0).toVar();
  const sum = vec3(0.0).toVar();
  Loop(n, () => {
    p.addAssign(dir);
    sum.addAssign(bright.sample(p).rgb.mul(w));
    w.mulAssign(decay);
  });
  return sum.div(n);
}

export interface SunScreen { uv: THREE.Vector2; visible: boolean }

const _f = new THREE.Vector3();
const _v = new THREE.Vector3();
/** Off-screen margin (NDC) inside which the sun still drives the rays. */
const SUN_NDC_MARGIN = 2.5;
/** Fallback distance along the axis when looking straight along it. */
const AXIS_LOOKAHEAD = 100;

/** Classic setSunScreen (js/photo.js): screen position of the station axis
    point nearest to the view ray (axis = the line x = y = 0 in the camera's
    world frame, clamped to ±halfLength). Writes GL-convention UV (origin
    bottom-left) into `out.uv` — what `setSunScreen` of the pipeline takes. */
export function axisSunScreen(camera: THREE.Camera, halfLength: number,
  out: SunScreen = { uv: new THREE.Vector2(0.5, 0.5), visible: false }): SunScreen {
  const f = camera.getWorldDirection(_f);
  const p = camera.position;
  const denom = 1 - f.z * f.z;
  const zAxis = denom < 1e-4 ? p.z + Math.sign(f.z || 1) * AXIS_LOOKAHEAD
    : p.z + f.z * (-(p.x * f.x + p.y * f.y)) / denom;
  const v = _v.set(0, 0, THREE.MathUtils.clamp(zAxis, -halfLength, halfLength)).project(camera);
  out.visible = v.z < 1 && Math.abs(v.x) < SUN_NDC_MARGIN && Math.abs(v.y) < SUN_NDC_MARGIN;
  out.uv.set(v.x * 0.5 + 0.5, v.y * 0.5 + 0.5);
  return out;
}
