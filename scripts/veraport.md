# VERA Port Project — AI Handoff Document

**Session**: 2026-09-10, conversation between `anomixer` and Perplexity
**Purpose**: Full context transfer so a new AI assistant can continue the Apple II VERA work without re-deriving any findings.
**Companion docs**: `veratest/AGENTS.md` (hardware + build reference) and `docs/vera-session.md` (session log through Time Pilot v1.9 / veratest v0.0.3). This file covers the work started **after** those docs.

---

## 1. Hardware & Architecture (established facts)

- **Target**: Apple II (IIe / IIgs / Laser 128), Apple2TS web emulator, AppleWin VERA fork (`anomixer/AppleWin`).
- **VERA card**: Slot 2 (`$C200`) or Slot 4 (`$C400`). Registers at `$C080 + ($10 × Slot)` or Slot ROM `$C000 + ($100 × Slot)`. Register layout is isomorphic to X16's `$9F20-$9F3F` (ADDR_L/M/H, DATA0/1, stride auto-increment, DC_VIDEO, L0/L1 config).
- **VRAM**: 128 KB. Fixed regions: PSG regs `$1F9C0-$1F9FF`, palette `$1FA00-$1FBFF`, 128 sprite attributes `$1FC00-$1FFFF`.
- **PSG**: 16 channels, 4 bytes each: `[freq_lo, freq_hi, ctrl, wave]`.
  - `ctrl`: bit7 = Right enable, bit6 = Left enable, bits5-0 = volume 0..63. Values in use: `$40` L, `$80` R, `$C0` center.
  - `wave`: 0-7 pulse (duty variants), 8 sawtooth, 9 triangle, `$A-$F` noise/LFSR.
  - **Frequency**: `f = PSG_CLOCK / (N + 1)`, working assumption `PSG_CLOCK = 781250` (25 MHz / 32). **Not yet verified on hardware** — verify against a known ZSM note before trusting pitch.
- **NO YM2151**. The card's audible path is PSG only. ZSM conversion must strip FM commands (already done in `slideshow_hdv.mjs` / `build_sonic_dat.mjs`); FM-only ZSM tracks are excluded.
- **Host CPU budget**: ~1.02 MHz 6502. Measured pain threshold: ~240 VERA writes per frame saturated frame time (Time Pilot high-score screen incident, fixed via lazy redraw). Program RAM after `TPILOT.SYSTEM` native loader: `$0800..$B7FF` (45 KB).

## 2. Existing Assets (reuse, don't rebuild)

From Time Pilot IIvera v1.9 and veratest v0.0.3:

- **Streaming**: ProDOS Direct Block MLI (`$80`) engine — streams 512-byte blocks straight into VERA VRAM, no pathname parsing (see `slideshow.asm`).
- **Audio engines**: 60 Hz VSYNC-IRQ-driven PSG event player (512-byte buffer at `$4000`, VERA addr regs saved/restored around ticks); PSG shadow register table (`PSG_SHADOW`) for glitch-free mute; PCM SFX serviced from VRAM Bank 0 (~5 kHz 8-bit); ZSM → PSG build-time converter; acoustic balancing tooling (e.g., CANYON: noise 55%, melody 130%).
- **Graphics engines**: Mode 7 320×240 8bpp bitmap + RLE, Mode 4 tilemap with smooth camera, dual-layer parallax, 16-sprite engine, 256-color text mode (Matrix demo), full VRAM/sprite/PSG clean-reset routine (`CLR_64K`).
- **Build system**: zero-dependency Node.js — two-pass 6502 assembler (`src/asm6502.mjs`), Applesoft BASIC compiler (`src/applebasic.mjs`), ProDOS filesystem image builders. Time Pilot v1.9 switched to Python 3 + CMake + `llvm-mos` (`mos-apple2e-clang`).
- **Distribution**: 140 KB `.po` + HDV images; Apple2TS Disk Collection registration (`src/ui/devices/disk/newreleases.ts`); GitHub Releases URLs.
- **Dual-slot probing**: Applesoft `startup.bas` probes Slot 2/4 and launches matching binary (`*.BIN` / `*4.BIN`).

## 3. Audio Findings (this session — do not re-litigate)

