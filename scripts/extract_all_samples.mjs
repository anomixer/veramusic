import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const buf = readFileSync('space_debris.mod');

function parseMod(buf) {
  const samples = [];
  for (let i = 0; i < 31; i++) {
    const o = 20 + i * 30;
    samples.push({
      id: i + 1,
      name: buf.toString('latin1', o, o + 22).replace(/\0[\s\S]*$/, '').trim(),
      length: buf.readUInt16BE(o + 22) * 2,
      finetune: buf.readUInt8(o + 24) & 0x0F,
      volume: Math.min(64, buf.readUInt8(o + 25)),
      repStart: buf.readUInt16BE(o + 26) * 2,
      repLen: buf.readUInt16BE(o + 28) * 2,
    });
  }
  const songLen = buf.readUInt8(950);
  const orders = [...buf.slice(952, 952 + 128)].slice(0, Math.max(1, songLen));
  const maxPat = Math.max(0, ...orders);
  let sOff = 1084 + (maxPat + 1) * 64 * 4 * 4;
  for (const s of samples) {
    s.data = buf.subarray(sOff, sOff + s.length);
    sOff += s.length;
  }
  return { samples, orders, maxPat };
}

function writeWav(filename, pcm8Signed, sampleRate = 16000) {
  const numSamples = pcm8Signed.length;
  const wavBuf = Buffer.alloc(44 + numSamples * 2);
  wavBuf.write('RIFF', 0);
  wavBuf.writeUInt32LE(36 + numSamples * 2, 4);
  wavBuf.write('WAVE', 8);
  wavBuf.write('fmt ', 12);
  wavBuf.writeUInt32LE(16, 16);
  wavBuf.writeUInt16LE(1, 20); // PCM
  wavBuf.writeUInt16LE(1, 22); // mono
  wavBuf.writeUInt32LE(sampleRate, 24);
  wavBuf.writeUInt32LE(sampleRate * 2, 28);
  wavBuf.writeUInt16LE(2, 32);
  wavBuf.writeUInt16LE(16, 34);
  wavBuf.write('data', 36);
  wavBuf.writeUInt32LE(numSamples * 2, 40);

  for (let i = 0; i < numSamples; i++) {
    // Convert 8-bit signed to 16-bit signed
    const val8 = pcm8Signed[i] > 127 ? pcm8Signed[i] - 256 : pcm8Signed[i];
    wavBuf.writeInt16LE(val8 << 8, 44 + i * 2);
  }
  writeFileSync(filename, wavBuf);
}

const { samples } = parseMod(buf);
const outDir = 'extracted_samples';
try { mkdirSync(outDir); } catch {}

console.log('=== All Samples in space_debris.mod ===');
for (const s of samples) {
  if (s.length === 0) continue;
  const isLoop = s.repLen > 2;
  const safeName = s.name.replace(/[^a-zA-Z0-9._-]/g, '_') || `sample_${s.id}`;
  const outPath = join(outDir, `s${String(s.id).padStart(2, '0')}_${safeName}.wav`);
  writeWav(outPath, s.data, 16000);
  console.log(`s${String(s.id).padStart(2, '0')}: "${s.name.padEnd(20)}" len=${s.length.toString().padStart(6)} vol=${s.volume.toString().padStart(2)} loop=${isLoop ? `${s.repStart}..${s.repStart + s.repLen}` : 'NO'}`);
}
