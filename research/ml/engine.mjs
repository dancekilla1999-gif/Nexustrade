// СГЕНЕРИРОВАНО: код извлечён из index.html (30 подтверждений, minPass=20), не редактировать
const SIG_MIN_MOVE=2.0;
const SIG_MIN_RR=1.8;
const SIG_MIN_PASS=20;
const SIG_TOTAL_CONFIRM=30;
function decOf(){return 2;}
let __K=null;
function realKlines(){ return __K; }
function computeSignal(sym){
  const k=realKlines(sym,'4h'); if(!k||k.length<70) return null;
  const cl=k.map(o=>o.c), n=cl.length, last=cl[n-1];
  const e21=emaArr(cl,21), e50=emaArr(cl,50), e200=emaArr(cl,200);
  const r=rsiArr(cl,14), mac=macdArr(cl), st=stochArr(k,14,3), bb=bbArr(cl,20,2);
  const atr=atrArr(k,14);
  const adxR=adxArr(k,14), cci=cciArr(k,20), roc=rocArr(cl,10), vwap=vwapArr(k);
  const vol=k.map(o=>o.v||0), volAvg=vol.slice(-20).reduce((s,v)=>s+v,0)/20 || 1;
  const rsi=r[n-1]||50, atrPct=(atr[n-1]/last)*100;

  const {highs, lows} = structLevels(k,4);
  const lastH=highs.length?highs[highs.length-1]:null, prevH=highs.length>1?highs[highs.length-2]:null;
  const lastL=lows.length?lows[lows.length-1]:null,   prevL=lows.length>1?lows[lows.length-2]:null;
  const structUp   = lastH&&prevH&&lastL&&prevL ? (lastH.p>prevH.p && lastL.p>prevL.p) : false;
  const structDown = lastH&&prevH&&lastL&&prevL ? (lastH.p<prevH.p && lastL.p<prevL.p) : false;

  const above200 = e200[n-1]!=null && last>e200[n-1];
  const emaUp = e21[n-1]>e50[n-1];
  let bias=null;
  if(structUp && above200) bias='LONG';
  else if(structDown && !above200) bias='SHORT';
  else if(emaUp && above200) bias='LONG';
  else if(!emaUp && !above200) bias='SHORT';
  else if(structUp) bias='LONG';
  else if(structDown) bias='SHORT';
  if(!bias) return null;
  const up = bias==='LONG';

  const target = up ? nearestAbove(highs, last, SIG_MIN_MOVE) : nearestBelow(lows, last, SIG_MIN_MOVE);
  const atrProj = atr[n-1]*3.2;
  let tp, tpSrc;
  if(target && Math.abs(target.p-last)/last*100 <= 9){
    tp = target.p*(up?0.997:1.003); tpSrc='уровень структуры';
  } else {
    const projPct = Math.max(SIG_MIN_MOVE*1.15, atrProj/last*100);
    tp = up ? last*(1+projPct/100) : last*(1-projPct/100); tpSrc='проекция по ATR';
  }
  const movePct = Math.abs(tp-last)/last*100;
  if(movePct < SIG_MIN_MOVE) return null;

  const protect = up ? lastL : lastH;
  const protectOK = protect && (up ? protect.p<last : protect.p>last) &&
                    Math.abs(last-protect.p)/last*100 <= 3.5;
  let sl = protectOK ? protect.p*(up?0.995:1.005) : (up? last-atr[n-1]*1.6 : last+atr[n-1]*1.6);
  const maxRisk = last*0.025;
  if(up && last-sl > maxRisk) sl = last-maxRisk;
  if(!up && sl-last > maxRisk) sl = last+maxRisk;
  const riskPct = Math.abs(last-sl)/last*100;
  if(riskPct < 0.25) return null;

  const rr = movePct/riskPct;
  if(rr < SIG_MIN_RR) return null;

  const higherHigh = last>Math.max(...cl.slice(n-6,n-1));
  const lowerLow   = last<Math.min(...cl.slice(n-6,n-1));
  const bodyOK = up ? k[n-1].c>k[n-1].o : k[n-1].c<k[n-1].o;
  const last4 = k.slice(n-4,n);
  const closesWithDir = last4.filter(c=> up ? c.c>c.o : c.c<c.o).length;
  const distEma200Pct = e200[n-1]!=null ? Math.abs(last-e200[n-1])/last*100 : 999;
  const emaStackUp   = e21[n-1]>e50[n-1] && e50[n-1]>e200[n-1];
  const emaStackDown = e21[n-1]<e50[n-1] && e50[n-1]<e200[n-1];
  const F=[
    ['Структура рынка', up?structUp:structDown, 1.6],
    ['Цена относительно EMA 200', up? above200 : !above200, 1.5],
    ['EMA 21 vs EMA 50', up? e21[n-1]>e50[n-1] : e21[n-1]<e50[n-1], 1.3],
    ['Наклон EMA 21', up? e21[n-1]>e21[n-3] : e21[n-1]<e21[n-3], 1.0],
    ['Наклон EMA 50', up? e50[n-1]>e50[n-3] : e50[n-1]<e50[n-3], 1.0],
    ['MACD выше/ниже сигнальной', up? mac.macd[n-1]>mac.sig[n-1] : mac.macd[n-1]<mac.sig[n-1], 1.2],
    ['Гистограмма MACD усиливается', up? mac.hist[n-1]>mac.hist[n-2] : mac.hist[n-1]<mac.hist[n-2], 1.0],
    ['RSI по направлению сделки', up? rsi>48 : rsi<52, 1.1],
    ['RSI не в экстремуме', up? rsi<74 : rsi>26, 1.2],
    ['RSI разворачивается', up? r[n-1]>r[n-2] : r[n-1]<r[n-2], 0.9],
    ['Stochastic по направлению', up? st.k[n-1]>st.d[n-1] : st.k[n-1]<st.d[n-1], 0.9],
    ['Stochastic не перегрет', up? st.k[n-1]<82 : st.k[n-1]>18, 1.0],
    ['Позиция в канале Боллинджера', up? last>bb.mid[n-1] : last<bb.mid[n-1], 1.0],
    ['Свеча по направлению', bodyOK, 0.8],
    ['Импульс последних баров', up? higherHigh : lowerLow, 1.1],
    ['Объём не ниже среднего', (k[n-1].v||0) >= volAvg*0.75, 1.0],
    ['Волатильность достаточная', atrPct>0.5, 1.3],
    ['Потенциал до цели', movePct>=SIG_MIN_MOVE, 2.0],
    ['Соотношение риск/прибыль', rr>=SIG_MIN_RR, 2.0],
    ['Цель опирается на уровень структуры', tpSrc==='уровень структуры', 1.4],
    ['ADX подтверждает тренд (>20)', adxR.adx[n-1]>20, 1.3],
    ['DI+/DI- по направлению', up? adxR.pdi[n-1]>adxR.mdi[n-1] : adxR.mdi[n-1]>adxR.pdi[n-1], 1.1],
    ['CCI по направлению', up? cci[n-1]>0 : cci[n-1]<0, 0.9],
    ['MACD выше/ниже нулевой линии', up? mac.macd[n-1]>0 : mac.macd[n-1]<0, 1.0],
    ['ROC по направлению', up? roc[n-1]>0.3 : roc[n-1]<-0.3, 0.9],
    ['Большинство последних свечей по направлению', closesWithDir>=3, 1.0],
    ['Объём растёт относительно предыдущего бара', (k[n-1].v||0)>(k[n-2].v||0), 0.7],
    ['Полный порядок EMA 21/50/200 по направлению', up? emaStackUp : emaStackDown, 1.4],
    ['Не перекуплено/перепродано относительно EMA200', distEma200Pct<15, 1.0],
    ['Цена относительно VWAP', up? last>vwap[n-1] : last<vwap[n-1], 0.9],
  ];
  const totalW=F.reduce((s,f)=>s+f[2],0);
  const gotW=F.filter(f=>f[1]).reduce((s,f)=>s+f[2],0);
  const passed=F.filter(f=>f[1]).length, total=F.length;
  if(passed < SIG_MIN_PASS) return null;

  const strength=Math.round(gotW/totalW*100);
  const d=decOf(sym);
  const horizonBars = Math.max(3, Math.round(movePct/Math.max(0.3,atrPct)));
  return {
    symbol:sym, dir:bias, strength, passed, total, entry:last, tp, sl, rsi,
    movePct, riskPct, rr,
    reasons:F.filter(f=>f[1]).slice(0,4).map(f=>f[0]),
    filters:F, d, tf:'4H', tpSrc,
    horizon: horizonBars<=6 ? 'до 1 дня' : horizonBars<=18 ? '1–3 дня' : '3–7 дней',
    targetLevel: target? target.p : null
  };
}
function structLevels(k, dep){
  for(const d of [dep||4, 3, 2]){
    const sw=swingPoints(k, d, 0.25);
    const highs=sw.filter(s=>s.type==='H'), lows=sw.filter(s=>s.type==='L');
    if(highs.length>=2 && lows.length>=2) return {highs, lows, dep:d};
  }
  const sw=swingPoints(k, 2, 0.15);
  return { highs: sw.filter(s=>s.type==='H'), lows: sw.filter(s=>s.type==='L'), dep:2 };
}
function nearestAbove(levels, price, minGapPct){
  const c=levels.filter(l=>l.p>price*(1+(minGapPct||0)/100)).sort((a,b)=>a.p-b.p);
  return c.length?c[0]:null;
}
function nearestBelow(levels, price, minGapPct){
  const c=levels.filter(l=>l.p<price*(1-(minGapPct||0)/100)).sort((a,b)=>b.p-a.p);
  return c.length?c[0]:null;
}
function emaArr(v,p){ const kk=2/(p+1), o=new Array(v.length); o[0]=v[0];
  for(let i=1;i<v.length;i++) o[i]=v[i]*kk+o[i-1]*(1-kk); return o; }
