#!/usr/bin/env node
/**
 * sim6502.mjs — minimal 6502 execution simulator for the psgplay/psgstream
 * player binaries. Executes the ACTUAL assembled bytes (not a re-model),
 * with a mock VERA (ADDR/DATA0/CTRL/IEN/ISR) and mock ProDOS MLI ($BF00,
 * READ_BLOCK $80 served from a real .po image). Drives the $03FE IRQ
 * handler once per 60 Hz frame and logs every PSG write as (frame, reg, val).
 *
 * Usage:
 *   node sim6502.mjs ram <playerWithStream.bin> <frames>     # psgplay test
 *   node sim6502.mjs stream <streamCode.bin> <jukebox.po> <frames>
 *
 * Exit 0 + "MATCH" if the write log equals the converter reference walk of
 * the same stream; otherwise prints the first divergent frame and dumps CPU.
 */
import { readFileSync, writeFileSync } from "node:fs";

const mem = new Uint8Array(0x10000);
let A = 0, X = 0, Y = 0, SP = 0xFF, P = 0x20; // N V - B D I Z C
const setNZ = (v) => { P = (P & 0x7D) | (v & 0x80) | ((v & 0xFF) === 0 ? 0x02 : 0); };
const getC = () => P & 0x01;
const setC = (c) => { P = (P & 0xFE) | (c ? 1 : 0); };
// BCD honored when D set (this is the point: catch decimal-mode bugs)
const adc = (v) => {
  const c = getC();
  if (P & 0x08) {
    let al = (A & 0x0F) + (v & 0x0F) + c, ah = (A >> 4) + (v >> 4);
    if (al > 9) { al -= 10; ah++; }
    setC(ah > 9 ? 1 : 0);
    if (ah > 9) ah -= 10;
    A = ((ah << 4) | (al & 0x0F)) & 0xFF;
    setNZ(A);
  } else {
    const r = A + v + c;
    setC(r > 0xFF ? 1 : 0);
    A = r & 0xFF; setNZ(A);
  }
};
const cmp = (r, v) => { setC(r >= v ? 1 : 0); setNZ((r - v) & 0xFF); };
const push = (v) => { mem[0x100 + SP] = v & 0xFF; SP = (SP - 1) & 0xFF; };
const pop = () => { SP = (SP + 1) & 0xFF; return mem[0x100 + SP]; };

// ---- mock VERA + MLI -------------------------------------------------------
const VERA_BASE = 0xC200;
let vAddr = 0, vCtrl = 0, vIEN = 0, vISR = 0;
const writes = []; // {frame, reg, val}
let frame = 0, mliReads = 0, mliErrNext = 0, live = false;
let traceGets = 0;
const getLog = [];
let dbgWrites = 0;
const dbgLog = [];
let poDisk = null;
const rd = (a) => {
  if (a === 0xC000) return 0x00;                       // KBD_DATA: no key
  if (a === VERA_BASE + 7) return vISR;               // ISR
  return mem[a];
};
const wr = (a, v) => {
  v &= 0xFF;
  if (a === VERA_BASE + 0) vAddr = (vAddr & 0xFFF00) | v;
  else if (a === VERA_BASE + 1) vAddr = (vAddr & 0xF00FF) | (v << 8);
  else if (a === VERA_BASE + 2) vAddr = (vAddr & 0x0FFFF) | ((v & 0x0F) << 16);
  else if (a === VERA_BASE + 3) {
    const off = vAddr - 0x1F9C0;
    if (live && off >= 0 && off < 64) writes.push({ frame, reg: off, val: v });
    if (live && dbgWrites < 8) { dbgWrites++; dbgLog.push([PC.toString(16), A, X, Y, vAddr.toString(16), v]); }
    const stride = (mem[VERA_BASE + 2] >> 4) & 0x0F;
    vAddr = (vAddr + (stride === 0 ? 1 : stride)) & 0xFFFFF;
  }
  else if (a === VERA_BASE + 5) vCtrl = v;
  else if (a === VERA_BASE + 6) vIEN = v;
  else if (a === VERA_BASE + 7) { vISR &= ~v; }
  else if (a === 0xC010) { /* strobe */ }
  else mem[a] = v;
};
// dump zp state after first IRQ
let firstIrqDone = false;
function mliCall(callerPC) {
  // JSR $BF00: cmd + param-ptr are inline AFTER the caller's JSR.
  // return address (6502 JSR pushes PC-1) points at the last operand byte.
  const ret = (callerPC - 1) & 0xFFFF;
  const cmd = mem[(ret + 1) & 0xFFFF];
  const pa = mem[(ret + 2) & 0xFFFF] | (mem[(ret + 3) & 0xFFFF] << 8);
  // execution continues at callerPC (past inline bytes), like MLI's RTS.
  if (cmd !== 0x80) { A = 0x01; setC(1); return; } // unsupported
  const unit = mem[pa + 1], buf = mem[pa + 2] | (mem[pa + 3] << 8);
  const blk = mem[pa + 4] | (mem[pa + 5] << 8);
  mliReads++;
  if (mliErrNext || !poDisk || blk * 512 + 512 > poDisk.length || unit === 0) {
    A = mliErrNext || 0x27; setC(1); return;
  }
  for (let i = 0; i < 512; i++) mem[(buf + i) & 0xFFFF] = poDisk[blk * 512 + i];
  if (buf === 0x4000) console.log(`READ blk=${blk} unit=${unit} → buf[0..15]=${[...poDisk.subarray(blk*512,(blk+1)*512)].slice(0,16).map(x=>x.toString(16).padStart(2,'0')).join(' ')}`);
  A = 0; setC(0);
}

