#!/usr/bin/env node
/**
 * mod2psg.mjs — ProTracker MOD → Apple II VERA PSG converter (v0.3)
 * Zero-dependency Node.js, matching the veratest / slideshow build pipeline style.
 *
 * Usage:
 *   node mod2psg.mjs <file.mod> [--info] [--no-wav] [--no-psg] [--octave=N]
 *
 * Outputs:
 *   <name>.psg     — 60 Hz-frame PSG register-write event stream (FORMAT below)
 *   <name>.wav     — 44.1 kHz stereo preview rendered from the SAME event stream
 *   <name>_pcm/    — 8-bit signed PCM one-shots for drum instruments
 *                    (drop into VERA VRAM Bank 0 like Time Pilot PCM SFX)
 *
 * VERA PSG channel layout (matches veratest AGENTS.md, base $1F9C0):
 *   +0 freq_lo, +1 freq_hi, +2 ctrl, +3 wave
 *   ctrl: bit7 = Right enable, bit6 = Left enable, bits5-0 = volume 0..63
 *         (PAN_L=$40, PAN_R=$80, PAN_C=$C0 — same values as Time Pilot audio)
 *   wave: 0-7 pulse (12.5%.. duty), 8 sawtooth, 9 triangle, 0xA-0xF noise
 *
 * Event stream FORMAT (v0), one record per 60 Hz VSYNC frame:
 *   [count u8][ (reg u8, val u8) x count ]
 *   reg 0..63 = (channel * 4) + field   (player adds PSG base $1F9C0)
 *   Stream terminator: [0xFF][loopFrame u16 LE]
 *   A frame with count 0 = silence frame, advance one VSYNC.
 *
 * CALIBRATION:
 *   VERA PSG is a phase accumulator: f = N × 25 MHz / (512 × 65536) = N × 0.7451 Hz
 *   N = round(f × 512 × 65536 / 25_000_000).  --octave=N shifts all notes ±N semitones.
 *
 * v0 limitations (by design, iterate later):
 *   - Finetune byte ignored, glissando / invert loop ignored
 *   - Pattern delay EEx approximated, instrument 0xF "sync" ignored
 *   - Drums: name-based heuristic + always exported as PCM one-shots
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

// ---------------- calibration ----------------
// VERA PSG: 16-bit phase accumulator driven at internal audio rate = 25 MHz / 512.
// Output freq: f = N × audio_rate / 65536 = N × 25_000_000 / (512 × 65536) ≈ N × 0.745058 Hz
// Inverse:     N = round(f × 65536 / audio_rate)
const PSG_AUDIO_RATE = 25000000 / 512; // ≈ 48828.125 Hz — VERA internal audio clock
const PAN_L = 0x40, PAN_R = 0x80, PAN_C = 0xC0;

// VERA PSG Waveform register values (Bits 7:6 = Waveform, Bits 5:0 = Pulse Width)
const VERA_WAVE_PULSE_50 = 0x20; // Pulse (00), 50% duty (pw=32)
const VERA_WAVE_SAW      = 0x40; // Sawtooth (01), pw=0
const VERA_WAVE_TRI      = 0x80; // Triangle (10), pw=0
const VERA_WAVE_NOISE    = 0xC0; // Noise (11), pw=0

let OCTAVE_SHIFT = 0;

// Amiga PAL ProTracker period to frequency:
// Base rate = 3546895 / 64 = 55420.23 Hz (assuming 32-sample single-cycle base)
function getFreqN(period, octShift = 0) {
  if (!period) return 0;
  const f = (55420.23 / Math.max(1, period)) * Math.pow(2, (OCTAVE_SHIFT - octShift * 12) / 12);
  return Math.max(0, Math.min(0xFFFF, Math.round(f * 131072 / PSG_AUDIO_RATE)));
}

// ---------------- MOD parser ----------------
function parseMod(buf) {
  const sig = buf.length > 1084 ? buf.toString('ascii', 1080, 1084) : '';
  const chMap = { 'M.K.': 4, 'M!K!': 4, 'FLT4': 4, '4CHN': 4, '2CHN': 2,
                  '6CHN': 6, '8CHN': 8, 'FLT8': 8, 'OKTA': 8, 'OCTA': 8 };
  const channels = chMap[sig];
  if (!channels) throw new Error(`Not a 31-sample MOD (signature "${sig}")`);
  if (buf.length < 1084 + 64 * channels * 4) throw new Error('File truncated before pattern data');

  const samples = [];
  for (let i = 0; i < 31; i++) {
    const o = 20 + i * 30;
    samples.push({
      name: buf.toString('latin1', o, o + 22).replace(/\0[\s\S]*$/, '').trim(),
      length: buf.readUInt16BE(o + 22),          // in words
      finetune: buf.readUInt8(o + 24) & 0x0F,    // ignored v0
      volume: Math.min(64, buf.readUInt8(o + 25)),
      repStart: buf.readUInt16BE(o + 26),
      repLen: buf.readUInt16BE(o + 28),
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
        row.push({
          sample: ((b0 & 0xF0) | (b2 >> 4)) || 0,
          period: ((b0 & 0x0F) << 8) | b1,
          effect: b2 & 0x0F,
          param: b3,
        });
      }
      rows.push(row);
    }
    patterns.push(rows);
  }
  let sOff = patOff + (maxPat + 1) * patSize;
  for (const s of samples) {
    const n = s.length * 2;
    s.data = buf.subarray(sOff, Math.min(buf.length, sOff + n));
    sOff += n;
  }
  return { title: buf.toString('latin1', 0, 20).replace(/\0[\s\S]*$/, '').trim(),
           sig, channels, samples, orders, patterns };
}

function classifyInstruments(samples) {
  for (const s of samples) {
    if (!s.length) continue;
    let sumSq = 0, zc = 0;
    const len = s.data.length;
    for (let j = 0; j < len; j++) {
      const v = (s.data[j] << 24) >> 24;
      sumSq += v * v;
      if (j > 0 && ((s.data[j - 1] ^ s.data[j]) & 0x80)) zc++;
    }
    const rms = len > 0 ? Math.sqrt(sumSq / len) : 0;
    const zcr = len > 0 ? zc / len : 0;
    const isLooped = s.repLen > 2;

    let cycleLen = 32;
    if (isLooped && s.repLen >= 32) {
      const loop = s.data.subarray(s.repStart * 2, (s.repStart + s.repLen) * 2);
      let bestLag = 32, bestCorr = -1;
      for (let lag = 16; lag < Math.min(loop.length / 2, 512); lag++) {
        let corr = 0;
        for (let k = 0; k < loop.length - lag; k++) {
          corr += (loop[k] - 128) * (loop[k + lag] - 128);
        }
        corr /= (loop.length - lag);
        if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
      }
      cycleLen = bestLag;
    }

    let kind = 'tonal';
    let drumType = null;
    let wave = VERA_WAVE_SAW;
    let chordType = null;

    // 1. Identify chord instruments by name (Space Debris and other tracker chord samples)
    if (/major/i.test(s.name)) {
      chordType = 'major';
      wave = VERA_WAVE_SAW;
      kind = 'chord';
    } else if (/minor/i.test(s.name)) {
      chordType = 'minor';
      wave = VERA_WAVE_SAW;
      kind = 'chord';
    } else if (/arrested|sus4/i.test(s.name)) {
      chordType = 'sus4';
      wave = VERA_WAVE_SAW;
      kind = 'chord';
    } else if (/sus2/i.test(s.name)) {
      chordType = 'sus2';
      wave = VERA_WAVE_SAW;
      kind = 'chord';
    } else if (/brass/i.test(s.name)) {
      kind = 'tonal';
      wave = VERA_WAVE_SAW; // SynBrass lead!
    } else if (/lead/i.test(s.name)) {
      kind = 'tonal';
      wave = VERA_WAVE_PULSE_50;
    } else if (/choir|pad/i.test(s.name)) {
      kind = 'tonal';
      wave = VERA_WAVE_SAW;
    } else if (/bass/i.test(s.name)) {
      kind = 'bass';
      wave = VERA_WAVE_SAW; // Punchy slap bass!
    } else if (/hup|voice|vocal/i.test(s.name)) {
      kind = 'tonal';
      wave = VERA_WAVE_SAW;
    }
    // 2. Identify Drum types by name:
    else if (/kick|bd\d*|bassdrum/i.test(s.name)) {
      kind = 'drum';
      drumType = 'kick';
    } else if (/snare|sd\d*/i.test(s.name)) {
      kind = 'drum';
      drumType = 'snare';
    } else if (/hat|hh|cymbal|shake/i.test(s.name) || zcr > 0.45) {
      kind = 'drum';
      drumType = 'hihat';
    } else if (/tom/i.test(s.name)) {
      kind = 'drum';
      drumType = 'tom';
    }
    // 3. Fallback heuristics for un-named acoustic samples:
    else if (!isLooped && len < 6000 && zcr < 0.05 && rms > 30) {
      kind = 'drum';
      drumType = 'kick';
    } else if (!isLooped && len < 8000 && zcr >= 0.22) {
      kind = 'drum';
      drumType = 'snare';
    } else {
      if (isLooped && cycleLen >= 200 && zcr < 0.03) {
        wave = VERA_WAVE_TRI;
        kind = 'tri';
      } else if (/pulse|square/i.test(s.name) || cycleLen < 40) {
        wave = VERA_WAVE_PULSE_50;
        kind = 'pulse';
      } else {
        wave = VERA_WAVE_SAW;
        kind = 'saw';
      }
    }

    let octShift = 0;
    if (kind !== 'drum' && isLooped && cycleLen > 40) {
      octShift = Math.round(Math.log2(cycleLen / 32));
      if (octShift < 0) octShift = 0;
    }

    s.kind = kind;
    s.drumType = drumType;
    s.wave = wave;
    s.chordType = chordType;
    s.octShift = octShift;
    s.cycleLen = cycleLen;
  }
}

