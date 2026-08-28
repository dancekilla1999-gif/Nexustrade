// Второй вариант той же гипотезы: структура (HH/HL) вместо EMA на D1,
// пробой локального 1H-экстремума вместо RSI-разворота как триггер входа.
import fs from 'fs';
import { signalOn } from './engine.mjs';

const FEE=0.0006, SLIP=0.0004;
const SYMS=['BTC-USDT','ETH-USDT','SOL-USDT','BNB-USDT','XRP-USDT','DOGE-USDT',
  'ADA-USDT','AVAX-USDT','LINK-USDT','LTC-USDT','DOT-USDT','TRX-USDT','NEAR-USDT',
  'ATOM-USDT','UNI-USDT','ETC-USDT','FIL-USDT','APT-USDT','ARB-USDT','OP-USDT'];

function to4h(h1){
  const out=[];
  for(let i=0;i+3<h1.length;i+=4){
    const c=h1.slice(i,i+4);
    out.push({t:c[0].t,o:c[0].o,h:Math.max(...c.map(x=>x.h)),l:Math.min(...c.map(x=>x.l)),
              c:c[3].c,v:c.reduce((s,x)=>s+x.v,0), i1:i});
  }
  return out;
}
function to1d(h1){
  const out=[];
  for(let i=0;i+23<h1.length;i+=24){
    const c=h1.slice(i,i+24);
    out.push({t:c[0].t,o:c[0].o,h:Math.max(...c.map(x=>x.h)),l:Math.min(...c.map(x=>x.l)),
              c:c[23].c,v:c.reduce((s,x)=>s+x.v,0), i1:i});
  }
  return out;
}
// Те же функции, что и в движке (structLevels/swingPoints) — определяют HH/HL vs LH/LL.
function swingPoints(k, dep, minPct){
  dep=dep||4; minPct=(minPct==null?0.35:minPct);
  const raw=[];
  for(let i=dep;i<k.length-dep;i++){
    let isH=true, isL=true;
    for(let j=i-dep;j<=i+dep;j++){ if(j===i) continue;
      if(k[j].h>k[i].h) isH=false;
      if(k[j].l<k[i].l) isL=false; }
    if(isH){ let mn=1e18; for(let j=i-dep;j<=i+dep;j++) if(j!==i) mn=Math.min(mn,k[j].l);
      if((k[i].h-mn)/k[i].h*100>=minPct) raw.push({i,p:k[i].h,type:'H'}); }
    if(isL){ let mx=-1e18; for(let j=i-dep;j<=i+dep;j++) if(j!==i) mx=Math.max(mx,k[j].h);
      if((mx-k[i].l)/k[i].l*100>=minPct) raw.push({i,p:k[i].l,type:'L'}); }
  }
  raw.sort((a,b)=>a.i-b.i);
  const out=[];
  raw.forEach(s=>{ const last=out[out.length-1];
    if(last && last.type===s.type){ if((s.type==='H'&&s.p>last.p)||(s.type==='L'&&s.p<last.p)) out[out.length-1]=s; }
    else out.push(s); });
  return out;
}
// Даёт структурный bias ('LONG'/'SHORT'/null) используя только бары до индекса idx включительно.
function structBiasAt(dailyBars, idx){
  const sub = dailyBars.slice(0, idx+1);
  if(sub.length<20) return null;
  let sw=swingPoints(sub, 3, 1.0);
  if(sw.filter(s=>s.type==='H').length<2 || sw.filter(s=>s.type==='L').length<2) sw=swingPoints(sub,2,0.6);
  const highs=sw.filter(s=>s.type==='H'), lows=sw.filter(s=>s.type==='L');
  if(highs.length<2||lows.length<2) return null;
  const lastH=highs[highs.length-1], prevH=highs[highs.length-2];
  const lastL=lows[lows.length-1], prevL=lows[lows.length-2];
  if(lastH.p>prevH.p && lastL.p>prevL.p) return 'LONG';
  if(lastH.p<prevH.p && lastL.p<prevL.p) return 'SHORT';
  return null;
}

