#!/usr/bin/env node
/**
 * render_hybrid.mjs — ProTracker MOD → Apple II VERA Hybrid (PSG + PCM) Converter
 *
 * Separates drum/percussion tracks (BD1, SD1, SoftShake, Hup) into an 8010.864 Hz
 * 8-bit signed mono PCM stream, while converting melodic tracks (Bass, Lead, Chords)
 * into a 60Hz 16-channel VERA PSG event stream.
 *
 * Outputs:
 *   <name>.hyb — Interleaved hybrid stream for Apple II hybridstream.asm player
 *   <name>_hybrid.wav — 44.1 kHz stereo preview of PSG synth + PCM drums mixed together
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const VERA_AUDIO_RATE = 8010.864; // Rate divider 21 = 21 * 48828.125 / 128 ≈ 8010.864 Hz
const PSG_AUDIO_RATE = 25000000 / 512; // ≈ 48828.125 Hz
const AMIGA_PAL_CLOCK = 3546895; // PAL Amiga color clock

const PAN_L = 0x40, PAN_R = 0x80, PAN_C = 0xC0;
const VERA_WAVE_PULSE_50 = 0x20;
const VERA_WAVE_SAW      = 0x40;
const VERA_WAVE_TRI      = 0x80;
const VERA_WAVE_NOISE    = 0xC0;

// Volume mix constants — tune these to balance PCM vs PSG
const PCM_VOL_SCALE  = 0.70;   // Overall PCM amplitude (drums + sample voices)
const PSG_WAV_SCALE  = 0.40;   // PSG voices in WAV preview mix
const PCM_WAV_BOOST  = 1.0;    // PCM in WAV preview (relative to PCM_VOL_SCALE)

function getFreqN(period, octShift = 0) {
  if (!period) return 0;
  const f = (55420.23 / Math.max(1, period)) * Math.pow(2, (-octShift * 12) / 12);
  return Math.max(0, Math.min(0xFFFF, Math.round(f * 131072 / PSG_AUDIO_RATE)));
}

function parseMod(buf) {
  const sig = buf.length > 1084 ? buf.toString('ascii', 1080, 1084) : '';
  const chMap = { 'M.K.': 4, 'M!K!': 4, 'FLT4': 4, '4CHN': 4 };
  const channels = chMap[sig];
  if (!channels) throw new Error(`Not a 4-channel MOD (signature "${sig}")`);

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
    s.data = buf.subarray(sOff, Math.min(buf.length, sOff + s.length));
    sOff += s.length;
  }

  return { title: buf.toString('latin1', 0, 20).replace(/\0[\s\S]*$/, '').trim(),
           sig, channels, samples, orders, patterns };
}

function classifyInstruments(samples) {
  for (const s of samples) {
    if (!s.length) continue;
    let kind = 'tonal';
    let wave = VERA_WAVE_SAW;
    let chordType = null;
    let isPcm = false;    // rendered as PCM voice (includes drums + sample-based tones)
    let isDrum = false;   // subset of isPcm: one-shot percussion (no loop)

    // ── True percussive one-shots → PCM (no loop) ──────────────────────────
    if (/kick|bd\d*|bassdrum/i.test(s.name) ||
        /snare|sd\d*/i.test(s.name) ||
        /hat|hh|cymbal|shake|softshake/i.test(s.name) ||
        /hup|vocalhit/i.test(s.name)) {
      isDrum = true;
      isPcm = true;
      kind = 'drum';

    // ── Complex Amiga sampled tones / synths / pads → PCM ──────────────────
    // Choir, Chord1, Zoh2, Rezonatix, SawSynth, SynBrass:
    // These instruments have complex acoustic harmonics, Ensoniq DOC filtering,
    // and subtle chorus that cannot be reproduced by raw PSG oscillators.
    // They are rendered into the high-fidelity 8010 Hz PCM track.
    } else if (/chord|choir|rezonat|zoh|sawsynth|brass/i.test(s.name)) {
      isPcm = true;
      kind = 'sample';
      if (/major/i.test(s.name))        chordType = 'major';
      else if (/minor/i.test(s.name))   chordType = 'minor';
      else if (/arrested/i.test(s.name)) chordType = 'sus4';

    // ── Dedicated Bass Line → VERA PSG Channel 0 ───────────────────────────
    // SuperHyperBass is a clean sub-bass fundamental. Playing the bass on PSG
    // delivers 48.8 kHz crisp low-end without 8-bit PCM quantization noise,
    // perfectly fulfilling the VERA Hybrid architecture (PSG Bass + PCM Samples).
    } else if (/bass/i.test(s.name)) {
      kind = 'bass';
      wave = VERA_WAVE_SAW;        // SuperHyperBass
      isPcm = false;
    } else if (/lead|pulse/i.test(s.name)) {
      kind = 'tonal';
      wave = VERA_WAVE_PULSE_50;
      isPcm = false;
    } else {
      // Unknown / misc sample → PCM to be safe
      isPcm = true;
      kind = 'sample';
    }

    s.isPcm = isPcm;
    s.isDrum = isDrum;  // legacy compat (isDrum ⊂ isPcm)
    s.kind = kind;
    s.wave = wave;
    s.chordType = chordType;
  }
}