function bbArr(v,p,m){ p=p||20; m=m||2; const mid=smaArr(v,p), up=[], lo2=[];
  for(let i=0;i<v.length;i++){ if(i<p-1||mid[i]===null){ up.push(null); lo2.push(null); continue; }
    let s=0; for(let j=i-p+1;j<=i;j++){ const d=v[j]-mid[i]; s+=d*d; }
    const sd=Math.sqrt(s/p); up.push(mid[i]+m*sd); lo2.push(mid[i]-m*sd); }
  return {mid,up,lo:lo2}; }
function trArr(k){ return k.map((c,i)=>i?Math.max(c.h-c.l,Math.abs(c.h-k[i-1].c),Math.abs(c.l-k[i-1].c)):c.h-c.l); }
function atrArr(k,p){ return emaArr(trArr(k),p||14); }
function adxArr(k,p){ p=p||14; const tr=trArr(k); const pdm=[],mdm=[];
  for(let i=0;i<k.length;i++){ const up=i?k[i].h-k[i-1].h:0, dn=i?k[i-1].l-k[i].l:0;
    pdm.push(up>dn&&up>0?up:0); mdm.push(dn>up&&dn>0?dn:0); }
  const atr=emaArr(tr,p), pdi=emaArr(pdm,p).map((x,i)=>atr[i]?100*x/atr[i]:0), mdi=emaArr(mdm,p).map((x,i)=>atr[i]?100*x/atr[i]:0);
  const dx=pdi.map((x,i)=>{const s=x+mdi[i];return s?100*Math.abs(x-mdi[i])/s:0;});
  return {adx:emaArr(dx,p), pdi, mdi}; }
