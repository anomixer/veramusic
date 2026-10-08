#!/usr/bin/env node
// Scan a ZSM file: histogram of command types, EXTCMD bytes, PSG/YM counts
import fs from "fs";

const file = process.argv[2];
const data = fs.readFileSync(file);
console.log("file:", file, "size:", data.length);
console.log("header:", data.subarray(0, 16).toString("hex"));
console.log("magic:", data.subarray(0, 3).toString());
const loopOffset = data[3] | (data[4] << 8) | (data[5] << 16);
const pcmTableOffset = data[6] | (data[7] << 8) | (data[8] << 16);
const fmMask = data[9];
const psgMask = data[10] | (data[11] << 8);
const tickRate = data[12] | (data[13] << 8) || 60;
console.log("loopOffset:", loopOffset, "(0x" + loopOffset.toString(16) + ")");
console.log("pcmTableOffset:", pcmTableOffset, "(0x" + pcmTableOffset.toString(16) + ")");
console.log("fmMask: 0x" + fmMask.toString(16).padStart(2, "0"), "psgMask: 0x" + psgMask.toString(16).padStart(4, "0"));
console.log("tickRate:", tickRate);

// Parse the PCM instrument table (if present)
if (pcmTableOffset >= 0x40 && pcmTableOffset + 4 <= data.length &&
    data[pcmTableOffset] === 0x50 && data[pcmTableOffset + 1] === 0x43 && data[pcmTableOffset + 2] === 0x4D) {
  const instMax = data[pcmTableOffset + 3];
  const dataBase = pcmTableOffset + 4 + (instMax + 1) * 16;
  console.log("\n--- PCM table ---");
  console.log("instruments:", instMax + 1, "dataBase: 0x" + dataBase.toString(16));
  for (let i = 0; i <= instMax; i++) {
    const e = pcmTableOffset + 4 + i * 16;
    if (e + 16 > data.length) break;
    const geom = data[e + 1];
    const off = data[e + 2] | (data[e + 3] << 8) | (data[e + 4] << 16);
    const len = data[e + 5] | (data[e + 6] << 8) | (data[e + 7] << 16);
    const looped = (data[e + 8] & 0x80) !== 0;
    const loopPt = data[e + 9] | (data[e + 10] << 8) | (data[e + 11] << 16);
    const fmt = (geom >> 4) & 3;
    const fmtName = ["mono8", "stereo8", "mono16", "stereo16"][fmt];
    console.log(`  inst ${data[e]}: ${fmtName} off=0x${(dataBase + off).toString(16)} len=${len} looped=${looped} loopPt=0x${loopPt.toString(16)}`);
  }
}

let ptr = 16;
let tick = 0;
let psgWrites = 0, ymWrites = 0, extcmds = 0, delays = 0, delayTicks = 0, endCmd = 0;
const extHist = {};
const psgRegHist = new Array(64).fill(0);
const ymRegHist = new Array(256).fill(0);

while (ptr < data.length) {
  const cmd = data[ptr++];
  if (cmd < 0x40) {
    if (ptr >= data.length) break;
    const val = data[ptr++];
    psgWrites++;
    psgRegHist[cmd]++;
  } else if (cmd === 0x40) {
    if (ptr >= data.length) break;
    const ext = data[ptr++];
    extcmds++;
    extHist[ext] = (extHist[ext] || 0) + 1;
    ptr += ext & 0x3F;
  } else if (cmd < 0x80) {
    const count = cmd & 0x3F;
    for (let i = 0; i < count; i++) {
      if (ptr + 1 >= data.length) break;
      const reg = data[ptr++];
      const val = data[ptr++];
      ymWrites++;
      ymRegHist[reg]++;
    }
  } else if (cmd === 0x80) {
    endCmd++;
    break;
  } else {
    delays++;
    delayTicks += cmd & 0x7F;
    tick += cmd & 0x7F;
  }
}

console.log("\n--- summary ---");
console.log("total ticks (frames):", tick);
console.log("psg writes:", psgWrites);
console.log("ym writes:", ymWrites);
console.log("extcmds:", extcmds, "hist:", JSON.stringify(extHist));
console.log("delay cmds:", delays, "delayTicks:", delayTicks);
console.log("end cmd count:", endCmd);
console.log("final ptr:", ptr, "/", data.length);

const usedPsg = psgRegHist.map((c, i) => c ? `r${i}:${c}` : null).filter(Boolean);
console.log("\nPSG regs used:", usedPsg.join(" "));
const usedYm = ymRegHist.map((c, i) => c ? `r${i}:${c}` : null).filter(Boolean);
console.log("\nYM regs used:", usedYm.join(" "));
