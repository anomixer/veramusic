/* Standalone FamiTracker .ftm -> VERA PSG audition player.
 * Reads 2A03 FTM 0.4.2-0.4.6 files directly; no FamiStudio/FamiTone/Node.
 * This is a lightweight PSG port, not a cycle-accurate NES APU emulator.
 */
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <algorithm>
#include <array>
#include <conio.h>
#include <fstream>
#include <functional>
#include <iostream>
#include <iterator>
#include <map>
#include <math.h>
#include <windows.h>
#include <mmsystem.h>
#include <stdexcept>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <string>
#include <vector>

#pragma comment(lib, "winmm.lib")

static const int RATE = 48000, FPS = 60, SAMPLES_PER_FRAME = RATE / FPS;
static const double VERA_CLOCK = 25000000.0 / 512.0;
static const double NES_CPU_CLOCK = 1789773.0;
// NTSC APU noise timer periods, in CPU cycles, from FamiStudio's bundled
// NesSndEmu/Nes_Oscs.cpp. These are the source engine's actual update periods.
static const int NES_NOISE_PERIOD[16] = {
    4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068};
static const uint16_t volumeLut[64] = {
    0,   4,   8,   12,  16,  17,  18,  20,  21,  22,  23,  25,  26,
    28,  30,  31,  33,  35,  37,  40,  42,  45,  47,  50,  53,  56,
    60,  63,  67,  71,  75,  80,  85,  90,  95,  101, 107, 113, 120,
    127, 135, 143, 151, 160, 170, 180, 191, 202, 214, 227, 241, 255,
    270, 286, 303, 321, 341, 361, 382, 405, 429, 455, 482, 511};
struct Reader {
  std::vector<uint8_t> b;
  size_t p = 0;
  std::string label = "FTM";
  uint8_t u8() {
    if (p >= b.size())
      throw std::runtime_error("truncated " + label);
    return b[p++];
  }
  uint32_t u32() {
    uint32_t v = 0;
    for (int i = 0; i < 4; i++)
      v |= (uint32_t)u8() << (i * 8);
    return v;
  }
  int32_t i32() { return (int32_t)u32(); }
  std::string str(size_t n) {
    if (p + n > b.size())
      throw std::runtime_error("truncated " + label);
    std::string s((char *)&b[p], n);
    p += n;
    return s;
  }
  void skip(size_t n) {
    if (p + n > b.size())
      throw std::runtime_error("truncated " + label);
    p += n;
  }
};
struct Seq {
  std::vector<int8_t> v;
  int loop = -1, release = -1, setting = 0;
};
struct Inst {
  std::string name;
  std::array<int, 5> enabled{}, seq{};
};
struct Note {
  uint8_t pitch = 0, oct = 0, inst = 0xff, vol = 16, fx = 0, fp = 0;
};
struct Pattern {
  std::map<int, Note> rows;
};
struct Song {
  std::string name;
  int frames = 0, speed = 6, tempo = 150, rows = 64;
  std::vector<std::array<int, 5>> order;
  std::array<std::array<int, 64>, 5> unused{};
  std::array<std::map<int, Pattern>, 5> pat;
};
struct Project {
  std::vector<Song> songs;
  std::map<std::pair<int, int>, Seq> seq;
  std::array<Inst, 64> inst;
  int instCount = 0;
};

