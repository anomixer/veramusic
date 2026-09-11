import { readFileSync } from 'node:fs';
const buf = readFileSync('space_debris.mod');
const sig = buf.toString('ascii', 1080, 1084);
console.log('Sig:', sig);
const songLen = buf.readUInt8(950);
const orders = [...buf.slice(952, 952+128)].slice(0, songLen);
console.log('Song length:', songLen, 'patterns');
console.log('Order list:', orders.join(','));
console.log('');
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
  if(len>0) {
    const line = `s${String(i+1).padStart(2,'0')} len=${String(len).padStart(6)} vol=${String(vol).padStart(2)} loop=${repLen} name="${name}"`;
    console.log(line);
  }
}

console.log('');
// Show channel usage in first 4 patterns (intro)
const chMap = { 'M.K.': 4, 'M!K!': 4, 'FLT4': 4, '4CHN': 4 };
const channels = chMap[sig];
const patOff = 1084, patSize = 64 * channels * 4;
const maxPat = Math.max(...orders);

// Analyze which samples appear in each pattern
console.log('Pattern sample usage:');
for(let p = 0; p <= Math.min(maxPat, 8); p++) {
  const used = new Set();
  for(let r = 0; r < 64; r++) {
    for(let c = 0; c < channels; c++) {
      const o = patOff + p * patSize + (r * channels + c) * 4;
      const b0 = buf[o], b2 = buf[o+2];
      const snum = ((b0 & 0xF0) | (b2 >> 4));
      if(snum) used.add(snum);
    }
  }
  const sNames = [...used].map(n => `s${n}:"${samples[n-1]?.name||'?'}"`).join(', ');
  console.log(`  Pat ${String(p).padStart(2)}: ${sNames}`);
}

console.log('');
// Trace the order list and find what happens in first several patterns
console.log('First 10 order entries:');
for(let i=0; i<Math.min(10, orders.length); i++) {
  console.log(`  Order[${i}] => Pattern ${orders[i]}`);
}