function cciArr(k,p){ p=p||20; const tp=k.map(c=>(c.h+c.l+c.c)/3), m=smaArr(tp,p), o=new Array(k.length).fill(null);
  for(let i=p-1;i<k.length;i++){ let md=0; for(let j=i-p+1;j<=i;j++) md+=Math.abs(tp[j]-m[i]); md/=p;
    o[i]=md?(tp[i]-m[i])/(0.015*md):0; } return o; }
function rocArr(v,p){ p=p||12; return v.map((x,i)=>i>=p?(x-v[i-p])/v[i-p]*100:null); }
function vwapArr(k){ let pv=0,vv=0; return k.map(c=>{ const tp=(c.h+c.l+c.c)/3, v=c.v||0; pv+=tp*v; vv+=v; return vv?pv/vv:c.c; }); }
function rsiArr(v,p){ p=p||14; const o=new Array(v.length).fill(null);
  if(v.length<=p) return o; let g=0,l=0;
  for(let i=1;i<=p;i++){ const d=v[i]-v[i-1]; if(d>=0) g+=d; else l-=d; }
  let ag=g/p, al=l/p; o[p]= al===0?100:100-100/(1+ag/al);
  for(let i=p+1;i<v.length;i++){ const d=v[i]-v[i-1];
    ag=(ag*(p-1)+(d>0?d:0))/p; al=(al*(p-1)+(d<0?-d:0))/p;
    o[i]= al===0?100:100-100/(1+ag/al); } return o; }