static std::string fixedName(const std::string &s) {
  auto n = s.find('\0');
  return s.substr(0, n);
}
static Project loadFtm(const char *path) {
  Reader r;
  std::ifstream f(path, std::ios::binary);
  if (!f)
    throw std::runtime_error("cannot open input FTM");
  r.b.assign(std::istreambuf_iterator<char>(f), {});
  if (r.b.size() < 22)
    throw std::runtime_error("file too short");
  if (r.str(18) != "FamiTracker Module")
    throw std::runtime_error("not a FamiTracker .ftm file");
  uint32_t ver = r.u32();
  if (ver < 0x420 || ver > 0x440)
    throw std::runtime_error("supports FTM 0.4.2 through 0.4.6");
  struct Block {
    uint32_t ver;
    std::vector<uint8_t> b;
  };
  std::map<std::string, Block> blocks;
  for (int guard = 0; guard < 64; guard++) {
    if (r.p + 3 <= r.b.size() && r.b[r.p] == 'E' && r.b[r.p + 1] == 'N' &&
        r.b[r.p + 2] == 'D')
      break;
    std::string id = fixedName(r.str(16));
    if (id == "END")
      break;
    uint32_t bv = r.u32(), sz = r.u32();
    if (sz > r.b.size() - r.p)
      throw std::runtime_error("bad FTM block size");
    Block x;
    x.ver = bv;
    x.b.assign(r.b.begin() + r.p, r.b.begin() + r.p + sz);
    r.p += sz;
    blocks[id] = std::move(x);
  }
  auto get = [&](const char *id) -> Reader {
    auto it = blocks.find(id);
    if (it == blocks.end())
      throw std::runtime_error(std::string("missing FTM block ") + id);
    Reader q;
    q.b = it->second.b;
    q.label = id;
    return q;
  };
  Reader prm = get("PARAMS");
  int expansion = prm.u8(), channels = prm.i32(), machine = prm.i32();
  (void)machine;
  prm.skip(8);
  if (prm.p + 8 <= prm.b.size())
    prm.skip(8);
  if (expansion != 0 || channels != 5)
    throw std::runtime_error("standalone player currently supports 2A03-only "
                             "five-channel FTM files");
  Project out;
  Reader hdr = get("HEADER");
  int songCount = (int)hdr.u8() + 1;
  if (songCount < 1 || songCount > 64)
    throw std::runtime_error("invalid FTM song count");
  for (int s = 0; s < songCount; s++) {
    Song song;
    for (;;) {
      uint8_t c = hdr.u8();
      if (!c)
        break;
      song.name.push_back((char)c);
    }
    out.songs.push_back(song);
  }
  std::array<std::array<int, 64>, 5> fxCols{};
  std::array<int, 5> chanType{};
  for (int c = 0; c < channels; c++) {
    chanType[c] = hdr.u8();
    for (int s = 0; s < songCount; s++)
      fxCols[c][s] = hdr.u8();
  }
  Reader ins = get("INSTRUMENTS");
  out.instCount = ins.i32();
  if (out.instCount < 0 || out.instCount > 64)
    throw std::runtime_error("bad instrument count");
  for (int k = 0; k < out.instCount; k++) {
    int index = ins.i32();
    uint8_t type = ins.u8();
    if (index < 0 || index >= 64 || type != 1)
      throw std::runtime_error("only 2A03 instruments are supported");
    ins.skip(4);
    Inst &x = out.inst[index];
    for (int e = 0; e < 5; e++) {
      x.enabled[e] = ins.u8();
      x.seq[e] = ins.u8();
    }
    ins.skip(8 * 12 * (blocks["INSTRUMENTS"].ver > 5 ? 3 : 2));
    int nameLen = ins.i32();
    x.name = ins.str(nameLen);
  }
  Reader sr = get("SEQUENCES");
  int seqCount = sr.i32();
  if (seqCount < 0 || seqCount > 512)
    throw std::runtime_error("bad sequence count");
  std::vector<std::pair<int, int>> seqKeys;
  seqKeys.reserve(seqCount);
  for (int i = 0; i < seqCount; i++) {
    int ix = sr.i32(), type = sr.i32();
    int n = sr.u8();
    Seq q;
    q.loop = sr.i32();
    for (int j = 0; j < n; j++)
      q.v.push_back((int8_t)sr.u8());
    out.seq[{ix, type}] = q;
    seqKeys.push_back({ix, type});
  }
  for (int i = 0; i < seqCount; i++) {
    out.seq[seqKeys[i]].release = sr.i32();
    out.seq[seqKeys[i]].setting = sr.i32();
  }
  Reader fr = get("FRAMES");
  for (int s = 0; s < songCount; s++) {
    Song &q = out.songs[s];
    q.frames = fr.i32();
    q.speed = fr.i32();
    q.tempo = fr.i32();
    q.rows = fr.i32();
    if (q.frames < 1 || q.frames > 256 || q.rows < 1 || q.rows > 256 ||
        q.speed < 1 || q.tempo < 32)
      throw std::runtime_error("invalid FTM song timing");
    for (int a = 0; a < q.frames; a++) {
      std::array<int, 5> o{};
      for (int c = 0; c < 5; c++)
        o[c] = fr.u8();
      q.order.push_back(o);
    }
  }
  Reader pr = get("PATTERNS");
  int blocksz = (int)pr.b.size();
  while (pr.p < (size_t)blocksz) {
    int si = pr.i32(), ci = pr.i32(), pi = pr.i32(), items = pr.i32();
    if (si < 0 || si >= songCount || ci < 0 || ci >= 5 || pi < 0 || pi > 255 ||
        items < 0 || items > 1024)
      throw std::runtime_error("invalid pattern data");
    Pattern &pat = out.songs[si].pat[ci][pi];
    int fxn = fxCols[ci][si] + 1;
    for (int z = 0; z < items; z++) {
      int row = pr.i32();
      Note n;
      n.pitch = pr.u8();
      n.oct = pr.u8();
      n.inst = pr.u8();
      n.vol = pr.u8();
      if (row >= 0 && row < out.songs[si].rows) {
        for (int e = 0; e < fxn; e++) {
          uint8_t code = pr.u8(), param = pr.u8();
          if (code) {
            n.fx = code;
            n.fp = param;
          }
        }
        if (n.pitch || n.inst != 0xff || n.vol != 16 || n.fx)
          pat.rows[row] = n;
      } else
        pr.skip((size_t)fxn * 2);
    }
  }
  return out;
}

