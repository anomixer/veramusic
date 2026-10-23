#!/usr/bin/env python3
# One-off (2026-10-22): compare tree_rate21_truth.wav against tree_orig.wav.
# The rate-21 patch should keep the same duration, same peak, and near-equal
# RMS (the M40 rate-42 patch measured 99% RMS). RMS here = mean abs of the
# 16-bit stereo mix, matching the melodius.cpp output scale.
import wave, sys, math

def stats(path):
    w = wave.open(path, "rb")
    n = w.getnframes(); ch = w.getnchannels(); sw = w.getsampwidth(); sr = w.getframerate()
    raw = w.readframes(n); w.close()
    assert ch == 2 and sw == 2
    total = peak = 0
    frames = 0
    for i in range(0, len(raw), 4):
        l = int.from_bytes(raw[i:i+2], "little", signed=True)
        r = int.from_bytes(raw[i+2:i+4], "little", signed=True)
        total += abs(l) + abs(r)
        peak = max(peak, abs(l), abs(r))
        frames += 1
    dur = frames / sr
    mean = total / (frames * 2)
    return dur, peak, mean

d1, p1, m1 = stats(sys.argv[1])
d2, p2, m2 = stats(sys.argv[2])
r = m2 / m1 if m1 else float("nan")
print(f"orig   : {d1:.2f}s peak {p1:6d} meanabs {m1:8.1f}")
print(f"rate21 : {d2:.2f}s peak {p2:6d} meanabs {m2:8.1f}")
print(f"dur delta {abs(d2-d1):.4f}s   peak ratio {p2/p1:.4f}   rms ratio {r:.4f} ({r*100:.1f}%)")
if abs(d2 - d1) > 0.05:
    print("FAIL duration"); sys.exit(1)
if abs(p2 - p1) > 3:
    print("FAIL peak"); sys.exit(1)
if abs(r - 1) > 0.03:
    print("FAIL rms"); sys.exit(1)
print("PASS")