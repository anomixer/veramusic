#!/usr/bin/env node
/**
 * build_pcmplay.mjs — VERA PCM RAM Player Builder
 *
 * Compiles pcmplay.asm (Slot 2 & Slot 4) and appends a .pcm sample
 * for immediate BRUN playback in Apple2TS / AppleWin.
 *
 * Usage:
 *   node build_pcmplay.mjs [sample.pcm] [--title="..."] [--rate=21] [--no-loop]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleAsmFile } from '../veratest/src/asm6502.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const LOAD = 0x2000;

let pcmFile = path.join(here, 'wellerman_ram.pcm');
let title = 'A.NAKARADA: WELLERMAN (8KHZ)   ';
let rateVal = 21;
let loop = 1;

for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--title=')) title = arg.split('=')[1];
  else if (arg.startsWith('--rate=')) rateVal = parseInt(arg.split('=')[1], 10);
  else if (arg === '--no-loop') loop = 0;
  else if (!arg.startsWith('-')) pcmFile = arg;
}

if (!fs.existsSync(pcmFile)) {
  console.error(`[FAILED] PCM file not found: ${pcmFile}`);
  process.exit(1);
}

const pcmData = fs.readFileSync(pcmFile);
if (LOAD + 700 + pcmData.length >= 0x9600) {
  console.warn(`[WARN] Combined binary size (${pcmData.length + 700} B) reaches $${(LOAD + 700 + pcmData.length).toString(16)} (approaching ProDOS buffers at $9600)`);
}

function assemblePlayer(slot) {
  const code = assembleAsmFile(here, 'pcmplay.asm', slot, LOAD);
  const buf = Buffer.from(code);

  // Patch header at $2005:
  // +5: PCM_LEN_L, PCM_LEN_H
  // +7: RATE_VAL
  // +8: LOOP_ENA
  // +9: TITLE (32 bytes)
  buf.writeUInt16LE(pcmData.length, 5);
  buf.writeUInt8(rateVal, 7);
  buf.writeUInt8(loop, 8);

  const paddedTitle = title.padEnd(32, ' ').slice(0, 32);
  for (let i = 0; i < 32; i++) {
    buf[9 + i] = paddedTitle.charCodeAt(i);
  }

  return Buffer.concat([buf, pcmData]);
}

const pcmPlay2 = assemblePlayer(2);
const pcmPlay4 = assemblePlayer(4);

const out2 = path.join(here, 'PCMPLAY.BIN');
const out4 = path.join(here, 'PCMPLAY4.BIN');

fs.writeFileSync(out2, pcmPlay2);
fs.writeFileSync(out4, pcmPlay4);

console.log(`[SUCCESS] Built VERA PCM RAM Players:`);
console.log(`  PCMPLAY.BIN  (Slot 2): ${pcmPlay2.length} bytes (Code: ${pcmPlay2.length - pcmData.length} B, Sample: ${pcmData.length} B)`);
console.log(`  PCMPLAY4.BIN (Slot 4): ${pcmPlay4.length} bytes`);
console.log(`  Rate: ${rateVal} (${((rateVal / 128) * (25000000 / 512)).toFixed(1)} Hz), Loop: ${loop ? 'ON' : 'OFF'}`);
