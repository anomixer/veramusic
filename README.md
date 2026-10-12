# VERA Music (veramusic)

**High-Fidelity Audio Engine & Jukebox Suite (Release R7) for Apple II with VERA Card**

[![Release](https://img.shields.io/badge/release-R7-blueviolet.svg)]()
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Apple%20II%20%7C%20IIe%20%7C%20IIgs-orange.svg)]()
[![Hardware](https://img.shields.io/badge/hardware-VERA%20Card%20(Slot%202%20%2F%204)-brightgreen.svg)]()

`veramusic` is an end-to-end music conversion toolchain and real-time playback system for the **Apple II** family equipped with an experimental **VERA (Versatile Embedded Retro Adapter)** card in Slot 2 (`$C0A0`) or Slot 4 (`$C0C0`).

Tested on:
- **Real Hardware**: Enhanced Apple IIe, Apple IIgs, Laser 128 with VERA card.
- **Emulators**: [Apple2TS](https://github.com/ct6502/apple2ts) (WebAssembly), [AppleWin VERA Fork](https://github.com/anomixer/AppleWin).

---

## Features

- **16-Voice Polyphonic PSG Synthesis (48,828 Hz)**:
  - 16 independent hardware oscillators (Pulse, Sawtooth, Triangle, Noise).
  - Additive acoustic grand piano synthesis with detuned chorusing, frequency-dependent acoustic decay, and full damper pedal (CC 64) sustain.
  - General MIDI percussion engine synthesized across dedicated triangle/noise channels.
- **Direct-to-FIFO 8-Bit PCM Streaming (8,010 Hz)**:
  - Reads 8-bit signed PCM sequentially through ProDOS `OPEN` / `READ` / `CLOSE`, then feeds VERA's 4 KB hardware FIFO from a 512-byte buffer. ProDOS follows the file's actual allocation, including tree files.
  - CPU usage under 5% on a 1.02 MHz 6502, buffered against drive seek latency.
  - Studio-grade TPDF (Triangular Probability Density Function) dither to eliminate 8-bit quantization distortion.
- **VERA 128KB SRAM Pre-Load Player (`psgvram.asm`)**:
  - Opens the PSG stream from the active ProDOS prefix and pre-loads it into VERA's onboard 128 KB SRAM at startup (~2.5s), without assuming physical block placement.
  - **Zero Floppy Stutter**: 100% silent, stutter-free playback on standard 140KB 5.25" Disk II floppies with no drive head movement during playback.
  - Instantaneous seeking: fast-forward and rewind execute in microseconds.
- **Native Windows VERA PSG Player (`tools/psgplay.exe`)**:
  - Standalone Win32 x86 real-time player to audition `.psg` streams on Windows PC with zero external dependencies.
  - Full 16-channel VERA PSG synthesis at 48,000 Hz 16-bit stereo with live 16-voice activity meters and interactive controls.
- **Standalone Windows x64 FTM player (`tools/ftmplay.exe`)**:
  - Reads FamiTracker `.ftm` files directly and plays their 2A03 pulse, triangle, and noise channels through a native VERA PSG software model.
  - Requires only Windows; it does not invoke FamiStudio, Node.js, FamiTone, or `psgplay.exe`. DPCM sample playback and expansion chips are not supported.
- **Melodius for Windows (`tools/melodius.exe`)**:
  - A Windows port of [Melodius](https://github.com/mooinglemur/melodius), the Commander X16 music player that runs **ZSM** and **ZCM** through the X16 audio API (zsmkit).
  - Renders the same engine the X16 uses — YM2151 (OPM) FM via ymfm, the 16-channel VERA PSG and the VERA PCM FIFO — summed 1:1 and hardware-accurately scaled, so the Commander X16 mix balance is preserved.
  - 48,000 Hz 16-bit stereo with authentic L/R panning (YM2151 pan registers `$20`–`$27` + VERA PSG stereo control bits).
  - **ZSM** (`.zsm`/`.zm`): full container support — loop points, per-chip channel masks, non-60 Hz tick rates, EXTCMD PCM streams and the 8-byte PCM instrument table (mono/stereo, 8/16-bit).
  - **ZCM** (`.zcm`): ZSound PCM container — `00 00 00` signature, 24-bit sample length, geometry byte and `AudioRate` byte, then raw PCM. PCM-only, so it uses just the VERA PCM FIFO.
  - **Standard MIDI Files (`.mid`/`.midi`) are not supported by this build** — they are rejected with an explicit message. Melodius's MIDI engine has not been ported.
  - Adjustable engine gains (`--fmvol`/`F1`/`F2`, `--psgvol`/`F3`/`F4`, `--pcmvol`/`F5`/`F6`), default **1.0×** = hardware level.
  - `--wav out.wav` renders the whole track offline to a 48 kHz stereo WAV and exits, for A/B comparison against a reference render.
- **Apple //e ZSM Player (`src/zsmplay.asm` → `zsmplay.po`)**:
  - A 65C02 program that writes YM2151 FM events through the VERA card's FM daughterboard registers (`VERA_BASE + $20` register select, `VERA_BASE + $21` data/status), the Apple-side equivalent of the X16's `$9F40`/`$9F41`.
  - Bootable 140KB ProDOS floppy (`zsmplay.po`) with an auto-starting Applesoft `STARTUP` that probes for a slot-2 or slot-4 VERA card before `BRUN`-ing the player.
  - Dual-slot binaries: `src/ZSMPLAY.BIN` (slot 2) and `src/ZSMPLAY4.BIN` (slot 4), both loaded at `$2000`; exits via `RTS` so control returns cleanly to BASIC.
- **Universal Player Controls Across All Formats**:
  - `ESC` / `Q`: Clean exit.
  - `P` / `SPACE`: Real-time pause / unpause.
  - `M`: Shadowed register mute.
  - `+` / `-`: 16-level master volume scaling.
  - `]` / `[`: Universal 5-second fast-forward and rewind.
  - `F1` / `F2`: FM (YM2151) gain down / up (`melodius.exe` only).
  - Live on-screen display: 16-voice activity meter (`T: mm:ss.c [...] V:xx`) for PSG tracks; logical 512-byte file-chunk counter (`T: mm:ss.c B:xxxx V:xx`) for PCM stream tracks.

---

## Included Jukebox Lineup

### 1. Bootable 32MB Hard Disk (`jukebox.hdv` / `jukebox.hdv.zip`)
| Track | Title | Format | Duration | Technology |
|---|---|---|---|---|
| **1** | **Melody Demo** | RAM PSG | 0:30 | 6502 RAM-resident 60 Hz PSG event player |
| **2** | **Fantaisie Impromptu** | VERA RAM PSG | 5:02 | 16-voice authentic PSG lead + thunderous saw bass |
| **3** | **Beat It** | Stream PSG | 3:58 | 16-voice rock chiptune engine + GM drums + vocal blues scoop bend |
| **4** | **Caribbean Blue** | Stream PSG | 2:56 | Enya MIDI → 16-voice PSG with high choir nana vocals |
| **5** | **Space Debris** | Stream PCM | 5:05 | 8010 Hz direct-to-FIFO ProDOS disk streaming |
| **6** | **The Wellerman** | Stream PCM | 2:00 | 8010 Hz full acoustic folk ballad with TPDF dither |

### 2. Bootable 140KB Floppy (`jukebox.po`)
| Track | Title | Format | Duration | Technology |
|---|---|---|---|---|
| **1** | **Melody Demo** | RAM PSG | 0:30 | Host RAM player |
| **2** | **Chopin: Fantaisie-Impromptu** | VERA RAM PSG | 5:02 | VERA 128KB SRAM pre-loaded (zero floppy noise/lag) |

---

## Repository Structure

```text
veramusic/
├── build.bat                  # Automated build & packaging script
├── jukebox.hdv                # Pre-built bootable 32MB ProDOS hard disk image
├── jukebox.hdv.zip            # Compressed 32MB hard disk image (~2.7MB, auto-generated)
├── jukebox.po                 # Pre-built bootable 140KB ProDOS floppy disk image
├── zsmplay.po                 # Pre-built bootable 140KB ProDOS floppy (Apple //e ZSM/FM player)
├── ymfm/                      # Bundled ymfm YM2151 core (self-contained for tools/melodius.exe)
│   ├── ymfm.h                 # ymfm core base
│   ├── ymfm_fm.h              # FM engine declarations
│   ├── ymfm_fm.ipp            # FM engine implementation
│   ├── ymfm_opm.h             # YM2151 (OPM) declarations
│   ├── ymfm_opm.cpp           # YM2151 (OPM) implementation
│   └── LICENSE                # BSD-3-Clause (Aaron Giles)
├── AGENTS.md                  # Comprehensive engineering & development log
├── src/                       # 6502 assembly players & Applesoft BASIC menus
│   ├── psgvram.asm            # VERA 128KB SRAM pre-load player (PO & HDV track 2)
│   ├── psgstream.asm          # ProDOS MLI OPEN/READ stream player (PSG)
│   ├── psgplay.asm            # Host RAM-resident PSG player
│   ├── pcmstream.asm          # ProDOS MLI OPEN/READ stream player (PCM)
│   ├── pcmplay.asm            # Host RAM-resident PCM player
│   ├── hybridstream.asm       # Legacy hybrid player (not packaged by current builder)
│   ├── zsmplay.asm            # Apple //e ZSM player (VERA FM daughterboard, slot 2/4)
│   ├── ZSMPLAY.BIN            # Built player binary, slot 2 ($2000 BRUN)
│   ├── ZSMPLAY4.BIN           # Built player binary, slot 4 ($2000 BRUN)
│   ├── zsmplay_startup.bas    # Applesoft BASIC VERA slot probe → BRUN ZSMPLAY.BIN
│   ├── vera.inc               # VERA hardware register equates
│   ├── startup.bas            # Applesoft BASIC auto-boot menu (HDV)
│   └── startup_po.bas         # Applesoft BASIC auto-boot menu (PO)
├── tools/                     # Zero-dependency conversion toolchain & Windows player
│   ├── cadius.exe             # ProDOS-aware disk image packager/validator
│   ├── psgplay.exe            # Native Windows x86 real-time VERA PSG player
│   ├── psgplay.c              # Source code for psgplay (WinMM waveOut 48kHz audio)
│   ├── build_psgplay.bat      # MSVC build script for psgplay.exe
│   ├── ftmplay.exe            # Standalone Windows FTM → VERA PSG player
│   ├── ftmplay.cpp           # Native FTM parser, PSG synth, and WinMM player
│   ├── build_ftmplay.bat      # MSVC build script for ftmplay.exe
│   ├── melodius.exe            # Native Windows x86 Commander X16 ZSM/ZCM player
│   ├── melodius.cpp            # Source code for melodius (ymfm YM2151 + VERA PSG + VERA PCM + WinMM)
│   ├── build_melodius.bat      # MSVC build script for melodius.exe
│   ├── build_zsmplay_po.mjs   # Packs zsmplay.po (ZSMPLAY.BIN + STARTUP) from the ProDOS template
│   ├── zsm_scan.mjs           # ZSM analyzer (event histogram + header/PCM table dump)
│   ├── zsm_pan.mjs            # ZSM stereo panning usage analyzer
│   ├── zsm2psg.mjs            # Commander X16 ZSM → 60 Hz PSG stream converter
│   ├── mid2psg.mjs            # Standard MIDI (.mid) → 60 Hz PSG stream converter
│   ├── mod2psg.mjs            # ProTracker MOD (.mod) → 60 Hz PSG stream converter
│   ├── wav2pcm.mjs            # Audio (.wav/.mp3) → 8010 Hz VERA PCM converter
│   ├── build_jukebox.mjs      # ProDOS volume packager & automatic ZIP generator
│   └── check_psg.mjs          # 6502 cycle & register write validator
├── music/                     # Source projects and converted streams (.ftm, .mid, .mod, .psg, .pcm)
│   ├── alterego-simpl0r.ftm  # Bundled 2A03 reference module (10 songs)
│   └── alterego-sounds.ftm    # Bundled 2A03 sound-effects/start-tune module
└── scripts/                   # Audio analysis & one-off diagnostic utilities
```

---

## Building & Development

### ProDOS File-Level Portability

All jukebox audio streams are ordinary ProDOS files. `psgstream.asm` and `pcmstream.asm` use `OPEN` / bounded `READ` / `CLOSE`, check MLI status and transfer counts, and handle EOF. PCM seeking uses `SET_MARK`. The floppy Chopin player reads the same file sequentially into a 512-byte buffer and copies it into VERA SRAM before playback. Stream paths use the active ProDOS prefix; when the prefix is empty, the player qualifies the filename with the boot volume name.

Players normalize the Apple IIe to main RAM, PAGE1, and 40-column text on entry. This keeps the direct text-page UI visible when launched from A2Desktop, which uses 80-column display modes.

`hybridstream.asm` is a historical, unused hybrid-format player and is not included in the current jukebox images; its older block-based reader is outside the current file-level playback path.

`tools/build_jukebox.mjs` uses the bundled `tools/cadius.exe` to update catalogs, allocation indexes, file metadata, and volume bitmaps. It copies the bootable ProDOS baselines from the sibling `veratest/assets` directory into a temporary folder, preserves `PRODOS`, `BASIC.SYSTEM`, and `CLOCK.SYSTEM`, adds the application files, then runs Cadius `CHECKVOLUME` and `CATALOG`. Set `CADIUS` to override the bundled executable. The assembler and Applesoft tokenizer are also currently imported from the sibling `veratest/src` checkout.

For a complete copied HDV installation, copy `STARTUP`, all `TESTTUNE*.BIN`, `STREAM*.BIN`, `BEATIT*.BIN`, `CARIBBEAN*.BIN`, `PCMDEB*.BIN`, and `PCMWEL*.BIN` files plus `FANTAISIE.PSG`, `BEATIT.PSG`, `CARIBBEAN.PSG`, `SPACEDEB.PCM`, and `WELLERMAN.PCM` into one ProDOS directory. Set that directory as the active prefix before launching `STARTUP`. The floppy install needs `STARTUP`, `TESTTUNE.BIN`, `TESTTUNE4.BIN`, `STREAM.BIN`, `STREAM4.BIN`, and `FANTAISIE.PSG`. Booting the generated images alone does not replace a copied-directory install check.

`node tools/build_jukebox.mjs` writes `jukebox.po`, `jukebox.hdv`, and the compressed `jukebox.hdv.zip`. PCM tracks 5 and 6 use the SD4 player; smooth 8 kHz playback on Vera SD requires the optimized resident driver built by the sibling `verasdtool` repository.

### Prerequisites
- [Node.js](https://nodejs.org/) (v18 or newer)
- The sibling `C:\dev\veratest` checkout, which provides the 6502 assembler, Applesoft tokenizer, and clean ProDOS baselines used by `tools/build_jukebox.mjs`.
- Bundled Cadius at `tools/cadius.exe` (or set `CADIUS` to another Cadius executable).

### Master Build Command
```cmd
# Re-assemble players, update BASIC menus, and pack jukebox.po, jukebox.hdv & jukebox.hdv.zip
build.bat quick

# Full rebuild: reconvert all MIDI/MOD/PCM sources and pack images
build.bat jukebox
```

### Manual Audio Conversions
```cmd
# Convert MIDI to 60 Hz PSG stream (generates .psg and 44.1 kHz preview .wav)
node tools/mid2psg.mjs music/Fantaisie-impromptu.mid --synth=piano

# Convert ProTracker MOD to PSG stream
node tools/mod2psg.mjs music/demo.mod

# Convert WAV/MP3 to 8010 Hz PCM stream with TPDF dither
node tools/wav2pcm.mjs music/alexander-nakarada-the-wellerman.mp3 music/wellerman_full.pcm --rate=21

# Convert Commander X16 ZSM tracks to 60 Hz PSG streams
node tools/zsm2psg.mjs

# Convert a FamiTracker/FamiStudio .ftm song to VERA PSG events
node tools/ftm2psg.mjs song.ftm 0 music/TITLE.psg --noise-gain=1.2
```

`ftm2psg.mjs` requires FamiStudio 4.5 or newer. Set `FAMISTUDIO` if its
executable is not in a standard Windows install location. Song indices are
zero-based and follow the order in the FTM project. The converter asks
FamiStudio for separate 44.1 kHz channel WAVs, then estimates pitch and volume
at 60 Hz; this is an audio-derived approximation, not a register-exact NES
APU/FamiTone2 conversion. `--noise-gain=N` tunes the VERA noise voice (default
1.0), and `--mute-noise` disables it. DPCM samples are omitted because standard
`.psg` streams contain PSG register writes only. Validate output with
`node tools/check_psg.mjs music/TITLE.psg`.

### Auditioning PSG Streams on Windows (`psgplay.exe`)
A standalone native Win32 tool is provided in `tools/psgplay.exe` to play any `.psg` file directly on Windows:
```cmd
cd tools

# Play any PSG stream (loops by default if loopFrame is defined)
psgplay.exe ..\music\TITLE.psg
psgplay.exe ..\music\BeatIt.psg

# Play one-shot (do not loop)
psgplay.exe ..\music\LEVELCOMPLETE.psg --no-loop

# Set initial master volume (0..15)
psgplay.exe ..\music\HIGHSCORE.psg --vol 12
```

**Interactive Controls**:
- `SPACE` or `P`: Pause / Resume
- `M`: Mute / Unmute
- `+` or `-`: Master volume up / down
- `[` or `]`: Rewind / Fast-forward 5 seconds
- `R`: Restart from beginning
- `L`: Toggle looping on / off
- `ESC` or `Q`: Quit player

### Playing FamiTracker `.ftm` files on Windows (`ftmplay.exe`)

The standalone player and two 2A03 FTM examples are included in this repository. The Alter Ego examples are source modules; generated `Ae-*.psg` files are not bundled. Run a song by passing its project and zero-based song index:
```cmd
tools\ftmplay.exe music\alterego-simpl0r.ftm 0
```

Use `tools\ftmplay.exe music\alterego-simpl0r.ftm --list` to show song indices. The second bundled project can be listed with `tools\ftmplay.exe music\alterego-sounds.ftm --list`. Optional `--vol 0..15` sets the initial volume, `--solo 0..3` renders only Square1, Square2, Triangle, or Noise, `--wav out.wav` writes a PCM render, and `--noise-freqs out.txt` exports the NES noise pitch for each 60 Hz frame without audio playback. This native player parses FTM 0.4.2–0.4.6 2A03 modules and maps their pulse, triangle, and noise voices to VERA PSG waveforms; for a closer match to the existing `.psg` converter it uses 25% pulse waves and maps FamiTracker's inverted NES noise-period table directly to its APU timer rate, capped at VERA's maximum PSG frequency. Relative FamiTracker pitch sequence values accumulate as APU timer-period deltas. The live player shows elapsed/total time and four channel VU meters; P pauses, Space advances to the next song, M mutes, +/- adjusts volume, and Q/Esc quits. DPCM and expansion-chip channels are omitted. It synthesizes directly from FTM patterns and envelopes without FamiTone bytecode or an intermediate `.psg` file. Run `tools\build_ftmplay.bat` to rebuild the Windows x64 executable with MSVC C++ Build Tools.

### Auditioning X16 Music Files on Windows (`melodius.exe`)
`tools/melodius.exe` plays Commander X16 music files — **`.zsm`** (including the YM2151 FM parts that `zsm2psg.mjs` discards when transcoding to `.psg`, and the VERA PCM sample streams such as `TREE.ZSM`) and **`.zcm`** (ZSound PCM containers). Standard MIDI Files are **not** supported by this build.
```cmd
cd tools

# Play any ZSM track (loops by default if a loop point exists)
melodius.exe ..\music\CANYON.ZSM

# Play a ZCM (PCM-only container)
melodius.exe ..\assets\shoryukEN_8kmono8bit.zcm --no-loop

# Boost the FM (YM2151) mix — drums & percussion live here (default gain 1.0 = hardware level)
melodius.exe CANYON.ZSM --fmvol 4.0

# One-shot playback (do not loop)
melodius.exe TITLE.ZSM --no-loop

# Set initial master volume (0..15, default 12)
melodius.exe HIGHSCORE.ZSM --vol 12

# Render offline to a WAV instead of playing
melodius.exe TITLE.ZSM --wav out.wav

# PCM-only track (plays the embedded sample stream, auto-exits at end)
melodius.exe TREE.ZSM
```

**Interactive Controls**:
- `SPACE` or `P`: Pause / Resume
- `M`: Mute / Unmute
- `+` or `-`: Master volume up / down
- `F1` / `F2`: FM (YM2151) gain down / up (0.25× steps)
- `F3` / `F4`: VERA PSG gain down / up (0.25× steps)
- `F5` / `F6`: VERA PCM gain down / up (0.25× steps)
- `[` or `]`: Rewind / Fast-forward 5 seconds
- `R`: Restart from beginning
- `L`: Toggle looping on / off
- `ESC` or `Q`: Quit player

**Real-Time Status Bar**:
```text
[TITLE.ZSM   ] 00:00/00:55 [>               ] [.......^..........] V:12 FM:1.00 PSG:1.00 PCM:1.00 [LOOP]
```
- **`T: mm:ss`**: Elapsed / total playback time.
- **`[...]`**: 18-character activity meter. For FM+PSG tracks (ZSM `fmMask` ≠ 0): slots 0-7 = YM2151 FM channels 0-7 (`^` = key-on, `.` = off), slots 8-15 = VERA PSG voices 0-7 (symbol guide below), slots 16-17 = VERA PCM L/R output level. For pure-PSG tracks: slots 0-15 = PSG voices 0-15, slots 16-17 = PCM L/R.
- **`V:xx`**: Master volume level (0 to 15, defaults to **12**; `+`/`-` adjust, `--vol N` sets it at startup).
- **`FM:x.xx`**: Current YM2151 FM mix gain (adjustable live with `F1`/`F2`, default 1.00 = hardware level).
- **`PSG:x.xx`**: Current VERA PSG mix gain (adjustable live with `F3`/`F4`, default 1.00 = hardware level).
- **`PCM:x.xx`**: Current VERA PCM mix gain (adjustable live with `F5`/`F6`, default 1.00 = hardware level).
- **`[LOOP]`**: Loop / repeat (`REPT`) / one-shot (`1SHT`) / paused (`PAUS`) / muted (`MUTE`) state. Tracks with no loop point play once and exit automatically.

**Stereo**: Both engines output true stereo — YM2151 per-channel panning (registers `$20`–`$27`: bit 6 = left, bit 7 = right) and VERA PSG per-voice stereo control bits. Tracks like `TITLE.ZSM` and `KILLED.ZSM` pan voices across the stereo field.

### Real-Time Status Bar (Apple II & Windows)

The status display on Apple II text screen (Row 23) and native Windows `psgplay.exe` automatically adapts based on the audio engine:

#### 1. PSG Tracks (Tracks 1–4: Demo, Chopin, Beat It, Caribbean Blue)
Features a real-time 16-channel hardware voice meter:

```text
T: mm:ss.c [##=#==^===......] V:15
```

- **`T: mm:ss.c`**: Elapsed playback stopwatch (minutes, seconds, and tenths of a second `c`).
- **`[...]`**: 16-character real-time activity meter. For FM+PSG tracks: slots 0-7 = YM2151 FM channels 0-7 (`^` = key-on), slots 8-15 = VERA PSG voices 0-7. For pure-PSG tracks: slots 0-15 = PSG voices 0-15 (left to right).
- **`V:xx`**: Master volume level (0 to 15).
- **`P`**: Displayed when playback is paused.

##### Voice Activity Symbol Guide
Each character reflects the instantaneous volume register (bits 5:0, 0..63) of the corresponding PSG hardware voice:

| Symbol | Volume Range (0..63) | Activity Level | Description |
| :---: | :---: | :---: | :--- |
| `.` | 0 | **Silent** | Voice inactive or note released |
| `-` | 1 .. 14 | **Quiet** | Gentle reverb tail, soft ambient pad, or decaying note |
| `=` | 15 .. 34 | **Medium** | Standard accompaniment, piano chords, rhythm guitar |
| `#` | 35 .. 49 | **Loud** | Main melody lead, prominent brass, accented notes |
| `^` | 50 .. 63 | **Peak** | Fortissimo climax, high choir lead, drum transient spike |

##### PCM Level Symbol Guide (slots 16-17)
The last two meter slots show the VERA PCM left/right output peak (0..32767, sampled before the PCM gain so the meter reflects the sample content):

| Symbol | Level Range (0..32767) | Description |
| :---: | :---: | :--- |
| `.` | 0 | PCM silent / not active |
| `-` | 1 .. 8191 | Quiet passage |
| `=` | 8192 .. 16383 | Medium level |
| `#` | 16384 .. 24575 | Loud passage |
| `^` | 24576 .. 32767 | Peak / near-full-scale |

#### 2. PCM Stream Tracks (Tracks 5 & 6: Space Debris, The Wellerman)
Pure 8-bit PCM audio streams from ProDOS files into VERA's 4 KB hardware FIFO without using PSG voices. Instead of channel meters, it displays the logical 512-byte file-chunk count:

```text
T: mm:ss.c B:xxxx V:15
```

- **`T: mm:ss.c`**: Elapsed playback stopwatch (minutes, seconds, and tenths of a second `c`).
- **`B:xxxx`**: Current 4-digit hexadecimal logical chunk count from the start of the PCM file. This does not identify a physical disk block; ProDOS resolves the file allocation during each `READ`.
- **`V:xx`**: Master volume level (0 to 15).
- **`P`**: Displayed when playback is paused.


---

## Hardware Architecture Notes

- **PSG Base Address**: `$1F9C0` in VERA address space. 4 bytes per voice `[freq_lo, freq_hi, ctrl, wave]`.
- **PCM Base Address**: `$1F9C0 + $1D` (`VERA_AUDIO_DATA`), rate register `$1E`, ctrl register `$1C`.
- **Clock Reference**: VERA internal audio base clock = `25 MHz / 512 = 48,828.125 Hz`. Rate 21 = `8,010.864 Hz`.
- **Slot I/O**:
  - Slot 2: Registers mapped to `$C0A0`..`$C0BF`.
  - Slot 4: Registers mapped to `$C0C0`..`$C0DF`.
  - Auto-detected at boot by reading and writing VERA scratch registers.
- **YM2151 FM (AppleWin VERA fork only)**:
  - Register select at slot base + `$20`, data at slot base + `$21` (e.g. `$C220` / `$C221` on Slot 2).
  - Not present on physical VERA cards — emulated by the AppleWin fork with the ymfm core; `tools/melodius.exe` renders the identical mix natively on Windows.

---

## License

This project is licensed under the MIT License. Audio compositions and arrangements are property of their respective creators or in the public domain.
