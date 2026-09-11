import fs from 'fs';

const buf = fs.readFileSync('BreakLine.mod');
let sOff = 1084 + (44 + 1) * 64 * 4 * 4;
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
  
  let kind = 'pulse';
  let wave = 0x20;
  let isDrum = false;
  let drumType = null;
  
  if (/kick|bassdrum/i.test(name) || (!isLooped && len < 6000 && zcr < 0.06 && rms > 30)) {
    isDrum = true;
    drumType = 'kick';
    kind = 'drum';
  } else if (/snare/i.test(name) || (!isLooped && len < 6000 && zcr >= 0.18)) {
    isDrum = true;
    drumType = 'snare';
    kind = 'drum';
  } else if (/hat|hh|cymbal/i.test(name) || zcr > 0.45) {
    isDrum = true;
    drumType = 'hihat';
    kind = 'drum';
  } else if (/tom/i.test(name) || (!isLooped && len < 6000 && zcr >= 0.06 && zcr < 0.18)) {
    isDrum = true;
    drumType = 'tom';
    kind = 'drum';
  } else {
    if (/bass/i.test(name) || cycleLen >= 200 || zcr < 0.03) {
      kind = 'bass';
      wave = 0x80; // Triangle wave for deep smooth bass
    } else if (/saw/i.test(name) || zcr > 0.1) {
      kind = 'saw';
      wave = 0x40; // Sawtooth
    } else if (/tri/i.test(name)) {
      kind = 'tri';
      wave = 0x80; // Triangle
    } else {
      kind = 'pulse';
      wave = 0x20; // 50% pulse
    }
  }
  
  samples.push({ id: i + 1, name, len, repStart, repLen, vol, isLooped, cycleLen, kind, wave, isDrum, drumType });
}

samples.forEach(s => {
  if (s.len > 0) {
    console.log(`s${String(s.id).padStart(2,'0')}: kind=${s.kind.padEnd(6)} wave=0x${s.wave.toString(16).padStart(2,'0')} cycle=${String(s.cycleLen).padStart(3)} drum=${(s.drumType || 'no').padEnd(5)} name='${s.name}'`);
  }
});
