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

const synthMode = (argv.find(a => a.startsWith('--synth=')) || '--synth=psg').split('=')[1];
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
let allEvents = [];
for (const trk of parsedMidi.tracks) {
  allEvents.push(...parseTrackEvents(trk));
}
allEvents.sort((a, b) => a.tick - b.tick);

// Build microsecond / second timeline handling all tempo changes
let usPerQuarter = 500000; // default 120 BPM
let curTick = 0;
let curTime = 0.0;
const tempoMap = [{ tick: 0, time: 0.0, usPerQuarter: 500000 }];

for (const ev of allEvents) {
  if (ev.type === 'meta' && ev.metaType === 0x51) {
    // Set Tempo: 3 bytes microseconds per quarter note
    const d = ev.metaData;
    const us = (d[0] << 16) | (d[1] << 8) | d[2];
    const dticks = ev.tick - curTick;
    curTime += (dticks * (usPerQuarter / 1000000)) / parsedMidi.division;
    curTick = ev.tick;
    usPerQuarter = us;
    tempoMap.push({ tick: curTick, time: curTime, usPerQuarter });
  }
}

function tickToSeconds(targetTick) {
  let seg = tempoMap[0];
  for (let i = 1; i < tempoMap.length; i++) {
    if (tempoMap[i].tick <= targetTick) seg = tempoMap[i];
    else break;
  }
  const dticks = targetTick - seg.tick;
  return seg.time + (dticks * (seg.usPerQuarter / 1000000)) / parsedMidi.division;
}

for (const ev of allEvents) {
  ev.time = tickToSeconds(ev.tick);
}

const noteCount = allEvents.filter(e => e.type === 9 && e.d2 > 0).length;
const totalDuration = allEvents.length > 0 ? allEvents[allEvents.length - 1].time : 0;

const baseName = basename(midiPath, extname(midiPath));
const outDir = dirname(midiPath);
console.log(`"${baseName}" | MIDI format ${parsedMidi.format} | ${parsedMidi.tracks.length} trks | ${noteCount} notes | ${totalDuration.toFixed(1)}s`);
if (infoOnly) process.exit(0);

if (baseName.toLowerCase().includes('beatit')) {
  // 1. Fix intro guitar riff sour clash on the 6th note ("前面兩次的音符不對"):
  // In the intro riff (first 2 times, tick 24372 and 27432), Channel 5 had a stray note 52 (E3)
  // firing right before note 54 (F#3), creating a dirty/sour double-note clash against Channel 3's
  // note 66 (F#4) and bass note 42 (F#2). Muting this stray note makes all 3 guitars/bass lock in pure F# octaves!
  for (let i = 0; i < allEvents.length; i++) {
    const ev = allEvents[i];
    if (ev.ch === 5 && ev.d1 === 52 && (ev.tick === 24372 || ev.tick === 27432)) {
      ev.type = 0;
      ev.d2 = 0;
    }
  }

  // 2. Vocal melody "No one wants to be defeated" pitch lift (Ver. 5 - Blues Scoop Bend):
  // "Be" & "fea-": start at 73 (Db5) and bend smoothly up half-step to 74 (D5)
  // "No one wants to" and "de-" and "-ted": 71 (B4)
  const chorusStarts = [62784, 105792, 118080, 179520, 191808];
  const ch0Events = allEvents.filter(e => e.ch === 0 && (e.type === 8 || e.type === 9));

  for (const startTick of chorusStarts) {
    const onIdx = ch0Events.findIndex(e => e.type === 9 && e.d2 > 0 && Math.abs(e.tick - startTick) < 10);
    if (onIdx !== -1) {
      let curIdx = onIdx;
      for (let k = 0; k < 8; k++) {
        while (curIdx < ch0Events.length && !(ch0Events[curIdx].type === 9 && ch0Events[curIdx].d2 > 0)) curIdx++;
        if (curIdx >= ch0Events.length) break;
        const noteOn = ch0Events[curIdx];
        let offIdx = curIdx + 1;
        while (offIdx < ch0Events.length && !((ch0Events[offIdx].type === 8 || (ch0Events[offIdx].type === 9 && ch0Events[offIdx].d2 === 0)) && ch0Events[offIdx].d1 === noteOn.d1)) {
          offIdx++;
        }
        if (k === 4 || k === 6) {
          // "Be" (k=4) or "fea-" (k=6): start at 73 (Db5) and bend up to 74 (D5)
          noteOn.d1 = 73;
          noteOn.bendTarget = 74;
          if (offIdx < ch0Events.length) ch0Events[offIdx].d1 = 73;
        } else {
          // "No one wants to" and "de-" and "-ted" are all 71 (B4)
          noteOn.d1 = 71;
          if (offIdx < ch0Events.length) ch0Events[offIdx].d1 = 71;
        }
        curIdx++;
      }
    }
  }
}

const isNewAge = baseName.toLowerCase().includes('enya') || baseName.toLowerCase().includes('caribbean') || synthMode === 'newage';

