#!/usr/bin/env node
/**
 * build_psgplay.mjs — assemble psgplay.asm (slot 2 + slot 4) and append a
 * .psg stream right after the code at STREAM_DATA.
 *
 * Usage: node build_psgplay.mjs <stream.psg>
 *
 * Outputs: PSGPLAY.BIN (slot 2) + PSGPLAY4.BIN (slot 4), load address $2000,
 * ProDOS BIN type $06 (BRUN-able, matching the veratest demo convention).
 *
 * Fit rule: the whole image must end below $9500 (ProDOS buffers live at
 * $9600+). Small tunes (test_tune.psg, 1295 B) fit easily; big streams
 * (BreakLine.psg, 47 KB) are REJECTED here on purpose — they need the
 * HDV-streaming Jukebox variant (veraport roadmap step 3), not this player.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assembleAsmFile } from "../veratest/src/asm6502.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// vera.inc is vendored in this dir (assembleAsmFile finds it beside the .asm).
// Never let VERA_* silently assemble to $0000 (see veraport gotcha).
const streamPath = process.argv[2];
if (!streamPath) {
  console.error("usage: node build_psgplay.mjs <stream.psg>");
  process.exit(1);
}
const stream = readFileSync(join(here, streamPath));
const LOAD = 0x2000;
const LIMIT = 0x9500;

// Safety: STREAM_DATA must be the last thing in the source (stream is
// appended at end-of-code by construction). Fail loudly if anyone adds
// data directives after it.
const src = readFileSync(join(here, "psgplay.asm"), "utf-8");
const afterLabel = src.slice(src.lastIndexOf("STREAM_DATA:")).split(/\r?\n/).slice(1);
const bad = afterLabel.filter((ln) => {
  const code = ln.split(";")[0].trim().split(/\s+/)[0] || "";
  return /^(HEX|!BYTE|\.BYTE|!WORD|\.WORD|DW|DA|ASC)$/i.test(code);
});
if (bad.length) {
  console.error("[FAILED] data directives found after STREAM_DATA — stream append offset would be wrong");
  process.exit(1);
}

for (const slot of [2, 4]) {
  const code = assembleAsmFile(here, "psgplay.asm", slot, LOAD);
  // Zero-address guard: any abs LDA/STA/INC/DEC/JMP/JSR to $0000 means an
  // unresolved label slipped through (resolveVal falls back to NaN -> 0).
  for (let i = 0; i + 2 < code.length; i++) {
    if ([0xAD, 0x8D, 0xEE, 0xCE, 0x4C, 0x20].includes(code[i]) && code[i + 1] === 0 && code[i + 2] === 0) {
      console.error(`[FAILED] slot ${slot}: $${code[i].toString(16)}0000 reference at code offset ${i} — unresolved label?`);
      process.exit(1);
    }
  }
  const streamBase = LOAD + code.length;
  const end = streamBase + stream.length;
  const name = basename(streamPath).replace(/\.[^.]+$/, "");
  console.log(`slot ${slot}: code ${code.length} B @ $${LOAD.toString(16)} ` +
    `+ stream ${stream.length} B @ $${streamBase.toString(16)} ` +
    `-> end $${end.toString(16)} (${name})`);
  if (end >= LIMIT) {
    console.error(`[FAILED] image ends at $${end.toString(16)} >= $${LIMIT.toString(16)}: ` +
      `"${name}" does not fit main RAM. This tune needs the HDV-streaming Jukebox build (veraport step 3).`);
    process.exit(1);
  }
  const out = Buffer.concat([Buffer.from(code), stream]);
  const suffix = slot === 2 ? "" : "4";
  writeFileSync(join(here, `PSGPLAY${suffix}.BIN`), out);
  console.log(`  wrote PSGPLAY${suffix}.BIN (${out.length} bytes)`);
}
console.log("[SUCCESS] psgplay binaries built.");
