#!/usr/bin/env node
// One-off (2026-10-22): verify TREE.ZSM resampling 73 -> 21 before rebuilding melodius.hdv.
// Writes the patched stream to %TEMP%\tree_rate21.zsm for melodius.exe auditioning.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resampleZsmPcm, parseZsmPcm, findRateEvents } from "../tools/zsm_pcm_resample.mjs";

const srcPath = "C:/dev/emu/x16emu/x16/SDCARD/MUSIC/MELODIUS/PCM/TREE.ZSM";
const buf = fs.readFileSync(srcPath);
const out = resampleZsmPcm(buf, 21);
if (!out) throw new Error("resampleZsmPcm returned null (no PCM table)");
console.log(`rate ${out.sourceRate} (${Math.round(out.sourceHz)} B/s) -> ${out.targetRate} (${Math.round(out.targetHz)} B/s)`);
console.log(`data ${out.bytes} B, was ${out.bytes + out.saved} B, saved ${out.saved} B`);
console.log(`duration orig ${((out.bytes + out.saved) / out.sourceHz).toFixed(2)} s -> patched ${(out.bytes / out.targetHz).toFixed(2)} s`);

const patched = out.buffer;
const tbl = parseZsmPcm(patched);
if (!tbl) throw new Error("patched buffer lost its PCM table");
const offs = findRateEvents(patched, tbl);
const rates = [...new Set(offs.map((off) => patched[off]))];
if (rates.length !== 1 || rates[0] !== 21) throw new Error(`patched rate events are ${rates.join(",")}, expected [21]`);
console.log(`patched: ${offs.length} rate events @ ${rates[0]}, instMax ${tbl.instMax}, inst0 offset ${tbl.insts[0].offset} len ${tbl.insts[0].length} looped ${tbl.insts[0].looped}`);

const dst = path.join(os.tmpdir(), "tree_rate21.zsm");
fs.writeFileSync(dst, patched);
console.log(`wrote ${dst} (${patched.length} B)`);