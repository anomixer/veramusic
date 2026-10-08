# VERA Music (veramusic)

**High-Fidelity Audio Engine & Jukebox Suite (Release R6) for Apple II with VERA Card**

[![Release](https://img.shields.io/badge/release-R6-blueviolet.svg)]()
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
  - Streams full 8-bit signed PCM directly into VERA's 4 KB hardware FIFO using ProDOS raw disk blocks (`READ_BLOCK`).
  - CPU usage under 5% on a 1.02 MHz 6502, buffered against drive seek latency.
  - Studio-grade TPDF (Triangular Probability Density Function) dither to eliminate 8-bit quantization distortion.
- **VERA 128KB SRAM Pre-Load Player (`psgvram.asm`)**:
  - Pre-loads entire song streams (e.g. Chopin, 68.6 KB) into VERA's onboard 128 KB SRAM at startup (~2.5s).
  - **Zero Floppy Stutter**: 100% silent, stutter-free playback on standard 140KB 5.25" Disk II floppies with no drive head movement during playback.
  - Instantaneous seeking: fast-forward and rewind execute in microseconds.
- **Native Windows VERA PSG Player (`tools/psgplay.exe`)**:
  - Standalone Win32 x86 real-time player to audition `.psg` streams on Windows PC with zero external dependencies.
  - Full 16-channel VERA PSG synthesis at 48,000 Hz 16-bit stereo with live 16-voice activity meters and interactive controls.
- **Native Windows ZSM Player (`tools/zsmplay.exe`)**:
  - Plays Commander X16 `.zsm` music files natively on Windows, rendering the 16-channel VERA PSG, the Yamaha YM2151 (OPM) FM chip, **and VERA PCM sample streams** in real time (ymfm synthesis core, zero external dependencies).
  - 48,000 Hz 16-bit stereo with authentic L/R panning (YM2151 pan registers `$20`–`$27` + VERA PSG stereo control bits).
  - Adjustable FM mix gain (`--fmvol` / `F1` / `F2`, default 12.0×) — ZSM percussion and FM leads sit prominently in the mix.
  - Adjustable PSG mix gain (`--psgvol` / `F3` / `F4`, default 12.0×) — VERA PSG voices can be boosted or attenuated.
  - Adjustable PCM mix gain (`--pcmvol` / `F5` / `F6`, default 12.0×) — VERA PCM sample streams can be boosted over the PSG bed.
  - Full ZSM container support: loop points, per-chip channel masks, non-60 Hz tick rates, and the PCM instrument table (mono/stereo, 8/16-bit).
- **Universal Player Controls Across All Formats**:
  - `ESC` / `Q`: Clean exit.
  - `P` / `SPACE`: Real-time pause / unpause.
  - `M`: Shadowed register mute.
  - `+` / `-`: 16-level master volume scaling.
  - `]` / `[`: Universal 5-second fast-forward and rewind.
  - `F1` / `F2`: FM (YM2151) gain down / up (`zsmplay.exe` only).
  - Live on-screen display: 16-voice activity meter (`T: mm:ss.c [...] V:xx`) for PSG tracks; direct disk block counter (`T: mm:ss.c B:xxxx V:xx`) for PCM stream tracks.

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
├── AGENTS.md                  # Comprehensive engineering & development log
├── src/                       # 6502 assembly players & Applesoft BASIC menus
│   ├── psgvram.asm            # VERA 128KB SRAM pre-load player (PO & HDV track 2)
│   ├── psgstream.asm          # ProDOS MLI direct block stream player (PSG)
│   ├── psgplay.asm            # Host RAM-resident PSG player
│   ├── pcmstream.asm          # ProDOS MLI direct block stream player (PCM)
│   ├── pcmplay.asm            # Host RAM-resident PCM player
│   ├── hybridstream.asm       # Dual-engine interleaved PSG+PCM player
│   ├── vera.inc               # VERA hardware register equates
│   ├── startup.bas            # Applesoft BASIC auto-boot menu (HDV)
│   └── startup_po.bas         # Applesoft BASIC auto-boot menu (PO)
├── tools/                     # Zero-dependency conversion toolchain & Windows player
│   ├── psgplay.exe            # Native Windows x86 real-time VERA PSG player
│   ├── psgplay.c              # Source code for psgplay (WinMM waveOut 48kHz audio)
│   ├── build_psgplay.bat      # MSVC build script for psgplay.exe
│   ├── zsmplay.exe            # Native Windows x86 real-time ZSM (VERA PSG + YM2151 FM + VERA PCM) player
│   ├── zsmplay.cpp            # Source code for zsmplay (ymfm YM2151 + VERA PSG + VERA PCM + WinMM)
│   ├── build_zsmplay.bat      # MSVC build script for zsmplay.exe
│   ├── zsm_scan.mjs           # ZSM analyzer (event histogram + header/PCM table dump)
│   ├── zsm_pan.mjs            # ZSM stereo panning usage analyzer
│   ├── zsm2psg.mjs            # Commander X16 ZSM → 60 Hz PSG stream converter
│   ├── mid2psg.mjs            # Standard MIDI (.mid) → 60 Hz PSG stream converter
│   ├── mod2psg.mjs            # ProTracker MOD (.mod) → 60 Hz PSG stream converter
│   ├── wav2pcm.mjs            # Audio (.wav/.mp3) → 8010 Hz VERA PCM converter
│   ├── build_jukebox.mjs      # ProDOS volume packager & automatic ZIP generator
│   └── check_psg.mjs          # 6502 cycle & register write validator
├── music/                     # Audio source assets & converted streams (.mid, .mod, .psg, .pcm)
└── scripts/                   # Audio analysis & one-off diagnostic utilities
```

---

## Building & Development

### Prerequisites
- [ACME Cross-Assembler](https://github.com/meonwax/acme) (in `PATH` or `C:\tools\acme\acme.exe`)
- [Node.js](https://nodejs.org/) (v18 or newer)

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
```

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

### Auditioning ZSM Files on Windows (`zsmplay.exe`)
`tools/zsmplay.exe` plays original Commander X16 `.zsm` music files — **including the YM2151 FM parts** that `zsm2psg.mjs` discards when transcoding to `.psg`, **and the VERA PCM sample streams** (e.g. `TREE.ZSM`):
```cmd
cd tools

# Play any ZSM track (loops by default if a loop point exists)
zsmplay.exe ..\music\CANYON.ZSM

# Boost the FM (YM2151) mix — drums & percussion live here (default gain 12.0)
zsmplay.exe CANYON.ZSM --fmvol 4.0

# One-shot playback (do not loop)
zsmplay.exe TITLE.ZSM --no-loop

# Set initial master volume (0..15)
zsmplay.exe HIGHSCORE.ZSM --vol 12

# PCM-only track (plays the embedded sample stream, auto-exits at end)
zsmplay.exe TREE.ZSM
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
[TITLE.ZSM   ] 00:00/00:55 [>               ] [.......^..........] V:15 FM:12.00 PSG:12.00 PCM:12.00 [LOOP]
```
- **`T: mm:ss`**: Elapsed / total playback time.
- **`[...]`**: 18-character activity meter. For FM+PSG tracks (ZSM `fmMask` ≠ 0): slots 0-7 = YM2151 FM channels 0-7 (`^` = key-on, `.` = off), slots 8-15 = VERA PSG voices 0-7 (symbol guide below), slots 16-17 = VERA PCM L/R output level. For pure-PSG tracks: slots 0-15 = PSG voices 0-15, slots 16-17 = PCM L/R.
- **`V:xx`**: Master volume level (0 to 15).
- **`FM:x.xx`**: Current YM2151 FM mix gain (adjustable live with `F1`/`F2`).
- **`PSG:x.xx`**: Current VERA PSG mix gain (adjustable live with `F3`/`F4`).
- **`PCM:x.xx`**: Current VERA PCM mix gain (adjustable live with `F5`/`F6`).
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
Pure 8-bit PCM audio streams directly from ProDOS disk blocks into VERA's 4 KB hardware FIFO without using PSG voices. Instead of channel meters, it displays the real-time physical disk block address:

```text
T: mm:ss.c B:xxxx V:15
```

- **`T: mm:ss.c`**: Elapsed playback stopwatch (minutes, seconds, and tenths of a second `c`).
- **`B:xxxx`**: Current 4-digit hexadecimal ProDOS disk block number being streamed from storage (e.g. `B:1388` for block 5000 in *Space Debris*, `B:0258` for block 600 in *The Wellerman*).
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
  - Not present on physical VERA cards — emulated by the AppleWin fork with the ymfm core; `tools/zsmplay.exe` renders the identical mix natively on Windows.

---

## License

This project is licensed under the MIT License. Audio compositions and arrangements are property of their respective creators or in the public domain.
