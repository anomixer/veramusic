import fs from 'fs';

const buf = fs.readFileSync('BreakLine.mod');

// Constants
const PSG_AUDIO_RATE = 25000000 / 512; // 48828.125 Hz
const PAN_L = 0x40, PAN_R = 0x80, PAN_C = 0xC0;

// Parse MOD
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
  let wave = 0x40; // Saw

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
    if (/bass/i.test(name) || (isLooped && cycleLen >= 200 && zcr < 0.03)) {
      wave = 0x80; // Triangle wave for deep bass
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
      wave = 0x40; // saw
      kind = 'saw';
    }
  }

  let octShift = 0;
  if (kind !== 'drum' && isLooped && cycleLen > 40) {
    octShift = Math.round(Math.log2(cycleLen / 32));
  }

  samples.push({ id: i + 1, name, len, repStart, repLen, vol, isLooped, cycleLen, kind, drumType, wave, octShift });
}

// Convert
const patterns = [];
for (let p = 0; p <= maxPat; p++) {
  const rows = [];
  for (let r = 0; r < 64; r++) {
    const row = [];
    for (let c = 0; c < 4; c++) {
      const o = patOff + p * patSize + (r * 4 + c) * 4;
      row.push({
        sample: ((buf[o] & 0xF0) | (buf[o+2] >> 4)) || 0,
        period: ((buf[o] & 0x0F) << 8) | buf[o+1],
        effect: buf[o+2] & 0x0F,
        param: buf[o+3],
      });
    }
    rows.push(row);
  }
  patterns.push(rows);
}

// Frequency helper
// 1773447.5 / (period * 32) = 55420.23 / period
function getFreqN(period, octShift) {
  if (!period) return 0;
  const f = (55420.23 / period) / Math.pow(2, octShift);
  return Math.max(0, Math.min(0xFFFF, Math.round(f * 65536 / PSG_AUDIO_RATE)));
}

// State
const chans = Array.from({ length: 4 }, (_, c) => ({
  period: 0, vol: 64, wave: 0x40, pan: (c === 0 || c === 3) ? PAN_L : PAN_R,
  curSample: 0, octShift: 0,
  arp: 0, portaUp: 0, portaDown: 0, toneTarget: 0, toneSpeed: 0,
  vibPos: 0, vibDepth: 0, vibRate: 0, volSlide: 0,
  cutTick: -1, delayTick: -1,
}));

// Percussion channels:
// 4 = Kick (Triangle pitch drop)
// 5 = Snare (Noise)
// 6 = Hi-Hat (Noise)
const kick = { active: false, frame: 0, vol: 0 };
const snare = { active: false, frame: 0, vol: 0 };
const hihat = { active: false, frame: 0, vol: 0 };

const frames = [];
let pending = [];
const psgLast = new Array(64).fill(-1);
function emit(reg, val) {
  if (psgLast[reg] !== val) {
    psgLast[reg] = val;
    pending.push(reg, val);
  }
}
function emitVoice(ch, freqN, ctrl, wave) {
  emit(ch * 4 + 0, freqN & 0xFF);
  emit(ch * 4 + 1, (freqN >> 8) & 0xFF);
  emit(ch * 4 + 2, ctrl);
  emit(ch * 4 + 3, wave);
}

let pos = 0, row = 0, tickInRow = 0, speed = 6, tempo = 125;
let jumpPos = -1, jumpRow = 0, rowDelay = 0, hold = false;
let pendingLoop = 0, done = false;
const ploop = { startPos: -1, startRow: 0, count: 0 };

