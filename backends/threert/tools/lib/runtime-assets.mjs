import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// A seamless PCM loop derived from the station's electrical mains and fan.
export function bakeAmbience(dir) {
  mkdirSync(dir, { recursive: true });
  const rate = 22050, samples = rate * 4;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    const t = i * 2 * Math.PI / rate;
    const hum = Math.sin(48 * t) + 0.3 * Math.sin(96 * t);
    const fan = Math.sin(122 * t) * (1 + 0.3 * Math.cos(2 * t));
    wav.writeInt16LE(Math.round(3200 * hum + 700 * fan), 44 + i * 2);
  }
  writeFileSync(join(dir, 'station.wav'), wav);
}
