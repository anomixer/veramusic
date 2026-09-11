/**
 * Render ONLY the Choir channel (ch2) for first 30s to hear portamento clearly
 */
import { readFileSync, writeFileSync } from 'node:fs';

const VERA_AUDIO_RATE = 8010.864;
const AMIGA_PAL_CLOCK = 3546895;

const buf = readFileSync('space_debris.mod');
const channels = 4;
const patOff = 1084;
const songLen = buf.readUInt8(950);
const orders = [...buf.slice(952,952+128)].slice(0,songLen);
const maxPat = Math.max(...orders);
const patSize = 64*channels*4;

const samples = [];
for(let i=0;i<31;i++) {
  const o=20+i*30;
  samples.push({
    id:i+1,
    name:buf.toString('latin1',o,o+22).replace(/\0[\s\S]*$/,'').trim(),
    length:buf.readUInt16BE(o+22)*2,
    volume:Math.min(64,buf.readUInt8(o+25)),
    repStart:buf.readUInt16BE(o+26)*2,
    repLen:buf.readUInt16BE(o+28)*2,
  });
}
let sOff = patOff+(maxPat+1)*patSize;
for(const s of samples){
  s.data=buf.subarray(sOff,Math.min(buf.length,sOff+s.length));
  sOff+=s.length;
  s.hasLoop = s.repLen > 2;
  s.isPcm = /chord|choir|rezonat|zoh|sawsynth|kick|bd|snare|sd|hat|hh|cymbal|shake|hup/i.test(s.name);
}

const patterns = [];
for(let p=0;p<=maxPat;p++){
  const rows=[];
  for(let r=0;r<64;r++){
    const row=[];
    for(let c=0;c<channels;c++){
      const o=patOff+p*patSize+(r*channels+c)*4;
      const b0=buf[o],b1=buf[o+1],b2=buf[o+2],b3=buf[o+3];
      row.push({sample:((b0&0xF0)|(b2>>4)),period:((b0&0x0F)<<8)|b1,effect:b2&0x0F,param:b3});
    }
    rows.push(row);
  }
  patterns.push(rows);
}

// Simulate ONLY ch2 state
const ch = { period:0, vol:0, curSample:0, toneTarget:0, toneSpeed:0, volSlide:0 };
let activePcm = null;
const st = { pos:0, row:0, tickInRow:0, speed:6, tempo:125, done:false };

function slotAt() { return patterns[orders[st.pos]]?.[st.row]?.[2]; }

function processRow() {
  const slot = slotAt() || {sample:0,period:0,effect:0,param:0};
  if(slot.sample) {
    ch.curSample = slot.sample;
    const s = samples[slot.sample-1];
    if(s) {
      if(s.isPcm) ch.vol = s.volume;
      else { if(s.volume>0) ch.vol=s.volume; else if(ch.vol===0) ch.vol=64; }
    }
  }
  const {effect:e, param:x} = slot;
  // ProTracker effect memory: effects 1/2/3 with x=0 reuse previous speed
  ch.volSlide=0;
  if(e===0x3) { if(x) ch.toneSpeed=x; }    // portamento memory
  else if(e===0xA) ch.volSlide=x;
  else if(e===0xC) ch.vol=Math.min(64,x);
  else if(e===0xF && x>0) { if(x<32) st.speed=Math.max(1,x); else st.tempo=Math.max(32,x); }
  else if(e!==0x1 && e!==0x2 && e!==0x4) {
    // Non-memory effect: reset portamento speeds
    ch.toneSpeed=0;
  }

  if(slot.period && e===3) {
    ch.toneTarget = slot.period;
    console.log(`  ROW${st.row} portamento: toneTarget=${slot.period} toneSpeed=${x} curPeriod=${ch.period}`);
  } else if(slot.period) {
    // Trigger
    const s = samples[(slot.sample||ch.curSample)-1];
    if(s && s.isPcm && s.data.length > 0) {
      const p = slot.period;
      const step = (AMIGA_PAL_CLOCK/p)/VERA_AUDIO_RATE;
      const loopEnd = s.hasLoop ? s.repStart+s.repLen : s.data.length;
      activePcm = { sample:s, pos:0, step, loopStart:s.repStart||0, loopEnd, hasLoop:s.hasLoop };
      console.log(`  ROW${st.row} TRG ch2: "${s.name}" period=${p} vol=${ch.vol} step=${step.toFixed(4)} hasLoop=${s.hasLoop}`);
    }
    ch.period = slot.period;
  }
}