// ---------------- conversion engine ----------------
function convert(mod) {
  const chans = [];
  for (let c = 0; c < mod.channels; c++) {
    chans.push({
      period: 0, instVol: 64, vol: 64, wave: VERA_WAVE_SAW, pan: PAN_C,
      drumMuteCount: 0, curSample: 0, octShift: 0,
      arp: 0, portaUp: 0, portaDown: 0, toneTarget: 0, toneSpeed: 0,
      vibPos: 0, vibDepth: 0, vibRate: 0, offset: 0, volSlide: 0,
      cutTick: -1, retrig: -1, retrigCount: 0, delayTick: -1, delaySlot: null,
    });
  }

  // Percussion synthesizers (Voices 4..7)
  const kick = { active: false, frame: 0, vol: 0 };
  const snare = { active: false, frame: 0, vol: 0 };
  const hihat = { active: false, frame: 0, vol: 0 };
  const tom = { active: false, frame: 0, vol: 0 };

  const ploop = { startPos: -1, startRow: 0, count: 0 }; // E6x pattern loop state
  const psgLast = new Array(64).fill(null); // last emitted value per reg
  const frames = [];                        // per 60Hz frame: flat [reg,val,...]
  const orderFrame = {};                    // order position -> frame index at entry
  let loopFrame = 0, loopTarget = -1;
  let pending = [];
  const emit = (reg, val) => { if (psgLast[reg] !== val) { psgLast[reg] = val; pending.push(reg, val); } };
  const emitVoice = (ch, freqN, ctrl, wave) => {
    emit(ch * 4 + 0, freqN & 0xFF);
    emit(ch * 4 + 1, (freqN >> 8) & 0xFF);
    emit(ch * 4 + 2, ctrl);
    emit(ch * 4 + 3, wave);
  };

  const st = { pos: 0, row: 0, tickInRow: 0, speed: 6, tempo: 125,
               jumpPos: -1, jumpRow: 0, rowDelay: 0, hold: false,
               pendingLoop: 0, done: false };

  const slotAt = (c) => mod.patterns[mod.orders[st.pos]]?.[st.row]?.[c];

  function applyNote(ch, slot) {
    const n = slot.sample || ch.curSample;
    const s = n ? mod.samples[n - 1] : null;
    if (s && s.kind === 'drum') {
      ch.drumMuteCount = 3; // Mute melodic voice for 3 frames so it doesn't clash
      const dVol = Math.max(1, Math.min(63, ch.vol));
      if (s.drumType === 'kick') {
        kick.active = true; kick.frame = 0; kick.vol = dVol;
      } else if (s.drumType === 'snare') {
        snare.active = true; snare.frame = 0; snare.vol = dVol;
      } else if (s.drumType === 'hihat') {
        hihat.active = true; hihat.frame = 0; hihat.vol = dVol;
      } else if (s.drumType === 'tom') {
        tom.active = true; tom.frame = 0; tom.vol = dVol;
      }
      return;
    }
    ch.drumMuteCount = 0;
    if (slot.period) {
      ch.period = slot.period;
      ch.vibPos = 0;
      ch.toneTarget = 0;
    }
  }

  function triggerSingle(c) {
    const ch = chans[c], slot = slotAt(c);
    if (!slot || !slot.period || slot.effect === 3) return;
    applyNote(ch, slot);
  }

  function processRow() {
    st.pendingLoop = 0;
    for (let c = 0; c < mod.channels; c++) {
      const ch = chans[c], slot = slotAt(c) || { sample: 0, period: 0, effect: 0, param: 0 };
      if (slot.sample) {
        ch.curSample = slot.sample;
        const s = mod.samples[slot.sample - 1];
        if (s) {
          ch.instVol = s.volume;
          ch.wave = s.wave;
          ch.chordType = s.chordType || null;
          ch.octShift = s.octShift || 0;
          if (s.kind !== 'drum') {
            if (s.volume > 0) ch.vol = s.volume;
            else if (ch.vol === 0) ch.vol = 64;
          }
        }
      }

      const { effect: e, param: x } = slot;
      ch.arp = 0; ch.portaUp = 0; ch.portaDown = 0; ch.volSlide = 0;
      ch.vibDepth = 0; ch.vibRate = 0; ch.toneSpeed = 0;
      ch.cutTick = -1; ch.delayTick = -1; ch.retrig = -1; ch.retrigCount = 0;
      switch (e) {
        case 0x0: ch.arp = x; break;
        case 0x1: ch.portaUp = x; break;
        case 0x2: ch.portaDown = x; break;
        case 0x3: ch.toneSpeed = x; break;
        case 0x4: ch.vibDepth = x & 0x0F; ch.vibRate = x >> 4; break;
        case 0x8: ch.pan = x <= 0x40 ? PAN_L : x >= 0xC0 ? PAN_R : PAN_C; break;
        case 0x9: ch.offset = x * 256; break;
        case 0xA: ch.volSlide = x; break;
        case 0xC: ch.vol = Math.min(64, x); break;
        case 0xB: st.jumpPos = x; st.jumpRow = 0; break;
        case 0xD: st.jumpPos = st.pos + 1; st.jumpRow = (x >> 4) * 10 + (x & 0x0F); break;
        case 0xF: if (x > 0) { if (x < 32) st.speed = Math.max(1, x); else st.tempo = Math.max(32, x); } break;
        case 0xE: {
          const ex = x >> 4, xy = x & 0x0F;
          if (ex === 0x6) {
            if (xy === 0) { ploop.startPos = st.pos; ploop.startRow = st.row; }
            else if (st.pendingLoop === 0) st.pendingLoop = xy;
          }
          if (ex === 0x9) ch.retrig = xy;
          if (ex === 0xC) ch.cutTick = xy;
          if (ex === 0xD) ch.delayTick = xy;
          if (ex === 0xE) { st.rowDelay = xy; st.hold = xy > 0; }
          break;
        }
      }

      if (slot.period && slot.effect === 3) ch.toneTarget = slot.period;
      else if (slot.period && ch.delayTick < 0) applyNote(ch, slot);
    }
  }

  function processTickEffects() {
    for (let c = 0; c < mod.channels; c++) {
      const ch = chans[c], slot = slotAt(c) || {};
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
      if (ch.cutTick === st.tickInRow) ch.vol = 0;
      if (ch.delayTick === st.tickInRow) triggerSingle(c);
    }
  }

  function emitTick() {
    const arpIdx = ['base', 'x', 'y'][st.tickInRow % 3];
    for (let c = 0; c < mod.channels; c++) {
      const ch = chans[c];
      let f = 0, ctrlVol = 0;
      if (ch.period && ch.drumMuteCount === 0) {
        let effPeriod = ch.period;
        if (ch.vibDepth) effPeriod += ch.vibDepth * 2 * Math.sin((ch.vibPos / 64) * 2 * Math.PI);
        if (ch.arp) {
          const semi = arpIdx === 'base' ? 0 : arpIdx === 'x' ? (ch.arp >> 4) : (ch.arp & 0x0F);
          effPeriod /= Math.pow(2, semi / 12);
        }
        f = getFreqN(effPeriod, ch.octShift);
        ctrlVol = Math.min(63, ch.vol);
      }
      if (ch.drumMuteCount > 0) ch.drumMuteCount--;
      emitVoice(c, f, ch.pan | ctrlVol, ch.wave);

      // Polyphonic chord expansion on Voices 8..15 (VERA has 16 voices!)
      const v2 = 8 + c * 2;
      const v3 = 9 + c * 2;
      if (ch.chordType && f > 0 && ctrlVol > 0) {
        let semi2 = 4;
        if (ch.chordType === 'minor') semi2 = 3;
        else if (ch.chordType === 'sus4') semi2 = 5;
        else if (ch.chordType === 'sus2') semi2 = 2;
        const f2 = Math.min(0xFFFF, Math.round(f * Math.pow(2, semi2 / 12)));
        const f3 = Math.min(0xFFFF, Math.round(f * Math.pow(2, 7 / 12)));
        emitVoice(v2, f2, PAN_C | Math.max(1, Math.min(63, Math.round(ctrlVol * 0.95))), ch.wave);
        emitVoice(v3, f3, PAN_C | Math.max(1, Math.min(63, Math.round(ctrlVol * 0.90))), ch.wave);
      } else {
        emitVoice(v2, 0, PAN_C, ch.wave);
        emitVoice(v3, 0, PAN_C, ch.wave);
      }
    }

    // Voice 4: Kick (Triangle wave, downward frequency drop 160 Hz -> 40 Hz)
    if (kick.active) {
      const sweepHz = Math.max(40, 160 - kick.frame * 20);
      const kN = Math.round(sweepHz * 131072 / PSG_AUDIO_RATE);
      const kVol = Math.max(0, Math.floor(kick.vol * (1 - kick.frame / 8)));
      emitVoice(4, kN, PAN_C | kVol, VERA_WAVE_TRI);
      kick.frame++;
      if (kick.frame > 8 || kVol === 0) kick.active = false;
    } else {
      emitVoice(4, 0, PAN_C, VERA_WAVE_TRI);
    }

    // Voice 5: Snare (Noise wave, punchy decay)
    if (snare.active) {
      const sN = 0x1400; // ~1.5 kHz noise
      const sVol = Math.max(0, Math.floor(snare.vol * Math.pow(0.75, snare.frame)));
      emitVoice(5, sN, PAN_C | sVol, VERA_WAVE_NOISE);
      snare.frame++;
      if (snare.frame > 9 || sVol < 2) snare.active = false;
    } else {
      emitVoice(5, 0, PAN_C, VERA_WAVE_NOISE);
    }

    // Voice 6: Hi-hat (High noise wave, crisp click)
    if (hihat.active) {
      const hN = 0x3800; // ~4 kHz crisp noise
      const hVol = Math.max(0, Math.floor(hihat.vol * Math.pow(0.65, hihat.frame)));
      emitVoice(6, hN, PAN_C | hVol, VERA_WAVE_NOISE);
      hihat.frame++;
      if (hihat.frame > 5 || hVol < 2) hihat.active = false;
    } else {
      emitVoice(6, 0, PAN_C, VERA_WAVE_NOISE);
    }

    // Voice 7: Tom (Triangle wave, pitch sweep 180 Hz -> 70 Hz)
    if (tom.active) {
      const tHz = Math.max(70, 180 - tom.frame * 20);
      const tN = Math.round(tHz * 131072 / PSG_AUDIO_RATE);
      const tVol = Math.max(0, Math.floor(tom.vol * (1 - tom.frame / 6)));
      emitVoice(7, tN, PAN_C | tVol, VERA_WAVE_TRI);
      tom.frame++;
      if (tom.frame > 6 || tVol === 0) tom.active = false;
    } else {
      emitVoice(7, 0, PAN_C, VERA_WAVE_TRI);
    }
  }

  function tick() {
    if (st.tickInRow === 0) { if (st.hold) processTickEffects(); else processRow(); }
    else processTickEffects();
    emitTick();
    st.tickInRow++;
    if (st.tickInRow >= st.speed) {
      st.tickInRow = 0;
      if (st.rowDelay > 0) {
        st.rowDelay--;
        if (st.rowDelay === 0) { st.hold = false; doRowAdvance(); }
      }
      else doRowAdvance();
    }
  }

  function doRowAdvance() {
    const x = st.pendingLoop; st.pendingLoop = 0;
    if (x > 0) {
      const target = (ploop.startPos < 0) ? 0 : ploop.startRow;
      if (target < st.row) {
        if (ploop.count < x) { ploop.count++; st.row = target; return; }
        ploop.count = 0;
      }
    }
    advanceRow();
  }

  function advanceRow() {
    st.row++;
    if (st.row >= 64 || st.jumpPos >= 0) {
      const target = st.jumpPos >= 0 ? st.jumpPos : st.pos + 1;
      const targetRow = st.jumpPos >= 0 ? st.jumpRow : 0;
      if (st.jumpPos >= 0 && orderFrame[target] !== undefined) {
        loopFrame = orderFrame[target];
        loopTarget = target;
        st.done = true; return;
      }
      st.row = targetRow; st.pos = target; st.jumpPos = -1;
      if (st.pos >= mod.orders.length) { st.done = true; return; }
      if (orderFrame[st.pos] === undefined) orderFrame[st.pos] = frames.length;
    }
  }

  let acc = 0;
  orderFrame[0] = 0;
  while (!st.done && frames.length < 60 * 600) { // 10-minute safety cap
    const tickHz = (2 * st.tempo) / 5;
    acc += tickHz;
    while (acc >= 60 && !st.done) { tick(); acc -= 60; }
    frames.push(pending); pending = [];
  }
  return { frames, loopFrame, loopTarget, orderFrame };
}

