// Тот же честный прогон, что и run.mjs, но на всех 20 парах и с текущим
// (30 подтверждений, minPass=20) движком — чтобы BOT_BACKTEST в приложении
// не остался цифрой от старого 20-фильтрового движка.
import fs from 'fs';
import { signalOn } from './engine.mjs';

const SYMS=['BTC-USDT','ETH-USDT','SOL-USDT','BNB-USDT','XRP-USDT','DOGE-USDT',
  'ADA-USDT','AVAX-USDT','LINK-USDT','LTC-USDT','DOT-USDT','TRX-USDT','NEAR-USDT',
  'ATOM-USDT','UNI-USDT','ETC-USDT','FIL-USDT','APT-USDT','ARB-USDT','OP-USDT'];
const FEE=0.0006, SLIP=0.0004;

function to4h(h1){
  const out=[];
  for(let i=0;i+3<h1.length;i+=4){
    const c=h1.slice(i,i+4);
    out.push({t:c[0].t,o:c[0].o,h:Math.max(...c.map(x=>x.h)),l:Math.min(...c.map(x=>x.l)),
              c:c[3].c,v:c.reduce((s,x)=>s+x.v,0), i1:i});
  }
  return out;
}

function backtest(cfg, symbols, from=0, to=1){
  const trades=[];
  for(const sym of symbols){
    const h1=JSON.parse(fs.readFileSync(`/tmp/bt/${sym}.json`,'utf8'));
    const h4=to4h(h1);
    const lo=Math.max(250, Math.floor(h4.length*from)), hi=Math.floor(h4.length*to);
    let open=null, cooldownUntil=0;
    for(let i=lo;i<hi;i++){
      if(open){
        const seg=h1.slice(h4[i].i1, h4[i].i1+4);
        const dir = open.side==='LONG'?1:-1;
        for(const b of seg){
          const hitSL = open.side==='LONG' ? b.l<=open.sl : b.h>=open.sl;
          const hitTP = open.side==='LONG' ? b.h>=open.tp : b.l<=open.tp;
          if(hitSL||hitTP){
            const px = hitSL ? open.sl : open.tp;
            const gross=(px-open.entry)/open.entry*dir, net=gross-FEE*2-SLIP*2;
            trades.push({sym, r:net/open.riskFrac, win:net>0});
            if(net<0) cooldownUntil = i + Math.ceil(cfg.cooldownBars||0);
            open=null; break;
          }
        }
      }
      if(open || i<cooldownUntil) continue;
      const sg = signalOn(h4.slice(0,i+1));
      if(!sg) continue;
      if(sg.strength < cfg.minStrength) continue;
      if(sg.rr < cfg.minRR) continue;
      const nxt=h4[i+1]; if(!nxt) continue;
      const entry=nxt.o, riskFrac=Math.abs(entry-sg.sl)/entry;
      if(!(riskFrac>0.002)) continue;
      open={side:sg.dir, entry, sl:sg.sl, tp:sg.tp, riskFrac};
    }
  }
  const n=trades.length;
  if(!n) return {n:0};
  const wins=trades.filter(t=>t.win).length;
  const rs=trades.map(t=>t.r), totalR=rs.reduce((a,b)=>a+b,0);
  const gp=rs.filter(r=>r>0).reduce((a,b)=>a+b,0), gl=-rs.filter(r=>r<0).reduce((a,b)=>a+b,0);
  let eq=1,peak=1,dd=0; trades.forEach(t=>{ eq*=(1+t.r*(cfg.riskPct/100)); peak=Math.max(peak,eq); dd=Math.max(dd,(peak-eq)/peak); });
  return { n, winRate:wins/n*100, avgR:totalR/n, totalR, pf: gl>0?gp/gl:(gp>0?99:0), ret:(eq-1)*100, maxDDpct:dd*100 };
}

const cfg = { minStrength:70, minRR:2.0, riskPct:1, cooldownBars:0 };
console.log('=== 30-подтверждений движок, minPass=20, полная история 20 пар ===');
const full = backtest(cfg, SYMS, 0, 1);
console.log(full);
console.log('\n=== train (первые 70%) / test (последние 30%) ===');
const tr = backtest(cfg, SYMS, 0, 0.7);
const te = backtest(cfg, SYMS, 0.7, 1.0);
console.log('train:', tr);
console.log('test :', te);
