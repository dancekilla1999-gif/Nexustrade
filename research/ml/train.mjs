// Обучение и честная проверка модели вероятности выигрыша.
//   node ml/train.mjs
//
// Дисциплина: никаких выводов по обучающим данным. Порог ищем и репортим
// только по OOS (тест — последние 30% времени), с embargo, чтобы barrier-
// разметка (заглядывающая на maxHold часов вперёд) не просачивалась через
// границу train/test. Плюс негативный контроль (перемешанные метки) —
// если он тоже "работает", значит пайплайн течёт, и всему верить нельзя.

import { buildDataset, FEATURE_NAMES } from './dataset.mjs';
import { fitStandardizer, standardize, trainLogReg, predictProba, auc } from './logreg.mjs';

const SYMBOLS = ['BTC-USDT','ETH-USDT','SOL-USDT','BNB-USDT','XRP-USDT','DOGE-USDT',
  'ADA-USDT','AVAX-USDT','LINK-USDT','LTC-USDT','DOT-USDT','TRX-USDT','NEAR-USDT',
  'ATOM-USDT','UNI-USDT','ETC-USDT','FIL-USDT','APT-USDT','ARB-USDT','OP-USDT'];

const RISK = 1.0, REWARD = 1.5, HOLD = 12;
const EMBARGO_MS = 4 * (HOLD + 1) * 3600 * 1000; // максимальный горизонт разметки в мс

console.log(`Барьер: risk=${RISK} reward=${REWARD} maxHold=${HOLD} (4h-бары)`);
console.log('Строю датасет...');
const { X: Xall, y: yall, meta } = buildDataset(SYMBOLS, RISK, REWARD, HOLD);
console.log('строк:', Xall.length);

// --- chronological split с embargo ---
const order = meta.map((_, i) => i).sort((a, b) => meta[a].t - meta[b].t);
const splitPos = Math.floor(order.length * 0.7);
const splitT = meta[order[splitPos]].t;

const trainIdx = [], testIdx = [];
for (const i of order) {
  if (meta[i].t < splitT - EMBARGO_MS) trainIdx.push(i);
  else if (meta[i].t >= splitT) testIdx.push(i);
  // между splitT-EMBARGO и splitT — выброшено (embargo zone)
}
console.log(`train: ${trainIdx.length}, embargo вырезан: ${order.length - trainIdx.length - testIdx.length}, test: ${testIdx.length}`);

const Xtr = trainIdx.map(i => Xall[i]), ytr = trainIdx.map(i => yall[i]);
const Xte = testIdx.map(i => Xall[i]), yte = testIdx.map(i => yall[i]);
const metaTe = testIdx.map(i => meta[i]);

console.log('win rate train:', (ytr.reduce((a,b)=>a+b,0)/ytr.length*100).toFixed(1)+'%');
console.log('win rate test :', (yte.reduce((a,b)=>a+b,0)/yte.length*100).toFixed(1)+'%');

// --- purged K-fold CV внутри train, чтобы выбрать L2 (по AUC) ---
function purgedFolds(idxSorted, tArr, k, embargoMs) {
  const n = idxSorted.length;
  const folds = [];
  for (let f = 0; f < k; f++) {
    const lo = Math.floor(n * f / k), hi = Math.floor(n * (f + 1) / k);
    const valSet = new Set(idxSorted.slice(lo, hi));
    const tLo = tArr[idxSorted[lo]], tHi = tArr[idxSorted[hi - 1]];
    const trainSet = [];
    for (const i of idxSorted) {
      if (valSet.has(i)) continue;
      const t = tArr[i];
      if (t >= tLo - embargoMs && t <= tHi + embargoMs) continue; // embargo вокруг вал-фолда
      trainSet.push(i);
    }
    folds.push({ train: trainSet, val: [...valSet] });
  }
  return folds;
}

const trainSortedByT = trainIdx.slice().sort((a, b) => meta[a].t - meta[b].t);
const tArrGlobal = meta.map(m => m.t);
const folds = purgedFolds(trainSortedByT, tArrGlobal, 5, EMBARGO_MS);