const trades=[];
for(const sym of SYMS){
  const h1=JSON.parse(fs.readFileSync(`/tmp/bt/${sym}.json`,'utf8'));
  const h4=to4h(h1);
  const d1=to1d(h1);
  // Кешируем дневной bias по индексу дневного бара — считать на каждый вход заново дорого.
  const dBiasCache=new Map();
  function dBias(idx){
    if(!dBiasCache.has(idx)) dBiasCache.set(idx, structBiasAt(d1, idx));
    return dBiasCache.get(idx);
  }

  let open=null;
  for(let i=250;i<h4.length-1;i++){
    if(open){
      const seg=h1.slice(h4[i].i1, h4[i].i1+4);
      const dir = open.side==='LONG'?1:-1;
      for(const b of seg){
        const hitSL = open.side==='LONG' ? b.l<=open.sl : b.h>=open.sl;
        const hitTP = open.side==='LONG' ? b.h>=open.tp : b.l<=open.tp;
        if(hitSL||hitTP){
          const px = hitSL ? open.sl : open.tp;
          const gross=(px-open.entry)/open.entry*dir, net=gross-FEE*2-SLIP*2;
          trades.push({ sym, t:open.t, r:net/open.riskFrac, win:net>0, dailyAgree:open.dailyAgree, h1Trigger:open.h1Trigger });
          open=null; break;
        }
      }
    }
    if(open) continue;
    const sg = signalOn(h4.slice(0,i+1));
    if(!sg) continue;
    if(sg.strength < 70) continue;
    if(sg.rr < 2.0) continue;
    const nxt=h4[i+1]; if(!nxt) continue;
    const entryIdx=nxt.i1;
    const entry=nxt.o, riskFrac=Math.abs(entry-sg.sl)/entry;
    if(!(riskFrac>0.002)) continue;

    const dIdx = Math.floor(entryIdx/24) - 1;
    let dailyAgree=false;
    if(dIdx>=20){ const b=dBias(dIdx); dailyAgree = (b===sg.dir); }

    // 1H пробой локального экстремума последних 6 часов прямо перед входом.
    const j = entryIdx-1;
    let h1Trigger=false;
    if(j>=8){
      const win=h1.slice(j-6,j);
      const hh=Math.max(...win.map(x=>x.h)), ll=Math.min(...win.map(x=>x.l));
      if(sg.dir==='LONG') h1Trigger = h1[j].h>hh;
      else h1Trigger = h1[j].l<ll;
    }

    open={side:sg.dir, entry, sl:sg.sl, tp:sg.tp, riskFrac, t:h4[i].t, dailyAgree, h1Trigger};
  }
}

function stats(arr){
  const n=arr.length; if(!n) return {n:0};
  const wins=arr.filter(t=>t.win).length;
  const rs=arr.map(t=>t.r), sumR=rs.reduce((a,b)=>a+b,0);
  const gp=rs.filter(r=>r>0).reduce((a,b)=>a+b,0), gl=-rs.filter(r=>r<0).reduce((a,b)=>a+b,0);
  return { n, winRate:wins/n*100, avgR:sumR/n, pf: gl>0?gp/gl:(gp>0?99:0) };
}
function fmt(s){ return s.n? `n=${String(s.n).padStart(5)}  WR=${s.winRate.toFixed(1)}%  avgR=${s.avgR.toFixed(3)}  PF=${s.pf.toFixed(2)}` : 'n=0'; }

console.log('Всего сделок движка:', trades.length);
console.log('\n--- полная история ---');
console.log('база (все сделки)                 :', fmt(stats(trades)));
console.log('+ 1D структура согласна            :', fmt(stats(trades.filter(t=>t.dailyAgree))));
console.log('+ 1H пробой локального экстремума  :', fmt(stats(trades.filter(t=>t.h1Trigger))));
console.log('+ оба (все 3 TF)                    :', fmt(stats(trades.filter(t=>t.dailyAgree && t.h1Trigger))));

const sorted=trades.slice().sort((a,b)=>a.t-b.t);
const splitT = sorted[Math.floor(sorted.length*0.7)].t;
const tr = trades.filter(t=>t.t<splitT), te = trades.filter(t=>t.t>=splitT);
console.log('\n--- train (первые 70%) ---');
console.log('база                : ', fmt(stats(tr)));
console.log('+ оба (все 3 TF)     :', fmt(stats(tr.filter(t=>t.dailyAgree && t.h1Trigger))));
console.log('\n--- test (последние 30%) ---');
console.log('база                : ', fmt(stats(te)));
console.log('+ оба (все 3 TF)     :', fmt(stats(te.filter(t=>t.dailyAgree && t.h1Trigger))));

function shuffleFlag(arr, key){
  const vals = arr.map(t=>t[key]);
  for(let i=vals.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [vals[i],vals[j]]=[vals[j],vals[i]]; }
  return arr.map((t,i)=>({...t, [key]:vals[i]}));
}
console.log('\n--- негативный контроль (перемешаны флаги, 5 прогонов) ---');
for(let k=0;k<5;k++){
  let shuf = shuffleFlag(trades,'dailyAgree');
  shuf = shuffleFlag(shuf,'h1Trigger');
  const sub = shuf.filter(t=>t.dailyAgree && t.h1Trigger);
  console.log(`  прогон ${k+1}: ${fmt(stats(sub))}`);
}
