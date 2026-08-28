// Один прогон негативного контроля мог просто попасть в шум. Проверяем это
// честно: строим датасет один раз, считаем реальную OOS AUC, а затем гоняем
// перемешивание меток N раз и смотрим на разброс — если реальная AUC не
// выделяется на фоне этого разброса, значит и "сигнал 0.51-0.52" был шумом.
import { buildDataset } from './dataset.mjs';
import { fitStandardizer, standardize, trainLogReg, predictProba, auc } from './logreg.mjs';

const SYMBOLS = ['BTC-USDT','ETH-USDT','SOL-USDT','BNB-USDT','XRP-USDT','DOGE-USDT',
  'ADA-USDT','AVAX-USDT','LINK-USDT','LTC-USDT','DOT-USDT','TRX-USDT','NEAR-USDT',
  'ATOM-USDT','UNI-USDT','ETC-USDT','FIL-USDT','APT-USDT','ARB-USDT','OP-USDT'];
const RISK=1.0, REWARD=1.5, HOLD=12;
const EMBARGO_MS = 4*(HOLD+1)*3600*1000;

console.log('Строю датасет (один раз)...');
const { X: Xall, y: yall, meta } = buildDataset(SYMBOLS, RISK, REWARD, HOLD);
const order = meta.map((_,i)=>i).sort((a,b)=>meta[a].t-meta[b].t);
const splitT = meta[order[Math.floor(order.length*0.7)]].t;
const trainIdx=[], testIdx=[];
for(const i of order){ if(meta[i].t<splitT-EMBARGO_MS) trainIdx.push(i); else if(meta[i].t>=splitT) testIdx.push(i); }
const Xtr=trainIdx.map(i=>Xall[i]), ytr=trainIdx.map(i=>yall[i]);
const Xte=testIdx.map(i=>Xall[i]), yte=testIdx.map(i=>yall[i]);
console.log('train:',Xtr.length,'test:',Xte.length);

const sc = fitStandardizer(Xtr);
const XtrS = standardize(Xtr, sc), XteS = standardize(Xte, sc);

const realModel = trainLogReg(XtrS, ytr, {l2:3, lr:0.3, iters:800});
const realAuc = auc(yte, predictProba(XteS, realModel));
console.log('\nРЕАЛЬНАЯ модель, OOS AUC:', realAuc.toFixed(4));

console.log('\nнегативный контроль — 10 независимых перемешиваний меток train:');
const shufAucs=[];
for(let k=0;k<10;k++){
  const yShuf = ytr.slice();
  for(let i=yShuf.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [yShuf[i],yShuf[j]]=[yShuf[j],yShuf[i]]; }
  const m = trainLogReg(XtrS, yShuf, {l2:3, lr:0.3, iters:800});
  const a = auc(yte, predictProba(XteS, m));
  shufAucs.push(a);
  console.log(`  прогон ${k+1}: AUC=${a.toFixed(4)}`);
}
const mean = shufAucs.reduce((s,v)=>s+v,0)/shufAucs.length;
const sd = Math.sqrt(shufAucs.reduce((s,v)=>s+(v-mean)**2,0)/shufAucs.length);
console.log(`\nшум: среднее=${mean.toFixed(4)}, ст.откл=${sd.toFixed(4)}, диапазон [${Math.min(...shufAucs).toFixed(4)}, ${Math.max(...shufAucs).toFixed(4)}]`);
console.log(`реальная модель: ${realAuc.toFixed(4)} — это ${((realAuc-mean)/sd).toFixed(2)} стандартных отклонений от шума`);