struct Voice {
  int type = 0, note = -1, inst = -1, vol = 15, duty = 1, arp = 0, pitch = 0;
  double phase = 0;
  uint32_t noise = 0xace1;
  std::array<int, 5> envPos{};
  std::array<int, 5> envAccum{};
  bool released = false;
};
struct Pcm {
  std::vector<int16_t> v;
  std::vector<std::array<uint8_t, 4>> vu;
  std::vector<double> noiseHz;
  bool looped = false;
};
static int veraVolumeForLinearLevel(int level) {
  level = std::clamp(level, 0, 15);
  if (level == 0)
    return 0;
  const int target = (level * 511 + 7) / 15;
  for (int i = 1; i < 64; i++)
    if (volumeLut[i] >= target)
      return i;
  return 63;
}
static int envValue(const Project &p, Voice &v, int type) {
  if (v.inst < 0 || v.inst >= 64)
    return type == 0 ? 15 : 0;
  const Inst &i = p.inst[v.inst];
  if (!i.enabled[type])
    return type == 0 ? 15 : (type == 4 ? 1 : 0);
  auto it = p.seq.find({i.seq[type], type});
  if (it == p.seq.end() || it->second.v.empty())
    return type == 0 ? 15 : 0;
  const Seq &e = it->second;
  int &at = v.envPos[type];
  if (v.released && e.release >= 0 && at < e.release)
    at = e.release;
  if (at >= (int)e.v.size()) {
    if (e.loop >= 0 && e.loop < (int)e.v.size())
      at = e.loop;
    else
      at = (int)e.v.size() - 1;
  }
  // FamiTracker pitch sequence entries are deltas, not absolute offsets.
  // Accumulated pitch is maintained by stepEnvelopes() each tracker tick.
  return type == 2 ? v.envAccum[type] + e.v[at] : e.v[at];
}
static void stepEnvelopes(const Project &p, Voice &v) {
  if (v.inst < 0 || v.inst >= 64)
    return;
  const Inst &i = p.inst[v.inst];
  for (int t = 0; t < 5; t++) {
    if (!i.enabled[t])
      continue;
    auto it = p.seq.find({i.seq[t], t});
    if (it == p.seq.end() || it->second.v.empty())
      continue;
    const Seq &e = it->second;
    int &at = v.envPos[t];
    if (v.released && e.release >= 0 && at < e.release)
      at = e.release;
    if (t == 2)
      v.envAccum[t] += e.v[at];
    if (at + 1 < (int)e.v.size())
      ++at;
    else if (e.loop >= 0 && e.loop < (int)e.v.size())
      at = e.loop;
  }
}
static int freqWord(double hz) {
  if (hz < 1)
    hz = 1;
  double w = hz * 131072.0 / VERA_CLOCK;
  return (int)std::min(65535.0, std::max(0.0, w));
}
static double veraNoiseHz(int note) {
  // ChannelStateNoise.cs writes ((note.Value + slide + arpeggio) & 0x0f) ^
  // 0x0f to $400e. Preserve that exact period index and convert the APU's
  // timer interval to its real clock rate. VERA has no selectable LFSR tap;
  // this maps the update rate without inventing a timbre curve.
  const int apuIndex = (note & 0x0f) ^ 0x0f;
  const double hz = NES_CPU_CLOCK / NES_NOISE_PERIOD[apuIndex];
  const double veraMaxHz = VERA_CLOCK * 65535.0 / 131072.0;
  return std::min(hz, veraMaxHz);
}
static void put16(std::ofstream &f, uint16_t x) {
  f.put((char)x);
  f.put((char)(x >> 8));
}
static void put32(std::ofstream &f, uint32_t x) {
  put16(f, (uint16_t)x);
  put16(f, (uint16_t)(x >> 16));
}

