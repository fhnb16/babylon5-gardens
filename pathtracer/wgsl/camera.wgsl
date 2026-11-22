// ═══════════════════════════════════════════════════════════════════════════
// camera.wgsl — pinhole camera matching three.js PerspectiveCamera (vertical
// fov, aspect = width / height, looks down −Z of its quaternion). Station
// frame. Pixel (0, 0) is the TOP-left; `px` is the continuous position in
// pixels (integer + jitter in [0, 1)). Mirrored by integrator.ts cameraRayDir.
// ═══════════════════════════════════════════════════════════════════════════

// right = unit right · tan(fovY/2) · aspect, up = unit up · tan(fovY/2)
fn b5_camera_dir(fwd: vec3f, right: vec3f, up: vec3f, px: vec2f, size: vec2f) -> vec3f {
  let sx = px.x / size.x * 2.0 - 1.0;
  let sy = 1.0 - px.y / size.y * 2.0;
  return normalize(fwd + right * sx + up * sy);
}
