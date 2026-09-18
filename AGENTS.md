# VERA Music (veramusic) — Apple II VERA Audio Architecture & Development Guide

**Repository**: `https://github.com/anomixer/veramusic`  
**Target Hardware**: Apple II (Enhanced IIe, IIgs, Laser 128) with VERA card in Slot 2 (`$C0A0`) or Slot 4 (`$C0C0`).  
**Test Emulators**: Apple2TS web emulator, AppleWin VERA fork (`anomixer/AppleWin`).  
**Audience**: AI agents and human developers continuing the audio pipeline development.

---

## 1. Hardware Architecture & Constraints

### 1.1 VERA Audio Capabilities
The VERA card on Apple II provides:
- **16-channel PSG (Programmable Sound Generator)** at `$1F9C0..$1F9FF`:
  - 4 bytes per voice: `[freq_lo, freq_hi, ctrl, wave]`
  - `ctrl`: bit 7 = Right enable, bit 6 = Left enable, bits 5:0 = Volume (0..63). `$40` = Left, `$80` = Right, `$C0` = Center (+6dB).
  - `wave`: bits 7:6 = Waveform (`00` = Pulse, `01` = Sawtooth, `10` = Triangle, `11` = Noise). Bits 5:0 = Pulse width (duty cycle).
  - Internal base clock: `25 MHz / 512 = 48,828.125 Hz`. Phase accumulator: 17-bit (`% 131,072`).
  - Frequency calculation: `N = round(f * 131072 / 48828.125) = round(f * 2.68435456)`.
- **1-channel 8-bit Signed PCM FIFO** at `$1F9C0 + $1D` (`VERA_AUDIO_DATA`):
  - 4 KB hardware FIFO buffer.
  - Rate register (`VERA_AUDIO_RATE`, `$1E`): rate = 1..128, actual Hz = `(rate / 128) * 48828.125 Hz`. Rate `21` (`$15`) = **8010.864 Hz**.
  - Ctrl register (`VERA_AUDIO_CTRL`, `$1C`): bit 7 = FIFO reset, bit 5 = stereo/mono (0=mono), bits 3:0 = volume (0..15).
- **NO YM2151 FM Synthesizer**:
  - The Commander X16 has a Yamaha YM2151 (OPM) chip on board.
  - The **Apple II VERA card has NO YM2151**. All sound must be synthesized via VERA PSG or streamed via VERA PCM.

### 1.2 Host CPU & Memory Constraints
- Apple II 6502 @ 1.02 MHz: single frame budget at 60 Hz = ~17,030 clock cycles.
- Software mixing of 4-channel 8-bit PCM in real time is **infeasible** on a 1.02 MHz 6502 (~56%+ CPU usage, zero margin for game/demos).
- Real-time MP3 decoding is **impossible** (~26 MIPS needed; 6502 delivers ~0.25 MIPS).
- **Optimal Strategy**:
  - **Music (PSG)**: 60 Hz VSYNC IRQ-driven event stream (~300–600 bytes/sec, < 3% CPU).
  - **Sampled Audio (PCM Stream)**: Pre-rendered 8-bit mono PCM streamed directly from ProDOS raw disk blocks via MLI `READ_BLOCK` (`$80`), buffered by VERA's 4 KB FIFO.
  - **Hybrid Engine (Option A)**: Sampled percussion & special effects streamed to PCM FIFO, melody & chords synthesized on PSG, mixed in hardware DAC.

---

## 2. Development History & Milestones

### Milestone 1: MOD to PSG Converter (`mod2psg.mjs`) & RAM Player (`psgplay.asm`)
- **Format**: 31-sample ProTracker MOD parser with tick-accurate effects engine (porta, arpeggio, vibrato, E6 loop).
- **Output**: 60 Hz PSG register write stream (`.psg`). Format: per frame `[count][(reg, val) * count]`, count=0 for hold frame, `$FF [loopFrame LE]` terminator.
- **Player**: `psgplay.asm` (RAM resident at `$2000`), hook `$03FE` VSYNC IRQ, shadow volume mute on `M`, pause on `P`, `ESC/Q` exit.
- **Key HW Bug Fixed**: Count-0 hold frames were skipping `ADV_PTR` before `BEQ TICK_BUMP`, causing infinite freeze on silence frames. Fixed with unconditional pointer advance.

### Milestone 2: MIDI to PSG Converter (`mid2psg.mjs`) & Disk Stream Player (`psgstream.asm`)
- **Format**: Standard MIDI File (SMF Type 0/1) to 60 Hz PSG stream (`Fantaisie-impromptu.psg`, 87 KB).
- **Streaming**: ProDOS MLI `READ_BLOCK` reading raw contiguous blocks starting at `STREAM_BLK0 = 100`. 512-byte double buffer at `$4000`, 60 Hz IRQ advancing stream pointer.
- **Voice Allocator**: 16 polyphonic PSG voices with damper pedal sustain (CC 64) and release curves.

### Milestone 3: PCM Disk Streaming (`wav2pcm.mjs` & `pcmstream.asm`)
- **Converter**: Resamples audio to 8010.864 Hz (rate 21), peak normalization (-0.3 dBFS), TPDF (Triangular Probability Density Function) dither to eliminate 8-bit harmonic quantization noise.
- **Streaming Engine**: `pcmstream.asm` streams 8010 Hz PCM directly to `$1D`. VERA's 4KB hardware FIFO absorbs ProDOS disk seek and read latencies completely.
- **Stopwatch**: Row 23 live timer `T: mm:ss.s  B: xxxx` driven by fractional 16-bit block math ($A39E per 512-byte block).

### Milestone 4: Hybrid Audio Engine (`render_hybrid.mjs` & `hybridstream.asm`)
- **Challenge**: Space Debris (`space_debris.mod`) uses Ensoniq DOC synthesizer samples for its iconic space choir, chords, and punchy drums.
- **Solution**:
  - Sample drum one-shots (`BD1`, `SD1`, `SoftShake`, `Hup`) and looping ambient samples (`Choir`, `Chord1`, `Zoh2`, `Rezonatix3`) are mixed offline into an 8010 Hz PCM track.
  - Tonal instruments (`SuperHyperBass`, `SynBrass`, `SawSynth.*`) are rendered into 16-channel PSG register events.
  - **Combined Interleaved Stream (`.hyb`)**: Each 60 Hz frame contains `[psg_count][(reg, val) * psg_count][pcm_len][pcm_bytes...]`.
  - **4-Frame FIFO Pre-buffering**: The player pre-loads ~66 ms of PCM audio into the VERA FIFO before starting the playback clock, ensuring 100% stutter-free disk streaming.
- **ProTracker Effect Memory Discovery**:
  - In Space Debris, the iconic space sound is a Choir sample sweeping upwards (period 320 down to 160 via tone portamento `300`).
  - ProTracker specification requires that when effect `3` (tone portamento) is given with parameter `00`, it **must reuse the previous speed parameter**. Resetting speed to 0 caused the choir sweep to freeze. Fixed in `render_hybrid.mjs`.

### Milestone 5: Dual-Slot Jukebox System (`build_jukebox.mjs`, `build.bat`, `startup.bas`)
- Automated single-command build pipeline:
  - `jukebox.po` (140KB floppy): Tracks 1 & 2 (Melody Demo & Chopin Fantaisie).
  - `jukebox32.hdv` (32MB hard disk image):
    - Track 1: Melody Demo (RAM PSG, 0:30)
    - Track 2: Chopin Fantaisie-Impromptu (Stream PSG, 5:17, blks 100–270)
    - Track 3: Space Debris (Hybrid PSG+PCM, 5:05, blks 5000–9884)
    - Track 4: The Wellerman (Stream PCM, 2:00, blks 600–2486)
