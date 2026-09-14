#!/usr/bin/env node
/**
 * zsm2psg.mjs — Commander X16 ZSM to Apple II VERA PSG Converter
 *
 * Converts the 5 x16-hero ZSM music files into standard .psg register streams
 * compatible with veramusic (psgplay.asm / psgstream / check_psg.mjs).
 *
 * Format:
 *   Per 60Hz frame: [count u8][ (reg u8, val u8) * count ]
 *   Terminator:     [0xFF][loopFrame u16 LE]
 */
import fs from "fs";
import path from "path";

const SRC_DIR = "C:/dev/x16-hero";
const OUT_DIRS = [
  "C:/dev/veramusic/music",
  "C:/dev/x16-hero/psg",
  "C:/dev/x16-hero-vera/music"
];

for (const dir of OUT_DIRS) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const TRACKS = [
  { name: "TITLE",         file: "TITLE.ZSM" },
  { name: "HIGHSCORE",     file: "HIGHSCORE.ZSM" },
  { name: "GAMEOVER",      file: "GAMEOVER.ZSM" },
  { name: "KILLED",        file: "KILLED.ZSM" },
  { name: "LEVELCOMPLETE", file: "LEVELCOMPLETE.ZSM" },
];

const PSG_AUDIO_RATE = 25000000 / 512; // 48828.125 Hz VERA internal clock

function midiToFreqN(midiNote) {
  const f = 440 * Math.pow(2, (midiNote - 69) / 12);
  return Math.max(0, Math.min(0xFFFF, Math.round(f * 131072 / PSG_AUDIO_RATE)));
}

// OPM Key Code note mapping:
// 14: C, 0: C#, 1: D, 2: D#, 4: E, 5: F, 6: F#, 8: G, 9: G#, 10: A, 12: A#, 13: B
const noteMap = { 14: 0, 0: 1, 1: 2, 2: 3, 4: 4, 5: 5, 6: 6, 8: 7, 9: 8, 10: 9, 12: 10, 13: 11 };

