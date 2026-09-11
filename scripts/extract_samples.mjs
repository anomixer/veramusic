import { readFileSync, writeFileSync } from 'node:fs';
const buf = readFileSync('space_debris.mod');

// Parse samples to find Zoh2.Minor (s04)
const patOff = 1084;
const channels = 4;
const samples = [];
for(let i=0; i<31; i++) {
  const o = 20+i*30;
  const name = buf.toString('latin1', o, o+22).replace(/\0[\s\S]*$/, '').trim();
  const len = buf.readUInt16BE(o+22)*2;
  const vol = buf.readUInt8(o+25);
  const repStart = buf.readUInt16BE(o+26)*2;
  const repLen = buf.readUInt16BE(o+28)*2;
  samples.push({ id:i+1, name, len, vol, repStart, repLen });
}
const maxPat = Math.max(0, ...([...buf.slice(952,952+128)].slice(0,buf.readUInt8(950))));
let sOff = patOff + (maxPat+1)*64*channels*4;
for (const s of samples) {
  s.data = buf.subarray(sOff, Math.min(buf.length, sOff+s.length));
  sOff += s.length;
}

// Extract Zoh2.Minor (s04 = index 3) and Choir (s09 = index 8) as WAV files for listening
function writeWav(filename, data8bit, rate) {
  const n = data8bit.length;
  const wav = Buffer.alloc(44 + n * 2);
  wav.write('RIFF',0); wav.writeUInt32LE(36+n*2,4); wav.write('WAVE',8);
  wav.write('fmt ',12); wav.writeUInt32LE(16,16); wav.writeUInt16LE(1,20);
  wav.writeUInt16LE(1,22); wav.writeUInt32LE(rate,24); wav.writeUInt32LE(rate*2,28);
  wav.writeUInt16LE(2,32); wav.writeUInt16LE(16,34);
  wav.write('data',36); wav.writeUInt32LE(n*2,40);
  for (let i=0;i<n;i++) {
    const s8 = (data8bit[i] << 24) >> 24;
    wav.writeInt16LE(s8 * 256, 44+i*2);
  }
  writeFileSync(filename, wav);
  console.log(`Wrote ${filename} (${n} samples @ ${rate}Hz = ${(n/rate).toFixed(2)}s)`);
}

// s04 Zoh2.Minor - at C2 (428 period) = AMIGA_PAL/428 = 8287Hz
// at C3 (202 period) = 17559Hz
const PAL = 3546895;
const s04 = samples[3]; // Zoh2.Minor
const s09 = samples[8]; // Choir
const s12 = samples[11]; // Rezonatix3

// Write the raw sample at native Amiga rate ~8287Hz to understand the waveform
console.log(`s04 Zoh2.Minor: len=${s04.len} vol=${s04.vol} repLen=${s04.repLen}`);
writeWav('zoh2_native.wav', s04.data, Math.round(PAL/428));

console.log(`s09 Choir: len=${s09.len} vol=${s09.vol} repLen=${s09.repLen}`);
writeWav('choir_native.wav', s09.data, Math.round(PAL/428));

// What does Choir sound like at high pitch (period=160)?
// We'd play at PAL/160 = 22168Hz
// Let's resample to simulate playback at period=320 vs period=160
const VERA_RATE = 8010.864;

function resampleToVera(sampleData, period, outSeconds) {
  const amigaRate = PAL / period;
  const step = amigaRate / VERA_RATE;
  const outLen = Math.round(outSeconds * VERA_RATE);
  const repStart = 2, repLen = sampleData.length - 2;
  const hasLoop = sampleData.length > 100 && repLen > 2;
  const loopEnd = hasLoop ? repStart + repLen : sampleData.length;
  const out = [];
  let pos = 0;
  for (let i = 0; i < outLen; i++) {
    const idx = Math.floor(pos);
    if (idx >= sampleData.length) break;
    out.push((sampleData[idx] << 24) >> 24);
    pos += step;
    if (hasLoop && pos >= loopEnd) pos = repStart + (pos - loopEnd) % repLen;
  }
  return out;
}

// Choir at period=320 (F2) vs period=160 (F3)
const choirF2 = resampleToVera(s09.data, 320, 3.0);
const choirF3 = resampleToVera(s09.data, 160, 3.0);

function writeVeraWav(filename, samples) {
  const n = samples.length;
  const SR = Math.round(VERA_RATE);
  const wav = Buffer.alloc(44+n*2);
  wav.write('RIFF',0); wav.writeUInt32LE(36+n*2,4); wav.write('WAVE',8);
  wav.write('fmt ',12); wav.writeUInt32LE(16,16); wav.writeUInt16LE(1,20);
  wav.writeUInt16LE(1,22); wav.writeUInt32LE(SR,24); wav.writeUInt32LE(SR*2,28);
  wav.writeUInt16LE(2,32); wav.writeUInt16LE(16,34);
  wav.write('data',36); wav.writeUInt32LE(n*2,40);
  for(let i=0;i<n;i++) wav.writeInt16LE(Math.max(-32768,Math.min(32767,samples[i]*256)), 44+i*2);
  writeFileSync(filename, wav);
  console.log(`Wrote ${filename}`);
}

writeVeraWav('choir_F2_normal.wav', choirF2);
writeVeraWav('choir_F3_high.wav', choirF3);

// Zoh2 at high pitch C3
const zoh2C3 = resampleToVera(s04.data, 202, 2.0);
writeVeraWav('zoh2_C3_high.wav', zoh2C3);
