import { readFileSync } from 'node:fs';
const buf = readFileSync('space_debris.mod');
const sig = buf.toString('ascii', 1080, 1084);
const channels = 4;
const patOff = 1084, patSize = 64 * channels * 4;
const AMIGA_PAL = 3546895;

// Parse samples
const samples = [];
for(let i=0; i<31; i++) {
  const o = 20 + i*30;
  const name = buf.toString('latin1', o, o+22).replace(/\0[\s\S]*$/, '').trim();
  const len = buf.readUInt16BE(o+22)*2;
  const vol = buf.readUInt8(o+25);
  const repStart = buf.readUInt16BE(o+26)*2;
  const repLen = buf.readUInt16BE(o+28)*2;
  samples.push({ id: i+1, name, len, vol, repStart, repLen });
}

const songLen = buf.readUInt8(950);
const orders = [...buf.slice(952, 952+128)].slice(0, songLen);

// Period to note name lookup
const PERIODS = {
  856:'C1', 808:'C#1', 762:'D1', 720:'D#1', 678:'E1', 640:'F1',
  604:'F#1', 570:'G1', 538:'G#1', 508:'A1', 480:'A#1', 453:'B1',
  428:'C2', 404:'C#2', 381:'D2', 360:'D#2', 339:'E2', 320:'F2',
  302:'F#2', 285:'G2', 269:'G#2', 254:'A2', 240:'A#2', 226:'B2',
  214:'C3', 202:'C#3', 190:'D3', 180:'D#3', 170:'E3', 160:'F3',
  151:'F#3', 143:'G3', 135:'G#3', 127:'A3', 120:'A#3', 113:'B3',
};
function pNote(p) {
  if(!p) return '---';
  const closest = Object.keys(PERIODS).reduce((a,b) => Math.abs(b-p)<Math.abs(a-p)?b:a);
  const freq = Math.round(AMIGA_PAL / p);
  return `${PERIODS[closest]||'?'}(${p},${freq}Hz)`;
}

// Show pattern 1 and 2 in detail (order[0] and order[1])
for(let pi = 0; pi < 2; pi++) {
  const patNum = orders[pi];
  console.log(`\n=== Order[${pi}] = Pattern ${patNum} ===`);
  for(let r = 0; r < 64; r++) {
    let cols = [];
    let hasData = false;
    for(let c = 0; c < channels; c++) {
      const o = patOff + patNum * patSize + (r * channels + c) * 4;
      const b0=buf[o], b1=buf[o+1], b2=buf[o+2], b3=buf[o+3];
      const snum = ((b0&0xF0)|(b2>>4));
      const period = ((b0&0x0F)<<8)|b1;
      const effect = b2&0x0F;
      const param = b3;
      if(snum || period || effect || param) {
        hasData = true;
        const sname = snum ? (samples[snum-1]?.name||'?').substring(0,12) : '            ';
        const note = period ? pNote(period) : '';
        cols.push(`ch${c} s${snum||'--'}:${sname} ${note} e=${effect.toString(16)} x=${param.toString(16).padStart(2,'0')}`);
      } else {
        cols.push(`ch${c} ---`);
      }
    }
    if(hasData) console.log(`  R${String(r).padStart(2,'0')}: ${cols.join(' | ')}`);
  }
}
