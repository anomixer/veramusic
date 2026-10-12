#!/usr/bin/env node
/*
 * FamiStudio/FamiTone project -> Apple II VERA PSG frame stream.
 *
 * Usage:
 *   node tools/ftm2psg.mjs input.ftm song-index output.psg [options]
 *
 *   --noise-gain=0..4   extra gain for noise-typed voices (default 1)
 *   --mute-noise       force every noise-typed voice silent
 *   --gain=0..4        global master trim applied to every voice (default 1)
 *   --no-normalize     skip per-voice level matching (raw relative dynamics)
 *
 * FamiStudio renders isolated voices; this tool tracks each stem's pitch and
 * envelope once per 60 Hz frame, then writes veramusic's [count,(reg,val)*]
 * PSG event format. This is a timbral approximation, not a register-level
 * FamiTone2 interpreter or NES APU emulator.
 *
 * Every stem FamiStudio produces is mapped, not just the NES 2A03 four:
 * NES 2A03 (Square1/2, Triangle, Noise), VRC6 (Square1/2, Saw), and any other
 * expansion FamiStudio emits (names are matched by waveform family). The VERA
 * PSG has 16 voices, so up to 16 stems fit. Sample channels (DPCM and friends)
 * cannot be expressed as PSG registers and are reported, not encoded.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RATE = 44100;
const TICK = 60;
const HOP = RATE / TICK;          // 735 samples per 60 Hz frame
const PSG_CLOCK = 25000000 / 512;
// The VERA noise oscillator is sample-and-hold, so its perceived "pitch" is an
// approximation of the NES APU noise period rather than a real fundamental.
const NOISE_HZ = 14000;
const SILENCE_RMS = 0.0015;       // below this the voice is treated as off
const MAX_VOICES = 16;

// Pitch is measured on a decimated signal. Decimating 2:1 and using a 4096-point
// FFT spans the same 186 ms and gives the same 5.38 Hz bin spacing as an 8192-
// point FFT at 44.1 kHz, at half the cost. 186 ms holds >5 periods of a 28 Hz
// bass fundamental, which is what makes bass notes measurable at all.
const DECIM = 2;
const SR = RATE / DECIM;          // 22050
const FFT_SIZE = 4096;
const HARM_RATIO = 0.55;          // subharmonic must reach this to count

let noiseGain = 1.0;
let masterGain = 1.0;
let muteNoise = false;
let normalize = true;

// VERA waveform bytes. Bits 7:6 select the wave, bits 5:0 the pulse width.
//   0x00 pulse 0%   0x20 pulse 25%   0x40 sawtooth   0x60 pulse 75%
//   0x80 triangle   0xA0 pulse 12.5% 0xC0 noise
const WAVE_BY_FAMILY = {
  pulse: 0x20,
  triangle: 0x80,
  saw: 0x40,
  noise: 0xC0,
};

// Preferred voice order: 2A03 first, then expansions, then anything new, so
// PSG voice indices stay stable across songs for the same project.
const PREFERRED_ORDER = [
  'Square1', 'Square2', 'Triangle', 'Noise',
  'VRC6Square1', 'VRC6Square2', 'VRC6Saw',
  'SunsoftTriangle1', 'SunsoftTriangle2', 'SunsoftNoise',
  'FDSWave', 'FDSMaster', 'FDSMod',
  'NamcoWave1', 'NamcoWave2', 'NamcoWave3',
];

// Sample-rate windows per waveform family. The NES triangle reaches well below
// C2; VERA PSG resolves anything the autocorrelation window can see.
const HZ_RANGE = {
  pulse: [55, 3500],
  triangle: [28, 6000],
  saw: [40, 6000],
  noise: [80, 12000],
};

function familyOf(stemName) {
  if (/dpcm|pcm|sample/i.test(stemName)) return 'sample';
  if (/saw/i.test(stemName)) return 'saw';
  if (/tri/i.test(stemName)) return 'triangle';
  if (/noise|tnm/i.test(stemName)) return 'noise';
  if (/square|pulse/i.test(stemName)) return 'pulse';
  return 'pulse'; // unknown melodic stem: safest audible default
}

function parseWav(file) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error(`Not a RIFF/WAVE file: ${file}`);
  let p = 12, fmt, data;
  while (p + 8 <= b.length) {
    const id = b.toString('ascii', p, p + 4), n = b.readUInt32LE(p + 4), start = p + 8;
    if (id === 'fmt ') fmt = { format: b.readUInt16LE(start), channels: b.readUInt16LE(start + 2), rate: b.readUInt32LE(start + 4), bits: b.readUInt16LE(start + 14) };
    if (id === 'data') data = b.subarray(start, start + n);
    p = start + n + (n & 1);
  }
  if (!fmt || !data || fmt.format !== 1 || fmt.bits !== 16) throw new Error(`Expected 16-bit PCM WAV: ${file}`);
  const frames = Math.floor(data.length / (fmt.channels * 2));
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; ++i) {
    let s = 0;
    for (let c = 0; c < fmt.channels; ++c) s += data.readInt16LE((i * fmt.channels + c) * 2) / 32768;
    mono[i] = s / fmt.channels;
  }
  if (fmt.rate !== RATE) throw new Error(`FamiStudio stem must be 44100 Hz (got ${fmt.rate})`);
  return mono;
}

function decimate(samples) {
  // 3-tap [1,2,1] lowpass, then keep every DECIM-th sample. Cheap anti-alias;
  // Nyquist after decimation is 11.025 kHz, well above every family's maxHz.
  const out = new Float32Array(Math.ceil(samples.length / DECIM));
  for (let i = 0, j = 0; j < samples.length; i++, j += DECIM) {
    const a = samples[j - 1] || 0, b = samples[j] || 0, c = samples[j + 1] || 0;
    out[i] = (a + 2 * b + c) / 4;
  }
  return out;
}

// Radix-2 in-place FFT with precomputed bit-reversal, twiddles and a Hann
// window. Tables are built once and the scratch buffers are reused per voice.
function makeFFT(size) {
  const rev = new Int32Array(size);
  for (let i = 1, j = 0; i < size; i++) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    rev[i] = j;
  }
  const cos = new Float64Array(size / 2), sin = new Float64Array(size / 2);
  for (let i = 0; i < size / 2; i++) {
    cos[i] = Math.cos(-2 * Math.PI * i / size);
    sin[i] = Math.sin(-2 * Math.PI * i / size);
  }
  const win = new Float64Array(size);
  for (let i = 0; i < size; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (size - 1));

  return (samples, start, n, re, im) => {
    for (let i = 0; i < size; i++) { re[i] = 0; im[i] = 0; }
    for (let i = 0; i < n; i++) re[i] = (samples[start + i] || 0) * win[i];
    for (let i = 0; i < size; i++) {
      const j = rev[i];
      if (j > i) { const t = re[i]; re[i] = re[j]; re[j] = t; }
    }
    for (let len = 2; len <= size; len <<= 1) {
      const half = len >> 1, step = size / len;
      for (let i = 0; i < size; i += len) {
        for (let k = 0; k < half; k++) {
          const t = (k * step) | 0;
          const wr = cos[t], wi = sin[t];
          const ar = re[i + k], ai = im[i + k];
          const br = re[i + k + half], bi = im[i + k + half];
          re[i + k] = ar + br * wr - bi * wi;
          im[i + k] = ai + br * wi + bi * wr;
          re[i + k + half] = ar - br * wr + bi * wi;
          im[i + k + half] = ai - br * wi - bi * wr;
        }
      }
    }
    const half = size / 2;
    const mag = new Float64Array(half);
    for (let k = 0; k < half; k++) mag[k] = Math.hypot(re[k], im[k]);
    return mag;
  };
}

// Spectral peak, refined parabolically on log magnitude for sub-bin accuracy.
function refineBin(mag, bin, binHz) {
  const la = Math.log(mag[bin - 1] || 1e-12);
  const lb = Math.log(mag[bin] || 1e-12);
  const lc = Math.log(mag[bin + 1] || 1e-12);
  const den = la - 2 * lb + lc;
  const off = Math.abs(den) > 1e-12 ? 0.5 * (la - lc) / den : 0;
  return {
    hz: (bin + Math.max(-0.5, Math.min(0.5, off))) * binHz,
    mag: mag[bin],
  };
}

// Pitch from the spectral fundamental.
//
// An earlier version used normalized autocorrelation over a 3-frame window.
// That is fundamentally unusable here: every integer multiple of the true
// period correlates at ~1.0, so "pick the first peak" or "walk toward longer
// periods" lands on an arbitrary multiple. Measured against a 743 ms FFT
// ground truth on the Alter Ego stems it was off by a median of 1154% on the
// triangle (up to 28x) and 72% on the squares -- audible as shrill squeal
// instead of a bass line. The FFT peak with harmonic-to-fundamental correction
// measures 1-3 cents median error on the same frames.
function detectPitch(voice, frame) {
  const [minHz, maxHz] = HZ_RANGE[voice.family];
  const hopD = SR / TICK;
  const center = Math.round(frame * hopD);
  const start = Math.max(0, center - (FFT_SIZE >> 1));
  const n = Math.min(FFT_SIZE, voice.dec.length - start);
  if (n < 256) return 0;

  const binHz = SR / FFT_SIZE;
  const mag = voice.fft(voice.dec, start, n, voice.re, voice.im);
  const lo = Math.max(1, Math.floor(minHz / binHz));
  const hi = Math.min(mag.length - 2, Math.ceil(maxHz / binHz));
  if (hi <= lo) return 0;
  let best = lo;
  for (let k = lo; k <= hi; k++) if (mag[k] > mag[best]) best = k;
  if (mag[best] <= 0) return 0;
  const peak = refineBin(mag, best, binHz);

  // Harmonic -> fundamental: the strongest bin may be an overtone. Search a
  // small neighbourhood of each candidate subharmonic, because its energy can
  // land between bins and testing a single bin makes the correction fail.
  const localPeak = (bin) => {
    const a = Math.max(1, bin - 2), b = Math.min(mag.length - 2, bin + 2);
    let bk = a;
    for (let k = a; k <= b; k++) if (mag[k] > mag[bk]) bk = k;
    return refineBin(mag, bk, binHz);
  };
  let f0 = peak.hz;
  for (let k = 8; k >= 2; k--) {
    const bin = Math.round(f0 / k / binHz);
    if (bin < 2) continue;
    const q = localPeak(bin);
    if (q.hz >= minHz && q.mag >= peak.mag * HARM_RATIO) { f0 = q.hz; break; }
  }
  return f0;
}

function frameRms(samples, frame) {
  const start = Math.round(frame * HOP);
  let energy = 0, count = 0;
  const end = Math.min(samples.length, start + Math.round(HOP));
  for (let i = start; i < end; ++i) { const x = samples[i] || 0; energy += x * x; }
  count = Math.max(1, end - start);
  return Math.sqrt(energy / count);
}

function freqWord(hz) {
  return Math.max(0, Math.min(0xFFFF, Math.round(hz * 131072 / PSG_CLOCK)));
}

function usage() {
  console.log('Usage: node tools/ftm2psg.mjs <input.ftm> <song-index> <output.psg> [options]');
  console.log('  --noise-gain=0..4  --mute-noise  --gain=0..4  --no-normalize');
  console.log('Options also accept the space-separated form (--noise-gain 1.2).');
  console.log('Set FAMISTUDIO to override the FamiStudio.exe path.');
}

function sortStems(names) {
  const rank = (n) => {
    const i = PREFERRED_ORDER.indexOf(n);
    return i >= 0 ? i : PREFERRED_ORDER.length;
  };
  return names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

// Which channels actually contain notes.
//
// FamiStudio's -wav-export-separate-channels emits a stem for EVERY channel,
// including unused ones, and an unused channel's stem is not silence: FamiStudio's
// SeparateChannelsExportTndMode setting bleeds DPCM samples into the triangle and
// noise channels. On a song whose Triangle channel holds zero patterns the stem
// still renders at RMS 0.0136 with 58% of frames non-zero -- it is the kick and
// snare samples, not a bass line. Converting it produces a PSG voice playing
// drums on a triangle wave at ~30 Hz.
//
// The text export is the authority on which channels are used. It carries no
// tempo, but tempo is not needed for an occupancy check.
function channelNoteCounts(txtFile) {
  const counts = new Map();
  const text = fs.readFileSync(txtFile, 'utf8');
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    let m = /^Channel\s+Type="([^"]+)"/.exec(line);
    if (m) { current = m[1]; if (!counts.has(current)) counts.set(current, 0); continue; }
    if (current && /^Note\s/.test(line) && /\bValue="/.test(line)) {
      counts.set(current, counts.get(current) + 1);
    }
  }
  return counts;
}

function main(args) {
  if (args.length < 3 || !/^\d+$/.test(args[1])) { usage(); process.exitCode = 2; return; }
  const [input, indexText, output, ...options] = args;
  noiseGain = 1.0;
  masterGain = 1.0;
  muteNoise = false;
  normalize = true;
  for (let i = 0; i < options.length; ++i) {
    let option = options[i];
    // Accept both "--opt=value" and "--opt value". The second form matters
    // because cmd splits batch arguments at '='.
    const eq = option.indexOf('=');
    let inlineValue = null;
    if (option.startsWith('--') && eq > 2) { inlineValue = option.slice(eq + 1); option = option.slice(0, eq); }
    const takeValue = (name) => {
      if (inlineValue !== null) return inlineValue;
      if (i + 1 < options.length) return options[++i];
      throw new Error(`${name} needs a value`);
    };
    if (option === '--mute-noise') muteNoise = true;
    else if (option === '--no-normalize') normalize = false;
    else if (option === '--noise-gain') {
      noiseGain = Number(takeValue('--noise-gain'));
      if (!Number.isFinite(noiseGain) || noiseGain < 0 || noiseGain > 4)
        throw new Error('--noise-gain must be a number from 0 to 4');
    } else if (option === '--gain') {
      masterGain = Number(takeValue('--gain'));
      if (!Number.isFinite(masterGain) || masterGain <= 0 || masterGain > 4)
        throw new Error('--gain must be a number above 0 and at most 4');
    } else throw new Error(`Unknown option: ${option}`);
  }
  const songIndex = Number(indexText);
  const candidates = [process.env.FAMISTUDIO, 'C:\\Program Files\\FamiStudio\\FamiStudio.exe', 'C:\\dev\\famistudio\\FamiStudio.exe', 'C:\\dev\\famistudio450\\FamiStudio.exe'].filter(Boolean);
  const exe = candidates.find(p => fs.existsSync(p));
  if (!fs.existsSync(input)) throw new Error(`Input not found: ${input}`);
  if (!exe) throw new Error(`FamiStudio.exe not found (set FAMISTUDIO; checked ${candidates.join(', ')})`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-fami-psg-'));
  try {
    const stemBase = path.join(tmp, 'stem.wav');
    const r = spawnSync(exe, [input, 'wav-export', stemBase, `-export-songs:${songIndex}`, '-wav-export-separate-channels', '-wav-export-rate:44100'], { encoding: 'utf8', windowsHide: true });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`FamiStudio export failed (${r.status}): ${r.stderr || r.stdout}`);

    // Discover whatever stems this song actually produced instead of assuming
    // the NES 2A03 four. That is what keeps VRC6/expansion voices audible.
    const stemDir = path.dirname(stemBase);
    const stemPrefix = path.basename(stemBase).replace(/\.wav$/i, '') + '_';
    const produced = fs.readdirSync(stemDir)
      .filter(f => f.toLowerCase().endsWith('.wav') && f.toLowerCase().startsWith(stemPrefix.toLowerCase()))
      .map(f => f.slice(stemPrefix.length).replace(/\.wav$/i, ''));
    if (!produced.length) throw new Error('FamiStudio produced no channel stems (is the song empty?)');

    // Ask FamiStudio which channels are actually in use. Best effort: if the text
    // export is unavailable we keep every stem rather than dropping real music.
    let noteCounts = null;
    const txtBase = path.join(tmp, 'project.txt');
    const tr = spawnSync(exe, [input, 'famistudio-txt-export', txtBase, `-export-songs:${songIndex}`], { encoding: 'utf8', windowsHide: true });
    if (!tr.error && tr.status === 0 && fs.existsSync(txtBase)) {
      noteCounts = channelNoteCounts(txtBase);
    } else {
      console.warn('WARNING: text export unavailable; cannot tell unused channels from DPCM bleed, keeping all stems.');
    }

    const names = sortStems(produced);
    const sampleNames = names.filter(n => familyOf(n) === 'sample');
    const blended = [];
    const voiceNames = names.filter(n => {
      if (familyOf(n) === 'sample') return false;
      if (noteCounts && noteCounts.has(n) && noteCounts.get(n) === 0) { blended.push(n); return false; }
      return true;
    });
    for (const name of blended) {
      console.warn(`Skipping PSG voice '${name}': channel has 0 notes, its stem is DPCM/sample bleed, not ${name}.`);
    }
    if (voiceNames.length > MAX_VOICES) {
      console.warn(`WARNING: ${voiceNames.length} PSG-capable stems but the VERA PSG has ${MAX_VOICES} voices; truncating.`);
      voiceNames.length = MAX_VOICES;
    }

    const voices = voiceNames.map((name, i) => {
      const family = familyOf(name);
      const samples = parseWav(path.join(stemDir, stemPrefix + name + '.wav'));
      return {
        name,
        family,
        index: i,
        wave: WAVE_BY_FAMILY[family],
        samples,
        dec: decimate(samples),
        fft: makeFFT(FFT_SIZE),
        re: new Float64Array(FFT_SIZE),
        im: new Float64Array(FFT_SIZE),
        lastHz: 0,
        ref: 0,
        stats: { active: 0, detected: 0, held: 0 },
      };
    });

    const sampleStems = sampleNames.map(name => ({
      name,
      samples: parseWav(path.join(stemDir, stemPrefix + name + '.wav')),
    }));

    const totalSamples = Math.max(...voices.map(v => v.samples.length));
    const frames = Math.ceil(totalSamples / HOP);

    // Per-voice RMS over every frame, then a level reference per voice. Using a
    // single global peak (the old behaviour) crushed quiet stems to silence once
    // a loud one such as VRC6Saw was present.
    const rmsTable = voices.map(v => new Float32Array(frames));
    let globalRef = 0;
    for (let i = 0; i < voices.length; ++i) {
      let sum = 0, count = 0;
      for (let f = 0; f < frames; ++f) {
        const r = frameRms(voices[i].samples, f);
        rmsTable[i][f] = r;
        if (r >= SILENCE_RMS) { sum += r * r; ++count; }
      }
      const ref = count ? Math.sqrt(sum / count) : 0;
      voices[i].ref = ref;
      if (ref > globalRef) globalRef = ref;
    }

    const events = [];
    let activeFrames = 0;
    for (let f = 0; f < frames; ++f) {
      const writes = new Map();
      for (let i = 0; i < voices.length; ++i) {
        const v = voices[i];
        const rms = rmsTable[i][f];
        const base = v.index * 4;
        if (v.family === 'noise' && muteNoise) { writes.set(base + 2, 0); continue; }
        if (rms < SILENCE_RMS) { v.lastHz = 0; writes.set(base + 2, 0); continue; }

        // Noise has no stable fundamental, so pitch correlation is meaningless
        // for its stem: gate it by RMS and use the configured VERA noise rate.
        let hz;
        if (v.family === 'noise') {
          hz = NOISE_HZ;
          v.stats.active++;
        } else {
          hz = detectPitch(v, f);
          if (hz > 0) { v.lastHz = hz; v.stats.detected++; }
          else if (v.lastHz > 0) {
            // A held pitch bridges note onsets/decimation dropouts instead of
            // chopping the note off whenever correlation momentarily dips.
            hz = v.lastHz;
            v.stats.held++;
          }
          if (hz > 0) v.stats.active++;
          else { writes.set(base + 2, 0); continue; }
        }

        ++activeFrames;
        const freq = freqWord(hz);
        // RMS-to-volume is intentionally per-frame: it reproduces each
        // channel's note envelope rather than imposing a fixed VERA level.
        // The reference is the geometric mean of this voice's own typical
        // level and the loudest voice's, so quiet stems are lifted toward
        // audibility without flattening the mix completely.
        const ref = normalize
          ? Math.sqrt((v.ref || globalRef || 1) * (globalRef || 1))
          : (globalRef || 1);
        let vol = Math.round(Math.pow(rms / (ref || 1), 0.65) * 55 * masterGain);
        if (v.family === 'noise') vol *= noiseGain;
        vol = Math.max(1, Math.min(63, vol));
        writes.set(base, freq & 0xFF);
        writes.set(base + 1, (freq >> 8) & 0xFF);
        writes.set(base + 2, 0xC0 | vol);   // center pan
        writes.set(base + 3, v.wave);
      }
      const pairs = [...writes.entries()];
      events.push(pairs.length, ...pairs.flat());
    }
    // This song export is a one-shot PSG stream; loop at frame zero. The game
    // may instead restart/select tracks explicitly at its music-state layer.
    events.push(0xFF, 0, 0);
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.writeFileSync(output, Buffer.from(events));
    console.log(`Wrote ${output}: ${frames} frames (${(frames / TICK).toFixed(2)} s), ${events.length} bytes`);
    console.log(`PSG voice -> FamiStudio stem (all ${voices.length} converted):`);
    for (const v of voices) {
      console.log(`  v${String(v.index + 1).padStart(2)} ${v.name.padEnd(14)} ${v.family.padEnd(9)} active=${String(v.stats.active).padStart(5)} frames (${(100 * v.stats.active / frames).toFixed(1)}%)  pitch: ${v.stats.detected} detected / ${v.stats.held} held`);
    }
    for (const s of sampleStems) {
      const r = Math.sqrt(s.samples.reduce((a, x) => a + x * x, 0) / Math.max(1, s.samples.length));
      console.log(`  --  ${s.name.padEnd(14)} ${'sample'.padEnd(9)} RMS=${r.toFixed(4)} (not encodable as PSG registers)`);
      if (r > SILENCE_RMS) console.warn(`WARNING: '${s.name}' is a sample channel and is omitted from this PSG-only output.`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(`[FAILED] ${e.message}`); process.exitCode = 1; }
}