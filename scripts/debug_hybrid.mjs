/**
 * Debug render: capture first N seconds and log PCM RMS + max per frame
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

// ── Copy key constants/functions from render_hybrid.mjs ──
const VERA_AUDIO_RATE = 8010.864;
const PSG_AUDIO_RATE = 25000000 / 512;
const AMIGA_PAL_CLOCK = 3546895;
const PAN_L = 0x40, PAN_R = 0x80, PAN_C = 0xC0;
const VERA_WAVE_SAW = 0x40;
const VERA_WAVE_PULSE_50 = 0x20;
const PCM_VOL_SCALE = 0.55;

function getFreqN(period) {
  if (!period) return 0;
  const f = 55420.23 / Math.max(1, period);
  return Math.max(0, Math.min(0xFFFF, Math.round(f * 131072 / PSG_AUDIO_RATE)));
}

function parseMod(buf) {
  const sig = buf.length > 1084 ? buf.toString('ascii', 1080, 1084) : '';
  const channels = 4;
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
  const patOff = 1084, patSize = 64 * channels * 4;
  const patterns = [];
  for (let p = 0; p <= maxPat; p++) {
    const rows = [];
    for (let r = 0; r < 64; r++) {
      const row = [];
      for (let c = 0; c < channels; c++) {
        const o = patOff + p * patSize + (r * channels + c) * 4;
        const b0 = buf[o], b1 = buf[o + 1], b2 = buf[o + 2], b3 = buf[o + 3];
        row.push({ sample: ((b0 & 0xF0) | (b2 >> 4)), period: ((b0 & 0x0F) << 8) | b1, effect: b2 & 0x0F, param: b3 });
      }
      rows.push(row);
    }
    patterns.push(rows);
  }
  let sOff = patOff + (maxPat + 1) * patSize;
  for (const s of samples) {
    s.data = buf.subarray(sOff, Math.min(buf.length, sOff + s.length));
    sOff += s.length;
  }
  return { title: buf.toString('latin1', 0, 20).replace(/\0[\s\S]*$/, '').trim(), sig, channels, samples, orders, patterns };
}

const buf = readFileSync('space_debris.mod');
const mod = parseMod(buf);

// Classify
for (const s of mod.samples) {
  if (!s.length) continue;
  s.isDrum = /kick|bd\d*|bassdrum|snare|sd\d*|hat|hh|cymbal|shake|softshake|hup|vocalhit/i.test(s.name);
  s.isPcm = s.isDrum || /chord|choir|rezonat|zoh|sawsynth/i.test(s.name);
  if (!s.isPcm) s.isPcm = !/brass|bass|lead|pulse/i.test(s.name) && s.length > 0;
  s.hasLoop = s.repLen > 2;
}

// Mini-render: just track what's happening per channel for the first 30 seconds
const chans = [];
for (let c = 0; c < mod.channels; c++) {
  chans.push({ period: 0, vol: 0, curSample: 0,
    arp:0,portaUp:0,portaDown:0,toneTarget:0,toneSpeed:0,
    vibPos:0,vibDepth:0,vibRate:0,volSlide:0,cutTick:-1,delayTick:-1,
    isMutedByPcm:false });
}
const activePcm = new Array(mod.channels).fill(null);
let activeDrums = [];

const st = { pos:0,row:0,tickInRow:0,speed:6,tempo:125,jumpPos:-1,jumpRow:0,done:false };
const slotAt = (c) => mod.patterns[mod.orders[st.pos]]?.[st.row]?.[c];

function triggerSampleVoice(ci, s, period, vol) {
  if (!s || !s.data || !s.data.length) return;
  const p = period || 428;
  const step = (AMIGA_PAL_CLOCK / p) / VERA_AUDIO_RATE;
  activePcm[ci] = { sample:s, pos:0, step, vol:(vol/64)*PCM_VOL_SCALE,
    loopStart:s.repStart||0, loopEnd:s.hasLoop?s.repStart+s.repLen:s.data.length, hasLoop:s.hasLoop, done:false };
  console.log(`  [TRG] frame=${totalFrames} ch${ci} "${s.name}" period=${p} vol=${vol} step=${step.toFixed(4)} hasLoop=${s.hasLoop}`);
}

function applyNote(ch, slot, ci) {
  const n = slot.sample || ch.curSample;
  const s = n ? mod.samples[n-1] : null;
  if (!s) return;
  if (s.isPcm) {
    ch.isMutedByPcm = true;
    const vol = Math.max(1, Math.min(64, ch.vol));
    const period = slot.period || ch.period || 428;
    if (s.isDrum) {
      activeDrums.push({ sample:s, pos:0, step:(AMIGA_PAL_CLOCK/period)/VERA_AUDIO_RATE, vol:(vol/64)*PCM_VOL_SCALE, done:false });
    } else {
      triggerSampleVoice(ci, s, period, vol);
    }
    if (slot.period) ch.period = slot.period;
    return;
  }
  ch.isMutedByPcm = false;
  activePcm[ci] = null;
  if (slot.period) { ch.period = slot.period; ch.toneTarget = 0; }
}

function processRow() {
  for (let c = 0; c < mod.channels; c++) {
    const ch = chans[c];
    const slot = slotAt(c) || {sample:0,period:0,effect:0,param:0};
    if (slot.sample) {
      ch.curSample = slot.sample;
      const s = mod.samples[slot.sample-1];
      if (s) { if (s.isPcm) ch.vol = s.volume; else { if (s.volume>0) ch.vol=s.volume; else if (ch.vol===0) ch.vol=64; } }
    }
    const { effect:e, param:x } = slot;
    ch.arp=0;ch.portaUp=0;ch.portaDown=0;ch.volSlide=0;ch.vibDepth=0;ch.vibRate=0;ch.toneSpeed=0;ch.cutTick=-1;ch.delayTick=-1;
    switch(e) {
      case 0x1: ch.portaUp=x; break; case 0x2: ch.portaDown=x; break;
      case 0x3: ch.toneSpeed=x; break; case 0xA: ch.volSlide=x; break;
      case 0xC: ch.vol=Math.min(64,x); break;
      case 0xF: if(x>0){if(x<32)st.speed=Math.max(1,x);else st.tempo=Math.max(32,x);} break;
    }
    if (slot.period && e===3) ch.toneTarget=slot.period;
    else if (slot.period && ch.delayTick<0) applyNote(ch,slot,c);
  }
}

function processTickEffects() {
  for (let c = 0; c < mod.channels; c++) {
    const ch = chans[c];
    if (ch.portaUp) ch.period = Math.max(113, ch.period-ch.portaUp);
    if (ch.portaDown) ch.period = Math.min(856, ch.period+ch.portaDown);
    if (ch.toneSpeed && ch.toneTarget) {
      const d = ch.toneTarget - ch.period;
      ch.period += Math.abs(d)<=ch.toneSpeed ? d : Math.sign(d)*ch.toneSpeed;
    }
    if (ch.volSlide) {
      const up=ch.volSlide>>4, dn=ch.volSlide&0x0F;
      ch.vol = Math.max(0,Math.min(64,ch.vol+(up||!dn?up:-dn)));
    }
  }
}

function emitTick() {
  for (let c = 0; c < mod.channels; c++) {
    const ch = chans[c];
    const voice = activePcm[c];
    if (voice && ch.period && !voice.done) {
      const amigaRate = AMIGA_PAL_CLOCK / Math.max(1, ch.period);
      voice.step = amigaRate / VERA_AUDIO_RATE;
      voice.vol = (Math.min(64,ch.vol)/64)*PCM_VOL_SCALE;
    }
  }
}

function advanceRow() {
  st.row++;
  if (st.row >= 64 || st.jumpPos >= 0) {
    const target = st.jumpPos>=0 ? st.jumpPos : st.pos+1;
    const targetRow = st.jumpPos>=0 ? 0 : 0;
    if (target >= mod.orders.length) { st.done=true; return; }
    st.row=targetRow; st.pos=target; st.jumpPos=-1;
  }
}

let totalFrames = 0;
let acc = 0;
const LIMIT_FRAMES = 60 * 30; // 30 seconds

const pcmFrames = [];

while (!st.done && totalFrames < LIMIT_FRAMES) {
  const tickHz = (2 * st.tempo) / 5;
  acc += tickHz;
  while (acc >= 60 && !st.done) {
    if (st.tickInRow === 0) processRow();
    else processTickEffects();
    emitTick();
    st.tickInRow++;
    if (st.tickInRow >= st.speed) {
      st.tickInRow = 0;
      advanceRow();
    }
    acc -= 60;
  }

  const targetSamples = Math.round((totalFrames+1) * VERA_AUDIO_RATE / 60);
  const numSamples = targetSamples - (Math.round(totalFrames * VERA_AUDIO_RATE / 60));
  const pcmBuf = new Int8Array(numSamples);

  for (let si = 0; si < numSamples; si++) {
    let mix = 0;
    for (let ci = 0; ci < activePcm.length; ci++) {
      const v = activePcm[ci];
      if (!v || v.done) continue;
      const idx = Math.floor(v.pos);
      const data = v.sample.data;
      if (idx < data.length) {
        mix += ((data[idx]<<24)>>24) * v.vol;
        v.pos += v.step;
        if (v.hasLoop && v.pos >= v.loopEnd) v.pos = v.loopStart + (v.pos-v.loopEnd)%(v.loopEnd-v.loopStart);
      } else { v.done = true; }
    }
    for (const d of activeDrums) {
      if (d.done) continue;
      const idx = Math.floor(d.pos);
      if (idx < d.sample.data.length) { mix += ((d.sample.data[idx]<<24)>>24)*d.vol; d.pos+=d.step; }
      else d.done = true;
    }
    activeDrums = activeDrums.filter(d => !d.done);
    pcmBuf[si] = Math.max(-128, Math.min(127, Math.round(mix)));
  }
  pcmFrames.push(pcmBuf);
  totalFrames++;
}

console.log(`Rendered ${totalFrames} frames (${(totalFrames/60).toFixed(1)}s)`);

// Show per-second RMS
for (let sec = 0; sec < 30; sec++) {
  const frames = pcmFrames.slice(sec*60, (sec+1)*60);
  let sumSq = 0, cnt = 0, maxAmp = 0;
  for (const f of frames) { for (const v of f) { sumSq += v*v; cnt++; maxAmp = Math.max(maxAmp, Math.abs(v)); } }
  const rms = cnt ? Math.sqrt(sumSq/cnt) : 0;
  console.log(`  sec ${String(sec).padStart(2)}: RMS=${rms.toFixed(2).padStart(6)} max=${String(maxAmp).padStart(3)}`);
}

// Write 30s WAV
const SR = 44100;
const SPF = Math.round(SR/60);
const allWav = [];
for (let fi = 0; fi < pcmFrames.length; fi++) {
  const pcm = pcmFrames[fi];
  for (let s = 0; s < SPF; s++) {
    const pcmIdx = Math.min(pcm.length-1, Math.floor((s/SPF)*pcm.length));
    const amp = pcm[pcmIdx]/128;
    allWav.push(amp, amp);
  }
}
const numS = allWav.length/2;
const wav = Buffer.alloc(44 + numS*4);
wav.write('RIFF',0); wav.writeUInt32LE(36+numS*4,4); wav.write('WAVE',8);
wav.write('fmt ',12); wav.writeUInt32LE(16,16); wav.writeUInt16LE(1,20); wav.writeUInt16LE(2,22);
wav.writeUInt32LE(SR,24); wav.writeUInt32LE(SR*4,28); wav.writeUInt16LE(4,32); wav.writeUInt16LE(16,34);
wav.write('data',36); wav.writeUInt32LE(numS*4,40);
for (let i = 0; i < numS; i++) {
  const L = Math.max(-32768,Math.min(32767,Math.round(allWav[i*2]*32767)));
  const R = Math.max(-32768,Math.min(32767,Math.round(allWav[i*2+1]*32767)));
  wav.writeInt16LE(L, 44+i*4); wav.writeInt16LE(R, 44+i*4+2);
}
writeFileSync('debug_30s.wav', wav);
console.log('Wrote debug_30s.wav');
