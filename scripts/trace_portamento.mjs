/**
 * Trace ch2 Choir portamento - frames 70-200 (roughly rows 10-30 of pattern 1)
 */
import { readFileSync } from 'node:fs';
const VERA_AUDIO_RATE = 8010.864;
const AMIGA_PAL_CLOCK = 3546895;
const PCM_VOL_SCALE = 0.55;

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
    id:i+1, name:buf.toString('latin1',o,o+22).replace(/\0[\s\S]*$/,'').trim(),
    length:buf.readUInt16BE(o+22)*2, volume:Math.min(64,buf.readUInt8(o+25)),
    repStart:buf.readUInt16BE(o+26)*2, repLen:buf.readUInt16BE(o+28)*2,
  });
}
let sOff = patOff+(maxPat+1)*patSize;
for(const s of samples){s.data=buf.subarray(sOff,Math.min(buf.length,sOff+s.length));sOff+=s.length;}

for(const s of samples){
  s.isDrum=/kick|bd\d*|bassdrum|snare|sd\d*|hat|hh|cymbal|shake|softshake|hup|vocalhit/i.test(s.name);
  s.isPcm=s.isDrum||/chord|choir|rezonat|zoh|sawsynth/i.test(s.name)||(!(/brass|bass|lead|pulse/i.test(s.name))&&s.length>0);
  s.hasLoop=s.repLen>2;
}

const chans=[];
for(let c=0;c<channels;c++) chans.push({period:0,vol:0,curSample:0,arp:0,portaUp:0,portaDown:0,toneTarget:0,toneSpeed:0,vibPos:0,vibDepth:0,vibRate:0,volSlide:0,cutTick:-1,delayTick:-1,isMutedByPcm:false});
const activePcm=new Array(channels).fill(null);
let activeDrums=[];

const st={pos:0,row:0,tickInRow:0,speed:6,tempo:125,jumpPos:-1,done:false};
const slotAt=(c)=>mod.patterns[mod.orders[st.pos]]?.[st.row]?.[c];
const mod={patterns:[],orders,channels};

// Parse patterns
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
  mod.patterns.push(rows);
}

function triggerSampleVoice(ci,s,period,vol){
  if(!s||!s.data||!s.data.length)return;
  const p=period||428;
  const step=(AMIGA_PAL_CLOCK/p)/VERA_AUDIO_RATE;
  activePcm[ci]={sample:s,pos:0,step,vol:(vol/64)*PCM_VOL_SCALE,
    loopStart:s.repStart||0,loopEnd:s.hasLoop?s.repStart+s.repLen:s.data.length,hasLoop:s.hasLoop,done:false};
}

function applyNote(ch,slot,ci){
  const n=slot.sample||ch.curSample;
  const s=n?mod.samples[n-1]:null;
  if(!s)return;
  if(s.isPcm){
    ch.isMutedByPcm=true;
    const vol=Math.max(1,Math.min(64,ch.vol));
    const period=slot.period||ch.period||428;
    if(s.isDrum)activeDrums.push({sample:s,pos:0,step:(AMIGA_PAL_CLOCK/period)/VERA_AUDIO_RATE,vol:(vol/64)*PCM_VOL_SCALE,done:false});
    else triggerSampleVoice(ci,s,period,vol);
    if(slot.period)ch.period=slot.period;
    return;
  }
  ch.isMutedByPcm=false;activePcm[ci]=null;
  if(slot.period){ch.period=slot.period;ch.toneTarget=0;}
}

function processRow(){
  for(let c=0;c<channels;c++){
    const ch=chans[c],slot=slotAt(c)||{sample:0,period:0,effect:0,param:0};
    if(slot.sample){ch.curSample=slot.sample;const s=mod.samples[slot.sample-1];if(s){if(s.isPcm)ch.vol=s.volume;else{if(s.volume>0)ch.vol=s.volume;else if(ch.vol===0)ch.vol=64;}}}
    const{effect:e,param:x}=slot;
    ch.arp=0;ch.portaUp=0;ch.portaDown=0;ch.volSlide=0;ch.vibDepth=0;ch.vibRate=0;ch.toneSpeed=0;ch.cutTick=-1;ch.delayTick=-1;
    switch(e){case 0x1:ch.portaUp=x;break;case 0x2:ch.portaDown=x;break;case 0x3:ch.toneSpeed=x;break;case 0xA:ch.volSlide=x;break;case 0xC:ch.vol=Math.min(64,x);break;case 0xF:if(x>0){if(x<32)st.speed=Math.max(1,x);else st.tempo=Math.max(32,x);}break;}
    if(slot.period&&e===3)ch.toneTarget=slot.period;
    else if(slot.period&&ch.delayTick<0)applyNote(ch,slot,c);
  }
}

function processTickEffects(){
  for(let c=0;c<channels;c++){
    const ch=chans[c];
    if(ch.portaUp)ch.period=Math.max(113,ch.period-ch.portaUp);
    if(ch.portaDown)ch.period=Math.min(856,ch.period+ch.portaDown);
    if(ch.toneSpeed&&ch.toneTarget){const d=ch.toneTarget-ch.period;ch.period+=Math.abs(d)<=ch.toneSpeed?d:Math.sign(d)*ch.toneSpeed;}
    if(ch.volSlide){const up=ch.volSlide>>4,dn=ch.volSlide&0x0F;ch.vol=Math.max(0,Math.min(64,ch.vol+(up||!dn?up:-dn)));}
  }
}

function emitTick(){
  for(let c=0;c<channels;c++){
    const ch=chans[c],v=activePcm[c];
    if(v&&ch.period&&!v.done){
      const step=(AMIGA_PAL_CLOCK/Math.max(1,ch.period))/VERA_AUDIO_RATE;
      v.step=step;v.vol=(Math.min(64,ch.vol)/64)*PCM_VOL_SCALE;
    }
  }
}

let totalFrames=0,acc=0;
const LIMIT=60*50;

while(!st.done&&totalFrames<LIMIT){
  const tickHz=(2*st.tempo)/5;
  acc+=tickHz;
  while(acc>=60&&!st.done){
    if(st.tickInRow===0)processRow();
    else processTickEffects();
    emitTick();
    st.tickInRow++;
    if(st.tickInRow>=st.speed){
      st.tickInRow=0;
      st.row++;
      if(st.row>=64||st.jumpPos>=0){
        const t=st.jumpPos>=0?st.jumpPos:st.pos+1;
        if(t>=mod.orders.length){st.done=true;break;}
        st.row=0;st.pos=t;st.jumpPos=-1;
      }
    }
    acc-=60;
  }

  // Log ch2 state every 30 frames (0.5s) during first 50 seconds
  if(totalFrames%30===0){
    const ch2=chans[2];
    const v2=activePcm[2];
    const sName=ch2.curSample?mod.samples[ch2.curSample-1]?.name:'---';
    const freq=ch2.period?Math.round(AMIGA_PAL_CLOCK/ch2.period):0;
    const step=v2?v2.step.toFixed(4):'n/a';
    const vvol=v2?v2.vol.toFixed(3):'n/a';
    console.log(`f=${String(totalFrames).padStart(4)} t=${(totalFrames/60).toFixed(1).padStart(5)}s | ch2: s="${sName}" period=${ch2.period} freq=${freq}Hz vol=${ch2.vol} | pcm_step=${step} pcm_vol=${vvol} toneTarget=${ch2.toneTarget} toneSpeed=${ch2.toneSpeed}`);
  }
  totalFrames++;
}
