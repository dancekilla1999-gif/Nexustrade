// Скан множителя раздвижения стопа + честная train/test проверка.
//   node scan_widen.mjs
// См. research/HIGH_WINRATE_MODE.md — методология и выводы.
import { backtest } from './run_widen.mjs';

const SYMS=['BTC-USDT','ETH-USDT','SOL-USDT','BNB-USDT','XRP-USDT','DOGE-USDT',
  'ADA-USDT','AVAX-USDT','LINK-USDT','LTC-USDT','DOT-USDT','TRX-USDT','NEAR-USDT',
  'ATOM-USDT','UNI-USDT','ETC-USDT','FIL-USDT','APT-USDT','ARB-USDT','OP-USDT'];
const base = { minStrength:70, minRR:2.0, cooldownBars:0 };

console.log('=== скан по полной истории (20 пар) ===');
console.log('mult | сделок | зависших | винрейт | avgR | сумма R | PF | просадка(R)');
for(const mult of [1.0, 2.0, 4.0, 6.0, 8.0, 10.0, 15.0, 20.0, 30.0]){
  const r = backtest({...base, slWidenMult:mult}, SYMS, 0, 1);
  console.log(`${mult.toFixed(1)}  |  ${String(r.n).padStart(5)} | ${String(r.openAtEnd).padStart(3)} | ${r.winRate.toFixed(1)}%  | ${r.avgR.toFixed(3)} | ${r.totalR.toFixed(1)} | ${r.pf.toFixed(2)} | ${r.maxDDr.toFixed(1)}`);
}

console.log('\n=== train (первые 70%) / test (последние 30%) — без утечки ===');
console.log('mult | TRAIN n/винрейт/avgR/PF   |   TEST n/винрейт/avgR/PF');
for(const mult of [6,8,10,12,15,20]){
  const tr = backtest({...base, slWidenMult:mult}, SYMS, 0, 0.7);
  const te = backtest({...base, slWidenMult:mult}, SYMS, 0.7, 1.0);
  console.log(`${mult}  |  ${tr.n}/${tr.winRate.toFixed(1)}%/${tr.avgR.toFixed(3)}/${tr.pf.toFixed(2)}   |   ${te.n}/${te.winRate.toFixed(1)}%/${te.avgR.toFixed(3)}/${te.pf.toFixed(2)}`);
}
