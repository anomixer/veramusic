/**
 * zsmplay.cpp — Native Windows FM (YM2151) + VERA PSG ZSM Player
 *
 * Plays Commander X16 ZSM music files (.zsm) natively on Windows, rendering
 * both the VERA PSG (16 channels) and the YM2151 (FM) audio paths with
 * ymfm. Zero external dependencies.
 *
 * Usage:
 *   zsmplay.exe <file.zsm> [--no-loop] [--vol 0..15] [--time N]
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
  double phase[16];
  uint32_t noiseState;
} PsgState;

static PsgState psg;

static void psg_reset(void) {
  memset(psg.regs, 0, sizeof(psg.regs));
  for (int i = 0; i < 16; i++)
    psg.phase[i] = 0.0;
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
// Player state
// ---------------------------------------------------------------------------
static int currentFrame = 0;
static int masterVolume = 15; // 0..15
static double fmGain = 12.0;  // FM (YM2151) mix gain
static double pcmGain = 12.0;  // VERA PCM mix gain (F5/F6)
static double psgGain = 12.0;  // VERA PSG mix gain (F3/F4)
static bool isMuted = false;
static bool isPaused = false;
static bool isRunning = true;
static bool songFinished = false;
static double tickAccum = 0.0; // ZSM tick accumulator (normalizes non-60Hz tick rates)
static double timeoutSeconds = 0.0;
static uint8_t channelVols[16] = {0};
static bool loopEnabled = true;

static HWAVEOUT hWaveOut = NULL;
static WAVEHDR waveHeaders[NUM_BUFFERS];
static int16_t *audioBuffers[NUM_BUFFERS];

// Apply all register writes for a specific frame
static void apply_frame(int frameIdx) {
  if (frameIdx < 0 || frameIdx >= totalFrames)
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
      const double samples = (double)(targetFrame - pcmTriggerTick) * pcmHz / 60.0;
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
    float noiseVal = (psg.noiseState & 1) ? 1.0f : -1.0f;

    float psgL = 0.0f, psgR = 0.0f;
    for (int ch = 0; ch < 16; ch++) {
      if (!(psgMask & (1 << ch)))
        continue; // voice masked off by the ZSM header
      uint8_t ctrl = psg.regs[ch * 4 + 2];
      uint8_t volIdx = ctrl & 0x3F;
      if (volIdx == 0)
        continue;

      bool left = (ctrl & 0x40) != 0;
      bool right = (ctrl & 0x80) != 0;
      if (!left && !right)
        continue;

      uint16_t freq = psg.regs[ch * 4] | (psg.regs[ch * 4 + 1] << 8);
      double step = ((double)freq / 131072.0) * (PSG_CLOCK / (double)SAMPLE_RATE);
      psg.phase[ch] += step;
      if (psg.phase[ch] >= 1.0) {
        psg.phase[ch] -= floor(psg.phase[ch]);
      }
      double p = psg.phase[ch];

      uint8_t waveReg = psg.regs[ch * 4 + 3];
      uint8_t waveType = (waveReg >> 6) & 3;
      uint8_t pw = waveReg & 0x3F;

      float samp = 0.0f;
      if (waveType == 0) { // Pulse
        double duty = (pw + 1.0) / 128.0;
        samp = (p < duty) ? 1.0f : -1.0f;
      } else if (waveType == 1) { // Sawtooth
        samp = (float)(2.0 * p - 1.0);
      } else if (waveType == 2) { // Triangle
        samp = (float)(p < 0.5 ? (4.0 * p - 1.0) : (3.0 - 4.0 * p));
      } else { // Noise
        samp = noiseVal;
      }

      float volAmp = volumeLut[volIdx] / 511.0f;
      float voiceSig = samp * volAmp;

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

    // Soft analog-style tanh saturation
    float satL = tanhf(mixL / 8.0f);
    float satR = tanhf(mixR / 8.0f);

    int32_t valL = (int32_t)(satL * 30000.0f);
    int32_t valR = (int32_t)(satR * 30000.0f);

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

static void draw_ui(const char *title) {
  int curSec = currentFrame / 60;
  int curMin = curSec / 60;
  curSec %= 60;

  int totSec = totalFrames / 60;
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

  char chBar[20];
  if (fmMask != 0) {
    // FM+PSG track: slots 0-7 = YM2151 channels (key-on), slots 8-15 = PSG voices 0-7
    for (int i = 0; i < 8; i++)
      chBar[i] = fmKeyOn[i] ? '^' : '.';
    for (int i = 0; i < 8; i++) {
      uint8_t v = channelVols[i];
      chBar[8 + i] = (v == 0) ? '.' : (v < 15) ? '-' : (v < 35) ? '=' : (v < 50) ? '#' : '^';
    }
  } else {
    // Pure PSG track: 16 voices
    for (int i = 0; i < 16; i++) {
      uint8_t v = channelVols[i];
      chBar[i] = (v == 0) ? '.' : (v < 15) ? '-' : (v < 35) ? '=' : (v < 50) ? '#' : '^';
    }
  }
  // Slots 16-17: VERA PCM L/R output level (peak sample, 0..32767)
  chBar[16] = pcmSymbol(pcmPeakL);
  chBar[17] = pcmSymbol(pcmPeakR);
  chBar[18] = '\0';

  const char *statusStr =
      isPaused ? "PAUS"
               : (isMuted ? "MUTE" : (loopEnabled ? (hasLoop ? "LOOP" : "REPT") : "1SHT"));

  char line[256];
  snprintf(line, sizeof(line), "[%-12.12s] %02d:%02d/%02d:%02d [%s] [%s] V:%02d FM:%.2f PSG:%.2f PCM:%.2f [%s]",
           title, curMin, curSec, totMin, totSec, progBar, chBar, masterVolume,
           fmGain, psgGain, pcmGain, statusStr);
  printf("\r%-110s", line);
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
    } else if ((strcmp(argv[i], "--time") == 0 || strcmp(argv[i], "--timeout") == 0) && i + 1 < argc) {
      timeoutSeconds = atof(argv[++i]);
    } else if (argv[i][0] != '-') {
      filePath = argv[i];
    }
  }

  if (!filePath) {
    printf("========================================================\n");
    printf(" FM + PSG + PCM ZSM Player for Windows (zsmplay v1.1)\n");
    printf("========================================================\n");
    printf("Usage:\n");
    printf("  zsmplay.exe <file.zsm> [--no-loop] [--vol 0..15] [--fmvol 0.25..16] [--psgvol 0.25..16] [--pcmvol 0.25..16] [--time N]\n\n");
    printf("Examples:\n");
    printf("  zsmplay.exe TITLE.ZSM\n");
    printf("  zsmplay.exe ..\\assets\\CANYON.ZSM --fmvol 4.0\n\n");
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

  if (!load_zsm_file(filePath)) {
    return 1;
  }

  ym2151 = new ymfm::ym2151(ymif);
  ym_reset();
  psg_reset();
  memset(channelVols, 0, sizeof(channelVols));

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
  printf(" FM + PSG + PCM ZSM Player -- %s\n", baseName);
  printf(" Frames: %d (%.1fs) | Loop Frame: %d | Stream: %zu bytes\n", totalFrames,
         totalFrames / 60.0, loopFrame, streamSize);
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
      draw_ui(baseName);
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