- **MP3 playback: infeasible, closed question.** Helix fixed-point decoder needs ~26 MIPS; best DSP implementations ~5-8 MIPS; retro floor is 486DX4-100 / 68030-50 class. The 6502 at 1.02 MHz delivers ~0.2-0.3 MIPS. Also Helix needs 53 KB code + 28 KB heap — doesn't fit 64 KB main RAM. Additionally 128 kbps MP3 = 16 KB/s, *more* than the existing ~5 KB/s PCM stream, so MP3 would be a storage regression even if decoding were free.
- **Current architecture is already optimal**: music = PSG chiptune (event tables, ~307 B/s, near-zero CPU), short SFX = PCM one-shots in VRAM. Keep this split.
- **If sampled music is ever wanted**: (a) offline transcode to 8-bit PCM at 8-15 kHz in CPU-idle contexts (32 MB HDV ≈ 68 min at 8 kHz); (b) 4-bit ADPCM for 2:1 (~15-25 cycles/sample decode); (c) IIgs-only: Ensoniq DOC 5503 does hardware sample playback (KansasFest 1993 documented MOD-on-DOC); (d) external MP3 modules = out of scope, not VERA audio.
- **4-channel software mixing of MOD samples: infeasible on IIe** (~56%+ CPU). C64 needs REU + Ultimate Audio DMA to do it. Direct playback must use PSG synthesis, not sample mixing.

## 4. Music Pipeline Initiative (current work)

### 4.1 Converter: `mod2psg.mjs` v0.3 (validated 2026-09-10, see below)

Zero-dependency Node.js converter, written to match the veratest pipeline style. Parses 31-sample ProTracker MOD (`M.K.`, `4CHN`, `6CHN`, `8CHN`, etc.), runs a tick-accurate effects engine, and emits:

1. **`<name>.psg`** — 60 Hz-frame event stream. Format: per VSYNC frame `[count u8][(reg u8, val u8) × count]`; reg 0..63 = `channel × 4 + field` (player adds PSG base `$1F9C0`); terminator `[0xFF][loopFrame u16 LE]`; count 0 = silence frame.
2. **`<name>.wav`** — 44.1 kHz stereo preview rendered from the *same event stream* (what you hear ≈ what the Apple II plays).
3. **`<name>_pcm/`** — 8-bit signed drum one-shots + manifest (VRAM Bank 0 material, Time Pilot SFX pattern).

Design decisions:
- MOD channels → PSG channels 0..n-1; drums → PSG channel 15 (noise + decay envelope); pan defaults L-R-R-L (`$40/$80`).
- Period→frequency: continuous formula `f = 65.406 × 856 / period` (PT C-1 ≡ MIDI 36), i.e. PT C-3 = middle C. `--octave=N` flag if a source sounds globally off.
- 50 Hz MOD ticks packed into 60 Hz frames via fractional accumulator.
- Effects: arpeggio (0), porta up/down (1/2), tone porta (3), vibrato (4), E6 pattern loop, pan (8), offset (9), vol slide (A), volume (C), jump/break (B/D), speed/tempo (F), E9 retrigger, EC cut, ED delay, EE pattern delay. **Ignored**: finetune, glissando.
- A synthetic smoke-test MOD (`test_tune.mod`, 12532 bytes, 2 patterns, arpeggio + vibrato + kick) was generated alongside.
- CLI extras: `--verbose` prints per-order frame map (timing audit), unreachable-order diagnostic (game-triggered jingle sections), loop target report.

**Validation log (2026-09-10, all items from the old checklist closed):**
1. ✅ `test_tune.mod` first run: no crash, but 6 logic bugs found & fixed (v0.1.1): `st.delayTick`→per-channel `ch.delayTick` (ED delay re-triggered whole row); effect-parse-before-trigger ordering; sample-0 instrument reuse (`curSample` fallback for drum detect); `retrigCount`/`vibRate` not reset per row; WAV `N=0` phase bug (`((N||1)+1)`→`(N+1)`); name-based wave heuristic (bass-saw→saw); dead `out` array removed.
2. ✅ Synthetic `fx_stress.mod` exposed an **EEx infinite re-arm** (delay repeat re-entered `processRow` and re-set `rowDelay`): fixed with `hold` flag (delay filler ticks sustain without retrigger). Deleted after use.
3. ✅ Real classic MOD: Moby `BreakLine.mod` (201390 bytes = canonical ModLand/ModArchive `brkline`, ProTracker M.K., 63 orders).
   - First run hit the 10-min safety cap (36000 frames): `p20 r47 B01` loops order 1..31 forever by design → implemented **song-loop detection** (v0.2): backward jump to a visited order position terminates with `loopFrame` = first-visit frame; unreachable orders (32..62, game jingles) reported, not played.
   - Output was then 307.2s but Winamp plays 5:27.2 (Δ exactly 20.0s = 1000 ticks): root cause = played-pattern `pat20` rows 24–37 contain **five `E60`/`E6A` pattern loops**, and E6 was still ignored → implemented **E6 pattern loop** (v0.3): E60 marks start only, E6x counts hits and resets on completion (E60-must-not-reset-counter, else loop-back replays hang). Re-render = **19632 frames = 327.2s, ffprobe-confirmed, exact Winamp match**. (VLC shows 5:17 — likely its own duration estimation; ear test pending.)
