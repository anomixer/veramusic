#!/usr/bin/env node
/**
 * build_zsmstream_hdv.mjs — Cadius-build the ZSMSTREAM ProDOS hard disk image.
 *
 * Usage: node tools/build_zsmstream_hdv.mjs [--autoplay]
 *
 * Produces zsmstream.hdv (32MB, volume ZSMSTREAM) + zsmstream.hdv.zip:
 *   - ZSMSTREAM.BIN / ZSMSTREAM4.BIN  (player, $2000 BRUN, slot 2/4)
 *   - STARTUP                          (Applesoft slot probe → BRUN)
 *   - 10 ZSM songs (type $00, read by the player via MLI by name)
 * `--autoplay` uses zsmstream_autostart.bas (direct BRUN, no menu) as STARTUP
 * and ZSMSTREAMA.BIN (AUTOPLAY=1) as ZSMSTREAM.BIN for headless.
 *
 * Mirrors build_jukebox.mjs: template HDV, Cadius ADDFILE/CHECKVOLUME/CATALOG.
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
const LIMIT = 0x3800;
const AUTOPLAY = process.argv.includes("--autoplay");
const autoIdx = process.argv.indexOf("--autosong");
const autoSong = autoIdx >= 0 ? Number(process.argv[autoIdx + 1]) : 0;

// ---- Inputs ----------------------------------------------------------------
const need = (p, what) => {
  if (!fs.existsSync(p)) { console.error(`[FAILED] missing ${what}: ${p}`); process.exit(1); }
  return fs.readFileSync(p);
};

const baseHdv = need(path.join(rootDir, "..", "veratest", "assets", "ProDOS 2.4.3.hdv"), "bootable ProDOS 2.4.3.hdv baseline");
if (baseHdv.length !== 33553920) { console.error("[FAILED] bad 32MB template size"); process.exit(1); }

// ---- Assemble player (slot 2 + 4), code-region zeroGuard -------------------
const MARKER = Array.from("CANYON.ZSM", (c) => c.charCodeAt(0));
const codeRegionEnd = (code) => {
  for (let i = 0; i + MARKER.length <= code.length; i++) {
    let m = true;
    for (let k = 0; k < MARKER.length; k++) if (code[i + k] !== MARKER[k]) { m = false; break; }
    if (m) return i;
  }
  return code.length;
};
const zeroGuard = (code, slot) => {
  const ds = codeRegionEnd(code);
  for (let i = 0; i + 2 < ds; i++) {
    if ([0xAD, 0x8D, 0xEE, 0xCE, 0x4C, 0x20].includes(code[i]) && code[i + 1] === 0 && code[i + 2] === 0) {
      console.error(`[FAILED] slot ${slot}: $0000 ref at offset ${i} (unresolved label?)`);
      process.exit(1);
    }
  }
};
const asm = (slot, extraLines = []) => {
  const code = assembleAsmFile(srcDir, "zsmstream.asm", slot, LOAD, extraLines);
  if (LOAD + code.length >= LIMIT) {
    console.error(`[FAILED] slot ${slot} ends at $${(LOAD + code.length).toString(16)} — collides with $4000 buffer`);
    process.exit(1);
  }
  zeroGuard(code, slot);
  return code;
};

const player2 = asm(2, AUTOPLAY ? [`AUTOPLAY = 1`, `AUTOSONG = ${autoSong}`] : []);
const player4 = asm(4, []);

const startupCode = compileApplesoftBasic(
  srcDir,
  AUTOPLAY ? "zsmstream_autostart.bas" : "zsmstream_startup.bas",
);

// ---- Cadius ---------------------------------------------------------------
const cadius = process.env.CADIUS || path.join(rootDir, "tools", "cadius.exe");
if (!fs.existsSync(cadius)) throw new Error(`Cadius not found at ${cadius}; set CADIUS to its executable path.`);

const SONGS = [
  ["CANYON.ZSM", "CANYON.ZSM"],
  ["TITLE.ZSM", "TITLE.ZSM"],
  ["HIGHSCORE.ZSM", "HIGHSCORE.ZSM"],
  ["GAMEOVER.ZSM", "GAMEOVER.ZSM"],
  ["KILLED.ZSM", "KILLED.ZSM"],
  ["LVLCOMPLETE.ZSM", "LVLCOMPLETE.ZSM"],
  ["BOTHPSG.ZSM", "BOTHPSG.ZSM"],
  ["GARGOYLES.ZSM", "GARGOYLES.ZSM"],
  ["TRACK2.ZSM", "TRACK2.ZSM"],
  ["CMDRDEMO.ZSM", "CMDRDEMO.ZSM"],
  ["SHOVELKNT.ZSM", "SHOVELKNT.ZSM"],
];

const programs = [
  ["ZSMSTREAM.BIN", 0x06, 0x2000, player2],
  ["ZSMSTREAM4.BIN", 0x06, 0x2000, player4],
  ["STARTUP", 0xFC, 0x0801, startupCode],
];
const assets = SONGS.map(([prodosName, file]) => [prodosName, 0x00, 0x0000, need(path.join(musicDir, file), file)]);
const files = [...programs, ...assets];

// ---- Cadius helpers (from build_jukebox.mjs) ------------------------------
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
function runCadius(...args) { execFileSync(cadius, args, { stdio: "inherit" }); }
function checkVolume(imagePath) {
  const output = execFileSync(cadius, ["CHECKVOLUME", imagePath], { encoding: "utf8" });
  process.stdout.write(output);
  if (/^\s*=>|\bError\s*:/im.test(output)) throw new Error(`Cadius reported volume allocation errors for ${imagePath}`);
}
function checkCatalog(imagePath, fileList) {
  const output = execFileSync(cadius, ["CATALOG", imagePath], { encoding: "utf8" });
  process.stdout.write(output);
  const typeNames = new Map([[0x00, "UNK"], [0x06, "BIN"], [0xfc, "BAS"]]);
  for (const [name, type, aux, data] of fileList) {
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
function addFiles(imagePath, volumeName, stageDir, fileList) {
  for (const [name, type, aux, data] of fileList) {
    const suffix = `#${type.toString(16).padStart(2, "0")}${aux.toString(16).padStart(4, "0")}`;
    const staged = path.join(stageDir, `${name}${suffix}`);
    fs.writeFileSync(staged, data);
    runCadius("ADDFILE", imagePath, `/${volumeName}`, staged, "--quiet");
  }
}
function writeImageFromBaseline({ name, baseBytes, volumeName, fileList }) {
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
    addFiles(imagePath, volumeName, stageDir, fileList);
    checkVolume(imagePath);
    checkCatalog(imagePath, fileList);
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
// Lightweight zero-dependency ZIP builder
function writeSingleFileZip(outZipPath, entryName, dataBuf) {
  const crc = zlib.crc32(dataBuf);
  const compressed = zlib.deflateRawSync(dataBuf, { level: 6 });
  const entryNameBuf = Buffer.from(entryName, "utf8");
  const localHeaderLen = 30 + entryNameBuf.length;
  const centralHeaderLen = 46 + entryNameBuf.length;
  const totalLen = localHeaderLen + compressed.length + centralHeaderLen + 22;
  const zip = Buffer.alloc(totalLen);
  let pos = 0;
  zip.writeUInt32LE(0x04034b50, pos); pos += 4;
  zip.writeUInt16LE(20, pos); pos += 2;
  zip.writeUInt16LE(0, pos); pos += 2;
  zip.writeUInt16LE(8, pos); pos += 2;
  zip.writeUInt16LE(0, pos); pos += 2;
  zip.writeUInt16LE(0, pos); pos += 2;
  zip.writeUInt32LE(crc, pos); pos += 4;
  zip.writeUInt32LE(compressed.length, pos); pos += 4;
  zip.writeUInt32LE(dataBuf.length, pos); pos += 4;
  zip.writeUInt16LE(entryNameBuf.length, pos); pos += 2;
  zip.writeUInt16LE(0, pos); pos += 2;
  entryNameBuf.copy(zip, pos); pos += entryNameBuf.length;
  compressed.copy(zip, pos); pos += compressed.length;
  const centralOffset = localHeaderLen + compressed.length;
  zip.writeUInt32LE(0x02014b50, pos); pos += 4;
  zip.writeUInt16LE(20, pos); pos += 2;
  zip.writeUInt16LE(20, pos); pos += 2;
  zip.writeUInt16LE(0, pos); pos += 2;
  zip.writeUInt16LE(8, pos); pos += 2;
  zip.writeUInt16LE(0, pos); pos += 2;
  zip.writeUInt16LE(0, pos); pos += 2;
  zip.writeUInt32LE(crc, pos); pos += 4;
  zip.writeUInt32LE(compressed.length, pos); pos += 4;
  zip.writeUInt32LE(dataBuf.length, pos); pos += 4;
  zip.writeUInt16LE(entryNameBuf.length, pos); pos += 2;
  zip.writeUInt16LE(0, pos); pos += 2;
  zip.writeUInt16LE(0, pos); pos += 2;
  zip.writeUInt16LE(0, pos); pos += 2;
  zip.writeUInt16LE(0, pos); pos += 2;
  zip.writeUInt32LE(0, pos); pos += 4;
  zip.writeUInt32LE(0, pos); pos += 4;
  entryNameBuf.copy(zip, pos); pos += entryNameBuf.length;
  zip.writeUInt32LE(0x06054b50, pos); pos += 4;
  zip.writeUInt16LE(0, pos); pos += 2;
  zip.writeUInt16LE(0, pos); pos += 2;
  zip.writeUInt16LE(1, pos); pos += 2;
  zip.writeUInt16LE(1, pos); pos += 2;
  zip.writeUInt32LE(centralHeaderLen, pos); pos += 4;
  zip.writeUInt32LE(centralOffset, pos); pos += 4;
  zip.writeUInt16LE(0, pos); pos += 2;
  fs.writeFileSync(outZipPath, zip);
}

// ---- Build ---------------------------------------------------------------
const imageName = AUTOPLAY ? "zsmstream_a.hdv" : "zsmstream.hdv";
const hdvImage = writeImageFromBaseline({ name: imageName, baseBytes: baseHdv, volumeName: "ZSMSTREAM", fileList: files });
const zipPath = path.join(rootDir, `${imageName}.zip`);
writeSingleFileZip(zipPath, imageName, hdvImage.bytes);
console.log(`[SUCCESS] ${path.basename(hdvImage.imagePath)} and ${imageName}.zip: Cadius-built ProDOS hard disk (${files.length} files, ${AUTOPLAY ? "AUTOPLAY=1" : "menu"})`);
