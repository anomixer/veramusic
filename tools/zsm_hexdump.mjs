#!/usr/bin/env node
// Hexdump the first N bytes of a ZSM file
import fs from "fs";
const file = process.argv[2];
const n = parseInt(process.argv[3] || "256", 10);
const data = fs.readFileSync(file);
console.log("file:", file, "size:", data.length);
for (let off = 0; off < Math.min(n, data.length); off += 16) {
  const row = data.subarray(off, off + 16);
  const hex = [...row].map(b => b.toString(16).padStart(2, "0")).join(" ");
  const ascii = [...row].map(b => (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : ".").join("");
  console.log(off.toString(16).padStart(8, "0") + "  " + hex.padEnd(47) + "  " + ascii);
}