static Pcm render(const Project &p, int songIdx, int soloChannel = -1) {
  const Song &s = p.songs.at(songIdx);
  Pcm out;
  std::array<Voice, 4> voices{};
  voices[0].type = voices[1].type = 0;
  voices[2].type = 1;
  voices[3].type = 2;
  int frame = 0, row = 0, speed = s.speed, tempo = s.tempo;
  double rowClock = 0;
  bool done = false;
  int pendingJump = -1, pendingSkip = -1;
  int safety = 0;
  uint32_t lfsr = 0x12345;
  std::function<void()> applyRow;
  applyRow = [&]() {
    pendingJump = pendingSkip = -1;
    for (int c = 0; c < 5; c++) {
      int patidx = s.order[frame][c];
      auto pi = s.pat[c].find(patidx);
      if (pi == s.pat[c].end())
        continue;
      auto ri = pi->second.rows.find(row);
      if (ri == pi->second.rows.end())
        continue;
      const Note &n = ri->second;
      Voice &v = voices[c < 4 ? c : 3];
      if (c == 4)
        continue;
      if (n.inst < 64 && n.inst != 0xff && n.inst != v.inst) {
        v.inst = n.inst;
        v.envPos.fill(0);
        v.envAccum.fill(0);
        v.released = false;
      }
      if (n.pitch == 13) {
        v.released = true;
        for (int t = 0; t < 5; t++)
          if (v.inst >= 0) {
            const Inst &in = p.inst[v.inst];
            auto it = p.seq.find({in.seq[t], t});
            if (in.enabled[t] && it != p.seq.end() && it->second.release >= 0)
              v.envPos[t] = it->second.release;
          }
      } else if (n.pitch == 14) {
        v.note = -1;
      } else if (n.pitch > 0 && n.pitch <= 12) {
        v.note = n.oct * 12 + (n.pitch - 1);
        v.envPos.fill(0);
        v.envAccum.fill(0);
        v.released = false;
        v.phase = 0;
      }
      if (n.vol < 16)
        v.vol = n.vol;
      if (n.fx == 0x0b)
        pendingJump = n.fp;
      else if (n.fx == 0x0d)
        pendingSkip = n.fp;
      else if (n.fx == 0x0c) {
        done = true;
      } else if (n.fx == 0x0f && n.fp > 0) {
        if (n.fp < 32)
          speed = n.fp;
        else
          tempo = n.fp;
      }
    }
  };
  applyRow();
  while (!done && safety++ < FPS * 60 * 8) {
    // Convert each 60 Hz update into one VERA-PSG audio frame.
    std::array<int, 4> fw{}, vol{}, wave{};
    double frameNoiseHz = 0;
    for (int c = 0; c < 4; c++) {
      Voice &v = voices[c];
      int ev = envValue(p, v, 0);
      int a = envValue(p, v, 1);
      int pit = envValue(p, v, 2);
      int duty = envValue(p, v, 4);
      v.arp = a;
      v.pitch = pit;
      if (c < 2 && v.inst >= 0 && p.inst[v.inst].enabled[4])
        v.duty = std::clamp(duty, 0, 3);
      if (v.note < 0 || ev <= 0) {
        vol[c] = 0;
        continue;
      }
      int ni = v.note + a;
      // A FamiTracker pitch sequence is a signed APU timer-period offset,
      // not a semitone offset. Apply it after converting the note to Hz.
      if (ni < 0)
        ni = 0;
      if (ni > 95)
        ni = 95;
      // The FTM note index 0 maps to note-table entry 1. The pulse table's
      // entry 1 is C0 at 32.7032 Hz; the triangle uses the same timer period
      // with twice the divider, so its corresponding pitch is C-1 at 16.3516
      // Hz. Using the pulse base for triangle made that voice an octave high.
      const double baseHz = c == 2 ? 16.351597831287415 : 32.70319566257483;
      double hz = baseHz * pow(2.0, ni / 12.0);
      if (c < 3 && pit != 0) {
        // Relative pitch sequence entries accumulate into an APU timer-period
        // offset (see envAccum above), then modify the base note's period.
        const double divider = c == 2 ? 32.0 : 16.0;
        double period = 1789773.0 / (divider * hz) - 1.0;
        period = std::clamp(period + pit, 0.0, 2047.0);
        hz = 1789773.0 / (divider * (period + 1.0));
      }
      if (c == 3)
        hz = veraNoiseHz(ni);
      fw[c] = freqWord(hz);
      const int nesLevel = std::clamp((ev * v.vol + 7) / 15, 0, 15);
      // VERA's volume table is logarithmic. Convert the NES 0..15 linear
      // envelope to the closest VERA level instead of multiplying by four;
      // that old mapping made low-volume noise hits almost inaudible.
      vol[c] = c == 2 ? 55 : veraVolumeForLinearLevel(nesLevel);
      if (c == 3 && vol[c] > 0)
        frameNoiseHz = hz;
      wave[c] = c < 2 ? 0x20
                      : (c == 2 ? 0x80 : 0xc0);
    }
    std::array<double, 4> channelPower{};
    for (int sm = 0; sm < SAMPLES_PER_FRAME; sm++) {
      lfsr = (lfsr << 1) |
             (((lfsr >> 1) ^ (lfsr >> 2) ^ (lfsr >> 4) ^ (lfsr >> 15)) & 1);
      lfsr &= 0xffff;
      double mixL = 0, mixR = 0;
      for (int c = 0; c < 4; c++) {
        if (!vol[c] || (soloChannel >= 0 && c != soloChannel))
          continue;
        Voice &v = voices[c];
        uint32_t old = (uint32_t)v.phase;
        v.phase = fmod(v.phase + fw[c] * (VERA_CLOCK / (double)RATE), 131072.0);
        uint32_t ph = (uint32_t)v.phase;
        if ((old & 65536) && !(ph & 65536))
          v.noise = (lfsr >> 1) & 63;
        int x = 0, wt = wave[c] >> 6, pw = wave[c] & 63;
        if (wt == 0)
          x = ((int)(ph >> 10) > pw) ? 0 : 63;
        else if (wt == 2)
          x = ((ph & 65536) ? (~(ph >> 10) & 63) : ((ph >> 10) & 63)) ^
              ((pw ^ 63) & 63);
        else
          x = (int)v.noise;
        int sv = x ^ 32;
        if (sv & 32)
          sv |= ~63;
        double val = sv * volumeLut[vol[c]] / 262144.0;
        mixL += val;
        mixR += val;
        channelPower[c] += val * val;
      }
      int32_t L = (int32_t)(tanh(mixL * 2) * 30000),
              R = (int32_t)(tanh(mixR * 2) * 30000);
      out.v.push_back((int16_t)std::clamp(L, -32767, 32767));
      out.v.push_back((int16_t)std::clamp(R, -32767, 32767));
    }
    std::array<uint8_t, 4> frameVu{};
    for (int c = 0; c < 4; c++)
      frameVu[c] = (uint8_t)std::clamp(
          (int)(sqrt(channelPower[c] / SAMPLES_PER_FRAME) * 220.0), 0, 10);
    out.vu.push_back(frameVu);
    out.noiseHz.push_back(frameNoiseHz);
    for (int c = 0; c < 4; c++)
      if (voices[c].note >= 0)
        stepEnvelopes(p, voices[c]);
    rowClock += tempo;
    if (rowClock >= speed * 150.0) {
      rowClock -= speed * 150.0;
      if (pendingJump >= 0) {
        int target = pendingJump;
        pendingJump = -1;
        if (target >= s.frames) {
          done = true;
          break;
        }
        if (target <= frame) {
          out.looped = true;
          done = true;
          break;
        }
        frame = target;
        row = 0;
      } else if (pendingSkip >= 0) {
        row = pendingSkip;
        pendingSkip = -1;
        if (++frame >= s.frames) {
          done = true;
          break;
        }
      } else if (++row >= s.rows) {
        row = 0;
        if (++frame >= s.frames) {
          done = true;
          break;
        }
      }
      applyRow();
    }
  }
  if (safety >= FPS * 60 * 8)
    throw std::runtime_error(
        "song exceeded 8 minute safety limit (looping pattern?)");
  return out;
}

