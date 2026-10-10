#!/usr/bin/env node
/**
 * build_jukebox.mjs — VERA PSG & PCM Jukebox Disk Builder
 *
 * Produces two bootable ProDOS images:
 *   1. jukebox.po  (140KB floppy, 280 blocks):
 *      - Track 1: Melody Demo (RAM PSG, 0:30)
 *      - Track 2: Chopin Fantaisie-Impromptu (file-based PSG stream)
 *   2. jukebox.hdv (32MB ProDOS Hard Disk Volume, 65,535 blocks):
 *      - Track 1: Melody Demo (RAM PSG, 0:30)
 *      - Track 2: Chopin Fantaisie-Impromptu (file-based PSG stream)
 *      - Track 3: Michael Jackson: Beat It (file-based PSG stream)
 *      - Track 4: Enya: Caribbean Blue (file-based PSG stream)
 *      - Track 5: Space Debris (file-based PCM stream)
 *      - Track 6: The Wellerman (file-based PCM stream)
 *
 * Uses Apple2TS / veratest assembler + tokenizer and Cadius for ProDOS images.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import os from "node:os";
import { execFileSync } from "node:child_process";
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
const eurusTune = need(path.join(musicDir, "Enya_Caribbean Blue.psg"), "Enya_Caribbean Blue.psg (run mid2psg first)");
const spaceDebrisPcm = need(path.join(musicDir, "space_debris.pcm"), "space_debris.pcm (run render_pure_pcm.mjs first)");
const wellermanTune = need(path.join(musicDir, "wellerman_full.pcm"), "wellerman_full.pcm (run wav2pcm first)");

const basePo = need(path.join(rootDir, "..", "veratest", "assets", "ProDOS 2.4.3.po"), "bootable ProDOS 2.4.3.po baseline");
if (basePo.length !== 143360) { console.error("[FAILED] bad 140K template size"); process.exit(1); }

const baseHdv = need(path.join(rootDir, "..", "veratest", "assets", "ProDOS 2.4.3.hdv"), "bootable ProDOS 2.4.3.hdv baseline");
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

const patchFilePath = (codeBuf, placeholder, filename) => {
  if (filename.length > 15) throw new Error(`ProDOS filename too long: ${filename}`);
  const buf = Uint8Array.from(codeBuf);
  const from = Buffer.from(placeholder, "ascii");
  const to = Buffer.from(filename, "ascii");
  for (let i = 0; i + from.length <= buf.length; i++) {
    if (from.every((value, j) => buf[i + j] === value)) {
      if (buf[i - 1] !== from.length) throw new Error(`Bad path length byte before ${placeholder}`);
      buf[i - 1] = to.length;
      buf.set(to, i);
      buf.fill(0, i + to.length, i + from.length);
      return buf;
    }
  }
  throw new Error(`Could not find path placeholder ${placeholder}`);
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

// 2. Stream Player for Chopin (file-level MLI reads)
const streamChopin2 = patchFilePath(patchTitle(asm("psgstream.asm", 2), "CHOPIN: FANTAISIE IMPROMPTU (5:02)", "VERA PSG STREAM", 40), "MUSICFILE.PSG", "FANTAISIE.PSG");
const streamChopin4 = patchFilePath(patchTitle(asm("psgstream.asm", 4), "CHOPIN: FANTAISIE IMPROMPTU (5:02)", "VERA PSG STREAM", 40), "MUSICFILE.PSG", "FANTAISIE.PSG");

// 2b. VERA VRAM Pre-Load Player for Chopin on Floppy Disk (jukebox.po): eliminates floppy read pauses!
const vramChopin2 = patchFilePath(asm("psgvram.asm", 2), "MUSICFILE.PSG", "FANTAISIE.PSG");
const vramChopin4 = patchFilePath(asm("psgvram.asm", 4), "MUSICFILE.PSG", "FANTAISIE.PSG");

// 3. Stream Player for Beat It
const streamBeat2 = patchFilePath(patchTitle(asm("psgstream.asm", 2), "M. JACKSON: BEAT IT (3:58)", "VERA PSG STREAM", 40), "MUSICFILE.PSG", "BEATIT.PSG");
const streamBeat4 = patchFilePath(patchTitle(asm("psgstream.asm", 4), "M. JACKSON: BEAT IT (3:58)", "VERA PSG STREAM", 40), "MUSICFILE.PSG", "BEATIT.PSG");

// 4. Stream Player for Enya: Caribbean Blue
const eurusBlks = Math.ceil(eurusTune.length / 512);
const streamEurus2 = patchFilePath(patchTitle(asm("psgstream.asm", 2), "ENYA: CARIBBEAN BLUE (2:56)", "VERA PSG STREAM", 40), "MUSICFILE.PSG", "CARIBBEAN.PSG");
const streamEurus4 = patchFilePath(patchTitle(asm("psgstream.asm", 4), "ENYA: CARIBBEAN BLUE (2:56)", "VERA PSG STREAM", 40), "MUSICFILE.PSG", "CARIBBEAN.PSG");

// 5. Stream PCM Player for Space Debris
const spaceDebrisPcmBlks = Math.ceil(spaceDebrisPcm.length / 512);
const pcmdeb2 = patchFilePath(patchTitle(asm("pcmstream.asm", 2, [
  `TOTAL_BLKS = ${spaceDebrisPcmBlks}`,
  "RATE_VAL = 21"
]), "CAPTAIN: SPACE DEBRIS (5:05) SD4", "A. NAKARADA: THE WELLERMAN", 40), "MUSICFILE.PCM", "SPACEDEB.PCM");
const pcmdeb4 = patchFilePath(patchTitle(asm("pcmstream.asm", 4, [
  `TOTAL_BLKS = ${spaceDebrisPcmBlks}`,
  "RATE_VAL = 21"
]), "CAPTAIN: SPACE DEBRIS (5:05) SD4", "A. NAKARADA: THE WELLERMAN", 40), "MUSICFILE.PCM", "SPACEDEB.PCM");

// 6. Stream Player for Alexander Nakarada - The Wellerman (Starts at block 600, FULL 2:00 SONG)
const wellermanBlks = Math.ceil(wellermanTune.length / 512);
const pcmwel2 = patchFilePath(asm("pcmstream.asm", 2, [
  `TOTAL_BLKS = ${wellermanBlks}`,
  "RATE_VAL = 21"
]), "MUSICFILE.PCM", "WELLERMAN.PCM");
const pcmwel4 = patchFilePath(asm("pcmstream.asm", 4, [
  `TOTAL_BLKS = ${wellermanBlks}`,
  "RATE_VAL = 21"
]), "MUSICFILE.PCM", "WELLERMAN.PCM");

for (const [c, n] of [
  [streamChopin2, "streamChopin2"], [streamChopin4, "streamChopin4"],
  [vramChopin2, "vramChopin2"],     [vramChopin4, "vramChopin4"],
  [streamBeat2, "streamBeat2"],     [streamBeat4, "streamBeat4"],
  [streamEurus2, "streamEurus2"],   [streamEurus4, "streamEurus4"],
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

// Cadius owns ProDOS catalogs, allocation indexes, timestamps, and bitmaps.
const programs = [
  ["TESTTUNE.BIN", 0x06, 0x2000, testtune2], ["TESTTUNE4.BIN", 0x06, 0x2000, testtune4],
  ["STREAM.BIN", 0x06, 0x2000, vramChopin2], ["STREAM4.BIN", 0x06, 0x2000, vramChopin4],
  ["BEATIT.BIN", 0x06, 0x2000, streamBeat2], ["BEATIT4.BIN", 0x06, 0x2000, streamBeat4],
  ["CARIBBEAN.BIN", 0x06, 0x2000, streamEurus2], ["CARIBBEAN4.BIN", 0x06, 0x2000, streamEurus4],
  ["PCMDEB.BIN", 0x06, 0x2000, pcmdeb2], ["PCMDEB4.BIN", 0x06, 0x2000, pcmdeb4],
  ["PCMWEL.BIN", 0x06, 0x2000, pcmwel2], ["PCMWEL4.BIN", 0x06, 0x2000, pcmwel4],
];
const assets = [
  ["FANTAISIE.PSG", 0x00, 0x0000, fantaisieTune],
  ["BEATIT.PSG", 0x00, 0x0000, beatitTune],
  ["CARIBBEAN.PSG", 0x00, 0x0000, eurusTune],
  ["SPACEDEB.PCM", 0x00, 0x0000, spaceDebrisPcm],
  ["WELLERMAN.PCM", 0x00, 0x0000, wellermanTune],
];
const startupPo = ["STARTUP", 0xFC, 0x0801, startupPoCode];
const startupHdv = ["STARTUP", 0xFC, 0x0801, startupHdvCode];
const cadius = process.env.CADIUS || path.join(rootDir, "tools", "cadius.exe");
if (!fs.existsSync(cadius)) throw new Error(`Cadius not found at ${cadius}; set CADIUS to its executable path.`);

function rootEntries(imagePath) {
  const disk = fs.readFileSync(imagePath);
  const entries = [];
  const visited = new Set();
  let blockNumber = 2;
  while (blockNumber && !visited.has(blockNumber)) {
    visited.add(blockNumber);
    const offset = blockNumber * 512;
    if (offset + 512 > disk.length) throw new Error(`Invalid ProDOS directory chain in ${imagePath}`);
    const block = disk.subarray(offset, offset + 512);
    const next = block[2] | (block[3] << 8);
    for (let slot = blockNumber === 2 ? 1 : 0; slot < 13; slot++) {
      const entryOffset = 4 + slot * 39;
      const storageName = block[entryOffset];
      const storageType = storageName >> 4;
      const length = storageName & 0x0f;
      if (!storageType || !length) continue;
      entries.push({
        name: block.toString("ascii", entryOffset + 1, entryOffset + 1 + length),
        isDirectory: storageType === 0x0d,
      });
    }
    blockNumber = next;
  }
  return entries;
}

function runCadius(...args) {
  execFileSync(cadius, args, { stdio: "inherit" });
}

function checkVolume(imagePath) {
  const output = execFileSync(cadius, ["CHECKVOLUME", imagePath], { encoding: "utf8" });
  process.stdout.write(output);
  if (/^\s*=>|\bError\s*:/im.test(output)) throw new Error(`Cadius reported volume allocation errors for ${imagePath}`);
}

function checkCatalog(imagePath, files) {
  const output = execFileSync(cadius, ["CATALOG", imagePath], { encoding: "utf8" });
  process.stdout.write(output);
  const typeNames = new Map([[0x00, "UNK"], [0x06, "BIN"], [0xfc, "BAS"]]);
  for (const [name, type, aux, data] of files) {
    const line = output.split(/\r?\n/).find((row) => row.trimStart().startsWith(`${name.padEnd(15)} `));
    if (!line) throw new Error(`Cadius catalog is missing ${name}`);
    const escapedType = typeNames.get(type);
    if (!line.includes(`${escapedType}   $${aux.toString(16).padStart(4, "0").toUpperCase()}`) || !line.includes(`${data.length}`)) {
      throw new Error(`Unexpected Cadius catalog metadata for ${name}: ${line.trim()}`);
    }
  }
}

function clearVolume(imagePath, volumeName) {
  runCadius("RENAMEVOLUME", imagePath, volumeName);
  for (const entry of rootEntries(imagePath)) {
    if (["PRODOS", "BASIC.SYSTEM", "CLOCK.SYSTEM"].includes(entry.name)) continue;
    runCadius(entry.isDirectory ? "DELETEFOLDER" : "DELETEFILE", imagePath, `/${volumeName}/${entry.name}`);
  }
}

function addFiles(imagePath, volumeName, stageDir, files) {
  for (const [name, type, aux, data] of files) {
    const suffix = `#${type.toString(16).padStart(2, "0")}${aux.toString(16).padStart(4, "0")}`;
    const staged = path.join(stageDir, `${name}${suffix}`);
    fs.writeFileSync(staged, data);
    runCadius("ADDFILE", imagePath, `/${volumeName}`, staged, "--quiet");
  }
}

function writeImageFromBaseline({ name, baseBytes, volumeName, files }) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "veramusic-cadius-"));
  const resolvedTemp = path.resolve(tempRoot);
  const expectedTempRoot = path.resolve(os.tmpdir()) + path.sep;
  if (!resolvedTemp.startsWith(expectedTempRoot)) throw new Error(`Refusing cleanup outside temporary root: ${resolvedTemp}`);
  const imagePath = path.join(tempRoot, name);
  const stageDir = path.join(tempRoot, "stage");
  fs.mkdirSync(stageDir);
  try {
    fs.writeFileSync(imagePath, baseBytes);
    clearVolume(imagePath, volumeName);
    addFiles(imagePath, volumeName, stageDir, files);
    checkVolume(imagePath);
    checkCatalog(imagePath, files);
    const outputPath = path.join(rootDir, name);
    let writtenPath = outputPath;
    try {
      fs.writeFileSync(outputPath, fs.readFileSync(imagePath));
    } catch (error) {
      if (error.code !== "EBUSY" && error.code !== "EPERM") throw error;
      writtenPath = `${outputPath}.new`;
      fs.writeFileSync(writtenPath, fs.readFileSync(imagePath));
      console.warn(`[WARN] ${name} is locked; wrote ${path.basename(writtenPath)}`);
    }
    return { imagePath: writtenPath, bytes: fs.readFileSync(imagePath) };
  } finally {
    fs.rmSync(resolvedTemp, { recursive: true, force: true });
  }
}

const poFiles = [
  ["TESTTUNE.BIN", 0x06, 0x2000, testtune2], ["TESTTUNE4.BIN", 0x06, 0x2000, testtune4],
  ["STREAM.BIN", 0x06, 0x2000, vramChopin2], ["STREAM4.BIN", 0x06, 0x2000, vramChopin4],
  startupPo, ["FANTAISIE.PSG", 0x00, 0x0000, fantaisieTune],
];
const hdvFiles = [...programs, startupHdv, ...assets];
const poImage = writeImageFromBaseline({ name: "jukebox.po", baseBytes: basePo, volumeName: "JUKEBOX", files: poFiles });
console.log(`[SUCCESS] ${path.basename(poImage.imagePath)}: Cadius-built ProDOS floppy with ${poFiles.length} application files.`);
const hdvImage = writeImageFromBaseline({ name: "jukebox.hdv", baseBytes: baseHdv, volumeName: "JUKEBOX", files: hdvFiles });
const zipPath = path.join(rootDir, "jukebox.hdv.zip");
writeSingleFileZip(zipPath, "jukebox.hdv", hdvImage.bytes);
console.log(`[SUCCESS] ${path.basename(hdvImage.imagePath)} and jukebox.hdv.zip: Cadius-built ProDOS hard disk with ${hdvFiles.length} application files.`);
