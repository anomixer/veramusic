#!/usr/bin/env node
/**
 * build_zsmstream.mjs — assemble zsmstream.asm (slot 2 + slot 4) into ProDOS BINs.
 *
 * Usage: node tools/build_zsmstream.mjs [--autoplay]
 *
 * Outputs: src/ZSMSTREAM.BIN (slot 2) + src/ZSMSTREAM4.BIN (slot 4), $2000,
 * ProDOS BIN type $06 (BRUN-able). `--autoplay` also writes src/ZSMSTREAMA.BIN
 * with AUTOPLAY=1 injected (headless verification disk).
 *
 * zeroGuard: scans only the code region (up to the data table start, found by
 * locating the first song name "CANYON.ZSM") for `$0000` absolute refs, which
 * are the signature of an unresolved label. Data tables are arbitrary bytes and
 * are excluded.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { assembleAsmFile } from "../../veratest/src/asm6502.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");
const LOAD = 0x2000;
const LIMIT = 0x3800;

// First data-table string (SONG_NAMES). Code region ends where this appears.
const MARKER = Array.from("CANYON.ZSM", (c) => c.charCodeAt(0));
const codeRegionEnd = (code) => {
  for (let i = 0; i + MARKER.length <= code.length; i++) {
    let m = true;
    for (let k = 0; k < MARKER.length; k++) if (code[i + k] !== MARKER[k]) { m = false; break; }
    if (m) return i;
  }
  return code.length;
};

const zeroGuard = (code) => {
  const ds = codeRegionEnd(code);
  const bad = [];
  for (let i = 0; i + 2 < ds; i++) {
    if ([0xAD, 0x8D, 0xEE, 0xCE, 0x4C, 0x20].includes(code[i]) && code[i + 1] === 0 && code[i + 2] === 0) {
      bad.push(i);
    }
  }
  return bad;
};

const build = (slot, extraLines) => {
  const code = assembleAsmFile(srcDir, "zsmstream.asm", slot, LOAD, extraLines);
  const end = LOAD + code.length;
  if (end > LIMIT) {
    console.error(`[FAILED] slot ${slot}: code ends $${end.toString(16)} > $${LIMIT.toString(16)}`);
    process.exit(1);
  }
  const bad = zeroGuard(code);
  if (bad.length) {
    console.error(`[FAILED] slot ${slot}: unresolved $0000 refs at ${bad.map((i) => `$${(LOAD + i).toString(16)}`).join(", ")}`);
    process.exit(1);
  }
  return code;
};

for (const slot of [2, 4]) {
  const code = build(slot, []);
  const name = slot === 2 ? "ZSMSTREAM.BIN" : "ZSMSTREAM4.BIN";
  writeFileSync(join(srcDir, name), code);
  console.log(`wrote src/${name} (${code.length} bytes @ $${LOAD.toString(16)}, end $${(LOAD + code.length).toString(16)})`);
}

if (process.argv.includes("--autoplay")) {
  const autoIdx = process.argv.indexOf("--autosong");
  const autoSong = autoIdx >= 0 ? Number(process.argv[autoIdx + 1]) : 0;
  const code = build(2, [`AUTOPLAY = 1`, `AUTOSONG = ${autoSong}`]);
  writeFileSync(join(srcDir, "ZSMSTREAMA.BIN"), code);
  console.log(`wrote src/ZSMSTREAMA.BIN (${code.length} bytes, AUTOPLAY=1, AUTOSONG=${autoSong})`);
}
console.log("[SUCCESS] zsmstream built.");
