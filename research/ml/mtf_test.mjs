// Честная проверка гипотезы мультитаймфреймного слияния (Elder's Triple Screen):
// 1D определяет общий тренд ("прилив"), 4H — это сама сделка (bias/структура/TP/SL,
// движок бота как есть), 1H — момент входа (локальный разворот моментума).
// Берём в работу только сделки, где ВСЕ три таймфрейма согласны, и сравниваем
// с базовой линией (все сделки 4H-движка, уже измерено в run20.mjs).
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
function emaArr(v,p){ const k=2/(p+1), o=new Array(v.length); o[0]=v[0];
  for(let i=1;i<v.length;i++) o[i]=v[i]*k+o[i-1]*(1-k); return o; }
function rsiArr(v,p){ p=p||14; const o=new Array(v.length).fill(null);
  if(v.length<=p) return o; let g=0,l=0;
  for(let i=1;i<=p;i++){ const d=v[i]-v[i-1]; if(d>=0) g+=d; else l-=d; }
  let ag=g/p, al=l/p; o[p]= al===0?100:100-100/(1+ag/al);
  for(let i=p+1;i<v.length;i++){ const d=v[i]-v[i-1];
    ag=(ag*(p-1)+(d>0?d:0))/p; al=(al*(p-1)+(d<0?-d:0))/p;
    o[i]= al===0?100:100-100/(1+ag/al); } return o; }

// Собираем все сделки движка (как в run20.mjs) + для каждой считаем dailyAgree и h1Trigger.
const trades=[];
for(const sym of SYMS){
  const h1=JSON.parse(fs.readFileSync(`/tmp/bt/${sym}.json`,'utf8'));
  const h4=to4h(h1);
  const d1=to1d(h1);
  const dCl=d1.map(x=>x.c);
  const dE21=emaArr(dCl,21), dE50=emaArr(dCl,50);
  const h1RSI=rsiArr(h1.map(x=>x.c),14);

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
    const entryIdx=nxt.i1;              // индекс в h1, где открывается сделка
    const entry=nxt.o, riskFrac=Math.abs(entry-sg.sl)/entry;
    if(!(riskFrac>0.002)) continue;

    // --- 1D bias: последний ЗАКРЫТЫЙ дневной бар строго до входа ---
    const dIdx = Math.floor(entryIdx/24) - 1;
    let dailyAgree = false;
    if(dIdx>=55 && dE21[dIdx]!=null && dE50[dIdx]!=null){
      const dBias = dE21[dIdx] > dE50[dIdx] ? 'LONG' : 'SHORT';
      dailyAgree = (dBias === sg.dir);
    }

    // --- 1H trigger: локальный разворот моментума в направлении сделки прямо перед входом ---
    const j = entryIdx-1; // последний закрытый часовой бар перед входом
    let h1Trigger=false;
    if(j>=18 && h1RSI[j]!=null){
      const win=[h1RSI[j-4],h1RSI[j-3],h1RSI[j-2]].filter(x=>x!=null);
      if(win.length){
        if(sg.dir==='LONG') h1Trigger = Math.min(...win)<40 && h1RSI[j]>45 && h1RSI[j]>h1RSI[j-1];
        else h1Trigger = Math.max(...win)>60 && h1RSI[j]<55 && h1RSI[j]<h1RSI[j-1];
      }
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

console.log('Всего сделок движка (minStrength>=70, RR>=2, весь период):', trades.length);
console.log('\n--- полная история ---');
console.log('база (все сделки)                :', fmt(stats(trades)));
console.log('+ 1D согласен с направлением      :', fmt(stats(trades.filter(t=>t.dailyAgree))));
console.log('+ 1H триггер momentum-разворота    :', fmt(stats(trades.filter(t=>t.h1Trigger))));
console.log('+ 1D согласен И 1H триггер (все 3) :', fmt(stats(trades.filter(t=>t.dailyAgree && t.h1Trigger))));

// train/test по времени
const sorted=trades.slice().sort((a,b)=>a.t-b.t);
const splitT = sorted[Math.floor(sorted.length*0.7)].t;
const tr = trades.filter(t=>t.t<splitT), te = trades.filter(t=>t.t>=splitT);
console.log('\n--- train (первые 70% по времени) ---');
console.log('база                               :', fmt(stats(tr)));
console.log('+ 1D согласен                       :', fmt(stats(tr.filter(t=>t.dailyAgree))));
console.log('+ 1D и 1H (все 3 TF)                :', fmt(stats(tr.filter(t=>t.dailyAgree && t.h1Trigger))));
console.log('\n--- test (последние 30%, не участвовали в выборе фильтра) ---');
console.log('база                               :', fmt(stats(te)));
console.log('+ 1D согласен                       :', fmt(stats(te.filter(t=>t.dailyAgree))));
console.log('+ 1D и 1H (все 3 TF)                :', fmt(stats(te.filter(t=>t.dailyAgree && t.h1Trigger))));

// негативный контроль: перемешиваем dailyAgree/h1Trigger случайно (с той же частотой true/false),
// чтобы увидеть, не объясняется ли "улучшение" выше просто уменьшением размера выборки.
function shuffleFlag(arr, key){
  const vals = arr.map(t=>t[key]);
  for(let i=vals.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [vals[i],vals[j]]=[vals[j],vals[i]]; }
  return arr.map((t,i)=>({...t, [key]:vals[i]}));
}
console.log('\n--- негативный контроль (перемешаны флаги dailyAgree/h1Trigger, 5 прогонов) ---');
for(let k=0;k<5;k++){
  let shuf = shuffleFlag(trades,'dailyAgree');
  shuf = shuffleFlag(shuf,'h1Trigger');
  const sub = shuf.filter(t=>t.dailyAgree && t.h1Trigger);
  console.log(`  прогон ${k+1}: ${fmt(stats(sub))}`);
}