function convertZsm(trackName) {
  const filePath = path.join(SRC_DIR, `${trackName}.ZSM`);
  const raw = fs.readFileSync(filePath);

  // Read header
  const loopOffset = raw[3] | (raw[4] << 8) | (raw[5] << 16);

  let ptr = 16, tick = 0;
  let loopFrame = 0;
  let loopFrameFound = false;

  const ymChNotes = [0, 0, 0, 0, 0, 0, 0, 0];
  const ymChKFs   = [0, 0, 0, 0, 0, 0, 0, 0];
  const ymChPan   = [0xC0, 0xC0, 0xC0, 0xC0, 0xC0, 0xC0, 0xC0, 0xC0];

  const frameEvents = [];
  function addWrite(t, reg, val) {
    while (frameEvents.length <= t) frameEvents.push([]);
    frameEvents[t].push({ reg: reg & 0x3F, val: val & 0xFF });
  }

  while (ptr < raw.length) {
    if (loopOffset > 0 && ptr >= loopOffset && !loopFrameFound) {
      loopFrame = tick;
      loopFrameFound = true;
    }

    const command = raw[ptr++];

    if (command < 0x40) {
      // Native PSG write (voice 0 or 1)
      let val = raw[ptr++];
      if (trackName === "TITLE") {
        // Boost second-half native melody on voice 0 and counter-melody on voice 1
        if (command === 2) {
          const pan = val & 0xC0;
          const vol = val & 0x3F;
          val = pan | (vol === 0 ? 0 : Math.min(63, Math.round(vol * 63 / 53)));
        } else if (command === 6) {
          const pan = val & 0xC0;
          const vol = val & 0x3F;
          val = pan | (vol === 0 ? 0 : Math.min(60, Math.round(vol * 60 / 53)));
        }
      }
      addWrite(tick, command, val);
      continue;
    }

    if (command === 0x40) {
      const ext = raw[ptr++];
      ptr += ext & 0x3F;
      continue;
    }

    if (command < 0x80) {
      // YM2151 FM write batch: translate to PSG voices 2..9
      const count = command & 0x3F;
      for (let i = 0; i < count; i++) {
        const reg = raw[ptr++], val = raw[ptr++];
        if (reg >= 0x20 && reg <= 0x27) {
          const ch = reg - 0x20;
          const p = val & 0xC0;
          ymChPan[ch] = (p === 0xC0 ? 0xC0 : (p === 0x80 ? 0x80 : 0x40));
        } else if (reg >= 0x28 && reg <= 0x2F) {
          ymChNotes[reg - 0x28] = val;
        } else if (reg >= 0x30 && reg <= 0x37) {
          ymChKFs[reg - 0x30] = val;
        } else if (reg === 0x08) {
          const ch = val & 7;
          const ops = (val >> 3) & 0x0F;
          const psgVoice = 2 + ch; // YM2151 ch 0..7 -> VERA PSG voices 2..9
          const baseReg = psgVoice * 4;

          if (ops > 0) {
            // Key On
            const kc = ymChNotes[ch];
            const oct = (kc >> 4) & 7;
            const nCode = kc & 0x0F;
            const semi = noteMap[nCode] ?? 0;
            let midi = (oct + 1) * 12 + semi;

            if (trackName === "TITLE" && ch === 7) {
              // Signature intro chime/piano ("dong~ dong~ dong~ dong~")
              midi = Math.max(12, midi - 12);
              const fN = midiToFreqN(midi);
              addWrite(tick, baseReg + 0, fN & 0xFF);
              addWrite(tick, baseReg + 1, (fN >> 8) & 0x3F);
              addWrite(tick, baseReg + 3, 0x80); // Warm Triangle wave
              // Strike + natural piano decay envelope across the 16-frame note window
              const decay = [56, 48, 40, 32, 24, 16, 8, 0];
              for (let d = 0; d < decay.length; d++) {
                addWrite(tick + d * 2, baseReg + 2, ymChPan[ch] | decay[d]);
              }
            } else {
              const fN = midiToFreqN(midi);
              let wave = 0x3F; // Pulse ~50%
              let vol = 36;
              if (trackName === "KILLED") {
                wave = 0x80; // Triangle wave for soft backing chord
                vol = 24;
              } else if (trackName === "GAMEOVER") {
                wave = (ch === 0 || ch === 1) ? 0x80 : 0x3F;
                vol = 40;
              } else if (ch === 7) {
                // HIGHSCORE / general lead
                wave = 0x3F;
                vol = 46;
              } else if (ch === 6) {
                wave = 0x80; // Bass
                vol = 52;
              } else if (ch === 4 || ch === 5) {
                wave = 0x3F;
                vol = 44;
              } else {
                wave = 0x3F;
                vol = 36;
              }

              addWrite(tick, baseReg + 0, fN & 0xFF);
              addWrite(tick, baseReg + 1, (fN >> 8) & 0x3F);
              addWrite(tick, baseReg + 3, wave);
              addWrite(tick, baseReg + 2, ymChPan[ch] | vol);
            }
          } else {
            // Key Off: mute voice
            addWrite(tick, baseReg + 2, 0x00);
          }
        }
      }
      continue;
    }

    if (command === 0x80) break;

    const delay = command & 0x7F;
    tick += delay;
  }

  // Ensure trailing frames up to song end are preserved
  const totalFrames = Math.max(tick, frameEvents.length);
  while (frameEvents.length < totalFrames) frameEvents.push([]);

  // Build standard .psg byte stream:
  // Each frame: [count u8][ (reg, val) * count ]
  // Deduplicate writes to the same register within each frame (last write wins)
  const psgBytes = [];

  for (let f = 0; f < frameEvents.length; f++) {
    const rawWrites = frameEvents[f] || [];
    const regMap = new Map();
    for (const w of rawWrites) {
      regMap.set(w.reg, w.val);
    }

    const count = regMap.size;
    if (count > 64) {
      throw new Error(`Frame ${f} has ${count} writes (> 64)!`);
    }

    psgBytes.push(count);
    for (const [reg, val] of regMap) {
      psgBytes.push(reg, val);
    }
  }

  // Terminator: [0xFF, loopFrame_lo, loopFrame_hi]
  psgBytes.push(0xFF, loopFrame & 0xFF, (loopFrame >> 8) & 0xFF);

  const psgBuf = Buffer.from(psgBytes);
  const durationSec = (totalFrames / 60).toFixed(1);

  console.log(`[Converted] ${trackName}.ZSM -> ${psgBuf.length} bytes (${totalFrames} frames, ${durationSec}s, loopFrame: ${loopFrame})`);

  for (const dir of OUT_DIRS) {
    const dest = path.join(dir, `${trackName}.psg`);
    fs.writeFileSync(dest, psgBuf);
  }

  return { trackName, totalFrames, loopFrame, size: psgBuf.length };
}

console.log("=== Converting x16-hero ZSM tracks to standard .psg streams ===");
for (const t of TRACKS) {
  convertZsm(t.name);
}
console.log("All tracks converted successfully!\n");