- Applesoft BASIC auto-detects VERA card in Slot 2 (`$C0A0`) or Slot 4 (`$C0C0`) and launches the corresponding player binary.

### Milestone 6: Copyright Compliance & Wellerman Integration
- Purged all copyrighted Michael Jackson - Beat It files.
- Integrated Alexander Nakarada's royalty-free "The Wellerman" (`alexander-nakarada-the-wellerman.mp3`):
  - Encoded to `wellerman_full.pcm` (8010 Hz, 1887 blocks).
  - Updated `pcmstream.asm` to display `A. NAKARADA: THE WELLERMAN (2:00)`.
  - Updated `startup.bas` menu option 4 and binary targets `PCMWEL.BIN` / `PCMWEL4.BIN`.

### Milestone 7: Full Instrument Extraction & Space Debris Hybrid Optimization
- **Sample Extraction (`extract_all_samples.mjs`)**:
  - Extracted all 17 active instruments from `space_debris.mod` into standalone 16-bit WAV files under `extracted_samples/` for acoustic auditioning.
- **Root Cause of Middle-Section PSG Dissonance**:
  - `SynBrass` (Orders 9–31) and `SawSynth` (Orders 14–40) were synthesized as raw unfiltered VERA sawtooth waves (`VERA_WAVE_SAW`), destroying the iconic warm Ensoniq DOC analog brass bite.
  - `SawSynth.Major/Minor/Arrested1/2` were synthesized as artificial 3-voice PSG sawtooth chords on voices 8–15, causing harsh phase clashing.
  - ProTracker **Effect 9 (Sample Offset)** was completely ignored in PCM triggers: 1,372 effect 9 commands (used to slice chords, scrub `Rezonatix3`, and nuance shaker hits) were lost.
- **Hybrid Reclassification & Engine Upgrades (`render_hybrid.mjs`)**:
  - Reclassified `SawSynth.*`, `SawSynth`, and `SynBrass` from PSG to PCM, preserving their authentic sampled Ensoniq timbre and filter sweeps.
  - Maintained `SuperHyperBass` as PSG voice 0: clean 48.8 kHz crisp sub-bass without 8-bit PCM quantization noise.
  - Implemented ProTracker Effect 9 sample-offset addressing in `triggerDrum` and `triggerSampleVoice`.
  - Added per-channel voice cutoff when drums trigger on the same Amiga channel.
  - Added peak normalization to preview WAV generation (`space_debris_hybrid.wav`), completely eliminating clipping while preserving full dynamic range.
  - Re-rendered `space_debris.hyb` (4,867 blocks, down from 4,885 blocks) and rebuilt `jukebox32.hdv`.

### Milestone 10: Native Windows VERA PSG Player (`psgplay.exe`) & ZSM Transcoder (`zsm2psg.mjs`)
- **Motivation**:
  - Needed a fast, zero-latency desktop player to evaluate `.psg` streams on Windows without booting AppleWin or Apple2TS.
  - Needed a tool to convert Commander X16 ZSM music files (hybrid VERA PSG + YM2151 FM) into standalone 60 Hz VERA PSG register streams.
- **ZSM to PSG Transcoder (`tools/zsm2psg.mjs`)**:
  - Decodes ZSM header: extracts 24-bit loop offset and maps to exact frame index (`loopFrame`).
  - Translates native PSG writes (channels 0 & 1).
  - Translates YM2151 FM channels 0..7 to VERA PSG voices 2..9 with envelope shaping (e.g. warm triangle wave with natural piano decay for Title intro chime).
  - Emits standard `veramusic` format: per 60 Hz frame `[count u8][ (reg u8, val u8) * count ]`, terminated by `0xFF [loopFrame u16 LE]`.
  - All 5 tracks converted & verified via `check_psg.mjs` (`TITLE`, `HIGHSCORE`, `GAMEOVER`, `KILLED`, `LEVELCOMPLETE`).
- **Native Windows Player (`tools/psgplay.exe`, `tools/psgplay.c`)**:
  - Built with MSVC x86 (`/O2 /MT`) linking WinMM `winmm.lib` for zero external DLL dependencies.
  - Full 16-channel VERA PSG emulation:
    - 17-bit accumulator, 48,000 Hz stereo 16-bit PCM output (exact 800 samples/frame).
    - Pulse (duty width), Sawtooth, Triangle, 16-bit Galois LFSR Noise.
    - 64-step logarithmic hardware volume LUT.
    - Soft analog saturation (`tanh`) preventing harsh digital clipping.
  - Interactive controls matching `psgplay.asm`: `SPACE`/`P` pause, `M` mute, `+`/`-` volume, `[`/`]` 5s seek, `R` restart, `L` loop, `ESC`/`Q` quit.
  - Single-line non-scrolling UI with strict 77-column formatting, in-place carriage return (`\r`), and 16-voice activity meters (`0123456789ABCDEF`).

---

## 3. Acoustic Fidelity & Sound Design Insights

- **User Auditory Feedback**:
  - Multi-waveform experiments (allocating high-frequency pulse waves $pw=4, 8$ for hammer transients and treble chorusing on notes $\ge 56$) sounded like a clashing secondary synthesizer voice / electronic lead intruding over the piano melody.
  - User requested: "Keep the main melody instrument consistent throughout the entire song... keep it pure!".
- **Engine Optimization (`mid2psg.mjs`)**:
  - Default mode updated to **Pure Piano (`--synth=pure`)**.
  - **100% Uniform Pure Triangle Waveform (`VERA_WAVE_TRI`, `$80`)**: All 3,049 notes from lowest bass to highest treble use identical pure triangle waves with zero transient waveform switching.
  - **Eliminated Treble Voice Splitting**: Removed the secondary `CHORUS` voice allocation, keeping all 16 polyphonic hardware channels available for zero-stealing polyphony during complex arpeggio passages.
  - **Natural Acoustic Dynamics**: Smooth velocity curve spanning 28..63, frequency-dependent acoustic decay (bass rings 6-8s, treble decays 1.5-2s), and full damper pedal (CC 64) sustain.
  - **Rebuilt PSG & Disk Images**: `Fantaisie-impromptu.psg` reduced to 83,432 bytes (163 blocks, saving 3 blocks). All 140KB floppy and 32MB hard disk images updated.

### Milestone 9: Chopin Melody Voicing Boost & Auto-Exit to BASIC
- **User Feedback**:
  - Make Chopin's main melody louder; at V:15 it's still very quiet. Also, return to BASIC when playback finishes.
- **Melody Voicing Loudness Curve (`mid2psg.mjs`)**:
  - Classical piano voicing: In *Fantaisie-Impromptu*, the left hand sustains 8–12 arpeggiated bass notes simultaneously via the damper pedal, which previously masked the single-note right-hand melody.
  - **Melody Boost (`note >= 60`)**: Mapped to **48..63** (median ~58) with $norm^{0.35}$ perceptual curve + 5 frames (~80 ms) initial hold time so melody notes sing with clear projection.
  - **Accompaniment Foundation (`note < 60`)**: Mapped to **26..46** (median ~38), providing a lush background pad without overpowering the melody.
- **Auto-Exit to BASIC (`psgstream.asm`)**:
  - Previously, `psgstream.asm` looped indefinitely on the `$FF` stream terminator.
  - Added `DONE_FLAG`: When `$FF` is encountered, `TICK` sets `DONE_FLAG = 1`. `MAIN` immediately detects completion, unhooks the IRQ, silences PSG hardware, and returns via `RTS` to Applesoft BASIC.

