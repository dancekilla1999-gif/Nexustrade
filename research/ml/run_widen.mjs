/* То же исполнение, что в run.mjs, но с одним новым рычагом: slWidenMult
   раздвигает СТОП от входа в cfg.slWidenMult раз (тейк не трогаем), а размер
   позиции по-прежнему считается по фиксированному % риска от баланса — то
   есть трейд risk-нормализован так же честно, как и без раздвижки, просто
   стоп переживает больше шума перед срабатыванием. Это тот же механизм,
   которым в ML-эксперименте (research/ML_TRAINING.md) удавалось поднять
   вин-рейт ценой размера убытка — здесь проверяем его на РЕАЛЬНОМ движке
   сигналов бота (engine.mjs), а не на отдельной ATR-барьерной симуляции. */
import fs from 'fs';
import { signalOn } from './engine.mjs';

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

export function backtest(cfg, symbols, from=0, to=1){
  const trades=[];
  let openAtEnd=0;
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
            const px = hitSL ? open.sl : open.tp;     // пессимистично при совпадении
            const gross = (px-open.entry)/open.entry*dir;
            const net = gross - FEE*2 - SLIP*2;
            const r = net/open.riskFrac;
            trades.push({sym, side:open.side, r, t:b.t, win: r>0});
            if(r<0) cooldownUntil = i + Math.ceil(cfg.cooldownBars||0);
            open=null; break;
          }
        }
      }
      if(open || i<cooldownUntil) continue;
      const sg = signalOn(h4.slice(0,i+1));
      if(!sg) continue;
      if(sg.strength < cfg.minStrength) continue;
      if(sg.rr < cfg.minRR) continue;
      const nxt = h4[i+1]; if(!nxt) continue;
      const entry = nxt.o;
      const dir = sg.dir==='LONG' ? 1 : -1;
      const baseRiskDist = Math.abs(entry-sg.sl);
      const riskDist = baseRiskDist * (cfg.slWidenMult||1);
      const sl = entry - dir*riskDist;
      const riskFrac = riskDist/entry;
      if(!(riskFrac>0.002)) continue;
      open={side:sg.dir, entry, sl, tp:sg.tp, riskFrac};
    }
    // Честность: сделка, ещё не закрытая на конец истории/среза — не пропавшая
    // без следа, а закрытая по последней известной цене (mark-to-market).
    // Иначе широкий стоп мог бы "прятать" зависшие в минусе позиции, раздувая
    // видимый винрейт за счёт того, что они просто не попали в статистику.
    if(open){
      const lastPx = h1[Math.min(hi*4-1, h1.length-1)].c;
      const dir = open.side==='LONG'?1:-1;
      const gross=(lastPx-open.entry)/open.entry*dir, net=gross-FEE*2-SLIP*2;
      trades.push({sym, side:open.side, r:net/open.riskFrac, t:h1[h1.length-1].t, win:net>0, openAtEnd:true});
      openAtEnd++;
    }
  }
  const s = stats(trades, cfg);
  s.openAtEnd = openAtEnd;
  return s;
}

function stats(tr, cfg){
  const n=tr.length;
  if(!n) return {n:0, winRate:0, avgR:0, totalR:0, maxDDr:0, pf:0};
  const wins=tr.filter(t=>t.win).length;
  const rs=tr.map(t=>t.r);
  const totalR=rs.reduce((a,b)=>a+b,0);
  const gp=rs.filter(r=>r>0).reduce((a,b)=>a+b,0), gl=-rs.filter(r=>r<0).reduce((a,b)=>a+b,0);
  let peakR=0,curR=0,ddR=0;
  rs.forEach(r=>{ curR+=r; peakR=Math.max(peakR,curR); ddR=Math.max(ddR,peakR-curR); });
  return { n, winRate:wins/n*100, avgR:totalR/n, totalR, pf: gl>0? gp/gl : (gp>0?99:0), maxDDr:ddR };
}