function macdArr(v){ const f=emaArr(v,12), s=emaArr(v,26);
  const macd=v.map((_,i)=>f[i]-s[i]); const sig=emaArr(macd,9);
  const hist=macd.map((m,i)=>m-sig[i]); return {macd,sig,hist}; }
function stochArr(k,p,d){ p=p||14; d=d||3; const kA=new Array(k.length).fill(null);
  for(let i=0;i<k.length;i++){ if(i<p-1) continue; let hh=-1e18,ll=1e18;
    for(let j=i-p+1;j<=i;j++){ if(k[j].h>hh)hh=k[j].h; if(k[j].l<ll)ll=k[j].l; }
    kA[i]= hh===ll?50:(k[i].c-ll)/(hh-ll)*100; }
  const dA=new Array(k.length).fill(null);
  for(let i=0;i<k.length;i++){ if(kA[i]===null) continue; let s=0,c=0;
    for(let j=Math.max(0,i-d+1);j<=i;j++){ if(kA[j]!==null){ s+=kA[j]; c++; } } dA[i]=c?s/c:null; }
  return {k:kA,d:dA}; }
function swingPoints(k, dep, minPct){
  dep=dep||4; minPct=(minPct==null?0.35:minPct);
  const raw=[];
  for(let i=dep;i<k.length-dep;i++){
    let isH=true, isL=true;
    for(let j=i-dep;j<=i+dep;j++){ if(j===i) continue;
      if(k[j].h>k[i].h) isH=false;
      if(k[j].l<k[i].l) isL=false; }
    if(isH){ let mn=1e18; for(let j=i-dep;j<=i+dep;j++) if(j!==i) mn=Math.min(mn,k[j].l);
      if((k[i].h-mn)/k[i].h*100>=minPct) raw.push({i,p:k[i].h,t:k[i].t,type:'H'}); }
    if(isL){ let mx=-1e18; for(let j=i-dep;j<=i+dep;j++) if(j!==i) mx=Math.max(mx,k[j].h);
      if((mx-k[i].l)/k[i].l*100>=minPct) raw.push({i,p:k[i].l,t:k[i].t,type:'L'}); }
  }
  raw.sort((a,b)=>a.i-b.i);
  const out=[];
  raw.forEach(s=>{
    const last=out[out.length-1];
    if(last && last.type===s.type){
      if((s.type==='H'&&s.p>last.p)||(s.type==='L'&&s.p<last.p)) out[out.length-1]=s;
    } else out.push(s);
  });
  return out;
}
function smaArr(v,p){ const o=new Array(v.length).fill(null); let s=0;
  for(let i=0;i<v.length;i++){ s+=v[i]; if(i>=p) s-=v[i-p]; if(i>=p-1) o[i]=s/p; } return o; }
export function signalOn(bars){ __K=bars; return computeSignal("X"); }