const l2grid = [0.3, 1, 3, 10, 30];
console.log('\nPurged 5-fold CV по train (подбор L2):');
let bestL2 = l2grid[0], bestAuc = -1;
for (const l2 of l2grid) {
  const aucs = [];
  for (const fold of folds) {
    if (fold.train.length < 200 || fold.val.length < 50) continue;
    const Xf = fold.train.map(i => Xall[i]), yf = fold.train.map(i => yall[i]);
    const Xv = fold.val.map(i => Xall[i]), yv = fold.val.map(i => yall[i]);
    const sc = fitStandardizer(Xf);
    const model = trainLogReg(standardize(Xf, sc), yf, { l2, lr: 0.3, iters: 300 });
    const p = predictProba(standardize(Xv, sc), model);
    aucs.push(auc(yv, p));
  }
  const m = aucs.reduce((a,b)=>a+b,0) / aucs.length;
  console.log(`  l2=${l2}: AUC=${m.toFixed(4)} (по ${aucs.length} фолдам)`);
  if (m > bestAuc) { bestAuc = m; bestL2 = l2; }
}
console.log('выбран l2 =', bestL2);

// --- финальная модель на всём purged train, оценка на OOS test ---
const sc = fitStandardizer(Xtr);
const model = trainLogReg(standardize(Xtr, sc), ytr, { l2: bestL2, lr: 0.3, iters: 800 });
const pTest = predictProba(standardize(Xte, sc), model);
console.log('\nOOS AUC (train->test):', auc(yte, pTest).toFixed(4));

function scanThresholds(probs, yArr, metaArr, label) {
  console.log(`\n--- скан порогов: ${label} ---`);
  console.log('порог | сделок | винрейт | avgR | сумма R | худшая просадка(R)');
  const rows = [];
  for (let thr = 0.30; thr <= 0.85; thr += 0.05) {
    const idxs = [];
    for (let i = 0; i < probs.length; i++) if (probs[i] >= thr) idxs.push(i);
    if (idxs.length < 15) continue;
    const wins = idxs.filter(i => yArr[i] === 1).length;
    const wr = wins / idxs.length;
    // считаем R в хронологическом порядке для честной просадки
    const sorted = idxs.slice().sort((a,b)=>metaArr[a].t - metaArr[b].t);
    let eq = 0, peak = 0, maxDD = 0, sumR = 0;
    for (const i of sorted) { const r = metaArr[i].r; sumR += r; eq += r; if (eq > peak) peak = eq; maxDD = Math.max(maxDD, peak - eq); }
    const avgR = sumR / idxs.length;
    rows.push({ thr: thr.toFixed(2), n: idxs.length, wr: (wr*100).toFixed(1), avgR: avgR.toFixed(3), sumR: sumR.toFixed(1), maxDD: maxDD.toFixed(1) });
  }
  for (const r of rows) console.log(`${r.thr}  |  ${String(r.n).padStart(5)} |  ${r.wr}%  | ${r.avgR} | ${r.sumR} | ${r.maxDD}`);
  return rows;
}

const realRows = scanThresholds(pTest, yte, metaTe, 'РЕАЛЬНАЯ модель, OOS test');

// --- негативный контроль: перемешанные метки в train ---
console.log('\n=== негативный контроль (метки в train перемешаны) ===');
const yShuf = ytr.slice();
for (let i = yShuf.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [yShuf[i], yShuf[j]] = [yShuf[j], yShuf[i]]; }
const modelShuf = trainLogReg(standardize(Xtr, sc), yShuf, { l2: bestL2, lr: 0.3, iters: 800 });
const pTestShuf = predictProba(standardize(Xte, sc), modelShuf);
console.log('AUC на настоящих test-метках (модель, обученная на шуме):', auc(yte, pTestShuf).toFixed(4), '(ожидание: ~0.50)');
scanThresholds(pTestShuf, yte, metaTe, 'КОНТРОЛЬ (шум), OOS test');

console.log('\n=== веса модели (после стандартизации) ===');
FEATURE_NAMES.forEach((n, j) => console.log(`  ${n.padEnd(14)} ${model.w[j].toFixed(4)}`));
console.log('  bias', model.b.toFixed(4));

console.log('\n=== для переноса в клиент (сырые признаки -> вероятность) ===');
console.log('mean:', JSON.stringify(sc.mean));
console.log('std :', JSON.stringify(sc.std));
console.log('w   :', JSON.stringify(model.w));
console.log('b   :', model.b);