// ---------------- WAV preview (accurate VERA PSG hardware simulation) ----------------
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
        phase[ch] += N * PSG_AUDIO_RATE / (131072 * SR);
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

// ---------------- CLI ----------------
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const opt = (n) => args.find((a) => a.startsWith(`--${n}`));
if (opt('octave')) OCTAVE_SHIFT = parseInt(opt('octave').split('=')[1], 10) || 0;
if (!file) { console.error('usage: node mod2psg.mjs <file.mod> [--info] [--no-wav] [--no-psg] [--octave=N]'); process.exit(1); }

const mod = parseMod(readFileSync(file));
classifyInstruments(mod.samples);
console.log(`"${mod.title}" | ${mod.sig} | ${mod.channels} ch | ${mod.orders.length} orders | max pat ${Math.max(...mod.orders)}`);
const used = mod.samples.map((s, i) => ({ i: i + 1, ...s })).filter((s) => s.length > 0);
for (const s of used) console.log(`  s${String(s.i).padStart(2, '0')} "${s.name}" ${s.length}w vol=${s.volume} → ${s.kind}`);
if (opt('info')) process.exit(0);

const { frames, loopFrame, loopTarget, orderFrame } = convert(mod);
const dur = (frames.length / 60).toFixed(1);
const visited = Object.keys(orderFrame).map(Number).sort((a, b) => a - b);
const unreachable = [];
for (let i = 0; i < mod.orders.length; i++) if (orderFrame[i] === undefined) unreachable.push(i);
console.log(`→ ${frames.length} frames (${dur}s @60Hz)` +
  (loopTarget >= 0 ? `, loop → order ${loopTarget} @ frame ${loopFrame}` : ', no loop (plays once)'));
