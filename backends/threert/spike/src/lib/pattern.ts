// A cheap procedural RGBA8 pattern (grid lines + sine bands + hash speckle), shared by the QuickJS DataTexture test
// and the Node PNG generator so both textures are identical.
export function fillPattern(px: Uint8Array, n: number): void {
  for (let y = 0; y < n; y++) {
    const sy = Math.sin((y / n) * 6.2831853 * 8);
    for (let x = 0; x < n; x++) {
      const o = (y * n + x) * 4;
      let h = Math.imul(x * 374761393 + y * 668265263, 1274126177);
      h = (h ^ (h >>> 13)) >>> 0;
      const speck = (h & 255) / 255;
      const line = (x & 127) < 4 || (y & 127) < 4 ? 1 : 0;
      const band = 0.5 + 0.5 * sy * Math.sin((x / n) * 6.2831853 * 5);
      px[o] = Math.min(255, 40 + 150 * band + 40 * speck + 200 * line);
      px[o + 1] = Math.min(255, 90 + 100 * band + 30 * speck);
      px[o + 2] = Math.min(255, 60 + 60 * (1 - band) + 20 * speck + 200 * line);
      px[o + 3] = 255;
    }
  }
}