function convertHybrid(mod) {
  const chans = [];
  for (let c = 0; c < mod.channels; c++) {
    chans.push({
      period: 0, instVol: 64, vol: 64, wave: VERA_WAVE_SAW, pan: PAN_C,
      curSample: 0, chordType: null,
      arp: 0, portaUp: 0, portaDown: 0, toneTarget: 0, toneSpeed: 0,
      vibRate: 0, vibDepth: 0, vibPos: 0, volSlide: 0,
      cutTick: -1, delayTick: -1, retrig: -1, retrigCount: 0,
      isMutedByPcm: false,
    });
  }

  // Active PCM voices:
  // 1. One voice per channel for tonal/looping samples (retriggered on new note)
  const activePcm = Array.from({ length: mod.channels }, () => null);
  // 2. Stacked pool for one-shot percussion/drums (can overlap)
  let activeDrums = [];

  // VERA PSG shadow state
  const psgShadow = Array.from({ length: 16 }, () => ({
    freq: -1, ctrl: -1, wave: -1,
  }));
  let pendingPsg = [];

  function emitVoice(v, freq, ctrl, wave) {
    const s = psgShadow[v];
    const fl = freq & 0xFF;
    const fh = (freq >> 8) & 0xFF;
    if (s.freq !== freq) {
      pendingPsg.push(v * 4 + 0, fl);
      pendingPsg.push(v * 4 + 1, fh);
      s.freq = freq;
    }
    if (s.ctrl !== ctrl) {
      pendingPsg.push(v * 4 + 2, ctrl);
      s.ctrl = ctrl;
    }
    if (s.wave !== wave) {
      pendingPsg.push(v * 4 + 3, wave);
      s.wave = wave;
    }
  }

  const ploop = { startPos: -1, startRow: 0, count: 0 };
  const st = {
    pos: 0, row: 0, tickInRow: 0,
    speed: 6, tempo: 125, hold: false, rowDelay: 0,
    jumpPos: -1, jumpRow: -1,
    pendingLoop: 0, done: false
  };

  const slotAt = (c) => mod.patterns[mod.orders[st.pos]]?.[st.row]?.[c];

  // Start a one-shot PCM drum voice
  function triggerDrum(sample, period, vol, startPos = 0) {
    if (!sample || !sample.data || sample.data.length === 0) return;
    if (startPos >= sample.data.length) return;
    const p = period || 428;
    const amigaRate = AMIGA_PAL_CLOCK / Math.max(1, p);
    const step = amigaRate / VERA_AUDIO_RATE;
    activeDrums.push({
      sample,
      pos: startPos,
      step,
      vol: (vol / 64) * PCM_VOL_SCALE,
      done: false,
    });
  }

  // Start/retrigger a sample-based PCM voice on a channel
  function triggerSampleVoice(chanIdx, sample, period, vol, startPos = 0) {
    if (!sample || !sample.data || sample.data.length === 0) return;
    if (startPos >= sample.data.length) return;
    const p = period || 428;
    const amigaRate = AMIGA_PAL_CLOCK / Math.max(1, p);
    const step = amigaRate / VERA_AUDIO_RATE;
    // Amiga loop: repStart/repLen in bytes
    const loopStart = sample.repStart || 0;
    const loopLen   = sample.repLen   || 0;
    const hasLoop   = loopLen > 2;
    // For looping voices (Choir, Chord1, etc.) that start vol=0 and use volume-slide
    // to fade in: ensure a minimum audible start volume so the portamento sweep
    // is heard from the first tick rather than being inaudible during the sweep.
    const effectiveVol = (hasLoop && sample.volume === 0) ? Math.max(6, vol) : vol;
    activePcm[chanIdx] = {
      sample,
      pos: startPos,
      step,
      vol: (effectiveVol / 64) * PCM_VOL_SCALE,
      loopStart,
      loopEnd: hasLoop ? loopStart + loopLen : sample.data.length,
      hasLoop,
      done: false,
    };
  }

  function applyNote(ch, slot, chanIdx) {
    const n = slot.sample || ch.curSample;
    const s = n ? mod.samples[n - 1] : null;
    const startPos = (slot.effect === 0x9) ? slot.param * 256 : 0;

    if (s && s.isPcm) {
      // PCM voice: mute PSG on this channel
      ch.isMutedByPcm = true;
      const pVol = Math.max(1, Math.min(64, ch.vol));
      const period = slot.period || ch.period || 428;
      if (s.isDrum) {
        // Cut any previous sample voice playing on this channel
        activePcm[chanIdx] = null;
        triggerDrum(s, period, pVol, startPos);
      } else {
        triggerSampleVoice(chanIdx, s, period, pVol, startPos);
      }
      if (slot.period) ch.period = slot.period;
      return;
    }

    // PSG tonal voice
    ch.isMutedByPcm = false;
    activePcm[chanIdx] = null; // stop any previous sample voice on this channel
    if (slot.period) {
      ch.period = slot.period;
      ch.vibPos = 0;
      ch.toneTarget = 0;
    }
  }

  function triggerSingle(c) {
    const ch = chans[c], slot = slotAt(c);
    if (!slot || !slot.period || slot.effect === 3) return;
    applyNote(ch, slot, c);
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
          // Always reset channel volume to sample's default when a note triggers.
          // For PCM samples: s.volume=0 means start silent (vol slides fade it in).
          // For PSG samples: if vol=0 keep previous vol to avoid silence.
          if (s.isPcm) {
            ch.vol = s.volume; // respect Amiga sample default (may be 0 for chord/choir)
          } else {
            if (s.volume > 0) ch.vol = s.volume;
            else if (ch.vol === 0) ch.vol = 64;
          }
        }
      }

      const { effect: e, param: x } = slot;
      ch.arp = 0; ch.volSlide = 0;
      ch.cutTick = -1; ch.delayTick = -1; ch.retrig = -1; ch.retrigCount = 0;
      // NOTE: portaUp/portaDown/toneSpeed/vibDepth/vibRate are NOT cleared per row —
      // ProTracker "effect memory": effects 1/2/3/4 with param=0 reuse the previous speed.
      switch (e) {
        case 0x0: ch.arp = x; break;
        case 0x1: if (x) ch.portaUp   = x; break;   // effect memory: 0 = use last speed
        case 0x2: if (x) ch.portaDown = x; break;   // effect memory: 0 = use last speed
        case 0x3: if (x) ch.toneSpeed = x; break;   // effect memory: 0 = continue at same speed
        case 0x4: if (x) { ch.vibDepth = x & 0x0F; ch.vibRate = x >> 4; } break; // memory
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
        default:
          // For all other effects, clear the persistent portamento/vibrato speeds
          ch.portaUp = 0; ch.portaDown = 0; ch.toneSpeed = 0;
          ch.vibDepth = 0; ch.vibRate = 0;
          break;
      }

      if (slot.period && slot.effect === 3) ch.toneTarget = slot.period;
      else if (slot.period && ch.delayTick < 0) applyNote(ch, slot, c);
    }
  }

  function processTickEffects() {
    for (let c = 0; c < mod.channels; c++) {
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
      if (ch.cutTick === st.tickInRow) ch.vol = 0;
      if (ch.delayTick === st.tickInRow) triggerSingle(c);
    }
  }

  function emitTick() {
    const arpIdx = ['base', 'x', 'y'][st.tickInRow % 3];
    for (let c = 0; c < mod.channels; c++) {
      const ch = chans[c];

      // Update looping PCM sample voice pitch (period changes from effects)
      const voice = activePcm[c];
      if (voice && ch.period && !voice.done) {
        const amigaRate = AMIGA_PAL_CLOCK / Math.max(1, ch.period);
        voice.step = amigaRate / VERA_AUDIO_RATE;
        voice.vol = (Math.min(64, ch.vol) / 64) * PCM_VOL_SCALE;
      }

      let f = 0, ctrlVol = 0;
      if (ch.period && !ch.isMutedByPcm) {
        let effPeriod = ch.period;
        if (ch.vibDepth) effPeriod += ch.vibDepth * 2 * Math.sin((ch.vibPos / 64) * 2 * Math.PI);
        if (ch.arp) {
          const semi = arpIdx === 'base' ? 0 : arpIdx === 'x' ? (ch.arp >> 4) : (ch.arp & 0x0F);
          effPeriod /= Math.pow(2, semi / 12);
        }
        f = getFreqN(effPeriod);
        ctrlVol = Math.min(63, ch.vol);
      }
      emitVoice(c, f, ch.pan | ctrlVol, ch.wave);

      // PSG polyphonic chord expansion on Voices 8..15 — only for PSG tonal voices
      const v2 = 8 + c * 2;
      const v3 = 9 + c * 2;
      if (ch.chordType && f > 0 && ctrlVol > 0 && !ch.isMutedByPcm) {
        let semi2 = 4;
        if (ch.chordType === 'minor') semi2 = 3;
        else if (ch.chordType === 'sus4') semi2 = 5;
        else if (ch.chordType === 'sus2') semi2 = 2;
        const f2 = Math.min(0xFFFF, Math.round(f * Math.pow(2, semi2 / 12)));
        const f3 = Math.min(0xFFFF, Math.round(f * Math.pow(2, 7 / 12)));
        emitVoice(v2, f2, PAN_C | Math.max(1, Math.round(ctrlVol * 0.85)), ch.wave);
        emitVoice(v3, f3, PAN_C | Math.max(1, Math.round(ctrlVol * 0.75)), ch.wave);
      } else {
        emitVoice(v2, 0, PAN_C, ch.wave);
        emitVoice(v3, 0, PAN_C, ch.wave);
      }
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
      if (target >= mod.orders.length) { st.done = true; return; }
      st.row = targetRow; st.pos = target; st.jumpPos = -1;
    }
  }

  // Generate 60Hz frames (PSG events + PCM audio samples)
  const hybridFrames = [];
  let totalPcmRendered = 0;
  let acc = 0;

  while (!st.done && hybridFrames.length < 60 * 600) { // 10 min cap
    const tickHz = (2 * st.tempo) / 5;
    acc += tickHz;
    while (acc >= 60 && !st.done) {
      tick();
      acc -= 60;
    }

    const frameIdx = hybridFrames.length;
    const targetSamples = Math.round((frameIdx + 1) * VERA_AUDIO_RATE / 60);
    const numSamples = targetSamples - totalPcmRendered;
    totalPcmRendered += numSamples;

    // Render PCM voices for this frame:
    // 1. Looping sample-based voices (one per channel: Chord, Choir, Rezonatix, etc.)
    // 2. One-shot drum voices (stacked pool)
    const pcmSamples = new Int8Array(numSamples);
    for (let s = 0; s < numSamples; s++) {
      let mix = 0;

      // --- Looping channel voices ---
      for (let ci = 0; ci < activePcm.length; ci++) {
        const v = activePcm[ci];
        if (!v || v.done) continue;
        const idx = Math.floor(v.pos);
        const data = v.sample.data;
        if (idx < data.length) {
          const raw = (data[idx] << 24) >> 24; // 8-bit signed
          mix += raw * v.vol;
          v.pos += v.step;
          // Amiga loop: wrap back to loop start
          if (v.hasLoop && v.pos >= v.loopEnd) {
            v.pos = v.loopStart + (v.pos - v.loopEnd) % (v.loopEnd - v.loopStart);
          }
        } else {
          v.done = true;  // past sample end (no loop or loop exhausted)
        }
      }

      // --- One-shot drum voices ---
      for (const d of activeDrums) {
        if (d.done) continue;
        const idx = Math.floor(d.pos);
        if (idx < d.sample.data.length) {
          const raw = (d.sample.data[idx] << 24) >> 24;
          mix += raw * d.vol;
          d.pos += d.step;
        } else {
          d.done = true;
        }
      }
      activeDrums = activeDrums.filter(d => !d.done);

      pcmSamples[s] = Math.max(-128, Math.min(127, Math.round(mix)));
    }

    hybridFrames.push({
      psgEvents: pendingPsg,
      pcmSamples,
    });
    pendingPsg = [];
  }

  return hybridFrames;
}