4. ⏳ **`PSG_CLOCK` (781250) + octave mapping: STILL UNVERIFIED** — compare a converted note against a known-pitch ZSM on hardware before trusting pitch.
5. ⏳ Drum noise decay (0.62/tick) + ch15 noise frequency: still placeholders, tune by ear.
6. ✅ Dead `out` array removed.

### 4.2 Build: `psgplay.asm` (6502 player — DELIVERED 2026-09-10, UNTESTED on HW/emu)

RAM-resident stream player, veratest conventions (`* = $2000` BRUN, dual slot, RTS to BASIC, `$03FE` VSYNC hook, VERA addr save/restore, `vera.inc` via assembler). Files: `psgplay.asm` (779 B code), `build_psgplay.mjs` (assemble slot 2+4, append `.psg` at `STREAM_DATA`, fit-check), `check_psg.mjs` (6502-algorithm mirror: validates any `.psg` — terminator reachability, reg<64, loop-skip lands on frame boundary).

- Frame engine: one record per VSYNC tick, `count` pairs → `$1F9C0+reg` (stride 1, slideshow idiom), count-0 = hold, `$FF`+loopFrame = rewind+skip (loopFrame 0 = instant restart), corrupt-count guard (`BCS`→restart), 24-bit frame counter + `F:xxxxxx`/`M` status on text row 23, `ESC/Q` exit (IRQ restore + silence + RTS), `M` mute with 64-byte shadow restore (pause-while-muted; absolute writes resume cleanly).
- Fit rule enforced by build: image must end below `$9500`. `test_tune.psg` → `PSGPLAY.BIN`/`PSGPLAY4.BIN` (2074 B, ends `$281A`) ✅. `BreakLine.psg` (47 KB) correctly REJECTED → needs HDV streaming (Jukebox step). No emulator/HW run yet — test on AppleWin VERA fork + Apple2TS, then real II/IIgs.
- ⚠️ Gotcha for future agents: `assembleAsmFile` only finds `vera.inc` beside the `.asm`, so `vera.inc` is **vendored into `veramus/`** (29 equates, verified identical to `veratest/src/vera.inc`; if upstream changes, re-copy). An earlier build without it **silently assembled all `VERA_*` refs to `$0000`** (25× `STA $0000`, zero diff between slots — caught by diffing). `build_psgplay.mjs` asserts no abs ref to `$0000` in output to catch any recurrence.
- 🐛 HW lesson 2026-09-10 (`F:00ADAE M` freeze, tune 1, AppleWin): player played one 1/60s blip then went silent with the frame counter racing past the 922-frame loop without reset. Root cause in `psgplay.asm` TICK: the count-0 hold-frame path did `BEQ TICK_BUMP` **before** `ADV_PTR`, so the first hold frame re-read the same 0 byte forever (silence + runaway counter + terminator never reached; test_tune is 828/922 hold frames). Fix: `ADV_PTR` unconditional, then `LDX CNT` (re-sets Z) + `BEQ`. `psgstream.asm` never had it (GETB advances on read). `check_psg.mjs` already modeled the correct walk — the code just didn't match the mirror. Also added `CLD` at both players' START (ADC assumes binary mode).
- 🔊 Content lesson 2026-09-10 ("high single tone droning" report, tune 1): stream decoded 100% correct (C-arp 262/330/392 Hz + 65 Hz bass + kick), wav RMS/zcr confirmed a constant ~300 Hz buzz. The smoke-test tune is just a terrible demo (no rests, sub-bass inaudible on small speakers, one kick in 15 s). Fix: `gen_demo.mjs` composes a real 4ch/4-pattern C-major groove (lead motif + roots + 4-on-floor + hats + EC rests, 1844 frames/30.7s, 3293 B) — TESTTUNE.BIN now ships `demo.psg`; `test_tune.psg` stays a converter regression test only. Rule: never judge the player by the smoke tune; A/B `demo.wav` (same-stream render) vs hardware.
- 🔖 Release convention (from 2026-09-10 version-skew incident): menu + both player titles carry a rev tag (`R5` now — bump in `startup.bas:20`, `psgplay.asm` TITLE, `psgstream.asm` TITLE on every release). TICK (RAM) and GETB/REFILL/SKIP (stream) both disassembly-verified byte-exact against source; unknown-opcode sweep of both binaries clean (code regions only). If a symptom can't be reproduced from current source, check the on-screen rev tag FIRST (stale `.po` behind file-lock `.new` dance).
- Menu: removed the 5 s auto-start (was blind-test harness) — straight INPUT now.

