#!/usr/bin/env node
/**
 * build_jukebox.mjs — VERA PSG & PCM Jukebox Disk Builder
 *
 * Produces TWO bootable ProDOS images:
 *   1. jukebox.po  (140KB floppy, 280 blocks):
 *      - Track 1: Melody Demo (RAM PSG, 0:30)
 *      - Track 2: Chopin Fantaisie-Impromptu (Stream PSG from block 100, 5:17)
 *   2. jukebox.hdv (32MB ProDOS Hard Disk Volume, 65,535 blocks):
 *      - Track 1: Melody Demo (RAM PSG, 0:30)
 *      - Track 2: Chopin Fantaisie-Impromptu (Stream PSG from block 100, 5:17)
 *      - Track 3: Michael Jackson: Beat It (Stream PSG from block 300, 3:58)
 *      - Track 4: Space Debris (Stream PCM from block 5000, 5:05)
 *      - Track 5: The Wellerman (Stream PCM from block 600, 2:00)
 *
 * Zero external dependencies. Uses Apple2TS / veratest 6502 assembler + tokenizer.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { assembleAsmFile } from "../../veratest/src/asm6502.mjs";
import { compileApplesoftBasic } from "../../veratest/src/applebasic.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, "..");
const srcDir = path.join(rootDir, "src");
const musicDir = path.join(rootDir, "music");
const LOAD = 0x2000;

const need = (p, what) => {
  if (!fs.existsSync(p)) { console.error(`[FAILED] missing ${what}: ${p}`); process.exit(1); }
  return fs.readFileSync(p);
};

// ---- Inputs ----------------------------------------------------------------
const demoTune = need(path.join(musicDir, "demo.psg"), "demo.psg (run gen_demo + mod2psg first)");
const fantaisieTune = need(path.join(musicDir, "Fantaisie-impromptu.psg"), "Fantaisie-impromptu.psg (run mid2psg first)");
const beatitTune = need(path.join(musicDir, "BeatIt.psg"), "BeatIt.psg (run mid2psg BeatIt.mid first)");
const spaceDebrisPcm = need(path.join(musicDir, "space_debris.pcm"), "space_debris.pcm (run render_pure_pcm.mjs first)");
const wellermanTune = need(path.join(musicDir, "wellerman_full.pcm"), "wellerman_full.pcm (run wav2pcm first)");

const basePo = need(path.join(rootDir, "..", "veratest", "assets", "ProDOS 2.4.3.po"), "ProDOS 2.4.3.po template");
if (basePo.length !== 143360) { console.error("[FAILED] bad 140K template size"); process.exit(1); }

const baseHdv = need(path.join(rootDir, "..", "veratest", "assets", "ProDOS 2.4.3.hdv"), "ProDOS 2.4.3.hdv 32MB template");
if (baseHdv.length !== 33553920) { console.error("[FAILED] bad 32MB template size"); process.exit(1); }

// ---- Assemble Players -------------------------------------------------------
const zeroGuard = (code, slot, what) => {
  for (let i = 0; i + 2 < code.length; i++) {
    if ([0xAD, 0x8D, 0xEE, 0xCE, 0x4C, 0x20].includes(code[i]) && code[i + 1] === 0 && code[i + 2] === 0) {
      console.error(`[FAILED] ${what} slot ${slot}: $0000 ref at offset ${i} (unresolved label?)`);
      process.exit(1);
    }
  }
};

const patchTitle = (codeBuf, titleStr, placeholder = "VERA PSG", targetLen = 32) => {
  const buf = Uint8Array.from(codeBuf);
  const padded = titleStr.padEnd(targetLen, " ").slice(0, targetLen);
  for (let i = 0; i + placeholder.length <= buf.length; i++) {
    let match = true;
    for (let j = 0; j < placeholder.length; j++) {
      if (buf[i + j] !== placeholder.charCodeAt(j)) { match = false; break; }
    }
    if (match) {
      for (let k = 0; k < targetLen; k++) buf[i + k] = padded.charCodeAt(k);
      break;
    }
  }
  return buf;
};

// Lightweight zero-dependency standard ZIP builder
function writeSingleFileZip(outZipPath, entryName, dataBuf) {
  const crc = zlib.crc32(dataBuf);
  const compressed = zlib.deflateRawSync(dataBuf, { level: 6 });
  const entryNameBuf = Buffer.from(entryName, "utf8");

  const localHeaderLen = 30 + entryNameBuf.length;
  const centralHeaderLen = 46 + entryNameBuf.length;
  const totalLen = localHeaderLen + compressed.length + centralHeaderLen + 22;
  const zip = Buffer.alloc(totalLen);
  let pos = 0;

  // Local file header (0x04034b50)
  zip.writeUInt32LE(0x04034b50, pos); pos += 4;
  zip.writeUInt16LE(20, pos); pos += 2; // version needed: 2.0
  zip.writeUInt16LE(0, pos); pos += 2;  // flags
  zip.writeUInt16LE(8, pos); pos += 2;  // compression: Deflate
  zip.writeUInt16LE(0, pos); pos += 2;  // mod time
  zip.writeUInt16LE(0, pos); pos += 2;  // mod date
  zip.writeUInt32LE(crc, pos); pos += 4;
  zip.writeUInt32LE(compressed.length, pos); pos += 4;
  zip.writeUInt32LE(dataBuf.length, pos); pos += 4;
  zip.writeUInt16LE(entryNameBuf.length, pos); pos += 2;
  zip.writeUInt16LE(0, pos); pos += 2;  // extra field length
  entryNameBuf.copy(zip, pos); pos += entryNameBuf.length;
  compressed.copy(zip, pos); pos += compressed.length;

  const centralOffset = localHeaderLen + compressed.length;

  // Central directory file header (0x02014b50)
  zip.writeUInt32LE(0x02014b50, pos); pos += 4;
  zip.writeUInt16LE(20, pos); pos += 2; // version made by: 2.0
  zip.writeUInt16LE(20, pos); pos += 2; // version needed: 2.0
  zip.writeUInt16LE(0, pos); pos += 2;  // flags
  zip.writeUInt16LE(8, pos); pos += 2;  // compression: Deflate
  zip.writeUInt16LE(0, pos); pos += 2;  // mod time
  zip.writeUInt16LE(0, pos); pos += 2;  // mod date
  zip.writeUInt32LE(crc, pos); pos += 4;
  zip.writeUInt32LE(compressed.length, pos); pos += 4;
  zip.writeUInt32LE(dataBuf.length, pos); pos += 4;
  zip.writeUInt16LE(entryNameBuf.length, pos); pos += 2;
  zip.writeUInt16LE(0, pos); pos += 2;  // extra field length
  zip.writeUInt16LE(0, pos); pos += 2;  // comment length
  zip.writeUInt16LE(0, pos); pos += 2;  // disk number
  zip.writeUInt16LE(0, pos); pos += 2;  // internal file attr
  zip.writeUInt32LE(0, pos); pos += 4;  // external file attr
  zip.writeUInt32LE(0, pos); pos += 4;  // local header offset
  entryNameBuf.copy(zip, pos); pos += entryNameBuf.length;

  // End of central directory record (0x06054b50)
  zip.writeUInt32LE(0x06054b50, pos); pos += 4;
  zip.writeUInt16LE(0, pos); pos += 2;  // disk number
  zip.writeUInt16LE(0, pos); pos += 2;  // start disk
  zip.writeUInt16LE(1, pos); pos += 2;  // entries on this disk
  zip.writeUInt16LE(1, pos); pos += 2;  // total entries
  zip.writeUInt32LE(centralHeaderLen, pos); pos += 4; // size of central dir
  zip.writeUInt32LE(centralOffset, pos); pos += 4;   // offset of central dir
  zip.writeUInt16LE(0, pos); pos += 2;  // comment length

  fs.writeFileSync(outZipPath, zip);
}

const asm = (file, slot, extraLines = []) => {
  const code = assembleAsmFile(srcDir, file, slot, LOAD, extraLines);
  zeroGuard(code, slot, file);
  return code;
};

// 1. RAM Player for Demo
const playCode2 = patchTitle(asm("psgplay.asm", 2), "MELODY DEMO (0:30, RAM)         ", "VERA PSG PLAYER");
const playCode4 = patchTitle(asm("psgplay.asm", 4), "MELODY DEMO (0:30, RAM)         ", "VERA PSG PLAYER");
const testtune2 = Buffer.concat([Buffer.from(playCode2), demoTune]);
const testtune4 = Buffer.concat([Buffer.from(playCode4), demoTune]);

// 2. Stream Player for Chopin (Starts at block 100)
const streamChopin2 = patchTitle(asm("psgstream.asm", 2, ["STREAM_BLK0 = 100"]), "CHOPIN: FANTAISIE-IMPROMPTU (5:02)", "VERA PSG STREAM", 40);
const streamChopin4 = patchTitle(asm("psgstream.asm", 4, ["STREAM_BLK0 = 100"]), "CHOPIN: FANTAISIE-IMPROMPTU (5:02)", "VERA PSG STREAM", 40);

// 2b. VERA VRAM Pre-Load Player for Chopin on Floppy Disk (jukebox.po): eliminates floppy read pauses!
const fantaisieBlks = Math.ceil(fantaisieTune.length / 512);
const vramChopin2 = asm("psgvram.asm", 2, [
  "STREAM_BLK0 = 100",
  `TOTAL_BLKS = ${fantaisieBlks}`
]);
const vramChopin4 = asm("psgvram.asm", 4, [
  "STREAM_BLK0 = 100",
  `TOTAL_BLKS = ${fantaisieBlks}`
]);

// 3. Stream Player for Michael Jackson: Beat It (Starts at block 300)
const streamBeat2 = patchTitle(asm("psgstream.asm", 2, ["STREAM_BLK0 = 300"]), "M. JACKSON: BEAT IT (3:58)", "VERA PSG STREAM", 40);
const streamBeat4 = patchTitle(asm("psgstream.asm", 4, ["STREAM_BLK0 = 300"]), "M. JACKSON: BEAT IT (3:58)", "VERA PSG STREAM", 40);

// 4. Stream PCM Player for Space Debris (Track 4: Starts at block 5000, 5:05)
const spaceDebrisPcmBlks = Math.ceil(spaceDebrisPcm.length / 512);
const SPACE_PCM_BLK0 = 5000;
const pcmdeb2 = patchTitle(asm("pcmstream.asm", 2, [
  `STREAM_BLK0 = ${SPACE_PCM_BLK0}`,
  `TOTAL_BLKS = ${spaceDebrisPcmBlks}`,
  "RATE_VAL = 21"
]), "CAPTAIN: SPACE DEBRIS (5:05)", "A. NAKARADA: THE WELLERMAN", 40);
const pcmdeb4 = patchTitle(asm("pcmstream.asm", 4, [
  `STREAM_BLK0 = ${SPACE_PCM_BLK0}`,
  `TOTAL_BLKS = ${spaceDebrisPcmBlks}`,
  "RATE_VAL = 21"
]), "CAPTAIN: SPACE DEBRIS (5:05)", "A. NAKARADA: THE WELLERMAN", 40);

// 5. Stream Player for Alexander Nakarada - The Wellerman (Starts at block 600, FULL 2:00 SONG)
const wellermanBlks = Math.ceil(wellermanTune.length / 512);
const pcmwel2 = asm("pcmstream.asm", 2, [
  "STREAM_BLK0 = 600",
  `TOTAL_BLKS = ${wellermanBlks}`,
  "RATE_VAL = 21"
]);
const pcmwel4 = asm("pcmstream.asm", 4, [
  "STREAM_BLK0 = 600",
  `TOTAL_BLKS = ${wellermanBlks}`,
  "RATE_VAL = 21"
]);

for (const [c, n] of [
  [streamChopin2, "streamChopin2"], [streamChopin4, "streamChopin4"],
  [vramChopin2, "vramChopin2"],     [vramChopin4, "vramChopin4"],
  [streamBeat2, "streamBeat2"],     [streamBeat4, "streamBeat4"],
  [pcmdeb2, "pcmdeb2"],             [pcmdeb4, "pcmdeb4"],
  [pcmwel2, "pcmwel2"],             [pcmwel4, "pcmwel4"]
]) {
  if (LOAD + c.length >= 0x3800) {
    console.error(`[FAILED] ${n} ends at $${(LOAD + c.length).toString(16)} — collides with $4000 buffer`);
    process.exit(1);
  }
}

// 5. Applesoft BASIC Startup menus
const startupPoCode = compileApplesoftBasic(srcDir, "startup_po.bas");
const startupHdvCode = compileApplesoftBasic(srcDir, "startup.bas");

// ============================================================================
// BUILD 1: jukebox.po (140KB Floppy, 280 blocks)
// ============================================================================
{
  const disk = new Uint8Array(basePo);
  const bitmap = disk.subarray(6 * 512, 7 * 512);
  const isFree = (b) => (bitmap[Math.floor(b / 8)] & (1 << (7 - (b % 8)))) !== 0;
  const markUsed = (b) => { bitmap[Math.floor(b / 8)] &= ~(1 << (7 - (b % 8))); };
  const markFree = (b) => { bitmap[Math.floor(b / 8)] |= (1 << (7 - (b % 8))); };

  let freeSearch = 7;
  const alloc = () => {
    while (freeSearch < 280) {
      if (isFree(freeSearch)) { const b = freeSearch++; markUsed(b); disk.fill(0, b * 512, (b + 1) * 512); return b; }
      freeSearch++;
    }
    throw new Error("Disk full (140KB)");
  };

  let fileCount = 0, curr = 2;
  while (curr !== 0) {
    const blk = disk.subarray(curr * 512, (curr + 1) * 512);
    const next = blk[0x02] | (blk[0x03] << 8);
    for (let i = 0; i < 13; i++) {
      if (curr === 2 && i === 0) continue;
      const off = 4 + i * 39, st = blk[off];
      if (st === 0) continue;
      const nm = String.fromCharCode(...blk.subarray(off + 1, off + 1 + (st & 0x0F)));
      if (nm === "PRODOS" || nm === "BASIC.SYSTEM") { fileCount++; continue; }
      const key = blk[off + 0x11] | (blk[off + 0x12] << 8);
      if (((st >> 4) & 0x0F) === 1) markFree(key);
      else {
        markFree(key);
        const ix = disk.subarray(key * 512, (key + 1) * 512);
        for (let b = 0; b < 256; b++) { const db = ix[b] | (ix[b + 256] << 8); if (db) markFree(db); }
      }
      blk.fill(0, off, off + 39);
    }
    curr = next;
  }

  const addDirEntry = (filename, type, aux, size, stType, keyBlock, blocksUsed) => {
    let bn = 2;
    while (bn !== 0) {
      const blk = disk.subarray(bn * 512, (bn + 1) * 512), next = blk[0x02] | (blk[0x03] << 8);
      for (let i = 0; i < 13; i++) {
        const off = 4 + i * 39;
        if (bn === 2 && i === 0) continue;
        if (blk[off] === 0) {
          blk[off] = (stType << 4) | (filename.length & 0x0F);
          for (let c = 0; c < 15; c++) blk[off + 1 + c] = c < filename.length ? filename.charCodeAt(c) : 0;
          blk[off + 0x10] = type;
          blk[off + 0x11] = keyBlock & 0xFF; blk[off + 0x12] = (keyBlock >> 8) & 0xFF;
          blk[off + 0x13] = blocksUsed & 0xFF; blk[off + 0x14] = (blocksUsed >> 8) & 0xFF;
          blk[off + 0x15] = size & 0xFF; blk[off + 0x16] = (size >> 8) & 0xFF; blk[off + 0x17] = (size >> 16) & 0xFF;
          blk[off + 0x1E] = 0xC3; blk[off + 0x1F] = aux & 0xFF; blk[off + 0x20] = (aux >> 8) & 0xFF;
          blk[off + 0x25] = 0x02; blk[off + 0x26] = 0x00;
          fileCount++;
          return;
        }
      }
      bn = next;
    }
    throw new Error("Directory full (140KB)");
  };

  const addFile = (filename, type, aux, data) => {
    const size = data.length;
    let stType, key;
    if (size <= 512) { stType = 1; key = alloc(); disk.set(data, key * 512); }
    else {
      stType = 2; key = alloc();
      const ix = disk.subarray(key * 512, (key + 1) * 512);
      const n = Math.ceil(size / 512);
      for (let i = 0; i < n; i++) {
        const db = alloc();
        disk.set(data.subarray(i * 512, Math.min(size, (i + 1) * 512)), db * 512);
        ix[i] = db & 0xFF; ix[i + 256] = (db >> 8) & 0xFF;
      }
    }
    addDirEntry(filename, type, aux, size, stType, key, stType === 1 ? 1 : 1 + Math.ceil(size / 512));
  };

  addFile("TESTTUNE.BIN", 0x06, 0x2000, testtune2);
  addFile("TESTTUNE4.BIN", 0x06, 0x2000, testtune4);
  addFile("STREAM.BIN", 0x06, 0x2000, vramChopin2);
  addFile("STREAM4.BIN", 0x06, 0x2000, vramChopin4);
  addFile("STARTUP", 0xFC, 0x0801, startupPoCode);

  const streamBlks = Math.ceil(fantaisieTune.length / 512);
  const STREAM_BLK0 = 100;
  for (let b = STREAM_BLK0; b < STREAM_BLK0 + streamBlks; b++) {
    if (!isFree(b)) { console.error(`[FAILED] raw block ${b} already allocated — move STREAM_BLK0`); process.exit(1); }
    markUsed(b);
  }

  const streamKey = alloc();
  const ix = disk.subarray(streamKey * 512, (streamKey + 1) * 512);
  for (let i = 0; i < streamBlks; i++) {
    const db = STREAM_BLK0 + i;
    disk.set(fantaisieTune.subarray(i * 512, Math.min(fantaisieTune.length, (i + 1) * 512)), db * 512);
    ix[i] = db & 0xFF; ix[i + 256] = (db >> 8) & 0xFF;
  }

  addDirEntry("FANTAISIE.PSG", 0x00, 0x0000, fantaisieTune.length, 2, streamKey, 1 + streamBlks);
  disk[2 * 512 + 0x25] = fileCount & 0xFF;
  disk[2 * 512 + 0x26] = (fileCount >> 8) & 0xFF;

  const outPo = path.join(rootDir, "jukebox.po");
  try { fs.writeFileSync(outPo, disk); }
  catch (e) {
    if (e.code === "EBUSY" || e.code === "EPERM") {
      fs.writeFileSync(outPo + ".new", disk);
      console.warn("  [WARN] jukebox.po locked by emulator, wrote jukebox.po.new");
    } else throw e;
  }
  let freePo = 0; for (let b = 0; b < 280; b++) if (isFree(b)) freePo++;
  console.log(`[SUCCESS] jukebox.po  (140KB): ${fileCount} files, FANTAISIE.PSG blks 100-${STREAM_BLK0 + streamBlks - 1} (${streamBlks} blks), ${freePo} blks free`);
}

// ============================================================================
// BUILD 2: jukebox.hdv (32MB ProDOS Hard Disk Volume, 65,535 blocks)
// ============================================================================
{
  const TOTAL_BLOCKS = 65535;
  const disk = new Uint8Array(baseHdv);
  const bmOffset = 6 * 512;

  const isFree = (b) => (disk[bmOffset + Math.floor(b / 8)] & (1 << (7 - (b % 8)))) !== 0;
  const markUsed = (b) => { disk[bmOffset + Math.floor(b / 8)] &= ~(1 << (7 - (b % 8))); };

  // 1. Rename volume to JUKEBOX
  const volName = "JUKEBOX";
  const volBase = 2 * 512;
  disk[volBase + 0x04] = 0xF0 | (volName.length & 0x0F);
  for (let c = 0; c < 15; c++) disk[volBase + 0x05 + c] = c < volName.length ? volName.charCodeAt(c) : 0;

  // 2. Filter base entries: preserve PRODOS, CLOCK.SYSTEM, BASIC.SYSTEM, remove BITSY.BOOT and QUIT.SYSTEM
  const preservedEntries = [];
  for (let i = 1; i <= 12; i++) {
    const off = volBase + 4 + i * 39;
    const stLen = disk[off];
    if (stLen === 0) continue;
    const nm = String.fromCharCode(...disk.subarray(off + 1, off + 1 + (stLen & 0x0F)));
    if (nm === "QUIT.SYSTEM" || nm === "BITSY.BOOT") {
      // omit
    } else {
      preservedEntries.push(disk.slice(off, off + 39));
    }
  }

  // Clear old entries in block 2
  for (let i = 1; i <= 12; i++) {
    disk.fill(0, volBase + 4 + i * 39, volBase + 4 + (i + 1) * 39);
  }

  // Rewrite preserved entries
  for (let i = 0; i < preservedEntries.length; i++) {
    disk.set(preservedEntries[i], volBase + 4 + (i + 1) * 39);
  }

  let fileCount = preservedEntries.length;

  // 3. Pre-reserve contiguous block ranges for the streaming tracks:
  //    Track 2 (Chopin):        blocks 100..100+fantaisieBlks-1
  //    Track 3 (Beat It):       blocks 300..300+beatitBlks-1 (FULL 3:58 SONG!)
  //    Track 5 (Wellerman):     blocks 600..600+wellermanBlks-1 (FULL 2:00 SONG!)
  //    Track 4 (Space Debris):  blocks 5000..5000+spaceDebrisPcmBlks-1 (100% Pure PCM)
  const fantaisieBlks = Math.ceil(fantaisieTune.length / 512);
  const beatitBlks = Math.ceil(beatitTune.length / 512);
  const CHOPIN_BLK0 = 100;
  const BEATIT_BLK0 = 300;
  const WELLERMAN_BLK0 = 600;

  for (let b = CHOPIN_BLK0; b < CHOPIN_BLK0 + fantaisieBlks; b++) markUsed(b);
  for (let b = BEATIT_BLK0; b < BEATIT_BLK0 + beatitBlks; b++) markUsed(b);
  for (let b = WELLERMAN_BLK0; b < WELLERMAN_BLK0 + wellermanBlks; b++) markUsed(b);
  for (let b = SPACE_PCM_BLK0; b < SPACE_PCM_BLK0 + spaceDebrisPcmBlks; b++) markUsed(b);

  // Write streaming audio payloads into disk blocks
  for (let i = 0; i < fantaisieBlks; i++) {
    const db = CHOPIN_BLK0 + i;
    disk.set(fantaisieTune.subarray(i * 512, Math.min(fantaisieTune.length, (i + 1) * 512)), db * 512);
  }
  for (let i = 0; i < beatitBlks; i++) {
    const db = BEATIT_BLK0 + i;
    disk.set(beatitTune.subarray(i * 512, Math.min(beatitTune.length, (i + 1) * 512)), db * 512);
  }
  for (let i = 0; i < wellermanBlks; i++) {
    const db = WELLERMAN_BLK0 + i;
    disk.set(wellermanTune.subarray(i * 512, Math.min(wellermanTune.length, (i + 1) * 512)), db * 512);
  }
  for (let i = 0; i < spaceDebrisPcmBlks; i++) {
    const db = SPACE_PCM_BLK0 + i;
    disk.set(spaceDebrisPcm.subarray(i * 512, Math.min(spaceDebrisPcm.length, (i + 1) * 512)), db * 512);
  }

  // 4. Block Allocator for general files (starts searching at block 87)
  let freeSearch = 87;
  const alloc = () => {
    while (freeSearch < TOTAL_BLOCKS) {
      if (isFree(freeSearch)) {
        const b = freeSearch++;
        markUsed(b);
        disk.fill(0, b * 512, (b + 1) * 512);
        return b;
      }
      freeSearch++;
    }
    throw new Error("Disk full (32MB HDV)");
  };

  const addDirEntry = (filename, type, aux, size, stType, keyBlock, blocksUsed) => {
    let bn = 2;
    while (bn !== 0) {
      const blk = disk.subarray(bn * 512, (bn + 1) * 512), next = blk[0x02] | (blk[0x03] << 8);
      for (let i = 0; i < 13; i++) {
        const off = 4 + i * 39;
        if (bn === 2 && i === 0) continue;
        if (blk[off] === 0) {
          blk[off] = (stType << 4) | (filename.length & 0x0F);
          for (let c = 0; c < 15; c++) blk[off + 1 + c] = c < filename.length ? filename.charCodeAt(c) : 0;
          blk[off + 0x10] = type;
          blk[off + 0x11] = keyBlock & 0xFF; blk[off + 0x12] = (keyBlock >> 8) & 0xFF;
          blk[off + 0x13] = blocksUsed & 0xFF; blk[off + 0x14] = (blocksUsed >> 8) & 0xFF;
          blk[off + 0x15] = size & 0xFF; blk[off + 0x16] = (size >> 8) & 0xFF; blk[off + 0x17] = (size >> 16) & 0xFF;
          blk[off + 0x1E] = 0xC3; blk[off + 0x1F] = aux & 0xFF; blk[off + 0x20] = (aux >> 8) & 0xFF;
          blk[off + 0x25] = 0x02; blk[off + 0x26] = 0x00;
          fileCount++;
          return;
        }
      }
      bn = next;
    }
    throw new Error("Directory full (32MB HDV)");
  };

  const addFile = (filename, type, aux, data) => {
    const size = data.length;
    let stType, key;
    if (size <= 512) { stType = 1; key = alloc(); disk.set(data, key * 512); }
    else {
      stType = 2; key = alloc();
      const ix = disk.subarray(key * 512, (key + 1) * 512);
      const n = Math.ceil(size / 512);
      for (let i = 0; i < n; i++) {
        const db = alloc();
        disk.set(data.subarray(i * 512, Math.min(size, (i + 1) * 512)), db * 512);
        ix[i] = db & 0xFF; ix[i + 256] = (db >> 8) & 0xFF;
      }
    }
    addDirEntry(filename, type, aux, size, stType, key, stType === 1 ? 1 : 1 + Math.ceil(size / 512));
  };

  // Add system menu and player binaries
  addFile("STARTUP", 0xFC, 0x0801, startupHdvCode);
  addFile("TESTTUNE.BIN", 0x06, 0x2000, testtune2);
  addFile("TESTTUNE4.BIN", 0x06, 0x2000, testtune4);
  addFile("STREAM.BIN", 0x06, 0x2000, vramChopin2);
  addFile("STREAM4.BIN", 0x06, 0x2000, vramChopin4);
  addFile("BEATIT.BIN", 0x06, 0x2000, streamBeat2);
  addFile("BEATIT4.BIN", 0x06, 0x2000, streamBeat4);
  addFile("PCMDEB.BIN", 0x06, 0x2000, pcmdeb2);
  addFile("PCMDEB4.BIN", 0x06, 0x2000, pcmdeb4);
  addFile("PCMWEL.BIN", 0x06, 0x2000, pcmwel2);
  addFile("PCMWEL4.BIN", 0x06, 0x2000, pcmwel4);

  // Add sapling index blocks for CATALOG visibility
  const chopinKey = alloc();
  const chopinIx = disk.subarray(chopinKey * 512, (chopinKey + 1) * 512);
  for (let i = 0; i < fantaisieBlks; i++) {
    const db = CHOPIN_BLK0 + i;
    chopinIx[i] = db & 0xFF; chopinIx[i + 256] = (db >> 8) & 0xFF;
  }
  addDirEntry("FANTAISIE.PSG", 0x00, 0x0000, fantaisieTune.length, 2, chopinKey, 1 + fantaisieBlks);

  const beatitKey = alloc();
  const beatitIx = disk.subarray(beatitKey * 512, (beatitKey + 1) * 512);
  for (let i = 0; i < beatitBlks; i++) {
    const db = BEATIT_BLK0 + i;
    beatitIx[i] = db & 0xFF; beatitIx[i + 256] = (db >> 8) & 0xFF;
  }
  addDirEntry("BEATIT.PSG", 0x00, 0x0000, beatitTune.length, 2, beatitKey, 1 + beatitBlks);

  // Add tree file index blocks for SPACEDB.PCM (CATALOG visibility)
  const debMasterKey = alloc();
  const debMasterIx = disk.subarray(debMasterKey * 512, (debMasterKey + 1) * 512);
  const numDebIndexBlocks = Math.ceil(spaceDebrisPcmBlks / 256);
  for (let s = 0; s < numDebIndexBlocks; s++) {
    const saplingKey = alloc();
    debMasterIx[s] = saplingKey & 0xFF;
    debMasterIx[s + 256] = (saplingKey >> 8) & 0xFF;
    const saplingIx = disk.subarray(saplingKey * 512, (saplingKey + 1) * 512);
    const startData = s * 256;
    const endData = Math.min(spaceDebrisPcmBlks, (s + 1) * 256);
    for (let d = startData; d < endData; d++) {
      const db = SPACE_PCM_BLK0 + d;
      saplingIx[d - startData] = db & 0xFF;
      saplingIx[d - startData + 256] = (db >> 8) & 0xFF;
    }
  }
  addDirEntry("SPACEDB.PCM", 0x00, 0x0000, spaceDebrisPcm.length, 3, debMasterKey, spaceDebrisPcmBlks + numDebIndexBlocks + 1);

  // Add tree file index blocks for WELLERM.PCM (CATALOG visibility)
  const masterKey = alloc();
  const masterIx = disk.subarray(masterKey * 512, (masterKey + 1) * 512);
  const numIndexBlocks = Math.ceil(wellermanBlks / 256);
  for (let s = 0; s < numIndexBlocks; s++) {
    const saplingKey = alloc();
    masterIx[s] = saplingKey & 0xFF;
    masterIx[s + 256] = (saplingKey >> 8) & 0xFF;
    const saplingIx = disk.subarray(saplingKey * 512, (saplingKey + 1) * 512);
    const startData = s * 256;
    const endData = Math.min(wellermanBlks, (s + 1) * 256);
    for (let d = startData; d < endData; d++) {
      const db = WELLERMAN_BLK0 + d;
      saplingIx[d - startData] = db & 0xFF;
      saplingIx[d - startData + 256] = (db >> 8) & 0xFF;
    }
  }
  addDirEntry("WELLERM.PCM", 0x00, 0x0000, wellermanTune.length, 3, masterKey, wellermanBlks + numIndexBlocks + 1);

  // Update volume header file count
  disk[volBase + 0x25] = fileCount & 0xFF;
  disk[volBase + 0x26] = (fileCount >> 8) & 0xFF;

  const outHdv = path.join(rootDir, "jukebox.hdv");
  try { fs.writeFileSync(outHdv, disk); }
  catch (e) {
    if (e.code === "EBUSY" || e.code === "EPERM") {
      fs.writeFileSync(outHdv + ".new", disk);
      console.warn("  [WARN] jukebox.hdv locked by emulator, wrote jukebox.hdv.new");
    } else throw e;
  }

  // Also automatically generate jukebox.hdv.zip
  const outHdvZip = path.join(rootDir, "jukebox.hdv.zip");
  writeSingleFileZip(outHdvZip, "jukebox.hdv", disk);
  const zipKb = Math.round(fs.statSync(outHdvZip).size / 1024);

  let freeHdv = 0; for (let b = 0; b < TOTAL_BLOCKS; b++) if (isFree(b)) freeHdv++;
  console.log(`[SUCCESS] jukebox.hdv (32MB) & jukebox.hdv.zip (${zipKb} KB): ${fileCount} files, FANTAISIE blks 100-${CHOPIN_BLK0 + fantaisieBlks - 1}, BEATIT blks 300-${BEATIT_BLK0 + beatitBlks - 1}, WELLERMAN blks 600-${WELLERMAN_BLK0 + wellermanBlks - 1}, SPACEDB.PCM blks 5000-${SPACE_PCM_BLK0 + spaceDebrisPcmBlks - 1} (${spaceDebrisPcmBlks} blks), ${freeHdv} blks free`);
}
