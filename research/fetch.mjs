// Выкачивает настоящую часовую историю с OKX постранично.
import fs from 'fs';
const SYMS=['BTC-USDT','ETH-USDT','SOL-USDT','BNB-USDT','XRP-USDT','DOGE-USDT'];
const NEED=10000;                      // 10 000 часов ≈ 417 дней

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function page(instId, after){
  const u=`https://www.okx.com/api/v5/market/history-candles?instId=${instId}&bar=1H&limit=300`+(after?`&after=${after}`:'');
  for(let a=0;a<4;a++){
    try{
      const r=await fetch(u); const j=await r.json();
      if(j.code==='0' && Array.isArray(j.data)) return j.data;
    }catch(e){}
    await sleep(700*(a+1));
  }
  return [];
}
for(const sym of SYMS){
  let all=[], after=null, guard=0;
  while(all.length<NEED && guard++<60){
    const d=await page(sym, after);
    if(!d.length) break;
    all=all.concat(d);
    after=d[d.length-1][0];             // курсор назад по времени
    await sleep(220);
  }
  // OKX отдаёт новые→старые; переворачиваем и приводим к нашему виду
  const bars=all.map(r=>({t:+r[0],o:+r[1],h:+r[2],l:+r[3],c:+r[4],v:+r[5]}))
                .filter(b=>isFinite(b.c)&&b.c>0)
                .sort((a,b)=>a.t-b.t);
  // защита от дублей и разрывов
  const out=[]; let last=0;
  for(const b of bars){ if(b.t>last){ out.push(b); last=b.t; } }
  const gaps=out.slice(1).filter((b,i)=>b.t-out[i].t!==3600000).length;
  fs.writeFileSync(`/tmp/bt/${sym}.json`, JSON.stringify(out));
  console.log(`${sym}: ${out.length} баров, ${(out.length/24).toFixed(0)} дней, разрывов ${gaps}, `+
    `${new Date(out[0].t).toISOString().slice(0,10)} → ${new Date(out[out.length-1].t).toISOString().slice(0,10)}`);
}
