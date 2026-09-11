import fs from 'fs';

// Load BreakLine.mod
const buf = fs.readFileSync('BreakLine.mod');

// 1. Parse MOD
const sig = buf.toString('ascii', 1080, 1084);
const songLen = buf.readUInt8(950);
const orders = [...buf.slice(952, 952 + 128)].slice(0, songLen);
const maxPat = Math.max(...orders);

const patOff = 1084, patSize = 64 * 4 * 4;
let sOff = patOff + (maxPat + 1) * patSize;

const samples = [];
for (let i = 0; i < 31; i++) {
  const o = 20 + i * 30;
  const name = buf.toString('latin1', o, o + 22).replace(/\0[\s\S]*$/, '').trim();
  const len = buf.readUInt16BE(o + 22) * 2;
  const finetune = buf.readUInt8(o + 24) & 0x0F;
  const vol = Math.min(64, buf.readUInt8(o + 25));
  const repStart = buf.readUInt16BE(o + 26) * 2;
  const repLen = buf.readUInt16BE(o + 28) * 2;
  const data = len > 0 ? buf.subarray(sOff, sOff + len) : Buffer.alloc(0);
  sOff += len;

  let sumSq = 0, zc = 0;
  for (let j = 0; j < len; j++) {
    const v = (data[j] << 24) >> 24;
    sumSq += v * v;
    if (j > 0 && ((data[j-1] ^ data[j]) & 0x80)) zc++;
  }
  const rms = len > 0 ? Math.sqrt(sumSq / len) : 0;
  const zcr = len > 0 ? zc / len : 0;
  const isLooped = repLen > 2;

  let cycleLen = 32;
  if (isLooped && repLen >= 32) {
    const loop = data.subarray(repStart, repStart + repLen);
    let bestLag = 32, bestCorr = -1;
    for (let lag = 16; lag < Math.min(repLen / 2, 512); lag++) {
      let corr = 0;
      for (let k = 0; k < repLen - lag; k++) {
        corr += (loop[k] - 128) * (loop[k + lag] - 128);
      }
      corr /= (repLen - lag);
      if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
    }
    cycleLen = bestLag;
  }

  let kind = 'tonal';
  let drumType = null;
  let wave = 0x40; // Default saw

  if (/kick|bassdrum/i.test(name) || (!isLooped && len < 6000 && zcr < 0.06 && rms > 30)) {
    kind = 'drum';
    drumType = 'kick';
  } else if (/snare/i.test(name) || (!isLooped && len < 6000 && zcr >= 0.18)) {
    kind = 'drum';
    drumType = 'snare';
  } else if (/hat|hh|cymbal/i.test(name) || zcr > 0.45) {
    kind = 'drum';
    drumType = 'hihat';
  } else if (/tom/i.test(name) || (!isLooped && len < 6000 && zcr >= 0.06 && zcr < 0.18)) {
    kind = 'drum';
    drumType = 'tom';
  } else {
    // Tonal
    if (/bass/i.test(name) || (isLooped && cycleLen >= 200 && zcr < 0.03)) {
      wave = 0x80; // Triangle for warm deep bass
      kind = 'bass';
    } else if (/tri/i.test(name)) {
      wave = 0x80;
      kind = 'tri';
    } else if (/saw/i.test(name)) {
      wave = 0x40;
      kind = 'saw';
    } else if (/pulse|square/i.test(name) || cycleLen < 40) {
      wave = 0x20; // 50% pulse
      kind = 'pulse';
    } else {
      wave = 0x40; // rich saw
      kind = 'saw';
    }
  }

  // Calculate octave shift from cycle length relative to standard 32-sample single cycle
  let octShift = 0;
  if (kind !== 'drum' && isLooped && cycleLen > 40) {
    octShift = Math.round(Math.log2(cycleLen / 32));
  }

  samples.push({ id: i + 1, name, len, repStart, repLen, vol, isLooped, cycleLen, kind, drumType, wave, octShift });
}

console.log('Sample analysis:');
samples.forEach(s => {
  if (s.len > 0) {
    console.log(`s${String(s.id).padStart(2,'0')}: kind=${s.kind.padEnd(6)} octShift=${s.octShift} wave=0x${s.wave.toString(16).padStart(2,'0')} drum=${(s.drumType||'no').padEnd(5)} name='${s.name}'`);
  }
});
