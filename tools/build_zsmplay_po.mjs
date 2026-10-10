#!/usr/bin/env node
/**
 * build_fmtest_po.mjs — build zsmplay.po (140KB bootable ProDOS floppy) with
 * the FMTEST player binaries (slot 2 & 4) and an Applesoft BASIC startup menu.
 *
 * Usage: node tools/build_fmtest_po.mjs   (run after build_fmtest.mjs)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileApplesoftBasic } from "../../veratest/src/applebasic.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, "..");
const srcDir = path.join(rootDir, "src");

const need = (p, what) => {
  if (!fs.existsSync(p)) { console.error(`[FAILED] missing ${what}: ${p}`); process.exit(1); }
  return fs.readFileSync(p);
};

const basePo = path.resolve(rootDir, "..", "veratest", "assets", "ProDOS 2.4.3.po");
const disk = new Uint8Array(need(basePo, "ProDOS 2.4.3.po template"));

const bitmap = disk.subarray(6 * 512, 7 * 512);
const isBlockFree = (b) => (bitmap[Math.floor(b / 8)] & (1 << (7 - (b % 8)))) !== 0;
const markBlockUsed = (b) => { bitmap[Math.floor(b / 8)] &= ~(1 << (7 - (b % 8))) };

let freeBlockSearch = 7;
const allocateBlock = () => {
  while (freeBlockSearch < 280) {
    if (isBlockFree(freeBlockSearch)) {
      const b = freeBlockSearch++;
      markBlockUsed(b);
      disk.fill(0, b * 512, (b + 1) * 512);
      return b;
    }
    freeBlockSearch++;
  }
  throw new Error("Disk full");
};

let fileCount = 0;
// wipe all user file entries, keep PRODOS + BASIC.SYSTEM
let currBlock = 2;
while (currBlock !== 0) {
  const blk = disk.subarray(currBlock * 512, (currBlock + 1) * 512);
  const next = blk[0x02] | (blk[0x03] << 8);
  for (let i = 0; i < 13; i++) {
    const off = 4 + i * 39;
    if (currBlock === 2 && i === 0) continue;
    const stLen = blk[off];
    if (stLen === 0) continue;
    const nameLen = stLen & 0x0F;
    const name = String.fromCharCode(...blk.subarray(off + 1, off + 1 + nameLen));
    if (!(name === "PRODOS" || name === "BASIC.SYSTEM")) blk.fill(0, off, off + 39);
    else fileCount++;
  }
  currBlock = next;
}

const addFile = (filename, type, aux, data) => {
  const size = data.length;
  let stType, keyBlock;
  if (size <= 512) {
    stType = 1;
    keyBlock = allocateBlock();
    disk.set(data, keyBlock * 512);
  } else {
    stType = 2;
    keyBlock = allocateBlock();
    const indexBlk = disk.subarray(keyBlock * 512, (keyBlock + 1) * 512);
    const numBlocks = Math.ceil(size / 512);
    for (let i = 0; i < numBlocks; i++) {
      const db = allocateBlock();
      disk.set(data.subarray(i * 512, Math.min(size, (i + 1) * 512)), db * 512);
      indexBlk[i] = db & 0xFF;
      indexBlk[i + 256] = (db >> 8) & 0xFF;
    }
  }
  const blocksUsed = stType === 1 ? 1 : 1 + Math.ceil(size / 512);
  let blkNum = 2;
  while (blkNum !== 0) {
    const blk = disk.subarray(blkNum * 512, (blkNum + 1) * 512);
    const next = blk[0x02] | (blk[0x03] << 8);
    for (let i = 0; i < 13; i++) {
      const off = 4 + i * 39;
      if (blkNum === 2 && i === 0) continue;
      if (blk[off] === 0) {
        blk[off] = (stType << 4) | (filename.length & 0x0F);
        for (let c = 0; c < 15; c++) blk[off + 1 + c] = c < filename.length ? filename.charCodeAt(c) : 0x00;
        blk[off + 0x10] = type;
        blk[off + 0x11] = keyBlock & 0xFF;
        blk[off + 0x12] = (keyBlock >> 8) & 0xFF;
        blk[off + 0x13] = blocksUsed & 0xFF;
        blk[off + 0x14] = (blocksUsed >> 8) & 0xFF;
        blk[off + 0x15] = size & 0xFF;
        blk[off + 0x16] = (size >> 8) & 0xFF;
        blk[off + 0x17] = (size >> 16) & 0xFF;
        blk[off + 0x1E] = 0xC3;
        blk[off + 0x1F] = aux & 0xFF;
        blk[off + 0x20] = (aux >> 8) & 0xFF;
        blk[off + 0x25] = 0x02;
        blk[off + 0x26] = 0x00;
        fileCount++;
        return;
      }
    }
    blkNum = next;
  }
  throw new Error("No directory slot for " + filename);
};

const fmtest2 = need(path.join(srcDir, "ZSMPLAY.BIN"), "ZSMPLAY.BIN (run build_fmtest.mjs)");
const fmtest4 = need(path.join(srcDir, "ZSMPLAY4.BIN"), "ZSMPLAY4.BIN (run build_fmtest.mjs)");
const startup = compileApplesoftBasic(srcDir, "zsmplay_startup.bas");

addFile("ZSMPLAY.BIN", 0x06, 0x2000, fmtest2);
addFile("ZSMPLAY4.BIN", 0x06, 0x2000, fmtest4);
addFile("STARTUP", 0xFC, 0x0801, startup);

disk[2 * 512 + 0x25] = fileCount & 0xFF;
disk[2 * 512 + 0x26] = (fileCount >> 8) & 0xFF;

fs.writeFileSync(path.join(rootDir, "zsmplay.po"), disk);
console.log(`[SUCCESS] zsmplay.po written (${fileCount} files), ${disk.length} bytes`);
