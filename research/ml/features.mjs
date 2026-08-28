// Признаки для модели. Индикаторы — теми же формулами, что в приложении
// (извлечены engine.mjs в прошлой сессии), но здесь нужны СЫРЫЕ значения
// индикаторов как числа, а не булевы "подтверждения": обучаемая модель
// сама взвесит, что важно, вместо того чтобы это взвешивание задавал я
// руками через веса фильтров.
import fs from 'fs';

function smaArr(v,p){ const out=new Array(v.length).fill(null); let s=0;
  for(let i=0;i<v.length;i++){ s+=v[i]; if(i>=p) s-=v[i-p]; if(i>=p-1) out[i]=s/p; } return out; }
function emaArr(v,p){ const k=2/(p+1), out=new Array(v.length).fill(null);
  let prev=null; for(let i=0;i<v.length;i++){ if(v[i]==null){continue;}
    if(prev==null){ if(i>=p-1){ let s=0; for(let j=i-p+1;j<=i;j++)s+=v[j]; prev=s/p; out[i]=prev; } }
    else { prev=v[i]*k+prev*(1-k); out[i]=prev; } } return out; }
function rsiArr(v,p){ const out=new Array(v.length).fill(null); let g=0,l=0;
  for(let i=1;i<v.length;i++){ const d=v[i]-v[i-1], up=Math.max(d,0), dn=Math.max(-d,0);
    if(i<=p){ g+=up; l+=dn; if(i===p){ g/=p; l/=p; out[i]= l===0?100:100-100/(1+g/l); } }
    else{ g=(g*(p-1)+up)/p; l=(l*(p-1)+dn)/p; out[i]= l===0?100:100-100/(1+g/l); } } return out; }
function macdArr(v){ const e12=emaArr(v,12), e26=emaArr(v,26);
  const macd=v.map((_,i)=> (e12[i]!=null&&e26[i]!=null)? e12[i]-e26[i] : null);
  const sig=emaArr(macd.map(x=>x==null?0:x),9);
  const hist=macd.map((m,i)=> (m!=null&&sig[i]!=null)? m-sig[i] : null);
  return {macd,sig,hist}; }
function stochArr(k,period,smoothK){ const K=new Array(k.length).fill(null);
  for(let i=period-1;i<k.length;i++){ let hh=-Infinity,ll=Infinity;
    for(let j=i-period+1;j<=i;j++){ hh=Math.max(hh,k[j].h); ll=Math.min(ll,k[j].l); }
    K[i]= hh===ll?50:(k[i].c-ll)/(hh-ll)*100; }
  const Ks=smaArr(K.map(x=>x==null?0:x),smoothK), D=smaArr(Ks.map(x=>x==null?0:x),smoothK);
  return {k:Ks,d:D}; }
function bbArr(v,p,m){ const mid=smaArr(v,p), out={mid,up:[],lo:[]};
  for(let i=0;i<v.length;i++){ if(mid[i]==null){ out.up.push(null); out.lo.push(null); continue; }
    let s=0; for(let j=i-p+1;j<=i;j++) s+=(v[j]-mid[i])**2; const sd=Math.sqrt(s/p);
    out.up.push(mid[i]+m*sd); out.lo.push(mid[i]-m*sd); } return out; }
function trArr(k){ const out=new Array(k.length).fill(null);
  for(let i=1;i<k.length;i++){ out[i]=Math.max(k[i].h-k[i].l, Math.abs(k[i].h-k[i-1].c), Math.abs(k[i].l-k[i-1].c)); }
  return out; }
function atrArr(k,p){ const tr=trArr(k); return emaArr(tr.map(x=>x==null?0:x),p).map((x,i)=>i<p?null:x); }

/** Строит 4h-бары из часовых. */
export function to4h(h1){
  const out=[];
  for(let i=0;i+3<h1.length;i+=4){
    const c=h1.slice(i,i+4);
    out.push({t:c[0].t,o:c[0].o,h:Math.max(...c.map(x=>x.h)),l:Math.min(...c.map(x=>x.l)),
              c:c[3].c,v:c.reduce((s,x)=>s+x.v,0), i1:i});
  }
  return out;
}

/**
 * Признаки на баре i (используя только k[0..i]) — никакого заглядывания вперёд.
 * Возвращает null, если истории недостаточно.
 */
export function featuresAt(k, i){
  if(i<210) return null;
  const cl=k.map(x=>x.c).slice(0,i+1);
  const win=k.slice(0,i+1);
  const last=cl[cl.length-1];
  const e21=emaArr(cl,21), e50=emaArr(cl,50), e200=emaArr(cl,200);
  const r=rsiArr(cl,14), mac=macdArr(cl), st=stochArr(win,14,3), bb=bbArr(cl,20,2);
  const atr=atrArr(win,14);
  const n=cl.length-1;
  if(e200[n]==null||atr[n]==null||mac.hist[n]==null) return null;

  const atrPct=atr[n]/last*100;
  const vol=win.map(x=>x.v||0), volAvg=vol.slice(-20).reduce((s,v)=>s+v,0)/20||1;
  const bbWidth=(bb.up[n]-bb.lo[n])/bb.mid[n];
  const bbPos=(last-bb.lo[n])/((bb.up[n]-bb.lo[n])||1);

  // Признаки — только числа, нормализованные там, где это осмысленно
  // (в единицах ATR или в процентах), чтобы модель не зависела от цены актива.
  return {
    distEma21: (last-e21[n])/last*100,
    distEma50: (last-e50[n])/last*100,
    distEma200: (last-e200[n])/last*100,
    ema21vs50: (e21[n]-e50[n])/last*100,
    ema21slope: (e21[n]-e21[n-3])/last*100,
    ema50slope: (e50[n]-e50[n-3])/last*100,
    rsi: r[n],
    rsiSlope: r[n]-r[n-2],
    macdHist: mac.hist[n]/last*1000,
    macdHistSlope: (mac.hist[n]-mac.hist[n-1])/last*1000,
    stochK: st.k[n],
    stochD: st.d[n],
    bbPos,
    bbWidth: bbWidth*100,
    atrPct,
    volRatio: (win[n].v||0)/volAvg,
    ret1: (last/cl[n-1]-1)*100,
    ret3: (last/cl[n-3]-1)*100,
    ret6: (last/cl[n-6]-1)*100,
    hh6: last>Math.max(...cl.slice(n-6,n)) ? 1:0,
    ll6: last<Math.min(...cl.slice(n-6,n)) ? 1:0,
    bodyUp: win[n].c>win[n].o ? 1:0,
  };
}
