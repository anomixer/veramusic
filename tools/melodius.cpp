/**
 * melodius.cpp - Native Windows player for Commander X16 / ZSound music
 *
 * A Windows port of Melodius (https://github.com/mooinglemur/melodius), the
 * Commander X16 music player that runs ZSM and ZCM through the X16 audio API
 * (zsmkit). On the X16 both formats are driven by the same engine: the YM2151
 * (FM), the VERA PSG and the VERA PCM FIFO, mixed by the VERA DAC.
 *
 * This build reproduces that engine natively on Windows using ymfm for the
 * YM2151, so ZSM and ZCM playback matches the Commander X16 mix. Melodius's
 * Standard MIDI File engine is NOT ported here.
 *
 * Supported: .zsm/.zm (YSM/ZSMKit stream), .zcm (ZSound PCM container)
 *
 * Usage:
 *   melodius.exe <file.zsm|.zcm> [--no-loop] [--vol 0..15] [--time N]
 *              [--fmvol G] [--psgvol G] [--pcmvol G] [--wav out.wav]
 *
 * Controls:
 *   [SPACE] or [P]  Pause / Resume
 *   [M]             Mute / Unmute
 *   [+] or [=]      Volume Up
 *   [-] or [_]      Volume Down
 *   [[]             Rewind 5s
 *   []]             Fast Forward 5s
 *   [R]             Restart from beginning
 *   [L]             Toggle Looping
 *   [ESC] or [Q]    Quit
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mmsystem.h>
#include <conio.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <vector>

#include "ymfm_opm.h"

#pragma comment(lib, "winmm.lib")

#define SAMPLE_RATE 48000
#define FPS 60
#define SAMPLES_PER_FRAME (SAMPLE_RATE / FPS) // exactly 800 samples
#define FRAMES_PER_BUF 4 // 4 frames = 3200 samples (~66.7ms)
#define SAMPLES_PER_BUF (SAMPLES_PER_FRAME * FRAMES_PER_BUF)
#define NUM_BUFFERS 4
#define PSG_CLOCK (25000000.0 / 512.0) // 48828.125 Hz
// The VERA PSG phase accumulator runs 0..0x20000 (17-bit) and advances by
// freq * (PSG_CLOCK / sampleRate); see VERAAudio.cpp renderSample().
#define PSG_PHASE_SCALE (PSG_CLOCK / (double)SAMPLE_RATE)

// 64-entry VERA logarithmic volume lookup table (same as psgplay.c)
static const uint16_t volumeLut[64] = {
    0,   4,   8,   12,  16,  17,  18,  20,  21,  22,  23,  25,  26,
    28,  30,  31,  33,  35,  37,  40,  42,  45,  47,  50,  53,  56,
    60,  63,  67,  71,  75,  80,  85,  90,  95,  101, 107, 113, 120,
    127, 135, 143, 151, 160, 170, 180, 191, 202, 214, 227, 241, 255,
    270, 286, 303, 321, 341, 361, 382, 405, 429, 455, 482, 511};

// ---------------------------------------------------------------------------
// VERA PSG state (ported from psgplay.c)
// ---------------------------------------------------------------------------
typedef struct {
  uint8_t regs[64];
  double phase[16];      // 0..0x20000 VERA fixed-point phase accumulator
  int32_t noiseVal[16];  // 6-bit noise sample latched per voice (0x00..0x3F)
  uint32_t noiseState;
} PsgState;

static PsgState psg;

static void psg_reset(void) {
  memset(psg.regs, 0, sizeof(psg.regs));
  for (int i = 0; i < 16; i++) {
    psg.phase[i] = 0.0;
    psg.noiseVal[i] = 0;
  }
  psg.noiseState = 1;
}

// ---------------------------------------------------------------------------
// YM2151 (ymfm) state
// ---------------------------------------------------------------------------
static class YmIf : public ymfm::ymfm_interface {
public:
  uint64_t m_clockCount = 0;
  uint64_t m_busyEnd = 0;
  void ymfm_set_busy_end(uint32_t clocks) override {
    m_busyEnd = m_clockCount + clocks;
  }
  bool ymfm_is_busy() override { return m_clockCount < m_busyEnd; }
} ymif;

static ymfm::ym2151 *ym2151 = NULL;
static ymfm::ym2151::output_data ymOut;
static bool fmKeyOn[8] = {false}; // per-channel key-on state (reg $08)

static void ym_reset(void) {
  if (ym2151)
    ym2151->reset();
  memset(fmKeyOn, 0, sizeof(fmKeyOn));
  ymif.m_clockCount = 0;
  ymif.m_busyEnd = 0;
}

static void ym_generate(int16_t *l, int16_t *r) {
  ym2151->generate(&ymOut, 1);
  *l = (int16_t)ymOut.data[0];
  *r = (int16_t)ymOut.data[1];
  ymif.m_clockCount += 64; // one native output sample = 64 chip clocks
}

static void ym_clock_keyoff(void);

// ---------------------------------------------------------------------------
// ZSM stream decode (mirrors tools/zsm2psg.mjs)
// ---------------------------------------------------------------------------
static uint8_t *streamData = NULL;
static size_t streamSize = 0;

struct PcmEvent {
  uint8_t sub;
  uint8_t val;
};

struct Frame {
  std::vector<uint8_t> psgReg;
  std::vector<uint8_t> psgVal;
  std::vector<uint8_t> ymReg;
  std::vector<uint8_t> ymVal;
  std::vector<PcmEvent> pcm;
};

static std::vector<Frame> frames;
static int totalFrames = 0;
static int loopFrame = 0;
static bool hasLoop = false;
static uint16_t tickRate = 60;    // ZSM tick rate (header offset 12-13)
static uint8_t fmMask = 0xFF;     // YM2151 channel enable mask (header offset 9)
static uint16_t psgMask = 0xFFFF; // VERA PSG voice enable mask (header offset 10-11)

// ---------------------------------------------------------------------------
// ZSM PCM (VERA PCM FIFO) state
// ---------------------------------------------------------------------------
struct PcmInst {
  uint32_t fileOffset; // absolute offset of the sample data in the file
  uint32_t length;     // bytes
  uint32_t loopPoint;  // bytes, relative to the sample start
  bool looped;
  uint8_t geometry;    // bits 5:4 feed VERA AudioCtrl (format)
};

static std::vector<PcmInst> pcmInsts;

static bool pcmBusy = false;
static int pcmInstIdx = -1;
static uint32_t pcmPos = 0;   // byte position within the sample
static int pcmVolume = 15;    // VERA AudioCtrl bits 3:0
static int pcmRateByte = 0;   // VERA AudioRate register
static uint8_t pcmFormat = 0; // AudioCtrl bits 5:4: 0=mono8 1=stereo8 2=mono16 3=stereo16
static double pcmPhase = 0.0;
static int16_t pcmPrevL = 0, pcmPrevR = 0, pcmCurL = 0, pcmCurR = 0;
static int applyTick = 0;      // tick of the frame currently being applied
static int pcmTriggerTick = 0; // tick at which the current instrument was triggered
static int pcmPeakL = 0, pcmPeakR = 0; // PCM sample peak (for VU meter)

// VERA PCM volume LUT (16 entries); output = sample * LUT[v] / 64
static const uint8_t pcmVolumeLut[16] = {0, 1, 2, 3, 4, 5, 6, 8, 11, 14, 18, 23, 30, 38, 49, 64};

static void pcm_reset(void) {
  pcmBusy = false;
  pcmInstIdx = -1;
  pcmPos = 0;
  pcmVolume = 15;
  pcmRateByte = 0;
  pcmFormat = 0;
  pcmPhase = 0.0;
  pcmPrevL = pcmPrevR = pcmCurL = pcmCurR = 0;
  pcmTriggerTick = 0;
}

static void pcm_trigger(int idx) {
  if (idx < 0 || idx >= (int)pcmInsts.size())
    return; // invalid instrument index: ignored (matches zsmkit)
  pcmInstIdx = idx;
  pcmPos = 0;
  pcmBusy = true;
  pcmPhase = 0.0;
  pcmPrevL = pcmPrevR = pcmCurL = pcmCurR = 0;
  pcmFormat = (pcmInsts[idx].geometry >> 4) & 3;
  pcmTriggerTick = applyTick;
}

// ZSM PCM sub-events: [0x00, ctrl] volume/flush, [0x01, rate], [>=0x02, instrument]
static void pcm_apply_event(const PcmEvent &ev) {
  if (ev.sub == 0x00) { // PCM ctrl: volume (bits 3:0), bit 7 = FIFO flush
    pcmVolume = ev.val & 0x0F;
    if (ev.val & 0x80) {
      pcmPrevL = pcmPrevR = pcmCurL = pcmCurR = 0;
      pcmPhase = 0.0;
    }
  } else if (ev.sub == 0x01) { // PCM rate
    pcmRateByte = ev.val;
  } else { // >= 2: trigger instrument
    pcm_trigger(ev.val);
  }
}

static bool load_zsm_file(const char *filename) {
  FILE *fp = fopen(filename, "rb");
  if (!fp) {
    printf("Error: Cannot open file '%s'\n", filename);
    return false;
  }
  fseek(fp, 0, SEEK_END);
  streamSize = ftell(fp);
  fseek(fp, 0, SEEK_SET);
  streamData = (uint8_t *)malloc(streamSize);
  if (fread(streamData, 1, streamSize, fp) != streamSize) {
    printf("Error: Failed to read file data\n");
    fclose(fp);
    return false;
  }
  fclose(fp);

  if (streamSize < 16) {
    printf("Error: File is too small to be a valid ZSM file\n");
    return false;
  }
  // Accept "ZSM"/"zsm" and the "zm"+version variant emitted by some tools
  if ((streamData[0] != 'Z' && streamData[0] != 'z') ||
      (streamData[1] != 'S' && streamData[1] != 's' &&
       streamData[1] != 'M' && streamData[1] != 'm')) {
    printf("Warning: File does not look like a ZSM file (bad magic)\n");
  }

  const uint32_t loopOffset = streamData[3] | (streamData[4] << 8) | (streamData[5] << 16);
  const uint32_t pcmTableOffset = streamData[6] | (streamData[7] << 8) | (streamData[8] << 16);
  fmMask = streamData[9];
  psgMask = streamData[10] | (streamData[11] << 8);
  tickRate = streamData[12] | (streamData[13] << 8);
  if (tickRate == 0)
    tickRate = 60;

  // Parse the PCM instrument table (header offset 6-8), if present:
  // "PCM" magic, 1 byte inst_max, then (inst_max+1) 16-byte entries,
  // followed by the raw PCM sample data area.
  pcmInsts.clear();
  if (pcmTableOffset != 0 && pcmTableOffset + 4 <= streamSize &&
      streamData[pcmTableOffset] == 'P' && streamData[pcmTableOffset + 1] == 'C' &&
      streamData[pcmTableOffset + 2] == 'M') {
    const uint8_t instMax = streamData[pcmTableOffset + 3];
    const uint32_t dataBase = pcmTableOffset + 4 + (uint32_t)(instMax + 1) * 16;
    for (int i = 0; i <= instMax; i++) {
      const size_t e = pcmTableOffset + 4 + (size_t)i * 16;
      if (e + 16 > streamSize)
        break;
      PcmInst inst;
      inst.geometry = streamData[e + 1];
      const uint32_t off =
          streamData[e + 2] | (streamData[e + 3] << 8) | (streamData[e + 4] << 16);
      inst.length =
          streamData[e + 5] | (streamData[e + 6] << 8) | (streamData[e + 7] << 16);
      inst.looped = (streamData[e + 8] & 0x80) != 0;
      inst.loopPoint =
          streamData[e + 9] | (streamData[e + 10] << 8) | (streamData[e + 11] << 16);
      inst.fileOffset = dataBase + off;
      pcmInsts.push_back(inst);
    }
  }

  size_t ptr = 16;
  int tick = 0;
  bool loopFound = false;

  frames.clear();
  frames.resize(1);

  while (ptr < streamSize) {
    if (loopOffset > 0 && ptr >= loopOffset && !loopFound) {
      loopFrame = tick;
      loopFound = true;
    }

    const uint8_t command = streamData[ptr++];

    if (command < 0x40) { // native PSG write
      if (ptr >= streamSize) break;
      const uint8_t val = streamData[ptr++];
      if ((int)frames.size() <= tick) frames.resize(tick + 1);
      frames[tick].psgReg.push_back(command);
      frames[tick].psgVal.push_back(val);
      continue;
    }

    if (command == 0x40) { // EXTCMD: [ext, ...payload]
      if (ptr >= streamSize) break;
      const uint8_t ext = streamData[ptr++];
      if (ext < 0x40) {
        // PCM events: ext payload bytes, 2 bytes per sub-event
        if ((int)frames.size() <= tick) frames.resize(tick + 1);
        const int nEvents = ext / 2;
        for (int i = 0; i < nEvents; i++) {
          if (ptr + 1 >= streamSize) break;
          const PcmEvent ev = {streamData[ptr++], streamData[ptr++]};
          frames[tick].pcm.push_back(ev);
        }
        if ((ext & 1) && ptr < streamSize)
          ptr++; // odd trailing byte: skip to stay in sync
      } else {
        // external chip data / sync events: no audio effect in this player
        ptr += ext & 0x3F;
        if (ptr > streamSize) ptr = streamSize;
      }
      continue;
    }

    if (command < 0x80) { // YM2151 write batch
      const int count = command & 0x3F;
      if ((int)frames.size() <= tick) frames.resize(tick + 1);
      for (int i = 0; i < count; i++) {
        if (ptr + 1 >= streamSize) break;
        const uint8_t reg = streamData[ptr++];
        const uint8_t val = streamData[ptr++];
        frames[tick].ymReg.push_back(reg);
        frames[tick].ymVal.push_back(val);
      }
      continue;
    }

    if (command == 0x80)
      break; // end of song

    // delay: tick += command & 0x7F
    tick += command & 0x7F;
  }

  // Delay commands advance the tick counter without emitting events, so a
  // stream that ends with delays (e.g. a PCM-only track) must grow the
  // frame array to cover the full song duration.
  if ((int)frames.size() < tick + 1)
    frames.resize(tick + 1);

  totalFrames = (int)frames.size();
  hasLoop = loopFound && loopFrame >= 0 && loopFrame < totalFrames;
  return true;
}

// ---------------------------------------------------------------------------
// File kind detection
// ---------------------------------------------------------------------------
enum FileKind { KIND_NONE, KIND_ZSM, KIND_ZCM, KIND_MID };

static FileKind fileKind = KIND_NONE;

static FileKind detect_kind(const char *path) {
  size_t n = strlen(path);
  const char *dot = NULL;
  for (size_t i = n; i > 0; i--) {
    if (path[i - 1] == '\\' || path[i - 1] == '/')
      break;
    if (path[i - 1] == '.' && !dot)
      dot = path + i - 1;
  }
  if (!dot)
    return KIND_NONE;
  char ext[8];
  size_t k = 0;
  for (const char *p = dot + 1; *p && k < sizeof(ext) - 1; p++)
    ext[k++] = (char)tolower((unsigned char)*p);
  ext[k] = 0;
  if (!strcmp(ext, "zsm") || !strcmp(ext, "zm"))
    return KIND_ZSM;
  if (!strcmp(ext, "zcm"))
    return KIND_ZCM;
  if (!strcmp(ext, "mid") || !strcmp(ext, "midi"))
    return KIND_MID;
  return KIND_NONE;
}

// ---------------------------------------------------------------------------
// ZCM - ZSound PCM container
//
// Layout (see zsound/tools/raw2zcm and zsmkit's zcm_play):
//   $00..$02  00 00 00 signature
//   $03..$05  sample length, 24-bit little endian
//   $06       geometry (AudioCtrl bits 5:4: 0=mono8 1=stereo8 2=mono16 3=stereo16)
//   $07       VERA AudioRate byte
//   $08..     PCM sample data
// ---------------------------------------------------------------------------
static bool read_whole_file(const char *filename) {
  FILE *fp = fopen(filename, "rb");
  if (!fp)
    return false;
  fseek(fp, 0, SEEK_END);
  long sz = ftell(fp);
  fseek(fp, 0, SEEK_SET);
  if (sz <= 0) {
    fclose(fp);
    return false;
  }
  streamSize = (size_t)sz;
  streamData = (uint8_t *)malloc(streamSize);
  if (!streamData) {
    fclose(fp);
    return false;
  }
  size_t got = fread(streamData, 1, streamSize, fp);
  fclose(fp);
  if (got != streamSize) {
    free(streamData);
    streamData = NULL;
    return false;
  }
  return true;
}

static bool load_zcm_file(const char *filename) {
  if (!read_whole_file(filename))
    return false;
  if (streamSize < 8) {
    printf("Error: file is too small to be a ZCM\n");
    return false;
  }
  if (streamData[0] || streamData[1] || streamData[2])
    printf("Warning: ZCM signature is missing (expected 00 00 00)\n");

  PcmInst inst;
  inst.fileOffset = 8;
  inst.length =
      streamData[3] | (streamData[4] << 8) | (streamData[5] << 16);
  if (inst.length == 0 || 8 + (size_t)inst.length > streamSize)
    inst.length = (uint32_t)(streamSize - 8);
  inst.geometry = streamData[6];
  inst.looped = false;
  inst.loopPoint = 0;
  pcmInsts.clear();
  pcmInsts.push_back(inst);

  pcmTriggerTick = 0;
  pcmRateByte = streamData[7];
  pcmFormat = (streamData[6] >> 4) & 3;
  pcmVolume = 15;
  pcm_trigger(0);

  const int bytesPerSample =
      ((pcmFormat & 1) ? 2 : 1) * ((pcmFormat & 2) ? 2 : 1);
  const int effRate =
      (pcmRateByte > 128) ? (256 - pcmRateByte) : pcmRateByte;
  const double pcmHz = (double)effRate * (48828.125 / 128.0);
  const double seconds =
      pcmHz > 0 ? (double)pcmInsts[0].length / bytesPerSample / pcmHz : 0.0;
  totalFrames = (int)(seconds * FPS) + 1;
  hasLoop = false;
  printf(" PCM: %u bytes, geometry 0x%02X (%s%d-bit), rate %d (%.0f Hz)\n",
         pcmInsts[0].length, pcmFormat,
         (pcmFormat == 1 || pcmFormat == 3) ? "stereo" : "mono",
         (pcmFormat >= 2) ? 16 : 8, effRate, pcmHz);
  return true;
}

// ---------------------------------------------------------------------------
// Player state
// ---------------------------------------------------------------------------
static int currentFrame = 0;
static int masterVolume = 15; // 0..15 (full scale; the linear mix peaks below 1.0)
// Hardware-accurate mix gains, following the X16 Developer Board mixer:
//   mix = (PSG + PCM) * 2 + YM
// (x16-emulator audio.c: `(psg + pcm) << 14 >> 13` + `ym >> 15`; a single
// full-volume PSG voice is 1/8 of the output). Mixing PSG/PCM 1:1 buries the
// PSG under the YM2151, which is far louder than a PSG voice.
static double fmGain = 1.0;   // FM (YM2151) mix gain
static double pcmGain = 2.0;  // VERA PCM mix gain (F5/F6)
static double psgGain = 2.0;  // VERA PSG mix gain (F3/F4)
static bool isMuted = false;
static bool isPaused = false;
static bool isRunning = true;
static bool songFinished = false;
static double tickAccum = 0.0; // ZSM tick accumulator (normalizes non-60Hz tick rates)
static double timeoutSeconds = 0.0;
static uint8_t channelVols[16] = {0};
static bool loopEnabled = true;
static const char *wavOutPath = NULL;

static HWAVEOUT hWaveOut = NULL;
static WAVEHDR waveHeaders[NUM_BUFFERS];
static int16_t *audioBuffers[NUM_BUFFERS];

// Apply all register writes for a specific frame
static void apply_frame(int frameIdx) {
  if (frameIdx < 0 || frameIdx >= totalFrames)
    return;
  // ZCM and MIDI drive the engines directly and have no ZSM frame array.
  if (frameIdx >= (int)frames.size())
    return;
  applyTick = frameIdx;
  Frame &f = frames[frameIdx];
  for (size_t i = 0; i < f.psgReg.size(); i++) {
    const uint8_t reg = f.psgReg[i] & 0x3F;
    const uint8_t val = f.psgVal[i];
    psg.regs[reg] = val;
    if (reg < 64 && (reg % 4) == 2)
      channelVols[reg / 4] = val & 0x3F;
  }
  for (size_t i = 0; i < f.ymReg.size(); i++) {
    const uint8_t reg = f.ymReg[i];
    const uint8_t val = f.ymVal[i];
    if (reg >= 0x20) {
      // per-channel register: channel = reg & 7
      if (!(fmMask & (1 << (reg & 7))))
        continue;
    } else if (reg == 0x08) {
      // key on/off: channel = val & 7, operator mask = bits 3-6 (non-zero = on)
      fmKeyOn[val & 7] = (val & 0x78) != 0;
      if (!(fmMask & (1 << (val & 7))))
        continue;
    }
    ym2151->write(0, reg); // register select
    ym2151->write(1, val); // data
    // A tick's writes are applied back-to-back, so a key-off immediately
    // followed by a key-on (the ZSM retrigger idiom) would never be seen by
    // ymfm's sample-clocked keystate sampler: the key state stays "on" and
    // the envelope keeps decaying instead of restarting. Clock one native
    // sample so the chip latches the release before the key-on arrives.
    if (reg == 0x08 && (val & 0x78) == 0)
      ym_clock_keyoff();
  }
  for (size_t i = 0; i < f.pcm.size(); i++)
    pcm_apply_event(f.pcm[i]);
}

// Seek: reset all engines and re-apply events up to targetFrame
static void seek_frame(int targetFrame) {
  if (targetFrame < 0)
    targetFrame = 0;
  if (targetFrame >= totalFrames)
    targetFrame = totalFrames - 1;
  psg_reset();
  ym_reset();
  pcm_reset();
  tickAccum = 0.0;
  for (int f = 0; f <= targetFrame; f++)
    apply_frame(f);
  // Advance the PCM position to match the seek target (the replay above
  // re-triggered the instrument at its start tick)
  if (pcmBusy && pcmRateByte > 0 && pcmInstIdx >= 0 && targetFrame > pcmTriggerTick) {
    const int effRate = (pcmRateByte > 128) ? (256 - pcmRateByte) : pcmRateByte;
    if (effRate > 0) {
      const double pcmHz = (double)effRate * (48828.125 / 128.0);
      const double samples = (double)(targetFrame - pcmTriggerTick) * pcmHz / (double)tickRate;
      const int bytesPerSample = ((pcmFormat & 1) ? 2 : 1) * ((pcmFormat & 2) ? 2 : 1);
      double pos = samples * (double)bytesPerSample;
      const PcmInst &inst = pcmInsts[pcmInstIdx];
      if (inst.looped && pos >= (double)inst.length) {
        const double loopLen = (double)(inst.length - inst.loopPoint);
        if (loopLen > 0)
          pos = (double)inst.loopPoint + fmod(pos - (double)inst.length, loopLen);
      }
      if (pos >= (double)inst.length) {
        pcmBusy = false;
        pcmPos = 0;
      } else {
        pcmPos = (uint32_t)pos;
      }
    }
  }
  currentFrame = targetFrame;
  songFinished = false;
}

// ---------------------------------------------------------------------------
// Resampling helpers (native -> 48000)
// ---------------------------------------------------------------------------
static double resamplePosPsg = 0.0; // not used; PSG renders at SAMPLE_RATE directly
static double ymPhase = 0.0;
static int16_t ymPrevL = 0, ymPrevR = 0, ymCurL = 0, ymCurR = 0;

static void ym_clock_keyoff(void) {
  ymPrevL = ymCurL;
  ymPrevR = ymCurR;
  ym_generate(&ymCurL, &ymCurR);
}

static void ym_render_sample(int16_t *l, int16_t *r) {
  const double nativeRate = (double)ym2151->sample_rate(3579545);
  ymPhase += nativeRate / (double)SAMPLE_RATE;
  while (ymPhase >= 1.0) {
    ymPhase -= 1.0;
    ymPrevL = ymCurL;
    ymPrevR = ymCurR;
    ym_generate(&ymCurL, &ymCurR);
  }
  const double f = ymPhase;
  *l = (int16_t)(ymPrevL + (ymCurL - ymPrevL) * f);
  *r = (int16_t)(ymPrevR + (ymCurR - ymPrevR) * f);
}

// ---------------------------------------------------------------------------
// Audio render for one 60Hz frame (800 stereo samples)
// ---------------------------------------------------------------------------
static void render_frame(int16_t *outBuffer) {
  // Advance the ZSM tick stream at the file's native tick rate
  // (tick rates other than 60 are normalized to the 60 Hz output clock)
  tickAccum += (double)tickRate / (double)FPS;
  while (tickAccum >= 1.0) {
    tickAccum -= 1.0;
    if (currentFrame < totalFrames) {
      apply_frame(currentFrame);
      currentFrame++;
    } else if (loopEnabled && hasLoop) {
      // zsmkit semantics: repoint the stream cursor to the loop offset
      // without resetting PSG/YM state (the loop point state carries over)
      currentFrame = loopFrame;
    } else {
      songFinished = true;
      break;
    }
  }

  float effVol = isMuted ? 0.0f : (masterVolume / 15.0f);
  pcmPeakL = 0;
  pcmPeakR = 0;

  for (int s = 0; s < SAMPLES_PER_FRAME; s++) {
    float mixL = 0.0f, mixR = 0.0f;

    // Noise LFSR (one per output sample)
    psg.noiseState = (psg.noiseState << 1) |
                     (((psg.noiseState >> 1) ^ (psg.noiseState >> 2) ^
                       (psg.noiseState >> 4) ^ (psg.noiseState >> 15)) &
                      1);
    psg.noiseState &= 0xFFFF;

    float psgL = 0.0f, psgR = 0.0f;
    for (int ch = 0; ch < 16; ch++) {
      if (!(psgMask & (1 << ch)))
        continue; // voice masked off by the ZSM header
      uint8_t ctrl = psg.regs[ch * 4 + 2];
      uint8_t volIdx = ctrl & 0x3F;

      bool left = (ctrl & 0x40) != 0;
      bool right = (ctrl & 0x80) != 0;
      if (!left && !right)
        continue; // muted voice: the hardware stops clocking its phase

      uint16_t freq = psg.regs[ch * 4] | (psg.regs[ch * 4 + 1] << 8);
      uint8_t waveReg = psg.regs[ch * 4 + 3];
      uint8_t waveType = waveReg >> 6;
      uint8_t pw = waveReg & 0x3F;

      // 17-bit phase accumulator, 0..0x20000 (VERAAudio.cpp)
      const uint32_t oldPhase = (uint32_t)psg.phase[ch];
      double newPhase = psg.phase[ch] + freq * PSG_PHASE_SCALE;
      newPhase = fmod(newPhase, 0x20000);
      const uint32_t newPhaseInt = (uint32_t)newPhase;
      // Each voice latches its own 6-bit noise sample at every half-period,
      // so the noise is band-limited to the voice frequency instead of being
      // full-bandwidth hiss, and voices are decorrelated from each other.
      if ((oldPhase & 0x10000) && !(newPhaseInt & 0x10000))
        psg.noiseVal[ch] = (int32_t)((psg.noiseState >> 1) & 0x3F);
      psg.phase[ch] = newPhase;

      // 6-bit unsigned waveform value
      int32_t v = 0;
      switch (waveType) {
      case 0: // pulse
        v = ((newPhaseInt >> 10) > pw) ? 0 : 0x3F;
        break;
      case 1: // sawtooth (phase offset by the pulse-width field)
        v = (int32_t)(newPhaseInt >> 11) ^ (int32_t)((pw ^ 0x3F) & 0x3F);
        break;
      case 2: // triangle
        v = (int32_t)((newPhaseInt & 0x10000) ? (~(newPhaseInt >> 10) & 0x3F)
                                             : ((newPhaseInt >> 10) & 0x3F)) ^
            (int32_t)((pw ^ 0x3F) & 0x3F);
        break;
      default: // noise
        v = psg.noiseVal[ch];
        break;
      }

      // 6-bit unsigned -> sign-extended 6-bit, range -32..+31
      int32_t sv = v ^ 0x20;
      if (sv & 0x20)
        sv |= 0xFFC0;
      sv = (sv << 16) >> 16;

      // Hardware voice level: every voice is attenuated by 3 bits, so one
      // full-volume voice is 1/8 of full scale (VERAAudio.cpp: l +=
      // (sv * volume) >> 3). The Developer Board's mixer compensates by
      // doubling the PSG/PCM bus (psgGain/pcmGain default 2.0).
      const float voiceSig =
          (float)sv * (float)volumeLut[volIdx] * (1.0f / 262144.0f);

      if (left)
        psgL += voiceSig;
      if (right)
        psgR += voiceSig;
    }
    mixL += psgL * (float)psgGain;
    mixR += psgR * (float)psgGain;

    // FM (YM2151) output, resampled to SAMPLE_RATE, with adjustable gain
    int16_t ymL, ymR;
    ym_render_sample(&ymL, &ymR);
    mixL += (ymL / 32768.0f) * (float)fmGain;
    mixR += (ymR / 32768.0f) * (float)fmGain;

    // PCM (VERA FIFO emulation): resample the sample clock to SAMPLE_RATE.
    // One sample is consumed per phase wrap; output = sample * VERA PCM
    // volume LUT / 64 (matches the AppleWin VERA card implementation).
    if (pcmBusy && pcmRateByte > 0 && pcmInstIdx >= 0) {
      const int effRate = (pcmRateByte > 128) ? (256 - pcmRateByte) : pcmRateByte;
      if (effRate > 0) {
        const double pcmHz = (double)effRate * (48828.125 / 128.0);
        pcmPhase += pcmHz / (double)SAMPLE_RATE;
        while (pcmPhase >= 1.0) {
          pcmPhase -= 1.0;
          const PcmInst &inst = pcmInsts[pcmInstIdx];
          const int bytesPerSample = ((pcmFormat & 1) ? 2 : 1) * ((pcmFormat & 2) ? 2 : 1);
          if (pcmPos + (uint32_t)bytesPerSample > inst.length) {
            if (inst.looped) {
              pcmPos = inst.loopPoint;
            } else {
              pcmBusy = false;
              pcmCurL = pcmCurR = 0;
              break;
            }
          }
          if (inst.fileOffset + pcmPos + (uint32_t)bytesPerSample > streamSize) {
            pcmBusy = false; // corrupt table: stop
            break;
          }
          pcmPrevL = pcmCurL;
          pcmPrevR = pcmCurR;
          const uint8_t *p = streamData + inst.fileOffset + pcmPos;
          switch (pcmFormat) {
          case 1: // stereo 8-bit
            pcmCurL = (int16_t)((int8_t)p[0] << 8);
            pcmCurR = (int16_t)((int8_t)p[1] << 8);
            break;
          case 2: // mono 16-bit
            pcmCurL = pcmCurR = (int16_t)(p[0] | (p[1] << 8));
            break;
          case 3: // stereo 16-bit
            pcmCurL = (int16_t)(p[0] | (p[1] << 8));
            pcmCurR = (int16_t)(p[2] | (p[3] << 8));
            break;
          default: // mono 8-bit
            pcmCurL = pcmCurR = (int16_t)((int8_t)p[0] << 8);
            break;
          }
          pcmPos += (uint32_t)bytesPerSample;
        }
        const double f = pcmPhase;
        const int32_t pcmL = pcmPrevL + (int32_t)((pcmCurL - pcmPrevL) * f);
        const int32_t pcmR = pcmPrevR + (int32_t)((pcmCurR - pcmPrevR) * f);
        const int vol = pcmVolumeLut[pcmVolume & 0x0F];
        const int pcmOutL = (pcmL * vol) / 64; // raw sample level (0..32767)
        const int pcmOutR = (pcmR * vol) / 64;
        // VU meter: track peak sample level (before gain, so the meter
        // reflects the sample content regardless of the gain setting)
        const int absL = pcmOutL < 0 ? -pcmOutL : pcmOutL;
        const int absR = pcmOutR < 0 ? -pcmOutR : pcmOutR;
        if (absL > pcmPeakL) pcmPeakL = absL;
        if (absR > pcmPeakR) pcmPeakR = absR;
        mixL += ((float)pcmOutL * (float)pcmGain) / 32768.0f;
        mixR += ((float)pcmOutR * (float)pcmGain) / 32768.0f;
      }
    }

    mixL *= effVol;
    mixR *= effVol;

    // Hardware output stage: VERA and the YM2151 are summed linearly and the
    // DAC hard-clips, so no soft limiter here. A tanh saturator used to duck
    // the whole mix (PSG included) at every loud FM attack, and the PSG is
    // quiet enough that it sounded like it was breaking up.
    int32_t valL = (int32_t)(mixL * 32768.0f);
    int32_t valR = (int32_t)(mixR * 32768.0f);

    if (valL > 32767) valL = 32767;
    if (valL < -32767) valL = -32767;
    if (valR > 32767) valR = 32767;
    if (valR < -32767) valR = -32767;

    *outBuffer++ = (int16_t)valL;
    *outBuffer++ = (int16_t)valR;
  }
}

// Fill a multi-frame buffer
static void fill_buffer(int16_t *buffer) {
  if (isPaused || songFinished) {
    memset(buffer, 0, SAMPLES_PER_BUF * 2 * sizeof(int16_t));
    return;
  }
  for (int f = 0; f < FRAMES_PER_BUF; f++) {
    render_frame(buffer + f * SAMPLES_PER_FRAME * 2);
  }
}

static HANDLE hConsole = NULL;
static bool isRealConsole = false;

// Map a PCM sample level (0..32767) to a VU meter symbol
static char pcmSymbol(int level) {
  if (level == 0)
    return '.';
  if (level < 8192)
    return '-';
  if (level < 16384)
    return '=';
  if (level < 24576)
    return '#';
  return '^';
}

static void draw_ui() {
  int curSec = currentFrame / tickRate;
  int curMin = curSec / 60;
  curSec %= 60;

  int totSec = totalFrames / tickRate;
  int totMin = totSec / 60;
  totSec %= 60;

  char progBar[20];
  int filled = totalFrames > 0 ? (currentFrame * 16 / totalFrames) : 0;
  if (filled > 16)
    filled = 16;
  for (int i = 0; i < 16; i++) {
    if (i < filled)
      progBar[i] = '=';
    else if (i == filled)
      progBar[i] = '>';
    else
      progBar[i] = ' ';
  }
  progBar[16] = '\0';

  // Three independent meters: FM key-on (8), PSG voice volume (16), PCM L/R.
  char fmBar[9];
  for (int i = 0; i < 8; i++)
    fmBar[i] = fmKeyOn[i] ? '^' : '.';
  fmBar[8] = '\0';

  char psgBar[17];
  for (int i = 0; i < 16; i++) {
    uint8_t v = channelVols[i];
    psgBar[i] = (v == 0) ? '.' : (v < 15) ? '-' : (v < 35) ? '=' : (v < 50) ? '#' : '^';
  }
  psgBar[16] = '\0';

  char pcmBar[3];
  pcmBar[0] = pcmSymbol(pcmPeakL);
  pcmBar[1] = pcmSymbol(pcmPeakR);
  pcmBar[2] = '\0';

  const char *statusStr =
      isPaused ? "PAUS"
               : (isMuted ? "MUTE" : (loopEnabled ? (hasLoop ? "LOOP" : "REPT") : "1SHT"));

  char line[256];
  snprintf(line, sizeof(line), "%02d:%02d/%02d:%02d [%s] [FM %s] [PSG %s] [PCM %s] V:%02d FM:%.2f PSG:%.2f PCM:%.2f [%s]",
           curMin, curSec, totMin, totSec, progBar, fmBar, psgBar, pcmBar, masterVolume,
           fmGain, psgGain, pcmGain, statusStr);
  printf("\r%-118s", line);
  fflush(stdout);
}

int main(int argc, char **argv) {
  const char *filePath = NULL;

  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--no-loop") == 0) {
      loopEnabled = false;
    } else if (strcmp(argv[i], "--loop") == 0) {
      loopEnabled = true;
    } else if (strcmp(argv[i], "--vol") == 0 && i + 1 < argc) {
      masterVolume = atoi(argv[++i]);
      if (masterVolume < 0) masterVolume = 0;
      if (masterVolume > 15) masterVolume = 15;
    } else if (strcmp(argv[i], "--fmvol") == 0 && i + 1 < argc) {
      fmGain = atof(argv[++i]);
      if (fmGain < 0.0) fmGain = 0.0;
      if (fmGain > 16.0) fmGain = 16.0;
    } else if (strcmp(argv[i], "--psgvol") == 0 && i + 1 < argc) {
      psgGain = atof(argv[++i]);
      if (psgGain < 0.0) psgGain = 0.0;
      if (psgGain > 16.0) psgGain = 16.0;
    } else if (strcmp(argv[i], "--pcmvol") == 0 && i + 1 < argc) {
      pcmGain = atof(argv[++i]);
      if (pcmGain < 0.0) pcmGain = 0.0;
      if (pcmGain > 16.0) pcmGain = 16.0;
    } else if (strcmp(argv[i], "--wav") == 0 && i + 1 < argc) {
      wavOutPath = argv[++i];
    } else if ((strcmp(argv[i], "--time") == 0 || strcmp(argv[i], "--timeout") == 0) && i + 1 < argc) {
      timeoutSeconds = atof(argv[++i]);
    } else if (argv[i][0] != '-') {
      filePath = argv[i];
    }
  }

  if (!filePath) {
    printf("========================================================\n");
    printf(" Melodius for Windows - Commander X16 ZSM / ZCM player\n");
    printf(" YM2151 (FM) + VERA PSG + VERA PCM, hardware-accurate mix\n");
    printf("========================================================\n");
    printf("Usage:\n");
    printf("  melodius.exe <file.zsm|.zcm> [--no-loop] [--vol 0..15] [--fmvol 0.25..16] [--psgvol 0.25..16] [--pcmvol 0.25..16] [--time N] [--wav out.wav]\n\n");
    printf("  Engine gains default to the X16 Developer Board mix: (PSG+PCM)*2 + YM;\n");
    printf("  use --fmvol/--psgvol/--pcmvol (or F1..F6) to rebalance.\n");
    printf("  --wav renders the whole song offline to a 48 kHz stereo WAV and exits.\n");
    printf("  (.mid playback is not included in this build)\n\n");
    printf("Examples:\n");
    printf("  melodius.exe TITLE.ZSM\n");
    printf("  melodius.exe CANYON.ZSM --fmvol 4.0\n\n");
    printf("Looking for .zsm files in current folder:\n");

    WIN32_FIND_DATAA fd;
    HANDLE hFind = FindFirstFileA("*.zsm", &fd);
    int found = 0;
    if (hFind != INVALID_HANDLE_VALUE) {
      do {
        printf("  - %s\n", fd.cFileName);
        found++;
      } while (FindNextFileA(hFind, &fd));
      FindClose(hFind);
    }
    if (!found) {
      printf("  (none found)\n");
    }
    return 0;
  }

  const char *baseName = strrchr(filePath, '\\');
  if (!baseName)
    baseName = strrchr(filePath, '/');
  baseName = baseName ? baseName + 1 : filePath;

  fileKind = detect_kind(filePath);
  if (fileKind == KIND_MID) {
    printf("Error: Standard MIDI File (.mid) playback is not part of this "
           "build.\n");
    printf("       Supported: .zsm/.zm (ZSMKit stream) and .zcm "
           "(ZSound PCM container).\n");
    return 1;
  }
  if (fileKind == KIND_NONE) {
    printf("Error: cannot determine file type of '%s' "
           "(expected .zsm/.zm or .zcm)\n",
           filePath);
    return 1;
  }

  bool loaded = false;
  switch (fileKind) {
  case KIND_ZCM:
    loaded = load_zcm_file(filePath);
    break;
  default:
    loaded = load_zsm_file(filePath);
    break;
  }
  if (!loaded)
    return 1;

  ym2151 = new ymfm::ym2151(ymif);
  ym_reset();
  psg_reset();
  memset(channelVols, 0, sizeof(channelVols));

  // Offline render: write the whole song to a 48 kHz stereo WAV using exactly
  // the same DSP as live playback, then exit without touching waveOut. Useful
  // for A/B comparison against a reference render.
  if (wavOutPath) {
    FILE *w = fopen(wavOutPath, "wb");
    if (!w) {
      printf("Error: cannot open '%s' for writing\n", wavOutPath);
      return 1;
    }
    // Canonical 44-byte WAV header: RIFF/WAVE + 16-byte fmt chunk
    // (audioFormat, channels, sampleRate, byteRate, blockAlign, bitsPerSample)
    // + data chunk.
    // totalFrames counts stream ticks at tickRate; the render loop consumes
    // tickRate/60 ticks per 60 Hz output frame, so the WAV holds
    // totalFrames*60/tickRate frames (ceil so the last tick is not dropped).
    const int outFrames = (int)(((int64_t)totalFrames * FPS + tickRate - 1) / tickRate);
    const uint32_t dataBytes = (uint32_t)((int64_t)outFrames * SAMPLES_PER_FRAME * 4);
    const uint16_t fmtSize = 16, audioFormat = WAVE_FORMAT_PCM;
    const uint16_t chn = 2, bits = 16, blkAlign = 4;
    const uint32_t rate = SAMPLE_RATE, byteRate = rate * blkAlign;
    const uint32_t riffSize = 36 + dataBytes;
    fwrite("RIFF", 1, 4, w);
    fwrite(&riffSize, 4, 1, w);
    fwrite("WAVE", 1, 4, w);
    fwrite("fmt ", 1, 4, w);
    fwrite(&fmtSize, 4, 1, w);
    fwrite(&audioFormat, 2, 1, w);
    fwrite(&chn, 2, 1, w);
    fwrite(&rate, 4, 1, w);
    fwrite(&byteRate, 4, 1, w);
    fwrite(&blkAlign, 2, 1, w);
    fwrite(&bits, 2, 1, w);
    fwrite("data", 1, 4, w);
    fwrite(&dataBytes, 4, 1, w);

    std::vector<int16_t> frameBuf(SAMPLES_PER_FRAME * 2);
    for (int f = 0; f < outFrames; f++) {
      render_frame(frameBuf.data());
      fwrite(frameBuf.data(), 2, frameBuf.size(), w);
    }
    fclose(w);
    printf("Wrote %s (%d frames, %.1fs, FM:%.2f PSG:%.2f PCM:%.2f)\n", wavOutPath,
           outFrames, (double)outFrames / FPS, fmGain, psgGain, pcmGain);
    return 0;
  }

  // Initialize Win32 waveOut
  WAVEFORMATEX wfx;
  ZeroMemory(&wfx, sizeof(wfx));
  wfx.wFormatTag = WAVE_FORMAT_PCM;
  wfx.nChannels = 2;
  wfx.nSamplesPerSec = SAMPLE_RATE;
  wfx.wBitsPerSample = 16;
  wfx.nBlockAlign = wfx.nChannels * (wfx.wBitsPerSample / 8);
  wfx.nAvgBytesPerSec = wfx.nSamplesPerSec * wfx.nBlockAlign;

  MMRESULT res = waveOutOpen(&hWaveOut, WAVE_MAPPER, &wfx, 0, 0, CALLBACK_NULL);
  if (res != MMSYSERR_NOERROR) {
    printf("Error: Failed to open waveOut device (code %u)\n", res);
    return 1;
  }

  for (int i = 0; i < NUM_BUFFERS; i++) {
    audioBuffers[i] = (int16_t *)malloc(SAMPLES_PER_BUF * 2 * sizeof(int16_t));
    ZeroMemory(&waveHeaders[i], sizeof(WAVEHDR));
    waveHeaders[i].lpData = (LPSTR)audioBuffers[i];
    waveHeaders[i].dwBufferLength = SAMPLES_PER_BUF * 2 * sizeof(int16_t);
    waveOutPrepareHeader(hWaveOut, &waveHeaders[i], sizeof(WAVEHDR));

    fill_buffer(audioBuffers[i]);
    waveOutWrite(hWaveOut, &waveHeaders[i], sizeof(WAVEHDR));
  }

  CONSOLE_SCREEN_BUFFER_INFO csbi;
  CONSOLE_CURSOR_INFO origCursorInfo, hideCursorInfo;
  hConsole = GetStdHandle(STD_OUTPUT_HANDLE);
  isRealConsole = (GetConsoleScreenBufferInfo(hConsole, &csbi) != 0);

  BOOL hasCursorInfo = FALSE;
  if (isRealConsole) {
    hasCursorInfo = GetConsoleCursorInfo(hConsole, &origCursorInfo);
    if (hasCursorInfo) {
      hideCursorInfo = origCursorInfo;
      hideCursorInfo.bVisible = FALSE;
      SetConsoleCursorInfo(hConsole, &hideCursorInfo);
    }
  }

  printf("============================================================================================================\n");
  printf(" Melodius (YM2151 + VERA PSG + VERA PCM) -- %s\n", baseName);
  printf(" Ticks: %d (%.1fs) | Loop Tick: %d | Stream: %zu bytes\n", totalFrames,
         totalFrames / (double)tickRate, loopFrame, streamSize);
  if (!pcmInsts.empty()) {
    printf(" PCM: %d instrument(s)%s\n", (int)pcmInsts.size(),
           pcmInsts[0].looped ? " (looped)" : "");
  }
  if (tickRate != 60) {
    printf(" Tick rate: %u ticks/sec (normalized to 60 Hz)\n", tickRate);
  }
  printf(" Keys: SPACE/P=Pause  M=Mute  +/-=Vol  F1/F2=FM  F3/F4=PSG  F5/F6=PCM  [/]=Seek 5s  L=Loop R=Restart Q=Quit\n");
  printf("============================================================================================================\n\n");

  int bufIdx = 0;
  DWORD startTick = GetTickCount();
  DWORD lastUiTick = 0;

  while (isRunning) {
    DWORD now = GetTickCount();
    if (timeoutSeconds > 0.0 && (now - startTick) >= (DWORD)(timeoutSeconds * 1000.0)) {
      break;
    }
    if (_kbhit()) {
      int ch = _getch();
      if (ch == 0 || ch == 224) {
        ch = _getch();
        if (ch == 59) { // F1: FM gain down
          if (fmGain > 0.25) fmGain -= 0.25;
        } else if (ch == 60) { // F2: FM gain up
          if (fmGain < 16.0) fmGain += 0.25;
        } else if (ch == 61) { // F3: PSG gain down
          if (psgGain > 0.25) psgGain -= 0.25;
        } else if (ch == 62) { // F4: PSG gain up
          if (psgGain < 16.0) psgGain += 0.25;
        } else if (ch == 63) { // F5: PCM gain down
          if (pcmGain > 0.25) pcmGain -= 0.25;
        } else if (ch == 64) { // F6: PCM gain up
          if (pcmGain < 16.0) pcmGain += 0.25;
        }
      }
      if (ch == 27 || ch == 'q' || ch == 'Q') {
        isRunning = false;
        break;
      } else if (ch == ' ' || ch == 'p' || ch == 'P') {
        isPaused = !isPaused;
      } else if (ch == 'm' || ch == 'M') {
        isMuted = !isMuted;
      } else if (ch == '+' || ch == '=') {
        if (masterVolume < 15) masterVolume++;
      } else if (ch == '-' || ch == '_') {
        if (masterVolume > 0) masterVolume--;
      } else if (ch == ']') {
        seek_frame(currentFrame + 300);
      } else if (ch == '[') {
        seek_frame(currentFrame - 300);
      } else if (ch == 'r' || ch == 'R') {
        seek_frame(0);
      } else if (ch == 'l' || ch == 'L') {
        loopEnabled = !loopEnabled;
      }
    }

    if (waveHeaders[bufIdx].dwFlags & WHDR_DONE) {
      fill_buffer(audioBuffers[bufIdx]);
      waveOutWrite(hWaveOut, &waveHeaders[bufIdx], sizeof(WAVEHDR));
      bufIdx = (bufIdx + 1) % NUM_BUFFERS;
    } else {
      Sleep(5);
    }

    now = GetTickCount();
    DWORD uiInterval = isRealConsole ? 50 : 500;
    if (now - lastUiTick >= uiInterval) {
      draw_ui();
      lastUiTick = now;
    }

    if (songFinished) {
      // The stream ran out with no loop point to return to (or looping is
      // disabled): let the queued audio buffers drain, then stop and exit.
      Sleep(200);
      break;
    }
  }

  if (hasCursorInfo) {
    SetConsoleCursorInfo(hConsole, &origCursorInfo);
  }

  printf("\n\nPlayback stopped.\n");

  waveOutReset(hWaveOut);
  for (int i = 0; i < NUM_BUFFERS; i++) {
    waveOutUnprepareHeader(hWaveOut, &waveHeaders[i], sizeof(WAVEHDR));
    free(audioBuffers[i]);
  }
  waveOutClose(hWaveOut);

  if (ym2151)
    delete ym2151;
  if (streamData)
    free(streamData);

  return 0;
}