function processRow() {
  pendingLoop = 0;
  for (let c = 0; c < 4; c++) {
    const ch = chans[c];
    const slot = patterns[orders[pos]]?.[row]?.[c] || { sample: 0, period: 0, effect: 0, param: 0 };
    if (slot.sample) {
      ch.curSample = slot.sample;
      const s = samples[slot.sample - 1];
      if (s) {
        if (s.kind !== 'drum') {
          ch.vol = s.vol;
          ch.wave = s.wave;
          ch.octShift = s.octShift;
        }
      }
    }

    const { effect: e, param: x } = slot;
    ch.arp = 0; ch.portaUp = 0; ch.portaDown = 0; ch.volSlide = 0;
    ch.vibDepth = 0; ch.vibRate = 0; ch.toneSpeed = 0;
    ch.cutTick = -1; ch.delayTick = -1;

    switch (e) {
      case 0x0: ch.arp = x; break;
      case 0x1: ch.portaUp = x; break;
      case 0x2: ch.portaDown = x; break;
      case 0x3: ch.toneSpeed = x; break;
      case 0x4: ch.vibDepth = x & 0x0F; ch.vibRate = x >> 4; break;
      case 0x8: ch.pan = x <= 0x40 ? PAN_L : x >= 0xC0 ? PAN_R : PAN_C; break;
      case 0xA: ch.volSlide = x; break;
      case 0xC: ch.vol = Math.min(64, x); break;
      case 0xB: jumpPos = x; jumpRow = 0; break;
      case 0xD: jumpPos = pos + 1; jumpRow = (x >> 4) * 10 + (x & 0x0F); break;
      case 0xF: if (x > 0) { if (x < 32) speed = Math.max(1, x); else tempo = Math.max(32, x); } break;
      case 0xE: {
        const ex = x >> 4, xy = x & 0x0F;
        if (ex === 0x6) {
          if (xy === 0) { ploop.startPos = pos; ploop.startRow = row; }
          else if (pendingLoop === 0) pendingLoop = xy;
        }
        if (ex === 0xC) ch.cutTick = xy;
        if (ex === 0xD) ch.delayTick = xy;
        if (ex === 0xE) { rowDelay = xy; hold = xy > 0; }
        break;
      }
    }

    if (slot.period && slot.effect === 3) ch.toneTarget = slot.period;
    else if (slot.period) {
      const s = slot.sample ? samples[slot.sample - 1] : (ch.curSample ? samples[ch.curSample - 1] : null);
      if (s && s.kind === 'drum') {
        if (s.drumType === 'kick') {
          kick.active = true; kick.frame = 0; kick.vol = Math.min(63, ch.vol);
        } else if (s.drumType === 'snare' || s.drumType === 'tom') {
          snare.active = true; snare.frame = 0; snare.vol = Math.min(63, ch.vol);
        } else if (s.drumType === 'hihat') {
          hihat.active = true; hihat.frame = 0; hihat.vol = Math.min(63, ch.vol);
        }
      } else {
        ch.period = slot.period;
        ch.vibPos = 0;
        ch.toneTarget = 0;
      }
    }
  }
}

function processTickEffects() {
  for (let c = 0; c < 4; c++) {
    const ch = chans[c];
    if (ch.portaUp) ch.period = Math.max(113, ch.period - ch.portaUp);
    if (ch.portaDown) ch.period = Math.min(856, ch.period + ch.portaDown);
    if (ch.toneSpeed && ch.toneTarget) {
      const d = ch.toneTarget - ch.period;
      ch.period += Math.abs(d) <= ch.toneSpeed ? d : Math.sign(d) * ch.toneSpeed;
    }
    if (ch.vibRate) ch.vibPos = (ch.vibPos + ch.vibRate) & 0x3F;
    if (ch.volSlide) {
      const up = ch.volSlide >> 4, dn = ch.volSlide & 0x0F;
      ch.vol = Math.max(0, Math.min(64, ch.vol + (up || !dn ? up : -dn)));
    }
    if (ch.cutTick === tickInRow) ch.vol = 0;
  }
}

function emitTick() {
  const arpIdx = ['base', 'x', 'y'][tickInRow % 3];
  for (let c = 0; c < 4; c++) {
    const ch = chans[c];
    let freqN = 0, ctrlVol = 0;
    if (ch.period) {
      let effPeriod = ch.period;
      if (ch.vibDepth) effPeriod += ch.vibDepth * 2 * Math.sin((ch.vibPos / 64) * 2 * Math.PI);
      if (ch.arp) {
        const semi = arpIdx === 'base' ? 0 : arpIdx === 'x' ? (ch.arp >> 4) : (ch.arp & 0x0F);
        effPeriod /= Math.pow(2, semi / 12);
      }
      freqN = getFreqN(effPeriod, ch.octShift);
      ctrlVol = Math.min(63, ch.vol);
    }
    emitVoice(c, freqN, ch.pan | ctrlVol, ch.wave);
  }

  // Voice 4: Kick (Triangle, pitch sweep from 150 Hz -> 40 Hz)
  if (kick.active) {
    const sweepHz = Math.max(35, 140 - kick.frame * 25);
    const kN = Math.round(sweepHz * 65536 / PSG_AUDIO_RATE);
    const kVol = Math.max(0, Math.floor(kick.vol * (1 - kick.frame / 6)));
    emitVoice(4, kN, PAN_C | kVol, 0x80); // Triangle
    kick.frame++;
    if (kick.frame > 6) kick.active = false;
  } else {
    emitVoice(4, 0, PAN_C, 0x80);
  }

  // Voice 5: Snare (Noise, snappy decay)
  if (snare.active) {
    const sN = 0x0C00; // ~900 Hz noise
    const sVol = Math.max(0, Math.floor(snare.vol * Math.pow(0.65, snare.frame)));
    emitVoice(5, sN, PAN_C | sVol, 0xC0); // Noise
    snare.frame++;
    if (snare.frame > 8 || sVol < 2) snare.active = false;
  } else {
    emitVoice(5, 0, PAN_C, 0xC0);
  }

  // Voice 6: Hi-hat (High noise, short click)
  if (hihat.active) {
    const hN = 0x2800; // ~3 kHz crisp noise
    const hVol = Math.max(0, Math.floor(hihat.vol * Math.pow(0.5, hihat.frame)));
    emitVoice(6, hN, PAN_C | hVol, 0xC0); // Noise
    hihat.frame++;
    if (hihat.frame > 4 || hVol < 2) hihat.active = false;
  } else {
    emitVoice(6, 0, PAN_C, 0xC0);
  }
}

