#!/usr/bin/env node
// Check stereo panning usage in ZSM files
// YM2151: reg $20-$27, bit7=pan right, bit6=pan left
// VERA PSG: reg 2/6 (ch ctrl), bit7=right, bit6=left
import fs from "fs";

const files = process.argv.slice(2);

for (const file of files) {
  const data = fs.readFileSync(file);
  if (data.length < 16) continue;
  let ptr = 16;
  const ymPan = { both: 0, left: 0, right: 0, none: 0 };
  const psgPan = { both: 0, left: 0, right: 0, none: 0 };
  const ymPanVals = new Set();
  const psgPanVals = new Set();
  let ymCh20 = 0;

  while (ptr < data.length) {
    const cmd = data[ptr++];
    if (cmd < 0x40) {
      if (ptr >= data.length) break;
      const val = data[ptr++];
      if (cmd === 2 || cmd === 6) {
        const l = (val & 0x40) !== 0;
        const r = (val & 0x80) !== 0;
        psgPanVals.add(val & 0xC0);
        if (l && r) psgPan.both++;
        else if (l) psgPan.left++;
        else if (r) psgPan.right++;
        else psgPan.none++;
      }
    } else if (cmd === 0x40) {
      if (ptr >= data.length) break;
      const ext = data[ptr++];
      ptr += ext & 0x3F;
    } else if (cmd < 0x80) {
      const count = cmd & 0x3F;
      for (let i = 0; i < count; i++) {
        if (ptr + 1 >= data.length) break;
        const reg = data[ptr++];
        const val = data[ptr++];
        if (reg >= 0x20 && reg <= 0x27) {
          ymCh20++;
          const l = (val & 0x40) !== 0;
          const r = (val & 0x80) !== 0;
          ymPanVals.add(val & 0xC0);
          if (l && r) ymPan.both++;
          else if (l) ymPan.left++;
          else if (r) ymPan.right++;
          else ymPan.none++;
        }
      }
    } else if (cmd === 0x80) {
      break;
    } else {
      // delay
    }
  }

  const name = file.split(/[\\/]/).pop();
  console.log(name + ":");
  console.log("  YM pan ($20-$27, " + ymCh20 + " writes): both=" + ymPan.both +
    " L=" + ymPan.left + " R=" + ymPan.right + " none=" + ymPan.none +
    " | distinct pan bits: " + [...ymPanVals].map(v => "0x" + v.toString(16)).join(","));
  console.log("  PSG pan (r2/r6):                both=" + psgPan.both +
    " L=" + psgPan.left + " R=" + psgPan.right + " none=" + psgPan.none +
    " | distinct pan bits: " + [...psgPanVals].map(v => "0x" + v.toString(16)).join(","));
}
