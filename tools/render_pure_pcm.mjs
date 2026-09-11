#!/usr/bin/env node
/**
 * render_pure_pcm.mjs — 100% Pure PCM Renderer for space_debris.mod
 *
 * Renders all 4 channels of space_debris.mod using pure PCM playback of all
 * original Amiga instruments (with accurate PAL timing, volume slides,
 * tone portamento, vibrato, and ProTracker Effect 9 sample offset support).
 *
 * Outputs:
 *   space_debris_pure_pcm.wav (44.1 kHz 16-bit stereo)
 */

import { readFileSync, writeFileSync } from 'node:fs';

const AMIGA_PAL_CLOCK = 3546895;
const SAMPLE_RATE = 44100;

function parseMod(buf) {
  const chMap = { 'M.K.': 4, 'M!K!': 4, 'FLT4': 4, '4CHN': 4 };
  const sig = buf.length > 1084 ? buf.toString('ascii', 1080, 1084) : '';
  const channels = chMap[sig] || 4;

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
           channels, samples, orders, patterns };
}

function renderPurePcm(mod, outPcmPath = 'music/space_debris.pcm') {
  const chans = Array.from({ length: 4 }, () => ({
    curSample: 0, period: 0, vol: 0,
    portaUp: 0, portaDown: 0, toneSpeed: 0, toneTarget: 0,
    vibRate: 0, vibDepth: 0, vibPos: 0, volSlide: 0,
    cutTick: -1, delayTick: -1, retrig: -1,
  }));

  // 4 Amiga hardware voices: 1 per channel
  const activeVoices = [null, null, null, null];

  const ploop = { startPos: -1, startRow: 0, count: 0 };
  const st = {
    pos: 0, row: 0, tickInRow: 0,
    speed: 6, tempo: 125, hold: false, rowDelay: 0,
    jumpPos: -1, jumpRow: -1, pendingLoop: 0, done: false
  };

  const slotAt = (c) => mod.patterns[mod.orders[st.pos]]?.[st.row]?.[c];

  function triggerVoice(c, sample, period, vol, startPos = 0) {
    if (!sample || !sample.data || sample.data.length === 0) return;
    if (startPos >= sample.data.length) return;
    const p = period || 428;
    const step = (AMIGA_PAL_CLOCK / Math.max(1, p)) / SAMPLE_RATE;
    const loopStart = sample.repStart || 0;
    const loopLen   = sample.repLen   || 0;
    const hasLoop   = loopLen > 2;
    activeVoices[c] = {
      sample,
      pos: startPos,
      step,
      vol: vol / 64.0,
      loopStart,
      loopEnd: hasLoop ? loopStart + loopLen : sample.data.length,
      hasLoop,
      done: false,
    };
  }

  function applyNote(ch, slot, c) {
    const n = slot.sample || ch.curSample;
    const s = n ? mod.samples[n - 1] : null;
    const startPos = (slot.effect === 0x9) ? slot.param * 256 : 0;
    if (s) {
      const pVol = Math.max(0, Math.min(64, ch.vol));
      const period = slot.period || ch.period || 428;
      triggerVoice(c, s, period, pVol, startPos);
    }
    if (slot.period) {
      ch.period = slot.period;
      ch.vibPos = 0;
      ch.toneTarget = 0;
    }
  }

  function processRow() {
    st.pendingLoop = 0;
    for (let c = 0; c < 4; c++) {
      const ch = chans[c], slot = slotAt(c) || { sample: 0, period: 0, effect: 0, param: 0 };
      if (slot.sample) {
        ch.curSample = slot.sample;
        const s = mod.samples[slot.sample - 1];
        if (s) ch.vol = s.volume;
      }
      const { effect: e, param: x } = slot;
      ch.arp = 0; ch.volSlide = 0;
      ch.cutTick = -1; ch.delayTick = -1; ch.retrig = -1;

      switch (e) {
        case 0x1: if (x) ch.portaUp   = x; break;
        case 0x2: if (x) ch.portaDown = x; break;
        case 0x3: if (x) ch.toneSpeed = x; break;
        case 0x4: if (x) { ch.vibDepth = x & 0x0F; ch.vibRate = x >> 4; } break;
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
          if (ex === 0xC) ch.cutTick = xy;
          if (ex === 0xD) ch.delayTick = xy;
          if (ex === 0xE) { st.rowDelay = xy; st.hold = xy > 0; }
          break;
        }
        default:
          ch.portaUp = 0; ch.portaDown = 0; ch.toneSpeed = 0;
          ch.vibDepth = 0; ch.vibRate = 0;
          break;
      }

      if (slot.period && slot.effect === 3) ch.toneTarget = slot.period;
      else if (slot.period && ch.delayTick < 0) applyNote(ch, slot, c);
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
      if (ch.cutTick === st.tickInRow) ch.vol = 0;
      if (ch.delayTick === st.tickInRow) {
        const slot = slotAt(c);
        if (slot && slot.period) applyNote(ch, slot, c);
      }
    }
  }

  function advance() {
    st.tickInRow++;
    if (st.tickInRow >= st.speed) {
      st.tickInRow = 0;
      if (st.rowDelay > 0) {
        st.rowDelay--;
        if (st.rowDelay === 0) { st.hold = false; doRowAdvance(); }
      } else {
        doRowAdvance();
      }
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
    st.row++;
    if (st.row >= 64 || st.jumpPos >= 0) {
      const target = st.jumpPos >= 0 ? st.jumpPos : st.pos + 1;
      const targetRow = st.jumpPos >= 0 ? st.jumpRow : 0;
      if (target >= mod.orders.length) { st.done = true; return; }
      st.row = targetRow; st.pos = target; st.jumpPos = -1;
    }
  }

  const leftOut = [];
  const rightOut = [];

  // Panning matrix for 4 Amiga channels (Ch0, Ch3 = Left; Ch1, Ch2 = Right)
  // Cross-feed slightly to make headphones listening pleasant (75% / 25%)
  const panMatrix = [
    [0.80, 0.20], // Ch0 (Left)
    [0.20, 0.80], // Ch1 (Right)
    [0.20, 0.80], // Ch2 (Right)
    [0.80, 0.20], // Ch3 (Left)
  ];

  console.log('[PURE PCM] Rendering entire song at 44.1 kHz...');

  while (!st.done && leftOut.length < SAMPLE_RATE * 600) {
    const tickHz = (2 * st.tempo) / 5;
    const samplesPerTick = Math.round(SAMPLE_RATE / tickHz);

    if (st.tickInRow === 0) {
      if (st.hold) processTickEffects();
      else processRow();
    } else {
      processTickEffects();
    }

    // Update voice pitches and volumes for this tick
    for (let c = 0; c < 4; c++) {
      const v = activeVoices[c], ch = chans[c];
      if (v && !v.done) {
        let effPeriod = ch.period;
        if (ch.vibDepth) effPeriod += ch.vibDepth * 2 * Math.sin((ch.vibPos / 64) * 2 * Math.PI);
        v.step = (AMIGA_PAL_CLOCK / Math.max(1, effPeriod)) / SAMPLE_RATE;
        v.vol = Math.max(0, Math.min(64, ch.vol)) / 64.0;
      }
    }

    // Mix samples for this tick
    for (let s = 0; s < samplesPerTick; s++) {
      let mixL = 0, mixR = 0;

      for (let c = 0; c < 4; c++) {
        const v = activeVoices[c];
        if (!v || v.done) continue;

        const idx = Math.floor(v.pos);
        const data = v.sample.data;
        if (idx < data.length) {
          const raw = (data[idx] << 24) >> 24; // 8-bit signed (-128..127)
          const floatSample = (raw / 128.0) * v.vol;

          mixL += floatSample * panMatrix[c][0];
          mixR += floatSample * panMatrix[c][1];

          v.pos += v.step;
          if (v.hasLoop && v.pos >= v.loopEnd) {
            v.pos = v.loopStart + (v.pos - v.loopEnd) % (v.loopEnd - v.loopStart);
          }
        } else {
          v.done = true;
        }
      }

      leftOut.push(mixL);
      rightOut.push(mixR);
    }

    advance();
  }

  // Two-pass peak normalization to -0.3 dBFS (0.966)
  let maxPeak = 0;
  for (let i = 0; i < leftOut.length; i++) {
    const aL = Math.abs(leftOut[i]);
    const aR = Math.abs(rightOut[i]);
    if (aL > maxPeak) maxPeak = aL;
    if (aR > maxPeak) maxPeak = aR;
  }
  const norm = maxPeak > 0 ? 0.966 / maxPeak : 1.0;
  console.log(`[PURE PCM] Peak: ${maxPeak.toFixed(3)}, applying norm gain: ${norm.toFixed(3)}`);

  // 1. Output 44.1 kHz Stereo Preview WAV
  const numSamples = leftOut.length;
  const wavBuf = Buffer.alloc(44 + numSamples * 4);
  wavBuf.write('RIFF', 0);
  wavBuf.writeUInt32LE(36 + numSamples * 4, 4);
  wavBuf.write('WAVE', 8);
  wavBuf.write('fmt ', 12);
  wavBuf.writeUInt32LE(16, 16);
  wavBuf.writeUInt16LE(1, 20); // PCM
  wavBuf.writeUInt16LE(2, 22); // Stereo
  wavBuf.writeUInt32LE(SAMPLE_RATE, 24);
  wavBuf.writeUInt32LE(SAMPLE_RATE * 4, 28);
  wavBuf.writeUInt16LE(4, 32);
  wavBuf.writeUInt16LE(16, 34);
  wavBuf.write('data', 36);
  wavBuf.writeUInt32LE(numSamples * 4, 40);

  for (let i = 0; i < numSamples; i++) {
    const sL = Math.max(-32768, Math.min(32767, Math.round(leftOut[i] * norm * 32767)));
    const sR = Math.max(-32768, Math.min(32767, Math.round(rightOut[i] * norm * 32767)));
    wavBuf.writeInt16LE(sL, 44 + i * 4);
    wavBuf.writeInt16LE(sR, 44 + i * 4 + 2);
  }

  writeFileSync('space_debris_pure_pcm.wav', wavBuf);
  console.log(`[PURE PCM] Wrote space_debris_pure_pcm.wav (${(numSamples / SAMPLE_RATE).toFixed(1)}s, ${wavBuf.length} bytes)`);

  // 2. Output 8010.864 Hz Mono 8-bit Signed PCM for Apple II VERA Hardware (Rate 21)
  const VERA_RATE = 8010.864;
  const totalVeraSamples = Math.round(numSamples * VERA_RATE / SAMPLE_RATE);
  const pcmOut = Buffer.alloc(totalVeraSamples);

  // TPDF dither generator
  function tpdf() {
    return (Math.random() - Math.random());
  }

  for (let i = 0; i < totalVeraSamples; i++) {
    const srcIdx = (i * SAMPLE_RATE) / VERA_RATE;
    const idx0 = Math.floor(srcIdx);
    const idx1 = Math.min(numSamples - 1, idx0 + 1);
    const frac = srcIdx - idx0;

    // Mono mix = (L + R) / 2
    const mono0 = (leftOut[idx0] + rightOut[idx0]) * 0.5;
    const mono1 = (leftOut[idx1] + rightOut[idx1]) * 0.5;
    const mono = (mono0 + (mono1 - mono0) * frac) * norm;

    // Convert float (-1.0..1.0) to 8-bit signed (-128..127) with TPDF dither
    const dithered = mono * 127.0 + tpdf();
    const q = Math.max(-128, Math.min(127, Math.round(dithered)));
    pcmOut.writeInt8(q, i);
  }

  writeFileSync(outPcmPath, pcmOut);
  const blks = Math.ceil(pcmOut.length / 512);
  console.log(`[PURE PCM] Wrote ${outPcmPath} (${totalVeraSamples} bytes, ${blks} ProDOS blocks @ 8010 Hz)`);
}

const inputPath = process.argv[2] || 'music/space_debris.mod';
const outputPath = process.argv[3] || 'music/space_debris.pcm';
const mod = parseMod(readFileSync(inputPath));
renderPurePcm(mod, outputPath);