function tick() {
  if (tickInRow === 0) {
    if (hold) processTickEffects();
    else processRow();
  } else {
    processTickEffects();
  }
  emitTick();
  tickInRow++;
  if (tickInRow >= speed) {
    tickInRow = 0;
    if (rowDelay > 0) {
      rowDelay--;
      if (rowDelay === 0) { hold = false; advance(); }
    } else {
      advance();
    }
  }
}

function advance() {
  const x = pendingLoop; pendingLoop = 0;
  if (x > 0) {
    const target = (ploop.startPos < 0) ? 0 : ploop.startRow;
    if (target < row) {
      if (ploop.count < x) { ploop.count++; row = target; return; }
      ploop.count = 0;
    }
  }
  row++;
  if (row >= 64 || jumpPos >= 0) {
    const target = jumpPos >= 0 ? jumpPos : pos + 1;
    const targetRow = jumpPos >= 0 ? jumpRow : 0;
    row = targetRow; pos = target; jumpPos = -1;
    if (pos >= orders.length || pos === 1 && row === 0 && frames.length > 1000) {
      done = true;
    }
  }
}

// Generate 1800 frames (~30 seconds)
let acc = 0;
while (!done && frames.length < 1800) {
  const tickHz = (2 * tempo) / 5;
  acc += tickHz;
  while (acc >= 60 && !done) { tick(); acc -= 60; }
  frames.push(pending); pending = [];
}
console.log(`Generated ${frames.length} frames (${(frames.length/60).toFixed(1)}s)`);

// Render WAV preview
function renderWav(frames) {
  const SR = 44100, SPF = Math.round(SR / 60);
  const st = new Array(64).fill(0);
  const phase = new Float64Array(16);
  let noiseState = 1;
  const pcm = [];
  const push = (v) => pcm.push(Math.max(-1, Math.min(1, v)));

  for (const frame of frames) {
    for (let i = 0; i < frame.length; i += 2) st[frame[i]] = frame[i + 1];
    for (let s = 0; s < SPF; s++) {
      let L = 0, R = 0;
      noiseState = (noiseState << 1) | (((noiseState >> 1) ^ (noiseState >> 2) ^ (noiseState >> 4) ^ (noiseState >> 15)) & 1);
      noiseState &= 0xFFFF;
      const noiseVal = (noiseState & 1) ? 1 : -1;

      for (let ch = 0; ch < 16; ch++) {
        const ctrl = st[ch * 4 + 2], vol = ctrl & 0x3F;
        if (!vol) continue;
        const N = st[ch * 4] | (st[ch * 4 + 1] << 8);
        phase[ch] += N * PSG_AUDIO_RATE / (65536 * SR);
        const p = phase[ch] - Math.floor(phase[ch]);
        const waveReg = st[ch * 4 + 3];
        const waveType = waveReg >> 6;
        const pw = waveReg & 0x3F;

        let v = 0;
        if (waveType === 0) { // Pulse
          const duty = (pw + 1) / 64;
          v = p < duty ? 1 : -1;
        } else if (waveType === 1) { // Sawtooth
          v = 2 * p - 1;
        } else if (waveType === 2) { // Triangle
          v = 4 * Math.abs(p - 0.5) - 1;
        } else { // Noise
          v = noiseVal;
        }

        const sampleVal = v * (vol / 63);
        if (ctrl & 0x40) L += sampleVal;
        if (ctrl & 0x80) R += sampleVal;
      }
      push(L * 0.25); push(R * 0.25);
    }
  }

  const data = Buffer.alloc(pcm.length * 2);
  pcm.forEach((v, i) => data.writeInt16LE(Math.round(v * 32767), i * 2));
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + data.length, 4); hdr.write('WAVE', 8);
  hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20);
  hdr.writeUInt16LE(2, 22); hdr.writeUInt32LE(SR, 24); hdr.writeUInt32LE(SR * 4, 28);
  hdr.writeUInt16LE(4, 32); hdr.writeUInt16LE(16, 34);
  hdr.write('data', 36); hdr.writeUInt32LE(data.length, 40);
  return Buffer.concat([hdr, data]);
}

const wav = renderWav(frames);
fs.writeFileSync('BreakLine_test.wav', wav);
console.log('Wrote BreakLine_test.wav (' + (wav.length/1048576).toFixed(2) + ' MB)');
