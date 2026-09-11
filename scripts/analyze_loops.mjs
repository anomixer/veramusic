import { readFileSync } from 'node:fs';
const buf = readFileSync('space_debris.mod');
for(let i=0; i<31; i++) {
  const o = 20+i*30;
  const name = buf.toString('latin1', o, o+22).replace(/\0[\s\S]*$/, '').trim();
  const len = buf.readUInt16BE(o+22)*2;
  if(!len) continue;
  const vol = buf.readUInt8(o+25);
  const ft = buf.readUInt8(o+24)&0x0F;
  const repStart = buf.readUInt16BE(o+26)*2;
  const repLen = buf.readUInt16BE(o+28)*2;
  const hasLoop = repLen > 2;
  console.log(`s${String(i+1).padStart(2,'0')} len=${String(len).padStart(6)} vol=${String(vol).padStart(2)} ft=${ft} repS=${repStart} repLen=${repLen} loop=${hasLoop} name="${name}"`);
}
