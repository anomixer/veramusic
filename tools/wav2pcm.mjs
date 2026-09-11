#!/usr/bin/env node
/**
 * wav2pcm.mjs — Audio to VERA 8-bit Signed PCM Converter
 *
 * Converts any WAV (or MP3 via ffmpeg) into Apple II VERA hardware-ready
 * 8-bit signed PCM streams (-128..127) for RAM or disk streaming playback.
 *
 * Features:
 *   - Auto-detects ffmpeg or uses built-in pure JS WAV parser & resampler
 *   - Pre-calibrated VERA hardware sample rates (rate register = 1..128)
 *   - True TPDF (Triangular Probability Density Function) dither to eliminate
 *     8-bit harmonic quantization distortion
 *   - Peak normalization (-0.3 dBFS) & soft clipping prevention
 *   - Generates matching PC preview .wav file for instant auditioning
 *
 * Usage:
 *   node wav2pcm.mjs <input.wav|input.mp3> [output.pcm] [options]
 *
 * Options:
 *   --rate=<hz>        Target sample rate in Hz (default: 8010)
 *                      Presets: 8010 (rate 21), 11060 (rate 29), 16021 (rate 42), 22120 (rate 58)
 *   --start=<sec>      Start time offset in seconds (default: 0)
 *   --duration=<sec>   Duration in seconds (default: full length)
 *   --gain=<float>     Manual linear gain multiplier (default: auto-normalize to -0.3 dBFS)
 *   --no-normalize     Disable peak normalization
 *   --no-dither        Disable TPDF dithering
 *   --no-wav           Do not generate preview .wav file
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawnSync } from 'node:child_process';

const VERA_BASE_RATE = 25000000 / 512; // 48828.125 Hz internal audio clock

// Pre-calibrated VERA PCM rates
const VERA_PRESETS = {
  3815:  10,
  6104:  16,
  8010:  21,
  11060: 29,
  11025: 29,
  12207: 32,
  16021: 42,
  16000: 42,
  22120: 58,
  22050: 58,
  24414: 64,
  48828: 128,
};

function hzToVeraRate(hz) {
  if (hz <= 128 && hz >= 1) return Math.round(hz);
  if (VERA_PRESETS[Math.round(hz)]) return VERA_PRESETS[Math.round(hz)];
  const r = Math.round((hz / VERA_BASE_RATE) * 128);
  return Math.max(1, Math.min(128, r));
}

function veraRateToHz(rate) {
  return (rate / 128) * VERA_BASE_RATE;
}

// Check ffmpeg availability
function hasFfmpeg() {
  try {
    const res = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return res.status === 0;
  } catch {
    return false;
  }
}

// Built-in WAV parser for pure JS fallback
function parseWav(buf) {
  if (buf.length < 44 || buf.subarray(0, 4).toString('ascii') !== 'RIFF' || buf.subarray(8, 12).toString('ascii') !== 'WAVE') {
    throw new Error('Not a valid RIFF/WAVE file');
  }
  let pos = 12;
  let fmt = null, data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.subarray(pos, pos + 4).toString('ascii');
    const size = buf.readUInt32LE(pos + 4);
    pos += 8;
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(pos),
        channels: buf.readUInt16LE(pos + 2),
        sampleRate: buf.readUInt32LE(pos + 4),
        bitsPerSample: buf.readUInt16LE(pos + 14),
      };
    } else if (id === 'data') {
      data = buf.subarray(pos, Math.min(buf.length, pos + size));
    }
    pos += size;
  }
  if (!fmt || !data) throw new Error('Incomplete WAV file (missing fmt or data chunk)');
  return { fmt, data };
}

// Convert audio buffer into Float32 mono samples [-1.0 .. +1.0]
function decodeToFloatMono(fmt, data) {
  const bytesPerSample = fmt.bitsPerSample / 8;
  const blockAlign = fmt.channels * bytesPerSample;
  const numFrames = Math.floor(data.length / blockAlign);
  const out = new Float32Array(numFrames);

  if (fmt.format === 1) {
    // Integer PCM
    if (fmt.bitsPerSample === 16) {
      for (let i = 0; i < numFrames; i++) {
        let sum = 0;
        for (let ch = 0; ch < fmt.channels; ch++) {
          sum += data.readInt16LE((i * fmt.channels + ch) * 2);
        }
        out[i] = (sum / fmt.channels) / 32768;
      }
    } else if (fmt.bitsPerSample === 8) {
      for (let i = 0; i < numFrames; i++) {
        let sum = 0;
        for (let ch = 0; ch < fmt.channels; ch++) {
          sum += data[(i * fmt.channels + ch)] - 128;
        }
        out[i] = (sum / fmt.channels) / 128;
      }
    } else if (fmt.bitsPerSample === 24) {
      for (let i = 0; i < numFrames; i++) {
        let sum = 0;
        for (let ch = 0; ch < fmt.channels; ch++) {
          const off = (i * fmt.channels + ch) * 3;
          let val = data[off] | (data[off + 1] << 8) | (data[off + 2] << 16);
          if (val & 0x800000) val |= ~0xFFFFFF; // Sign extend 24-bit
          sum += val;
        }
        out[i] = (sum / fmt.channels) / 8388608;
      }
    } else {
      throw new Error(`Unsupported PCM bits per sample: ${fmt.bitsPerSample}`);
    }
  } else if (fmt.format === 3 && fmt.bitsPerSample === 32) {
    // 32-bit float
    for (let i = 0; i < numFrames; i++) {
      let sum = 0;
      for (let ch = 0; ch < fmt.channels; ch++) {
        sum += data.readFloatLE((i * fmt.channels + ch) * 4);
      }
      out[i] = sum / fmt.channels;
    }
  } else {
    throw new Error(`Unsupported WAV audio format code: ${fmt.format}`);
  }

  return { samples: out, sampleRate: fmt.sampleRate };
}

// High quality linear resampler with anti-aliasing integration for pure JS fallback
function resampleFloat(samples, srcRate, dstRate) {
  if (srcRate === dstRate) return samples;
  const ratio = srcRate / dstRate;
  const outLen = Math.round(samples.length / ratio);
  const out = new Float32Array(outLen);

  if (ratio > 1.0) {
    // Downsampling: box average / anti-aliasing filter
    const halfWin = ratio * 0.5;
    for (let i = 0; i < outLen; i++) {
      const srcPos = i * ratio;
      const start = Math.max(0, Math.floor(srcPos - halfWin));
      const end = Math.min(samples.length - 1, Math.ceil(srcPos + halfWin));
      let sum = 0, count = 0;
      for (let j = start; j <= end; j++) {
        sum += samples[j];
        count++;
      }
      out[i] = count > 0 ? sum / count : 0;
    }
  } else {
    // Upsampling: linear interpolation
    for (let i = 0; i < outLen; i++) {
      const srcPos = i * ratio;
      const idx = Math.floor(srcPos);
      const frac = srcPos - idx;
      const s0 = samples[idx] || 0;
      const s1 = samples[idx + 1] !== undefined ? samples[idx + 1] : s0;
      out[i] = s0 + frac * (s1 - s0);
    }
  }

  return out;
}

// Build standard 16-bit WAV header and file for PC preview
function createWavBuffer(int16Samples, sampleRate) {
  const dataSize = int16Samples.length * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // Mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < int16Samples.length; i++) {
    buf.writeInt16LE(int16Samples[i], 44 + i * 2);
  }
  return buf;
}

// ---------------- CLI Entry Point ----------------
export function convertWavToPcm(args) {
  let inputFile = null;
  let outputFile = null;
  let targetHz = 8010;
  let startTime = 0;
  let duration = null;
  let gain = null;
  let normalize = true;
  let dither = true;
  let makeWav = true;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--rate=')) targetHz = parseFloat(a.split('=')[1]);
    else if (a === '-r' && args[i + 1]) targetHz = parseFloat(args[++i]);
    else if (a.startsWith('--start=')) startTime = parseFloat(a.split('=')[1]);
    else if (a === '-s' && args[i + 1]) startTime = parseFloat(args[++i]);
    else if (a.startsWith('--duration=')) duration = parseFloat(a.split('=')[1]);
    else if (a === '-d' && args[i + 1]) duration = parseFloat(args[++i]);
    else if (a.startsWith('--gain=')) gain = parseFloat(a.split('=')[1]);
    else if (a === '-g' && args[i + 1]) gain = parseFloat(args[++i]);
    else if (a === '--no-normalize') normalize = false;
    else if (a === '--no-dither') dither = false;
    else if (a === '--no-wav') makeWav = false;
    else if (!a.startsWith('-')) {
      if (!inputFile) inputFile = a;
      else if (!outputFile) outputFile = a;
    }
  }

  if (!inputFile) {
    console.log(`wav2pcm.mjs — Audio to Apple II VERA 8-bit Signed PCM Converter

Usage:
  node wav2pcm.mjs <input.wav|input.mp3> [output.pcm] [options]

Options:
  --rate=<hz>        Target sample rate (default: 8010)
                     Preset rates: 8010 (rate 21), 11060 (rate 29), 16021 (rate 42), 22120 (rate 58)
  --start=<sec>      Start offset in seconds (e.g. --start=15.5)
  --duration=<sec>   Segment duration in seconds (e.g. --duration=30)
  --gain=<float>     Manual gain factor (e.g. --gain=1.5)
  --no-normalize     Do not auto-normalize peak
  --no-dither        Disable TPDF dithering
  --no-wav           Do not generate preview .wav
`);
    process.exit(1);
  }

  if (!fs.existsSync(inputFile)) {
    console.error(`[FAILED] Input file not found: ${inputFile}`);
    process.exit(1);
  }

  const veraRateReg = hzToVeraRate(targetHz);
  const actualHz = veraRateToHz(veraRateReg);

  const parsedPath = path.parse(inputFile);
  if (!outputFile) {
    outputFile = path.join(parsedPath.dir, `${parsedPath.name}.pcm`);
  }

  console.log(`[WAV2PCM] Processing: "${parsedPath.base}"`);
  console.log(`  Target Rate: ${targetHz} Hz → VERA RATE reg = ${veraRateReg} ($${veraRateReg.toString(16).toUpperCase().padStart(2, '0')}, actual: ${actualHz.toFixed(2)} Hz)`);

  let floatSamples;
  let inDuration;

  // Use ffmpeg if available or if input is not WAV
  const ext = parsedPath.ext.toLowerCase();
  const useFfmpeg = hasFfmpeg();

  if (useFfmpeg) {
    // Stream through ffmpeg resampler directly into 32-bit float mono PCM pipe
    const ffArgs = ['-y', '-hide_banner', '-loglevel', 'error'];
    if (startTime > 0) ffArgs.push('-ss', String(startTime));
    if (duration !== null && duration > 0) ffArgs.push('-t', String(duration));
    ffArgs.push('-i', inputFile, '-ac', '1', '-ar', String(Math.round(actualHz)), '-f', 'f32le', 'pipe:1');

    const proc = spawnSync('ffmpeg', ffArgs, { maxBuffer: 100 * 1024 * 1024 });
    if (proc.status !== 0 || !proc.stdout || proc.stdout.length === 0) {
      console.error(`[FAILED] ffmpeg conversion failed: ${proc.stderr ? proc.stderr.toString() : 'Unknown error'}`);
      process.exit(1);
    }

    const numSamples = Math.floor(proc.stdout.length / 4);
    floatSamples = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      floatSamples[i] = proc.stdout.readFloatLE(i * 4);
    }
    inDuration = floatSamples.length / actualHz;
  } else {
    // Pure JS Fallback
    if (ext !== '.wav') {
      console.error(`[FAILED] ${ext} format requires ffmpeg to be installed. Please install ffmpeg or convert to WAV first.`);
      process.exit(1);
    }
    const rawBuf = fs.readFileSync(inputFile);
    const { fmt, data } = parseWav(rawBuf);
    const decoded = decodeToFloatMono(fmt, data);

    let startIdx = 0;
    let endIdx = decoded.samples.length;
    if (startTime > 0) startIdx = Math.min(endIdx, Math.floor(startTime * decoded.sampleRate));
    if (duration !== null && duration > 0) endIdx = Math.min(endIdx, startIdx + Math.floor(duration * decoded.sampleRate));

    const sliced = decoded.samples.subarray(startIdx, endIdx);
    floatSamples = resampleFloat(sliced, decoded.sampleRate, actualHz);
    inDuration = floatSamples.length / actualHz;
  }

  // 1. Peak & RMS analysis
  let peak = 0;
  let sumSq = 0;
  for (let i = 0; i < floatSamples.length; i++) {
    const abs = Math.abs(floatSamples[i]);
    if (abs > peak) peak = abs;
    sumSq += abs * abs;
  }
  const rms = Math.sqrt(sumSq / (floatSamples.length || 1));
  const peakDb = peak > 0 ? 20 * Math.log10(peak) : -96;
  const rmsDb = rms > 0 ? 20 * Math.log10(rms) : -96;
  console.log(`  Raw segment: ${floatSamples.length} samples (${inDuration.toFixed(2)}s), Peak: ${peakDb.toFixed(1)} dBFS, RMS: ${rmsDb.toFixed(1)} dBFS`);

  // 2. Normalization / Gain
  let scale = 1.0;
  if (gain !== null) {
    scale = gain;
  } else if (normalize && peak > 0.001) {
    // Normalize peak to -0.3 dBFS (~0.966) to avoid hard saturation
    const targetPeak = Math.pow(10, -0.3 / 20);
    scale = targetPeak / peak;
  }

  // 3. TPDF Dither & Quantization to 8-bit Signed (-128..+127)
  const pcmBytes = new Int8Array(floatSamples.length);
  const previewInt16 = new Int16Array(floatSamples.length);

  for (let i = 0; i < floatSamples.length; i++) {
    let s = floatSamples[i] * scale;
    // Soft clip limiter [-1.0 .. +1.0]
    if (s > 1.0) s = 1.0;
    else if (s < -1.0) s = -1.0;

    let target = s * 127;
    if (dither) {
      // Triangular PDF dither: (R1 - R2) where R is [0..1)
      const d = (Math.random() - Math.random()) * 0.7;
      target += d;
    }

    let q = Math.round(target);
    if (q > 127) q = 127;
    else if (q < -128) q = -128;

    pcmBytes[i] = q;
    previewInt16[i] = q << 8; // Match exact 8-bit quantized playback sound
  }

  // Write .pcm file
  fs.writeFileSync(outputFile, Buffer.from(pcmBytes.buffer));
  const prodosBlocks = Math.ceil(pcmBytes.length / 512);

  console.log(`  Output: ${pcmBytes.length} bytes (${inDuration.toFixed(2)}s @ ${actualHz.toFixed(1)} Hz), ${prodosBlocks} ProDOS blocks`);
  console.log(`  ✔ Wrote ${outputFile}`);

  // Write .wav preview
  if (makeWav) {
    const previewName = outputFile.replace(/\.pcm$/i, '') + '_preview.wav';
    const wavBuf = createWavBuffer(previewInt16, Math.round(actualHz));
    fs.writeFileSync(previewName, wavBuf);
    console.log(`  ✔ Wrote ${previewName} (Audition preview)`);
  }

  return {
    outputFile,
    length: pcmBytes.length,
    samples: pcmBytes.length,
    duration: inDuration,
    rateReg: veraRateReg,
    sampleRate: actualHz,
    prodosBlocks,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  convertWavToPcm(process.argv.slice(2));
}