if (isNewAge) {
  // Fix 0:09, 1:17, 2:11, 2:28, 2:45 phrase end notes ("句尾 平音~升音-平音~(錯) => 平音~升音-降音"):
  // In the original MIDI:
  // 0:09: tick 8092: D#4 (63), tick 8854: E4 (64), tick 9220: D#4 (63) (平音 - 錯) -> NoteOff: tick 10098
  // 1:17: tick 81804: D#4 (63), tick 82560: E4 (64), tick 82932: D#4 (63) (平音 - 錯) -> NoteOff: tick 83858
  // 2:11: tick 140544: E4 (64), tick 141328: F4 (65), tick 141708: E4 (64) (平音 - 錯) -> NoteOff: tick 142870
  // 2:28: tick 158972: E4 (64), tick 159774: F4 (65), tick 160134: E4 (64) (平音 - 錯) -> NoteOff: tick 161314
  // 2:45: tick 177420: E4 (64), tick 178200: F4 (65), tick 178546: E4 (64) (平音 - 錯) -> NoteOff: tick 179736
  const enyaVer = parseInt((argv.find(a => a.startsWith('--enya-ver=')) || '--enya-ver=2').split('=')[1], 10) || 2;
  let endNote = 61; // Default Ver 2: C#4 (61) — chosen by user ("平音~升音-降音")
  if (enyaVer === 1) endNote = 59; // Ver 1: B3 (59)
  else if (enyaVer === 3) endNote = 57; // Ver 3: A3 (57)
  else if (enyaVer === 4) endNote = 62; // Ver 4: D4 (62)

  const outroEndNote = (endNote === 61) ? 62 : (endNote === 59 ? 60 : (endNote === 57 ? 58 : 63)); // Ver 2 outro: D4 (62)

  for (const ev of allEvents) {
    if (ev.ch === 2) {
      // 0:06, 0:14, 1:14, 1:22 下滑4個音 (E4->D#4->C#4->B3), 第4個音 (B3, note 59) 不用短促伴奏音, 保持主旋律唱歌音色與延音:
      if (ev.d1 === 59 && (ev.tick === 6326 || ev.tick === 15520 || ev.tick === 80064 || ev.tick === 89294)) {
        ev.isMelody = true;
      }

      if (enyaVer === 5) {
        if (ev.tick === 8092 && ev.type === 9 && ev.d2 > 0) ev.d1 = 61;
        if (ev.tick === 8854 && ev.type === 9 && ev.d2 > 0) ev.d1 = 63;
        if (ev.tick === 9220 && ev.type === 9 && ev.d2 > 0) ev.d1 = 59;
        if (ev.tick === 10098 && (ev.type === 8 || (ev.type === 9 && ev.d2 === 0))) ev.d1 = 59;
        if (ev.tick === 81804 && ev.type === 9 && ev.d2 > 0) ev.d1 = 61;
        if (ev.tick === 82560 && ev.type === 9 && ev.d2 > 0) ev.d1 = 63;
        if (ev.tick === 82932 && ev.type === 9 && ev.d2 > 0) ev.d1 = 59;
        if (ev.tick === 83858 && (ev.type === 8 || (ev.type === 9 && ev.d2 === 0))) ev.d1 = 59;
      } else {
        // 0:09 phrase end
        if (ev.tick === 9220 && (ev.type === 9 && ev.d2 > 0)) ev.d1 = endNote;
        if (ev.tick === 10098 && (ev.type === 8 || (ev.type === 9 && ev.d2 === 0))) ev.d1 = endNote;
        // 1:17 phrase end
        if (ev.tick === 82932 && (ev.type === 9 && ev.d2 > 0)) ev.d1 = endNote;
        if (ev.tick === 83858 && (ev.type === 8 || (ev.type === 9 && ev.d2 === 0))) ev.d1 = endNote;
        // 2:11 phrase end (transposed section: E4 -> D4)
        if (ev.tick === 141708 && (ev.type === 9 && ev.d2 > 0)) ev.d1 = outroEndNote;
        if (ev.tick === 142870 && (ev.type === 8 || (ev.type === 9 && ev.d2 === 0))) {
          // Release note 141708 before note 142844 starts so 142844 plays its full 0.92s sustain (跟2:04一樣長, 不再短促)!
          ev.tick = 142843;
          ev.d1 = outroEndNote;
        }
        // 2:28 phrase end (transposed section: E4 -> D4)
        if (ev.tick === 160134 && (ev.type === 9 && ev.d2 > 0)) ev.d1 = outroEndNote;
        if (ev.tick === 161314 && (ev.type === 8 || (ev.type === 9 && ev.d2 === 0))) {
          ev.tick = 161287;
          ev.d1 = outroEndNote;
        }
        // 2:45 phrase end (transposed section: E4 -> D4)
        if (ev.tick === 178546 && (ev.type === 9 && ev.d2 > 0)) ev.d1 = outroEndNote;
        if (ev.tick === 179736 && (ev.type === 8 || (ev.type === 9 && ev.d2 === 0))) {
          ev.tick = 179713;
          ev.d1 = outroEndNote;
        }
      }
    }
  }

  // In the Outro (tick >= 134784, 2:05 onwards):
  // Filter out Track 3 (12-String Guitar) to completely eliminate all interfering 25% pulse-wave chimes!
  allEvents = allEvents.filter(ev => !(ev.ch === 3 && ev.tick >= 134784));

  // 2:05 Outro High Vocal Choir Harmony:
  // "1. 第一個超高超高 要跟隨主旋 (你有點慢了半拍) -> Beat 1 即刻切入
  //  2. nana 聲音要再大聲~ 跟主旋同等級
  //  3. 那個 平平 太低, 音高要再高一點 -> G5 (79)
  //  其他地方別亂chime, 後面依此類推"
  const addHighChoir = !argv.includes('--no-high-choir');
  if (addHighChoir) {
    const newChoirEvents = [];
    const startTick = 134784; // 2:05 in MIDI (starts with Eurus)
    const phraseStarts = [0, 8, 16, 24, 32, 40];
    // Bar 0: 超高=86 (D6), Bar 1: 高=81 (A5), Bar 2: 平=79 (G5, 調高2個半音匹配Gm且更加開闊)
    const phraseNotes = [86, 81, 79];

    for (const p of phraseStarts) {
      const fadeMult = (p >= 40) ? 0.6 : 1.0;

      for (let barOffset = 0; barOffset < 3; barOffset++) {
        const barIdx = p + barOffset;
        if (barIdx > 43) break;
        const mTick = startTick + barIdx * 1152;
        const note = phraseNotes[barOffset];

        // Beat 1: 第一個音 (跟隨主旋律同步在第一拍切入)
        const b1Tick = mTick + 0;
        const v1 = Math.round(96 * fadeMult);
        newChoirEvents.push({ tick: b1Tick, time: tickToSeconds(b1Tick), type: 9, ch: 6, d1: note, d2: v1, pan: PAN_C });
        newChoirEvents.push({ tick: b1Tick + 360, time: tickToSeconds(b1Tick + 360), type: 8, ch: 6, d1: note, d2: 64, pan: PAN_C });

        // Beat 2: 第二個音 (第二拍切入並持續延音貫穿第三拍)
        const b2Tick = mTick + 384;
        const v2 = Math.round(90 * fadeMult);
        newChoirEvents.push({ tick: b2Tick, time: tickToSeconds(b2Tick), type: 9, ch: 6, d1: note, d2: v2, pan: PAN_C });
        newChoirEvents.push({ tick: b2Tick + 720, time: tickToSeconds(b2Tick + 720), type: 8, ch: 6, d1: note, d2: 64, pan: PAN_C });
      }
    }
    allEvents.push(...newChoirEvents);
    allEvents.sort((a, b) => a.tick - b.tick);
  }
}

