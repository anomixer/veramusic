import { readFileSync } from 'node:fs';
const buf = readFileSync('space_debris.mod');
const sig = buf.toString('ascii', 1080, 1084);
const channels = 4;
const patOff = 1084, patSize = 64 * channels * 4;

// Parse samples
const samples = [];
for(let i=0; i<31; i++) {
  const o = 20 + i*30;
  const name = buf.toString('latin1', o, o+22).replace(/\0[\s\S]*$/, '').trim();
  const len = buf.readUInt16BE(o+22)*2;
  const vol = buf.readUInt8(o+25);
  samples.push({ id: i+1, name, len, vol });
}

const songLen = buf.readUInt8(950);
const orders = [...buf.slice(952, 952+128)].slice(0, songLen);

// Show first 3 patterns in detail (intro)
for(let pi = 0; pi < 3; pi++) {
  const patNum = orders[pi];
  console.log(`\n=== Order[${pi}] = Pattern ${patNum} ===`);
  for(let r = 0; r < 64; r++) {
    let rowStr = `  Row ${String(r).padStart(2)}:`;
    let hasData = false;
    for(let c = 0; c < channels; c++) {
      const o = patOff + patNum * patSize + (r * channels + c) * 4;
      const b0 = buf[o], b1 = buf[o+1], b2 = buf[o+2], b3 = buf[o+3];
      const snum = ((b0 & 0xF0) | (b2 >> 4));
      const period = ((b0 & 0x0F) << 8) | b1;
      const effect = b2 & 0x0F;
      const param = b3;
      if(snum || period || effect || param) {
        hasData = true;
        const sname = snum ? samples[snum-1]?.name || '?' : '---';
        const svol = snum ? samples[snum-1]?.vol : '-';
        rowStr += ` | ch${c} s${snum || '--'}(vol=${svol}) p=${period} e=${effect.toString(16)} x=${param.toString(16).padStart(2,'0')}`;
      } else {
        rowStr += ' | ---';
      }
    }
    if(hasData) console.log(rowStr);
  }
}
