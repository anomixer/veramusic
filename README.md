# VERA Music (veramusic)

**High-Fidelity Audio Engine & Jukebox Suite for Apple II with VERA Card**

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
- **Universal Player Controls Across All Formats**:
  - `ESC` / `Q`: Clean exit back to Applesoft BASIC menu.
  - `P` / `M`: Real-time pause / unpause (shadowed register mute).
  - `+` / `-`: 16-level master volume scaling.
  - `]` / `[`: Universal 5-second fast-forward and rewind.
  - Live stopwatch display: `T: mm:ss.s  V: xx`.

---

## Included Jukebox Lineup

### 1. Bootable 32MB Hard Disk (`jukebox.hdv`)
| Track | Title | Format | Duration | Technology |
|---|---|---|---|---|
| **1** | **Melody Demo** | RAM PSG | 0:30 | 6502 RAM-resident 60 Hz PSG event player |
| **2** | **Chopin: Fantaisie-Impromptu** | VERA RAM PSG | 5:02 | 16-voice pure triangle acoustic grand piano |
| **3** | **Michael Jackson: Beat It** | Stream PSG | 3:58 | 16-voice rock band + GM channel 9 drums |
| **4** | **Captain: Space Debris** | Stream PCM | 5:05 | 8010 Hz direct-to-FIFO ProDOS disk streaming |
| **5** | **Alexander Nakarada: The Wellerman** | Stream PCM | 2:00 | 8010 Hz full acoustic folk ballad with TPDF dither |

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
├── tools/                     # Zero-dependency Node.js conversion toolchain
│   ├── mid2psg.mjs            # Standard MIDI (.mid) → 60 Hz PSG stream converter
│   ├── mod2psg.mjs            # ProTracker MOD (.mod) → 60 Hz PSG stream converter
│   ├── wav2pcm.mjs            # Audio (.wav/.mp3) → 8010 Hz VERA PCM converter
│   ├── build_jukebox.mjs      # ProDOS volume & directory filesystem packager
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
# Re-assemble players, update BASIC menus, and pack jukebox.po & jukebox.hdv
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
```

---

## Hardware Architecture Notes

- **PSG Base Address**: `$1F9C0` in VERA address space. 4 bytes per voice `[freq_lo, freq_hi, ctrl, wave]`.
- **PCM Base Address**: `$1F9C0 + $1D` (`VERA_AUDIO_DATA`), rate register `$1E`, ctrl register `$1C`.
- **Clock Reference**: VERA internal audio base clock = `25 MHz / 512 = 48,828.125 Hz`. Rate 21 = `8,010.864 Hz`.
- **Slot I/O**:
  - Slot 2: Registers mapped to `$C0A0`..`$C0BF`.
  - Slot 4: Registers mapped to `$C0C0`..`$C0DF`.
  - Auto-detected at boot by reading and writing VERA scratch registers.

---

## License

This project is licensed under the MIT License. Audio compositions and arrangements are property of their respective creators or in the public domain.
