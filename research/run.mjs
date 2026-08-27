/* Прогон правил бота по настоящей истории.
   Ключевые условия честности:
   - сигнал считается ТОЛЬКО по закрытым барам (никакого заглядывания вперёд);
   - вход по цене открытия СЛЕДУЮЩЕГО бара, а не по цене сигнала;
   - стоп и тейк проверяются по часовым барам внутри 4-часового;
   - если бар задел и стоп, и тейк — считаем стоп (пессимистично);
   - комиссия и проскальзывание вычитаются на каждой сделке. */
import fs from 'fs';
import { signalOn } from './engine.mjs';

const SYMS=['BTC-USDT','ETH-USDT','SOL-USDT','BNB-USDT','XRP-USDT','DOGE-USDT'];
const FEE=0.0006, SLIP=0.0004;         // тейкер обе стороны + проскальзывание

function to4h(h1){
  const out=[];
  for(let i=0;i+3<h1.length;i+=4){
    const c=h1.slice(i,i+4);
    out.push({t:c[0].t,o:c[0].o,h:Math.max(...c.map(x=>x.h)),l:Math.min(...c.map(x=>x.l)),
              c:c[3].c,v:c.reduce((s,x)=>s+x.v,0), i1:i});
  }
  return out;
}

export function backtest(cfg, symbols=SYMS, from=0, to=1){
  const trades=[];
  for(const sym of symbols){
    const h1=JSON.parse(fs.readFileSync(`/tmp/bt/${sym}.json`,'utf8'));
    const h4=to4h(h1);
    const lo=Math.max(250, Math.floor(h4.length*from)), hi=Math.floor(h4.length*to);
    let open=null, cooldownUntil=0;
    for(let i=lo;i<hi;i++){
      // управление открытой позицией по часовым барам внутри текущего 4h
      if(open){
        const seg=h1.slice(h4[i].i1, h4[i].i1+4);
        const dir = open.side==='LONG'?1:-1;
        for(const b of seg){
          /* Частичная фиксация на 1R: закрываем половину и двигаем стоп в
             безубыток. Это структурное изменение выплаты, а не подбор
             параметра: меняется само распределение исходов. */
          if(cfg.partialAtR && !open.partial){
            const lvl = open.entry*(1 + dir*open.riskFrac*cfg.partialAtR);
            const hit = open.side==='LONG' ? b.h>=lvl : b.l<=lvl;
            if(hit){
              open.partial = true;
              open.bankedR = cfg.partialAtR*cfg.partialFrac - (FEE+SLIP)*2/open.riskFrac*cfg.partialFrac;
              open.sl = open.entry;                  // остаток без риска
            }
          }
          const hitSL = open.side==='LONG' ? b.l<=open.sl : b.h>=open.sl;
          const hitTP = open.side==='LONG' ? b.h>=open.tp : b.l<=open.tp;
          if(hitSL||hitTP){
            const px = hitSL ? open.sl : open.tp;   // пессимистично: стоп приоритетнее
            const gross = (px-open.entry)/open.entry*dir;
            const net = gross - FEE*2 - SLIP*2;
            const frac = open.partial ? (1-cfg.partialFrac) : 1;
            const r = (net/open.riskFrac)*frac + (open.bankedR||0);
            trades.push({sym, side:open.side, r, net:r*open.riskFrac, t:b.t, win: r>0});
            if(r<0) cooldownUntil = i + Math.ceil(cfg.cooldownBars||0);
            open=null; break;
          }
        }
      }
      if(open || i<cooldownUntil) continue;
      const sg = signalOn(h4.slice(0,i+1));         // только закрытые бары
      if(!sg) continue;
      if(sg.strength < cfg.minStrength) continue;
      if(sg.rr < cfg.minRR) continue;
      const nxt = h4[i+1]; if(!nxt) continue;
      const entry = nxt.o;                          // вход по открытию следующего бара
      const riskFrac = Math.abs(entry-sg.sl)/entry;
      if(!(riskFrac>0.002)) continue;
      open={side:sg.dir, entry, sl:sg.sl, tp:sg.tp, riskFrac};
    }
  }
  return stats(trades, cfg);
}

function stats(tr, cfg){
  const n=tr.length;
  if(!n) return {n:0, winRate:0, avgR:0, totalR:0, maxDDr:0, pf:0, sharpe:0, ret:0, maxDDpct:0};
  const wins=tr.filter(t=>t.win).length;
  const rs=tr.map(t=>t.r);
  const totalR=rs.reduce((a,b)=>a+b,0);
  const gp=rs.filter(r=>r>0).reduce((a,b)=>a+b,0), gl=-rs.filter(r=>r<0).reduce((a,b)=>a+b,0);
  const mean=totalR/n, sd=Math.sqrt(rs.reduce((s,r)=>s+(r-mean)**2,0)/Math.max(1,n-1));
  // кривая капитала при фиксированном риске cfg.riskPct на сделку
  let eq=1, peak=1, dd=0;
  tr.forEach(t=>{ eq*= (1 + t.r*(cfg.riskPct/100)); peak=Math.max(peak,eq); dd=Math.max(dd,(peak-eq)/peak); });
  let peakR=0,curR=0,ddR=0;
  rs.forEach(r=>{ curR+=r; peakR=Math.max(peakR,curR); ddR=Math.max(ddR,peakR-curR); });
  return { n, winRate:wins/n*100, avgR:mean, totalR,
           pf: gl>0? gp/gl : (gp>0?99:0),
           sharpe: sd>0? mean/sd*Math.sqrt(n) : 0,
           maxDDr: ddR, ret:(eq-1)*100, maxDDpct: dd*100 };
}