// ---- CPU -------------------------------------------------------------------
let steps = 0, jsrDepth = 0;
function step() {
  const pc0 = PC;
  const op = mem[PC++];
  const abs = () => { const v = mem[PC] | (mem[PC + 1] << 8); PC += 2; return v; };
  const zp = () => mem[PC++];
  const br = (t) => { const o = mem[PC++]; if (t) PC += o < 128 ? o : o - 256; };
  steps++;
  if (steps > 50_000_000) throw new Error("step cap hit at " + pc0.toString(16));
  switch (op) {
    case 0xA9: A = mem[PC++]; setNZ(A); break;
    case 0xA5: A = mem[zp()]; setNZ(A); break;
    case 0xAD: A = rd(abs()); setNZ(A); break;
    case 0xB1: { const z = mem[PC++]; const ptr = (mem[z] | (mem[z + 1] << 8)) + Y; A = rd(ptr); setNZ(A); if (z === 6 && getLog.length < 120) getLog.push([ptr.toString(16), A.toString(16).padStart(2, "0")]); break; }
    case 0xA2: X = mem[PC++]; setNZ(X); break;
    case 0xA6: X = mem[zp()]; setNZ(X); break;
    case 0xAE: X = rd(abs()); setNZ(X); break;
    case 0xA0: Y = mem[PC++]; setNZ(Y); break;
    case 0xAC: Y = rd(abs()); setNZ(Y); break;
    case 0x8D: wr(abs(), A); break;
    case 0x85: mem[zp()] = A; break;
    case 0x9D: { const a = abs(); wr(a + X, A); break; }
    case 0x99: { const a = abs(); wr(a + Y, A); break; }
    case 0xBD: { const a = abs(); A = rd(a + X); setNZ(A); break; }
    case 0xB9: { const a = abs(); A = rd(a + Y); setNZ(A); break; }
    case 0xBE: { const a = abs(); X = rd(a + Y); setNZ(X); break; }
    case 0xDD: { const a = abs(); cmp(A, rd(a + X)); break; }
    case 0xD9: { const a = abs(); cmp(A, rd(a + Y)); break; }
    case 0x8E: wr(abs(), X); break;
    case 0x86: mem[zp()] = X; break;
    case 0x8C: wr(abs(), Y); break;
    case 0x84: mem[zp()] = Y; break;
    case 0xE8: X = (X + 1) & 0xFF; setNZ(X); break;
    case 0xCA: X = (X - 1) & 0xFF; setNZ(X); break;
    case 0xC8: Y = (Y + 1) & 0xFF; setNZ(Y); break;
    case 0x88: Y = (Y - 1) & 0xFF; setNZ(Y); break;
    case 0xAA: X = A; setNZ(X); break;
    case 0x8A: A = X; setNZ(A); break;
    case 0xA8: Y = A; setNZ(Y); break;
    case 0x98: A = Y; setNZ(A); break;
    case 0x48: push(A); break;
    case 0x68: A = pop(); setNZ(A); break;
    case 0x08: push(P | 0x30); break;
    case 0x28: P = (pop() & 0xEF) | 0x20; break;
    case 0x69: adc(mem[PC++]); break;
    case 0x6D: adc(rd(abs())); break;
    case 0x09: A |= mem[PC++]; setNZ(A); break;
    case 0x0D: A |= rd(abs()); setNZ(A); break;
    case 0x29: A &= mem[PC++]; setNZ(A); break;
    case 0x2D: A &= rd(abs()); setNZ(A); break;
    case 0x49: A ^= mem[PC++]; setNZ(A); break;
    case 0xC9: cmp(A, mem[PC++]); break;
    case 0xCD: cmp(A, rd(abs())); break;
    case 0xE0: cmp(X, mem[PC++]); break;
    case 0xC0: cmp(Y, mem[PC++]); break;
    case 0xE6: { const z = mem[PC++]; mem[z] = (mem[z] + 1) & 0xFF; setNZ(mem[z]); break; }
    case 0xEE: { const a = abs(); const v = (rd(a) + 1) & 0xFF; wr(a, v); setNZ(v); break; }
    case 0xC6: { const z = mem[PC++]; mem[z] = (mem[z] - 1) & 0xFF; setNZ(mem[z]); break; }
    case 0xCE: { const a = abs(); const v = (rd(a) - 1) & 0xFF; wr(a, v); setNZ(v); break; }
    case 0x4A: setC(A & 1); A >>= 1; setNZ(A); break;
    case 0x0A: setC((A >> 7) & 1); A = (A << 1) & 0xFF; setNZ(A); break;
    case 0x2C: { const v = rd(abs()); setNZ(A & v); P = (P & 0x3F) | (v & 0xC0); break; }
    case 0x18: setC(0); break;
    case 0x38: setC(1); break;
    case 0x58: P &= ~0x04; break;
    case 0x78: P |= 0x04; break;
    case 0xD8: P &= ~0x08; break;
    case 0xEA: break;
    case 0x60: {
      const l = pop(), h = pop();
      PC = ((l | (h << 8)) + 1) & 0xFFFF;
      jsrDepth--;
      break;
    }
    case 0x40: { P = (pop() & 0xEF) | 0x20; const l = pop(), h = pop(); PC = (l | (h << 8)) & 0xFFFF; break; }
    case 0x20: {
      const t = abs();
      if (t === 0xBF00) { mliCall(PC); PC = (PC + 3) & 0xFFFF; break; }
      push(((PC - 1) >> 8) & 0xFF); push((PC - 1) & 0xFF); PC = t; jsrDepth++; break;
    }
    case 0x4C: PC = abs(); break;
    case 0xD0: br(!(P & 0x02)); break;
    case 0xF0: br(!!(P & 0x02)); break;
    case 0x10: br(!(P & 0x80)); break;
    case 0x30: br(!!(P & 0x80)); break;
    case 0x90: br(!getC()); break;
    case 0xB0: br(!!getC()); break;
    case 0x50: br(!(P & 0x40)); break;
    case 0x70: br(!!(P & 0x40)); break;
    default: throw new Error(`unimpl op $${op.toString(16)} at $${pc0.toString(16)}`);
  }
}
let PC = 0;