function processTickEffects() {
  if(ch.toneSpeed && ch.toneTarget) {
    const d = ch.toneTarget - ch.period;
    ch.period += Math.abs(d)<=ch.toneSpeed ? d : Math.sign(d)*ch.toneSpeed;
  }
  if(ch.volSlide) {
    const up=ch.volSlide>>4, dn=ch.volSlide&0x0F;
    ch.vol = Math.max(0, Math.min(64, ch.vol+(up||!dn?up:-dn)));
  }
}

let totalFrames=0, acc=0;
const LIMIT = 60*30;
const allSamples = [];

while(!st.done && totalFrames<LIMIT) {
  const tickHz = (2*st.tempo)/5;
  acc += tickHz;
  while(acc>=60 && !st.done) {
    if(st.tickInRow===0) processRow();
    else processTickEffects();
    // Update PCM voice step based on current period
    if(activePcm && ch.period) {
      activePcm.step = (AMIGA_PAL_CLOCK/Math.max(1,ch.period))/VERA_AUDIO_RATE;
    }
    st.tickInRow++;
    if(st.tickInRow>=st.speed) {
      st.tickInRow=0;
      st.row++;
      if(st.row>=64||st.jumpPos>=0) {
        const t=st.pos+1;
        if(t>=orders.length){st.done=true;break;}
        st.row=0; st.pos=t;
      }
    }
    acc-=60;
  }

  // Render this frame's PCM for ch2 only
  const targetS = Math.round((totalFrames+1)*VERA_AUDIO_RATE/60);
  const numS = targetS - Math.round(totalFrames*VERA_AUDIO_RATE/60);
  const chVol = ch.vol/64;

  for(let si=0; si<numS; si++) {
    let val = 0;
    if(activePcm && !activePcm.done) {
      const idx = Math.floor(activePcm.pos);
      const data = activePcm.sample.data;
      if(idx < data.length) {
        val = ((data[idx]<<24)>>24) * chVol;
        activePcm.pos += activePcm.step;
        if(activePcm.hasLoop && activePcm.pos >= activePcm.loopEnd) {
          activePcm.pos = activePcm.loopStart + (activePcm.pos - activePcm.loopEnd) % (activePcm.loopEnd - activePcm.loopStart);
        }
      } else {
        activePcm.done = true;
      }
    }
    allSamples.push(Math.max(-128, Math.min(127, Math.round(val))));
  }
  totalFrames++;
}

console.log(`Rendered ${totalFrames} frames = ${(totalFrames/60).toFixed(1)}s, ${allSamples.length} samples`);

// Write WAV
const SR = Math.round(VERA_AUDIO_RATE);
const n = allSamples.length;
const wav = Buffer.alloc(44+n*2);
wav.write('RIFF',0); wav.writeUInt32LE(36+n*2,4); wav.write('WAVE',8);
wav.write('fmt ',12); wav.writeUInt32LE(16,16); wav.writeUInt16LE(1,20);
wav.writeUInt16LE(1,22); wav.writeUInt32LE(SR,24); wav.writeUInt32LE(SR*2,28);
wav.writeUInt16LE(2,32); wav.writeUInt16LE(16,34);
wav.write('data',36); wav.writeUInt32LE(n*2,40);
for(let i=0;i<n;i++) wav.writeInt16LE(allSamples[i]*256, 44+i*2);
writeFileSync('choir_ch2_30s.wav', wav);
console.log('Wrote choir_ch2_30s.wav');
