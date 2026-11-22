/** Same little-endian baked bytes in V8 and QuickJS, including alignment. */
export function byteHash(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) hash = Math.imul(hash ^ bytes[i], 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, '0');
}