// ---------------- Polyphonic PSG Voice Engine ----------------
const FPS = 60;
const totalFrames = Math.ceil(totalDuration * FPS) + 30; // +0.5s tail for acoustic release

const distinctChannels = new Set(allEvents.filter(e => e.type === 9 && e.d2 > 0).map(e => e.ch));
const isEnsemble = distinctChannels.has(9) || distinctChannels.size >= 3;
const chProg = new Array(16).fill(0);
const chBend = new Array(16).fill(0);

const voices = Array.from({ length: maxVoices }, (_, i) => ({
  id: i,
  state: 'IDLE', // 'IDLE', 'HOLD', 'RELEASE'
  role: 'PRIMARY', // 'PRIMARY', 'CHORUS', 'BASS_BODY', 'DRUM', 'BASS', 'GUITAR_LEAD', 'GUITAR_RHYTHM', 'LEAD', 'CHORD', 'CHOIR', 'NEWAGE_BASS', 'ACOUSTIC_GTR', 'ARPEGGIO', 'PIANO'
  parentNote: -1,
  note: -1,
  ch: -1,
  targetFreq: 0,
  freqWord: 0,
  pitchDrop: 0,
  slideStep: 0,
  slideFrames: 0,
  pan: PAN_C,
  vol: 0,
  baseVol: 0,
  keyHeld: false,
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

function isBassVoice(x) {
  return x.role === 'BASS_BODY' || x.role === 'NEWAGE_BASS' || (x.parentNote >= 0 && x.parentNote < 48) || (x.role === 'PRIMARY' && x.note < 48);
}

function getInstrumentRole(ch, note) {
  if (ch === 9) return 'DRUM';
  const prog = chProg[ch];
  if (isNewAge) {
    if (ch === 1 || (prog >= 32 && prog <= 39)) return 'NEWAGE_BASS';
    if (ch === 6) return 'HIGH_CHOIR';
    if (ch === 4 || (prog >= 52 && prog <= 55)) return 'CHOIR';
    if (ch === 3 || prog === 24 || prog === 25) return 'ACOUSTIC_GTR';
    if (ch === 5 || prog === 7 || (prog >= 8 && prog <= 15)) return 'ARPEGGIO';
    if (ch === 2 || (prog >= 0 && prog <= 5)) return 'PIANO';
    return 'CHORD';
  }
  if (baseName.toLowerCase().includes('beatit')) {
    if (ch === 1 || (prog >= 32 && prog <= 39)) return 'BASS';
    if (ch === 3 || ch === 4 || prog === 29 || prog === 30) return 'GUITAR_LEAD';
    if (ch === 5 || ch === 6 || prog === 27 || prog === 28) return 'GUITAR_RHYTHM';
    if (ch === 0 || ch === 10 || (prog >= 52 && prog <= 55) || (prog >= 80 && prog <= 87)) return 'LEAD';
    return 'CHORD';
  }
  if (prog >= 32 && prog <= 39) return 'BASS';
  if (prog >= 24 && prog <= 31) return 'ACOUSTIC_GTR';
  if (prog >= 52 && prog <= 55) return 'CHOIR';
  if (prog >= 0 && prog <= 7) return 'PIANO';
  return 'CHORD';
}

function allocEnsembleVoice(role, ch) {
  // If BASS (monophonic bass lines e.g. Beat It): recycle existing voice on this channel
  if (role === 'BASS') {
    const prevBass = voices.find(x => x.ch === ch && x.state !== 'IDLE');
    if (prevBass) return prevBass;
  }

  // 1. Idle voice
  let v = voices.find(x => x.state === 'IDLE');
  if (v) return v;

  // 2. Released voices (quietest first, protect CHOIR and HIGH_CHOIR)
  const relVoices = voices.filter(x => x.state === 'RELEASE');
  if (relVoices.length > 0) {
    const nonChoir = relVoices.filter(x => x.role !== 'CHOIR' && x.role !== 'HIGH_CHOIR');
    if (nonChoir.length > 0) return nonChoir.reduce((m, x) => (x.vol < m.vol ? x : m));
    return relVoices.reduce((m, x) => (x.vol < m.vol ? x : m));
  }

  // 3. Non-critical background voices (CHORD / GUITAR_RHYTHM / ARPEGGIO) sounding > 6 frames
  const nonCrit = voices.filter(x => (x.role === 'CHORD' || x.role === 'GUITAR_RHYTHM' || x.role === 'ARPEGGIO') && x.age > 6);
  if (nonCrit.length > 0) return nonCrit.reduce((m, x) => (x.vol < m.vol ? x : m));

  // 4. Any voice that is not DRUM, BASS, or CHOIR, sounding > 8 frames
  const oldVoices = voices.filter(x => x.role !== 'DRUM' && x.role !== 'BASS' && x.role !== 'NEWAGE_BASS' && x.role !== 'CHOIR' && x.age > 8);
  if (oldVoices.length > 0) return oldVoices.reduce((m, x) => (x.vol < m.vol ? x : m));

  // 5. Any voice that is not a fresh drum hit (age > 2)
  const avail = voices.filter(x => !(x.role === 'DRUM' && x.age <= 2));
  if (avail.length > 0) return avail.reduce((m, x) => (x.vol < m.vol ? x : m));

  // 6. Last resort
  return voices.reduce((m, x) => (x.vol < m.vol ? x : m));
}

function allocVoice() {
  // 1. Idle voice
  let v = voices.find(x => x.state === 'IDLE');
  if (v) return v;

  // 2. Released non-bass notes / overtones (quietest first)
  const relTreble = voices.filter(x => x.state === 'RELEASE' && !isBassVoice(x));
  if (relTreble.length > 0) return relTreble.reduce((m, x) => (x.vol < m.vol ? x : m));

  // 3. Notes held ONLY by pedal in treble / accompaniment (key released, quietest first)
  const pedalTreble = voices.filter(x => !x.keyHeld && !isBassVoice(x));
  if (pedalTreble.length > 0) return pedalTreble.reduce((m, x) => (x.vol < m.vol ? x : m));

  // 4. Any non-bass voice in HOLD that has been sounding for at least 6 frames (100ms)
  const oldTreble = voices.filter(x => !isBassVoice(x) && x.age > 6);
  if (oldTreble.length > 0) return oldTreble.reduce((m, x) => (x.vol < m.vol ? x : m));

  // 5. Released bass body overtones if volume is low (< 12)
  const quietBassOvertones = voices.filter(x => x.state === 'RELEASE' && isBassVoice(x) && x.vol < 12);
  if (quietBassOvertones.length > 0) return quietBassOvertones.reduce((m, x) => (x.vol < m.vol ? x : m));

  // 6. Remaining non-bass voices
  const anyTreble = voices.filter(x => !isBassVoice(x));
  if (anyTreble.length > 0) return anyTreble.reduce((m, x) => (x.vol < m.vol ? x : m));

  // 7. Last resort: least loud voice
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

    if (ev.type === 0xC) {
      // Program Change: track instrument per channel
      chProg[ev.ch] = ev.d1;
    } else if (ev.type === 0xE) {
      // Pitch Bend: Only allow on solo lead channels (e.g. Channel 4 Van Halen solo).
      // Never bend rhythm guitar riff (Channel 3) or bass (Channel 1), which causes the iconic
      // Beat It riff 6th note (F#) to bend into a dissonant clash against the rhythm harmony!
      if (ev.ch === 4) {
        const bendVal = ((ev.d2 << 7) | ev.d1) - 8192;
        chBend[ev.ch] = bendVal;
        const bendSemis = (bendVal / 8192) * 2;
        for (const v of voices) {
          if (v.ch === ev.ch && v.state !== 'IDLE' && v.role !== 'DRUM') {
            v.targetFreq = midiNoteToFreqN(v.note + bendSemis, octaveShift, 0);
            v.freqWord = v.targetFreq;
          }
        }
      }
    } else if (ev.type === 0xB) {
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
        const v1 = isEnsemble ? allocEnsembleVoice('DRUM', 9) : allocVoice();
        v1.role = 'DRUM';
        v1.ch = 9;
        v1.note = note;
        v1.parentNote = note;
        v1.keyHeld = false; // drums are self-releasing one-shot hits
        v1.state = 'HOLD';
        v1.age = 0;
        v1.pan = PAN_C;
        v1.isNewNote = true;
        v1.hammerFrames = 0;
        v1.pitchDrop = 0;

        if (note === 35 || note === 36) {
          // Acoustic / Electric Bass Drum (Kick)
          // Punchy chiptune kick: starts at punch pitch (note 48 ≈ 130 Hz) and dives rapidly to ~50 Hz!
          v1.wave = VERA_WAVE_TRI;
          v1.targetFreq = midiNoteToFreqN(48, 0, 0);
          v1.freqWord = v1.targetFreq;
          v1.pitchDrop = 3; // drops in 3 frames
          v1.baseVol = Math.min(63, Math.round(60 + 3 * norm));
          v1.vol = v1.baseVol;
          v1.decayRate = 3.8;
          v1.holdFrames = 1;
        } else if (note === 38 || note === 40 || note === 39) {
          // Acoustic / Electric Snare, Hand Clap
          v1.wave = VERA_WAVE_NOISE;
          v1.targetFreq = midiNoteToFreqN(76, 0, 0);
          v1.freqWord = v1.targetFreq;
          v1.baseVol = Math.min(63, Math.round(56 + 7 * norm));
          v1.vol = v1.baseVol;
          v1.decayRate = 2.8;
          v1.holdFrames = 0;
        } else if (note === 42 || note === 44) {
          // Closed Hi-Hat / Pedal Hi-Hat
          v1.wave = VERA_WAVE_NOISE;
          v1.targetFreq = midiNoteToFreqN(94, 0, 0);
          v1.freqWord = v1.targetFreq;
          v1.baseVol = Math.min(54, Math.round(44 + 10 * norm));
          v1.vol = v1.baseVol;
          v1.decayRate = 8.0; // crisp transient
          v1.holdFrames = 0;
        } else if (note === 46) {
          // Open Hi-Hat
          v1.wave = VERA_WAVE_NOISE;
          v1.targetFreq = midiNoteToFreqN(90, 0, 0);
          v1.freqWord = v1.targetFreq;
          v1.baseVol = Math.min(58, Math.round(48 + 10 * norm));
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
          v1.decayRate = 1.0;
          v1.holdFrames = 0;
        } else if (note >= 41 && note <= 50) {
          // Floor / Mid / High Toms
          v1.wave = VERA_WAVE_TRI;
          v1.targetFreq = midiNoteToFreqN(note + 7, 0, 0);
          v1.freqWord = v1.targetFreq;
          v1.pitchDrop = 3;
          v1.baseVol = Math.min(63, Math.round(56 + 7 * norm));
          v1.vol = v1.baseVol;
          v1.decayRate = 2.5;
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
      } else if (isEnsemble) {
        // Multi-track Pop / Rock Ensemble Chiptune Synthesizer
        const role = getInstrumentRole(ev.ch, note);
        const v1 = allocEnsembleVoice(role, ev.ch);
        v1.role = role;
        v1.ch = ev.ch;
        v1.note = note;
        v1.parentNote = note;
        v1.keyHeld = true;
        v1.state = 'HOLD';
        v1.age = 0;
        v1.pan = PAN_C;
        v1.isNewNote = true;
        v1.pitchDrop = 0;
        v1.slideFrames = 0;
        v1.slideStep = 0;

        const bendSemis = (chBend[ev.ch] / 8192) * 2;
        v1.targetFreq = midiNoteToFreqN(note + bendSemis, octaveShift, 0);
        v1.freqWord = v1.targetFreq;

        if (ev.bendTarget) {
          const startFreq = midiNoteToFreqN(ev.d1, octaveShift, 0);
          const targetFreq = midiNoteToFreqN(ev.bendTarget, octaveShift, 0);
          v1.targetFreq = startFreq;
          v1.freqWord = startFreq;
          const bendFrames = 8; // slide across ~133ms
          v1.slideFrames = bendFrames;
          v1.slideStep = (targetFreq - startFreq) / bendFrames;
        }

        if (role === 'NEWAGE_BASS') {
          // Channel 1 (Patch 37 Bass):
          // Pure Triangle wave (VERA_WAVE_TRI): warm, organic, deep, zero buzz!
          v1.wave = VERA_WAVE_TRI;
          v1.hammerFrames = 0;
          v1.baseVol = Math.min(52, Math.round(38 + 14 * norm));
          v1.vol = v1.baseVol;
          v1.holdFrames = 6;
          v1.decayRate = 0.16;
          v1.pan = PAN_C;
        } else if (role === 'CHOIR') {
          // Channel 4 (Patch 52 Choir Aahs - Enya's iconic vocal melody):
          // Pure Triangle wave (VERA_WAVE_TRI): angelic, singing, 100% in-tune pitch!
          v1.wave = VERA_WAVE_TRI;
          v1.hammerFrames = 0;
          v1.baseVol = Math.min(63, Math.round(54 + 9 * Math.pow(norm, 0.35)));
          v1.vol = v1.baseVol;
          v1.holdFrames = 24;
          v1.decayRate = 0.04;
          v1.pan = PAN_C;
        } else if (role === 'HIGH_CHOIR') {
          // Channel 6 (Outro backing choir - Na.na~ Na.na~ Na.na):
          // Pure Triangle wave (VERA_WAVE_TRI): soaring, singing, slightly under lead vocal for perfect balance!
          v1.wave = VERA_WAVE_TRI;
          v1.hammerFrames = 0;
          v1.baseVol = Math.min(46, Math.round((44 + 13 * Math.pow(norm, 0.35)) * 0.8));
          v1.vol = v1.baseVol;
          v1.holdFrames = 18;
          v1.decayRate = 0.05;
          v1.pan = (ev.pan !== undefined) ? ev.pan : PAN_C;
        } else if (role === 'ACOUSTIC_GTR') {
          // Channel 3 (Patch 25 +12Str Gtr - 12-string guitar shimmering arpeggios):
          // 25% pulse wave: bright, singing, bell-like acoustic chime, panned right!
          v1.wave = VERA_WAVE_PULSE_25;
          v1.hammerFrames = 0;
          v1.baseVol = Math.min(48, Math.round(34 + 14 * norm));
          v1.vol = v1.baseVol;
          v1.holdFrames = 4;
          v1.decayRate = 0.16;
          v1.pan = PAN_R;
        } else if (role === 'ARPEGGIO') {
          // Channel 5 (Patch 7 Clavinet - delicate waltz accompaniment):
          // 50% square wave (VERA_WAVE_PULSE_50): warm, soft, non-buzzing, panned left!
          v1.wave = VERA_WAVE_PULSE_50;
          v1.hammerFrames = 0;
          v1.baseVol = Math.min(36, Math.round(22 + 14 * norm));
          v1.vol = v1.baseVol;
          v1.holdFrames = 2;
          v1.decayRate = 0.28;
          v1.pan = PAN_L;
        } else if (role === 'PIANO') {
          // Channel 2 (Patch 0 A. Piano 1 - piano melody & waltz accompaniment):
          // Accompaniment chords (< 60): Pure Triangle wave (soft felt piano, zero buzz)
          // Melody & upper register (>= 60 or melody run): Warm 50% square wave (singing wooden piano tone!)
          const isMelodyPiano = note >= 60 || ev.isMelody;
          if (!isMelodyPiano) {
            v1.wave = VERA_WAVE_TRI;
            v1.hammerFrames = 0;
            v1.baseVol = Math.min(38, Math.round(24 + 14 * norm));
            v1.vol = v1.baseVol;
            v1.holdFrames = 3;
            v1.decayRate = 0.20;
            v1.pan = PAN_C;
          } else {
            v1.wave = VERA_WAVE_PULSE_50;
            v1.hammerFrames = 0;
            v1.baseVol = Math.min(58, Math.round(44 + 14 * norm));
            v1.vol = v1.baseVol;
            v1.holdFrames = 6;
            v1.decayRate = 0.12;
            v1.pan = PAN_C;
          }
        } else if (role === 'BASS') {
          // Funk / Slap Bass (Ch 1 / GM 32..39):
          // Punchy Sawtooth wave with growl and slap bite!
          v1.wave = VERA_WAVE_SAW;
          v1.hammerFrames = 1;
          v1.baseVol = Math.min(63, Math.round(58 + 5 * Math.pow(norm, 0.4)));
          v1.vol = 63;
          v1.holdFrames = 4;
          v1.decayRate = 0.25;
        } else if (role === 'GUITAR_LEAD') {
          // Overdriven Guitar Riff & Solo:
          // Pulse 12.5% pick crunch -> Sawtooth distortion!
          v1.wave = VERA_WAVE_PULSE_12;
          v1.hammerFrames = 1;
          v1.baseVol = Math.min(63, Math.round(56 + 7 * Math.pow(norm, 0.35)));
          v1.vol = 63;
          v1.holdFrames = 6;
          v1.decayRate = 0.08;
        } else if (role === 'GUITAR_RHYTHM') {
          // Rhythm Guitar Chords & Muted Chops:
          v1.wave = VERA_WAVE_PULSE_25;
          v1.hammerFrames = 0;
          v1.baseVol = Math.min(54, Math.round(40 + 14 * norm));
          v1.vol = v1.baseVol;
          v1.holdFrames = 2;
          v1.decayRate = 0.20;
        } else if (role === 'LEAD') {
          // Vocals / Main Hook:
          v1.wave = VERA_WAVE_PULSE_12;
          v1.hammerFrames = 1;
          v1.baseVol = Math.min(63, Math.round(54 + 9 * Math.pow(norm, 0.35)));
          v1.vol = 63;
          v1.holdFrames = 5;
          v1.decayRate = 0.06;
        } else {
          // Synth Pad / Brass Chords:
          v1.wave = VERA_WAVE_PULSE_50;
          v1.hammerFrames = 0;
          v1.baseVol = Math.min(50, Math.round(34 + 16 * norm));
          v1.vol = v1.baseVol;
          v1.holdFrames = 0;
          v1.decayRate = 0.12;
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
        } else if (synthMode === 'psg') {
          // Authentic VERA PSG Concert Piano:
          if (note < 48) {
            // Thunderous bass piano (C#1 to B2): rich, authoritative foundation (58..63)
            baseVol = Math.min(63, Math.round(58 + 5 * Math.pow(norm, 0.35)));
            holdFrames = (note < 36) ? 30 : 20; // 330ms to 500ms of solid acoustic hold
          } else if (note < 60) {
            // Middle arpeggio accompaniment (C3 to B3): warm polyphonic cushion (36..54)
            baseVol = Math.min(54, Math.round(36 + 18 * Math.pow(norm, 0.45)));
            holdFrames = 3;
          } else {
            // Right-hand melody & fast runs (C4 and above): radiant, crisp PSG lead (46..63)
            baseVol = Math.min(63, Math.round(46 + 17 * Math.pow(norm, 0.35)));
            holdFrames = 7;
          }
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
        } else if (synthMode === 'psg') {
          // Authentic VERA PSG Concert Piano:
          if (note < 48) {
            // Bass: Sawtooth wave delivers full harmonic spectrum (1f, 2f, 3f, 4f, 5f...)
            // Deep, growling, acoustic copper-wound string bite that punches through any speaker!
            v1.wave = VERA_WAVE_SAW;
            v1.hammerFrames = 0;
          } else if (note < 60) {
            // Tenor: Warm 50% square wave creates a rich, hollow acoustic piano body
            v1.wave = VERA_WAVE_PULSE_50;
            v1.hammerFrames = 0;
          } else {
            // Treble: Starts on 12.5% pulse hammer attack strike, transitions into 25% pulse body!
            // Crisp, brilliant chiptune presence with zero "crystal music-box" muddiness!
            v1.wave = VERA_WAVE_PULSE_12;
            v1.hammerFrames = 2;
          }
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
        if (note < 48) {
          const overtones = [];
          if (synthMode === 'psg') {
            if (note < 36) {
              // Sub-bass (Note 25 C#1, Note 32 G#1):
              // 1. Unison chorus body with detune (+0.35 Hz) on Pulse 50%
              overtones.push({ noteOff: 0, detune: 0.35, wave: VERA_WAVE_PULSE_50, volRatio: 0.95, hold: 26, decayMult: 0.8 });
              // 2. Sub-octave fundamental (-12st) on Sawtooth for deep physical weight
              overtones.push({ noteOff: -12, detune: 0.0, wave: VERA_WAVE_SAW, volRatio: 0.95, hold: 28, decayMult: 0.7 });
              // 3. Octave overtone (+12st) on Pulse 50% for singing presence
              overtones.push({ noteOff: 12, detune: 0.0, wave: VERA_WAVE_PULSE_50, volRatio: 0.88, hold: 18, decayMult: 0.9 });
            } else if (note < 44) {
              // Deep bass (C#2 to G#2, Notes 36..43, e.g. Note 37 C#2):
              // 1. Sub-octave fundamental (-12st, C#1 34.65 Hz) on Sawtooth for thunderous low-end weight
              overtones.push({ noteOff: -12, detune: 0.0, wave: VERA_WAVE_SAW, volRatio: 0.92, hold: 24, decayMult: 0.8 });
              // 2. Unison chorus body (+0.35 Hz) on Pulse 50%
              overtones.push({ noteOff: 0, detune: 0.35, wave: VERA_WAVE_PULSE_50, volRatio: 0.90, hold: 20, decayMult: 0.85 });
              // 3. Octave overtone (+12st) on Pulse 50% for singing presence
              overtones.push({ noteOff: 12, detune: 0.0, wave: VERA_WAVE_PULSE_50, volRatio: 0.85, hold: 16, decayMult: 0.95 });
            } else {
              // Mid-bass (A2 to B2, Notes 44..47, e.g. opening Note 44 G#2):
              // 1. Sub-octave (-12st, G#1 51.9 Hz) on Sawtooth for deep punch
              overtones.push({ noteOff: -12, detune: 0.0, wave: VERA_WAVE_SAW, volRatio: 0.90, hold: 18, decayMult: 0.85 });
              // 2. Unison chorus body on Pulse 50%
              overtones.push({ noteOff: 0, detune: 0.35, wave: VERA_WAVE_PULSE_50, volRatio: 0.85, hold: 14, decayMult: 1.0 });
            }
          } else {
            if (note < 36) {
              // Ultra-low sub-bass (Note 25 C#1, Note 32 G#1, Note 31 G1):
              // Multi-oscillator grand piano soundboard resonance centered on the opening bass pitch (playNote):
              overtones.push({ noteOff: 0, detune: 0.35, wave: VERA_WAVE_TRI, volRatio: 0.98, hold: 16, decayMult: 1.0 }); // unison chorus body
              overtones.push({ noteOff: -12, detune: 0.0, wave: VERA_WAVE_TRI, volRatio: 0.98, hold: 18, decayMult: 0.9 }); // deep 34 Hz sub-octave
              overtones.push({ noteOff: 12, detune: 0.0, wave: VERA_WAVE_TRI, volRatio: 0.92, hold: 12, decayMult: 1.2 });  // octave overtone
              overtones.push({ noteOff: 7, detune: 0.0, wave: VERA_WAVE_TRI, volRatio: 0.85, hold: 10, decayMult: 1.4 });   // 5th overtone
            } else if (note < 44) {
              // Deep bass (C#2 to G#2, Notes 36..43):
              overtones.push({ noteOff: 0, detune: 0.35, wave: VERA_WAVE_TRI, volRatio: 0.95, hold: 12, decayMult: 1.0 }); // unison body
              overtones.push({ noteOff: 12, detune: 0.0, wave: VERA_WAVE_TRI, volRatio: 0.88, hold: 10, decayMult: 1.2 });  // octave
              overtones.push({ noteOff: 7, detune: 0.0, wave: VERA_WAVE_TRI, volRatio: 0.80, hold: 8, decayMult: 1.4 });   // 5th
            } else {
              // Mid-bass (A2 to B2, Notes 44..47):
              overtones.push({ noteOff: 0, detune: 0.35, wave: VERA_WAVE_TRI, volRatio: 0.90, hold: 8, decayMult: 1.0 });  // unison body
              overtones.push({ noteOff: 12, detune: 0.0, wave: VERA_WAVE_TRI, volRatio: 0.82, hold: 6, decayMult: 1.3 });  // octave
            }
          }

          for (const ot of overtones) {
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
            vOt.wave = ot.wave || VERA_WAVE_TRI;
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
      // Note Off: release all matching voices that were held down
      const note = ev.d1;
      for (const v of voices) {
        if (v.keyHeld && (v.ch === ev.ch || v.ch === -1) && (v.note === note || v.parentNote === note)) {
          v.keyHeld = false;
          const usePedal = isEnsemble ? (sustainPedal && v.role === 'CHORD') : sustainPedal;
          if (!usePedal) {
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

    // Kick / Tom rapid pitch dive:
    if (v.pitchDrop > 0) {
      v.pitchDrop--;
      v.targetFreq = Math.round(v.targetFreq * 0.76);
      v.freqWord = v.targetFreq;
    }

    // Portamento / pitch slide (e.g. vocal blues scoop bend):
    if (v.slideFrames > 0) {
      v.slideFrames--;
      v.freqWord = Math.round(v.freqWord + v.slideStep);
    }

    // Hammer / pick attack transient completion:
    if (v.hammerFrames > 0) {
      v.hammerFrames--;
      if (v.hammerFrames === 0) {
        if (isEnsemble) {
          if (v.role === 'ACOUSTIC_GTR') {
            v.wave = VERA_WAVE_PULSE_25;
          } else if (v.role === 'PIANO') {
            v.wave = (v.note < 50) ? VERA_WAVE_PULSE_50 : VERA_WAVE_PULSE_25;
          } else if (v.role === 'GUITAR_LEAD') {
            v.wave = VERA_WAVE_SAW; // crunchy overdriven guitar distortion!
          } else if (v.role === 'LEAD') {
            v.wave = VERA_WAVE_PULSE_25; // bright singing lead
          } else if (v.role === 'BASS') {
            v.wave = VERA_WAVE_SAW; // growling slap bass
          }
        } else if (v.role === 'PRIMARY') {
          if (synthMode === 'psg') {
            v.wave = (v.note >= 60) ? VERA_WAVE_PULSE_25 : ((v.note < 48) ? VERA_WAVE_SAW : VERA_WAVE_PULSE_50);
          } else if (synthMode === 'grand') {
            v.wave = VERA_WAVE_TRI;
          }
        }
        v.vol = v.baseVol;
      }
    }

    // Acoustic / Synth Decay Simulation
    if (v.holdFrames > 0) {
      v.holdFrames--;
    } else if (v.state === 'HOLD') {
      v.vol = Math.max(0, v.vol - v.decayRate);
      if (v.vol <= 6) {
        v.vol = 0;
        v.state = 'IDLE';
      }
    } else if (v.state === 'RELEASE') {
      let relDecay;
      if (isEnsemble) {
        if (v.role === 'BASS' || v.role === 'NEWAGE_BASS') relDecay = 2.5;
        else if (v.role === 'CHOIR') relDecay = 1.0; // ethereal airy decay
        else if (v.role === 'HIGH_CHOIR') relDecay = 1.8;
        else if (v.role === 'ACOUSTIC_GTR' || v.role === 'ARPEGGIO') relDecay = 3.0;
        else if (v.role === 'PIANO') relDecay = 3.2;
        else if (v.role === 'GUITAR_LEAD' || v.role === 'GUITAR_RHYTHM') relDecay = 4.0;
        else if (v.role === 'LEAD') relDecay = 3.5;
        else if (v.role === 'CHORD') relDecay = 2.0;
        else relDecay = 4.0;
      } else {
        const isBass = isBassVoice(v);
        relDecay = isBass ? 0.35 : 5.5;
      }
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
      if (Math.abs(v.freqWord - v.lastSentFreq) >= 4) {
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
