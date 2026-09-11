#!/usr/bin/env node
/**
 * check_psg.mjs — algorithm mirror of psgplay.asm's TICK/DO_LOOP/ADV_PTR.
 * Walks a .psg stream EXACTLY the way the 6502 player does (count/FF/
 * loopFrame/skip arithmetic) and asserts structural validity:
 * terminator reachable, loopFrame <= total frames, all regs < 64,
 * loop-skip lands back on a valid frame boundary (terminator re-found).
 *
 * Usage: node check_psg.mjs <file.psg> [expectedFrames] [expectedLoopFrame]
 */
import { readFileSync } from "node:fs";

const [path, expF, expL] = process.argv.slice(2);
if (!path) { console.error("usage: node check_psg.mjs <file.psg> [expectedFrames] [expectedLoopFrame]"); process.exit(1); }
const b = readFileSync(path);

let p = 0, frames = 0, maxCount = 0, totalPairs = 0;
const fail = (m) => { console.error(`[FAILED] ${path}: ${m}`); process.exit(1); };

// Pass 1: linear walk to terminator (mirrors TICK frame advance)
const frameOff = [];
while (true) {
  if (p >= b.length) fail(`ran off end at frame ${frames} (no terminator)`);
  const c = b[p];
  if (c === 0xFF) break;
  if (c > 64) fail(`frame ${frames}: count ${c} > 64 (6502 BCS guard would restart song)`);
  frameOff.push(p);
  maxCount = Math.max(maxCount, c);
  totalPairs += c;
  for (let i = 0; i < c; i++) {
    const reg = b[p + 1 + i * 2];
    if (reg > 63) fail(`frame ${frames}: reg ${reg} > 63 (VRAMAddr would stray off PSG page)`);
  }
  p += 1 + c * 2;
  frames++;
  if (frames > 60 * 601) fail("exceeds 10-min cap worth of frames");
}
if (p + 2 >= b.length) fail("terminator truncated (missing loopFrame u16)");
const loopFrame = b[p + 1] | (b[p + 2] << 8);
if (loopFrame > frames) fail(`loopFrame ${loopFrame} > total frames ${frames}`);
console.log(`${path}: ${frames} frames, ${totalPairs} pairs, maxCount ${maxCount}, loopFrame ${loopFrame}`);

// Pass 2: mirror DO_LOOP skip — rewind + skip loopFrame records, must land
// exactly on a frame boundary, then walk to terminator again.
let q = 0;
for (let i = 0; i < loopFrame; i++) {
  const c = b[q];
  if (c === 0xFF) fail(`loop-skip hit $FF at skipped frame ${i} (6502 DO_RESTART guard)`);
  q += 1 + c * 2;
}
if (!frameOff.includes(q) && q !== p) fail(`loop-skip lands at byte ${q}, not a frame boundary`);
let f2 = 0;
while (b[q] !== 0xFF) { q += 1 + b[q] * 2; f2++; }
if (q !== p) fail(`post-loop walk ends at byte ${q}, expected terminator at ${p}`);
console.log(`  loop-skip ok: lands frame ${loopFrame}, replays ${f2} frames to terminator`);

if (expF !== undefined && frames !== +expF) fail(`frames ${frames} != expected ${expF}`);
if (expL !== undefined && loopFrame !== +expL) fail(`loopFrame ${loopFrame} != expected ${expL}`);
console.log("[SUCCESS] stream is 6502-player-safe.");