Consumes the `.psg` format above. Requirements derived from existing engines: VSYNC IRQ at 60 Hz advances one frame record per tick, writes `[count]` register pairs to PSG at `$1F9C0 + reg`, VERA address registers preserved around ticks, silence/clean-exit on `Esc`, `PSG_SHADOW`-style state if mute is wanted. Should assemble under `src/asm6502.mjs` conventions (ACME-ish syntax, slot base injection via `vera.inc`).

### 4.3 Roadmap after that (agreed direction)

1. `mod2psg.mjs` validated → 2. `psgplay.asm` player → 3. **VERA Jukebox**: bootable HDV with `MODPLAY.SYSTEM` + file browser, users drop any `.MOD` on the ProDOS volume; register in Apple2TS `newreleases.ts`. → 4. `midi2psg.mjs` (SMF parser is simpler than MOD; whole `.mid` fits in VRAM Bank 0; MIDI 16 tracks ↔ PSG 16 channels 1:1; channel 10 → noise; GM preset → waveform mapping table is the real work; note Furnace does NOT import MIDI files — don't route through it). → 5. Optional IIgs branch: MOD with real samples via Ensoniq DOC.

## 5. X16 Repo Porting Candidates (re-ranked this session)

Basis: VERA display layer ports mechanically (same register layout, different base); KERNAL → ProDOS MLI + loader trampoline (pattern proven in Time Pilot); main RAM is the constraint.

| Rank | Project | Verdict | Rationale |
|---|---|---|---|
| 1 | `wizardmanannan/CX16Agi` (Sierra AGI interpreter, C) | **Top pick** | X16 banked RAM dependency solved by Direct Block MLI streaming + VRAM-as-database (proven zero-disk pattern). "Apple II plays King's Quest via VERA" is the strongest showcase. cc65 C, portable. |
| 2 | `SlithyMatt/x16-tile-editor` | Strategic | First native asset tool for the whole Apple VERA ecosystem; built from existing tilemap/font engines. "Building the platform, not a port." |
| 3 | `SlithyMatt/x16-chasevault`, `CJLove/x16-LodeRunner`, `JimmyDansbo/cx16-maze` | Cheap | All engine components already exist locally; port = game logic only. Lode Runner can recompile under `llvm-mos`. |
| — | `visrealm/cx16-supaplex` | Downgraded | Full-map falling-rock physics needs the X16's 8 MHz; at 1.02 MHz expect frame-budget pain unless IIgs 2.8 MHz or heavy optimization. |
| — | `kgsws/kg3d_x16` (Build-style 3D) | Rejected for IIe | CPU-bound; IIgs-only dream project. |
| — | `zsmkit`, `cx16-concerto`, `StewBC/music-player` | Rejected | YM2151-dependent; no YM2151 on the card. PSG half is already covered by in-house ZSM converter + player. |

Note: `anomixer/veratest` itself is upstream-registered in Apple2TS; `anomixer` also contributed the `ii-vera` ProDOS BIN-header fix and MLI X-register preservation upstream to `StewBC/Time-Pilot` (commit `a7fa28c`, integrated by Stefan Wessels in `0870564`, release `v1.9-iivera`).

## 6. Open Questions / Context for the Next Agent

- The user (anomixer) works iteratively (test-and-fix), communicates in Traditional Chinese, documents in English (AGENTS.md convention), and uses `AGENTS.md` + session `.md` files precisely for AI handoff — keep that convention.
- Hardware verification always beats emulator verification; Apple2TS and AppleWin (VERA fork) are the test benches; final validation on real II/IIgs.
- Distribution artifacts follow the established pattern: dual-slot binaries (`*.BIN` + `*4.BIN`), `.po` + `.hdv`, 560×384 PNG previews, GitHub Releases.
- `PSG_CLOCK` (781250) and PT octave mapping are the two unverified numeric assumptions in the music pipeline — resolve these before writing more converters.
- When porting X16 assembly: check for 65C02-only instructions (fine on Enhanced IIe/IIc/IIgs, not on original II/II+), and X16 banked-RAM assumptions (Apple II has only 64 KB main + 128 KB VRAM as asset space).