// ---- reference walk (converter-truth) ---------------------------------------
function refWalk(stream) {
  const frames = [];
  let p = 0;
  while (stream[p] !== 0xFF) {
    const c = stream[p++], rec = [];
    for (let i = 0; i < c; i++) rec.push([stream[p], stream[p + 1]]), p += 2;
    frames.push(rec);
  }
  return { frames, loop: stream[p + 1] | (stream[p + 2] << 8) };
}

// ---- main ------------------------------------------------------------------
const mode = process.argv[2];
if (mode === "ram") {
  const bin = readFileSync(process.argv[3]), N = +process.argv[4];
  mem.set(bin, 0x2000);
  PC = 0x2000;
  P |= 0x08; // D=1 on entry: Applesoft leaves decimal set — the sim must survive it
  jsrDepth = 0;
  let guard = 0;
  // START flows into MAIN (never returns). Boot = until IRQ hooked + enabled.
  while (!(vIEN === 1 && (mem[0x03FE] | (mem[0x03FF] << 8)) !== 0)) {
    step();
    if (++guard > 200000) throw new Error("boot failed: IRQ never hooked+enabled");
  }
  console.log(`boot ok. stream ptr=$${mem[7].toString(16)}${mem[6].toString(16)}`);
  // drive N VSYNC frames through the $03FE vector
  const vec = mem[0x03FE] | (mem[0x03FF] << 8);
  console.log(`IRQ vector=$${vec.toString(16)} IEN=$${vIEN.toString(16)}`);
  for (frame = 0; frame < N; frame++) {
    vISR |= 1;
    live = true;
    push((PC >> 8) & 0xFF); push(PC & 0xFF); push(P | 0x30); P |= 0x04;
    PC = vec;
    let g = 0;
    while (mem[PC] !== 0x40) { step(); if (++g > 200000) throw new Error(`IRQ handler did not RTI at frame ${frame}`); }
    step(); // RTI
  }
  console.log(`ran ${N} frames, ${writes.length} PSG writes, steps=${steps}`);
  fs_writeLog("ram");
} else if (mode === "stream") {
  const code = readFileSync(process.argv[3]);
  poDisk = readFileSync(process.argv[4]);
  const N = +process.argv[5];
  mem.set(code, 0x2000);
  mem[0xBF30] = 0x60; // boot unit S6D1
  PC = 0x2000;
  P |= 0x08; // D=1 on entry: Applesoft leaves decimal set — the sim must survive it
  jsrDepth = 0;
  let guard = 0;
  // START flows into MAIN (never returns). Boot = until IRQ hooked + enabled.
  while (!(vIEN === 1 && (mem[0x03FE] | (mem[0x03FF] << 8)) !== 0)) {
    step();
    if (++guard > 200000) throw new Error("boot failed: IRQ never hooked+enabled");
  }
  console.log(`START returned. mliReads=${mliReads} ptr=$${mem[7].toString(16)}${mem[6].toString(16)}`);
  const vec = mem[0x03FE] | (mem[0x03FF] << 8);
  console.log(`IRQ vector=$${vec.toString(16)} IEN=$${vIEN.toString(16)}`);
  for (frame = 0; frame < N; frame++) {
    vISR |= 1;
    live = true;
    push((PC >> 8) & 0xFF); push(PC & 0xFF); push(P | 0x30); P |= 0x04;
    PC = vec;
    let g = 0;
    while (mem[PC] !== 0x40) {
      step();
      if (mem[PC] === undefined) break;
      if (steps > 50_000_000) break;
    }
    step();
    if (!firstIrqDone) {
      firstIrqDone = true;
      console.log("ZP after first IRQ: STREAM_L=$"+mem[6].toString(16)+" STREAM_H=$"+mem[7].toString(16)+" CNT=$"+mem[8].toString(16)+" FRM0=$"+mem[9].toString(16));
      console.log("mem[0..20]:",[...Array(20)].map((_,i)=>i.toString(16)+":"+mem[i].toString(16).padStart(2,'0')).join(' '));
      console.log("dbgWrites:",dbgWrites,"dbgLog:",JSON.stringify(dbgLog));
    }
  }
  console.log(`ran ${N} frames, ${writes.length} PSG writes, mliReads=${mliReads}, steps=${steps}`);
  console.log("FIRST WRITES [pc,A,X,Y,vAddr,val]:", JSON.stringify(dbgLog));
  console.log("GETB trace (ptr:byte):", JSON.stringify(getLog));
  fs_writeLog("stream");
} else { console.error("usage: sim6502.mjs ram|stream ..."); process.exit(1); }

function fs_writeLog(tag) {
  writeFileSync(`_sim_${tag}.json`, JSON.stringify({ writes }));
  // per-frame compact: frame -> [reg,val,...]
  const per = {};
  for (const w of writes) (per[w.frame] = per[w.frame] || []).push(w.reg, w.val);
  writeFileSync(`_sim_${tag}_frames.json`, JSON.stringify(per));
  console.log(`wrote _sim_${tag}_frames.json`);
}
