import { readFileSync } from 'node:fs';
const buf = readFileSync('space_debris.mod');
const channels = 4;
const patOff = 1084;
const songLen = buf.readUInt8(950);
const orders = [...buf.slice(952,952+128)].slice(0,songLen);
const maxPat = Math.max(...orders);
const patSize = 64*channels*4;
const PAL = 3546895;

const samples = [];
for(let i=0;i<31;i++) {
  const o=20+i*30;
  const name=buf.toString('latin1',o,o+22).replace(/\0[\s\S]*$/,'').trim();
  const len=buf.readUInt16BE(o+22)*2;
  const vol=buf.readUInt8(o+25);
  const repLen=buf.readUInt16BE(o+28)*2;
  samples.push({id:i+1, name, len, vol, repLen});
}

const PERIODS = {856:'C1',808:'C#1',762:'D1',720:'D#1',678:'E1',640:'F1',
  604:'F#1',570:'G1',538:'G#1',508:'A1',480:'A#1',453:'B1',
  428:'C2',404:'C#2',381:'D2',360:'D#2',339:'E2',320:'F2',
  302:'F#2',285:'G2',269:'G#2',254:'A2',240:'A#2',226:'B2',
  214:'C3',202:'C#3',190:'D3',180:'D#3',170:'E3',160:'F3'};
function pn(p){if(!p)return'---';const c=Object.keys(PERIODS).reduce((a,b)=>Math.abs(b-p)<Math.abs(a-p)?b:a);return `${PERIODS[c]||'?'}(${p})`;}

// Speed=6 tempo=125: tickHz=50, rows/sec=50/6=8.33, seconds/pattern=64/8.33=7.68s
const rowsPerSec = 50/6;
const secsPerPat = 64/rowsPerSec; // ~7.68s per pattern

console.log('Pattern timing:');
for(let i=0;i<Math.min(orders.length, 12);i++) {
  const t = i * secsPerPat;
  const mins = Math.floor(t/60), secs = (t%60).toFixed(1);
  console.log(`  Order[${i}] @ ${mins}:${String(secs).padStart(4,'0')} = Pattern ${orders[i]}`);
}

console.log('');

// Show patterns 10, 17, 18 in detail (the ones around 0:31)
for(const patNum of [10, 17, 18]) {
  console.log(`\n=== Pattern ${patNum} ===`);
  const usedSamples = new Set();
  for(let r=0;r<64;r++) {
    let cols=[], hasData=false;
    for(let c=0;c<channels;c++) {
      const o=patOff+patNum*patSize+(r*channels+c)*4;
      const b0=buf[o],b1=buf[o+1],b2=buf[o+2],b3=buf[o+3];
      const snum=((b0&0xF0)|(b2>>4));
      const period=((b0&0x0F)<<8)|b1;
      const effect=b2&0x0F;
      const param=b3;
      if(snum||period||effect||param) {
        hasData=true;
        if(snum) usedSamples.add(snum);
        const sname=(snum?samples[snum-1]?.name||'?':'').substring(0,11);
        const note=period?pn(period):'';
        cols.push(`ch${c} s${snum||'--'}:${sname} ${note} e=${effect.toString(16)} x=${param.toString(16).padStart(2,'0')}`);
      } else {
        cols.push(`ch${c} ---`);
      }
    }
    if(hasData) console.log(`  R${String(r).padStart(2)}: ${cols.join(' | ')}`);
  }
  console.log(`  Samples used: ${[...usedSamples].map(n=>`s${n}:"${samples[n-1]?.name}"`).join(', ')}`);
}
