#!/usr/bin/env node
/**
 * gen_demo.mjs — synthesize a REAL musical 4ch ProTracker MOD (no samples
 * needed from elsewhere). House-ish groove in C major, 4 patterns x 64 rows,
 * speed 6 default (~30s): lead motif + bass roots + four-on-floor kick +
 * offbeat hats. Plain notes only (composer-safe effects), so it doubles as
 * a converter/player musicality proof: dense note traffic, rests via EC cut.
 *
 * Usage: node gen_demo.mjs   -> demo.mod
 */
import { writeFileSync } from "node:fs";

// PT periods (C-2 octave base x2 for bass, C-3/C-4 for lead)
const N = {
  C2: 428, D2: 382, E2: 340, F2: 320, G2: 286, A2: 254, B2: 227,
  C3: 214, D3: 190, E3: 170, F3: 160, G3: 143, A3: 127, B3: 113,
  C4: 107, D4: 95, E4: 85, F4: 80, G4: 72, A4: 64, B4: 57, C5: 53,
  E5: 42, G5: 36,
};

function sampleBlob(name, lenW, vol, data) {
  const h = Buffer.alloc(30);
  Buffer.from(name).copy(h);
  h.writeUInt16BE(lenW, 22);
  h[24] = 0; h[25] = vol;
  h.writeUInt16BE(0, 26); h.writeUInt16BE(data.loop || 0, 28);
  return { h, d: data.buf };
}
const singleCycle = (len, fn) => {
  const b = Buffer.alloc(len);
  for (let i = 0; i < len; i++) b[i] = Math.max(-128, Math.min(127, Math.round(fn(i / len) * 127)));
  return b;
};

const lead167 = singleCycle(128, (p) => (p < 0.5 ? 0.8 : -0.8));       // square-ish
const bass256 = singleCycle(256, (p) => Math.sin(p * 2 * Math.PI));    // sine-ish
const kick = Buffer.alloc(400);                                        // pitch-drop thump
for (let i = 0; i < 400; i++) {
  const t = i / 400, f = 0.12 - 0.09 * t;
  kick[i] = Math.round(Math.sin(i * f) * 127 * (1 - t) * (1 - t));
}
const hat = Buffer.alloc(96);                                          // noise tick
let seed = 0x1234;
for (let i = 0; i < 96; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; hat[i] = (seed >> 8) - 128; }

const samples = [
  sampleBlob("lead-square", 64, 63, { buf: lead167, loop: 64 }),
  sampleBlob("bass", 128, 63, { buf: bass256, loop: 128 }),
  sampleBlob("kick", 200, 63, { buf: kick }),
  sampleBlob("hat", 48, 56, { buf: hat }),
];
while (samples.length < 31) samples.push(sampleBlob("", 0, 0, { buf: Buffer.alloc(0) }));

// 4 patterns, chord roots C F G F; lead motif varies per pattern
const leadPhrases = [
  [N.E4, N.G4, N.A4, N.G4, N.E4, N.D4, N.C4, N.D4, N.E4, N.G4, N.E4, N.D4, N.C4, 0, N.D4, N.E4],
  [N.A4, N.G4, N.A4, N.C5, N.A4, N.G4, N.E4, N.G4, N.A4, N.C5, N.A4, N.G4, N.E4, 0, N.G4, N.A4],
  [N.B4, N.C5, N.B4, N.G4, N.A4, N.B4, N.C5, N.B4, N.G4, N.A4, N.G4, N.E4, N.D4, 0, N.D4, N.G4],
  [N.A4, N.G4, N.E4, N.G4, N.A4, N.G4, N.E4, N.D4, N.C4, N.D4, N.E4, 0, N.C4, 0, 0, 0],
];
const bassRoots = [N.C3, N.F3, N.G3, N.F3];
const stabNotes = [[N.C3, N.E3, N.G3], [N.F3, N.A3, N.C4], [N.G3, N.B3, N.D4], [N.F3, N.A3, N.C4]];

const CH = 4, ROWS = 64, PATS = 4;
const pat = Buffer.alloc(PATS * ROWS * CH * 4);
function set(p, r, c, smp, per, eff = 0, prm = 0) {
  const o = (p * ROWS * CH + r * CH + c) * 4;
  pat[o] = ((smp & 0xF0)) | ((per >> 8) & 0x0F);
  pat[o + 1] = per & 0xFF;
  pat[o + 2] = ((smp & 0x0F) << 4) | eff;
  pat[o + 3] = prm;
}
for (let p = 0; p < PATS; p++) {
  const phrase = leadPhrases[p];
  for (let i = 0; i < 16; i++) { // lead: note every 4 rows
    const n = phrase[i];
    if (n) set(p, i * 4, 0, 1, n);
    else if (i > 0) set(p, i * 4, 0, 0, 0, 0xE, 0xC0 + 4); // EC4 cut = rest
  }
  for (let i = 0; i < 8; i++) set(p, i * 8, 1, 2, bassRoots[p]); // bass half notes
  for (let r = 0; r < 64; r += 8) set(p, r, 3, 3, 512);          // four-on-floor kick (low thump)
  for (let r = 4; r < 64; r += 8) set(p, r, 3, 4, 60);           // offbeat hats (high tick)
  for (let i = 0; i < 4; i++) {                                  // chord stabs
    const [a, b, c] = stabNotes[p];
    set(p, i * 16, 2, 1, [a, b, c][i % 3]);
  }
}

const hdr = Buffer.alloc(1084);
Buffer.from("vera demo tune").copy(hdr, 0);
hdr[950] = PATS; hdr[951] = 0;
for (let i = 0; i < PATS; i++) hdr[952 + i] = i;
hdr.write("M.K.", 1080);
samples.forEach((s, i) => s.h.copy(hdr, 20 + i * 30));

const outPath = process.argv[2] || "music/demo.mod";
writeFileSync(outPath, Buffer.concat([hdr, pat, ...samples.map((s) => s.d)]));
console.log(`wrote ${outPath}`);
