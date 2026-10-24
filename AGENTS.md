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
- **YM2151 FM Synthesizer (emulated in AppleWin fork only)**:
  - The Commander X16 has a Yamaha YM2151 (OPM) chip on board; the **physical Apple II VERA card has NO YM2151**.
  - The **AppleWin VERA fork** (`anomixer/AppleWin`) emulates the YM2151 with the **ymfm** synthesis core (`source\ymfm\`, registers at slot base + `$20`/`$21`, e.g. `$C220`/`$C221` on Slot 2), so ZSM music with FM plays back in the emulator.
  - `tools/melodius.exe` renders the same YM2151 + VERA PSG + VERA PCM mix natively on Windows for auditioning `.zsm` and `.zcm` files (originally `tools/zsmplay.exe`, see Milestones 30 and 34).

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

### Milestone 29: Native Windows Player (`psgplay.exe`) Polyphonic Mix Headroom Overhaul (2026-09-30)
- **User Problem**: Chopin *Fantaisie-Impromptu* sounded crisp and elegant inside `jukebox.hdv` (AppleWin), but sounded harsh, distorted, and unpleasantly crushed ("撕心裂肺") when played in the native Windows player `tools/psgplay.exe`.
- **Root Cause Analysis (`tools/psgplay.c`)**:
  - `psgplay.c` originally normalized the combined voice sum with a fixed divisor of 3 before feeding into `tanhf()` soft-saturation (`tanhf(mix / 3.0f)`).
  - While adequate for monophonic or 2-to-3-voice tracks, polyphonic piano tracks like Chopin (*Fantaisie-Impromptu*) frequently have 8–12 voices actively sounding simultaneously during arpeggios with pedal sustain.
  - When the summed voice amplitude reached 8.0–10.0, dividing by 3 pushed the input into `tanhf(3.0+)`, slamming against the hard saturation curve and causing severe non-linear compression and clipping distortion.
- **Engine Fix**:
  - Expanded the voice mix headroom divisor from `/ 3.0f` to `/ 8.0f` (`tanhf(mixL / 8.0f)` / `tanhf(mixR / 8.0f)`).
  - Recompiled `tools/psgplay.exe` with MSVC (`vcvars32.bat`).
- **Result**:
  - Eliminated polyphonic distortion completely. Multi-voice piano passages now render with clean, open dynamic range and zero harsh clipping, matching the hardware behavior on AppleWin.

### Milestone 30: Native Windows ZSM Player (`zsmplay.exe`) — VERA PSG + YM2151 FM + VERA PCM (2026-10-08)
- **User Problem**: `zsm2psg.mjs` transcodes Commander X16 ZSM music into VERA-PSG-only `.psg` streams, discarding the YM2151 FM parts. There was no way to audition the original `.zsm` files (FM percussion, drums, stereo panning) on Windows without a Commander X16.
- **Implementation (`tools/zsmplay.cpp`)**:
  - **ZSM container decoder**: 16-byte header (`zm`/`ZSM` magic, 24-bit loop offset, 24-bit PCM table offset, FM channel mask, PSG voice mask, 16-bit tick rate) followed by a 60 Hz command stream — native PSG writes (`< $40`: `[reg, val]`), EXTCMD (`$40`: `[ext, data[ext & $3F]]`), YM2151 batches (`$41`–`$7F`: `count = cmd & $3F` register pairs), end-of-data (`$80`), tick delays (`> $80`: `tick += cmd & $7F`).
  - **PCM table**: `"PCM"` magic + `inst_max` + `(inst_max+1)` 16-byte instrument entries (geometry bits 5:4 = format, 24-bit data offset/length/loop point relative to the data area) followed by raw sample data. EXTCMD `ext < $40` carries PCM sub-events: `[0x00, ctrl]` volume (bits 3:0) + FIFO flush (bit 7), `[0x01, rate]`, `[>=0x02, instrument]` trigger.
  - **Dual synthesis engines**:
    - VERA PSG: 16-voice synthesis ported from `psgplay.c` (pulse/sawtooth/triangle/noise, 64-step logarithmic volume LUT, 48 kHz output).
    - YM2151: **ymfm** core (`ymfm::ym2151`, compiled in from `AppleWin\source\ymfm\ymfm_opm.cpp`); native ~55,930 Hz output linearly resampled to 48 kHz.
  - **VERA PCM playback**: sample rate = `rate × 48828.125 / 128` Hz (format from instrument geometry: 0=mono8 / 1=stereo8 / 2=mono16 / 3=stereo16), linear interpolation, VERA PCM volume LUT (`{0,1,2,3,4,5,6,8,11,14,18,23,30,38,49,64}`, output = `sample × LUT[v] / 64`), loop-point restart, matching the AppleWin VERA card implementation (`VERAAudio.cpp`).
  - **True stereo**: YM2151 per-channel pan (reg `$20`–`$27`: bit 6 = left, bit 7 = right → `output.data[0]` / `data[1]`) and VERA PSG per-voice stereo control bits, summed and mixed with `tanh` soft saturation.
  - **FM mix gain**: default 12.0× — the raw ymfm output (±1.0) is buried under the 16-voice PSG sum, which made FM drums inaudible; adjustable via `--fmvol 0.25..16` or `F1`/`F2` hotkeys, shown live as `FM:x.xx` in the status bar.
  - **Loop semantics**: matches `zsmkit.s` — at end-of-data the stream cursor repoints to the loop frame **without** resetting PSG/YM state (the loop-point state carries over). A track with no loop point plays once and exits (after the audio buffers drain).
  - **Tick-rate normalization**: non-60 Hz tick rates (header offset 12–13) are normalized to the 60 Hz output clock via a fractional accumulator.
  - **Header masks**: FM channel mask (offset 9) and PSG voice mask (offset 10–11) are applied during event dispatch.
  - **FM VU meter**: the 16-slot activity meter shows YM2151 channels 0-7 (key-on state tracked from reg `$08` writes: channel = `val & 7`, operator mask = bits 3-6) in slots 0-7 and PSG voices 0-7 in slots 8-15 when `fmMask` ≠ 0; pure-PSG tracks show all 16 PSG voices.
  - **PCM VU meter + gain**: slots 16-17 show the VERA PCM L/R output peak (0..32767, tracked before gain so the meter reflects sample content; `.` `-` `=` `#` `^` at 0/8192/16384/24576). PCM mix gain (`pcmGain`, default 12.0×, `--pcmvol`/`F5`/`F6`, 0.25..16) is applied after the volume LUT and shown live as `PCM:x.xx` in the status bar.
  - **PSG gain**: `psgGain` (default 12.0×, `--psgvol`/`F3`/`F4`, 0.25..16) scales the summed 16-voice PSG output before mixing; shown live as `PSG:x.xx`. Hotkey layout: F1/F2 = FM, F3/F4 = PSG, F5/F6 = PCM.
- **Diagnostic tools**:
  - `tools/zsm_scan.mjs`: per-file event histogram (PSG/YM register usage, EXTCMDs, delay ticks) + header field dump + PCM instrument table decode. Revealed TITLE.ZSM's drums are pure FM percussion: reg `$08` key-on (957 writes) + reg `$60`–`$7F` total-level modulation (2,500–3,100 writes per operator), with zero noise-register (`$0F`) writes.
  - `tools/zsm_pan.mjs`: stereo panning analysis — TITLE.ZSM uses all three YM pan modes (L=208 / R=209 / both=215) plus PSG L/R panning.
- **Build**: `tools/build_zsmplay.bat` — `cl /O2 /MT /EHsc zsmplay.cpp ymfm_opm.cpp /I<ymfm> /link winmm.lib` (zero external DLL dependencies, same as `psgplay.exe`).
- **Verified**: TITLE.ZSM decodes to 3,329 frames (55.5 s), loop @ frame 256, real-time playback with correct stereo image and audible FM percussion after the gain fix. TREE.ZSM (PCM-only, 1 instrument, mono 8-bit, 27,847 Hz, 52.8 s, no loop point) plays PCM audio and auto-exits at end of stream.
- **Gotcha**: `totalFrames` must be `max(frames.size(), tick + 1)` after parsing — delay commands advance the tick counter without emitting events, so a stream ending with delays (e.g. a PCM-only track) would otherwise report a 1-frame song.

### Milestone 31: Bundled ymfm Source (`ymfm/`) + Apple //e ZSM Player (`zsmplay.asm` → `zsmplay.po`)
- **User Problem**: `zsmplay.exe` compiled against `C:\dev\applewin\source\ymfm` via an absolute include path, making the veramusic build non-portable. Additionally, `.zsm` music from the x16-hero-vera port (`C:\dev\x16-hero-vera\assets\*.ZSM`) could only be auditioned on Windows — there was no Apple //e-side player that writes the YM2151 FM events through the VERA card's FM daughterboard registers.
- **Bundled ymfm** (`ymfm/`): `ymfm.h`, `ymfm_fm.h`, `ymfm_opm.h`, `ymfm_fm.ipp`, `ymfm_opm.cpp`, `LICENSE` copied from `AppleWin\source\ymfm`. `tools/build_zsmplay.bat` now uses `set YMFM=%~dp0..\ymfm` (repo-relative) instead of the absolute AppleWin path, so the Windows player builds self-contained.
- **Apple //e ZSM player** (`src/zsmplay.asm`):
  - 65C02 program loaded via `BRUN ZSMPLAY.BIN` at `$2000`; writes YM2151 host registers through `YM_REG = VERA_BASE + $20` (register select) and `YM_DATA = VERA_BASE + $21` (data/status) — same convention as the Commander X16 `$9F40`/`$9F41`.
  - **Code-first layout**: all `.byte` data tables (`INIT_REGS`, `ZSM_STREAM`) live *after* the code. An earlier version placed the stream data before `START`, so BRUN began executing raw data. Data tables use `$FF` terminators.
  - **Channel 0 init**: `INIT_REGS` programs reg `$20` = `$C7` (RL = L+R, CON = 7 parallel operators), MUL = 1 for all 4 operators (`$40/$48/$50/$58`), TL = `$7F` (`$60–$78`), AR = `$1F` instant attack (`$80–$98`), RR = 7 fast release (`$E0–$F8`).
  - **ZSM event walk**: `ZSM_STREAM` holds `[reg, val]` pairs; the main loop writes `reg → YM_REG`, `val → YM_DATA`, then a ~1 frame delay. Verified event sequence in the AppleWin `-log` output: `$28/$4A` (KC concert A) → `$08/$78` key-on → `$08/$00` key-off → `$28/$5A` (octave up) → `$08/$78` → `$08/$00`.
  - **Exit is `RTS`, not `JMP $03D0`**: under ProDOS/BASIC.SYSTEM, jumping to the DOS 3.3 warm-start vector `$03D0` makes BASIC.SYSTEM attempt to reload itself → `** Unable to load BASIC.SYSTEM **`. `RTS` returns cleanly to the BASIC interpreter (BRUN's return vector).
  - **Delay preserves the stream index**: `DELAY_FRAME` originally did `LDX #$30` for its nested delay loops, clobbering the `X` stream pointer — the event loop then re-wrote the first register pair forever (297 × `$28/$4A`, key-on never reached). Fixed with `TXA/PHA` … `PLA/TAX` around the delay.
  - **Dual-slot build**: `src/ZSMPLAY.BIN` (slot 2, `VERA_BASE = $C200`) + `src/ZSMPLAY4.BIN` (slot 4, `$C400`).
- **ProDOS image** (`tools/build_zsmplay_po.mjs` → `zsmplay.po`, 140 KB): built from the `veratest/assets/ProDOS 2.4.3.po` template with the same directory/bitmap allocation logic as `build_fmtest_po.mjs`. Contains `ZSMPLAY.BIN`, `ZSMPLAY4.BIN` (type `$06`, aux `$2000`) and `STARTUP` (type `$FC`).
- **Startup slot probe** (`src/zsmplay_startup.bas`): the Applesoft STARTUP mirrors `fmtest_startup.bas` — POKEs `$C205`/`$C405` (VERA_CTRL) expecting a read-back, then writes/reads a pattern at DATA0 (`$C203`/`$C403`) to positively identify a slot-2 or slot-4 VERA card before `BRUN ZSMPLAY.BIN` / `BRUN ZSMPLAY4.BIN`.
- **Verified** (`AppleWin.exe -d1 zsmplay.po -s2 vera -log`): disk boots, slot-2 VERA detected, `ZSMPLAY.BIN` runs, 48 FM register writes (34 init + 12 stream + 2 key-off) with the full key-on/key-off pattern present, then returns to BASIC with no crash.
- **Gotcha**: `.po` (ProDOS floppy, `-d1`) and `.hdv` (hard-disk image, `-h1`/`-h2`) are different formats — an `.hdv` is not a renamed `.po`, and copying an unrelated `.hdv` (e.g. the x16-hero-vera game image) just ships that image's contents.

### Milestone 33: ZSM Player PSG/FM Mix Balance Fix — Restores the Missing Percussion (2026-10-11)
- **User Problem**: `zsmplay.exe` playing Commander X16 game music (e.g. `MINE-RESCUE/title.zsm`) lost the percussion track — the CX16 plays `hit-note-note-note` repeatedly, `zsmplay` played `hit-note-note-note` once and then only quiet notes.
- **Root Cause — the VERA PSG was rendered ~16x too loud, which pinned the output limiter and flattened every FM transient**:
  - The authoritative VERA core in the AppleWin fork (`C:\dev\applewin\source\VERACard\VERAAudio.cpp`) computes each PSG voice as `val = sign_extend_6bit(wave) * volumeLut[ctrl&0x3f]; l += val >> 3;` — i.e. **one PSG voice at full volume contributes ~1980/32767 (0.060)**, and all 16 voices sum to ~31,700 (just under full scale). This is the same 2,044-per-voice figure already noted in Milestone 11.
  - `zsmplay.cpp` instead used `volAmp = volumeLut[volIdx] / 511.0f` with a ±1.0 waveform sample, making **one voice = full scale** (16.5x too loud). Two PSG voices therefore reached ±65,000 before any gain was applied.
  - Milestone 30 then "compensated" by defaulting **all three engine gains to 12x** ("the raw ymfm output is buried under the 16-voice PSG sum"), which made things worse: the sum was driven far past the `tanhf(mix / 8.0f)` knee, so the limiter output sat pinned near full scale for virtually every sample and all dynamics — including the YM2151 drum transients — were crushed away.
  - The AppleWin reference at the time mixed the engines 1:1 (`VERACard.cpp`: `mixed = psg + ym`), so no engine gain was thought to differ. **Superseded by Milestone 37**: the real X16 Developer Board mixer is `(PSG + PCM) * 2 + YM`; the 1:1 sum was itself the imbalance bug.
- **Measured Proof** (offline ymfm render, YM2151 channel 7 removed vs. present, whole 55 s of `TITLE.ZSM`):

  | Mix | Drum RMS vs. mix RMS | Drum share of mix energy | Mix peak / avg |
  |---|---|---|---|
  | Before (`LUT/511`, gain 12, `tanh/8`) | **-25.0 dB** | 5.6 % | 29,595 / 9,446 (saturated) |
  | After (hardware PSG, gain 1, `tanh x2`) | **-11.8 dB** | 25.6 % | 26,149 / 3,414 (clean) |

  Per-second RMS before the fix jumped from ~2,840 to ~14,900 the moment the PSG melody entered (frame 1024, ~17 s) — the limiter was being slammed. After the fix the level stays flat across the whole song.
- **Changes (`tools/zsmplay.cpp`)**:
  - PSG voice amplitude now matches the hardware: `volAmp = volumeLut[volIdx] * (4.0f / 32767.0f)`.
  - `fmGain` / `psgGain` / `pcmGain` defaults changed from `12.0` to `1.0` (hardware-accurate 1:1 sum). `F1`–`F6` and `--fmvol/--psgvol/--pcmvol` still adjust over `0.25..16`.
  - Output soft clipper changed from `tanhf(mix / 8.0f)` to `tanhf(mix * 2.0f)`, sized for hardware-accurate engine levels (a busy 8-channel FM arrangement peaks near 0.9) instead of the previous over-driven range.
- **Also verified**: `CANYON.ZSM` (PSG-heavy, 16 voices) previously rendered pinned at the limiter ceiling (29,999/30,000 — i.e. distorted); it now peaks at 25,550 with zero clipped samples.
- **`tools/psgplay.c` brought onto the same hardware model** (same `VERAAudio.cpp` reference, which is what `zsound` and `zsmkit` ultimately rely on — neither library scales anything, they only write raw VERA PSG / YM2151 registers and let the VERA DAC do the mixing):
  - Phase accumulator changed to the VERA's 17-bit `0..0x20000` form, advanced by `freq * (PSG_CLOCK / sampleRate)`.
  - Waveforms now use the hardware's 6-bit unsigned output value, sign-extended to `-32..+31`. This restores the **pulse-width phase offset on the sawtooth and triangle** waveforms, which the old code ignored entirely.
  - Noise is now **band-limited and per-voice**: each voice latches its own 6-bit sample (`(noiseState >> 1) & 0x3F`) at every half-period of its own oscillator. Previously a single ±1.0 white-noise value was regenerated per sample and shared by all voices, which produced full-bandwidth hiss with correlated voices instead of the hardware's stepped, frequency-limited noise.
  - Voice level is `(sv * volumeLut[v]) >> 3`, so one voice at full volume is ~1980/32767 and 16 voices sum to just under full scale.
  - Output clipper moved from `tanhf(mix / 8.0f)` to `tanhf(mix * 2.0f)`. Because the PSG input shrank by exactly 16x, `16 * (1/8) = 2.0` reproduces the previous output level and loudness while leaving the transfer curve in its linear region instead of slamming it — the existing `.psg` previews keep their calibrated volume but lose the distortion.

### Milestone 34: Melodius for Windows — ZSM / ZCM Player (2026-10-11)
- **Goal**: a native Windows player for Commander X16 music, ported from `C:\dev\melodius` (MooingLemur's X16 music player, which drives **ZSM** and **ZCM** through zsmkit and additionally parses Standard MIDI Files).
- **Scope delivered**: **ZSM and ZCM only**. Melodius's MIDI engine is **not** ported; `.mid` / `.midi` inputs are rejected with an explicit message rather than silently mis-playing.
- **`tools/zsmplay.cpp` / `zsmplay.exe` / `build_zsmplay.bat` were deleted** — `melodius.cpp` started life as a copy of `zsmplay.cpp` plus a ZCM loader and file-kind detection, so keeping both meant maintaining the same DSP in two places (the Milestone 33 PSG level fix had to be applied twice). `melodius.exe` is now the single Windows player for X16 music, detecting the format from the file extension. The Apple //e player `src/zsmplay.asm` is unrelated and remains — but its `zsmplay.po` floppy image was dropped from the repo on 2026-10-13 (`e55dac7`); `tools/build_zsmplay_po.mjs` still packs it locally from `src/ZSMPLAY.BIN` / `ZSMPLAY4.BIN`.
- **Why the X16 mix comes out right**: on the Commander X16 both formats go through the same engine — YM2151 + VERA PSG + VERA PCM — and the X16 mixes them in the VERA DAC. Neither zsmkit nor ZSound scales anything (they only write raw registers), so reproducing `VERAAudio.cpp` faithfully is what makes the Windows render match the hardware. `melodius.cpp` therefore reuses the Milestone 33 hardware model unchanged. **Corrected in Milestone 37 (2026-10-22)**: the board mix is `(PSG + PCM) * 2 + YM`, not 1:1 — `VERACard.cpp`'s `mixed = psg + ym` repeated the same AppleWin-side bug.
- **ZCM container format** (derived from `zsound/tools/raw2zcm` and `zsmkit`'s `zcm_play`):

  | Offset | Size | Field |
  |---|---|---|
  | `$00` | 3 | `00 00 00` signature |
  | `$03` | 3 | sample length, 24-bit little endian |
  | `$06` | 1 | geometry (VERA `AudioCtrl` bits 5:4 — 0=mono8 1=stereo8 2=mono16 3=stereo16) |
  | `$07` | 1 | VERA `AudioRate` byte |
  | `$08` | var | raw PCM sample data |

  Verified against `zsound/examples/simplepcm`: `shoryukEN_8kmono8bit.zcm` (12332 B, geometry `0x00`, rate 21 → 8011 Hz) and `TEST.ZCM` (135630 B, geometry `0x3F` → stereo16, rate 58 → 22125 Hz); rendered durations match byte-count / rate exactly.
- **Bug found while wiring ZCM**: `apply_frame()` indexed `frames[frameIdx]` without bounds-checking against the populated array. ZCM (and MIDI) drive the engines directly and have **no** ZSM frame array, so a non-zero `totalFrames` caused an access violation (`0xC0000005`). Fixed with a `frameIdx >= (int)frames.size()` guard.
- **Reversing the MIDI half (deferred, documented for later)**: melodius's MIDI engine is two layers — `src/midi.s` (available: SMF parsing, 16-channel state, 8-voice YM allocation, `VELOCITY_TO_ATTEN = max(0, ((127-vel)>>2) - 16)`, note range 13..108, uses **only** the 8 YM2151 channels and never the VERA PSG) and zsmkit's `AudioAPI` (**source unavailable** — only the 9 KB compiled `extern/zsmkit-a000.bin`).
  - A 6502 disassembler was written (`%TEMP%\opencode\dis6502.js`) and the 39-entry JMP table recovered cleanly, e.g. `notecon_midi2fm $ABC9`, `ym_loaddefpatches $B009`, `ym_loadpatch $B12F`, `ym_playdrum $B0F4`, `ym_playnote $B15F`.
  - **Open question blocking the port**: the MIDI-note → YM2151 `KC`/`KF` mapping. `ymfm` indexes a 768-entry phase-step table via `s_phase_step[eff_freq] >> (block ^ 7)` (`ymfm_fm.ipp:320`); the documented `fnum = (144 × freq × 2^20) / 8053920 / 4` produces `eff_freq` outside the 0..767 range and is for delta offsetting, not absolute pitch. `notecon_midi2fm` was found to use a 17-entry semitone table at `$ABFC` (`00 05 09 0E 0E 12 17 1B 1F 24 28 2D 2D 31 36 3A 3D`) whose block-splitting has not yet been recovered. Resolve this before writing the SMF parser, otherwise a wrong-timbred MIDI render is indistinguishable from a wrong patch table.

### Milestone 35: Real Apple II ZSM Player (`zsmstream.asm`) — PSG + YM2151 FM (2026-10-18)
- **Goal**: a real 6502 ZSM player for the Apple II, going beyond `zsmplay.asm`'s hardcoded FM demo. Streams `.ZSM` files from ProDOS disk, decodes PSG + YM2151 FM events (PCM deferred), `BRUN`s at `$2000`, and has a built-in menu of 11 songs (incl. SHOVELKNT.ZSM via the 'S' key). Built as `zsmstream.hdv` (32 MB).
- **Architecture (decode-ahead, never in IRQ)**:
  - **Main loop `DECODE_FRAME`**: byte-exact ZSM stream decoder via `GETB` (`psgstream.asm`'s `$580-$602` pattern — `BUF_END` boundary, `SHORT_READ`, MLI sync re-fill; MLI never runs inside the IRQ). 24-bit `POS` tracks file position for loop seek.
  - **IRQ pipeline** (`IRQ_HANDLER`/`TICK`): PSG pairs written via the VRAM window (`$Cn00-$Cn02` address, `$Cn03` DATA0 auto-increment → `$11F9C0-$11F9FF`); FM pairs written via `$Cn20` YM_REG / `$Cn21` YM_DATA (no BUSY poll — the emulator doesn't drop writes during BUSY, real OPM2151 would; documented emulator simplification). `VERA ISR/IEN` hooked through `$03FE/$03FF`, VERA ADDR saved/restored around the handler.
  - **Dual frame buffer**: `[psgCnt][reg,val]×n [ymCnt][reg,val]×n`, `psgCnt=$FF` = hold frame. Main loop decodes into the write buffer; at a tick boundary `SEI` copies the pointer into `FB_ACT`/`FB_READY=1`/`CLI` and swaps. `FB_A=$7300`, `FB_B=$7500`, `YM_SCRATCH=$7700` — three non-overlapping 512 B regions.
  - **Tick-rate normalization**: all songs are 60; non-60 falls to a fractional accumulator so the IRQ always applies whole 60 Hz frames.
- **ZSM decode semantics**: `$00-$3F` PSG write (psgMask-gated, `bit = reg>>2`); `$40` EXTCMD (skip `ext<0x40 ? ext : ext&$3F` bytes — PCM sub-events byte-exact); `$41-$7F` YM batch (fmMask-gated — `reg≥$20 → ch=reg&7`, `reg=$08 → ch=val&7`); `$80` end (publish → loop or done); `$81-$FF` delay. Loop seek via `SET_FILE_MARK(loopOffset)` + `READ`, engine state not reset (cursor re-point, not state reset — zsmkit/melodius semantics); `loopOffset=0` = play once and return to menu.
- **Song table** (11, all ProDOS-legal 15-char names): `CANYON.ZSM` (loop @19), `TITLE.ZSM`/`HIGHSCORE.ZSM`/`GAMEOVER.ZSM`/`KILLED.ZSM`/`LVLCOMPLETE.ZSM` (x16-hero-vera, FM drums + `$82` sync events), `BOTHPSG.ZSM` (melodius test), `GARGOYLES.ZSM` (FM-only, loop=0 no-loop path), `TRACK2.ZSM` (fmMask $1F), `CMDRDEMO.ZSM` (fmMask $0F / psgMask $6F). SHOVELKNT.ZSM now included via the 'S' menu key (song index 10; its PCM table + 606 PCM events are skipped byte-exact — PCM engine deferred).
- **Build pipeline**: `tools/build_zsmstream.mjs` (slot 2/4 assemble + zeroGuard + fit < $3800) → `tools/build_zsmstream_hdv.mjs` (Cadius from the ProDOS 2.4.3 template, `STARTUP` slot-probe Applesoft + BRUN, 11 songs). `--autoplay` variant (`AUTOPLAY = 1` equate) produces `ZSMSTREAMA.BIN` for headless verification.
- **Two bugs found while bringing up FM (the "no sound" root cause)**:
  - **Frame-buffer overlap**: the three 512 B regions were `$7300/$7400/$7500`, overlapping 256 B each — `FB_B` and `YM_SCRATCH` collided. Fixed to `$7300/$7500/$7700`.
  - **16-bit memmove count decrement (FM stall)**: `PUBLISH_FRAME`'s memmove (copying `2*ymCnt` bytes from `YM_SCRATCH` to the frame) decremented `MOVCNT_L` while `A` held `MOVCNT_H` whenever `MOVCNT_L` wrapped to 0 with `MOVCNT_H>0` (any frame with `ymCnt>128`). `MOVCNT_H` never changed, the loop spun forever at `MOVCNT=$0100` copying bytes around and corrupting the player — the FM went silent and the stream position drifted into `disk err - stream block unreadable $50`. Fix: explicit borrow — when `L==0 && H>0`, `DEC MOVCNT_H` and set `MOVCNT_L=$FF`; only decrement `L` when `L!=0`.
  - **`SET_MARK` param count (rare `$44` loop-seek error)**: `SETMARK_PARAMS` originally declared `!byte 2`, and the `$44` errors were blamed on that, so it was changed to `!byte 4,0,0,0,0`. **Corrected 2026-10-22 (Milestone 36): ProDOS MLI `SET_MARK` ($CE) takes a parameter count of 2** (refnum + 24-bit position); with 4 the MLI returns `$04` (bad reference number) at the first EOD. `pcmstream.asm` has always used 2. The original `$44`s were caused by the frame-buffer memmove/PSG-flood corruption documented above, not by the count — after those fixes, count=2 loops TITLE and BOTHPSG repeatedly with zero disk errors. Current: `!byte 2,0,0,0,0`. A GETB-triggered `READ` error instead sets STREAM_END → DONE_FLAG → SONG_DONE (silent), so loop-seek errors always come from the `SET_MARK`/`READ` inside `DO_LOOP_SEEK`. Verify other param counts: OPEN=3, READ=4, CLOSE=1.
- **Verification**: headless `-run-cycles 40000000 -fm-wav-dump` on the AUTOPLAY build — WAV peak 9029, 53% nonzero over 20 s (FM + PSG both in the mixed VERA buffer), heartbeat reaches the end of the run (no stall), zero `unreadable`/disk errors. After the `$44` fix: 10 consecutive headless `-run-cycles 60000000` runs (each ~2 full CANYON playthroughs = 2 loop seeks) with zero `$44`; the pre-fix error reproduced ~1 in 4. Final re-verification (2026-10-19, post-fix build): headless `-run-cycles 40000000 -fm-wav-dump` clean — VERA.log run has zero disk errors, all `SETMARK count=$02` with 9 loop-seek events, heartbeats reach the end of the run; WAV full-scale over 20 s (peak 12395, ~94% nonzero, continuous per-second peaks). Real-time run confirmed by the user (audible PSG + FM). Debug logging (FM sel = 830, FMMAX = 10771) confirmed FM registers applied before it was reverted — never leave temp debug in the tree.

### Milestone 36: ZSM FM Retrigger + Apple //e TITLE Playback Fixes (2026-10-22)
- **User Problem (Windows)**: `melodius.exe` played TITLE.ZSM's first FM chord, then every later note was silent or much quieter (the "missing notes" symptom; the Apple //e player showed it too).
- **Root Cause — ZSM key-off + key-on inside one tick**: ymfm samples the key state once per generated native sample (`clock_keystate` calls `start_attack()` only on a 0→1 change of `m_key_state`). ZSM retriggers a channel with `$08 = ch` (key-off, operator mask 0) immediately followed by `$08 = $78 | ch` (key-on) in the same tick, and our players applied the whole batch with **no sample generated in between**, so the key-off+key-on cancelled and the envelope kept decaying. The first note of each channel works because it starts from key state 0. x16emu clocks the chip between CPU writes, which is why the X16 reference never showed the bug.
- **Fix**: after a full key-off write to `$08`, clock exactly one native YM sample so the release latches before the key-on arrives.
  - `tools/melodius.cpp` (`apply_frame`): `if (reg == 0x08 && (val & 0x78) == 0) ym_clock_keyoff();` where `ym_clock_keyoff()` generates one sample through the normal ymfm path.
  - AppleWin `VERAYM::WriteData`: tracks `m_regSelect`; the same condition calls `ClockKeyOff()` (`source\VERACard\VERAYM.cpp`, applied alongside this milestone).
- **Verified** (`tools/melodius.exe TITLE.ZSM --wav` vs the x16emu ground truth, aligned 55 s): 0 loud windows missing (was ~74 % unaligned / audible collapse); ch0 solo envelope per note 0.074 → 0.078 → 0.087 (was 0.074 → 0.020 → 0.005). AppleWin `-fm-wav-dump` group peaks are now 0.13–0.26 for **all** groups (the old dump stayed pinned at the drum floor, 0.08).
- **Apple //e `zsmstream.asm` fixes (same session)**:
  1. **PSG flood → slow motion + noise**: in `TICK4` the sequence `STA TCNT1` / `BEQ TICK_YM` tested the stale Z flag from the preceding `CMP #$FF` (`STA` does not set flags). A frame with `psgCnt = 0` fell through, `DEC TCNT1` underflowed to `$FF`, and the IRQ wrote 256 bogus PSG pairs (running past the PSG window into palette/sprite VRAM). Fix: `CMP #$00` before the branch.
  2. **16-bit frame walk**: a published frame can exceed 255 bytes (TITLE has a 128-pair YM frame, GAMEOVER 213), so the IRQ now walks it with `FB_RD_L/FB_RD_H` instead of an 8-bit `Y` index that wrapped back into the frame header and replayed it as YM/PSG data. New zero-page vars `FB_RD_L = $36`, `FB_RD_H = $37`.
  3. **`SET_MARK` parameter count**: back to `2` (see the correction in Milestone 35). With count 4 the first EOD loop-seek failed with MLI `$04`.
- **Verification (Enhanced //e at 3 MHz)**: TITLE first pass plays normally (6,052 real PSG pairs after tick 1024; 897 host ADDR_L writes for ticks 1024–1433 vs 900 expected), then loops at ~171 M cycles. At 195 M: `FRM=3765`, `DEBUG_MARKER=$12`, `ERR=0`, `ERRCODE=0`, `REF_NUM=1`, `EOF_FLAG=0`; the 512-byte stream buffer matches TITLE byte offset `0x2688` (loop point `0x888` + 15 blocks) with `STREAM` at `0x27D8`. BOTHPSG loops 3.28× to offset `0x13` (a valid command boundary mid-frame). All `zsmstream*.hdv` images rebuilt; temporary TICK/PSG/IRQ probes removed from `VERACard.cpp`.
  - **Timing note**: this machine's //e runs at 3 MHz, so `g_nCumulativeCycles` advances ~51 k per 60 Hz VERA tick, not ~17 k; TITLE's EOD is at ~171 M cycles and on-screen `T:` is published-frame based (~3329 frames = 55 s of music).

### Milestone 37: X16 Developer Board Mix Balance — `(PSG + PCM) * 2 + YM` (2026-10-22)
- **User Problem**: after the FM retrigger fix, FM was very loud while PSG was "小貓叫" (buried), and the PSG seemed to break up whenever FM played.
- **Root Cause — the board mix is not 1:1**: the Commander X16 Developer Board sums the engines as `mix = (PSG + PCM) * 2 + YM` (x16emu `src/audio.c`: `vera_out_l = ((psg + pcm) << 14)`, then `mix_l = (vera_out_l >> 13) + (ym_out_l >> 15)`). A single full-volume PSG voice is only 1/8 of full scale, so the ×2 on the VERA bus is what puts the PSG and PCM at their intended level against the YM2151. Our player mixed 1:1 and additionally ran the sum through a `tanh` saturator, which ducked the **whole** mix on every loud FM attack — that ducking is what made the PSG sound chopped/broken.
- **Fix (`tools/melodius.cpp`)**:
  - Engine gains now match the board mixer: `psgGain = 2.0`, `pcmGain = 2.0`, `fmGain = 1.0` (still adjustable with `--psgvol`/`--pcmvol`/`--fmvol` and `F1`–`F6`).
  - Output stage is a hardware-style **linear sum + hard clip** (no soft limiter); the mix peaks below full scale at master volume 15, which is now the default.
  - Usage text and the voice-level comment document the 1/8-per-voice scale and the ×2 compensation.
- **Verified against x16emu ground truth** (`TITLE.ZSM`, aligned `truth_t = 0.04 + 1.00644 × our_t`):
  - Full-mix RMS 0.1333 vs truth 0.1311; PSG stem 0.0446 vs truth-derived ~0.045; FM stem 0.126 vs 0.123.
  - PSG-band envelope tracking improved from 0.244 to 0.615 (the PSG is now present under the FM instead of being buried/ducked).
  - Zero clipped samples across five songs at volume 15.
- **AppleWin follow-up**: `VERACard::UpdateSound()` now applies the same `(PSG + PCM) * 2 + YM` scaling before the int16 clamp, and the balance was ear-confirmed on 2026-10-22.

### Milestone 38: Apple //e Melodius Jukebox — 94 Songs + Streamed PCM (2026-10-22)
- **Goal**: replace the 11-song `zsmstream.hdv` test disk with a `melodius.hdv` jukebox carrying the whole X16 `MELODIUS` music collection (93 ZSM + `TREE.ZSM`; MIDI excluded) behind a two-level menu like `jukebox.hdv`'s (category → song), and make PCM actually play — the engine had PSG + FM only ("PCM deferred").
- **Engine (`src/zsmstream.asm`)**:
  - External file name: the BASIC menu writes `'M','Z'` + a NUL-terminated ProDOS path to `$6800`/`$6802` before `BRUN`; the player opens that instead of walking its own built-in table. `AUTOPLAY`/`AUTOSONG` equates still produce a headless single-song image.
  - PCM is now real: `$40` EXTCMD payloads with `ext < $40` are decoded as `[sub,val]` PCM sub-events (0 = volume/flush, 1 = rate, ≥2 = trigger instrument).
  - **Companion `.PCM` file**: ProDOS 8 returns `$50` ("File is open") for a second OPEN on the file the ZSM stream is already streaming, so `tools/build_melodius.mjs` splits each song's PCM table out into `<8.3name>.PCM` (magic + instMax + entries + data, table at offset 0). The player opens it with a second refnum (`PCM_REF`) and computes `DATA_BASE = 20 + instMax*16`. A missing companion (`$46`) is not fatal: the song plays without its samples.
  - **Windowed streaming**: the old bulk load capped at 7 KB, which truncated 20 of the 28 PCM songs (TREE's sample is 1.47 MB) and — because the cap only compared the high byte — let Crockett's 125 KB sample overrun the buffer and trash the stream state. `PCM_TRIGGER` now only resets position/window state; `PCM_FILL_WINDOW` loads 2 KB windows (`PCM_BUFFER_SIZE = $800` at `$4400`) on demand from `FP_PUSH_ONE`, which compares `PCM_POS` against `PCM_WIN`/`PCM_WINEND` (both directions, so a loop wrap refills too).
  - A PCM window read failure sets the private `PCM_IOERR` and silences the drums only — it never touches the global `ERR` that would abort the song.
  - The window byte pointer is zero-page `$03/$04` (`(zp),Y` is a zero-page mode: the old pointer lived in the data block at `$33xx`, which only "worked" because emulators ignore the high byte).
- **Build (`tools/build_melodius.mjs`)**: assembles both slots, compiles the two-level Applesoft menu, splits PCM companions, packs + `CHECKVOLUME`s `melodius.hdv` with Cadius; `--list` prints the song index table, `--autoplay <idx>` writes a temp test image to `%TEMP%\melodius_autoplay.hdv`.
- **Verification** (headless, `-fm-wav-dump` + the `$C21D` writes in `VERA.log`): Crockett (32.5 KB sample) streams 357 k FIFO bytes and the histogram is signed-8-bit-audio shaped (mean −0.17, peaks at `$00`/`$FF`); TREE (1.47 MB) streams 508 k bytes and reaches `T: 00:16.5` with no disk error. The release image boots to the 17-category menu.
- **Cleanup**: deleted `zsmstream.hdv*`, `ZSMSTREAM*.BIN`, `zsmstream_startup.bas`, `zsmstream_autostart.bas`, `tools/build_zsmstream*.mjs`; `build.bat melodius` (old `zsmstream` target still accepted) now runs `tools/build_melodius.mjs`.

### Milestone 39: PCM feed rewritten to the `pcmstream`/`zsmkit` model — TREE plays clean (2026-10-22)
- **Symptom**: `melodius.exe` renders `TREE.ZSM` fine, the Apple //e player turned the same track into noise. TREE is the pure-PCM case: one mono-8 instrument, 1,469,916 bytes, rate 73 → the VERA FIFO must receive 27,865 B/s, and nothing else (fmMask/psgMask both 0).
- **Format lesson (do not re-derive this)**: the PCM instrument table is `"PCM"` + **one `inst_max` byte that is a MAX INDEX, not a count** (count = `inst_max + 1`) + `(inst_max+1)` × 16-byte entries, and the sample data starts at `pcmTableOffset + 4 + (inst_max+1)*16`. `tools/pcminfo.cjs` parsed `inst_max` as a count and walked off the 48-byte stream, which produced the bogus "TREE has 256 instruments / is ZCM" conclusion. `tools/melodius.cpp:load_zsm_file` is authoritative.
- **Root cause of the noise was cost per byte, not format**: the old `FP_PUSH_ONE` did three 24-bit compares plus a pointer recompute per sample byte (~140 cycles). 27,900 B/s × 140 > the whole 3 MHz CPU, so the FIFO starved, AppleWin emits silence on underrun, and a low-level signal turns into crackle. Replaced with `PCM_FEED` / `PCM_PREFILL` / `PCM_DRAIN` / `PCM_MUTE`, modelled on `src/pcmstream.asm`'s `FEED_BLOCK_BYTES` (bounded 128-byte page-indexed pass, gated on `VERA_AUDIO_CTRL` bit 7 = FIFO full) and `zsmkit`'s `_pcm_player` (rate-0 cold prefill so the FIFO is loaded before the clock starts, natural-end drain instead of a flush). Bookkeeping is now once per pass instead of once per byte (~22 cycles/byte).
- **Status line**: `SHOW_STATUS` draws the 16-channel VU meter only when the song actually has PSG voices (`psgMask != 0`) **or** has no PCM table; a pure-PCM track prints `PCM $xxxxxx` (the 24-bit sample cursor) instead, and the stopwatch now counts VSYNC ticks in `TICK_CLK` rather than published frames, so `T:` tracks the audio. FM-only tracks (e.g. Crisps' `01-TITLE`, psgMask 0 but no PCM) keep the meter — gating on `psgMask` alone was wrong.
- **Pause/mute contract**: pause freezes the rate and the clock and stops feeding (`PCM_FEED` returns while `PAUSE`), mute keeps the timeline moving at volume 0 with no FIFO flush, and every path clears `FB_READY` so the main loop can never wedge in `PUB_WAIT` with the keyboard unpolled.
- **Verified** against `tools/melodius.exe TREE.ZSM --no-loop --wav tree_truth.wav`: cross-correlating 2 s segments of the 20 ms RMS envelope gives `emu = truth + 0.44 s` with slope 1.000 and corr 0.979-0.998 over the whole 16 s window; the AppleWin FIFO probe reads `fifo=3817`, `pushed 27,843 B/s`, `underrun=0`. **At 1.02 MHz the same build still starves** (~26 kB/s vs the 27.9 kB/s needed) — 27.9 kB/s PCM costs ~60 % of a 1 MHz //e in the feed loop alone, so pure-PCM streaming tracks need clock headroom (AppleWin `-clock-multiplier 3`, or a 14 MHz slot accelerator on hardware).
- **Measurement gotcha**: never time a PCM run with `-log` — the per-write VERA.log line costs an `fopen` per FIFO byte. `tools/build_melodius.mjs --autoplay 93` is the TREE test image (`%TEMP%\melodius_autoplay.hdv`).

### Milestone 40: TREE is decimated to VERA rate 42 — 1.02 MHz now plays it clean (2026-10-22)
- **Fix chosen over the unrolled feeder**: instead of squeezing more cycles out of `PCM_FEED`, the sample itself is slowed down, exactly like `tools/build_jukebox.mjs` already does for its two PCM tracks (`RATE_VAL = 21`, 8 kHz). `PCM: TREE` is decimated to rate **42** (16,022 B/s), which costs ~36 % of a 1 MHz //e instead of ~60 %.
- **`tools/zsm_pcm_resample.mjs`** does the rewrite in memory during the build: parse the PCM table (`inst_max` is a max index), find every EXTCMD `0x40` sub-event `[1, rate]` in the tick stream (`findRateEvents`), area-integrate each channel in the **signed** sample domain, then rewrite the entry offset/length/loop point and the rate byte. Duration is preserved by construction (`bytes/rate` is unchanged), so the tick stream needs no re-timing. `build_melodius.mjs` applies it for any category with `pcmRate`, before the `.ZSM` / companion `.PCM` split, and `--list` prints `[PCM 73->42 = 16022 B/s]`.
- **Guard rails in the tool** (fail loudly rather than corrupt): refuses upsampling, refuses a stream that sets several PCM rates, refuses overlapping instrument data, refuses a sample that runs past the stream.
- **Verified**: `melodius.exe` renders the patched file at the same 53.35 s length, identical peak (23552) and 99 % of the RMS, so the patch is a legal ZSM. AppleWin with the decimated `PCM01` (`845,725 B` companion in `melodius.hdv`): at the default **1.02 MHz** `corr 0.995` at `emu = truth + 1.52 s` and **0** dropout frames out of 525; at `-clock-multiplier 3` `corr 0.995`, 1 frame. Image shrank to 4,896 KB zip.
- **Still open (not asked for)**: the 27 mixed PSG/FM+PCM songs keep their original rate-60 drums and *do* drop frames at 1.02 MHz (`BEN01` 76/836 quiet frames, `Crockett` 115/357). Same one-line remedy (`pcmRate` on those categories) if 1 MHz playback of the drums is wanted; at 3 MHz all 28 were already dropout-free.
- **Metric gotcha**: align `emu` to `truth` as `emu[k] ↔ truth[k - lag]` (the dump is *behind* the reference). Testing the opposite sign invents 0.5 s "dropouts" that are only misalignment, and a mean-removed envelope correlation is meaningless on a steady track like TREE — use the absolute `emu_env / truth_env` ratio per 20 ms frame, ignoring frames where the truth itself is quiet.

### Milestone 41: TREE is decimated to VERA rate 21 (8 kHz) — same trade as the jukebox PCM (2026-10-22)
- **User request**: "先把melodius.hdv裡的 tree.zsm 檔案, 將其 pcm 的 sample rate (jukebox.hdv 的兩個 .pcm檔案也是降sample rate)". The jukebox side was already at the target: `space_debris.pcm` (2,451,687 B = 306 s) and `wellerman_full.pcm` (965,767 B = 120.6 s) were converted at `--rate=21` (8,010.864 Hz) by `wav2pcm.mjs` / `render_pure_pcm.mjs`, and `pcmstream.asm` ships `RATE_VAL = 21`. No rebuild was needed there.
- **melodius side**: `build_melodius.mjs`'s PCM category went from `pcmRate: 42` to **`pcmRate: 21`**, so `resampleZsmPcm()` decimates TREE from rate 73 (27,847 B/s) to rate 21 (8,011 B/s). `PCM01.PCM` in `melodius.hdv` shrinks 845,725 → **422,872 B** (Tree, 826 blocks) and the zip grows from 4,896 KB (rate-42 image) to **4,785 KB** — the sample is now 50 % smaller than the rate-42 build, closer to the jukebox PCM budget.
- **Pre-build offline verification** (`scripts/tree_rate21_check.mjs` + `scripts/tree_rate21_wavcmp.py`, kept as one-off scripts): the patch keeps the exact duration (422,852 B / 8,011 B/s = 52.78 s vs the original 1,469,916 B / 27,847 B/s = 52.78 s), one rate event at 21, and `melodius.exe --no-loop --wav` renders it with the **same peak 23552** and 97.3 % of the RMS (meanabs 3348.5 vs 3441.1) — the area-integrated decimation is the same legal trade M40 measured at rate 42.
- **AppleWin headless verification** (default 1.02 MHz, `-run-cycles 60000000 -fm-wav-dump`, no `-log`): `scripts/tree_rate21_align.py` aligns `emu[k] ↔ truth[k-75]` (**1.50 s lag**, the dump is behind the reference) over 9 loud 2 s segments with **corr min 0.988 / mean 0.995 / max 0.998**, loudness ratio median 1.015, and **1 boundary artifact / 0 real dropouts** across 925 loud frames (the single 0.151-ratio frame is the 20 ms envelope boundary of the 2.0 s loud-section onset; its neighbours are 0.99/0.93/1.00). Zero DISK ERR lines, zero PCM underruns. The alignment metric must use the correct sign (`emu[k] ↔ truth[k-lag]`): the opposite sign invented ~39.7 % "dropouts" that were pure misalignment (verified both ways in this session).
- **Timing note**: at 1.02 MHz the 60M-cycle run covers the whole 52.8 s song (~58.8 s of guest CPU at ~17,030 cycles/tick), while the `-fm-wav-dump` capture is wall-clock 20 s — so the dump's lag grows with the song position, not with the wall clock. The dump is *behind* the reference by ~1.5 s at the capture start; do not read that lag as starvation (slope stays 1.0, the per-segment lag is constant).
- **Superseded by M42**: the general 16 kB/s cap relaxes TREE back to rate **42** (16,022 B/s), which still measured `underrun 0` and corr 0.9948 at 1.02 MHz. The rate-21 choice was a per-song workaround; the general cap keeps the highest rate that fits the budget.

### Milestone 42: Apple //e PCM noise fixed — 16-bit frame stride + a 16 kB/s FIFO budget for all 28 PCM songs (2026-10-23)
- **Symptom**: `melodius.hdv` index 40 (Crockett, `MOO03.ZSM`) played persistent noise/crackle on the Apple //e player (user: 「還是有雜音啊~ (pcm部份)」), while `tools/melodius.exe` rendered the same `.zsm` cleanly.
- **Root cause #1 — 16-bit PCM was walked as bytes.** `tools/zsm_pcm_resample.mjs`'s `parseZsmPcm` computed `bytesPerFrame` as "stereo ? 2 : 1", dropping the sample width: mono16 (geometry `format = 2`) got a 1-byte frame, so the de-interleaver and area decimation walked Crockett's 16-bit drum byte-by-byte and emitted hash (the decimated data was visibly `15 71 04 d2 …`). Fixed to `channels × sampleBytes` — `(format & 1 ? 2 : 1) * (format >= 2 ? 2 : 1)` — so mono16 strides 2 and stereo16 strides 4. This is what made the drum "all noise" rather than merely quiet.
- **Root cause #2 — the FIFO byte rate, not the emulator.** The collection's mixed songs run drums at VERA rates up to 128 (mono16 → **97,656 B/s**, 2.45 full FIFOs per 20 ms). Each FIFO byte costs the 6502 ~22 cycles, so at 1.02 MHz anything above ~16-20 kB/s starves the FIFO. M40/M41 only fixed TREE's own rate; the drum samples of the other songs still dropped.
- **Fix — one general build-time cap** (`capZsmPcmByteRate(buf, 16000)` in `tools/zsm_pcm_resample.mjs`, applied by `build_melodius.mjs` to every song with a PCM table):
  - `scanPcmEvents` walks the tick stream (with the **one-byte** `$81-$FF` delay walk) to collect every rate event and the instruments actually triggered, then scales **all** rate bytes by `capBps / maxBps` and area-decimates the sample data by the inverse ratio. Duration (`bytes / rate`) is preserved by construction, so the tick stream needs no re-timing and the pitch is unchanged.
  - `shrinkPcmData` rebuilds **each unique `(offset, length)` span once**, so exact duplicates share the copy and partial overlaps (Rising Blue Lightning inst 1 @6466 vs inst 3 @6467, same 12,932-byte length) no longer trip the old "instruments overlap" guard.
  - Rate bytes `> 128` fold to `256 - r` (matching `VERAAudio::WritePcmCtrl`); a source rate of **0 stays 0** (it stops the FIFO — zsmkit parks the channel that way), positive rates clamp to 1..127, and the cap is a no-op for songs already under budget. `--list` prints `[PCM 97656->16022 B/s]` per song.
  - All 27 mixed songs cap at **16,022 B/s**; TREE is `27,847 -> 16,022` (rate **42**, superseding M41's rate 21). `PCM01.PCM` = 844,578 B, Crockett's `MOO03.PCM` = 9,418 B, zip 3,959 KB. **Superseded by M43**: the user still heard a slight stutter at 16 kB/s, so the cap moved from a byte budget to the jukebox's 8 kHz sample rate.
- **ESC / stop leaves no lingering audio.** `src/zsmstream.asm` flushes the PCM FIFO on stop (`PT_START` sets AudioCtrl bit 7 before refilling; `PCM_KEY_OFF` writes a bare `$80` and clears PCM_ACTIVE), and every exit path (ESC/Q, EOD, error) runs `PCM_KEY_OFF` / `PCM_CLOSE` / `FM_KEY_OFF` / `SILENCE_ALL` / `CLOSE_STREAM` / `IRQ_OFF`. Verified with a WAV dump killed mid-PCM at ~12 s: the remaining 8 s of the capture are exactly zero.
- **`tools/melodius.exe` status line** now matches the requested layout — no filename: `mm:ss/mm:ss [===============>] [FM ........] [PSG ======#....] [PCM --] V:15 FM:1.00 PSG:2.00 PCM:2.00 [1SHT]`, with separate FM (8 ch) / PSG (16 ch) / PCM (L+R) meters.
- **Verification (AppleWin headless, 1.02 MHz, no `-log`)**:
  - TREE (rate 42): `pushed 16022 popped 16022 underrun 0 fifo 4095`; envelope corr **0.9948** vs the `melodius.exe --wav` reference, 0 dropout frames out of 525.
  - Crockett: the mono16 drum single-hit now matches the reference waveform at corr **0.999** (peak 8,020 vs 8,032) instead of hash. A probe-free rebuilt `Release\AppleWin.exe` playing the rebuilt image at 1.02 MHz gives RMS 2,272 → 3,896 with peaks near full scale and no silence.
  - Trigger audit: 27 PCM songs, 105 trigger events, **0 out-of-range** instrument indices, so `zsmstream.asm`'s missing `instMax` check never fires for this collection (still absent, matching the engine's original behaviour).
- **Measurement traps** (cost hours):
  - Mixed PSG/FM/PCM dumps are **not reproducible** sample-wise (same image and flags twice correlate at 0.257). Use envelope correlation for mixed tracks and absolute RMS for level.
  - AppleWin's FIFO "underrun" counter counts frames with an empty FIFO, including intentional silence between one-shot drums; only a continuous sample (TREE) makes `underrun == 0` a meaningful pass.
  - `-log` adds an `fopen` per FIFO byte and pushes the run below real time; never measure feed rates under `-log`. Bulk ports DATA0 (`$03`) and the PCM FIFO (`$1d`) are now excluded in `VERACard.cpp`.
  - Align `emu[k] ↔ truth[k - lag]` (the dump trails the reference); the opposite sign fabricates ~0.5 s of dropouts.

### Milestone 43: every PCM song at 8 kHz + 16→8 bit — matching the jukebox's proven rate (2026-10-23)
- **User request**: Crockett's PCM still had a slight stutter at 16 kB/s (「會有點小頓~ 沒原先x16那樣流暢... 1.02mhz不夠力」), so 「你再降sample rate吧~ 像 jukebox.hdv 裡面的 pcm都降到 8k了」. The jukebox's `pcmstream.asm` ships `RATE_VAL = 21` = **8,011 Hz**; that is the proven load, and M42's 16,022 B/s cap was still twice it for 8-bit samples.
- **Fix — cap by sample rate, not bytes**: `capZsmPcmByteRate(buf, 16000)` became **`capZsmPcmSampleRate(buf, 21)`** in `tools/zsm_pcm_resample.mjs`, and `build_melodius.mjs` passes `PCM_RATE_MAX = 21`. Two things happen in one pass:
  - **Rate scaling**: every rate event is scaled by `21 / maxRate` (rates > 128 fold to `256 - r`; 0 stays 0), and the data is area-decimated by the inverse, preserving pitch and duration exactly as before.
  - **16→8 bit re-quantization** (new `to8Bit()` + `convertTo8` in `shrinkPcmData`): after decimation the signed 16-bit samples are rounded to signed 8-bit with deterministic TPDF dither (±1 LSB), and the entry's geometry byte is rewritten `format - 2` (mono16→mono8, stereo16→stereo8). This halves the FIFO drain and the companion size *at the same sample rate*, which is what makes mono drums cost 8 kB/s instead of 16 kB/s. Loop points are byte offsets, so they scale by `ratio × (converted ? 2 : 1)`; the dedupe key now includes `sampleBytes` so a 16-bit and an 8-bit view of the same span are not shared.
  - `depthReduced` triggers the conversion pass even when a song is already at ≤ rate 21 (e.g. DUM04/DUM05 run rate 128 mono8 → 21 with no depth change).
- **Result**: all 27 PCM-bearing songs are capped; 22 mono songs now cost **8,011 B/s**, the five stereo ones (Headbanger!, Journey Begins, Rising Blue Lightning, stage21, Ocean Palace) **16,022 B/s** because stereo doubles the bytes at the same rate. 10 songs are re-quantized 16→8 bit (CRP10, CRP15, GTR06, GTR09, MOO03, DUM01, DUM02, DUM03, DUM06, DUM09). Companions: `PCM01.PCM` 844,578 → **422,872 B**, `MOO03.PCM` 9,418 → **6,765 B**, `DUM02.PCM` → **7,908 B**; the image zip is **3,630 KB**.
- **Offline quality check** (Crockett, the song the user reported): the 8 kHz mono8 companion vs the previous 16 kHz mono16 build, both `melodius.exe --wav` renders of 144.02 s — 20 ms envelope correlation **0.9999**, RMS ratio **0.9957 (−0.04 dB)**; the 16→8-bit dithered step alone (drum instrument vs the same source decimated to 16-bit at the same ratio) measures **SNR 29.0 dB** (peak 18,345/32,767). The quantization sits far below the FM/PSG mix.
  - **Trap:** `melodius.exe` cannot read the companion `.PCM`, so rendering the image's split ZSM alone yields FM/PSG only. An earlier "corr 0.991 / RMS −1.9 %" figure came from comparing such a PCM-less render — join `MOO03.ZSM` + `MOO03.PCM` first, then render.
- **Emulator re-check** (after the image was released): headless 1.02 MHz Crockett autoplay logs `$C21C` alternating `$15` (rate 21) and `$00` (54 writes) plus 56 `$C21B` control writes; the `-fm-wav-dump` capture has no zero sample runs after the boot silence, and the installed `MOO03.ZSM/.PCM` are byte-identical to the independently extracted conversion. The 20 s dump is wall-clock paced, not 1:1 with guest time, so envelope cross-correlation against a reference is invalid there — only dropout detection is.
- **`--out <path>`** was added to `build_melodius.mjs` so a rebuild can target a different image while `melodius.hdv` is mounted by a running emulator (the write fails with `EBUSY` otherwise).
- **Verification caveat**: a second AppleWin instance does not advance while the user's interactive emulator holds the audio device, so emulator checks have to wait until the image is released.

### Milestone 44: In-song Melodius header — title/duration/dash rule + live loop state (2026-10-23)
- **User request**: the playing screen was too bare (「太單調. 只有status那欄. 你看 jukebox.hdv 上面還有顯示 song info」), then 「鍵盤指示顯示在title下方好了, 跟 jukebox.hdv 的ui對齊」, 「title和鍵盤指示中間可以用 ------------------ 來分開」, and 「title 右邊沒寫 音樂的時間 (mm:ss) ? (jukebox有)」.
- **Layout** (`SHOW_INFO` in `src/zsmstream.asm`, 40-column page written directly):
  - row 0 `$0400`: `MELODIUS  ` brand + category label (external-name mode only).
  - row 1 `$0480`: ProDOS song name, then the `(m:ss)` length **right-aligned to column 39**.
  - row 2 `$0500`: 40 `-` characters.
  - row 3 `$0580`: `ESC=EXIT  P=PAUSE  M=MUTE  R=RESTART`.
  - row 4 `$0600`: `+/-=VOL  L=LOOP: ON/OFF  [/]=SEEK 5S` — the 3-char tag is rewritten in place by `SHOW_LOOP_TAG` on every `L` toggle, so the mode is always visible.
  - row 23: the existing status line (`T: mm:ss.s [seek bar] V:nn`), unchanged.
- **Duration plumbing**: `zsmDuration(data, tickRate)` in `tools/build_melodius.mjs` scans the ZSM tick stream (`<0x40` +2, `0x40` EXTCMD `+1+(ext&0x3f)`, `0x41-0x7F` `+1+(cmd&0x3f)*2`, `0x81-0xFF` holds) and formats `m:ss`; the menu BASIC pokes it into `INFO_DUR = $6850` (NUL-terminated) next to the existing title (`$6818`) and category (`$6828`) buffers.
- **Assembler trap — undefined branch labels silently fall through.** Deleting the `SI_RULE` label while `BEQ SI_RULE` branches remained made the title loop run past its NUL into the next buffer, printing `CROCKETT…FURN: MOOINGLEMUR@@****@@` on row 1: `asm6502.mjs` resolves an undefined branch target to `NaN → 0` and emits a relative offset of 0 (a no-op fall-through), with no error. `build_melodius.mjs` now runs `branchGuard(source)` and fails the build for any `BNE/BEQ/BPL/BMI/BCC/BCS/BVC/BVS` whose label is not defined (`zeroGuard` only covered absolute operands).
- **Startup menu credit** is now `BY ANOMIXER https://github.com/anomixer` (39 columns, the widest form that fits a 40-column row).
- **Verified** on the installed image: headless boot shows the two-level menu; the real keyboard path (`3` + ENTER → `1` + ENTER) starts `CRP01.ZSM` and shows `MELODIUS  FURN: CRISPS` / `01-TITLE …… (1:55)` / the dash rule / `L=LOOP: ON`; the 20 s FM/PCM dump after the rebuild still has non-zero per-second RMS (2.0–5.7 k) with no silence run.
- **Duration-parser fix (same day) — the exe is the reference.** The first `zsmDuration` mis-walked the tick stream: it advanced **2** bytes after a PSG command (`cmd < 0x40`) instead of **1**, so the cursor lost sync at the first PSG write — after which arbitrary payload bytes were read as delays. The EXTCMD skip was also missing the ext byte itself, and the tick rate was read from header bytes 13–14 instead of 12–13. Symptoms in the first release: `MAZE (76:23)`, `KRAID (126:19)`, `WATCHING PAINT DRY (106:57)`, `BLANKPAGE (0:00)`. Correct walk: PSG `+1`, EXTCMD `+1 + (ext & 0x3f)`, YM batch `+2*(cmd&0x3f)`, `0x80` ends, `0x81-$FF` adds `cmd & 0x7f` ticks; display divides by **60** (the exe's and the player stopwatch's reference clock — 93 of 94 songs declare 60 ticks/s; BlankPage declares 64, so its label 9:46 follows the exe while real playback runs 9:09).
  - Cross-checked against `tools/melodius.exe` full renders: MAZE 13,322 frames = 3:42, KRAID 5,377 = 1:30, 01-TITLE 6,914 = 1:55, Watching Paint Dry 11,296 = 3:08, BlankPage 35,163 = 9:46 — every label matches to the second.

### Milestone 45: Tick-rate normalization — Headbanger (240 Hz) plays at the right tempo; durations use the header rate (2026-10-23)
- **Symptom** (user): 「melodius apple的 headbananger!.zsm 聽起來太慢, exe版就很順」 — the Apple //e player ran Headbanger ~4× slow while `tools/melodius.exe` was fine, and the exe label said **17:34**.
- **Root cause — one ZSM tick per VSYNC.** The IRQ published one decoded frame per 60 Hz VERA VSYNC, and `DECODE_FRAME` decoded exactly **one** tick per call. That is only correct for 60 Hz streams: Headbanger's header declares **240 ticks/s**, so one tick per 60 Hz frame stretched it 4× (and the menu's `/60` label agreed, hiding the mismatch).
- **Fix — zsmkit's normalization model** (`src/zsmstream.asm`): the decoder, not the IRQ, decides how many source ticks belong to each 60 Hz output frame. `READ_HEADER` splits the rate into `TICKS_PER_FRM = tickRate/60` and `TICK_REM = tickRate%60`; each `DECODE_FRAME` accumulates `FRAC += TICK_REM` (carry adds one tick) and runs `DECODE_ONE_TICK` that many times, merging all writes into the same `[psgCnt][pairs][ymCnt][pairs]` frame. Rates below 60 yield zero-tick frames that publish a hold frame (`psgCnt=$FF`), so 50/52/56 Hz songs still advance at real time. The IRQ now unconditionally consumes one published frame per VSYNC (the old rate gate is gone).
- **Consequences**: `FRM0/1/2` count **source ticks** again (incremented in `DECODE_ONE_TICK`), so the 5 s seek keys use `SEEK_CNT = 5 * TICKRATE` (`CALC_SEEK_TICKS`) instead of a hard-coded 300. Hold slots (`$81-$FF`) are consumed inside `DECODE_ONE_TICK`; EOD publishes the partial merged frame before the loop seek.
- **Duration labels were also wrong — the exe is not the reference here.** `tools/melodius.cpp` printed `totalFrames/60` and its offline `--wav` loop rendered `totalFrames` frames, but `totalFrames` counts **stream ticks at `tickRate`**; `render_frame()` advances `tickAccum += tickRate/FPS`, so real seconds are `ticks/tickRate`. For 240 Hz the info/WAV were 4× too long (1054.6 s instead of 263.6 s). Same bug in `zsmDuration()` (`build_melodius.mjs`). Both now divide by the header rate (bytes 12-13, fallback 60). 11 of 94 songs are non-60 Hz: 50 (3), 52 (2), 56 (1), 64 (2), 67 (1), 68 (1), 240 (1).
- **Labels after the fix**: Headbanger **(4:24)**, Groove (50 Hz) **(1:09)**, Shades of Blue (64 Hz) **(3:44)**; 60 Hz songs are unchanged. User-facing check on the installed image: the in-song header shows `HEADBANGER! … (4:24)` and `GROOVE … (1:09)` (screenshots via `tools/menu_probe.ps1`).
- **Verified**: `melodius.exe Headbanger!.zsm --no-loop --wav` now writes 12,655,200 stereo frames = 263.6 s, and that file is **byte-identical to the first 263.6 s** of the old 1054.6 s render (the old tail was static). In AppleWin at 3 MHz the reference's 12.0 s section lands at ~13 s (4× slow would put it at ~48 s); at the default 1.02 MHz the 240 Hz decode still fits (continuous per-second RMS 2.4–3.2 k, zero-run32 fraction 0.00004), confirming the merged decoder costs no more per output frame than a 60 Hz song.
- **Regression runs at 3 MHz**: 60 Hz (BEN01) peak 26452, continuous RMS; 64 Hz Shades of Blue (510-byte merged frames) peak 32397; 50 Hz groove peak 29552 — no crashes, no dropouts, buffer fits 512 B with the largest merged frame at 510 B.

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
| `psgplay.exe` | Win32 C (x86) | Native Windows real-time VERA PSG player (WinMM waveOut, 48kHz stereo); `--wav out.wav` renders offline |
| `psgplay.c` | C | Source code for native Windows VERA PSG stream player |
| `build_psgplay.bat` | Windows CMD | MSVC build script for compiling `psgplay.exe` |
| `ftmplay.exe` | Win32 C++ (x64) | Standalone 2A03 FTM parser, VERA PSG synth, and WinMM player; no FamiStudio/Node/FamiTone runtime |
| `ftmplay.cpp` | C++ | Source for native FTM parser, PSG synth, and Windows audio player |
| `build_ftmplay.bat` | Windows CMD | MSVC build script for compiling `ftmplay.exe` |
| `zsm2psg.mjs` | Node.js | Commander X16 ZSM (VERA PSG + YM2151 FM) → 60Hz PSG stream converter |
| `melodius.exe` | Win32 C++ (x86) | Native Windows Commander X16 music player (VERA PSG + YM2151 FM via ymfm + VERA PCM, WinMM waveOut 48kHz stereo; `.zsm` and `.zcm`) |
| `melodius.cpp` | C++ | Source code for the native Windows Melodius player |
| `build_melodius.bat` | Windows CMD | MSVC build script for `melodius.exe` |
| `zsmstream.asm` | 6502 ASM | Apple //e ZSM jukebox engine — streams `.ZSM` from ProDOS, normalizes the header tick rate into 60 Hz frames, plays PSG + YM2151 FM + PCM FIFO |
| `build_melodius.mjs` | Node.js | Assembles `zsmstream.asm` (slot 2/4), splits/decimates PCM companions, generates the two-level menu BASIC, packs `melodius.hdv` + `.zip` (`--list`, `--autoplay <idx>`, `--out <path>`) |
| `zsm_pcm_resample.mjs` | Node.js | Build-time PCM decimator — caps every song at VERA rate 21 (8 kHz) and re-quantizes 16-bit instruments to dithered 8-bit |
| `src/melodius/*.bas` | Applesoft BASIC | Generated jukebox menus (`STARTUP.bas` category list + one file per category) |
| `zsmplay.asm` | 6502 ASM | Legacy FM bring-up player (embedded event stream); `build_zsmplay_po.mjs` packs `zsmplay.po` locally — that image is not committed |
| `zsm_scan.mjs` | Node.js | ZSM event composition analyzer (PSG/YM register histograms) |
| `zsm_pan.mjs` | Node.js | ZSM stereo panning usage analyzer |
| `mid2psg.mjs` | Node.js | Standard MIDI File (.mid) → 60Hz PSG register stream converter |
| `mod2psg.mjs` | Node.js | ProTracker MOD → 60Hz PSG register stream converter |
| `ftm2psg.mjs` | Node.js + FamiStudio | FamiTracker/FamiStudio FTM → audio-derived 60Hz VERA PSG stream (all channel stems) |
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

# Build native Windows players
tools\build_psgplay.bat
tools\build_ftmplay.bat
tools\build_melodius.bat

# Manual conversions
node mod2psg.mjs space_debris.mod --no-wav
node render_hybrid.mjs space_debris.mod --no-wav
node mid2psg.mjs Fantaisie-impromptu.mid --no-wav
node wav2pcm.mjs alexander-nakarada-the-wellerman.mp3 wellerman_full.pcm --rate=21 --no-wav

# Assemble disk images
node tools\build_jukebox.mjs

# Apple //e ZSM jukebox (melodius.hdv + .zip). --list prints the song index
# table; --autoplay <idx> writes a temp headless test image to %TEMP%.
build.bat melodius
node tools\build_melodius.mjs --autoplay 23

# Play the jukebox in the AppleWin VERA fork (the HDV goes on the hard-disk
# slot — never as a floppy)
Release\AppleWin.exe -s2 vera -s7 hdc -h1 C:\dev\veramusic\melodius.hdv -power-on
```

## File-Level I/O and Cadius Migration (2026-10-11)

- `psgstream.asm` and `pcmstream.asm` now open streams by relative ProDOS pathname and use bounded MLI `READ` calls. PSG reads check actual transfer lengths and reject unterminated/truncated streams; PCM reads use actual end pointers, respect short final reads and EOF, and use `SET_MARK` for logical 512-byte seek offsets. Both close references on exit and error.
- `psgvram.asm` opens `FANTAISIE.PSG` through the active ProDOS prefix, reads sequentially, copies only transferred bytes into VERA SRAM, and caps the preload before the PSG/audio register region. If ProDOS has an empty prefix, it qualifies the filename with the boot volume name.
- Runtime reads use application-scoped paths resolved against the active prefix; files with duplicate names elsewhere on the volume are not searched.
- `tools/build_jukebox.mjs` no longer edits ProDOS directory entries, index blocks, or bitmaps. It copies clean bootable baselines to a temporary directory, uses bundled `tools/cadius.exe` to rename/delete/add files, then runs strict `CHECKVOLUME` and `CATALOG` checks. `CADIUS` remains overridable.
- Music is packaged as ordinary ProDOS files, including tree-structured PCM files. The README documents the complete copied install set and the active-prefix requirement for nested installs.
- Verified: both images rebuilt successfully through Cadius; `CHECKVOLUME` reported no allocation errors. Apple II emulator playback and copied nested-directory execution are still separate integration checks.

## Release R7 Packaging (2026-10-11)

- Both `src/startup.bas` and `src/startup_po.bas` display R7.
- `tools/build_jukebox.mjs` produces `jukebox.po`, `jukebox.hdv`, and `jukebox.hdv.zip`. The former `sd_install/`, `sd_install.po`, and `sd_install.hdv` outputs were removed from the build.
- PCM tracks 5 and 6 retain the SD4 player. Vera SD playback at the intended pace depends on the optimized resident driver from `verasdtool`.

## FamiStudio FTM to VERA PSG Converter (2026-10-12)

- Added `tools/ftm2psg.mjs`: asks FamiStudio for separate 44.1 kHz voice WAVs, estimates pitch/volume per 60 Hz frame, and writes the standard VERA `.psg` event stream.
- Supports `--noise-gain=N` (default 1.0), `--mute-noise`, `--gain=N` (master trim) and `--no-normalize`; options also accept the space-separated form because cmd splits batch arguments at `=`. Uses `FAMISTUDIO` or common Windows install paths to locate FamiStudio.
- This is an audio-derived approximation, not register-exact FamiTone2/APU emulation. Sample channels (DPCM) cannot be expressed as PSG registers and are reported, not encoded.
- Validate each output with `node tools/check_psg.mjs <file.psg>` or via `build.bat ftm`.

## Standalone FTM player (2026-10-12)

- Replaced the temporary `ftmplay.exe` wrapper with a native C++ player in `tools/ftmplay.cpp`. It parses FTM 0.4.2–0.4.6 directly and synthesizes the 2A03 pulse, triangle, and noise channels through the VERA PSG software model. It uses WinMM for live output; no FamiStudio, Node.js, FamiTone, or companion player is needed at runtime.
- Supports 2A03-only five-channel FTM projects. Expansion-chip voices and DPCM samples are omitted. CLI: `ftmplay.exe file.ftm [song-index] [--vol 0..15] [--solo 0..3] [--wav out.wav]`; `--list` shows song names.
- Build with `tools/build_ftmplay.bat` (MSVC x64, statically linked CRT).
- Bundled the source modules as `music/alterego-simpl0r.ftm` and `music/alterego-sounds.ftm`, so the player examples and tests do not need a sibling checkout. The WAV-derived `Ae-*.psg` examples were removed; only the source FTM modules are bundled. The standalone renders Title to 19.4 s (FamiStudio stem converter: 19.35 s) and Level 1 to 48.0 s (converter: 47.93 s). Also rendered Game Over and the separate sounds/start tune. Live WinMM playback was smoke-tested.
- Fixed FTM octave conversion to use the FamiTracker note-table indexing: pulse uses 32.7032 Hz at octave 0, while triangle uses 16.3516 Hz because the same timer period runs through twice the divider. For timbre closer to the established `.psg` output, pulse voices use 25% duty, triangle level was raised, and noise maps FamiTracker's inverted NES 16-step period table directly to the corresponding APU timer rate, capped at VERA's maximum PSG frequency; noise arpeggio changes the period index. FamiStudio uses its bundled NesSndEmu 15-bit APU LFSR and Blip_Buffer resampling; VERA has a different fixed noise generator, so its timbre cannot exactly reproduce the FamiStudio WAV.
- Corrected FamiTracker effect IDs (`B` jump, `D` break, `C` stop, `F` speed/tempo); effect `4` is no longer mistaken for song end. Level 2's `LightVibd1` uses relative pitch sequence deltas (`+2`, `+2`, `+2`, then negative values); the player now accumulates each delta into the 2A03 timer-period offset, matching FamiStudio's `ChannelState.UpdateEnvelopes`. Added `--solo 0..3` for listening to individual NES voices. Rebuilt and rendered Level 2 (43.2 s). The 2A03 0..15 volume envelope is now mapped through the inverse VERA logarithmic volume table, fixing the nearly inaudible low-volume noise hits. Live playback streams 50 ms buffers so volume controls work during play, and displays elapsed/total time plus four channel VU meters; controls are P pause, Space next song, M mute, +/- volume, Q/Esc quit. WAV output stays offline and honors `--vol`. User auditioned the direct-period noise mapping in `build/level2_noise_famistudio_ref.wav` and approved it on 2026-10-12; keep this as the accepted noise setting.

### All stems are converted, not just the NES 2A03 four

The first version carried a hardcoded 4-entry `VOICES` table (Square1, Square2, Triangle, Noise). Any song using an expansion chip therefore lost channels silently — a fair test song produced **8** stems and only 4 were mapped, including dropping the loudest one (`VRC6Saw`, stem RMS 0.0931).

- The stem list is now **discovered** by globbing whatever `wav-export -wav-export-separate-channels` produced. Names map to waveform families: `saw`→VERA sawtooth `0x40`, `tri`→triangle `0x80`, `noise|tnm`→noise `0xC0`, `square|pulse`→pulse `0x20`; anything containing `dpcm|pcm|sample` is treated as a sample channel and reported.
- Voice order is fixed by a `PREFERRED_ORDER` list (2A03 first, then VRC6, Sunsoft, FDS, Namco) so PSG voice indices stay stable across songs of the same project. Capped at the VERA PSG's 16 voices with a warning.
- Conversion of the same `Nice.fms` test song went from **4 stems / Triangle 0% active** to **7 stems / Triangle 63.7%, VRC6Saw 100%**.

### Pitch detection: autocorrelation replaced by FFT (measured, not guessed)

The converter originally estimated pitch with normalized autocorrelation over a two- then three-frame window, plus an "octave correction" that walked toward longer periods and accepted the first lag within 85% of the best correlation. **Both the original heuristic and that correction are fundamentally invalid on musical signals**: for a periodic signal, *every integer multiple of the true period also correlates at ~1.0*, so "take the first local maximum" or "walk toward longer periods" lands on an arbitrary multiple rather than the fundamental.

Measured against an independent ground truth (743 ms Hann FFT, 1.35 Hz bins, accepted only when the long window also agrees with itself ±20 frames so note changes and vibrato do not contaminate the comparison), on the Alter Ego stems:

| stem | 3-frame autocorrelation | FFT 4096 |
|---|---|---|
| Triangle | median error **1153.8%**, 1.8% correct (up to 28x, audible as shrill squeal instead of a bass line) | median **0.2%** (3 cents), **92.1%** correct |
| Square1 | median **71.9%**, 5.5% correct | median **0.1%** (1 cent), 63.6% correct |
| Square2 | median **74.5%**, 11.3% correct | median **1.1%** (18 cents), 58.9% correct |

The Square percentages plateau near 60% because Alter Ego has a vibrato instrument: the long truth window reports the centre of the vibrato while the detector reports the instantaneous pitch, which is the behaviour we want. **The meaningful figure is the 1-3 cent median, not the percentage.**

- The detector is now a Hann-windowed FFT over a 186 ms window centred on the frame, with parabolic interpolation on log magnitude for sub-bin accuracy and a harmonic-to-fundamental correction that walks subharmonics k=8..2, taking the lowest one whose neighbourhood peak reaches 55% of the maximum. Testing a single bin for the subharmonic fails because its energy lands between bins.
- Window size matters: 4096 (186 ms) beat 2048 decisively on Square2 (1.1% vs 19.4% median error) because a 28 Hz bass fundamental needs >5 periods to be measurable at all. The stems are decimated 2:1 (3-tap [1,2,1] lowpass) so 4096 points at 22.05 kHz span the same time and give the same 5.38 Hz bin spacing as 8192 points at 44.1 kHz, at half the cost.
- A per-voice **pitch memory** still holds the last good frequency when a frame yields no peak, bridging note onsets instead of chopping notes off.
- After the fix the Alter Ego title's triangle channel writes 28 Hz min / 62 Hz median / 165 Hz max — a real NES bass line — instead of the ~690 Hz median the autocorrelation produced.

A previous `centeredEnergy < 1` gate also had to go: with only 367 decimated samples that is an RMS threshold of ~0.052, so a channel averaging 0.0136 could never pass and the triangle was muted for the entire song. The gate is now relative to the sample count.

### Unused channels are not silent: DPCM bleed

FamiStudio's `-wav-export-separate-channels` emits a stem for **every** channel, including unused ones, and an unused channel's stem is **not silence**. FamiStudio's `SeparateChannelsExportTndMode` setting bleeds DPCM samples into the triangle and noise channels.

On `Nice.fms` song "Title" the Triangle channel holds **zero patterns** (the text export shows its `Channel Type="Triangle"` block occupying a single line, immediately followed by `Channel Type="Noise"`), yet `st_Triangle.wav` renders at RMS 0.0136 with 58% of frames non-zero. Its spectrum peaks at 26.9 Hz and 177.6 Hz at 0 dB each, spaced 6.73 Hz apart — that is the kick and snare **samples**, not a bass line. Converting it produced a PSG voice playing drums on a triangle wave at ~30 Hz, which is what "the triangle is all wrong" actually was. A long investigation into pitch-detection accuracy on that stem was chasing the wrong thing entirely.

The fix uses `famistudio-txt-export` purely as a **channel occupancy map** — how many notes each channel has. Stems whose channel has zero notes are skipped with a warning. Tempo is not needed for this, and the text export carries none (only `famistudio-asm-export` has it, as `$47`/`$73` inside otherwise-binary note tables).

After the fix `Nice.fms` converts 6 voices instead of 7, and the bass line lands correctly on `VRC6Saw` at 40-249 Hz.

### Level matching is per voice

A single global `peakRms` normalized against all stems meant one loud channel crushed every quiet one to silence. Each voice now gets its own reference, and the volume divisor is the geometric mean of that voice's typical level and the loudest voice's, which lifts quiet stems toward audibility without flattening the mix. `--no-normalize` restores raw relative dynamics.

### Build pipeline

- `build.bat ftm <in.ftm> [songIndex] [out.psg] [options]` converts and validates a FamiStudio project. It does **not** repack `jukebox.po`/`jukebox.hdv`.
- Two cmd quirks had to be worked around: `%2` arrives with its quotes when the batch file is invoked from PowerShell (use `%~2`), and `--opt=value` is split at the `=`.
- `psgplay.exe` gained `--wav <out.wav>` (canonical 44-byte header) so PSG streams can be rendered offline and A/B'd against a reference, matching `melodius.exe`.

### Bundled Alter Ego reference (`music/alterego-simpl0r.ftm`)

Song order: 0 Title, 1 Level 1, 2 Level 2, 3 Level 2 Alt, 4 Level 3, 5 Level 4, 6 Level 5, 7 Game Over, 8 Congratulations, 9 Level Clear. These use the plain NES 2A03 four, so all stems convert. The user-auditioned mix used noise gain 1.2 for TITLE and 1.0 for LEVEL1–LEVEL5.

### FTM noise-period export (2026-10-12)

- `ftmplay.exe` accepts `--noise-freqs <path>` to export the FTM's per-frame
  VERA noise frequencies at 60 Hz. This uses the same inverted NES APU noise
  period mapping as the standalone audio renderer and does not open audio.
- The export can be consumed by a PSG patcher such as
  `alter-ego/tools/patch_psg_noise_from_ftm.mjs`, which updates only voice 3
  frequency registers in an existing `.psg` stream. The FamiStudio-derived
  volume envelope and the other three voice streams stay intact. `psgplay`
  already applies the stream's frequency register writes; this optional
  integration does not add a dependency to `veramusic`.
- Rebuilt `tools/ftmplay.exe` with `tools\build_ftmplay.bat`. The altered
  Level 2 `.psg` renders through `psgplay.exe --wav` as 2,589 frames / 43.1 s.

### Milestone 46: ZSM → VZM export path for `veratest` (A2VERA stream format) (2026-10-24)

- `veramusic` keeps the Commander X16 `.ZSM` tracks as the source of truth, and its own Apple //e player (`src/zsmstream.asm`, the `melodius.hdv` jukebox) reads them **directly**, tick-rate normalised from the header.
- The sibling [`veratest`](https://github.com/anomixer/veratest) repository reuses three of those tracks (`SB-INTRO`, `CANYON`, `GREENHILL`) in its 140 KB demo disk and 32 MB slideshow. Its players are too small to carry a ZSM parser, so `veratest`'s build (`src/zsm2vera.mjs`) converts each `.ZSM` into **VZM** — "VERA ZSM", an A2VERA-oriented derivative rather than a second encoder. The music is the same: every PSG write and every YM2151 write is re-packed in original order, so the daughterboard receives what the tracker emitted.
- VZM record layout (no header; length comes from the ProDOS file size):
  - `$00..$7F` delay — byte `N` adds `N` further ticks; a ZSM delay of `D` ticks is stored as `D - 1`.
  - `$80..$BF` PSG write — register `= byte & $3F` (`$1F9C0 + reg`), followed by 1 value byte.
  - `$C0..$DF` YM2151 batch — pair count `= (byte & $1F) + 1`, followed by `count` × (register, value).
  - `$E0..$FE` block padding (records never straddle a 512-byte ProDOS block); `$FF` ends the stream and the player loops from offset 0.
- Why the indirection: no ZSM parser in the 6502 player, YM2151 address/data pairs pre-batched, the PSG and FM halves separated so a card without the FM chip skips the FM records with one branch, per-track mix curves (CANYON's percussion/melody balance) baked into the stream, and duplicate register writes dropped.
- The YM2151 key register `$08` is copied **verbatim** and never de-duplicated: operator mask in bits 6..3, channel in bits 2..0, bit 7 ignored, and a zero mask releases the operators. This matches `tools/zsm2psg.mjs` and ymfm (`ymfm_opm.cpp`: `channel = bitfield(data,0,3); opmask = bitfield(data,3,4)`). Rewriting it into a bit-7 key flag turns every key-off into a key-on, so each FM channel sounds once, decays, and never retriggers — this was a real bug fixed in `veratest` on the same day.
- Provenance of the shipped streams: 0 mismatched ticks out of 31,147 across the three tracks (`SB-INTRO` 20,385 / `CANYON` 7,570 / `GREENHILL` 3,192), verified by `veratest`'s `node src/verify_music_streams.mjs`, which rebuilds the streams, diffs them against the packaged `.vzm` files and replays both the raw ZSM and the converted stream register-image by register-image.
- Sizes: `SB-INTRO` 346,425 B → 347,136 B (678 blocks), `CANYON` 129,168 B → 124,416 B (243), `GREENHILL` 22,337 B → 18,432 B (36). Raw `GREENHILL.ZSM` would need 44 blocks, which does not fit the demo floppy's remaining 4; the 32 MB slideshow would fit either.
- `veratest` documents the format in its `AGENTS.md` §4.4 and `README.md` ("The VZM Stream Format (ZSM → A2VERA)"); the players are `src/slideshow/slideshow.asm` and `src/veratest/sonic.asm`. `veramusic` itself is unchanged by this milestone — it remains the ZSM producer and the direct-ZSM reference player.