### Milestone 10: Chopin Sub-Bass Restoration & Space Debris Pure PCM Transition
- **Chopin Sub-Bass Fix (`mid2psg.mjs`)**:
  - **Issue Identified**: In *Fantaisie-Impromptu*, climactic foundational bass notes (e.g. Note 32 / G#1 and Note 25 / C#1 at 34.65 Hz around 1:03 and 4:03) were inaudible.
  - **Root Causes**:
    1. Pure triangle waves at 35 Hz have virtually zero upper harmonics ($1/n^2$), falling below the cutoff frequency of standard desktop/monitor speakers.
    2. Damper release decay (`-2.8` per frame) silenced massive bass strings in just 10 frames (160 ms).
    3. Low accompaniment volume mapping (38–43) caused voice stealing to kill deep bass notes prematurely in polyphonic sixteenth-note passages.
  - **100% Pure Acoustic Piano Timbre (`VERA_WAVE_TRI`)**:
    - User emphasized: "That low note is not a bass synth, it must be piano! The whole song should be piano".
    - Eliminated all pulse wave switching: 100% of notes from A0/C#1 (note 25) to C7 use identical pure acoustic piano triangle waves (`VERA_WAVE_TRI`, `$80`). Zero synth bass or pulse buzz.
    - **Piano Bass Foundation (`note < 48`)**: Base volume mapped to **48..63** (median ~58) with an 8-frame (~130 ms) acoustic hold time so deep grand piano bass octaves strike with acoustic power.
    - **Natural String Release**: Release decay slowed to `0.6` per frame for notes `< 48`, allowing piano bass strings to ring out naturally without artificial clipping.
    - **Voice Allocation Protection**: `allocVoice()` prioritizes preserving active bass foundation notes (`note < 48`) from voice stealing.
- **Space Debris Pure PCM Transition**:
  - **Rationale**: User observed that the hybrid format required storing both PSG events and PCM samples (`.hyb`, 4,867 blocks), resulting in a larger file and inferior fidelity compared to pure PCM. Space Debris relies heavily on 17 Ensoniq DOC analog-filtered samples and 1,372 Effect 9 sample slices that sound distorted when forced into raw PSG square/saw waves.
  - **100% Pure PCM Stream (`space_debris.pcm`)**: Rendered via `render_pure_pcm.mjs` at 8010.864 Hz with TPDF dither, consuming only 4,787 blocks (saving 80 blocks vs hybrid).
  - **Player & Jukebox Integration**: Track 3 on `jukebox32.hdv` wired to `PCMDEB.BIN` / `PCMDEB4.BIN` via `pcmstream.asm` (blocks 5000..9786), featuring <5% 6502 CPU load, live stopwatch, volume control, and clean exit.

### Milestone 11: Concert Grand Acoustic Additive Bass Synthesis & Master Dynamic Headroom
- **Critical Root Cause Analysis**:
  1. **The Multi-Voice Summing Attenuation Trap**:
     - In VERA PSG architecture (e.g. `AppleWin`'s `VERAAudio.cpp`), the 16-bit DAC sums 16 voices ($16 \times 2,044 = 32,704 \approx 32,767$).
     - During complex arpeggio passages, 12–16 voices sound simultaneously, reaching full scale (-2 dBFS to 0 dBFS).
     - But when Chopin strikes the famous solo climactic low bass octave (Note 25, C#1 at 1:03 and 4:03), only 1 voice was playing alone! In AppleWin, a single voice at volume 63 outputs only $2,044 / 32,767 = -24 \text{ dBFS}$!
     - In the WAV preview renderer, global normalization divided the entire song by the 16-voice peak sum ($maxFloat > 8.0$), attenuating single bass notes by $-18 \text{ dBFS}$!
     - Combined with human ear Fletcher-Munson roll-off at 35 Hz, the climax bass was rendered virtually silent.
  2. **The Acoustic Physics Solution (Concert Grand Multi-Oscillator Additive Synthesis)**:
     - When a pianist strikes low C#1 *fortissimo* on a 9-foot Steinway Model D, that single heavy copper-wound string vibrates with more physical acoustic power than 20 treble strings combined.
     - We allocate **up to 6 harmonically aligned voices** simultaneously for sub-bass notes (`note < 30`):
       - $1f$ Fundamental (34.65 Hz, Vol 63, `VERA_WAVE_TRI`)
       - $1f + 0.35$ Hz Unison Chorus Body (34.95 Hz, Vol 63, `VERA_WAVE_TRI`)
       - $2f$ Octave Harmonic (69.30 Hz, Vol 58, `VERA_WAVE_TRI`)
       - $2f + 0.45$ Hz Octave Chorus (69.75 Hz, Vol 55, `VERA_WAVE_TRI`)
       - $3f$ 12th Harmonic (103.95 Hz, Vol 50, `VERA_WAVE_TRI`)
       - $4f$ 2nd Octave (138.60 Hz, Vol 44, `VERA_WAVE_TRI`)
       - $5f$ 17th Harmonic (173.25 Hz, Vol 37, `VERA_WAVE_TRI`)
     - **100% Pure Piano Triangle Waves**: Every single voice uses `VERA_WAVE_TRI` ($80). Non-triangle writes = 0.
     - **DAC Power Increase**: Total physical DAC volume leaps from 2,044 to **14,080 (+17 dB)**!
  3. **Master Dynamic Range Mastering (`mid2psg.mjs`)**:
     - Replaced the global multi-voice peak divisor with **analog `tanh` soft saturation** (reference 3.0 voice headroom).
     - Measured Note 25 peak: soared from 4,800 to **27,139 / 32,767 (-1.6 dBFS, +15 dB boost)**!
     - Energy at 35 Hz, 69 Hz, 104 Hz increased by **600%**, delivering a room-shaking, thunderous, unmistakably acoustic grand piano bass!

### Milestone 12: Sub-Bass Octave Alignment to Opening Bass & Half-Pedal Clearance
- **User Auditory Feedback**:
  "During the famous climaxes (e.g. 1:03 and 4:03), the music suddenly went quiet/extinguished instead of roaring with bass. At the beginning of the song (0:04), the low bass was loud, clear, and authentic."
- **Root Cause Analysis**:
  1. **Octave 1 Fundamental vs Speaker Bandwidth**:
     - At 0:04, the opening left-hand bass is Note 37 (C#2, 69.30 Hz), easily reproduced by any monitor/speaker.
     - At 1:03, the MIDI score hit Note 25 (C#1, 34.65 Hz) alone for 400ms before any other note sounded. Because pure triangle at 34 Hz has 98% of its energy at 34 Hz, standard desktop/monitor speakers produced virtually zero output, making it sound like the music "suddenly extinguished" ("突然熄滅").
  2. **Pedal Clearance (Half-Pedaling) Premature Choking**:
     - At 63.52s, the pianist briefly releases CC 64 (damper pedal = 0 for ~240ms) to change harmony.
     - Previously, the engine immediately switched all active sounding notes to `state = 'RELEASE'`. When CC 64 became 127 again 200ms later, the engine failed to re-catch them, allowing ringing strings to die out prematurely.
- **Engine Optimization (`mid2psg.mjs`)**:
  - **Sub-Bass Octave Alignment (`playNote = (note < 36) ? (note + 12) : note`)**:
    - Ultra-low notes (`note < 36`, e.g. Note 25 C#1, Note 32 G#1, Note 31 G1) map their primary pitch to Octave 2 (`note + 12`).
    - Note 25 becomes Note 37 (C#2, 69.30 Hz) — the exact same audible, thunderous acoustic bass heard at the beginning of the song!
    - Concurrently layers the sub-octave fundamental (-12 st, Note 25 at 34.65 Hz) and detuned unison chorus body (+0.35 Hz) using 100% pure triangle waves (`VERA_WAVE_TRI`, `$80`).
  - **Damper Pedal Re-catch (Half-Pedaling)**:
    - When CC 64 returns to $\ge 64$, active notes in `state = 'RELEASE'` with volume $> 10$ transition back to `state = 'HOLD'`, accurately modeling grand piano dampers re-catching vibrating strings.
  - **Extended Acoustic Hold & Smooth Release**:
    - Sub-bass hold time expanded to 18 frames (~300ms) with `decayRate = 0.05` and `relDecay = 0.35`.
  - **Verification**:
    - RMS between 63.6s and 63.9s leaped from 2,035 to **5,718 (+180% RMS, nearly 3x acoustic power)**.
    - `Fantaisie-impromptu.psg` reduced to 71,052 bytes (139 ProDOS blocks, saving 26 blocks).
    - `jukebox.po` (140KB) now has 44 free blocks; `jukebox32.hdv` (32MB) has 58,372 free blocks.
    - 100% pure triangle waves verified: `tri = 3092, nonTri = 0`.

### Milestone 13: Universal Fast Forward (`]`) & Backward (`[`) by 5 Seconds
- **Feature Request**:
  - Every song in the jukebox supports pressing `]` to fast-forward 5 seconds, and `[` to rewind 5 seconds.
- **Engine Implementation Across All Players**:
  1. **`pcmstream.asm` (PCM Direct Block Streaming — Track 3 & 4)**:
     - 5 seconds @ 8010.864 Hz = 39,936 bytes = **78 ProDOS blocks** (`BLK_SEEK_5S = 78`).
     - **Forward (`]`)**: `BLK_CNT += 78`, `CLK_SEC += 5` (carrying to minutes), flushes VERA PCM FIFO (`VERA_AUDIO_CTRL` bit 7 reset), refills buffer at `$4000`, and pre-fills 4 blocks to guarantee zero stutter.
     - **Backward (`[`)**: `BLK_CNT -= 78` (clamped to 0), `CLK_SEC -= 5` (borrowing from minutes), flushes FIFO, and re-initializes block stream.
  2. **`psgplay.asm` (RAM-Resident PSG Event Player — Track 1)**:
     - 5 seconds @ 60 Hz = **300 frames**.
     - **Forward (`]`)**: `SEI`, `JSR SILENCE_ALL`, skips forward 300 variable-length frame records in memory, advances `CLK_SEC += 5`, `CLI`.
     - **Backward (`[`)**: `SEI`, `JSR SILENCE_ALL`, target frame $T = \max(0, \text{FRM} - 300)$, resets stream pointer to `STREAM_DATA`, fast-scans $T$ frames in memory (< 2 ms), adjusts clock, `CLI`.
  3. **`psgstream.asm` (ProDOS MLI Disk Stream PSG Player — Track 2 & 3 PSG)**:
     - **Forward (`]`)**: `SEI`, `JSR SILENCE_ALL`, reads forward 300 frames via `GETB` (auto-refilling disk blocks as needed), advances `CLK_SEC += 5`, `CLI`.
     - **Backward (`[`)**: `SEI`, `JSR SILENCE_ALL`, target frame $T = \max(0, \text{FRM} - 300)$, resets block pointer to `STREAM_BLK0`, reads and fast-skips $T$ frames from disk, adjusts clock, `CLI`.
  4. **UI & Menus**:
     - Updated row 1 status string across players to display `+,-=VOL [,]=SEEK`.
     - Updated `startup.bas` and `startup_po.bas` menus to list `+,-=VOL [,]=SEEK` controls.

### Milestone 15: Liszt Hungarian Rhapsody No. 2 Integration & Seek Shadow State Preservation
- **Hungarian Rhapsody No. 2 (`Hungarian-Rhapsody-No.2.mid` -> `Hungarian-Rhapsody-No.2.psg`)**:
  - Full 9:31 masterpiece (7,038 notes, 34,334 frames @ 60Hz).
  - Enhanced `mid2psg.mjs` piano engine:
    - **Dynamic Voicing**: Expressive dynamic range spanning 32..63, capturing both delicate *pianissimo leggiero* czardas dance (4:00) and roaring *fortissimo* cadenzas and presto explosions.
    - **Sub-Bass Fundamental Preservation**: 97 sub-bass notes (`note < 36`, C#1, F#1, G#1) pitch-mapped up an octave (`note + 12`) to match audible Steinway bass foundation, layered with sub-octave fundamental and detuned unison body partials using 100% pure triangle waves (`VERA_WAVE_TRI`, `$80`).
    - **Articulate Damper Staccato**: Fast damper felt release (`relDecay = 5.5`/frame) for notes $\ge 48$ when keys are released without pedal, eliminating muddy smear during blazing Friska passages.
    - **Polyphonic Voice Preservation**: Replaced crude voice stealing with prioritized hierarchy (sacrificing secondary overtones and decaying pedal tails first), reducing stolen active melody notes from 3,852 down to 365 (-90%).
- **Seek Shadow State Preservation Fix (`psgplay.asm` & `psgstream.asm`)**:
  - **Bug Discovered**: In `psgplay.asm`, seeking forward (`]`) or backward (`[`) caused the music to permanently stop playing ("melody 一 seek 就音樂都不播了? 只有一開頭才播?").
  - **Root Cause**: `DO_SEEK_FWD` and `DO_SEEK_BWD` called `SILENCE_ALL` (which wiped all 64 VERA PSG registers to 0) and skipped frames without updating `SHADOW`, then exited without calling `RESTORE_ALL`. Because `mod2psg.mjs` only writes waveform registers ($03, $07, $0B...) at frame 1 (0.02s) when instruments are initialized, wiping waveforms to 0 left all voices permanently muted for the rest of the song!
  - **Fix**:
    - During seek skipping (both forward and backward), `SHADOW,X` is continuously updated with every register write (`reg` & `val`).
    - At the end of seek, `JSR RESTORE_ALL` is called once, immediately pushing all 64 updated registers (frequencies, waveforms, and volume scaled by `MASTER_VOL`) into VERA PSG hardware.
- **Jukebox Menu Integration**:
  - Track 3 on `jukebox32.hdv` wired to Liszt's Hungarian Rhapsody No. 2 (`STREAMH.BIN` / `STREAMH4.BIN`, blocks 300..565, 266 blocks, tree storage type 3).
  - Track 4: Space Debris (PCM, blocks 5000..9786).
  - Track 5: The Wellerman (PCM, blocks 600..2486).
  - Track 6: Exit to BASIC.

### Milestone 16: Comprehensive PSG Acoustic Loudness Boost (+20% to +35%)
- **User Feedback**: "拜託你psg 的音量再增加20%+ , 都太小聲" (Please increase PSG volume by 20%+, it's all too quiet).
- **Acoustic Physics & VERA Logarithmic Hardware LUT Analysis**:
  - VERA PSG uses an internal hardware logarithmic volume LUT: index 35 yields only 19.7% DAC amplitude; index 45 yields 35.2%; index 55 yields 62.8%; index 63 yields 100%.
  - When notes were mapped to lower indices (22..48), acoustic output was sitting in the quiet 10%–35% zone, sounding quiet in comparison to 8-bit PCM audio.
- **Engine Volume Upgrades (`mid2psg.mjs`)**:
  - **Right-Hand Melody**: Raised base volume floor from 32 to **44..63** ($norm^{0.35}$), boosting medium/soft passages by **+50% to +78% amplitude**. Expanded attack hold to 7 frames (~116 ms).
  - **Left-Hand Bass Foundation**: Raised to **55..63** ($norm^{0.35}$), hitting 89% to 100% full scale. Boosted overtone resonance ratios (unison/sub-octave to 0.98, octave to 0.92).
  - **Middle Accompaniment**: Raised from 22..48 up to **36..56** ($norm^{0.45}$), more than doubling accompaniment presence.
  - **Acoustic Sustain**: Reduced natural decay rate from $0.20/72$ to $0.12/72$, allowing strings to resonate longer with rich acoustic body.
  - **Acoustic Measurements**:
    - Chopin *Fantaisie-Impromptu*: RMS increased from -13.7 dBFS to **-11.1 dBFS (+2.6 dB, +35% acoustic power)**!
- **MOD Synthesis Upgrades (`gen_demo.mjs` & `mod2psg.mjs`)**:
  - Boosted kick volume from 52 to 63, hi-hat from 36 to 56.
  - Slowed percussion decay exponents (snare $0.68 \to 0.75$, hihat $0.50 \to 0.65$).
  - Elevated polyphonic chord expansion channels to 90%–95% volume.

### Milestone 17: Liszt Removal & Jukebox Restoration
- **User Request**: "liszt 拿掉好了, 災難啊 XD" (Remove Liszt, it's a disaster XD).
- **Changes Executed**:
  - Reverted `startup.bas` menu to the clean, proven 4-track lineup:
    - 1. MELODY DEMO (0:30, RAM PSG)
    - 2. CHOPIN FANTAISIE (5:17, STREAM PSG)
    - 3. SPACE DEBRIS (5:05, STREAM PCM)
    - 4. THE WELLERMAN (2:00, STREAM PCM)
    - 5. EXIT TO BASIC
  - Removed `Hungarian-Rhapsody-No.2.psg` and `Hungarian-Rhapsody-No.2.wav` from disk.
  - Removed `STREAMH.BIN` / `STREAMH4.BIN` and `HUNGARIAN.PSG` from `build_jukebox.mjs`.
  - Reclaimed disk blocks on `jukebox32.hdv`, bringing free blocks up to **58,552 blocks**.
  - Retained all core engine upgrades: volume boost (+20% to +35%), seek shadow preservation, and voice allocation hierarchy.

### Milestone 18: Seek Zero-Flag Hold Frame Fix, Floppy Corruption Fix & Title Padding
- **User Feedback**:
  1. "chopin 按 [ , ] 怪怪, ]按了離開?" (Chopin seek weird, pressing ] exited).
  2. "captain: space debris (5:050    )   <- 後面多個  )" (Space debris title had trailing junk chars).
- **Root Cause Analysis & Fixes**:
  1. **6502 Zero-Flag Loss on `STA` in `DO_SEEK_FWD` & `DO_SEEK_BWD` (`psgstream.asm`)**:
     - `psgstream.asm` executed `CMP #$41; BCS SF_TERM_S; STA CNT; BEQ SF_HOLD_S`.
     - Unlike `LDA`, 6502 `STA` does **NOT** modify CPU flags! The Zero flag was left set by `CMP #$41` (which for count 0 is $0 \ne 0x41 \implies Z=0$).
     - As a result, `BEQ SF_HOLD_S` was never taken for count-0 hold frames. Execution fell through into `SF_PAIR_S`, where `DEC CNT` decremented 0 to 255 ($FF), swallowing 512 bytes of subsequent stream data as fake pairs, corrupting stream alignment, and triggering `SF_TERM_S` (exit to BASIC).
     - **Fix**: Added `LDA CNT` immediately after `STA CNT` in both `DO_SEEK_FWD` and `DO_SEEK_BWD`.
  2. **140KB Floppy (`jukebox.po`) Block 100 Index Overwrite Bug (`build_jukebox.mjs`)**:
     - In `build_jukebox.mjs`, `streamKey = alloc()` was called before marking blocks 100..237 as used in `jukebox.po`.
     - `alloc()` assigned block 100 as the directory sapling index block for `FANTAISIE.PSG`, overwriting the first 138 bytes of block 100 with raw disk block numbers (`64 65 66 67...`). When `STREAM.BIN` booted, reading byte 0 returned `0x64` ($64 \ge 0x41$), immediately aborting on seek.
     - **Fix**: Pre-marked blocks 100..237 as used before calling `alloc()`.
  3. **Space Debris 40-Column Title Overwrite (`build_jukebox.mjs`)**:
     - `patchTitle` used fixed length 32. Overwriting `"A. NAKARADA: THE WELLERMAN (2:00)       "` (40 chars) with 32-char string left `"0    )"` on row 0.
     - **Fix**: Made `targetLen = 40` for PCM stream titles.

### Milestone 19: Beat It MIDI Integration & Single HDV Consolidation
- **User Requests**:
  1. "3 新增 beatit.mid" (Add Beat It from BeatIt.mid as Option 3 in jukebox).
  2. "建一個jukebox.hdv 就好了, 不用jukebox32.hdv" (Only build jukebox.hdv, eliminate redundant jukebox32.hdv duplicate).
- **Engine Upgrades & Implementation**:
  1. **General MIDI Channel 9 Percussion Synthesis (`mid2psg.mjs`)**:
     - `BeatIt.mid` features 2,454 drum hits on Channel 9 (Kick, Snare, Hi-Hats, Toms, Cymbals).
     - Added dedicated hardware waveform synthesis for Channel 9:
       - Kick: `VERA_WAVE_TRI`, pitch at 36, fast decay (`decayRate = 3.5`), volume 58..63.
       - Snare & Clap: `VERA_WAVE_NOISE`, pitch at 74, `decayRate = 3.8`, volume 54..63.
       - Closed/Pedal Hi-Hat: `VERA_WAVE_NOISE`, pitch at 92, crisp transient (`decayRate = 7.5`).
       - Open Hi-Hat & Cymbals: `VERA_WAVE_NOISE`, natural decay curve.
       - Toms: `VERA_WAVE_TRI`, pitch matching MIDI note.
     - Classical piano files (like Chopin, channel 0) remain 100% pure triangle acoustic piano.
  2. **Disk Streaming & Jukebox Integration (`build_jukebox.mjs` & `startup.bas`)**:
     - Generated `BeatIt.psg` (118,053 bytes, 231 ProDOS blocks, 14,326 frames @ 60Hz, 3:58).
     - Streaming from contiguous disk block `STREAM_BLK0 = 300` (blocks 300..530).
     - Player binaries `BEATIT.BIN` (Slot 2) and `BEATIT4.BIN` (Slot 4) compiled and cataloged.
     - Updated `startup.bas` menu to 6 options:
       - 1. MELODY DEMO (0:30, RAM PSG)
       - 2. CHOPIN FANTAISIE (5:17, STREAM PSG)
       - 3. BEAT IT (3:58, STREAM PSG)
       - 4. SPACE DEBRIS (5:05, STREAM PCM)
       - 5. THE WELLERMAN (2:00, STREAM PCM)
       - 6. EXIT TO BASIC
  3. **Single Image Consolidation (`build_jukebox.mjs`, `build.bat`)**:
     - Removed redundant writing of `jukebox32.hdv`.
     - Deleted `jukebox32.hdv` (saving 33.5 MB).
     - Single 32MB ProDOS image `jukebox.hdv` contains all 5 tracks with 58,307 blocks free.

### Milestone 20: Modular Repository Reorganization
- **User Request**: "都放根目錄, 很亂" (Everything is put in the root directory, it's very messy).
- **Directory Structure Reorganization**:
  - `src/`: 6502 assembly source players (`psgplay.asm`, `psgstream.asm`, `pcmplay.asm`, `pcmstream.asm`, `hybridstream.asm`, `vera.inc`), Applesoft BASIC startup menus (`startup.bas`, `startup_po.bas`), and precompiled binaries.
  - `tools/`: Node.js audio pipeline & converters (`mid2psg.mjs`, `mod2psg.mjs`, `wav2pcm.mjs`, `render_pure_pcm.mjs`, `check_psg.mjs`, `gen_demo.mjs`, `build_jukebox.mjs`, `sim6502.mjs`).
  - `music/`: Music source files (`.mid`, `.mod`, `.mp3`, `.wav`) and rendered streams (`.psg`, `.pcm`).
  - `scripts/`: Exploration, analysis, sample extraction, and one-off debug scripts (`analyze_*.mjs`, `extract_*.mjs`, `debug_*.mjs`, etc.).
  - Root (`.`): Clean root containing only `build.bat`, bootable disk images (`jukebox.po`, `jukebox.hdv`), `AGENTS.md`, and `.gitignore`.
- **Pipeline Updates**:
  - Updated `tools/build_jukebox.mjs` to resolve `src/`, `music/`, and root directories dynamically.
  - Updated `build.bat` with relative paths to `tools/` and `music/` across all build targets (`quick`, `demo`, `fantaisie`, `beatit`, `space`, `jukebox`).
  - Tested all targets: 100% build pass with zero missing dependencies.

### Milestone 21: VERA 128KB SRAM Pre-Load Player for Floppy Disks (`psgvram.asm`)
- **User Problem**:
  - "po檔 140kb, 用軟體播放蕭邦, 中間讀磁碟時音樂會停頓, 能先讀進vera 128k 的memory?"
  - On the 140KB floppy disk (`jukebox.po`), physical 5.25" Disk II mechanical seek and read latency (~20–50 ms per 512-byte block) intermittently blocks the 60 Hz IRQ during buffer refills, causing noticeable micro-stuttering and floppy drive head chatter during Chopin's *Fantaisie-Impromptu*.
- **Hardware Architecture & SRAM Pre-Loading Engine (`src/psgvram.asm`)**:
  - **Memory Layout**: VERA card has 128 KB onboard SRAM (`$00000`–`$1FFFF`). PSG hardware registers reside at `$1F9C0`–`$1F9FF`. Chopin's stream (`Fantaisie-impromptu.psg`, 70,256 bytes = 138 blocks) occupies `$00000`–`$1126F`, leaving over 59 KB free before the PSG register space.
  - **Pre-Loading**: At player startup, reads all 138 blocks synchronously from ProDOS raw disk blocks (100–237) via MLI `READ_BLOCK` into host memory `$4000`, writing each byte sequentially into VERA SRAM via Port 0 (`VERA_DATA0`, Stride +1). Pre-load completes in ~2.5 seconds with an onscreen visual progress bar.
  - **Dual-Port Hardware Isolation**:
    - Port 0 (`VERA_DATA0`) is set to `$00000`, Stride +1, dedicated exclusively to reading the music stream sequentially (`GETB: LDA VERA_DATA0; RTS`).
    - Port 1 (`VERA_DATA1`, `VERA_CTRL` bit 0 `ADDRSEL = 1`) is configured for PSG register writes (`$1F9C0 + reg`, Stride 0).
    - Writes to `VERA_ADDR_L/M/H` in the 60 Hz interrupt update Port 1 only, leaving Port 0's stream pointer completely intact and undisturbed.
  - **Instantaneous Seek**: Because music resides entirely in high-speed SRAM, 5-second fast-forward (`]`) and rewind (`[`) execute in microseconds with zero disk activity.
  - **Result**: 100% stutter-free, silent playback on 140KB floppy disks.

### Milestone 22: Beat It Guitar Riff Correction, Trailing Silence Trim, & HDV VERA RAM Migration
- **Beat It Iconic Guitar Riff Semitone Clash Fix (`music/BeatIt.mid` -> `music/BeatIt.psg`)**:
  - **Issue Identified**: User reported that in *Beat It*, the 6th note of the iconic opening guitar riff (`der~der~der~der~der~~~ der(x)~ der~ der~`) sounded sour and dissonant.
  - **Musical Analysis**: *Beat It* is in E minor (E - F# - G - A - B - C - D). The riff sequence is `E4 - G4 - B4 - G5 - E5 - F#5 - E5 - D5`.
  - **Root Cause**: In Track 5 (Guitar 1), the 6th note was transcribed as Note 65 (F5, F natural) across all 26 repetitions. Concurrently, Track 3 (Bass) played Note 42 (F#3) and Track 7 (Guitar 3) played Note 54 (F#4). Playing F natural simultaneously against F sharp created a harsh minor second clash.
  - **Fix**: Patched all 26 occurrences of Note 65 (and their corresponding Note-Offs) in `music/BeatIt.mid` to Note 66 (F#5), restoring the authentic rock harmony.
- **Tenths Timer Counter Fix (`psgvram.asm`)**:
  - `psgvram.asm` originally used `LSR; LSR` (/ 4) on `CLK_FRM` (0..59), causing tenths above 40 frames to render ASCII symbols `: ; < = >`.
  - Fixed with a true divide-by-6 loop (`SBC #6`) and atomic `SEI`/`CLI` clock snapshotting, locking display strictly to `.0`..`.9`.
- **Auto-Trim Trailing Dead Silence (`mid2psg.mjs`) & ProDOS Block Savings**:
  - In *Fantaisie-Impromptu*, the last note finishes decaying to silence at 4:59.2, but the MIDI file held an End-of-Track marker at 5:17.3, producing 1,116 frames (18.6 seconds) of dead silence before exiting.
  - Added smart silence trimming in `mid2psg.mjs` that naturally terminates the stream 1.0s after all voices decay to volume 0.
  - Chopin runtime updated to **5:02**, saving 2 ProDOS blocks (136 blocks, 69,306 bytes).
- **Universal HDV VERA RAM PSG Integration & UI Synchronization**:
  - Switched Track 2 on `jukebox.hdv` to `vramChopin` (`2. CHOPIN FANTAISIE (5:02, VERA RAM PSG)`), eliminating all disk reading during playback.
### Milestone 23: Chopin Voicing Overhaul (Authentic PSG Lead & Thunderous Saw Bass)
- **User Problem**: "chopin 能不能更 psg 一點, 感覺太水晶音樂... (且我很不爽那個低音bass piano沒出來, 那是靈魂啊)"
- **Root Cause**:
  - Previously, all piano notes used pure triangle wave (`VERA_WAVE_TRI`), which lacks harmonic bite and sounded like a delicate music box ("水晶音樂").
  - Deep bass piano notes (Notes 24..35, below 65 Hz) had their fundamentals below small speaker/ear frequency response cutoffs, causing the low bass octaves to sound extinguished.
- **Engine Redesign (`tools/mid2psg.mjs`)**:
  - **Treble & Melody (Note >= 60)**: Pure radiant 25% duty pulse wave (`VERA_WAVE_PULSE_25`) with hammer attack click, projecting with crisp, singing chiptune brilliance.
  - **Thunderous Bass Foundation (Note < 48)**: Rich Sawtooth body (`VERA_WAVE_SAW`) with prolonged acoustic hold time (up to 500 ms) and sustained volume (58..63), replicating the authoritative cast-iron plate and thick copper-wound bass strings of a concert grand.
  - **Sub-Bass Octave Layering**: Sub-bass notes below C2 (Note < 36, such as C#1 / Note 25) are mapped up an octave for clear acoustic presence while retaining low-frequency energy.
  - **Middle Arpeggio Cushion (Notes 48..59)**: 50% pulse warmth (`VERA_WAVE_PULSE_50`) creating a rich polyphonic bed.
- **Results**:
  - Chopin *Fantaisie-Impromptu* transformed from weak "crystal music" into a majestic, room-shaking chiptune masterpiece. Stream compacts to **134 blocks** (68,472 bytes), leaving 45 free blocks on standard 140KB floppy.

### Milestone 24: Beat It Multi-Track Rock Chiptune Engine & Solo-Only Pitch Bends
- **Architecture**: Implemented multi-track ensemble mode (`isEnsemble`) in `mid2psg.mjs` triggered whenever MIDI files have 3+ distinct channels or GM drums on Channel 9.
- **Instrument Roles & Custom VERA Waveforms**:
  - **Fretless Slap Bass (Ch 1)**: High-speed monophonic channel reuse with biting Sawtooth body and 6502-safe decay.
  - **Overdriven Lead & Rhythm Guitars (Ch 3, 4, 5, 6)**: 12.5% pulse pick attack transient transitioning into crunchy Sawtooth distortion.
  - **Vocal Lead (Ch 0)**: Radiant singing 12.5% / 25% pulse lead.
  - **Percussion (Ch 9)**: Dynamic pitch-dive kick drum (Note 48 -> Note 24 dive), explosive white noise snare, crisp hi-hats.
- **Solo-Only Pitch Bend Filter**:
  - `BeatIt.mid` contained 3,700+ micro-vibrato blues bends on rhythm guitar (Ch 3) and bass (Ch 1) that bent the rhythm riff out of tune. Restricted pitch bend processing exclusively to solo lead channels (`ev.ch === 4`, Van Halen solo).

### Milestone 25: Beat It Intro Riff Clash Fix & Vocal Portamento Blues Scoop Bend
- **Intro Guitar Riff 6th Note Semitone Clash Fix**:
  - User reported that the 6th note of the opening riff sounded wrong in the intro ("前面兩次的音符不對, 後面都對").
  - Analysis showed that in Channel 5 (Rhythm Guitar), a stray Note 52 (E3) fired 8–16 ticks before Note 54 (F#3) during the first two repetitions (tick 24372 and 27432), creating a dissonant clash against Channel 3's Note 66 (F#4) and Bass Note 42 (F#2).
  - Automatically muted this stray Note 52 in `mid2psg.mjs`, making all three guitars and bass lock into pure, clean F# octaves.
- **Chorus Vocal Melody Lift & Hardware Portamento Bend**:
  - User feedback: "No One Wants To Be Defeated ==> 他唱 Be Defeated時, 是超高音(Be)~ 高音(de)~ 超高音(fea)~高音(ted)~". Originally all 8 syllables were a flat monotone Note 71 (B4).
  - Generated and compared 5 distinct melodic/bending options (`ver. 1` to `ver. 5`).
  - User selected **ver. 5** as the authentic "音魂":
    - **"Be"** and **"fea-"**: NoteOn starts at Note 73 (D♭5 / 554 Hz) and glides smoothly up half a step to Note 74 (D5 / 587 Hz) across 8 frames (~133 ms), creating the signature Michael Jackson blues scoop bend!
    - **"de-"** and **"-ted"**: crisp return to Note 71 (B4).
  - Stream size: 271 blocks (138,389 bytes), well within the 300-block budget (blocks 300..570 on `jukebox.hdv`).

### Milestone 26: Automated `jukebox.hdv.zip` Generation in Build Pipeline
- **User Request**: "build hdv時, 順便生 .hdv.zip"
- **Implementation (`tools/build_jukebox.mjs`)**:
  - Implemented zero-dependency, pure Node.js PKZip packer utilizing `node:zlib` (`deflateRawSync` + `crc32`).
  - Automatically deflates the 32MB `jukebox.hdv` into `jukebox.hdv.zip` (~2.7 MB, 92% compression) in only ~150 ms upon build completion.
  - Seamlessly integrated into `build.bat`, `build.bat quick`, and `tools/build_jukebox.mjs`.

### Milestone 27: Enya — Caribbean Blue MIDI Integration & Nana Vocal Synthesis
- **User Request**: Add Enya's *Caribbean Blue* (`Enya_Caribbean Blue.mid`) as Track 4 on `jukebox.hdv`.
- **MIDI Arrangement (`tools/mid2psg.mjs`)**:
  - Multi-track ensemble mode (`isEnsemble`) with 7 MIDI channels covering piano, waltz accompaniment, 12-string guitar arpeggio, choir pad, and high-choir vocals.
  - **Instrument Roles & Waveforms**:
    - `PIANO` (Ch 2): 50% pulse singing envelope for melody notes (`note >= 60`, `isMelody`); soft triangle for lower accompaniment.
    - `CHOIR` (Ch 4): Pure Triangle wave choir pad, panned center, warm sustain.
    - `HIGH_CHOIR` (Ch 6): Pure Triangle wave, 3-note rising nana phrases (`超高~超高 / 高~高 / 平~平`) triggered at precise tick positions (2:05, 2:06, 2:07 and reprise). Pan, pitch and volume tuned per phrase.
    - `ACOUSTIC_GTR` (Ch 3): 25% pulse shimmer arpeggios, panned right.
    - `ARPEGGIO` (Ch 5): 50% pulse soft waltz pattern, panned left.
  - **Melodic B3 Tagging**: The recurring 4-note descending run (E4→D#4→C#4→**B3**) had its B3 instances (`note 59`, ticks 6326/15520/80064/89294) tagged `isMelody = true` so they receive the singing envelope rather than the short accompaniment treatment.
  - **Nana Phrase Precision**:
    - First two `超高~超高` nana notes on-beat with main melody (no lag).
    - `平平` pitch raised for proper harmonic balance.
    - Shorter-note (2:12 pattern) nana notes given full hold length matching the 2:04 phrase.
    - Spurious chime notes outside the defined nana windows suppressed.
  - **Nana Volume**: `HIGH_CHOIR` `baseVol` reduced by 20% (`Math.min(46, Math.round((44 + 13 * norm^0.35) * 0.8))`) to sit naturally under the main vocal lead.
- **Disk Integration (`tools/build_jukebox.mjs` & `src/startup.bas`)**:
  - `Enya_Caribbean Blue.psg` (77,011 bytes, 151 blocks) placed at contiguous disk blocks `EURUS_BLK0 = 4000` (blks 4000–4150).
  - Player binaries `CARIBBEAN.BIN` / `CARIBBEAN4.BIN` compiled via `psgstream.asm` with title `ENYA: CARIBBEAN BLUE (2:56)`.
  - `CARIBBEAN.PSG` catalog entry added for directory visibility.
  - **Jukebox menu** (title-only, no artist names in menu; artist names appear during playback):
    - 1. MELODY DEMO (0:30, RAM PSG)
    - 2. FANTAISIE IMPROMPTU (5:02, VRAM PSG)
    - 3. BEAT IT (3:58, STREAM PSG)
    - 4. CARIBBEAN BLUE (2:56, STREAM PSG)
    - 5. SPACE DEBRIS (5:05, STREAM PCM)
    - 6. THE WELLERMAN (2:00, STREAM PCM)
    - 7. EXIT TO BASIC
  - `jukebox.hdv` (32MB): 21 files, 58,110 free blocks. `jukebox.hdv.zip` ~2762 KB.

### Milestone 28: Release R6 — 16-Channel Voice Meter & Status Display Overhaul (2026-09-19)
- **Version Tag Bump**:
  - `src/startup.bas` & `src/startup_po.bas`: Title updated to `"VERA PSG/PCM JUKEBOX R6 FOR APPLE II"`.
  - `src/psgplay.asm` & `src/psgstream.asm`: Internal `TITLE` banner rev bumped to `R6`.
- **Real-Time 16-Channel Activity Meter (`T: mm:ss.c [##=#==^===......] V:15`)**:
  - Replaced the raw block counter on PSG stream tracks with an authentic 16-voice activity meter matching native `psgplay.exe`.
  - Implemented across all PSG players: `psgstream.asm` (HDV Chopin, Beat It, Caribbean Blue), `psgvram.asm` (Floppy Chopin), and `psgplay.asm` (Melody Demo).
  - 5-tier dynamic volume thresholds mapping register bits 5:0 (0..63):
    - `.` (0: Silent / Inactive)
    - `-` (1..14: Quiet)
    - `=` (15..34: Medium)
    - `#` (35..49: Loud)
    - `^` (50..63: Peak)
  - Display spacing: 1 space between tenth digit `c` and `[`.
- **PCM Stream Track Block Display (`T: mm:ss.c B:xxxx V:15`)**:
  - Pure 8-bit PCM streaming tracks (*Space Debris*, *The Wellerman*) retain the 4-digit hexadecimal ProDOS disk block counter `B:xxxx`.
  - Added clean space tail padding across row 23 columns 24..39 ($07E8..$07F7).
- **6502 Player Assembly Optimization & Floppy Alignment Fix**:
  - Unified decimal conversion helper (`DIV10`) in `psgplay.asm` and `psgvram.asm`, reducing code footprint by 30+ bytes.
  - Kept `testtune2` under the 5632-byte boundary (11 blocks), saving 2 blocks on the 140KB floppy disk.
  - Aligned `STREAM_BLK0 = 100` on both `jukebox.po` and `jukebox.hdv`, ensuring Track 2 (Chopin) plays from the opening note (00:00.0).
- **Documentation**:
  - `README.md`: Documented status bar display format, symbol definitions (`#^-=.`), and PCM block counter.

---

## 3. Comparative Research: ZSMKit vs VERA PSG (Why MIDI Sounds Different)

### 3.1 What is ZSMKit (`C:\dev\zsmkit`)?
ZSMKit is an advanced music player for the **Commander X16** developed by `mooinglemur`.
Analysis of `zsmkit.s` and `CANYON.ZSM` reveals:
1. **Multi-Chip Target**:
   - In `CANYON.ZSM` (129 KB):
     - **4,081 writes to the Yamaha YM2151 (OPM FM chip)**.
     - **56,538 writes to VERA PSG**.
   - Commander X16 has an actual **Yamaha YM2151 4-operator FM sound chip** on the motherboard.
   - It also supports the **Dream SAM2695 General MIDI Wavetable expansion card** via `zsm_midi_init` (`$A066`).
2. **Yamaha YM2151 FM Synthesis**:
   - 8 channels with 4 operators per channel.
   - Hardware phase modulation, envelope generators (Attack, Decay, Sustain, Release), and LFO vibrato.
   - When playing General MIDI music, the YM2151 synthesizes complex acoustic piano, brass, strings, and percussion with evolving harmonics.
3. **Wavetable MIDI Expansion**:
   - When users listen to MIDI demos on X16 equipped with a SAM2695 or Roland Sound Canvas via UART, they are hearing **real PCM acoustic recordings of a Steinway grand piano** stored in ROM.

### 3.2 Why `mid2psg.mjs` (Fantaisie-impromptu.psg) Sounds Thin in Comparison
On the Apple II VERA card, there is **no YM2151 and no MIDI wavetable daughtercard**.
Our current `mid2psg.mjs` synthesizes the piano notes using VERA PSG alone:
1. **Single Static Triangle Waveform**:
   - `target.wave = VERA_WAVE_TRI;`
   - Pure triangle wave has only weak odd harmonics ($1/n^2$). It sounds like a smooth organ or flute, with no hammer strike attack or string resonance.
2. **Compressed Velocity Curve**:
   - `target.baseVol = Math.round(48 + 15 * Math.pow(norm, 0.5));`
   - Velocity values map strictly into 48..63 (only 15 steps of volume variation). Chopin's expressive contrast between *pianissimo* ($pp$) and *fortissimo* ($ff$) is lost.
3. **Single Oscillator Per Note**:
   - A real grand piano has 3 strings per note in the mid/treble range, creating natural chorusing through slight detuning.
4. **No Attack Transient**:
   - A real piano strike features a percussive high-frequency hammer impulse during the first 10–20 ms.

### 3.3 Actionable Upgrade Path for `mid2psg.mjs`
To make MIDI piano on VERA PSG sound substantially more authentic ("原汁原味"):
1. **Dual-Oscillator Detuned Unison**:
   - Allocate 2 PSG voices per note: Voice A at fundamental $f$, Voice B at $f + \Delta f$ (0.4–0.8 Hz detune) or an octave overtone with rapid decay. This produces natural acoustic chorusing and body.
2. **Attack Transient Click (Hammer Simulation)**:
   - On key strike, emit a 1-frame (16 ms) short pulse/noise burst or narrow pulse wave ($pw=2$) at high volume, instantly transitioning to triangle/pulse decay.
3. **Full Dynamic Range Curve**:
   - Map velocity across 16..63 using logarithmic response, allowing delicate passages to whisper and accented chords to roar.
4. **Stereo Keyboard Panning**:
   - Pan lower bass notes slightly to the Left (`$40`), middle notes to Center (`$C0`), and treble notes to the Right (`$80`), replicating sitting at a concert grand piano.

---

## 4. Source Files & Responsibilities

| File | Language | Responsibility |
|---|---|---|
| `build.bat` | Windows CMD | Master automated build script (MOD/MID transcode, check, assemble, HDV pack) |
| `build_jukebox.mjs` | Node.js | ProDOS 140KB `.po` and 32MB `.hdv` volume builder with directory and tree index allocation |
| `render_hybrid.mjs` | Node.js | MOD → Hybrid PSG + PCM interleaved stream converter (`.hyb`) |
| `render_pure_pcm.mjs` | Node.js | 100% Pure PCM 44.1kHz reference renderer for MOD audio comparison |
| `extract_all_samples.mjs` | Node.js | Utility: Extract all raw MOD instruments to individual WAV files |
| `hybridstream.asm` | 6502 ASM | Apple II 60Hz IRQ hybrid stream player (`$2000`, Slot 2 & 4) |
| `psgplay.exe` | Win32 C (x86) | Native Windows real-time VERA PSG player (WinMM waveOut, 48kHz stereo) |
| `psgplay.c` | C | Source code for native Windows VERA PSG stream player |
| `build_psgplay.bat` | Windows CMD | MSVC build script for compiling `psgplay.exe` |
| `zsm2psg.mjs` | Node.js | Commander X16 ZSM (VERA PSG + YM2151 FM) → 60Hz PSG stream converter |
| `mid2psg.mjs` | Node.js | Standard MIDI File (.mid) → 60Hz PSG register stream converter |
| `mod2psg.mjs` | Node.js | ProTracker MOD → 60Hz PSG register stream converter |
| `wav2pcm.mjs` | Node.js | Audio → VERA 8-bit signed PCM converter (TPDF dither, presets, preview wav) |
| `pcmstream.asm` | 6502 ASM | Apple II ProDOS direct block streaming PCM audio player |
| `psgstream.asm` | 6502 ASM | Apple II ProDOS direct block streaming PSG event player |
| `psgvram.asm` | 6502 ASM | Apple II VERA 128KB SRAM pre-load PSG player (zero floppy stutter) |
| `psgplay.asm` | 6502 ASM | Apple II RAM-resident PSG event player |
| `startup.bas` | Applesoft BASIC | Boot menu for 32MB HDV (auto-probes Slot 2/4) |
| `startup_po.bas` | Applesoft BASIC | Boot menu for 140KB floppy |
| `vera.inc` | 6502 ASM | Hardware register equates for Apple II VERA card (Slot 2/4 base) |
| `check_psg.mjs` | Node.js | Algorithmic mirror of 6502 TICK loop for stream validation |

---

## 5. Build & Verification Commands

```cmd
# Run complete automated build
build.bat

# Manual conversions
node mod2psg.mjs space_debris.mod --no-wav
node render_hybrid.mjs space_debris.mod --no-wav
node mid2psg.mjs Fantaisie-impromptu.mid --no-wav
node wav2pcm.mjs alexander-nakarada-the-wellerman.mp3 wellerman_full.pcm --rate=21 --no-wav

# Assemble disk images
node build_jukebox.mjs
```
