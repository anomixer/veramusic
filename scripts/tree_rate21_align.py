#!/usr/bin/env python3
# One-off (2026-10-22): compare the AppleWin TREE rate-21 run WAV against the
# melodius.exe reference render of the same rate-21 stream, using the M39/M40
# metric (AGENTS.md): 20 ms RMS-envelope frames over 2 s segments, aligned as
# emu[k] <-> truth[k - lag] (the dump is BEHIND the reference; the opposite sign
# invents dropouts that are only misalignment).
#
# Rates differ (AppleWin 44.1 kHz dump vs melodius 48 kHz reference) but the
# 20 ms envelope frame grid is identical, so no decimation is needed.
#
# A clean stream tracks emu = truth + const with per-segment corr > 0.95 and
# ~0 dropout frames (a dropout = truth loud (>0.05) but emu < 0.35x truth).
# Boundary frames of a loud-section onset can report a low ratio once while the
# neighbours are ~1.0; report them separately so the metric stays meaningful.
import wave, sys, math, statistics

FRAME_MS = 20          # envelope frame size
SEG_FRAMES = 100       # 2 s of 20 ms frames per segment
QUIET = 0.05           # ignore frames where the truth is below this abs level
DROP = 0.35            # dropout when emu/truth below this while truth loud


def env_frames(path):
    w = wave.open(path, "rb")
    n, ch, sw, sr = w.getnframes(), w.getnchannels(), w.getsampwidth(), w.getframerate()
    raw = w.readframes(n); w.close()
    assert ch == 2 and sw == 2
    per = FRAME_MS * sr // 1000
    env = []
    for i in range(0, len(raw), per * 4):
        chunk = raw[i:i + per * 4]
        acc = 0
        for j in range(0, len(chunk), 4):
            l = int.from_bytes(chunk[j:j+2], "little", signed=True)
            r = int.from_bytes(chunk[j+2:j+4], "little", signed=True)
            acc += l * l + r * r
        env.append(math.sqrt(acc / (len(chunk) // 4)))
    return env, sr


def seg_corr(e, t, lag, seg):
    # per-segment corr of emu[k] <-> truth[k-lag]; returns list (may be empty)
    n = min(len(e), len(t) - lag)
    out = []
    for s in range(0, n // seg):
        ea = e[s * seg:(s + 1) * seg]
        tb = t[s * seg - lag:(s + 1) * seg - lag]
        ma = sum(ea) / seg
        mb = sum(tb) / seg
        num = sum((x - ma) * (y - mb) for x, y in zip(ea, tb))
        va = math.sqrt(sum((x - ma) ** 2 for x in ea))
        vb = math.sqrt(sum((y - mb) ** 2 for y in tb))
        out.append(num / (va * vb) if va > 1e-6 and vb > 1e-6 else 0.0)
    return out


def find_lag(e, t, seg):
    # per-segment best lag with the correct sign; returns (lag, mean corr)
    n = min(len(e), len(t))
    votes = {}
    for s in range(1, n // seg):
        ea = e[s * seg:(s + 1) * seg]
        best = (-1.0, -1)
        for lag in range(0, min(400, s * seg)):
            tb = t[s * seg - lag:s * seg - lag + seg]
            ma = sum(ea) / seg
            mb = sum(tb) / seg
            num = sum((x - ma) * (y - mb) for x, y in zip(ea, tb))
            va = math.sqrt(sum((x - ma) ** 2 for x in ea))
            vb = math.sqrt(sum((y - mb) ** 2 for y in tb))
            c = num / (va * vb) if va > 1e-6 and vb > 1e-6 else 0.0
            if c > best[0]:
                best = (c, lag)
        if best[0] > 0.8:
            votes[best[1]] = votes.get(best[1], 0) + best[0]
    if not votes:
        return -1, 0.0
    lag = max(votes, key=lambda k: votes[k])
    return lag, sum(votes.values()) / len(votes)


def main(emu_path, truth_path):
    e, sr1 = env_frames(emu_path)
    t, sr2 = env_frames(truth_path)
    lag, vote = find_lag(e, t, SEG_FRAMES)
    if lag < 0:
        print("no stable alignment found")
        return 1
    print(f"aligned emu[k] <-> truth[k-{lag}] ({lag*FRAME_MS/1000:.2f}s lag; vote {vote:.3f})")
    n = min(len(e), len(t) - lag)
    segs = seg_corr(e, t, lag, SEG_FRAMES)
    segs = [c for c in segs if c > 0.01]  # drop pre-onset segments (truth quiet)
    loud = drop = boundary = 0
    for k in range(lag, n):
        tt = t[k - lag]
        if tt < QUIET:
            continue
        loud += 1
        r = e[k] / tt if tt > 0 else 0.0
        if r < DROP:
            drop += 1
            # boundary frame: next frame loud ratio back to ~1
            if k + 1 < n and t[k + 1 - lag] >= QUIET and e[k + 1] >= t[k + 1 - lag] * 0.8:
                boundary += 1
    vals = [e[k] / t[k - lag] for k in range(lag, n) if t[k - lag] >= QUIET]
    med = statistics.median(vals) if vals else float("nan")
    mean = statistics.mean(vals) if vals else float("nan")
    lo = min(segs); hi = max(segs); mu = sum(segs) / len(segs) if segs else 0.0
    print(f"segments {len(segs)}: min {lo:.3f} mean {mu:.3f} max {hi:.3f}")
    print(f"loud-window frames {loud}, dropouts {drop} ({100*drop/max(1,loud):.1f}%), boundary artifacts {boundary}")
    print(f"loudness ratio median {med:.3f} mean {mean:.3f}")
    ok = mu > 0.95 and (drop - boundary) == 0
    print("PASS" if ok else "FAIL")
    return 0 if ok else 1


sys.exit(main(sys.argv[1], sys.argv[2]))