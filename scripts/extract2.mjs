import { readFileSync, writeFileSync } from 'node:fs';
const buf = readFileSync('space_debris.mod');
const channels = 4;
const patOff = 1084;
const songLen = buf.readUInt8(950);
const orders = [...buf.slice(952,952+128)].slice(0,songLen);
const maxPat = Math.max(...orders);
const patSize = 64*channels*4;
const PAL = 3546895;

let sOff = patOff + (maxPat+1)*patSize;
for(let i=0;i<31;i++) {
  const o=20+i*30;
  const name=buf.toString('latin1',o,o+22).replace(/\0[\s\S]*$/,'').trim();
  const len=buf.readUInt16BE(o+22)*2;
  const vol=buf.readUInt8(o+25);
  const repStart=buf.readUInt16BE(o+26)*2;
  const repLen=buf.readUInt16BE(o+28)*2;
  if(len>0) {
    const data=buf.subarray(sOff,sOff+len);
    console.log(`s${i+1} "${name}" len=${len} vol=${vol} repStart=${repStart} repLen=${repLen} offset=${sOff} dataActual=${data.length}`);
    
    // Write WAV for key samples
    if(/Zoh|Choir|Rezon/i.test(name)) {
      const wavName = name.replace(/[^a-zA-Z0-9]/g,'_') + '.wav';
      const n = data.length;
      const rate = Math.round(PAL/428); // at C2 native
      const wav = Buffer.alloc(44+n*2);
      wav.write('RIFF',0); wav.writeUInt32LE(36+n*2,4); wav.write('WAVE',8);
      wav.write('fmt ',12); wav.writeUInt32LE(16,16); wav.writeUInt16LE(1,20);
      wav.writeUInt16LE(1,22); wav.writeUInt32LE(rate,24); wav.writeUInt32LE(rate*2,28);
      wav.writeUInt16LE(2,32); wav.writeUInt16LE(16,34);
      wav.write('data',36); wav.writeUInt32LE(n*2,40);
      for(let j=0;j<n;j++) wav.writeInt16LE(((data[j]<<24)>>24)*256, 44+j*2);
      writeFileSync(wavName, wav);
      console.log(`  -> wrote ${wavName} at ${rate}Hz`);
    }
  }
  sOff+=len;
}
