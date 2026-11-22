import { packed, description, expectedBytes } from '../generated/station.ts';
import { byteHash } from './layout-hash.ts';
import type { SceneDesc } from '../../../core/scene/types.ts';

// QuickJS has no atob. The CLI bundles the baked bytes into the game, so a
// checked scene can also be opened offline without a filesystem API.
export function loadLayout(): SceneDesc {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const decode = new Uint8Array(128);
  for (let i = 0; i < alphabet.length; i++) decode[alphabet.charCodeAt(i)] = i;
  const pad = packed.endsWith('==') ? 2 : packed.endsWith('=') ? 1 : 0;
  const bytes = new Uint8Array(packed.length / 4 * 3 - pad);
  for (let i = 0, dst = 0; i < packed.length; i += 4) {
    const a = decode[packed.charCodeAt(i)], b = decode[packed.charCodeAt(i + 1)];
    const c = decode[packed.charCodeAt(i + 2)], d = decode[packed.charCodeAt(i + 3)];
    bytes[dst++] = (a << 2) | (b >> 4);
    bytes[dst++] = (b << 4) | (c >> 2);
    bytes[dst++] = (c << 6) | d;
  }
  if (byteHash(bytes) !== expectedBytes) throw new Error('Baked instance/geometry data checksum mismatch');
  const types = { Float32Array, Float64Array, Int8Array, Uint8Array, Uint16Array, Uint32Array };
  return JSON.parse(description, (_k, v) => {
    if (!v || typeof v !== 'object' || !('$ta' in v)) return v;
    const Type = types[v.$ta as keyof typeof types];
    if (!Type) throw new Error('Unknown baked array ' + v.$ta);
    return new Type(bytes.buffer, v.offset, v.length);
  });
}
