// Честный бэктест MIE.
//
// Дисциплина этого файла:
//   1) Гоняется РОВНО тот mie.js, что идёт в прод. Логика сигнала здесь не
//      переписывается — иначе проверялось бы не то, что работает у пользователя.
//   2) Никакого заглядывания в будущее: сигнал считается по закрытию бара i,
//      вход — по открытию бара i+1.
//   3) Комиссия и проскальзывание включены. Бэктест без издержек — реклама.
//   4) Если бар задел и стоп, и тейк — считаем СТОП. Всегда в худшую сторону.
//   5) Сделки, не закрывшиеся к концу данных, закрываются по последней цене,
//      а не выбрасываются. Выброшенные «ещё не закрытые» сделки — классический
//      способ нарисовать себе винрейт.
//   6) Есть негативный контроль: случайные входы с той же статистикой стопов
//      и целей. Если движок не бьёт случайность — значит edge нет, и это
//      надо сказать прямо.
import fs from 'fs';
import path from 'path';

const src = fs.readFileSync(path.join(process.cwd(), 'mie.js'), 'utf8');
const mod = { exports: {} };
new Function('module', 'globalThis', src)(mod, globalThis);
const MIE = mod.exports;

const DATA = '/tmp/bt';
const FEE = 0.0005;        // тейкер 0.05% с каждой стороны
const SLIP = 0.0002;       // проскальзывание 0.02%
const RISK_PCT = 1;        // риск на сделку, % от капитала
const START_EQ = 10000;

// Режимы:
//   (по умолчанию) engine   — сигналы движка как есть
//   --random                — случайные входы со своей геометрией стопа
//   --invert                — ТА ЖЕ точка входа и ТО ЖЕ расстояние стопа, но
//                             направление перевёрнуто. Если движок системно
//                             ошибается в направлении, инверсия обязана
//                             зарабатывать (за вычетом издержек).
//   --randside              — та же точка и геометрия, направление случайно.
//                             Изолирует вклад ИМЕННО выбора направления.
const argv = process.argv.slice(2);
const MODE = argv.includes('--random') ? 'random'
  : argv.includes('--invert') ? 'invert'
    : argv.includes('--randside') ? 'randside' : 'engine';
const SEED = Number((argv.find(a => a.startsWith('--seed=')) || '--seed=1').split('=')[1]);
function lcg(s) { let x = (s >>> 0) || 1; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296); }
const rnd = lcg(SEED);

function agg(k1h, hours) {
  const out = [];
  for (let i = 0; i + hours <= k1h.length; i += hours) {
    const s = k1h.slice(i, i + hours);
    out.push({
      t: s[0].t, o: s[0].o, h: Math.max(...s.map(x => x.h)),
      l: Math.min(...s.map(x => x.l)), c: s[s.length - 1].c, v: s.reduce((a, x) => a + x.v, 0),
    });
  }
  return out;
}

const files = fs.readdirSync(DATA).filter(f => f.endsWith('-USDT.json')).sort();
const trades = [];