// ---------------- Package into .HYB binary stream ----------------
function packageHybrid(hybridFrames) {
  // Prefill: first 4 frames of PCM (approx 534 bytes = ~66ms jitter margin)
  const prefillFrames = 4;
  let prefillBytes = 0;
  for (let i = 0; i < Math.min(prefillFrames, hybridFrames.length); i++) {
    prefillBytes += hybridFrames[i].pcmSamples.length;
  }

  const chunks = [];

  // Header:
  // [prefill_len : u16 LE]
  const hdr = Buffer.alloc(2);
  hdr.writeUInt16LE(prefillBytes, 0);
  chunks.push(hdr);

  // Prefill PCM bytes
  for (let i = 0; i < Math.min(prefillFrames, hybridFrames.length); i++) {
    chunks.push(Buffer.from(hybridFrames[i].pcmSamples.buffer, hybridFrames[i].pcmSamples.byteOffset, hybridFrames[i].pcmSamples.length));
  }

  // Stream frames:
  // For frame F (0..N-1):
  // [PSG_COUNT : u8]
  // [reg, val pairs : PSG_COUNT * 2 bytes]
  // [PCM_COUNT : u8]  (contains PCM audio for frame F + prefillFrames)
  // [PCM samples : PCM_COUNT bytes]
  for (let f = 0; f < hybridFrames.length; f++) {
    const cur = hybridFrames[f];
    // Look ahead for PCM by prefillFrames
    const futureIdx = f + prefillFrames;
    const pcm = futureIdx < hybridFrames.length ? hybridFrames[futureIdx].pcmSamples : new Int8Array(133);

    const psgLen = Math.floor(cur.psgEvents.length / 2);
    if (psgLen > 127) throw new Error(`PSG event count ${psgLen} exceeds 127`);

    const frameHeader = Buffer.alloc(1 + psgLen * 2 + 1);
    frameHeader[0] = psgLen;
    for (let i = 0; i < cur.psgEvents.length; i++) {
      frameHeader[1 + i] = cur.psgEvents[i];
    }
    frameHeader[1 + psgLen * 2] = pcm.length;
    chunks.push(frameHeader);
    chunks.push(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.length));
  }

  // Terminator: 0xFF
  chunks.push(Buffer.from([0xFF]));

  return Buffer.concat(chunks);
}

