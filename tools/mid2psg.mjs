#!/usr/bin/env node
/**
 * mid2psg.mjs — Standard MIDI File (.mid) → Apple II VERA PSG converter
 * Zero-dependency Node.js, matching the veratest / veramus build pipeline.
 *
 * Converts polyphonic MIDI music (e.g. Chopin piano works) into 60 Hz VERA PSG
 * register-write streams for Apple II playback (RAM player or disk streaming).
 *
 * Usage:
 *   node mid2psg.mjs <file.mid> [--synth=piano|hybrid|pulse] [--no-wav] [--no-psg] [--vol-step=N]
 *
 * Outputs:
 *   <name>.psg     — 60 Hz-frame PSG register-write event stream (compatible with psgstream / psgplay)
 *   <name>.wav     — 44.1 kHz stereo audio preview rendered from identical PSG hardware emulation
 *
 * VERA PSG channel layout (base $1F9C0):
 *   +0 freq_lo, +1 freq_hi, +2 ctrl, +3 wave
 *   ctrl: bit7 = Right enable ($80), bit6 = Left enable ($40), bits5-0 = volume 0..63
 *         (PAN_L=$40, PAN_R=$80, PAN_C=$C0)
 *   wave: bits 7:6 = Waveform (00=Pulse, 01=Saw, 10=Triangle, 11=Noise), bits 5:0 = Pulse Width
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join, dirname } from 'node:path';

// ---------------- VERA PSG Constants & Calibration ----------------
const PSG_AUDIO_RATE = 25000000 / 512; // ≈ 48828.125 Hz internal audio clock
const PAN_L = 0x40, PAN_R = 0x80, PAN_C = 0xC0;

const VERA_WAVE_PULSE_50 = 0x20; // 00 (pulse), pw=32 (50% duty)
const VERA_WAVE_PULSE_25 = 0x10; // 00 (pulse), pw=16 (25% duty)
const VERA_WAVE_PULSE_12 = 0x08; // 00 (pulse), pw=8  (12.5% duty - warm resonant overtone)
const VERA_WAVE_PULSE_6 = 0x04; // 00 (pulse), pw=4  (6.25% duty - bright hammer transient strike)
const VERA_WAVE_SAW = 0x40; // 01 (sawtooth)
const VERA_WAVE_TRI = 0x80; // 10 (triangle)
const VERA_WAVE_NOISE = 0xC0; // 11 (noise)

function midiNoteToFreqN(midiNote, octaveShift = 0, detuneHz = 0) {
  const note = midiNote + octaveShift * 12;
  const f = 440 * Math.pow(2, (note - 69) / 12) + detuneHz;
  // VERA PSG hardware uses a 17-bit phase accumulator (% 0x20000 = 131072):
  return Math.max(0, Math.min(0xFFFF, Math.round(f * 131072 / PSG_AUDIO_RATE)));
}

// ---------------- MIDI Parser (Type 0 / 1) ----------------
function parseMidi(buf) {
  if (buf.length < 14 || buf.toString('ascii', 0, 4) !== 'MThd') {
    throw new Error('Not a valid MIDI file (missing MThd header)');
  }
  const headerLen = buf.readUInt32BE(4);
  const format = buf.readUInt16BE(8);
  const ntrks = buf.readUInt16BE(10);
  const division = buf.readUInt16BE(12);

  let p = 8 + headerLen;
  const tracks = [];
  while (p < buf.length) {
    if (p + 8 > buf.length) break;
    const magic = buf.toString('ascii', p, p + 4);
    const len = buf.readUInt32BE(p + 4);
    p += 8;
    if (magic === 'MTrk') {
      tracks.push(buf.subarray(p, p + len));
    }
    p += len;
  }
  return { format, ntrks, division, tracks };
}

function parseTrackEvents(trkBuf) {
  let p = 0, tick = 0, runningStatus = 0;
  const events = [];

  function readVarLen() {
    let val = 0;
    while (p < trkBuf.length) {
      const b = trkBuf[p++];
      val = (val << 7) | (b & 0x7F);
      if (!(b & 0x80)) break;
    }
    return val;
  }

  while (p < trkBuf.length) {
    const delta = readVarLen();
    tick += delta;
    let status = trkBuf[p];
    if (status & 0x80) {
      status = trkBuf[p++];
      runningStatus = status;
    } else {
      status = runningStatus;
    }

    if (status === 0xFF) {
      // Meta event
      const metaType = trkBuf[p++];
      const metaLen = readVarLen();
      const metaData = trkBuf.subarray(p, p + metaLen);
      p += metaLen;
      events.push({ tick, type: 'meta', metaType, metaData });
    } else if (status === 0xF0 || status === 0xF7) {
      // SysEx
      const sysexLen = readVarLen();
      p += sysexLen;
    } else {
      // Channel message
      const type = status >> 4;
      const ch = status & 0x0F;
      const d1 = trkBuf[p++];
      const d2 = (type === 0xC || type === 0xD) ? 0 : trkBuf[p++];
      events.push({ tick, type, ch, d1, d2 });
    }
  }
  return events;
}

// ---------------- CLI & Main ----------------
const argv = process.argv.slice(2);
const midiPath = argv.find(a => !a.startsWith('-'));
if (!midiPath) {
  console.log(`
Usage: node mid2psg.mjs <file.mid> [options]
Options:
  --synth=grand|piano|hybrid|pulse Sound style (default: grand - multi-voice detuned chorus, hammer transient, stereo spread)
  --no-wav                         Skip rendering .wav preview
  --no-psg                         Skip writing .psg stream file
  --vol-step=N                     Decay volume threshold (default: 6, saves disk blocks)
  --chorus=melody|all|off          Chorus allocation policy (default: melody)
  --octave=N                       Octave shift (default: 0)
  --max-ch=N                       Max polyphonic PSG voices (default: 16, 1..16)
  --loop                           Loop stream when finished
  --info                           Print MIDI track details
`);
  process.exit(1);
}

const synthMode = (argv.find(a => a.startsWith('--synth=')) || '--synth=pure').split('=')[1];
const chorusPolicy = (argv.find(a => a.startsWith('--chorus=')) || (synthMode === 'grand' ? '--chorus=melody' : '--chorus=off')).split('=')[1];
const noWav = argv.includes('--no-wav');
const noPsg = argv.includes('--no-psg');
const volStep = parseInt((argv.find(a => a.startsWith('--vol-step=')) || '--vol-step=6').split('=')[1], 10) || 6;
const octaveShift = parseInt((argv.find(a => a.startsWith('--octave=')) || '--octave=0').split('=')[1], 10) || 0;
const maxVoices = Math.min(16, Math.max(1, parseInt((argv.find(a => a.startsWith('--max-ch=')) || '--max-ch=16').split('=')[1], 10) || 16));
const loopFlag = argv.includes('--loop');
const infoOnly = argv.includes('--info');

const midiBuf = readFileSync(midiPath);
const parsedMidi = parseMidi(midiBuf);

// Merge tracks into a time-sorted event queue
const allEvents = [];
for (const trk of parsedMidi.tracks) {
  allEvents.push(...parseTrackEvents(trk));
}
allEvents.sort((a, b) => a.tick - b.tick);

// Build microsecond / second timeline handling all tempo changes
let usPerQuarter = 500000; // default 120 BPM
let curTick = 0;
let curSec = 0;
let noteCount = 0;

for (const ev of allEvents) {
  const dt = ev.tick - curTick;
  curSec += (dt * usPerQuarter) / (parsedMidi.division * 1000000);
  curTick = ev.tick;
  ev.time = curSec;

  if (ev.type === 'meta' && ev.metaType === 0x51 && ev.metaData.length >= 3) {
    usPerQuarter = (ev.metaData[0] << 16) | (ev.metaData[1] << 8) | ev.metaData[2];
  } else if (ev.type === 9 && ev.d2 > 0) {
    noteCount++;
  }
}

const totalDuration = curSec;
const baseName = basename(midiPath, extname(midiPath));
const outDir = dirname(midiPath);

console.log(`"${baseName}" | MIDI format ${parsedMidi.format} | ${parsedMidi.tracks.length} trks | ${noteCount} notes | ${totalDuration.toFixed(1)}s`);
if (infoOnly) process.exit(0);

// ---------------- Polyphonic PSG Voice Engine ----------------
const FPS = 60;
const totalFrames = Math.ceil(totalDuration * FPS) + 30; // +0.5s tail for acoustic release

const voices = Array.from({ length: maxVoices }, (_, i) => ({
  id: i,
  role: 'PRIMARY',    // 'PRIMARY' or 'CHORUS'
  parentNote: -1,
  note: -1,
  state: 'IDLE',      // 'IDLE', 'HOLD', 'RELEASE'
  keyHeld: false,
  vol: 0,
  baseVol: 0,
  freqWord: 0,
  targetFreq: 0,
  pan: PAN_C,
  wave: VERA_WAVE_TRI,
  age: 0,
  hammerFrames: 0,
  holdFrames: 0,
  decayRate: 0.20,
  isNewNote: false,
  lastSentFreq: -1,
  lastSentWave: -1,
  lastSentCtrl: -1,
}));

function allocVoice() {
  // 1. Idle voice
  let v = voices.find(x => x.state === 'IDLE');
  if (v) return v;

  // 2. Released overtone / body voices (quietest first)
  const relOvertones = voices.filter(x => x.state === 'RELEASE' && (x.role === 'CHORUS' || x.role === 'BASS_BODY'));
  if (relOvertones.length > 0) return relOvertones.reduce((m, x) => (x.vol < m.vol ? x : m));

  // 3. Active overtone / body voices in HOLD (secondary harmonics: sacrifice before real notes!)
  const actOvertones = voices.filter(x => x.role === 'CHORUS' || x.role === 'BASS_BODY');
  if (actOvertones.length > 0) return actOvertones.reduce((m, x) => (x.vol < m.vol ? x : m));

  // 4. Released primary notes (quietest first)
  const relPrimary = voices.filter(x => x.state === 'RELEASE');
  if (relPrimary.length > 0) {
    const nonBass = relPrimary.filter(x => x.note >= 48);
    if (nonBass.length > 0) return nonBass.reduce((m, x) => (x.vol < m.vol ? x : m));
    return relPrimary.reduce((m, x) => (x.vol < m.vol ? x : m));
  }

  // 5. Notes held ONLY by pedal (keyHeld === false, decaying background pad)
  const pedalOnly = voices.filter(x => !x.keyHeld);
  if (pedalOnly.length > 0) {
    const nonBassPedal = pedalOnly.filter(x => x.note >= 48);
    if (nonBassPedal.length > 0) return nonBassPedal.reduce((m, x) => (x.vol < m.vol ? x : m));
    return pedalOnly.reduce((m, x) => (x.vol < m.vol ? x : m));
  }

  // 6. Physically held keys: protect highest melody note and lowest bass
  let maxNote = Math.max(...voices.map(x => x.note));
  let minNote = Math.min(...voices.map(x => x.note));
  const middleHeld = voices.filter(x => x.note !== maxNote && x.note !== minNote);
  if (middleHeld.length > 0) return middleHeld.reduce((m, x) => (x.vol < m.vol ? x : m));

  return voices.reduce((m, x) => (x.vol < m.vol ? x : m));
}

let sustainPedal = false;
let evIdx = 0;
const frameEvents = [];
let totalPairs = 0;
let maxPairsPerFrame = 0;

for (let f = 0; f < totalFrames; f++) {
  const nextFrameTime = (f + 1) / FPS;

  // Process all MIDI events occurring within this frame window
  while (evIdx < allEvents.length && allEvents[evIdx].time < nextFrameTime) {
    const ev = allEvents[evIdx++];

    if (ev.type === 0xB) {
      // Control Change
      if (ev.d1 === 64) {
        // Sustain Pedal (Damper)
        sustainPedal = ev.d2 >= 64;
        if (!sustainPedal) {
          // When pedal released, all keys not physically held down trigger damper release
          for (const v of voices) {
            if (v.state === 'HOLD' && !v.keyHeld) {
              v.state = 'RELEASE';
            }
          }
        } else {
          // When pedal depressed again (half-pedaling/re-pedaling), catch vibrating strings so they keep ringing
          for (const v of voices) {
            if (v.state === 'RELEASE' && v.vol > 10) {
              v.state = 'HOLD';
            }
          }
        }
      } else if (ev.d1 === 120 || ev.d1 === 123) {
        // All Sound Off / All Notes Off
        for (const v of voices) {
          v.keyHeld = false;
          v.state = 'RELEASE';
        }
      }
    } else if (ev.type === 9 && ev.d2 > 0) {
      // Note On
      const note = ev.d1;
      const vel = ev.d2;
      const norm = Math.max(0, Math.min(1, vel / 127));

      if (ev.ch === 9) {
        // General MIDI Standard Percussion Channel (Channel 10 in 1-based index)
        const v1 = allocVoice();
        v1.role = 'DRUM';
        v1.note = note;
        v1.parentNote = note;
        v1.keyHeld = false; // drums are self-releasing one-shot hits
        v1.state = 'HOLD';
        v1.age = 0;
        v1.pan = PAN_C;
        v1.isNewNote = true;
        v1.hammerFrames = 0;

        if (note === 35 || note === 36) {
          // Acoustic / Electric Bass Drum (Kick)
          v1.wave = VERA_WAVE_TRI;
          v1.targetFreq = midiNoteToFreqN(36, 0, 0);
          v1.freqWord = v1.targetFreq;
          v1.baseVol = Math.min(63, Math.round(58 + 5 * norm));
          v1.vol = v1.baseVol;
          v1.decayRate = 3.5;
          v1.holdFrames = 1;
        } else if (note === 38 || note === 40 || note === 39) {
          // Acoustic / Electric Snare, Hand Clap
          v1.wave = VERA_WAVE_NOISE;
          v1.targetFreq = midiNoteToFreqN(74, 0, 0);
          v1.freqWord = v1.targetFreq;
          v1.baseVol = Math.min(63, Math.round(54 + 9 * norm));
          v1.vol = v1.baseVol;
          v1.decayRate = 3.8;
          v1.holdFrames = 0;
        } else if (note === 42 || note === 44) {
          // Closed Hi-Hat / Pedal Hi-Hat
          v1.wave = VERA_WAVE_NOISE;
          v1.targetFreq = midiNoteToFreqN(92, 0, 0);
          v1.freqWord = v1.targetFreq;
          v1.baseVol = Math.min(56, Math.round(44 + 12 * norm));
          v1.vol = v1.baseVol;
          v1.decayRate = 7.5; // crisp transient
          v1.holdFrames = 0;
        } else if (note === 46) {
          // Open Hi-Hat
          v1.wave = VERA_WAVE_NOISE;
          v1.targetFreq = midiNoteToFreqN(90, 0, 0);
          v1.freqWord = v1.targetFreq;
          v1.baseVol = Math.min(60, Math.round(48 + 12 * norm));
          v1.vol = v1.baseVol;
          v1.decayRate = 2.0;
          v1.holdFrames = 0;
        } else if (note === 49 || note === 51 || note === 57) {
          // Crash / Ride Cymbal
          v1.wave = VERA_WAVE_NOISE;
          v1.targetFreq = midiNoteToFreqN(82, 0, 0);
          v1.freqWord = v1.targetFreq;
          v1.baseVol = Math.min(62, Math.round(50 + 12 * norm));
          v1.vol = v1.baseVol;
          v1.decayRate = 1.2;
          v1.holdFrames = 0;
        } else if (note >= 41 && note <= 50) {
          // Floor / Mid / High Toms
          v1.wave = VERA_WAVE_TRI;
          v1.targetFreq = midiNoteToFreqN(note, 0, 0);
          v1.freqWord = v1.targetFreq;
          v1.baseVol = Math.min(63, Math.round(56 + 7 * norm));
          v1.vol = v1.baseVol;
          v1.decayRate = 2.8;
          v1.holdFrames = 0;
        } else {
          // Other percussion (shakers, tambourines, etc.)
          v1.wave = VERA_WAVE_NOISE;
          v1.targetFreq = midiNoteToFreqN(94, 0, 0);
          v1.freqWord = v1.targetFreq;
          v1.baseVol = Math.min(54, Math.round(42 + 10 * norm));
          v1.vol = v1.baseVol;
          v1.decayRate = 6.0;
          v1.holdFrames = 0;
        }
      } else {
        // Expressive dynamic range with classical melody voicing:
        // In classical piano, the right-hand melody (note >= 60) projects clearly above
        // the polyphonic accompaniment, while preserving full dynamic range from pp to fff.
        let baseVol;
        let holdFrames = 0;

        if (synthMode === 'pulse') {
          baseVol = Math.round(36 + 27 * Math.pow(norm, 0.5));
        } else if (synthMode === 'grand') {
          baseVol = Math.round(18 + 45 * Math.pow(norm, 0.65));
        } else {
          // Pure concert grand piano mode:
          if (note >= 60) {
            // Right-hand melody: bold, radiant concert grand projection (44..63, median ~58)
            baseVol = Math.min(63, Math.round(44 + 19 * Math.pow(norm, 0.35)));
            holdFrames = 7; // maintain peak volume for ~116ms so melody notes sing with acoustic power
          } else if (note < 48) {
            // Left-hand bass foundation (A0 to C3, e.g. Chopin's & Liszt's thunderous bass octaves):
            // Concert grand piano acoustic power (55..63) and extended hold time (~300ms)
            baseVol = Math.min(63, Math.round(55 + 8 * Math.pow(norm, 0.35)));
            holdFrames = (note < 36) ? 18 : 12;
          } else {
            // Left-hand middle arpeggio fill (Notes 48..59): lush, audible harmonic foundation (36..56)
            baseVol = Math.min(56, Math.round(36 + 20 * Math.pow(norm, 0.45)));
            holdFrames = 2;
          }
        }

        // Pitch mapping for sub-bass:
        // Sub-bass notes below C2 (note < 36, such as Note 25 / C#1) have their fundamental
        // at 34 Hz, which falls below speaker/ear cutoff and sounds extinguished ("突然熄滅").
        // Per user request ("一開始的那個低音就有, 拿那個過去不行嗎?"), we map notes < 36 up an octave
        // to match the opening bass foundation (Note 25 -> Note 37 C#2, Note 32 -> Note 44 G#2),
        // while also layering the deep 1f sub-bass octave for full acoustic range.
        const playNote = (note < 36) ? (note + 12) : note;

        // Consistent acoustic piano panning: Center ($C0)
        const pan = PAN_C;

        // Frequency-dependent acoustic decay:
        // Slower decay keeps piano strings resonating with warmth and volume (+20% sustained power)
        const noteClamped = Math.max(24, Math.min(96, note));
        const decayRate = 0.03 + (noteClamped - 24) * (0.12 / 72);

        // 1. Allocate PRIMARY voice
        const v1 = allocVoice();
        v1.role = 'PRIMARY';
        v1.note = note;
        v1.parentNote = note;
        v1.keyHeld = true;
        v1.state = 'HOLD';
        v1.age = 0;
        v1.decayRate = decayRate;
        v1.baseVol = baseVol;
        v1.vol = baseVol;
        v1.holdFrames = holdFrames;
        v1.pan = pan;
        v1.targetFreq = midiNoteToFreqN(playNote, octaveShift, 0);
        v1.freqWord = v1.targetFreq;

        if (synthMode === 'pulse') {
          v1.wave = VERA_WAVE_PULSE_25;
          v1.hammerFrames = 0;
        } else if (synthMode === 'grand') {
          v1.wave = VERA_WAVE_PULSE_6;
          v1.hammerFrames = 1;
          v1.vol = Math.min(63, baseVol + 5);
        } else {
          // Pure piano: 100% pure consistent triangle wave across all registers (low & high)
          // Never use pulse waves or bass synthesizer timbres: pure acoustic piano throughout!
          v1.wave = VERA_WAVE_TRI;
          v1.hammerFrames = 0;
        }
        v1.isNewNote = true;

        // 2. Allocate Acoustic Concert Grand Bass Resonance (for bass notes < 48)
        // On real 9-foot concert grand pianos, low copper-wound bass strings and the massive soundboard
        // radiate powerful acoustic body overtones at unison detune, sub-octave, and octave harmonics.
        // ALL harmonic partials use VERA_WAVE_TRI to maintain 100% pure acoustic piano timbre throughout!
        if (note < 48) {
          const overtones = [];
          if (note < 36) {
            // Ultra-low sub-bass (Note 25 C#1, Note 32 G#1, Note 31 G1):
            // Multi-oscillator grand piano soundboard resonance centered on the opening bass pitch (playNote):
            overtones.push({ noteOff: 0, detune: 0.35, volRatio: 0.98, hold: 16, decayMult: 1.0 }); // unison chorus body
            overtones.push({ noteOff: -12, detune: 0.0, volRatio: 0.98, hold: 18, decayMult: 0.9 }); // deep 34 Hz sub-octave
            overtones.push({ noteOff: 12, detune: 0.0, volRatio: 0.92, hold: 12, decayMult: 1.2 });  // octave overtone
            overtones.push({ noteOff: 7, detune: 0.0, volRatio: 0.85, hold: 10, decayMult: 1.4 });   // 5th overtone
          } else if (note < 44) {
            // Deep bass (C#2 to G#2, Notes 36..43):
            overtones.push({ noteOff: 0, detune: 0.35, volRatio: 0.95, hold: 12, decayMult: 1.0 }); // unison body
            overtones.push({ noteOff: 12, detune: 0.0, volRatio: 0.88, hold: 10, decayMult: 1.2 });  // octave
            overtones.push({ noteOff: 7, detune: 0.0, volRatio: 0.80, hold: 8, decayMult: 1.4 });   // 5th
          } else {
            // Mid-bass (A2 to B2, Notes 44..47):
            overtones.push({ noteOff: 0, detune: 0.35, volRatio: 0.90, hold: 8, decayMult: 1.0 });  // unison body
            overtones.push({ noteOff: 12, detune: 0.0, volRatio: 0.82, hold: 6, decayMult: 1.3 });  // octave
          }

          for (const ot of overtones) {
            const idleCount = voices.filter(x => x.state === 'IDLE').length;
            if (idleCount <= 2) break; // keep at least 2 voices free for right hand runs!
            const vOt = allocVoice();
            vOt.role = 'BASS_BODY';
            vOt.parentNote = note;
            vOt.note = playNote + ot.noteOff;
            vOt.keyHeld = true;
            vOt.state = 'HOLD';
            vOt.age = 0;
            vOt.decayRate = decayRate * ot.decayMult;
            vOt.baseVol = Math.max(16, Math.min(63, Math.round(baseVol * ot.volRatio)));
            vOt.vol = vOt.baseVol;
            vOt.holdFrames = ot.hold;
            vOt.hammerFrames = 0;
            vOt.pan = PAN_C;
            vOt.targetFreq = midiNoteToFreqN(playNote + ot.noteOff, octaveShift, ot.detune);
            vOt.freqWord = vOt.targetFreq;
            vOt.wave = VERA_WAVE_TRI;
            vOt.isNewNote = true;
          }
        }
      }

      // 3. Allocate CHORUS voice (only in explicit 'grand' mode when enabled)
      if (synthMode === 'grand' && chorusPolicy !== 'off') {
        const idleCount = voices.filter(x => x.state === 'IDLE').length;
        let shouldChorus = false;
        if (chorusPolicy === 'all') shouldChorus = (idleCount >= 2 && note >= 44);
        else if (chorusPolicy === 'melody') shouldChorus = (vel >= 72 && note >= 56 && idleCount >= 3);

        if (shouldChorus) {
          const v2 = allocVoice();
          v2.role = 'CHORUS';
          v2.parentNote = note;
          v2.note = note;
          v2.keyHeld = true;
          v2.state = 'HOLD';
          v2.age = 0;
          v2.decayRate = decayRate * 1.8;
          v2.baseVol = Math.max(10, Math.round(baseVol * 0.60));
          v2.vol = v2.baseVol;
          v2.hammerFrames = 0;
          v2.holdFrames = 0;
          v2.pan = PAN_C;
          v2.targetFreq = midiNoteToFreqN(note, octaveShift, 0.6);
          v2.freqWord = v2.targetFreq;
          v2.wave = VERA_WAVE_PULSE_12;
          v2.isNewNote = true;
        }
      }
    } else if (ev.type === 8 || (ev.type === 9 && ev.d2 === 0)) {
      // Note Off: release all matching voices (including acoustic resonance bodies) that were held down
      const note = ev.d1;
      for (const v of voices) {
        if ((v.note === note || v.parentNote === note) && v.keyHeld) {
          v.keyHeld = false;
          if (!sustainPedal) {
            v.state = 'RELEASE';
          }
        }
      }
    }
  }

  // Calculate volume envelopes and emit register updates for this frame
  const writes = [];
  for (const v of voices) {
    if (v.state === 'IDLE') continue;
    v.age++;

    // Hammer attack transient completion:
    if (v.hammerFrames > 0) {
      v.hammerFrames--;
      if (v.hammerFrames === 0 && v.role === 'PRIMARY') {
        v.wave = VERA_WAVE_TRI;
        v.vol = v.baseVol;
      }
    }

    // Acoustic Piano Decay Simulation
    if (v.holdFrames > 0) {
      v.holdFrames--;
    } else if (v.state === 'HOLD') {
      v.vol = Math.max(0, v.vol - v.decayRate);
      if (v.vol <= 6) {
        v.vol = 0;
        v.state = 'IDLE';
      }
    } else if (v.state === 'RELEASE') {
      // Natural acoustic piano damper felt release:
      // Bass strings (note < 48) have larger mass and linger naturally for ~1s (0.4/frame).
      // Mid/treble strings (note >= 48) are cleanly dampened within ~100ms (5.5/frame) for crisp staccato!
      const relDecay = (v.note < 48) ? 0.40 : 5.5;
      v.vol = Math.max(0, v.vol - relDecay);
      if (v.vol <= 6) {
        v.vol = 0;
        v.state = 'IDLE';
      }
    }

    const qVol = Math.round(v.vol);
    const ctrl = (qVol > 0) ? (v.pan | qVol) : 0;
    const chBase = v.id * 4;

    if (v.isNewNote) {
      // Unconditionally write all 4 registers for a new note strike: guarantees NO silent notes!
      writes.push({ reg: chBase + 0, val: v.freqWord & 0xFF });
      writes.push({ reg: chBase + 1, val: (v.freqWord >> 8) & 0xFF });
      writes.push({ reg: chBase + 3, val: v.wave });
      writes.push({ reg: chBase + 2, val: ctrl });
      v.lastSentFreq = v.freqWord;
      v.lastSentWave = v.wave;
      v.lastSentCtrl = ctrl;
      v.isNewNote = false;
    } else {
      // Frequency update (pitch bend / vibrato if any)
      if (v.freqWord !== v.lastSentFreq) {
        writes.push({ reg: chBase + 0, val: v.freqWord & 0xFF });
        writes.push({ reg: chBase + 1, val: (v.freqWord >> 8) & 0xFF });
        v.lastSentFreq = v.freqWord;
      }
      // Waveform update (e.g. hammer transient -> resonant body)
      if (v.wave !== v.lastSentWave) {
        writes.push({ reg: chBase + 3, val: v.wave });
        v.lastSentWave = v.wave;
      }
      // Volume / Ctrl update during natural decay
      const lastVol = v.lastSentCtrl < 0 ? -99 : (v.lastSentCtrl & 0x3F);
      const diff = Math.abs(qVol - lastVol);
      const panChanged = (ctrl & 0xC0) !== (v.lastSentCtrl & 0xC0);
      if (qVol === 0 || panChanged || diff >= volStep) {
        if (ctrl !== v.lastSentCtrl) {
          writes.push({ reg: chBase + 2, val: ctrl });
          v.lastSentCtrl = ctrl;
        }
      }
    }
  }

  frameEvents.push(writes);
  totalPairs += writes.length;
  if (writes.length > maxPairsPerFrame) maxPairsPerFrame = writes.length;
}

// Trim excessive trailing silent frames (where all voices have reached volume 0)
let lastActiveFrame = 0;
for (let f = 0; f < frameEvents.length; f++) {
  if (frameEvents[f].length > 0) lastActiveFrame = f;
}
const effectiveFrames = Math.min(totalFrames, lastActiveFrame + 60); // 1.0s graceful acoustic tail

console.log(`→ ${effectiveFrames} frames (${(effectiveFrames / FPS).toFixed(1)}s @60Hz), ${totalPairs} reg writes, max/frame: ${maxPairsPerFrame}`);

// ---------------- Write .psg File ----------------
if (!noPsg) {
  // Format: [count u8][ (reg u8, val u8) x count ] ... [0xFF][loopFrame u16 LE]
  let estimatedSize = effectiveFrames + totalPairs * 2 + 3;
  const psgBuf = Buffer.alloc(estimatedSize);
  let pos = 0;

  for (let f = 0; f < effectiveFrames; f++) {
    const writes = frameEvents[f];
    psgBuf[pos++] = writes.length;
    for (const w of writes) {
      psgBuf[pos++] = w.reg;
      psgBuf[pos++] = w.val;
    }
  }

  // Terminator
  psgBuf[pos++] = 0xFF;
  const loopFrame = loopFlag ? 0 : 0;
  psgBuf.writeUInt16LE(loopFrame, pos);
  pos += 2;

  const finalPsg = psgBuf.subarray(0, pos);
  const psgOut = join(outDir, `${baseName}.psg`);
  writeFileSync(psgOut, finalPsg);
  const blks = Math.ceil(finalPsg.length / 512);
  console.log(`  wrote ${psgOut} (${finalPsg.length} bytes, ${blks} ProDOS blocks)`);
}

// ---------------- Render .wav File (VERA PSG Emulation) ----------------
if (!noWav) {
  const sampleRate = 44100;
  const numSamples = Math.floor((effectiveFrames / FPS) * sampleRate);
  const outL = new Float32Array(numSamples);
  const outR = new Float32Array(numSamples);

  const volumeLut = new Uint16Array([
    0, 4, 8, 12,
    16, 17, 18, 20, 21, 22, 23, 25, 26, 28, 30, 31,
    33, 35, 37, 40, 42, 45, 47, 50, 53, 56, 60, 63,
    67, 71, 75, 80, 85, 90, 95, 101, 107, 113, 120, 127,
    135, 143, 151, 160, 170, 180, 191, 202, 214, 227, 241, 255,
    270, 286, 303, 321, 341, 361, 382, 405, 429, 455, 482, 511,
  ]);

  const psgChs = Array.from({ length: 16 }, () => ({
    freq: 0,
    ctrl: 0,
    wave: 0,
    phase: 0,
    noiseLfsr: 1,
  }));

  const samplesPerFrame = sampleRate / FPS;
  let framePtr = 0;

  for (let s = 0; s < numSamples; s++) {
    const curFrame = Math.floor(s / samplesPerFrame);
    while (framePtr <= curFrame && framePtr < frameEvents.length) {
      for (const w of frameEvents[framePtr]) {
        const ch = w.reg >> 2;
        const field = w.reg & 3;
        if (field === 0) psgChs[ch].freq = (psgChs[ch].freq & 0xFF00) | w.val;
        else if (field === 1) psgChs[ch].freq = (psgChs[ch].freq & 0x00FF) | (w.val << 8);
        else if (field === 2) psgChs[ch].ctrl = w.val;
        else if (field === 3) psgChs[ch].wave = w.val;
      }
      framePtr++;
    }

    let mixL = 0, mixR = 0;
    for (let c = 0; c < 16; c++) {
      const ch = psgChs[c];
      const volIdx = ch.ctrl & 0x3F;
      if (volIdx === 0) continue;

      const left = (ch.ctrl & 0x40) !== 0;
      const right = (ch.ctrl & 0x80) !== 0;

      // 17-bit accumulator (% 0x20000 = 131072) driven at 48828.125 Hz
      const step = (ch.freq / 131072) * (PSG_AUDIO_RATE / sampleRate);
      ch.phase = (ch.phase + step) % 1.0;

      const waveType = (ch.wave >> 6) & 3;
      const pw = ch.wave & 0x3F;
      let amp = 0;

      if (waveType === 0) {
        // Pulse
        const duty = (pw + 1) / 64;
        amp = ch.phase < duty ? 1.0 : -1.0;
      } else if (waveType === 1) {
        // Saw
        amp = 2.0 * ch.phase - 1.0;
      } else if (waveType === 2) {
        // Triangle
        amp = ch.phase < 0.5 ? (4.0 * ch.phase - 1.0) : (3.0 - 4.0 * ch.phase);
      } else {
        // Noise
        amp = 0;
      }

      const volAmp = volumeLut[volIdx] / 511.0;
      const sig = amp * volAmp;
      if (left) mixL += sig;
      if (right) mixR += sig;
    }

    outL[s] = mixL;
    outR[s] = mixR;
  }

  // Master Dynamic Range with Soft Saturation:
  // Avoid global multi-voice peak attenuation which turns solo piano notes into inaudible whispers.
  // Using 3.0 voice reference headroom with analog tanh soft saturation gives loud, punchy, majestic piano sound!
  const refHeadroom = 3.0;
  const targetPeak = 30000;

  // Construct 16-bit stereo WAV buffer
  const wavBuf = Buffer.alloc(44 + numSamples * 4);
  wavBuf.write('RIFF', 0);
  wavBuf.writeUInt32LE(36 + numSamples * 4, 4);
  wavBuf.write('WAVE', 8);
  wavBuf.write('fmt ', 12);
  wavBuf.writeUInt32LE(16, 16);
  wavBuf.writeUInt16LE(1, 20); // PCM
  wavBuf.writeUInt16LE(2, 22); // stereo
  wavBuf.writeUInt32LE(sampleRate, 24);
  wavBuf.writeUInt32LE(sampleRate * 4, 28);
  wavBuf.writeUInt16LE(4, 32);
  wavBuf.writeUInt16LE(16, 34);
  wavBuf.write('data', 36);
  wavBuf.writeUInt32LE(numSamples * 4, 40);

  let offset = 44;
  let maxV = 0, sumSq = 0;
  for (let i = 0; i < numSamples; i++) {
    const satL = Math.tanh(outL[i] / refHeadroom);
    const satR = Math.tanh(outR[i] / refHeadroom);
    const sL = Math.max(-32767, Math.min(32767, Math.round(satL * targetPeak)));
    const sR = Math.max(-32767, Math.min(32767, Math.round(satR * targetPeak)));
    wavBuf.writeInt16LE(sL, offset);
    wavBuf.writeInt16LE(sR, offset + 2);
    offset += 4;
    const pk = Math.max(Math.abs(sL), Math.abs(sR));
    if (pk > maxV) maxV = pk;
    sumSq += (sL * sL + sR * sR) / 2;
  }
  const rms = Math.sqrt(sumSq / numSamples);
  const wavOut = join(outDir, `${baseName}.wav`);
  writeFileSync(wavOut, wavBuf);
  console.log(`  wrote ${basename(wavOut)} (${(wavBuf.length / (1024 * 1024)).toFixed(1)} MB preview, peak: ${maxV}/32767, RMS: ${(20 * Math.log10(rms / 32767)).toFixed(1)} dBFS)`);
}