for (const f of files) {
  const sym = f.replace('.json', '');
  const k1h = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
  const k4 = agg(k1h, 4);
  const kd = agg(k1h, 24);

  let open = null;
  for (let i = 260; i < k4.length - 1; i++) {
    const tNow = k4[i].t + 4 * 3600e3;

    /* --- управление уже открытой позицией: бар за баром --- */
    if (open) {
      const bar = k4[i];
      const isLong = open.side === 'LONG';
      // MAE/MFE в R
      const adverse = isLong ? (open.entry - bar.l) / open.R : (bar.h - open.entry) / open.R;
      const favor = isLong ? (bar.h - open.entry) / open.R : (open.entry - bar.l) / open.R;
      open.mae = Math.max(open.mae, adverse);
      open.mfe = Math.max(open.mfe, favor);

      const hitSL = isLong ? bar.l <= open.sl : bar.h >= open.sl;
      // Пессимистично: если бар задел стоп — считаем стоп, даже если он же задел тейк.
      if (hitSL) {
        closeTrade(open, open.sl, k4[i].t, 'SL', i);
        open = null;
      } else {
        // частичные фиксации по достигнутым целям
        for (const tp of open.tps) {
          if (tp.done) continue;
          const hit = isLong ? bar.h >= tp.p : bar.l <= tp.p;
          if (hit) {
            tp.done = true;
            open.realized += tp.part * rMult(open, tp.p);
            open.closedPart += tp.part;
            if (tp.label.startsWith('TP1')) open.sl = open.entry;   // безубыток после 1R
          }
        }
        if (open.closedPart >= 0.999) { finish(open, 'TP', k4[i].t, i); open = null; }
        else {
          // трейлинг после 2R — правило из managePosition()
          const profitR = rMult(open, bar.c);
          if (profitR >= 2) {
            const atr = atrOf(k4, i);
            const trail = isLong ? bar.c - atr * 1.5 : bar.c + atr * 1.5;
            if (isLong ? trail > open.sl : trail < open.sl) open.sl = trail;
          }
        }
      }
    }

    if (open) continue;

    /* --- поиск нового входа --- */
    let want = null;
    if (MODE !== 'random') {
      const r = MIE.analyze({
        symbol: sym, primaryTf: '4h', now: tNow,
        candles: { '4h': k4.slice(0, i + 1), '1d': kd.filter(b => b.t + 24 * 3600e3 <= tNow) },
        account: { balance: START_EQ, riskPct: RISK_PCT, maxLev: 20, freeMargin: START_EQ, openPositions: [] },
      });
      if (r.decision === 'TRADE') {
        if (MODE === 'engine') want = r;
        else {
          // Контроли: сохраняем ТОЧКУ ВХОДА и РАССТОЯНИЕ стопа движка,
          // меняем только направление. Цели пересобираем симметрично
          // (1R/2R/3R), иначе структурные цели старого направления
          // сделали бы сравнение нечестным.
          const side = MODE === 'invert'
            ? (r.direction === 'LONG' ? 'SHORT' : 'LONG')
            : (rnd() < 0.5 ? 'LONG' : 'SHORT');
          const price = r.recommended_entry;
          const Rp = Math.abs(price - r.stop_loss);
          const sgn = side === 'LONG' ? 1 : -1;
          want = {
            direction: side, recommended_entry: price, stop_loss: price - sgn * Rp,
            regime: r.regime, confidence: r.confidence, setup: r.setup,
            take_profit: [
              { label: 'TP1 (1R)', p: price + sgn * Rp, part: 0.4 },
              { label: 'TP2 (2R)', p: price + sgn * Rp * 2, part: 0.4 },
              { label: 'TP3 (3R)', p: price + sgn * Rp * 3, part: 0.2 },
            ],
          };
        }
      }
    } else {
      // Негативный контроль: вход со случайной стороной с той же частотой,
      // что даёт движок (≈2.3% баров), стоп и цели — по той же механике ATR.
      if (rnd() < 0.023) {
        const atr = atrOf(k4, i);
        const price = k4[i].c;
        const side = rnd() < 0.5 ? 'LONG' : 'SHORT';
        const R = Math.max(atr * 1.5, price * 0.004);
        const sl = side === 'LONG' ? price - R : price + R;
        want = {
          direction: side, recommended_entry: price, stop_loss: sl, regime: 'RANDOM', confidence: 0,
          take_profit: [
            { label: 'TP1 (1R)', p: side === 'LONG' ? price + R : price - R, part: 0.4 },
            { label: 'TP2 (2R)', p: side === 'LONG' ? price + R * 2 : price - R * 2, part: 0.4 },
            { label: 'TP3', p: side === 'LONG' ? price + R * 3 : price - R * 3, part: 0.2 },
          ],
          setup: 'RANDOM',
        };
      }
    }

    if (want) {
      // Вход по ОТКРЫТИЮ следующего бара — сигнал знал только закрытие текущего.
      const nb = k4[i + 1];
      const isLong = want.direction === 'LONG';
      const entry = nb.o * (1 + (isLong ? SLIP : -SLIP));
      const sl = want.stop_loss;
      const R = Math.abs(entry - sl);
      if (!R || !isFinite(R)) continue;
      open = {
        sym, side: want.direction, entry, sl, R, openIdx: i + 1, openT: nb.t,
        regime: want.regime, setup: want.setup, confidence: want.confidence,
        tps: want.take_profit.map(t => ({ ...t, done: false })),
        realized: 0, closedPart: 0, mae: 0, mfe: 0,
      };
    }
  }
  // Не закрытая к концу данных позиция закрывается по последней цене.
  if (open) finishMark(open, k4[k4.length - 1].c, k4[k4.length - 1].t, k4.length - 1);

  function atrOf(k, i) {
    const w = k.slice(Math.max(0, i - 20), i + 1);
    return MIE.indicators.atrArr(w, 14).filter(x => x != null).pop() || (k[i].c * 0.01);
  }
  function rMult(o, price) {
    return (o.side === 'LONG' ? price - o.entry : o.entry - price) / o.R;
  }
  function closeTrade(o, price, t, how, idx) {
    o.realized += (1 - o.closedPart) * rMult(o, price);
    o.closedPart = 1;
    finish(o, how, t, idx);
  }
  function finishMark(o, price, t, idx) { closeTrade(o, price, t, 'MARK', idx); }
  function finish(o, how, t, idx) {
    // Издержки: комиссия с обеих сторон + проскальзывание на выходе, в единицах R.
    const notionalR = o.entry / o.R;              // сколько R «стоит» вся позиция
    const cost = (FEE * 2 + SLIP) * notionalR;
    trades.push({
      sym: o.sym, side: o.side, regime: o.regime, setup: o.setup, confidence: o.confidence,
      openT: o.openT, closeT: t, bars: idx - o.openIdx,
      r: o.realized - cost, rGross: o.realized, how, mae: o.mae, mfe: o.mfe,
    });
  }
}