// ---------------- 44.1 kHz WAV Preview of Mixed PSG + PCM ----------------
function renderWavPreview(hybridFrames) {
  const SR = 44100;
  const SPF = Math.round(SR / 60);
  const st = new Array(64).fill(0);
  const phase = new Float64Array(16);
  const leftOut = [];
  const rightOut = [];

  for (const f of hybridFrames) {
    for (let i = 0; i < f.psgEvents.length; i += 2) {
      st[f.psgEvents[i]] = f.psgEvents[i + 1];
    }

    const pcm = f.pcmSamples;

    for (let s = 0; s < SPF; s++) {
      // 1. Synthesize PSG voices
      let psgL = 0, psgR = 0;
      for (let ch = 0; ch < 16; ch++) {
        const ctrl = st[ch * 4 + 2], vol = ctrl & 0x3F;
        if (!vol) continue;
        const N = st[ch * 4] | (st[ch * 4 + 1] << 8);
        phase[ch] += N * PSG_AUDIO_RATE / (131072 * SR);
        const p = phase[ch] - Math.floor(phase[ch]);
        const waveReg = st[ch * 4 + 3];
        const waveType = waveReg >> 6;
        const pw = waveReg & 0x3F;

        let sample = 0;
        if (waveType === 0) sample = p < ((pw + 1) / 64) ? 1 : -1; // Pulse
        else if (waveType === 1) sample = 2 * p - 1; // Saw
        else if (waveType === 2) sample = p < 0.5 ? 4 * p - 1 : 3 - 4 * p; // Triangle

        const amp = (vol / 63) * sample;
        if (ctrl & 0x40) psgL += amp;
        if (ctrl & 0x80) psgR += amp;
      }

      // 2. Resample PCM stream to 44.1 kHz (drums + sample voices already mixed at VERA_AUDIO_RATE)
      const pcmIdx = Math.min(pcm.length - 1, Math.floor((s / SPF) * pcm.length));
      const pcmAmp = pcm.length > 0 ? (pcm[pcmIdx] / 128) * PCM_WAV_BOOST : 0;

      const totalL = (psgL * PSG_WAV_SCALE) + pcmAmp;
      const totalR = (psgR * PSG_WAV_SCALE) + pcmAmp;

      leftOut.push(totalL);
      rightOut.push(totalR);
    }
  }

  // Peak normalization to -0.2 dBFS (0.977)
  let maxPeak = 0;
  for (let i = 0; i < leftOut.length; i++) {
    const aL = Math.abs(leftOut[i]);
    const aR = Math.abs(rightOut[i]);
    if (aL > maxPeak) maxPeak = aL;
    if (aR > maxPeak) maxPeak = aR;
  }
  const norm = maxPeak > 0 ? 0.977 / Math.max(0.977, maxPeak) : 1.0;

  // Build WAV
  const numSamples = leftOut.length;
  const wav = Buffer.alloc(44 + numSamples * 4);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + numSamples * 4, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(2, 22); // Stereo
  wav.writeUInt32LE(SR, 24);
  wav.writeUInt32LE(SR * 4, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(numSamples * 4, 40);

  for (let i = 0; i < numSamples; i++) {
    const sL = Math.max(-32768, Math.min(32767, Math.round(leftOut[i] * norm * 32767)));
    const sR = Math.max(-32768, Math.min(32767, Math.round(rightOut[i] * norm * 32767)));
    wav.writeInt16LE(sL, 44 + i * 4);
    wav.writeInt16LE(sR, 44 + i * 4 + 2);
  }

  return wav;
}

// ---------------- Main Entry Point ----------------
const args = process.argv.slice(2);
const modPath = args[0] || 'space_debris.mod';
console.log(`[HYBRID] Loading "${modPath}"...`);

const modBuf = readFileSync(modPath);
const mod = parseMod(modBuf);
classifyInstruments(mod.samples);

console.log(`[HYBRID] Title: "${mod.title}" | Orders: ${mod.orders.length} | Channels: ${mod.channels}`);
console.log('[HYBRID] PCM instruments (drums + samples):');
mod.samples.filter(s => s.isPcm).forEach(s =>
  console.log(`  s${String(s.id).padStart(2, '0')} [${s.isDrum ? 'DRUM' : 'LOOP'}] "${s.name}" len=${s.length} vol=${s.volume} loop=${s.repLen}`));
console.log('[HYBRID] PSG instruments:');
mod.samples.filter(s => !s.isPcm && s.length > 0).forEach(s =>
  console.log(`  s${String(s.id).padStart(2, '0')} [PSG ] "${s.name}" len=${s.length} vol=${s.volume}`));

console.log('[HYBRID] Converting to hybrid PSG + PCM stream...');
const hybridFrames = convertHybrid(mod);
console.log(`[HYBRID] Rendered ${hybridFrames.length} frames (${(hybridFrames.length / 60).toFixed(1)}s, ${Math.floor(hybridFrames.length / 3600)}:${String(Math.floor((hybridFrames.length % 3600) / 60)).padStart(2, '0')}.${Math.floor((hybridFrames.length % 60) / 6)})`);

const hybBuf = packageHybrid(hybridFrames);
const hybName = basename(modPath).replace(/\.mod$/i, '') + '.hyb';
writeFileSync(hybName, hybBuf);
console.log(`[HYBRID] Wrote "${hybName}" (${hybBuf.length} bytes, ${Math.ceil(hybBuf.length / 512)} disk blocks)`);

if (!args.includes('--no-wav')) {
  console.log('[HYBRID] Rendering 44.1 kHz stereo preview WAV...');
  const wavBuf = renderWavPreview(hybridFrames);
  const wavName = basename(modPath).replace(/\.mod$/i, '') + '_hybrid.wav';
  writeFileSync(wavName, wavBuf);
  console.log(`[HYBRID] Wrote preview "${wavName}" (${wavBuf.length} bytes)`);
}

console.log('[HYBRID] Done!');