static void writeWav(const char *path, const Pcm &p, int masterVol) {
  std::ofstream f(path, std::ios::binary);
  if (!f)
    throw std::runtime_error("cannot create WAV output");
  uint32_t bytes = (uint32_t)(p.v.size() * 2);
  f.write("RIFF", 4);
  put32(f, 36 + bytes);
  f.write("WAVEfmt ", 8);
  put32(f, 16);
  put16(f, 1);
  put16(f, 2);
  put32(f, RATE);
  put32(f, RATE * 4);
  put16(f, 4);
  put16(f, 16);
  f.write("data", 4);
  put32(f, bytes);
  const double gain = std::clamp(masterVol, 0, 15) / 15.0;
  if (masterVol == 15) {
    f.write((char *)p.v.data(), bytes);
  } else {
    for (int16_t sample : p.v)
      put16(f, (uint16_t)(int16_t)std::clamp((int)(sample * gain), -32767, 32767));
  }
}
static bool play(const Pcm &p, int masterVol) {
  HWAVEOUT h = nullptr;
  WAVEFORMATEX w{};
  w.wFormatTag = WAVE_FORMAT_PCM;
  w.nChannels = 2;
  w.nSamplesPerSec = RATE;
  w.wBitsPerSample = 16;
  w.nBlockAlign = 4;
  w.nAvgBytesPerSec = RATE * 4;
  MMRESULT e = waveOutOpen(&h, WAVE_MAPPER, &w, 0, 0, CALLBACK_NULL);
  if (e != MMSYSERR_NOERROR)
    throw std::runtime_error("cannot open Windows audio output");
  struct Buffer {
    WAVEHDR header{};
    std::vector<int16_t> samples;
    size_t firstFrame = 0;
    size_t frames = 0;
    bool queued = false;
  };
  const size_t totalFrames = p.v.size() / 2;
  const size_t framesPerBuffer = RATE / 20; // 50 ms, responsive volume keys
  std::array<Buffer, 4> buffers;
  for (auto &b : buffers) {
    b.samples.resize(framesPerBuffer * 2);
    b.header.lpData = (LPSTR)b.samples.data();
    b.header.dwBufferLength = (DWORD)(b.samples.size() * sizeof(int16_t));
    waveOutPrepareHeader(h, &b.header, sizeof(WAVEHDR));
  }
  size_t nextFrame = 0;
  int queuedCount = 0;
  bool running = true, paused = false, muted = false, nextSong = false;
  auto queueBuffer = [&](Buffer &b) -> bool {
    if (!totalFrames || (!p.looped && nextFrame >= totalFrames))
      return false;
    b.firstFrame = nextFrame;
    b.frames = std::min(framesPerBuffer, totalFrames - nextFrame);
    if (p.looped)
      b.frames = framesPerBuffer;
    const double gain = muted ? 0.0 : masterVol / 15.0;
    for (size_t i = 0; i < b.frames; i++) {
      const size_t srcFrame = (nextFrame + i) % totalFrames;
      b.samples[i * 2] = (int16_t)std::clamp(
          (int)(p.v[srcFrame * 2] * gain), -32767, 32767);
      b.samples[i * 2 + 1] = (int16_t)std::clamp(
          (int)(p.v[srcFrame * 2 + 1] * gain), -32767, 32767);
    }
    b.header.dwBufferLength = (DWORD)(b.frames * 2 * sizeof(int16_t));
    b.header.dwFlags &= ~(WHDR_DONE | WHDR_INQUEUE | WHDR_BEGINLOOP | WHDR_ENDLOOP);
    if (waveOutWrite(h, &b.header, sizeof(WAVEHDR)) != MMSYSERR_NOERROR)
      return false;
    b.queued = true;
    queuedCount++;
    nextFrame += b.frames;
    if (p.looped)
      nextFrame %= totalFrames;
    return true;
  };
  for (auto &b : buffers)
    if (!queueBuffer(b))
      break;

  HANDLE console = GetStdHandle(STD_OUTPUT_HANDLE);
  CONSOLE_SCREEN_BUFFER_INFO csbi{};
  CONSOLE_CURSOR_INFO oldCursor{}, hiddenCursor{};
  bool showUi = GetConsoleScreenBufferInfo(console, &csbi) != 0;
  bool restoreCursor = showUi && GetConsoleCursorInfo(console, &oldCursor);
  if (restoreCursor) {
    hiddenCursor = oldCursor;
    hiddenCursor.bVisible = FALSE;
    SetConsoleCursorInfo(console, &hiddenCursor);
  }
  printf("FTM VERA PSG Player | %02d:%02d | P pause  SPACE next  M mute  +/- vol  Q quit\n",
         (int)(totalFrames / RATE / 60), (int)(totalFrames / RATE % 60));
  DWORD lastUi = 0;
  while (running && queuedCount > 0) {
    if (_kbhit()) {
      int key = _getch();
      if (key == 27 || key == 'q' || key == 'Q') {
        running = false;
      } else if (key == ' ') {
        nextSong = true;
        running = false;
      } else if (key == 'p' || key == 'P') {
        paused = !paused;
        if (paused) waveOutPause(h); else waveOutRestart(h);
      } else if (key == 'm' || key == 'M') {
        muted = !muted;
      } else if (key == '+' || key == '=') {
        masterVol = std::min(15, masterVol + 1);
      } else if (key == '-' || key == '_') {
        masterVol = std::max(0, masterVol - 1);
      }
    }
    for (auto &b : buffers) {
      if (b.queued && (b.header.dwFlags & WHDR_DONE)) {
        b.queued = false;
        queuedCount--;
        if (queueBuffer(b)) {
          // queueBuffer increments queuedCount.
        }
      }
    }
    MMTIME pos{};
    pos.wType = TIME_SAMPLES;
    waveOutGetPosition(h, &pos, sizeof(pos));
    size_t currentFrame = pos.wType == TIME_SAMPLES ? pos.u.sample : 0;
    if (p.looped && totalFrames)
      currentFrame %= totalFrames;
    else
      currentFrame = std::min(currentFrame, totalFrames);
    DWORD now = GetTickCount();
    if (showUi && now - lastUi >= 100) {
      const int curSec = (int)(currentFrame / RATE);
      const int totSec = (int)(totalFrames / RATE);
      char progress[21];
      int filled = totalFrames ? (int)(currentFrame * 20 / totalFrames) : 0;
      for (int i = 0; i < 20; i++) progress[i] = i < filled ? '=' : (i == filled ? '>' : ' ');
      progress[20] = 0;
      std::array<uint8_t, 4> meter{};
      size_t vuIndex = std::min(currentFrame / SAMPLES_PER_FRAME,
                                p.vu.empty() ? size_t(0) : p.vu.size() - 1);
      if (!p.vu.empty()) meter = p.vu[vuIndex];
      for (auto &level : meter)
        level = muted ? 0 : (uint8_t)((level * masterVol + 7) / 15);
      auto bar = [](uint8_t v) { char s[11]; memset(s, '#', v); memset(s + v, '.', 10 - v); s[10] = 0; return std::string(s); };
      printf("\r%02d:%02d/%02d:%02d [%s] S1[%s] S2[%s] TR[%s] NO[%s] V:%02d %s   ",
             curSec / 60, curSec % 60, totSec / 60, totSec % 60, progress,
             bar(meter[0]).c_str(), bar(meter[1]).c_str(), bar(meter[2]).c_str(),
             bar(meter[3]).c_str(), masterVol, paused ? "PAUSE" : (muted ? "MUTE" : "PLAY"));
      fflush(stdout);
      lastUi = now;
    }
    Sleep(5);
  }
  waveOutReset(h);
  if (restoreCursor)
    SetConsoleCursorInfo(console, &oldCursor);
  if (showUi) printf("\n");
  for (auto &b : buffers)
    waveOutUnprepareHeader(h, &b.header, sizeof(WAVEHDR));
  waveOutClose(h);
  return nextSong;
}
static void writeNoiseFreqs(const char *path, const Pcm &p) {
  std::ofstream f(path);
  if (!f)
    throw std::runtime_error("cannot create noise frequency output");
  for (double hz : p.noiseHz)
    f << (hz > 0 ? (int)std::lround(hz) : 0) << '\n';
}
int main(int argc, char **argv) {
  try {
    if (argc < 2 || !strcmp(argv[1], "--help")) {
      puts("Standalone FTM VERA PSG player\nUsage: ftmplay.exe song.ftm "
           "[song-index] [--vol 0..15] [--solo 0..3] [--wav out.wav] [--noise-freqs out.txt]\n       ftmplay.exe "
           "song.ftm --list\nLive controls: P pause, Space next song, M mute, +/- volume, Q/Esc quit. "
           "Shows elapsed/total time and per-channel VU meters.\nReads FTM "
           "0.4.2-0.4.6 (2A03 only); no FamiStudio, Node.js or FamiTone required. "
           "DPCM is omitted.");
      return argc < 2 ? 2 : 0;
    }
    Project p = loadFtm(argv[1]);
    if (argc >= 3 && !strcmp(argv[2], "--list")) {
      for (size_t i = 0; i < p.songs.size(); i++)
        printf("%2u  %s\n", (unsigned)i, p.songs[i].name.c_str());
      return 0;
    }
    int si = argc >= 3 && argv[2][0] != '-' ? atoi(argv[2]) : 0, vol = 12;
    const char *wav = nullptr;
    const char *noiseFreqs = nullptr;
    int solo = -1;
    for (int i = 2; i < argc; i++) {
      if (!strcmp(argv[i], "--vol") && i + 1 < argc)
        vol = std::clamp(atoi(argv[++i]), 0, 15);
      else if (!strcmp(argv[i], "--solo") && i + 1 < argc)
        solo = std::clamp(atoi(argv[++i]), 0, 3);
      else if (!strcmp(argv[i], "--wav") && i + 1 < argc)
        wav = argv[++i];
      else if (!strcmp(argv[i], "--noise-freqs") && i + 1 < argc)
        noiseFreqs = argv[++i];
    }
    if (si < 0 || si >= (int)p.songs.size())
      throw std::runtime_error(
          "song index out of range; use --list to see songs");
    do {
      printf("FTM song %d: %s\n", si, p.songs[si].name.c_str());
      Pcm pcm = render(p, si, solo);
      if (noiseFreqs) {
        writeNoiseFreqs(noiseFreqs, pcm);
        printf("Wrote %s (%zu 60 Hz frames)\n", noiseFreqs, pcm.noiseHz.size());
      }
      if (wav) {
        writeWav(wav, pcm, vol);
        printf("Wrote %s (%zu frames, %.1f sec)\n", wav, pcm.v.size() / 2,
               pcm.v.size() / (double)(RATE * 2));
      } else if (!noiseFreqs && play(pcm, vol)) {
        si = (si + 1) % (int)p.songs.size();
        continue;
      }
      break;
    } while (true);
    return 0;
  } catch (const std::exception &e) {
    fprintf(stderr, "ftmplay: %s\n", e.what());
    return 1;
  }
}