/* ============================ МЕТРИКИ ============================ */
function metrics(ts) {
  const n = ts.length;
  if (!n) return null;
  const rs = ts.map(t => t.r);
  const wins = rs.filter(r => r > 0), losses = rs.filter(r => r <= 0);
  const sum = (a) => a.reduce((s, x) => s + x, 0);
  const grossWin = sum(wins), grossLoss = Math.abs(sum(losses));

  // Капитал: риск RISK_PCT% на сделку, компаундинг.
  let eq = START_EQ, peak = START_EQ, maxDD = 0;
  const curve = [START_EQ];
  ts.forEach(t => {
    eq += eq * (RISK_PCT / 100) * t.r;
    curve.push(eq);
    if (eq > peak) peak = eq;
    const dd = (peak - eq) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  });
  const retPct = (eq / START_EQ - 1) * 100;

  const mean = sum(rs) / n;
  const sd = Math.sqrt(sum(rs.map(r => (r - mean) ** 2)) / Math.max(1, n - 1));
  const dsd = Math.sqrt(sum(rs.filter(r => r < 0).map(r => r ** 2)) / Math.max(1, n));
  // Годовая шкала: сделки редки, считаем по фактической длительности выборки.
  const spanDays = (Math.max(...ts.map(t => t.closeT)) - Math.min(...ts.map(t => t.openT))) / 86400e3;
  const perYear = spanDays > 0 ? n / (spanDays / 365) : 0;
  const sharpe = sd ? mean / sd * Math.sqrt(perYear) : 0;
  const sortino = dsd ? mean / dsd * Math.sqrt(perYear) : 0;
  const cagr = spanDays > 0 ? (Math.pow(eq / START_EQ, 365 / spanDays) - 1) * 100 : 0;
  const calmar = maxDD ? cagr / maxDD : 0;

  let cl = 0, maxCL = 0, cw = 0, maxCW = 0;
  rs.forEach(r => {
    if (r <= 0) { cl++; cw = 0; if (cl > maxCL) maxCL = cl; }
    else { cw++; cl = 0; if (cw > maxCW) maxCW = cw; }
  });

  // Стандартная ошибка среднего R — чтобы видеть, отличим ли результат от нуля.
  const se = sd / Math.sqrt(n);
  return {
    n, winRate: wins.length / n * 100, avgR: mean, seR: se, tStat: se ? mean / se : 0,
    pf: grossLoss ? grossWin / grossLoss : (grossWin ? Infinity : 0),
    avgWin: wins.length ? sum(wins) / wins.length : 0,
    avgLoss: losses.length ? sum(losses) / losses.length : 0,
    expectancy: mean, netProfit: eq - START_EQ, retPct, cagr, maxDD,
    recovery: maxDD ? retPct / maxDD : 0, sharpe, sortino, calmar,
    maxConsecLoss: maxCL, maxConsecWin: maxCW,
    avgBars: sum(ts.map(t => t.bars)) / n,
    avgMAE: sum(ts.map(t => t.mae)) / n, avgMFE: sum(ts.map(t => t.mfe)) / n,
    exposureBars: sum(ts.map(t => t.bars)),
  };
}