if (unreachable.length) console.log(`  note: order pos ${unreachable[0]}..${unreachable[unreachable.length - 1]} never reached (${unreachable.length} pos, game-triggered sections?)`);
if (opt('verbose')) {
  const keys = visited;
  console.log('  per-order frames (pos:pattern startFrame-endFrame):');
  keys.forEach((p, i) => {
    const start = orderFrame[p];
    const end = (i + 1 < keys.length) ? orderFrame[keys[i + 1]] : frames.length;
    console.log(`    pos${p} (pat${mod.orders[p]}): ${start}-${end} = ${end - start}f (${((end - start) / 60).toFixed(1)}s)`);
  });
}

const dir = dirname(file);
const base = basename(file).replace(/\.[^.]+$/, '');
if (!opt('no-psg')) {
  // frames are flat [reg,val,...]; rebuild as records
  const recs = [];
  for (const f of frames) { recs.push(f.length / 2); for (const b of f) recs.push(b); }
  const buf = Buffer.from([...recs, 0xFF, loopFrame & 0xFF, (loopFrame >> 8) & 0xFF]);
  const outPsg = join(dir, `${base}.psg`);
  writeFileSync(outPsg, buf);
  console.log(`  wrote ${outPsg} (${buf.length} bytes)`);
}
if (!opt('no-wav')) {
  const wav = renderWav(frames);
  const outWav = join(dir, `${base}.wav`);
  writeFileSync(outWav, wav);
  console.log(`  wrote ${outWav} (${(wav.length / 1048576).toFixed(1)} MB preview)`);
}
const drums = used.filter((s) => s.kind === 'drum' && s.data.length > 0);
if (opt('export-pcm') && drums.length) {
  const pcmDir = join(dir, `${base}_pcm`);
  mkdirSync(pcmDir, { recursive: true });
  const manifest = [];
  for (const d of drums) {
    const fn = `s${String(d.i).padStart(2, '0')}_${d.name.replace(/[^a-z0-9]+/gi, '_')}.pcm`;
    writeFileSync(join(pcmDir, fn), d.data);
    manifest.push(`${fn}  len=${d.data.length}  suggested_rate=7813Hz(0x40 div)`);
  }
  writeFileSync(join(pcmDir, 'manifest.txt'), manifest.join('\n') + '\n');
  console.log(`  wrote ${pcmDir}/ (${drums.length} drum one-shot${drums.length > 1 ? 's' : ''})`);
}
