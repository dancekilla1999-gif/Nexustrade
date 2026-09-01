// Юнит-тесты MIE. Гоняют РОВНО тот файл mie.js, что идёт в прод.
// Запуск: node research/ml/mie.test.mjs
import fs from 'fs';
import path from 'path';

const src = fs.readFileSync(path.join(process.cwd(), 'mie.js'), 'utf8');
const mod = { exports: {} };
new Function('module', 'globalThis', src)(mod, globalThis);
const MIE = mod.exports;

let pass = 0, fail = 0;
const fails = [];
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; fails.push(name + ' -> ' + e.message); console.log('  FAIL ' + name + ' -> ' + e.message); }
}
function eq(a, b, msg) { if (a !== b) throw new Error((msg || '') + ' ожидалось ' + b + ', получено ' + a); }
function near(a, b, tol, msg) { if (!(Math.abs(a - b) <= tol)) throw new Error((msg || '') + ' ожидалось ~' + b + ' (±' + tol + '), получено ' + a); }
function ok(c, msg) { if (!c) throw new Error(msg || 'ожидалось true'); }

/* --- генераторы синтетических серий (для проверки поведения, не прибыльности) --- */
function mk(closes, volBase = 100) {
  return closes.map((c, i) => {
    const prev = i ? closes[i - 1] : c;
    return { t: 1700000000000 + i * 4 * 3600e3, o: prev, h: Math.max(prev, c) * 1.002, l: Math.min(prev, c) * 0.998, c, v: volBase };
  });
}
const ramp = (n, from, to) => Array.from({ length: n }, (_, i) => from + (to - from) * i / (n - 1));
const flat = (n, v, amp = 0) => Array.from({ length: n }, (_, i) => v + amp * Math.sin(i / 3));
/** Детерминированный ГПСЧ — чтобы тесты не «мигали» от запуска к запуску. */
function lcg(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
/** Блуждание без дрейфа — ЭТО и есть боковик. Ровная синусоида боковиком не является:
 *  у неё полуцикл — идеально гладкое направленное движение, и ADX там законно высок. */
function walk(n, v, step, seed = 42) {
  const rnd = lcg(seed); const out = [v];
  for (let i = 1; i < n; i++) out.push(Math.max(1, out[i - 1] + (rnd() - 0.5) * 2 * step));
  return out;
}

const I = MIE.indicators;

console.log('\n--- 1. Индикаторы: сверка с ручным расчётом ---');
t('SMA(3) считает среднее последних трёх', () => {
  const k = mk([1, 2, 3, 4, 5]);
  const s = I.smaArr(k.map(x => x.c), 3);
  near(s[4], 4, 1e-9);
  near(s[2], 2, 1e-9);
  eq(s[1], null, 'до прогрева должно быть null:');
});
t('EMA(3) совпадает с рекуррентной формулой', () => {
  const v = [1, 2, 3, 4, 5];
  const e = I.emaArr(v, 3);
  const kf = 2 / 4;
  let expect = (1 + 2 + 3) / 3;                       // seed = SMA
  expect = 4 * kf + expect * (1 - kf);
  expect = 5 * kf + expect * (1 - kf);
  near(e[4], expect, 1e-9);
});
// rsiArr/bbArr/macdArr принимают массив ЦЕН, adxArr/atrArr — массив СВЕЧЕЙ.
const closes = (k) => k.map(x => x.c);
t('RSI = 100 при монотонном росте, 0 при монотонном падении', () => {
  const up = I.rsiArr(closes(mk(ramp(60, 100, 200))), 14);
  const dn = I.rsiArr(closes(mk(ramp(60, 200, 100))), 14);
  near(up[59], 100, 0.5);
  near(dn[59], 0, 0.5);
});
t('ATR положителен и растёт вместе с диапазоном', () => {
  const calm = I.atrArr(mk(flat(60, 100, 0.2)), 14);
  const wild = I.atrArr(mk(flat(60, 100, 8)), 14);
  ok(calm[59] > 0, 'ATR спокойного рынка > 0');
  ok(wild[59] > calm[59] * 3, 'ATR волатильного рынка должен быть заметно выше');
});
t('ADX высок в тренде и низок в боковике', () => {
  const trend = I.adxArr(mk(ramp(120, 100, 300)), 14).adx;
  const chop = I.adxArr(mk(walk(120, 100, 1.5)), 14).adx;
  ok(trend[119] > 40, 'ADX в тренде должен быть высоким, получено ' + trend[119]);
  ok(chop[119] < 30, 'ADX в боковике должен быть низким, получено ' + chop[119]);
});
t('ADX: +DI доминирует в росте, -DI в падении', () => {
  const up = I.adxArr(mk(ramp(120, 100, 300)), 14);
  const dn = I.adxArr(mk(ramp(120, 300, 100)), 14);
  ok(up.pdi[119] > up.mdi[119], '+DI должен быть выше в росте');
  ok(dn.mdi[119] > dn.pdi[119], '-DI должен быть выше в падении');
});
t('Bollinger: цена внутри полос, ширина > 0', () => {
  const bb = I.bbArr(closes(mk(flat(60, 100, 3))), 20, 2);
  ok(bb.up[59] > bb.mid[59] && bb.mid[59] > bb.lo[59], 'порядок полос');
  ok(bb.width[59] > 0, 'ширина > 0');
});

console.log('\n--- 2. Причинность: будущее не влияет на прошлое ---');
t('analyze() на срезе даёт тот же результат, что на срезе из длинного ряда', () => {
  const long = mk([...ramp(400, 100, 180), ...ramp(200, 180, 120)]);
  const cut = 420;
  const a = MIE.analyze({ symbol: 'T', primaryTf: '4h', candles: { '4h': long.slice(0, cut) }, now: long[cut - 1].t });
  const b = MIE.analyze({ symbol: 'T', primaryTf: '4h', candles: { '4h': long.slice(0, cut).map(x => ({ ...x })) }, now: long[cut - 1].t });
  eq(a.direction, b.direction, 'направление:');
  eq(a.confidence, b.confidence, 'confidence:');
  eq(a.decision, b.decision, 'решение:');
  eq(a.regime, b.regime, 'режим:');
});
t('дописывание будущих свечей НЕ меняет решение на прошлом баре', () => {
  const base = mk([...ramp(400, 100, 180), ...ramp(60, 180, 175)]);
  const cut = 430;
  const now = base[cut - 1].t;
  const before = MIE.analyze({ symbol: 'T', primaryTf: '4h', candles: { '4h': base.slice(0, cut) }, now });
  // тот же срез, но исходный массив продолжен резким обвалом
  const extended = mk([...ramp(400, 100, 180), ...ramp(60, 180, 175), ...ramp(80, 175, 60)]);
  const after = MIE.analyze({ symbol: 'T', primaryTf: '4h', candles: { '4h': extended.slice(0, cut) }, now });
  eq(after.direction, before.direction, 'направление не должно зависеть от будущего:');
  eq(after.confidence, before.confidence, 'confidence не должен зависеть от будущего:');
});
t('индикатор на позиции i не меняется при дописывании данных справа', () => {
  const a = mk(ramp(100, 100, 200));
  const b = mk([...ramp(100, 100, 200), ...ramp(50, 200, 50)]);
  const ra = I.rsiArr(a, 14), rb = I.rsiArr(b, 14);
  for (let i = 20; i < 100; i++) near(ra[i], rb[i], 1e-9, 'RSI[' + i + ']');
});

console.log('\n--- 3. Никакой отдельный индикатор не выдаёт сигнал сам ---');
t('перепроданный RSI в нисходящем тренде НЕ даёт LONG-решение', () => {
  const k = mk(ramp(400, 300, 100));                     // безоткатное падение -> RSI ~0
  const r = MIE.analyze({ symbol: 'T', primaryTf: '4h', candles: { '4h': k } });
  const rsi = I.rsiArr(closes(k), 14);
  ok(rsi[rsi.length - 1] < 15, 'предусловие: RSI должен быть перепродан, он = ' + rsi[rsi.length - 1]);
  ok(!(r.decision === 'TRADE' && r.direction === 'LONG'), 'движок не должен покупать только из-за RSI<30');
});
t('группы возвращают счёт в [-1..1] и не ломаются', () => {
  const k = mk([...ramp(300, 100, 200), ...flat(120, 200, 4)]);
  const r = MIE.analyze({ symbol: 'T', primaryTf: '4h', candles: { '4h': k } });
  Object.entries(r.analysis.groups).forEach(([name, g]) => {
    ok(typeof g.score === 'number' && isFinite(g.score), name + ': score должен быть числом');
    ok(g.score >= -1.0001 && g.score <= 1.0001, name + ': score вне [-1..1] = ' + g.score);
  });
});

console.log('\n--- 4. NO-TRADE как полноценный исход ---');
t('слишком короткая история -> NO_TRADE с явной причиной', () => {
  const r = MIE.analyze({ symbol: 'T', primaryTf: '4h', candles: { '4h': mk(ramp(50, 100, 110)) } });
  eq(r.decision, 'NO_TRADE');
  eq(r.ok, false);
  ok(r.blockers.some(b => /недостаточно истории/.test(b)), 'должна быть причина про историю, есть: ' + r.blockers.join('|'));
});
t('пустой вход не роняет движок', () => {
  const r = MIE.analyze({});
  eq(r.decision, 'NO_TRADE');
  ok(Array.isArray(r.blockers) && r.blockers.length > 0);
});
t('синтетические данные блокируют сделку', () => {
  const k = mk([...ramp(300, 100, 200), ...flat(150, 200, 3)]);
  const r = MIE.analyze({ symbol: 'T', primaryTf: '4h', candles: { '4h': k }, dataQuality: { synthetic: true } });
  eq(r.decision, 'NO_TRADE');
  ok(r.blockers.some(b => /синтетические/.test(b)), 'должна быть причина про синтетику');
});
t('каждый блокер — непустая строка-объяснение', () => {
  const k = mk(flat(450, 100, 1.5));
  const r = MIE.analyze({ symbol: 'T', primaryTf: '4h', candles: { '4h': k } });
  r.blockers.forEach(b => ok(typeof b === 'string' && b.length > 8, 'пустой блокер: ' + JSON.stringify(b)));
});

console.log('\n--- 5. Ликвидность: без данных — честный отказ, не выдумка ---');
t('нет стакана -> available:false и никаких чисел спреда', () => {
  const k = mk(ramp(400, 100, 200));
  const r = MIE.analyze({ symbol: 'T', primaryTf: '4h', candles: { '4h': k } });
  eq(r.analysis.liquidity.available, false);
  eq(r.analysis.liquidity.spreadPct, null);
  ok(r.risks.some(x => /стакан/.test(x)) || r.analysis.liquidity.note, 'должно быть отмечено отсутствие данных');
});
t('со стаканом -> available:true и спред посчитан', () => {
  const k = mk(ramp(400, 100, 200));
  const r = MIE.analyze({
    symbol: 'T', primaryTf: '4h', candles: { '4h': k },
    orderbook: { bestBid: 199.5, bestAsk: 200.5, bidVol: 1000, askVol: 900 },
  });
  eq(r.analysis.liquidity.available, true);
  ok(r.analysis.liquidity.spreadPct > 0, 'спред должен быть посчитан');
  ok(r.analysis.liquidity.imbalance > 0, 'перевес бидов должен дать положительный imbalance');
});

console.log('\n--- 6. Сделка: стоп, цель, RR ---');
t('если сделка разрешена, RR >= порога и в диапазоне 1:1.6..1:10', () => {
  const k = mk([...ramp(300, 100, 220), ...flat(160, 220, 5)]);
  const r = MIE.analyze({ symbol: 'T', primaryTf: '4h', candles: { '4h': k } });
  if (r.decision === 'TRADE') {
    ok(r.rr >= MIE.DEFAULT_THRESHOLDS.minRR, 'RR ниже порога: ' + r.rr);
    ok(r.rr <= 10.001, 'RR выше потолка 1:10: ' + r.rr);
  }
});
t('цель никогда не берётся ближе стопа при разрешённой сделке', () => {
  const k = mk([...ramp(300, 100, 220), ...flat(160, 220, 5)]);
  const r = MIE.analyze({ symbol: 'T', primaryTf: '4h', candles: { '4h': k } });
  if (r.recommended_entry && r.stop_loss && r.take_profit.length) {
    const R = Math.abs(r.recommended_entry - r.stop_loss);
    const tp3 = r.take_profit[2].p;
    ok(Math.abs(tp3 - r.recommended_entry) > 0, 'цель не может совпадать со входом');
    if (r.decision === 'TRADE') ok(Math.abs(tp3 - r.recommended_entry) >= R * MIE.DEFAULT_THRESHOLDS.minRR - 1e-9, 'цель ближе minRR');
  }
});
t('стоп стоит по нужную сторону от входа', () => {
  const k = mk([...ramp(300, 100, 220), ...flat(160, 220, 5)]);
  const r = MIE.analyze({ symbol: 'T', primaryTf: '4h', candles: { '4h': k } });
  if (r.direction === 'LONG' && r.stop_loss) ok(r.stop_loss < r.recommended_entry, 'LONG: стоп должен быть ниже входа');
  if (r.direction === 'SHORT' && r.stop_loss) ok(r.stop_loss > r.recommended_entry, 'SHORT: стоп должен быть выше входа');
});
t('риск на сделку в пределах [minRiskPct, maxRiskPct]', () => {
  const k = mk([...ramp(300, 100, 220), ...flat(160, 220, 5)]);
  const r = MIE.analyze({ symbol: 'T', primaryTf: '4h', candles: { '4h': k } });
  if (r.stop_loss) {
    const riskPct = Math.abs(r.recommended_entry - r.stop_loss) / r.recommended_entry * 100;
    ok(riskPct >= MIE.DEFAULT_THRESHOLDS.minRiskPct, 'риск ниже минимума: ' + riskPct);
    ok(riskPct <= MIE.DEFAULT_THRESHOLDS.maxRiskPct, 'риск выше максимума: ' + riskPct);
  }
});

console.log('\n--- 7. Риск-менеджмент ---');
t('размер позиции считается ОТ расстояния до стопа, а не от плеча', () => {
  const a = MIE.risk.positionSize({ balance: 10000, riskPct: 1, entry: 100, sl: 99, maxLev: 20, freeMargin: 10000 });
  const b = MIE.risk.positionSize({ balance: 10000, riskPct: 1, entry: 100, sl: 98, maxLev: 20, freeMargin: 10000 });
  ok(a.ok && b.ok, 'оба размера должны быть валидны');
  near(a.riskMoney, 100, 1, 'риск 1% от 10000');
  near(b.riskMoney, 100, 1, 'риск 1% от 10000');
  ok(b.qty < a.qty * 0.6, 'вдвое дальний стоп -> примерно вдвое меньший объём');
});
t('риск режется вдвое при экстремальной волатильности', () => {
  const normal = MIE.risk.positionSize({ balance: 10000, riskPct: 1, entry: 100, sl: 98, maxLev: 20, freeMargin: 10000, volPercentile: 0.5 });
  const wild = MIE.risk.positionSize({ balance: 10000, riskPct: 1, entry: 100, sl: 98, maxLev: 20, freeMargin: 10000, volPercentile: 0.95 });
  ok(wild.riskMoney < normal.riskMoney, 'при высокой волатильности риск должен быть меньше');
});
t('нулевое расстояние до стопа -> отказ, а не деление на ноль', () => {
  const r = MIE.risk.positionSize({ balance: 10000, riskPct: 1, entry: 100, sl: 100, maxLev: 20, freeMargin: 10000 });
  eq(r.ok, false);
  ok(typeof r.reason === 'string' && r.reason.length > 0);
});
t('нет мартингейла: размер не растёт после убытков', () => {
  const s = MIE.risk.positionSize({ balance: 9000, riskPct: 1, entry: 100, sl: 98, maxLev: 20, freeMargin: 9000 });
  const s0 = MIE.risk.positionSize({ balance: 10000, riskPct: 1, entry: 100, sl: 98, maxLev: 20, freeMargin: 10000 });
  ok(s.riskMoney < s0.riskMoney, 'после просадки баланса риск в деньгах обязан УМЕНЬШИТЬСЯ');
});
t('дневной стоп-лосс блокирует новые входы (dailyLossPct — без знака)', () => {
  const p = MIE.risk.portfolioRisk({ direction: 'LONG', openPositions: [], balance: 10000, dailyLossPct: 5, dailyStopPct: 4 });
  ok(p.blockers.some(b => /дневной стоп/.test(b)), 'должен быть блокер по дневному лимиту, есть: ' + p.blockers.join('|'));
});
t('дневной стоп понимает знаковый dailyPnlPct', () => {
  const hit = MIE.risk.portfolioRisk({ direction: 'LONG', openPositions: [], balance: 10000, dailyPnlPct: -5, dailyStopPct: 4 });
  ok(hit.blockers.some(b => /дневной стоп/.test(b)), 'минус 5% при лимите 4% обязан блокировать');
  const profit = MIE.risk.portfolioRisk({ direction: 'LONG', openPositions: [], balance: 10000, dailyPnlPct: 5, dailyStopPct: 4 });
  ok(!profit.blockers.some(b => /дневной стоп/.test(b)), 'прибыльный день не должен блокировать');
});
t('максимальная просадка блокирует независимо от знака', () => {
  const a = MIE.risk.portfolioRisk({ direction: 'LONG', openPositions: [], balance: 10000, drawdownPct: -12, maxDrawdownPct: 10 });
  const b = MIE.risk.portfolioRisk({ direction: 'LONG', openPositions: [], balance: 10000, drawdownPct: 12, maxDrawdownPct: 10 });
  ok(a.blockers.some(x => /просадка/.test(x)), 'отрицательная запись просадки должна блокировать');
  ok(b.blockers.some(x => /просадка/.test(x)), 'положительная запись просадки должна блокировать');
});
t('лимит на число позиций в одну сторону работает', () => {
  const open = [{ side: 'LONG', symbol: 'A' }, { side: 'LONG', symbol: 'B' }];
  const p = MIE.risk.portfolioRisk({ direction: 'LONG', openPositions: open, balance: 10000, maxSameSide: 2 });
  ok(p.blockers.length > 0, 'третий LONG при лимите 2 должен блокироваться');
});

console.log('\n--- 8. Confidence: полосы и семантика ---');
t('полосы confidence монотонны и покрывают 0..100', () => {
  let prevIdx = -1;
  const order = ['NO_TRADE', 'WEAK', 'WATCH', 'VALID_SETUP', 'STRONG_SETUP', 'EXTREME_CONFLUENCE'];
  for (let c = 0; c <= 100; c += 1) {
    const b = MIE.confidenceBand(c);
    const idx = order.indexOf(b.band);
    ok(idx >= 0, 'неизвестная полоса ' + b.band + ' при c=' + c);
    ok(idx >= prevIdx, 'полосы должны расти монотонно, при c=' + c);
    prevIdx = idx;
  }
  eq(MIE.confidenceBand(0).band, 'NO_TRADE');
  eq(MIE.confidenceBand(100).band, 'EXTREME_CONFLUENCE');
});
t('confidence ниже порога -> сделка не разрешена', () => {
  const k = mk(flat(450, 100, 1.2));
  const r = MIE.analyze({ symbol: 'T', primaryTf: '4h', candles: { '4h': k } });
  if (r.confidence < MIE.DEFAULT_THRESHOLDS.minConfidence) eq(r.decision, 'NO_TRADE');
});

console.log('\n--- 9. Управление позицией ---');
t('после 1R — частичная фиксация и стоп в безубыток', () => {
  const k = mk(ramp(300, 100, 200));
  const ctx = { k };
  const acts = MIE.managePosition({ side: 'LONG', entry: 190, sl: 185, qty: 1 }, ctx);
  ok(acts.some(a => a.type === 'PARTIAL_CLOSE'), 'ожидалась частичная фиксация');
  ok(acts.some(a => a.type === 'MOVE_SL' && a.to === 190), 'ожидался перевод стопа в безубыток');
});
t('стоп двигается только в сторону прибыли', () => {
  const k = mk(ramp(300, 100, 200));
  const acts = MIE.managePosition({ side: 'LONG', entry: 150, sl: 149, qty: 1, partialDone: true, breakevenDone: true }, { k });
  acts.filter(a => a.type === 'MOVE_SL').forEach(a => ok(a.to > 149, 'стоп LONG нельзя двигать вниз: ' + a.to));
});
t('без движения цены — никаких действий', () => {
  const k = mk(flat(300, 100, 0.5));
  const price = k[k.length - 1].c;
  const acts = MIE.managePosition({ side: 'LONG', entry: price, sl: price * 0.97, qty: 1 }, { k });
  eq(acts.length, 0, 'на нулевой прибыли действий быть не должно');
});

console.log('\n--- 10. Контракт вывода ---');
t('analyze() всегда возвращает полный набор полей', () => {
  const k = mk(ramp(400, 100, 200));
  const r = MIE.analyze({ symbol: 'T', primaryTf: '4h', candles: { '4h': k } });
  ['version', 'symbol', 'tf', 'ok', 'direction', 'confidence', 'band', 'entry_quality', 'regime',
    'decision', 'reasons', 'risks', 'blockers', 'recommended_entry', 'stop_loss', 'take_profit',
    'invalidation', 'rr', 'position_size', 'setup', 'analysis', 'ms'].forEach(f => {
      ok(f in r, 'нет поля ' + f);
    });
  ok(['TRADE', 'NO_TRADE'].includes(r.decision), 'решение должно быть TRADE или NO_TRADE');
});
t('confidence — целое 0..100', () => {
  const k = mk(ramp(400, 100, 200));
  const r = MIE.analyze({ symbol: 'T', primaryTf: '4h', candles: { '4h': k } });
  ok(Number.isInteger(r.confidence) && r.confidence >= 0 && r.confidence <= 100, 'confidence = ' + r.confidence);
});
t('решение TRADE всегда сопровождается входом, стопом и целью', () => {
  const k = mk([...ramp(300, 100, 220), ...flat(160, 220, 5)]);
  const r = MIE.analyze({ symbol: 'T', primaryTf: '4h', candles: { '4h': k } });
  if (r.decision === 'TRADE') {
    ok(r.recommended_entry > 0 && r.stop_loss > 0, 'вход и стоп обязаны быть заданы');
    ok(r.take_profit.length >= 1, 'должна быть хотя бы одна цель');
    ok(r.reasons.length > 0, 'сделка без объяснения причин недопустима');
  }
});

console.log('\n=========================================');
console.log('пройдено: ' + pass + ', провалено: ' + fail);
if (fail) { console.log('\nПРОВАЛЫ:'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
