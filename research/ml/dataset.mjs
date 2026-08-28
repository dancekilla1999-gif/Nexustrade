// Строит обучающую выборку: признаки (в системе координат "в пользу сделки")
// + метка тройного барьера + вспомогательные поля для честной проверки
// (символ, время, издержки) — нужны для purged K-fold и walk-forward.
import fs from 'fs';
import { to4h, featuresAt } from './features.mjs';

const FEE=0.0006, SLIP=0.0004; // тейкер обе стороны + проскальзывание, как в прошлом прогоне

/** Направление тренда на баре i — по EMA21 vs EMA50 из уже посчитанных признаков. */
function biasOf(raw){ return raw.ema21vs50 >= 0 ? 'LONG' : 'SHORT'; }

/** Разворачивает признаки в систему координат "за сделку в этом направлении". */
function canon(raw, dir){
  const s = dir==='LONG' ? 1 : -1;
  return {
    distEma21: raw.distEma21*s, distEma50: raw.distEma50*s, distEma200: raw.distEma200*s,
    ema21vs50: raw.ema21vs50*s, ema21slope: raw.ema21slope*s, ema50slope: raw.ema50slope*s,
    rsiFav: dir==='LONG' ? raw.rsi-50 : 50-raw.rsi,
    rsiSlope: raw.rsiSlope*s,
    macdHist: raw.macdHist*s, macdHistSlope: raw.macdHistSlope*s,
    stochFav: dir==='LONG' ? raw.stochK-50 : 50-raw.stochK,
    stochDFav: dir==='LONG' ? raw.stochD-50 : 50-raw.stochD,
    bbPosFav: dir==='LONG' ? raw.bbPos : 1-raw.bbPos,
    bbWidth: raw.bbWidth, atrPct: raw.atrPct, volRatio: raw.volRatio,
    ret1: raw.ret1*s, ret3: raw.ret3*s, ret6: raw.ret6*s,
    breakoutFav: dir==='LONG' ? raw.hh6 : raw.ll6,
    breakAgainst: dir==='LONG' ? raw.ll6 : raw.hh6,
    bodyFav: dir==='LONG' ? raw.bodyUp : (1-raw.bodyUp),
  };
}

export const FEATURE_NAMES = ['distEma21','distEma50','distEma200','ema21vs50','ema21slope','ema50slope',
  'rsiFav','rsiSlope','macdHist','macdHistSlope','stochFav','stochDFav','bbPosFav','bbWidth','atrPct',
  'volRatio','ret1','ret3','ret6','breakoutFav','breakAgainst','bodyFav'];

/**
 * Метка тройного барьера. entry = открытие следующего бара. Симметричный барьер
 * в единицах ATR% на момент сигнала. Таймаут (ни одна сторона не задета за
 * maxHoldBars) размечается как проигрыш — пессимистично, без начисления
 * кредита за движение, которое ещё могло развернуться.
 */
function tripleBarrier(h4, h1, i, dir, riskMult, rewardMult, maxHoldBars){
  const atrPct = h4._atr[i];
  const nxt = h4[i+1]; if(!nxt) return null;
  const entry = nxt.o;
  const rr = riskMult*atrPct/100, rw = rewardMult*atrPct/100;
  const s = dir==='LONG'?1:-1;
  const sl = entry*(1-s*rr), tp = entry*(1+s*rw);
  const startIdx = h4[i+1].i1;
  const endIdx = Math.min(h1.length, startIdx + 4*(maxHoldBars+1));
  for(let j=startIdx;j<endIdx;j++){
    const b=h1[j];
    const hitSL = dir==='LONG' ? b.l<=sl : b.h>=sl;
    const hitTP = dir==='LONG' ? b.h>=tp : b.l<=tp;
    if(hitSL||hitTP){
      const win = hitSL ? 0 : 1;              // пессимистично при обоих сразу
      const px = hitSL ? sl : tp;
      const gross = (px-entry)/entry*s;
      const net = gross - FEE*2 - SLIP*2;
      const rUnit = Math.abs(entry-sl)/entry;
      return { win: net>0?1:0, r: net/rUnit, riskMult, rewardMult };
    }
  }
  // таймаут — пессимистично
  const rUnit = Math.abs(entry-sl)/entry;
  const lastPx = h1[Math.min(endIdx-1,h1.length-1)].c;
  const gross=(lastPx-entry)/entry*s, net=gross-FEE*2-SLIP*2;
  return { win: 0, r: net/rUnit, riskMult, rewardMult, timeout:true };
}

/** Собирает датасет по всем символам для заданного барьера R:R. */
export function buildDataset(symbols, riskMult, rewardMult, maxHoldBars){
  const X=[], y=[], meta=[];
  for(const sym of symbols){
    const h1=JSON.parse(fs.readFileSync(`/tmp/bt/${sym}.json`,'utf8'));
    const h4=to4h(h1);
    h4._atr = h4.map((_,i)=>{ const f=featuresAt(h4,i); return f?f.atrPct:null; });
    for(let i=210;i<h4.length-1;i++){
      const raw=featuresAt(h4,i); if(!raw) continue;
      if(!(h4._atr[i]>0.05)) continue;         // почти нулевая волатильность — барьер бессмысленен
      const dir=biasOf(raw);
      const feat=canon(raw,dir);
      const lbl=tripleBarrier(h4,h1,i,dir,riskMult,rewardMult,maxHoldBars);
      if(!lbl) continue;
      X.push(FEATURE_NAMES.map(k=>feat[k]));
      y.push(lbl.win);
      meta.push({ sym, t:h4[i].t, r:lbl.r, timeout:!!lbl.timeout });
    }
  }
  return { X, y, meta };
}
