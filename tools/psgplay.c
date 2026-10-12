/**
 * psgplay.c — Native Windows VERA PSG Stream Player
 *
 * Plays .psg files generated for the Apple II VERA sound card or Commander X16.
 * Implements full 16-channel VERA PSG audio synthesis and streams in real time
 * via Win32 waveOut (MME) with zero external dependencies.
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

#pragma comment(lib, "winmm.lib")

#define SAMPLE_RATE 48000
#define FPS 60
#define SAMPLES_PER_FRAME (SAMPLE_RATE / FPS) // exactly 800 samples
#define FRAMES_PER_BUF 4 // 4 frames = 3200 samples (~66.7ms)
#define SAMPLES_PER_BUF (SAMPLES_PER_FRAME * FRAMES_PER_BUF)
#define NUM_BUFFERS 4
#define PSG_CLOCK (25000000.0 / 512.0) // 48828.125 Hz
// The VERA PSG phase accumulator runs 0..0x20000 (17-bit) and advances by
// freq * (PSG_CLOCK / sampleRate) — see VERAAudio.cpp renderSample().
#define PSG_PHASE_SCALE (PSG_CLOCK / (double)SAMPLE_RATE)

// 64-entry VERA logarithmic volume lookup table
static const uint16_t volumeLut[64] = {
    0,   4,   8,   12,  16,  17,  18,  20,  21,  22,  23,  25,  26,
    28,  30,  31,  33,  35,  37,  40,  42,  45,  47,  50,  53,  56,
    60,  63,  67,  71,  75,  80,  85,  90,  95,  101, 107, 113, 120,
    127, 135, 143, 151, 160, 170, 180, 191, 202, 214, 227, 241, 255,
    270, 286, 303, 321, 341, 361, 382, 405, 429, 455, 482, 511};

typedef struct {
  uint8_t regs[64];
  double phase[16];      // 0..0x20000 VERA fixed-point phase accumulator
  int32_t noiseVal[16];  // 6-bit noise sample latched per voice (0x00..0x3F)
  uint32_t noiseState;
} PsgState;

static PsgState psg;

// Stream data
static uint8_t *streamData = NULL;
static size_t streamSize = 0;
static size_t *frameOffsets = NULL;
static int totalFrames = 0;
static int loopFrame = 0;
static bool hasLoop = false;
static bool loopEnabled = true;

// Player state
static int currentFrame = 0;
static int masterVolume = 12; // 0..15
static bool isMuted = false;
static bool isPaused = false;
static bool isRunning = true;
static bool songFinished = false;
static double timeoutSeconds = 0.0;
static const char *wavOutPath = NULL;
static uint8_t channelVols[16] = {0};

// Audio buffers
static HWAVEOUT hWaveOut = NULL;
static WAVEHDR waveHeaders[NUM_BUFFERS];
static int16_t *audioBuffers[NUM_BUFFERS];

// Reset PSG state
static void psg_reset(void) {
  memset(psg.regs, 0, sizeof(psg.regs));
  for (int i = 0; i < 16; i++) {
    psg.phase[i] = 0.0;
    psg.noiseVal[i] = 0;
  }
  psg.noiseState = 1;
}

// Apply register writes for a specific frame
static void psg_apply_frame(int frameIdx) {
  if (frameIdx < 0 || frameIdx >= totalFrames)
    return;
  size_t offset = frameOffsets[frameIdx];
  uint8_t count = streamData[offset];
  if (count == 0xFF)
    return;
  for (int i = 0; i < count; i++) {
    uint8_t reg = streamData[offset + 1 + i * 2];
    uint8_t val = streamData[offset + 2 + i * 2];
    if (reg < 64) {
      psg.regs[reg] = val;
    }
  }
}

// Seek to a frame by resetting and replaying from frame 0
static void psg_seek(int targetFrame) {
  if (targetFrame < 0)
    targetFrame = 0;
  if (targetFrame >= totalFrames)
    targetFrame = totalFrames - 1;

  psg_reset();
  for (int f = 0; f <= targetFrame; f++) {
    psg_apply_frame(f);
  }
  currentFrame = targetFrame;
  songFinished = false;
}

// Parse and validate .psg file into frame offset table
static bool load_psg_file(const char *filename) {
  FILE *fp = fopen(filename, "rb");
  if (!fp) {
    printf("Error: Cannot open file '%s'\n", filename);
    return false;
  }
  fseek(fp, 0, SEEK_END);
  streamSize = ftell(fp);
  fseek(fp, 0, SEEK_SET);

  if (streamSize < 4) {
    printf("Error: File is too small to be a valid .psg file\n");
    fclose(fp);
    return false;
  }

  streamData = (uint8_t *)malloc(streamSize);
  if (!streamData) {
    printf("Error: Memory allocation failure\n");
    fclose(fp);
    return false;
  }

  if (fread(streamData, 1, streamSize, fp) != streamSize) {
    printf("Error: Failed to read file data\n");
    fclose(fp);
    return false;
  }
  fclose(fp);

  // First pass: count frames
  size_t ptr = 0;
  int count = 0;
  while (ptr < streamSize) {
    uint8_t c = streamData[ptr];
    if (c == 0xFF)
      break;
    if (c > 64) {
      printf("Error: Invalid frame count %u at byte offset %zu\n", c, ptr);
      return false;
    }
    ptr += 1 + c * 2;
    count++;
  }

  if (ptr >= streamSize || streamData[ptr] != 0xFF) {
    printf("Error: Missing 0xFF terminator in .psg stream\n");
    return false;
  }

  if (ptr + 2 < streamSize) {
    loopFrame = streamData[ptr + 1] | (streamData[ptr + 2] << 8);
    hasLoop = (loopFrame < count && (loopFrame > 0 || count > 300));
  } else {
    loopFrame = 0;
    hasLoop = false;
  }

  totalFrames = count;
  frameOffsets = (size_t *)malloc(totalFrames * sizeof(size_t));
  if (!frameOffsets) {
    printf("Error: Memory allocation failure for frame offsets\n");
    return false;
  }

  // Second pass: store frame offsets
  ptr = 0;
  for (int f = 0; f < totalFrames; f++) {
    frameOffsets[f] = ptr;
    uint8_t c = streamData[ptr];
    ptr += 1 + c * 2;
  }

  return true;
}

// Synthesize audio for one 60Hz frame (800 stereo samples)
static void render_frame(int16_t *outBuffer) {
  if (currentFrame < totalFrames) {
    psg_apply_frame(currentFrame);
    currentFrame++;
  } else {
    if (loopEnabled && loopFrame < totalFrames) {
      psg_seek(loopFrame);
    } else {
      songFinished = true;
    }
  }

  float effVol = isMuted ? 0.0f : (masterVolume / 15.0f);

  for (int s = 0; s < SAMPLES_PER_FRAME; s++) {
    float mixL = 0.0f, mixR = 0.0f;

    // The VERA clocks the noise LFSR once per output sample, not once per
    // voice (clocking it per voice made the noise far too fast).
    psg.noiseState = (psg.noiseState << 1) |
                     (((psg.noiseState >> 1) ^ (psg.noiseState >> 2) ^
                       (psg.noiseState >> 4) ^ (psg.noiseState >> 15)) &
                      1);
    psg.noiseState &= 0xFFFF;

    for (int ch = 0; ch < 16; ch++) {
      uint8_t ctrl = psg.regs[ch * 4 + 2];
      uint8_t volIdx = ctrl & 0x3F;
      if (s == 0)
        channelVols[ch] = volIdx;

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
      // voice at full volume is ~1980/32767 and all 16 sum to just under full
      // scale (VERAAudio.cpp: l += (sv * volume) >> 3).
      const float voiceSig =
          (float)sv * (float)volumeLut[volIdx] * (1.0f / 262144.0f);

      if (left)
        mixL += voiceSig;
      if (right)
        mixR += voiceSig;
    }

    mixL *= effVol;
    mixR *= effVol;

    // Soft analog-style tanh saturation. The PSG is now at hardware level
    // (16 voices ~= full scale), so a 2.0x drive reproduces the previous
    // output level while keeping the curve linear instead of slamming it.
    float satL = tanhf(mixL * 2.0f);
    float satR = tanhf(mixR * 2.0f);

    int32_t valL = (int32_t)(satL * 30000.0f);
    int32_t valR = (int32_t)(satR * 30000.0f);

    if (valL > 32767)
      valL = 32767;
    if (valL < -32767)
      valL = -32767;
    if (valR > 32767)
      valR = 32767;
    if (valR < -32767)
      valR = -32767;

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

// Display single-line status bar in place (using \r, strictly no newlines)
static void draw_ui(const char *title) {
  int curSec = currentFrame / 60;
  int curMin = curSec / 60;
  curSec %= 60;

  int totSec = totalFrames / 60;
  int totMin = totSec / 60;
  totSec %= 60;

  // Progress bar (16 characters)
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

  // 16 Voice activity bar
  char chBar[18];
  for (int i = 0; i < 16; i++) {
    uint8_t v = channelVols[i];
    if (v == 0)
      chBar[i] = '.';
    else if (v < 15)
      chBar[i] = '-';
    else if (v < 35)
      chBar[i] = '=';
    else if (v < 50)
      chBar[i] = '#';
    else
      chBar[i] = '^';
  }
  chBar[16] = '\0';

  const char *statusStr =
      isPaused
          ? "PAUS"
          : (isMuted ? "MUTE"
                     : (loopEnabled ? (hasLoop ? "LOOP" : "REPT") : "1SHT"));

  char line[128];
  snprintf(line, sizeof(line),
           "[%-12.12s] %02d:%02d/%02d:%02d [%s] [%s] V:%02d [%s]", title,
           curMin, curSec, totMin, totSec, progBar, chBar, masterVolume,
           statusStr);

  // Exactly 77 characters padded with spaces, never wraps and never scrolls
  printf("\r%-77s", line);
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
      if (masterVolume < 0)
        masterVolume = 0;
      if (masterVolume > 15)
        masterVolume = 15;
    } else if ((strcmp(argv[i], "--time") == 0 ||
                strcmp(argv[i], "--timeout") == 0) &&
               i + 1 < argc) {
      timeoutSeconds = atof(argv[++i]);
    } else if (strcmp(argv[i], "--wav") == 0 && i + 1 < argc) {
      wavOutPath = argv[++i];
    } else if (argv[i][0] != '-') {
      filePath = argv[i];
    }
  }

  if (!filePath) {
    printf("========================================================\n");
    printf(" VERA PSG Stream Player for Windows (psgplay v1.0)\n");
    printf("========================================================\n");
    printf("Usage:\n");
    printf("  psgplay.exe <file.psg> [--no-loop] [--vol 0..15] [--wav out.wav]\n\n");
    printf("Examples:\n");
    printf("  psgplay.exe TITLE.psg\n");
    printf("  psgplay.exe ..\\music\\BeatIt.psg\n\n");
    printf("Looking for .psg files in current folder:\n");

    WIN32_FIND_DATAA fd;
    HANDLE hFind = FindFirstFileA("*.psg", &fd);
    int found = 0;
    if (hFind != INVALID_HANDLE_VALUE) {
      do {
        printf("  - %s\n", fd.cFileName);
        found++;
      } while (FindNextFileA(hFind, &fd));
      FindClose(hFind);
    }
    if (!found) {
      printf("  (none found in current folder, check ..\\music\\)\n");
    }
    return 0;
  }

  // Extract basename for display
  const char *baseName = strrchr(filePath, '\\');
  if (!baseName)
    baseName = strrchr(filePath, '/');
  baseName = baseName ? baseName + 1 : filePath;

  if (!load_psg_file(filePath)) {
    return 1;
  }

  psg_reset();
  psg_seek(0);

  // Offline render: write the whole stream to a 48 kHz stereo WAV using exactly
  // the same DSP as live playback, then exit without touching waveOut. Matches
  // melodius.exe --wav so PSG streams can be A/B'd against a reference render.
  if (wavOutPath) {
    FILE *w = fopen(wavOutPath, "wb");
    if (!w) {
      printf("Error: cannot open '%s' for writing\n", wavOutPath);
      return 1;
    }
    // Canonical 44-byte WAV header: RIFF/WAVE + 16-byte fmt chunk
    // (audioFormat, channels, sampleRate, byteRate, blockAlign, bitsPerSample)
    // + data chunk.
    const uint32_t dataBytes = (uint32_t)(totalFrames * SAMPLES_PER_FRAME * 4);
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

    int16_t *frameBuf = (int16_t *)malloc(SAMPLES_PER_FRAME * 2 * sizeof(int16_t));
    if (!frameBuf) {
      printf("Error: out of memory\n");
      fclose(w);
      return 1;
    }
    for (int f = 0; f < totalFrames; f++) {
      render_frame(frameBuf);
      fwrite(frameBuf, 2, SAMPLES_PER_FRAME * 2, w);
    }
    free(frameBuf);
    fclose(w);
    printf("Wrote %s (%d frames, %.1fs)\n", wavOutPath, totalFrames,
           totalFrames / (double)FPS);
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

  printf("====================================================================="
         "===\n");
  printf(" VERA PSG Stream Player -- %s\n", baseName);
  printf(" Frames: %d (%.1fs) | Loop Frame: %d | Stream Size: %zu bytes\n",
         totalFrames, totalFrames / 60.0, loopFrame, streamSize);
  printf(" Keys: SPACE/P=Pause  M=Mute  +/-=Vol  [/]=Seek 5s  L=Loop R=Restart Q=Quit\n");
  printf("====================================================================="
         "===\n\n");

  int bufIdx = 0;
  DWORD startTick = GetTickCount();
  DWORD lastUiTick = 0;

  while (isRunning) {
    // Check timeout
    DWORD now = GetTickCount();
    if (timeoutSeconds > 0.0 &&
        (now - startTick) >= (DWORD)(timeoutSeconds * 1000.0)) {
      break;
    }
    // Check keyboard input
    if (_kbhit()) {
      int ch = _getch();
      if (ch == 0 || ch == 224) {
        ch = _getch(); // handle arrow/fn keys
      }
      if (ch == 27 || ch == 'q' || ch == 'Q') { // ESC or Q
        isRunning = false;
        break;
      } else if (ch == ' ' || ch == 'p' || ch == 'P') { // Pause
        isPaused = !isPaused;
      } else if (ch == 'm' || ch == 'M') { // Mute
        isMuted = !isMuted;
      } else if (ch == '+' || ch == '=') { // Vol up
        if (masterVolume < 15)
          masterVolume++;
      } else if (ch == '-' || ch == '_') { // Vol down
        if (masterVolume > 0)
          masterVolume--;
      } else if (ch == ']') { // Fast forward 5s (+300 frames)
        psg_seek(currentFrame + 300);
      } else if (ch == '[') { // Rewind 5s (-300 frames)
        psg_seek(currentFrame - 300);
      } else if (ch == 'r' || ch == 'R') { // Restart
        psg_seek(0);
      } else if (ch == 'l' || ch == 'L') { // Toggle loop
        loopEnabled = !loopEnabled;
      }
    }

    // Wait for buffer to be done playing
    if (waveHeaders[bufIdx].dwFlags & WHDR_DONE) {
      fill_buffer(audioBuffers[bufIdx]);
      waveOutWrite(hWaveOut, &waveHeaders[bufIdx], sizeof(WAVEHDR));
      bufIdx = (bufIdx + 1) % NUM_BUFFERS;
    } else {
      Sleep(5);
    }

    // Update UI (50ms in real console, 500ms in piped output)
    now = GetTickCount();
    DWORD uiInterval = isRealConsole ? 50 : 500;
    if (now - lastUiTick >= uiInterval) {
      draw_ui(baseName);
      lastUiTick = now;
    }

    if (songFinished && !loopEnabled) {
      // Give audio buffer time to flush
      Sleep(200);
      break;
    }
  }

  if (hasCursorInfo) {
    SetConsoleCursorInfo(hConsole, &origCursorInfo);
  }

  printf("\n\nPlayback stopped.\n");

  // Cleanup waveOut
  waveOutReset(hWaveOut);
  for (int i = 0; i < NUM_BUFFERS; i++) {
    waveOutUnprepareHeader(hWaveOut, &waveHeaders[i], sizeof(WAVEHDR));
    free(audioBuffers[i]);
  }
  waveOutClose(hWaveOut);

  if (streamData)
    free(streamData);
  if (frameOffsets)
    free(frameOffsets);

  return 0;
}