function show(label, m) {
  if (!m) { console.log(label + ': нет сделок'); return; }
  const f = (x, d = 2) => (typeof x === 'number' && isFinite(x) ? x.toFixed(d) : String(x));
  console.log('\n### ' + label);
  console.log('  сделок             ' + m.n + '   (в среднем ' + f(m.avgBars, 1) + ' баров 4h в позиции)');
  console.log('  win rate           ' + f(m.winRate, 1) + '%');
  console.log('  средний R          ' + f(m.avgR, 4) + '  ± ' + f(m.seR, 4) + ' (t = ' + f(m.tStat, 2) + ')');
  console.log('  profit factor      ' + f(m.pf));
  console.log('  средняя прибыль    ' + f(m.avgWin, 3) + 'R    средний убыток ' + f(m.avgLoss, 3) + 'R');
  console.log('  матожидание        ' + f(m.expectancy, 4) + 'R на сделку');
  console.log('  чистая прибыль     $' + f(m.netProfit, 0) + '   (' + f(m.retPct, 1) + '% при риске ' + RISK_PCT + '%/сделку)');
  console.log('  CAGR               ' + f(m.cagr, 1) + '%');
  console.log('  макс. просадка     ' + f(m.maxDD, 1) + '%');
  console.log('  recovery factor    ' + f(m.recovery));
  console.log('  Sharpe             ' + f(m.sharpe) + '    Sortino ' + f(m.sortino) + '    Calmar ' + f(m.calmar));
  console.log('  подряд убытков     ' + m.maxConsecLoss + '    подряд прибылей ' + m.maxConsecWin);
  console.log('  средний MAE        ' + f(m.avgMAE) + 'R    средний MFE ' + f(m.avgMFE) + 'R');
}

console.log('=== БЭКТЕСТ MIE ' + MIE.VERSION + ' (' + (MODE === 'random' ? 'СЛУЧАЙНЫЕ ВХОДЫ — негативный контроль' : 'движок') + ') ===');
console.log('пар: ' + files.length + ' | ТФ 4h | комиссия ' + (FEE * 100) + '%/сторона | проскальзывание ' + (SLIP * 100) + '%');
console.log('вход по открытию следующего бара после сигнала; при касании стопа и тейка в одном баре считается стоп');

const all = metrics(trades);
show('ВСЕ СДЕЛКИ', all);

if (trades.length) {
  /* --- Walk-forward: делим по времени на 4 равных окна --- */
  const sorted = [...trades].sort((a, b) => a.openT - b.openT);
  const t0 = sorted[0].openT, t1 = sorted[sorted.length - 1].openT;
  console.log('\n\n===== WALK-FORWARD (4 последовательных окна по времени) =====');
  console.log('Смысл: стабилен ли результат во времени или держится на одном удачном участке.');
  for (let w = 0; w < 4; w++) {
    const lo = t0 + (t1 - t0) * w / 4, hi = t0 + (t1 - t0) * (w + 1) / 4;
    const seg = sorted.filter(t => t.openT >= lo && (w === 3 ? t.openT <= hi : t.openT < hi));
    show('окно ' + (w + 1) + ' (' + new Date(lo).toISOString().slice(0, 10) + ' … ' + new Date(hi).toISOString().slice(0, 10) + ')', metrics(seg));
  }

  /* --- По режимам рынка --- */
  console.log('\n\n===== ПО РЕЖИМАМ РЫНКА =====');
  const byReg = {};
  trades.forEach(t => (byReg[t.regime] = byReg[t.regime] || []).push(t));
  Object.entries(byReg).sort((a, b) => b[1].length - a[1].length).forEach(([r, ts]) => {
    const m = metrics(ts);
    console.log('  ' + r.padEnd(20) + 'n=' + String(m.n).padStart(4) + '  WR ' + m.winRate.toFixed(1).padStart(5) + '%  avgR ' + m.avgR.toFixed(3).padStart(7) + '  PF ' + m.pf.toFixed(2));
  });

  console.log('\n===== ПО ТИПАМ СЕТАПА =====');
  const bySet = {};
  trades.forEach(t => (bySet[t.setup] = bySet[t.setup] || []).push(t));
  Object.entries(bySet).sort((a, b) => b[1].length - a[1].length).forEach(([r, ts]) => {
    const m = metrics(ts);
    console.log('  ' + r.padEnd(20) + 'n=' + String(m.n).padStart(4) + '  WR ' + m.winRate.toFixed(1).padStart(5) + '%  avgR ' + m.avgR.toFixed(3).padStart(7) + '  PF ' + m.pf.toFixed(2));
  });

  console.log('\n===== ПО ВЫХОДУ =====');
  const byHow = {};
  trades.forEach(t => (byHow[t.how] = byHow[t.how] || []).push(t));
  Object.entries(byHow).forEach(([r, ts]) => console.log('  ' + r.padEnd(8) + ts.length));

  console.log('\n===== ВЛИЯНИЕ ИЗДЕРЖЕК =====');
  const gross = trades.reduce((s, t) => s + t.rGross, 0) / trades.length;
  console.log('  средний R до издержек ' + gross.toFixed(4) + '  ->  после ' + all.avgR.toFixed(4));
}

fs.writeFileSync('/tmp/bt/mie_trades_' + MODE + '.json', JSON.stringify(trades));
console.log('\nсделки сохранены: /tmp/bt/mie_trades_' + MODE + '.json');
