/* ============================================================================
   MIE — Market Intelligence Engine
   ----------------------------------------------------------------------------
   Чистая библиотека анализа рынка: без DOM, без состояния приложения, без
   сетевых запросов. На вход — свечи по нескольким таймфреймам, на выход —
   структурированное решение (направление, confidence, режим, уровни, риски,
   причины, вход/стоп/цели) либо явный отказ от сделки.

   Почему отдельным файлом:
   1) её можно юнит-тестировать в Node;
   2) бэктест гоняет ЭТОТ ЖЕ файл, а не переписанную копию логики —
      иначе проверяется не то, что работает в проде;
   3) index.html не раздувается ещё на полторы тысячи строк.

   ПРИНЦИПЫ, зашитые в код:
   - Причинность. Каждая функция смотрит только назад по массиву. Никаких
     будущих свечей: индекс i использует k[0..i] и ничего правее.
   - Нет «кнопок BUY». Ни один индикатор сам по себе не даёт сигнал: они
     сворачиваются в ГРУППЫ (тренд/структура/моментум/…), группа даёт один
     голос. Три индикатора, меряющие один и тот же тренд, не считаются
     тремя независимыми подтверждениями.
   - Право сказать «нет». NO-TRADE — полноценный, приоритетный исход.
   - Никаких выдуманных данных. Нет стакана — модуль ликвидности честно
     возвращает available:false, а не рисует правдоподобные числа.
   - Confidence — это оценка КАЧЕСТВА сетапа, а не вероятность прибыли.

   ВАЖНО ПРО ПРИБЫЛЬНОСТЬ: наличие этой архитектуры само по себе не создаёт
   статистического преимущества. В этом репозитории пять честных проверок
   (research/BACKTEST.md, ML_TRAINING.md, CONFIRMATIONS_30.md, MTF_CONTEXT.md)
   показали отсутствие измеримого edge на публичных OHLCV этих пар. Движок
   даёт дисциплину, прозрачность и отказ от плохих входов — а не обещание
   заработка. Любые цифры доходности берутся только из бэктеста.
   ========================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MIE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = '1.0.0';

  /* ==========================================================================
     0. УТИЛИТЫ
     ========================================================================== */
  const nz = (v, d) => (typeof v === 'number' && isFinite(v) ? v : (d === undefined ? 0 : d));
  const last = (a) => (a && a.length ? a[a.length - 1] : null);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  /** Линейная нормализация в [-1..1] с насыщением. */
  const norm = (v, scale) => clamp(nz(v) / (scale || 1), -1, 1);
  function pct(a, b) { return b ? (a - b) / b * 100 : 0; }
  function mean(a) { return a && a.length ? a.reduce((s, x) => s + nz(x), 0) / a.length : 0; }
  function stdev(a) {
    if (!a || a.length < 2) return 0;
    const m = mean(a);
    return Math.sqrt(a.reduce((s, x) => s + (nz(x) - m) ** 2, 0) / (a.length - 1));
  }
  /** Перцентиль значения v внутри массива arr (0..1). Нужен для «высокая ли волатильность». */
  function percentileOf(arr, v) {
    const a = (arr || []).filter(x => typeof x === 'number' && isFinite(x));
    if (!a.length) return 0.5;
    let n = 0; for (const x of a) if (x <= v) n++;
    return n / a.length;
  }

  /* ==========================================================================
     1. INDICATOR ENGINE
     Все функции причинны: значение на индексе i зависит только от [0..i].
     ========================================================================== */
  function smaArr(v, p) {
    const o = new Array(v.length).fill(null); let s = 0;
    for (let i = 0; i < v.length; i++) { s += nz(v[i]); if (i >= p) s -= nz(v[i - p]); if (i >= p - 1) o[i] = s / p; }
    return o;
  }
  function emaArr(v, p) {
    const k = 2 / (p + 1), o = new Array(v.length).fill(null);
    let prev = null;
    for (let i = 0; i < v.length; i++) {
      const x = nz(v[i]);
      if (prev === null) { if (i >= p - 1) { let s = 0; for (let j = i - p + 1; j <= i; j++) s += nz(v[j]); prev = s / p; o[i] = prev; } }
      else { prev = x * k + prev * (1 - k); o[i] = prev; }
    }
    return o;
  }
  function wmaArr(v, p) {
    const o = new Array(v.length).fill(null);
    for (let i = p - 1; i < v.length; i++) {
      let s = 0, w = 0;
      for (let j = 0; j < p; j++) { s += nz(v[i - j]) * (p - j); w += (p - j); }
      o[i] = s / w;
    }
    return o;
  }
  function hmaArr(v, p) {
    const h = Math.max(1, Math.round(p / 2)), sq = Math.max(1, Math.round(Math.sqrt(p)));
    const w1 = wmaArr(v, h), w2 = wmaArr(v, p);
    const d = v.map((_, i) => (w1[i] != null && w2[i] != null) ? 2 * w1[i] - w2[i] : null);
    return wmaArr(d.map(x => x == null ? 0 : x), sq);
  }
  function demaArr(v, p) { const e = emaArr(v, p), e2 = emaArr(e.map(x => nz(x)), p); return v.map((_, i) => (e[i] != null && e2[i] != null) ? 2 * e[i] - e2[i] : null); }
  function temaArr(v, p) {
    const e = emaArr(v, p), e2 = emaArr(e.map(x => nz(x)), p), e3 = emaArr(e2.map(x => nz(x)), p);
    return v.map((_, i) => (e[i] != null && e2[i] != null && e3[i] != null) ? 3 * e[i] - 3 * e2[i] + e3[i] : null);
  }
  /** KAMA — адаптивная скользящая: ускоряется в тренде, замирает в шуме. */
  function kamaArr(v, p, fast, slow) {
    p = p || 10; fast = fast || 2; slow = slow || 30;
    const fc = 2 / (fast + 1), sc = 2 / (slow + 1);
    const o = new Array(v.length).fill(null);
    let prev = null;
    for (let i = 0; i < v.length; i++) {
      if (i < p) continue;
      const change = Math.abs(nz(v[i]) - nz(v[i - p]));
      let vol = 0; for (let j = i - p + 1; j <= i; j++) vol += Math.abs(nz(v[j]) - nz(v[j - 1]));
      const er = vol ? change / vol : 0;
      const sm = (er * (fc - sc) + sc) ** 2;
      if (prev === null) prev = nz(v[i - 1]);
      prev = prev + sm * (nz(v[i]) - prev);
      o[i] = prev;
    }
    return o;
  }
  function trArr(k) {
    return k.map((c, i) => i ? Math.max(c.h - c.l, Math.abs(c.h - k[i - 1].c), Math.abs(c.l - k[i - 1].c)) : (c.h - c.l));
  }
  function atrArr(k, p) { p = p || 14; return emaArr(trArr(k), p); }
  function rsiArr(v, p) {
    p = p || 14;
    const o = new Array(v.length).fill(null);
    if (v.length <= p) return o;
    let g = 0, l = 0;
    for (let i = 1; i <= p; i++) { const d = nz(v[i]) - nz(v[i - 1]); if (d >= 0) g += d; else l -= d; }
    let ag = g / p, al = l / p;
    o[p] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    for (let i = p + 1; i < v.length; i++) {
      const d = nz(v[i]) - nz(v[i - 1]);
      ag = (ag * (p - 1) + (d > 0 ? d : 0)) / p;
      al = (al * (p - 1) + (d < 0 ? -d : 0)) / p;
      o[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    }
    return o;
  }
  function macdArr(v, f, s, g) {
    f = f || 12; s = s || 26; g = g || 9;
    const ef = emaArr(v, f), es = emaArr(v, s);
    const macd = v.map((_, i) => (ef[i] != null && es[i] != null) ? ef[i] - es[i] : null);
    const sig = emaArr(macd.map(x => nz(x)), g);
    const hist = macd.map((m, i) => (m != null && sig[i] != null) ? m - sig[i] : null);
    return { macd, sig, hist };
  }
  function ppoArr(v, f, s) {
    f = f || 12; s = s || 26;
    const ef = emaArr(v, f), es = emaArr(v, s);
    return v.map((_, i) => (ef[i] != null && es[i] != null && es[i]) ? (ef[i] - es[i]) / es[i] * 100 : null);
  }
  function rocArr(v, p) { p = p || 12; return v.map((x, i) => i >= p && nz(v[i - p]) ? (nz(x) - nz(v[i - p])) / nz(v[i - p]) * 100 : null); }
  function momArr(v, p) { p = p || 10; return v.map((x, i) => i >= p ? nz(x) - nz(v[i - p]) : null); }
  function stochArr(k, p, d) {
    p = p || 14; d = d || 3;
    const kA = new Array(k.length).fill(null);
    for (let i = p - 1; i < k.length; i++) {
      let hh = -Infinity, ll = Infinity;
      for (let j = i - p + 1; j <= i; j++) { if (k[j].h > hh) hh = k[j].h; if (k[j].l < ll) ll = k[j].l; }
      kA[i] = hh === ll ? 50 : (k[i].c - ll) / (hh - ll) * 100;
    }
    const dA = smaArr(kA.map(x => nz(x, 50)), d);
    return { k: kA, d: dA };
  }
  function stochRsiArr(v, p) {
    p = p || 14;
    const r = rsiArr(v, p), o = new Array(v.length).fill(null);
    for (let i = 0; i < v.length; i++) {
      if (r[i] == null || i < p * 2) continue;
      let hh = -Infinity, ll = Infinity;
      for (let j = i - p + 1; j <= i; j++) { if (r[j] == null) continue; if (r[j] > hh) hh = r[j]; if (r[j] < ll) ll = r[j]; }
      o[i] = hh === ll ? 50 : (r[i] - ll) / (hh - ll) * 100;
    }
    return o;
  }
  function cciArr(k, p) {
    p = p || 20;
    const tp = k.map(c => (c.h + c.l + c.c) / 3), m = smaArr(tp, p), o = new Array(k.length).fill(null);
    for (let i = p - 1; i < k.length; i++) {
      let md = 0; for (let j = i - p + 1; j <= i; j++) md += Math.abs(tp[j] - m[i]); md /= p;
      o[i] = md ? (tp[i] - m[i]) / (0.015 * md) : 0;
    }
    return o;
  }
  function wprArr(k, p) {
    p = p || 14;
    const o = new Array(k.length).fill(null);
    for (let i = p - 1; i < k.length; i++) {
      let hh = -Infinity, ll = Infinity;
      for (let j = i - p + 1; j <= i; j++) { if (k[j].h > hh) hh = k[j].h; if (k[j].l < ll) ll = k[j].l; }
      o[i] = hh === ll ? -50 : (hh - k[i].c) / (hh - ll) * -100;
    }
    return o;
  }
  /** Ultimate Oscillator — три горизонта сразу, меньше ложных экстремумов. */
  function uoArr(k, s, m, l) {
    s = s || 7; m = m || 14; l = l || 28;
    const bp = [], tr = [];
    for (let i = 0; i < k.length; i++) {
      if (!i) { bp.push(0); tr.push(k[i].h - k[i].l); continue; }
      const pc = k[i - 1].c;
      bp.push(k[i].c - Math.min(k[i].l, pc));
      tr.push(Math.max(k[i].h, pc) - Math.min(k[i].l, pc));
    }
    const sum = (arr, i, n) => { let x = 0; for (let j = i - n + 1; j <= i; j++) x += nz(arr[j]); return x; };
    const o = new Array(k.length).fill(null);
    for (let i = l; i < k.length; i++) {
      const a1 = sum(tr, i, s) ? sum(bp, i, s) / sum(tr, i, s) : 0;
      const a2 = sum(tr, i, m) ? sum(bp, i, m) / sum(tr, i, m) : 0;
      const a3 = sum(tr, i, l) ? sum(bp, i, l) / sum(tr, i, l) : 0;
      o[i] = 100 * (4 * a1 + 2 * a2 + a3) / 7;
    }
    return o;
  }
  function aoArr(k) {
    const mid = k.map(c => (c.h + c.l) / 2);
    const f = smaArr(mid, 5), s = smaArr(mid, 34);
    return mid.map((_, i) => (f[i] != null && s[i] != null) ? f[i] - s[i] : null);
  }
  function bbArr(v, p, mult) {
    p = p || 20; mult = mult || 2;
    const mid = smaArr(v, p), up = new Array(v.length).fill(null), lo = new Array(v.length).fill(null), wid = new Array(v.length).fill(null);
    for (let i = p - 1; i < v.length; i++) {
      if (mid[i] == null) continue;
      let s = 0; for (let j = i - p + 1; j <= i; j++) s += (nz(v[j]) - mid[i]) ** 2;
      const sd = Math.sqrt(s / p);
      up[i] = mid[i] + mult * sd; lo[i] = mid[i] - mult * sd;
      wid[i] = mid[i] ? (up[i] - lo[i]) / mid[i] * 100 : null;
    }
    return { mid, up, lo, width: wid };
  }
  function keltnerArr(k, v, p, mult) {
    p = p || 20; mult = mult || 2;
    const mid = emaArr(v, p), a = atrArr(k, 10);
    return {
      mid,
      up: v.map((_, i) => (mid[i] != null && a[i] != null) ? mid[i] + mult * a[i] : null),
      lo: v.map((_, i) => (mid[i] != null && a[i] != null) ? mid[i] - mult * a[i] : null),
    };
  }
  function donchianArr(k, p) {
    p = p || 20;
    const up = new Array(k.length).fill(null), lo = new Array(k.length).fill(null);
    for (let i = p - 1; i < k.length; i++) {
      let hh = -Infinity, ll = Infinity;
      for (let j = i - p + 1; j <= i; j++) { if (k[j].h > hh) hh = k[j].h; if (k[j].l < ll) ll = k[j].l; }
      up[i] = hh; lo[i] = ll;
    }
    return { up, lo, mid: up.map((u, i) => (u != null && lo[i] != null) ? (u + lo[i]) / 2 : null) };
  }
  /** Историческая (реализованная) волатильность в % годовых, по логдоходностям. */
  function histVolArr(v, p, barsPerYear) {
    p = p || 20; barsPerYear = barsPerYear || 2190; // 4h баров в году
    const r = v.map((x, i) => i && nz(v[i - 1]) > 0 ? Math.log(nz(x) / nz(v[i - 1])) : 0);
    const o = new Array(v.length).fill(null);
    for (let i = p; i < v.length; i++) o[i] = stdev(r.slice(i - p + 1, i + 1)) * Math.sqrt(barsPerYear) * 100;
    return o;
  }
  function adxArr(k, p) {
    p = p || 14;
    const tr = trArr(k), pdm = [], mdm = [];
    for (let i = 0; i < k.length; i++) {
      const up = i ? k[i].h - k[i - 1].h : 0, dn = i ? k[i - 1].l - k[i].l : 0;
      pdm.push(up > dn && up > 0 ? up : 0);
      mdm.push(dn > up && dn > 0 ? dn : 0);
    }
    const trS = emaArr(tr, p), pS = emaArr(pdm, p), mS = emaArr(mdm, p);
    const pdi = [], mdi = [], dx = [];
    for (let i = 0; i < k.length; i++) {
      const t = nz(trS[i]);
      const a = t ? 100 * nz(pS[i]) / t : 0, b = t ? 100 * nz(mS[i]) / t : 0;
      pdi.push(a); mdi.push(b);
      const s = a + b; dx.push(s ? 100 * Math.abs(a - b) / s : 0);
    }
    return { adx: emaArr(dx, p), pdi, mdi };
  }
  function obvArr(k) {
    let s = 0;
    return k.map((c, i) => { if (i) { if (c.c > k[i - 1].c) s += nz(c.v); else if (c.c < k[i - 1].c) s -= nz(c.v); } return s; });
  }
  /** Кумулятивный VWAP от начала переданного окна (не «сессионный» — окно задаёт вызывающий). */
  function vwapArr(k) {
    let pv = 0, vv = 0;
    return k.map(c => { const tp = (c.h + c.l + c.c) / 3, v = nz(c.v); pv += tp * v; vv += v; return vv ? pv / vv : c.c; });
  }
  function mfiArr(k, p) {
    p = p || 14;
    const tp = k.map(c => (c.h + c.l + c.c) / 3), o = new Array(k.length).fill(null);
    for (let i = p; i < k.length; i++) {
      let pos = 0, neg = 0;
      for (let j = i - p + 1; j <= i; j++) {
        const f = tp[j] * nz(k[j].v);
        if (tp[j] > tp[j - 1]) pos += f; else if (tp[j] < tp[j - 1]) neg += f;
      }
      o[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
    }
    return o;
  }
  function cmfArr(k, p) {
    p = p || 20;
    const o = new Array(k.length).fill(null);
    for (let i = p - 1; i < k.length; i++) {
      let mfv = 0, vol = 0;
      for (let j = i - p + 1; j <= i; j++) {
        const rng = k[j].h - k[j].l;
        const m = rng ? ((k[j].c - k[j].l) - (k[j].h - k[j].c)) / rng : 0;
        mfv += m * nz(k[j].v); vol += nz(k[j].v);
      }
      o[i] = vol ? mfv / vol : 0;
    }
    return o;
  }
  /** Относительный объём: текущий бар против среднего за p баров. */
  function relVolArr(k, p) {
    p = p || 20;
    const v = k.map(c => nz(c.v)), m = smaArr(v, p);
    return v.map((x, i) => (m[i] ? x / m[i] : null));
  }
  function supertrendArr(k, p, mult) {
    p = p || 10; mult = mult || 3;
    const a = atrArr(k, p), line = new Array(k.length).fill(null), dir = new Array(k.length).fill(null);
    let d = 1, l = null;
    for (let i = 0; i < k.length; i++) {
      if (a[i] == null) continue;
      const mid = (k[i].h + k[i].l) / 2, up = mid + mult * a[i], lo = mid - mult * a[i];
      if (l === null) { l = lo; d = 1; }
      if (d === 1) { l = Math.max(l, lo); if (k[i].c < l) { d = -1; l = up; } }
      else { l = Math.min(l, up); if (k[i].c > l) { d = 1; l = lo; } }
      line[i] = l; dir[i] = d;
    }
    return { line, dir };
  }
  function ichimokuArr(k) {
    const hh = (p, i) => { let h = -Infinity; for (let j = Math.max(0, i - p + 1); j <= i; j++) if (k[j].h > h) h = k[j].h; return h; };
    const ll = (p, i) => { let l = Infinity; for (let j = Math.max(0, i - p + 1); j <= i; j++) if (k[j].l < l) l = k[j].l; return l; };
    const ten = [], kij = [], spA = [], spB = [];
    for (let i = 0; i < k.length; i++) { ten.push((hh(9, i) + ll(9, i)) / 2); kij.push((hh(26, i) + ll(26, i)) / 2); }
    for (let i = 0; i < k.length; i++) { spA.push((ten[i] + kij[i]) / 2); spB.push((hh(52, i) + ll(52, i)) / 2); }
    return { ten, kij, spA, spB };
  }

  const indicators = {
    smaArr, emaArr, wmaArr, hmaArr, demaArr, temaArr, kamaArr, trArr, atrArr,
    rsiArr, macdArr, ppoArr, rocArr, momArr, stochArr, stochRsiArr, cciArr, wprArr, uoArr, aoArr,
    bbArr, keltnerArr, donchianArr, histVolArr, adxArr,
    obvArr, vwapArr, mfiArr, cmfArr, relVolArr, supertrendArr, ichimokuArr,
  };

  /* ==========================================================================
     2. MARKET STRUCTURE ENGINE
     Свинги -> последовательность HH/HL/LH/LL -> BOS / CHoCH -> уровни,
     пулы ликвидности (equal highs/lows), свипы, displacement.
     ========================================================================== */

  /** Фрактальные свинг-точки с фильтром по минимальному размаху (в % от цены). */
  function swingPoints(k, dep, minPct) {
    dep = dep || 3; minPct = (minPct == null ? 0.3 : minPct);
    const raw = [];
    for (let i = dep; i < k.length - dep; i++) {
      let isH = true, isL = true;
      for (let j = i - dep; j <= i + dep; j++) {
        if (j === i) continue;
        if (k[j].h > k[i].h) isH = false;
        if (k[j].l < k[i].l) isL = false;
      }
      if (isH) {
        let mn = Infinity; for (let j = i - dep; j <= i + dep; j++) if (j !== i) mn = Math.min(mn, k[j].l);
        if (k[i].h && (k[i].h - mn) / k[i].h * 100 >= minPct) raw.push({ i, p: k[i].h, t: k[i].t, type: 'H' });
      }
      if (isL) {
        let mx = -Infinity; for (let j = i - dep; j <= i + dep; j++) if (j !== i) mx = Math.max(mx, k[j].h);
        if (k[i].l && (mx - k[i].l) / k[i].l * 100 >= minPct) raw.push({ i, p: k[i].l, t: k[i].t, type: 'L' });
      }
    }
    raw.sort((a, b) => a.i - b.i);
    // Схлопываем подряд идущие одного типа — остаётся самый экстремальный.
    const out = [];
    raw.forEach(s => {
      const l = out[out.length - 1];
      if (l && l.type === s.type) { if ((s.type === 'H' && s.p > l.p) || (s.type === 'L' && s.p < l.p)) out[out.length - 1] = s; }
      else out.push(s);
    });
    return out;
  }

  /**
   * Полная структура рынка на закрытых барах k.
   * Возвращает: направление структуры, последовательность (HH/HL/LH/LL),
   * BOS/CHoCH, уровни поддержки/сопротивления, пулы ликвидности и свипы.
   */
  function analyzeStructure(k, opts) {
    opts = opts || {};
    const n = k.length - 1;
    const out = {
      ok: false, dir: null, sequence: [], swings: [],
      lastHigh: null, prevHigh: null, lastLow: null, prevLow: null,
      bos: null, choch: null, support: [], resistance: [],
      equalHighs: [], equalLows: [], sweep: null, displacement: null,
    };
    if (!k || k.length < 30) return out;

    // Подбираем глубину так, чтобы получить достаточно опорных точек.
    let sw = [];
    for (const d of [opts.dep || 3, 2]) {
      sw = swingPoints(k, d, opts.minPct == null ? 0.3 : opts.minPct);
      if (sw.filter(s => s.type === 'H').length >= 2 && sw.filter(s => s.type === 'L').length >= 2) break;
    }
    out.swings = sw;
    const highs = sw.filter(s => s.type === 'H'), lows = sw.filter(s => s.type === 'L');
    if (highs.length < 2 || lows.length < 2) return out;
    out.ok = true;

    const lastH = highs[highs.length - 1], prevH = highs[highs.length - 2];
    const lastL = lows[lows.length - 1], prevL = lows[lows.length - 2];
    out.lastHigh = lastH; out.prevHigh = prevH; out.lastLow = lastL; out.prevLow = prevL;

    // Последовательность последних 4 свингов в терминах HH/HL/LH/LL.
    const seq = [];
    for (let i = 1; i < sw.length; i++) {
      const cur = sw[i];
      const prevSame = sw.slice(0, i).reverse().find(s => s.type === cur.type);
      if (!prevSame) continue;
      if (cur.type === 'H') seq.push(cur.p > prevSame.p ? 'HH' : 'LH');
      else seq.push(cur.p > prevSame.p ? 'HL' : 'LL');
    }
    out.sequence = seq.slice(-4);

    const up = lastH.p > prevH.p && lastL.p > prevL.p;
    const down = lastH.p < prevH.p && lastL.p < prevL.p;
    out.dir = up ? 'LONG' : down ? 'SHORT' : null;

    const price = k[n].c;
    const a = atrArr(k, 14), atr = nz(last(a), 0);

    /* BOS (продолжение): цена закрылась ЗА последним значимым экстремумом
       по направлению структуры. CHoCH (слом характера): закрылась против —
       за последним противоположным экстремумом. Разница принципиальна:
       BOS подтверждает тренд, CHoCH предупреждает о развороте. */
    if (out.dir === 'LONG') {
      if (price > lastH.p) out.bos = { dir: 'LONG', level: lastH.p, at: n };
      if (price < lastL.p) out.choch = { dir: 'SHORT', level: lastL.p, at: n };
    } else if (out.dir === 'SHORT') {
      if (price < lastL.p) out.bos = { dir: 'SHORT', level: lastL.p, at: n };
      if (price > lastH.p) out.choch = { dir: 'LONG', level: lastH.p, at: n };
    } else {
      if (price > lastH.p) out.bos = { dir: 'LONG', level: lastH.p, at: n };
      if (price < lastL.p) out.bos = { dir: 'SHORT', level: lastL.p, at: n };
    }

    // Уровни: свинги ниже цены — поддержка, выше — сопротивление (ближайшие).
    out.support = lows.filter(s => s.p < price).sort((x, y) => y.p - x.p).slice(0, 3).map(s => ({ p: s.p, i: s.i }));
    out.resistance = highs.filter(s => s.p > price).sort((x, y) => x.p - y.p).slice(0, 3).map(s => ({ p: s.p, i: s.i }));

    /* Пулы ликвидности: равные максимумы/минимумы (в пределах 0.15*ATR) —
       под ними обычно стоят стопы, и рынок часто ходит именно туда. */
    const tol = Math.max(atr * 0.15, price * 0.0005);
    function equals(arr) {
      const res = [];
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          if (Math.abs(arr[i].p - arr[j].p) <= tol) res.push({ p: (arr[i].p + arr[j].p) / 2, count: 2, i: arr[j].i });
        }
      }
      return res.slice(-3);
    }
    out.equalHighs = equals(highs);
    out.equalLows = equals(lows);

    /* Свип ликвидности: бар пробил уровень пула ФИТИЛЁМ и закрылся обратно
       внутрь. Это не пробой, а снятие стопов — часто разворотный сигнал. */
    const c = k[n];
    const sweepHigh = out.equalHighs.concat(highs.slice(-2).map(s => ({ p: s.p })))
      .find(l => c.h > l.p + tol * 0.5 && c.c < l.p);
    const sweepLow = out.equalLows.concat(lows.slice(-2).map(s => ({ p: s.p })))
      .find(l => c.l < l.p - tol * 0.5 && c.c > l.p);
    if (sweepHigh) out.sweep = { side: 'HIGH', level: sweepHigh.p, dir: 'SHORT' };
    else if (sweepLow) out.sweep = { side: 'LOW', level: sweepLow.p, dir: 'LONG' };

    /* Displacement: импульсный бар с телом заметно больше ATR — признак
       входа крупного участника, а не шумового колебания. */
    const body = Math.abs(c.c - c.o);
    if (atr && body > atr * 1.5) out.displacement = { dir: c.c > c.o ? 'LONG' : 'SHORT', bodyAtr: body / atr };

    return out;
  }

  const structure = { swingPoints, analyzeStructure };

  /* ==========================================================================
     3. MARKET REGIME ENGINE
     Режим определяет, КАКАЯ стратегия вообще уместна. В чопе лучший вход —
     его отсутствие, в тренде mean-reversion работает против себя.
     ========================================================================== */
  const REGIMES = [
    'STRONG_BULL', 'WEAK_BULL', 'STRONG_BEAR', 'WEAK_BEAR',
    'RANGE', 'CHOP', 'BREAKOUT', 'BREAKDOWN',
    'ACCUMULATION', 'DISTRIBUTION', 'EXPANSION', 'CONTRACTION',
    'REVERSAL', 'PANIC',
  ];

  function detectRegime(k, st) {
    const n = k.length - 1;
    const out = {
      ok: false, primary: 'UNKNOWN', flags: [], trendStrength: 0, direction: null,
      volatility: 'UNKNOWN', volPercentile: 0.5, atrPct: 0, bbWidth: 0, bbPercentile: 0.5,
      squeeze: false, expansion: false, allow: { trend: false, meanRev: false, breakout: false },
    };
    if (!k || k.length < 60) return out;
    const cl = k.map(c => c.c);
    const ad = adxArr(k, 14), atr = atrArr(k, 14), bb = bbArr(cl, 20, 2);
    const e21 = emaArr(cl, 21), e50 = emaArr(cl, 50), e200 = emaArr(cl, 200);
    const price = cl[n], A = nz(atr[n]);
    if (!A || ad.adx[n] == null) return out;
    out.ok = true;

    const adx = nz(ad.adx[n]);
    const diUp = nz(ad.pdi[n]) > nz(ad.mdi[n]);
    out.trendStrength = Math.round(adx);
    out.atrPct = price ? A / price * 100 : 0;

    // Перцентили считаем по прошлому окну — «высокая волатильность» относительна.
    const atrPctSeries = [];
    for (let i = Math.max(1, n - 200); i <= n; i++) if (atr[i] != null && cl[i]) atrPctSeries.push(atr[i] / cl[i] * 100);
    out.volPercentile = percentileOf(atrPctSeries, out.atrPct);
    out.volatility = out.volPercentile > 0.8 ? 'HIGH' : out.volPercentile < 0.25 ? 'LOW' : 'MEDIUM';

    out.bbWidth = nz(bb.width[n]);
    const bbSeries = [];
    for (let i = Math.max(1, n - 200); i <= n; i++) if (bb.width[i] != null) bbSeries.push(bb.width[i]);
    out.bbPercentile = percentileOf(bbSeries, out.bbWidth);
    out.squeeze = out.bbPercentile < 0.2;        // сжатие — топливо для импульса
    out.expansion = out.bbPercentile > 0.8;

    // Направление: EMA-стек + структура. Одного мало, но вместе устойчивее.
    const stackUp = e21[n] != null && e50[n] != null && e200[n] != null && e21[n] > e50[n] && e50[n] > e200[n];
    const stackDown = e21[n] != null && e50[n] != null && e200[n] != null && e21[n] < e50[n] && e50[n] < e200[n];
    const structDir = st && st.dir;
    let dir = null;
    if (stackUp && structDir !== 'SHORT') dir = 'LONG';
    else if (stackDown && structDir !== 'LONG') dir = 'SHORT';
    else if (structDir) dir = structDir;
    else if (e21[n] != null && e50[n] != null) dir = e21[n] > e50[n] ? 'LONG' : 'SHORT';
    out.direction = dir;

    const trending = adx >= 25;
    const weakTrend = adx >= 18 && adx < 25;
    const noTrend = adx < 18;

    // Диапазон: цена ходит внутри канала Дончиана без прогресса.
    const dc = donchianArr(k, 20);
    const chanH = nz(dc.up[n]), chanL = nz(dc.lo[n]);
    const chanW = chanH - chanL;
    const posInChan = chanW ? (price - chanL) / chanW : 0.5;

    let primary = 'UNKNOWN';
    if (noTrend && out.volPercentile < 0.6 && chanW && chanW / price * 100 < 12) primary = 'RANGE';
    if (noTrend && (out.volPercentile >= 0.6 || (st && !st.dir))) primary = 'CHOP';
    if (weakTrend) primary = dir === 'LONG' ? 'WEAK_BULL' : 'WEAK_BEAR';
    if (trending) primary = dir === 'LONG' ? 'STRONG_BULL' : 'STRONG_BEAR';

    // Пробой/слом: закрытие за границей канала на расширении.
    if (price > chanH - A * 0.1 && out.expansion && diUp) primary = 'BREAKOUT';
    if (price < chanL + A * 0.1 && out.expansion && !diUp) primary = 'BREAKDOWN';

    // Сжатие/расширение как самостоятельные состояния.
    if (out.squeeze && noTrend) primary = 'CONTRACTION';

    // Паника: экстремальная волатильность + сильное направленное движение.
    const ret3 = cl[n - 3] ? (price / cl[n - 3] - 1) * 100 : 0;
    if (out.volPercentile > 0.95 && Math.abs(ret3) > out.atrPct * 2.5) primary = 'PANIC';

    // Разворот: слом характера структуры против прежнего направления.
    if (st && st.choch) primary = 'REVERSAL';

    // Накопление/распределение: сжатие у края диапазона без тренда.
    if (primary === 'RANGE' || primary === 'CONTRACTION') {
      if (posInChan < 0.3) primary = 'ACCUMULATION';
      else if (posInChan > 0.7) primary = 'DISTRIBUTION';
    }

    out.primary = primary;
    if (out.squeeze) out.flags.push('SQUEEZE');
    if (out.expansion) out.flags.push('EXPANSION');
    if (out.volatility === 'HIGH') out.flags.push('HIGH_VOLATILITY');
    if (out.volatility === 'LOW') out.flags.push('LOW_VOLATILITY');
    if (st && st.bos) out.flags.push('BOS');
    if (st && st.choch) out.flags.push('CHOCH');
    if (st && st.sweep) out.flags.push('LIQUIDITY_SWEEP');

    /* Какие семейства стратегий вообще разрешены в этом режиме.
       Это и есть «стратегия меняет поведение в зависимости от режима». */
    out.allow.trend = ['STRONG_BULL', 'STRONG_BEAR', 'WEAK_BULL', 'WEAK_BEAR', 'BREAKOUT', 'BREAKDOWN'].includes(primary);
    out.allow.meanRev = ['RANGE', 'ACCUMULATION', 'DISTRIBUTION'].includes(primary);
    out.allow.breakout = ['CONTRACTION', 'ACCUMULATION', 'DISTRIBUTION', 'BREAKOUT', 'BREAKDOWN'].includes(primary);
    return out;
  }

  const regime = { detectRegime, REGIMES };

  /* ==========================================================================
     4. DIVERGENCE ENGINE
     Regular — цена делает новый экстремум, осциллятор не подтверждает
     (ослабление тренда). Hidden — наоборот: коррекция цены при сохраняющейся
     силе осциллятора (продолжение тренда). Смешивать их нельзя.
     ========================================================================== */
  function findDivergences(k, sw) {
    const res = [];
    if (!k || k.length < 40 || !sw || sw.length < 4) return res;
    const cl = k.map(c => c.c);
    const rsi = rsiArr(cl, 14);
    const macd = macdArr(cl).hist;
    const obv = obvArr(k);
    const n = k.length - 1;
    const recent = (s) => n - s.i <= 40;   // старые расхождения не интересны

    const highs = sw.filter(s => s.type === 'H' && recent(s)).slice(-2);
    const lows = sw.filter(s => s.type === 'L' && recent(s)).slice(-2);

    function check(name, series) {
      if (highs.length === 2) {
        const [a, b] = highs;
        const pa = a.p, pb = b.p, oa = nz(series[a.i]), ob = nz(series[b.i]);
        if (pb > pa && ob < oa) res.push({ type: 'REGULAR', dir: 'SHORT', on: name, from: a.i, to: b.i });
        if (pb < pa && ob > oa) res.push({ type: 'HIDDEN', dir: 'SHORT', on: name, from: a.i, to: b.i });
      }
      if (lows.length === 2) {
        const [a, b] = lows;
        const pa = a.p, pb = b.p, oa = nz(series[a.i]), ob = nz(series[b.i]);
        if (pb < pa && ob > oa) res.push({ type: 'REGULAR', dir: 'LONG', on: name, from: a.i, to: b.i });
        if (pb > pa && ob < oa) res.push({ type: 'HIDDEN', dir: 'LONG', on: name, from: a.i, to: b.i });
      }
    }
    check('RSI', rsi);
    check('MACD', macd);
    check('OBV', obv);
    return res;
  }

  const divergence = { findDivergences };

  /* ==========================================================================
     5. LEVEL / FIBONACCI / CONFLUENCE ENGINE
     Отдельные уровни малоинформативны. Ценность даёт СОВПАДЕНИЕ нескольких
     независимых источников в узкой зоне.
     ========================================================================== */
  function fibLevels(swingLow, swingHigh, dirUp) {
    const d = swingHigh - swingLow;
    if (!(d > 0)) return [];
    const r = [0.382, 0.5, 0.618, 0.786];
    const e = [1.272, 1.618];
    const out = [];
    r.forEach(f => out.push({ p: dirUp ? swingHigh - d * f : swingLow + d * f, kind: 'fib', label: 'Fib ' + f }));
    e.forEach(f => out.push({ p: dirUp ? swingLow + d * f : swingHigh - d * f, kind: 'fibext', label: 'Fib ext ' + f }));
    return out;
  }

  function pivotLevels(prevHigh, prevLow, prevClose) {
    if (!(prevHigh > 0 && prevLow > 0)) return [];
    const p = (prevHigh + prevLow + prevClose) / 3;
    return [
      { p, kind: 'pivot', label: 'Pivot P' },
      { p: 2 * p - prevLow, kind: 'pivot', label: 'R1' },
      { p: 2 * p - prevHigh, kind: 'pivot', label: 'S1' },
      { p: p + (prevHigh - prevLow), kind: 'pivot', label: 'R2' },
      { p: p - (prevHigh - prevLow), kind: 'pivot', label: 'S2' },
    ];
  }

  /** Психологические круглые уровни рядом с ценой. */
  function roundLevels(price) {
    if (!(price > 0)) return [];
    const mag = Math.pow(10, Math.floor(Math.log10(price)) - 1);
    const step = mag * 5;
    const base = Math.round(price / step) * step;
    return [-2, -1, 0, 1, 2].map(i => ({ p: base + i * step, kind: 'round', label: 'Круглый уровень' }))
      .filter(l => l.p > 0);
  }

  /** Грубый volume profile: гистограмма объёма по ценовым корзинам, POC/VAH/VAL. */
  function volumeProfile(k, bins) {
    bins = bins || 24;
    if (!k || k.length < 20) return null;
    let lo = Infinity, hi = -Infinity;
    k.forEach(c => { if (c.l < lo) lo = c.l; if (c.h > hi) hi = c.h; });
    if (!(hi > lo)) return null;
    const w = (hi - lo) / bins, hist = new Array(bins).fill(0);
    k.forEach(c => {
      const idx = clamp(Math.floor(((c.h + c.l + c.c) / 3 - lo) / w), 0, bins - 1);
      hist[idx] += nz(c.v);
    });
    let pocI = 0; hist.forEach((x, i) => { if (x > hist[pocI]) pocI = i; });
    const total = hist.reduce((s, x) => s + x, 0);
    // Value area: расширяемся от POC, пока не наберём 70% объёма.
    let l = pocI, r = pocI, acc = hist[pocI];
    while (acc < total * 0.7 && (l > 0 || r < bins - 1)) {
      const left = l > 0 ? hist[l - 1] : -1, right = r < bins - 1 ? hist[r + 1] : -1;
      if (right >= left) { r++; acc += hist[r]; } else { l--; acc += hist[l]; }
    }
    return { poc: lo + (pocI + 0.5) * w, val: lo + l * w, vah: lo + (r + 1) * w, lo, hi };
  }

  /**
   * Собирает уровни из независимых источников и кластеризует их.
   * Зона считается значимой, если в неё попали РАЗНЫЕ по природе источники.
   */
  function buildConfluence(k, st, htfCandles) {
    const n = k.length - 1, price = k[n].c;
    const atr = nz(last(atrArr(k, 14)));
    const levels = [];

    if (st && st.ok && st.lastLow && st.lastHigh) {
      const lo = Math.min(st.lastLow.p, st.prevLow ? st.prevLow.p : st.lastLow.p);
      const hi = Math.max(st.lastHigh.p, st.prevHigh ? st.prevHigh.p : st.lastHigh.p);
      fibLevels(lo, hi, st.dir !== 'SHORT').forEach(l => levels.push(l));
      st.support.forEach(s => levels.push({ p: s.p, kind: 'structure', label: 'Поддержка' }));
      st.resistance.forEach(s => levels.push({ p: s.p, kind: 'structure', label: 'Сопротивление' }));
      st.equalHighs.forEach(s => levels.push({ p: s.p, kind: 'liquidity', label: 'Пул ликвидности (равные максимумы)' }));
      st.equalLows.forEach(s => levels.push({ p: s.p, kind: 'liquidity', label: 'Пул ликвидности (равные минимумы)' }));
    }

    const vw = last(vwapArr(k.slice(-Math.min(k.length, 120))));
    if (vw) levels.push({ p: vw, kind: 'vwap', label: 'VWAP' });

    const vp = volumeProfile(k.slice(-Math.min(k.length, 200)));
    if (vp) {
      levels.push({ p: vp.poc, kind: 'volume', label: 'POC (макс. объём)' });
      levels.push({ p: vp.vah, kind: 'volume', label: 'VAH' });
      levels.push({ p: vp.val, kind: 'volume', label: 'VAL' });
    }

    // Уровни старшего таймфрейма: предыдущий период high/low + пивоты.
    if (htfCandles && htfCandles.length >= 3) {
      const p1 = htfCandles[htfCandles.length - 2];
      if (p1) {
        levels.push({ p: p1.h, kind: 'htf', label: 'High пред. периода (старший ТФ)' });
        levels.push({ p: p1.l, kind: 'htf', label: 'Low пред. периода (старший ТФ)' });
        pivotLevels(p1.h, p1.l, p1.c).forEach(l => levels.push({ ...l, kind: 'pivot' }));
      }
    }

    roundLevels(price).forEach(l => levels.push(l));

    // Кластеризация: уровни ближе 0.4*ATR считаем одной зоной.
    const tol = Math.max(atr * 0.4, price * 0.0015);
    const sorted = levels.filter(l => l.p > 0 && isFinite(l.p)).sort((a, b) => a.p - b.p);
    const zones = [];
    let cur = null;
    sorted.forEach(l => {
      if (cur && Math.abs(l.p - cur.center) <= tol) {
        cur.items.push(l);
        cur.center = mean(cur.items.map(x => x.p));
      } else {
        cur = { center: l.p, items: [l] };
        zones.push(cur);
      }
    });
    // Сила зоны = число РАЗНЫХ источников (не количество уровней): три фибо
    // рядом — это по-прежнему один источник информации.
    zones.forEach(z => {
      z.kinds = Array.from(new Set(z.items.map(i => i.kind)));
      z.strength = z.kinds.length;
      z.labels = Array.from(new Set(z.items.map(i => i.label))).slice(0, 4);
      z.distPct = price ? (z.center - price) / price * 100 : 0;
      z.side = z.center > price ? 'ABOVE' : 'BELOW';
    });
    const strong = zones.filter(z => z.strength >= 2).sort((a, b) => Math.abs(a.distPct) - Math.abs(b.distPct));
    return {
      zones: strong.slice(0, 8),
      nearestAbove: strong.filter(z => z.side === 'ABOVE').sort((a, b) => a.center - b.center)[0] || null,
      nearestBelow: strong.filter(z => z.side === 'BELOW').sort((a, b) => b.center - a.center)[0] || null,
      vwap: vw || null, volumeProfile: vp,
    };
  }

  const levels = { fibLevels, pivotLevels, roundLevels, volumeProfile, buildConfluence };

  /* ==========================================================================
     6. PATTERN ENGINE
     Паттерн сам по себе НЕ сигнал. У каждого есть confidence, инвалидация,
     условие подтверждения, цель и совместимость с режимом рынка.
     ========================================================================== */
  function candlePatterns(k) {
    const n = k.length - 1;
    if (n < 3) return [];
    const c = k[n], p1 = k[n - 1], p2 = k[n - 2];
    const atr = nz(last(atrArr(k, 14)));
    const body = (x) => Math.abs(x.c - x.o);
    const upWick = (x) => x.h - Math.max(x.c, x.o);
    const dnWick = (x) => Math.min(x.c, x.o) - x.l;
    const range = (x) => Math.max(1e-12, x.h - x.l);
    const bull = (x) => x.c > x.o, bear = (x) => x.c < x.o;
    const out = [];
    const add = (name, dir, conf, note) => out.push({ name, dir, confidence: conf, note: note || '', kind: 'candle' });

    if (bull(c) && bear(p1) && c.c > p1.o && c.o < p1.c && body(c) > body(p1)) add('Бычье поглощение', 'LONG', 0.6);
    if (bear(c) && bull(p1) && c.c < p1.o && c.o > p1.c && body(c) > body(p1)) add('Медвежье поглощение', 'SHORT', 0.6);
    if (dnWick(c) > body(c) * 2 && upWick(c) < body(c) && body(c) / range(c) < 0.4) add('Молот / пин-бар', 'LONG', 0.5);
    if (upWick(c) > body(c) * 2 && dnWick(c) < body(c) && body(c) / range(c) < 0.4) add('Падающая звезда / пин-бар', 'SHORT', 0.5);
    if (body(c) / range(c) < 0.1) add('Доджи (неопределённость)', null, 0.3);
    if (c.h < p1.h && c.l > p1.l) add('Внутренний бар', null, 0.35, 'сжатие перед импульсом');
    if (c.h > p1.h && c.l < p1.l) add('Внешний бар', c.c > c.o ? 'LONG' : 'SHORT', 0.4);
    if (bear(p2) && body(p1) / range(p1) < 0.3 && bull(c) && c.c > (p2.o + p2.c) / 2) add('Утренняя звезда', 'LONG', 0.55);
    if (bull(p2) && body(p1) / range(p1) < 0.3 && bear(c) && c.c < (p2.o + p2.c) / 2) add('Вечерняя звезда', 'SHORT', 0.55);
    if (bull(c) && bull(p1) && bull(p2) && c.c > p1.c && p1.c > p2.c && atr && body(c) > atr * 0.5) add('Три белых солдата', 'LONG', 0.55);
    if (bear(c) && bear(p1) && bear(p2) && c.c < p1.c && p1.c < p2.c && atr && body(c) > atr * 0.5) add('Три чёрные вороны', 'SHORT', 0.55);
    return out;
  }

  /** Линейная регрессия по точкам {i,p} — нужна для каналов/клиньев/треугольников. */
  function fitLine(pts) {
    if (!pts || pts.length < 2) return null;
    const n = pts.length;
    const sx = pts.reduce((s, q) => s + q.i, 0), sy = pts.reduce((s, q) => s + q.p, 0);
    const sxx = pts.reduce((s, q) => s + q.i * q.i, 0), sxy = pts.reduce((s, q) => s + q.i * q.p, 0);
    const d = n * sxx - sx * sx;
    if (!d) return null;
    const slope = (n * sxy - sx * sy) / d, intercept = (sy - slope * sx) / n;
    return { slope, intercept, at: (i) => slope * i + intercept };
  }

  function chartPatterns(k, sw) {
    const out = [];
    if (!k || k.length < 60 || !sw || sw.length < 4) return out;
    const n = k.length - 1, price = k[n].c;
    const atr = nz(last(atrArr(k, 14)));
    const tol = Math.max(atr * 0.5, price * 0.003);
    const highs = sw.filter(s => s.type === 'H').slice(-3);
    const lows = sw.filter(s => s.type === 'L').slice(-3);
    const relVol = nz(last(relVolArr(k, 20)), 1);
    const add = (o) => out.push(Object.assign({ kind: 'chart', volumeConfirmed: relVol > 1.1, regimes: [] }, o));

    // Двойная вершина / двойное дно: два экстремума на одном уровне + шея.
    if (highs.length >= 2) {
      const [a, b] = highs.slice(-2);
      if (Math.abs(a.p - b.p) <= tol && b.i - a.i >= 4) {
        const neck = Math.min(...k.slice(a.i, b.i + 1).map(c => c.l));
        add({
          name: 'Двойная вершина', dir: 'SHORT', confidence: 0.55,
          invalidation: Math.max(a.p, b.p) + tol * 0.5,
          confirmation: 'закрытие ниже шеи ' + neck.toFixed(6),
          target: neck - (Math.max(a.p, b.p) - neck),
          regimes: ['DISTRIBUTION', 'RANGE', 'WEAK_BULL', 'REVERSAL'],
        });
      }
    }
    if (lows.length >= 2) {
      const [a, b] = lows.slice(-2);
      if (Math.abs(a.p - b.p) <= tol && b.i - a.i >= 4) {
        const neck = Math.max(...k.slice(a.i, b.i + 1).map(c => c.h));
        add({
          name: 'Двойное дно', dir: 'LONG', confidence: 0.55,
          invalidation: Math.min(a.p, b.p) - tol * 0.5,
          confirmation: 'закрытие выше шеи ' + neck.toFixed(6),
          target: neck + (neck - Math.min(a.p, b.p)),
          regimes: ['ACCUMULATION', 'RANGE', 'WEAK_BEAR', 'REVERSAL'],
        });
      }
    }
    // Голова-плечи: три вершины, средняя выше, крайние примерно равны.
    if (highs.length === 3) {
      const [l, h, r] = highs;
      if (h.p > l.p && h.p > r.p && Math.abs(l.p - r.p) <= tol * 1.5) {
        const neck = Math.min(...k.slice(l.i, r.i + 1).map(c => c.l));
        add({
          name: 'Голова и плечи', dir: 'SHORT', confidence: 0.6,
          invalidation: h.p, confirmation: 'закрытие ниже шеи ' + neck.toFixed(6),
          target: neck - (h.p - neck), regimes: ['DISTRIBUTION', 'REVERSAL', 'WEAK_BULL'],
        });
      }
    }
    if (lows.length === 3) {
      const [l, h, r] = lows;
      if (h.p < l.p && h.p < r.p && Math.abs(l.p - r.p) <= tol * 1.5) {
        const neck = Math.max(...k.slice(l.i, r.i + 1).map(c => c.h));
        add({
          name: 'Перевёрнутая голова и плечи', dir: 'LONG', confidence: 0.6,
          invalidation: h.p, confirmation: 'закрытие выше шеи ' + neck.toFixed(6),
          target: neck + (neck - h.p), regimes: ['ACCUMULATION', 'REVERSAL', 'WEAK_BEAR'],
        });
      }
    }
    // Треугольники / клинья / канал — по наклонам линий максимумов и минимумов.
    if (highs.length >= 2 && lows.length >= 2) {
      const lh = fitLine(highs.map(s => ({ i: s.i, p: s.p })));
      const ll = fitLine(lows.map(s => ({ i: s.i, p: s.p })));
      if (lh && ll && price) {
        const sh = lh.slope / price * 100, sl = ll.slope / price * 100;   // наклон в %/бар
        const flat = 0.02;
        const conv = Math.abs(sh) > flat && Math.abs(sl) > flat && ((sh < 0 && sl > 0));
        if (Math.abs(sh) <= flat && sl > flat) add({ name: 'Восходящий треугольник', dir: 'LONG', confidence: 0.5, confirmation: 'пробой горизонтального сопротивления', regimes: ['ACCUMULATION', 'CONTRACTION', 'WEAK_BULL'] });
        else if (Math.abs(sl) <= flat && sh < -flat) add({ name: 'Нисходящий треугольник', dir: 'SHORT', confidence: 0.5, confirmation: 'пробой горизонтальной поддержки', regimes: ['DISTRIBUTION', 'CONTRACTION', 'WEAK_BEAR'] });
        else if (conv) add({ name: 'Симметричный треугольник', dir: null, confidence: 0.4, confirmation: 'пробой границы', regimes: ['CONTRACTION', 'RANGE'] });
        else if (sh > flat && sl > flat && sh < sl) add({ name: 'Восходящий клин', dir: 'SHORT', confidence: 0.45, confirmation: 'пробой нижней границы', regimes: ['DISTRIBUTION', 'REVERSAL'] });
        else if (sh < -flat && sl < -flat && sh > sl) add({ name: 'Нисходящий клин', dir: 'LONG', confidence: 0.45, confirmation: 'пробой верхней границы', regimes: ['ACCUMULATION', 'REVERSAL'] });
        else if (Math.abs(sh - sl) < flat && Math.abs(sh) > flat) add({ name: sh > 0 ? 'Восходящий канал' : 'Нисходящий канал', dir: sh > 0 ? 'LONG' : 'SHORT', confidence: 0.4, confirmation: 'отбой от границы канала', regimes: ['STRONG_BULL', 'STRONG_BEAR', 'WEAK_BULL', 'WEAK_BEAR'] });
      }
    }
    return out;
  }

  const patterns = { candlePatterns, chartPatterns, fitLine };

  /* ==========================================================================
     7. MULTI-TIMEFRAME ANALYSIS
     Таймфреймы не равноправны: старший задаёт контекст и право на сделку,
     средний — фазу, младший — только момент входа. Младший ТФ НИКОГДА не
     перебивает старший: он лишь уточняет тайминг внутри разрешённого
     направления.
     ========================================================================== */
  function tfSummary(k) {
    if (!k || k.length < 60) return { ok: false };
    const cl = k.map(c => c.c), n = cl.length - 1;
    const e21 = emaArr(cl, 21), e50 = emaArr(cl, 50), e200 = emaArr(cl, 200);
    const ad = adxArr(k, 14);
    const st = analyzeStructure(k);
    const rg = detectRegime(k, st);
    const emaDir = (e21[n] != null && e50[n] != null) ? (e21[n] > e50[n] ? 'LONG' : 'SHORT') : null;
    const above200 = e200[n] != null ? cl[n] > e200[n] : null;
    // Голос таймфрейма: структура важнее EMA, EMA важнее ничего.
    const dir = st.dir || emaDir;
    return {
      ok: true, dir, emaDir, above200, adx: Math.round(nz(ad.adx[n])),
      regime: rg.primary, volatility: rg.volatility, structure: st, regimeFull: rg,
      price: cl[n], bos: !!st.bos, choch: !!st.choch, sweep: st.sweep || null,
      sequence: st.sequence,
    };
  }

  /** Согласованность таймфреймов относительно направления dir: -1..+1. */
  function mtfAlignment(tfs, dir) {
    const w = { htf: 0.5, mid: 0.3, ltf: 0.2 };  // старший весит больше
    let score = 0, total = 0, agree = [], conflict = [];
    ['htf', 'mid', 'ltf'].forEach(key => {
      const t = tfs[key];
      if (!t || !t.ok || !t.dir) return;
      total += w[key];
      if (t.dir === dir) { score += w[key]; agree.push(key); }
      else { score -= w[key]; conflict.push(key); }
    });
    return { score: total ? score / total : 0, agree, conflict, counted: total > 0 };
  }

  /* ==========================================================================
     8. LIQUIDITY ENGINE
     Стакан/фандинг/OI приходят снаружи. Если их нет — честно available:false.
     Никаких правдоподобных выдуманных чисел: лучше пустота, чем ложь.
     ========================================================================== */
  function analyzeLiquidity(st, external) {
    const out = {
      available: false, source: 'none', spreadPct: null, imbalance: null,
      pools: [], sweep: null, notes: [],
    };
    if (st && st.ok) {
      // Из структуры ликвидность выводится честно: пулы = равные экстремумы.
      out.pools = []
        .concat((st.equalHighs || []).map(z => ({ p: z.p, side: 'ABOVE', label: 'равные максимумы' })))
        .concat((st.equalLows || []).map(z => ({ p: z.p, side: 'BELOW', label: 'равные минимумы' })));
      out.sweep = st.sweep || null;
      if (out.pools.length || out.sweep) { out.available = true; out.source = 'structure'; }
    }
    if (external && typeof external === 'object') {
      // Стакан, если его дал вызывающий: bid/ask объёмы и спред.
      if (isFinite(external.bestBid) && isFinite(external.bestAsk) && external.bestAsk > 0) {
        out.spreadPct = (external.bestAsk - external.bestBid) / external.bestAsk * 100;
        out.available = true; out.source = 'orderbook';
      }
      if (isFinite(external.bidVol) && isFinite(external.askVol) && (external.bidVol + external.askVol) > 0) {
        out.imbalance = (external.bidVol - external.askVol) / (external.bidVol + external.askVol);
      }
      if (isFinite(external.fundingRate)) out.fundingRate = external.fundingRate;
      if (isFinite(external.openInterest)) out.openInterest = external.openInterest;
    } else {
      out.notes.push('Стакан, фандинг и open interest недоступны — эти факторы не участвуют в оценке.');
    }
    return out;
  }

  /* ==========================================================================
     9. SIGNAL ENSEMBLE
     Ни один индикатор не голосует отдельно. Индикаторы, меряющие одно и то же,
     СВОРАЧИВАЮТСЯ в группу и дают один голос — иначе пять способов померить
     тренд превратились бы в пять «независимых подтверждений».
     ========================================================================== */
  const DEFAULT_WEIGHTS = {
    trend: 20, structure: 20, volume: 15, liquidity: 15,
    momentum: 10, htf: 10, pattern: 5, volatility: 5,
  };

  const DEFAULT_THRESHOLDS = {
    minConfidence: 60,     // ниже — не сделка
    minRR: 1.6,            // минимальное отношение к ближайшей реальной цели
    minRiskPct: 0.25,      // стоп ближе — это шум, а не стоп
    maxRiskPct: 3.0,       // стоп дальше — сетап слишком рыхлый
    maxVolPercentile: 0.97,
    minRelVolume: 0.5,
    maxSpreadPct: 0.15,
    maxSameSide: 2,
  };

  /** Каждая группа возвращает signed score в [-1..+1] и человекочитаемые заметки. */
  function scoreGroups(ctx) {
    const { k, st, rg, tfs, liq, cands, divs, pats } = ctx;
    const n = k.length - 1, cl = k.map(c => c.c), price = cl[n];
    const g = {};

    // --- ТРЕНД: пять способов померить одно и то же -> один голос ---
    {
      const e21 = emaArr(cl, 21), e50 = emaArr(cl, 50), e200 = emaArr(cl, 200);
      const ad = adxArr(k, 14), stx = supertrendArr(k, 10, 3), kama = kamaArr(cl, 10);
      const sub = [];
      if (e21[n] != null && e50[n] != null) sub.push(e21[n] > e50[n] ? 1 : -1);
      if (e50[n] != null && e200[n] != null) sub.push(e50[n] > e200[n] ? 1 : -1);
      if (ad.adx[n] != null) {
        const strength = clamp(nz(ad.adx[n]) / 40, 0, 1);
        sub.push((nz(ad.pdi[n]) > nz(ad.mdi[n]) ? 1 : -1) * strength);
      }
      if (stx.dir[n] != null) sub.push(stx.dir[n]);
      if (kama[n] != null && kama[n - 3] != null) sub.push(kama[n] > kama[n - 3] ? 1 : -1);
      g.trend = { score: sub.length ? mean(sub) : 0, note: 'EMA-стек, ADX/DI, Supertrend, KAMA' };
    }

    // --- СТРУКТУРА: направление + подтверждение слома ---
    {
      let s = 0;
      if (st.dir === 'LONG') s += 0.6; else if (st.dir === 'SHORT') s -= 0.6;
      if (st.bos) s += st.bos.dir === 'LONG' ? 0.4 : -0.4;
      if (st.choch) s += st.choch.dir === 'LONG' ? 0.3 : -0.3;
      g.structure = { score: clamp(s, -1, 1), note: (st.sequence || []).join(' → ') || 'структура не определена' };
    }

    // --- ОБЪЁМ: подтверждает ли поток направление ---
    {
      const obv = obvArr(k), cmf = cmfArr(k, 20), mfi = mfiArr(k, 14), rv = relVolArr(k, 20);
      const sub = [];
      if (obv[n] != null && obv[n - 5] != null) sub.push(obv[n] > obv[n - 5] ? 1 : -1);
      if (cmf[n] != null) sub.push(clamp(nz(cmf[n]) * 5, -1, 1));
      if (mfi[n] != null) sub.push(clamp((nz(mfi[n]) - 50) / 30, -1, 1));
      const relv = nz(rv[n], 1);
      // Слабый объём ослабляет ЛЮБОЙ вывод — гасим модуль голоса.
      const damp = clamp(relv / 1.2, 0.2, 1);
      g.volume = { score: (sub.length ? mean(sub) : 0) * damp, note: 'OBV/CMF/MFI, отн. объём ' + relv.toFixed(2), relVolume: relv };
    }

    // --- ЛИКВИДНОСТЬ: свипы и пулы (стакан, если дали) ---
    {
      let s = 0; const notes = [];
      if (liq.sweep) { s += liq.sweep.dir === 'LONG' ? 0.7 : -0.7; notes.push('свип ' + (liq.sweep.side === 'LOW' ? 'минимумов' : 'максимумов')); }
      if (liq.imbalance != null) { s += clamp(liq.imbalance, -1, 1) * 0.5; notes.push('дисбаланс стакана'); }
      // Близкий пул ликвидности — это магнит: цену туда тянет.
      const nearPool = (liq.pools || []).map(p => ({ ...p, d: Math.abs(p.p - price) / price }))
        .sort((a, b) => a.d - b.d)[0];
      if (nearPool && nearPool.d < 0.01) { s += nearPool.side === 'ABOVE' ? 0.2 : -0.2; notes.push('рядом пул ликвидности'); }
      g.liquidity = { score: clamp(s, -1, 1), note: notes.join(', ') || (liq.available ? 'без выраженных сигналов' : 'данных нет') };
    }

    // --- МОМЕНТУМ: шесть осцилляторов -> один голос ---
    {
      const rsi = rsiArr(cl, 14), mac = macdArr(cl), roc = rocArr(cl, 10),
        sto = stochArr(k, 14, 3), cci = cciArr(k, 20), uo = uoArr(k);
      const sub = [];
      if (rsi[n] != null) sub.push(clamp((rsi[n] - 50) / 25, -1, 1));
      if (mac.hist[n] != null && price) sub.push(clamp(mac.hist[n] / (price * 0.004), -1, 1));
      if (roc[n] != null) sub.push(clamp(roc[n] / 4, -1, 1));
      if (sto.k[n] != null) sub.push(clamp((sto.k[n] - 50) / 35, -1, 1));
      if (cci[n] != null) sub.push(clamp(cci[n] / 150, -1, 1));
      if (uo[n] != null) sub.push(clamp((uo[n] - 50) / 25, -1, 1));
      g.momentum = { score: sub.length ? mean(sub) : 0, note: 'RSI/MACD/ROC/Stoch/CCI/UO' };
    }

    // --- СТАРШИЕ ТАЙМФРЕЙМЫ: считаются отдельно, в analyze() ---
    g.htf = { score: 0, note: '' };

    // --- ПАТТЕРНЫ: усреднённые по confidence, только совместимые с режимом ---
    {
      const all = (pats.candle || []).concat(pats.chart || []);
      const usable = all.filter(p => p.dir && (!p.regimes || !p.regimes.length || p.regimes.includes(rg.primary)));
      let s = 0, w = 0;
      usable.forEach(p => { s += (p.dir === 'LONG' ? 1 : -1) * p.confidence; w += p.confidence; });
      g.pattern = { score: w ? clamp(s / w, -1, 1) * clamp(w, 0, 1) : 0, note: usable.map(p => p.name).slice(0, 3).join(', ') || 'нет' };
    }

    // --- ВОЛАТИЛЬНОСТЬ: не направление, а пригодность момента ---
    {
      let s = 0; const notes = [];
      if (rg.expansion && rg.direction) { s += rg.direction === 'LONG' ? 0.6 : -0.6; notes.push('расширение волатильности по тренду'); }
      if (rg.squeeze) { s += 0; notes.push('сжатие — движение впереди, направление неясно'); }
      if (rg.volatility === 'HIGH') { s *= 0.5; notes.push('высокая волатильность'); }
      g.volatility = { score: clamp(s, -1, 1), note: notes.join(', ') || ('ATR ' + rg.atrPct.toFixed(2) + '%') };
    }

    // --- ДИВЕРГЕНЦИИ подмешиваются в моментум (это его свойство) ---
    if (divs && divs.length) {
      const regular = divs.filter(d => d.type === 'REGULAR');
      const hidden = divs.filter(d => d.type === 'HIDDEN');
      let d = 0;
      regular.forEach(x => { d += x.dir === 'LONG' ? 0.5 : -0.5; });   // разворотные
      hidden.forEach(x => { d += x.dir === 'LONG' ? 0.3 : -0.3; });    // продолжение
      g.momentum.score = clamp(g.momentum.score + clamp(d, -0.6, 0.6), -1, 1);
      g.momentum.note += ' + дивергенции: ' + divs.map(x => x.type[0] + ':' + x.on + (x.dir === 'LONG' ? '↑' : '↓')).join(' ');
    }
    return g;
  }

  /* ==========================================================================
     10. CONFIDENCE ENGINE
     Confidence — оценка КАЧЕСТВА сетапа (сколько независимых источников
     согласны), а НЕ вероятность прибыли. 85 не означает «85% выигрышных».
     ========================================================================== */
  function confidenceBand(c) {
    if (c >= 90) return { band: 'EXTREME_CONFLUENCE', quality: 'A+', label: 'Экстремальное совпадение факторов' };
    if (c >= 80) return { band: 'STRONG_SETUP', quality: 'A', label: 'Сильный сетап' };
    if (c >= 70) return { band: 'VALID_SETUP', quality: 'B', label: 'Валидный сетап' };
    if (c >= 60) return { band: 'WATCH', quality: 'C', label: 'Наблюдать' };
    if (c >= 40) return { band: 'WEAK', quality: 'D', label: 'Слабо' };
    return { band: 'NO_TRADE', quality: 'F', label: 'Нет сделки' };
  }

  /* ==========================================================================
     11. RISK ENGINE
     Считает размер позиции ОТ РАССТОЯНИЯ ДО СТОПА, а не наоборот. Мартингейл
     запрещён архитектурно: функция вообще не принимает историю убытков как
     аргумент — увеличить риск «чтобы отыграться» нечем.
     ========================================================================== */
  function positionSize(o) {
    const balance = nz(o.balance), riskPct = nz(o.riskPct, 0.5);
    const entry = nz(o.entry), sl = nz(o.sl);
    const maxLev = Math.max(1, nz(o.maxLev, 10)), freeMargin = nz(o.freeMargin, balance);
    const out = { ok: false, reason: null, riskMoney: 0, notional: 0, margin: 0, lev: 1, qty: 0, liqDistPct: null };
    if (!(balance > 0) || !(entry > 0) || !(sl > 0)) { out.reason = 'нет данных для расчёта'; return out; }
    const stopDist = Math.abs(entry - sl) / entry;
    if (!(stopDist > 0)) { out.reason = 'нулевое расстояние до стопа'; return out; }

    let risk = riskPct;
    // Волатильность выше нормы -> меньше риск. Это не «оптимизация доходности»,
    // а защита капитала: тот же стоп в % цены при высокой волатильности
    // срабатывает чаще.
    if (o.volPercentile != null && o.volPercentile > 0.8) risk *= 0.6;
    else if (o.volPercentile != null && o.volPercentile < 0.25) risk *= 1.0;

    out.riskMoney = balance * (risk / 100);
    out.notional = out.riskMoney / stopDist;
    out.lev = clamp(Math.ceil(out.notional / Math.max(1, balance * 0.2)), 1, maxLev);
    out.margin = out.notional / out.lev;
    out.qty = out.notional / entry;
    // Ликвидация должна быть ЗА стопом, иначе стоп бессмысленен.
    out.liqDistPct = (1 / out.lev) * 0.95 * 100;
    if (out.liqDistPct <= stopDist * 100 * 1.2) { out.reason = 'ликвидация слишком близко к стопу'; return out; }
    if (out.margin < 10) { out.reason = 'размер позиции меньше минимального ($10)'; return out; }
    if (out.margin > freeMargin) { out.reason = 'не хватает свободной маржи'; return out; }
    out.ok = true;
    return out;
  }

  /** Корреляция доходностей двух серий. Нет данных — честно available:false. */
  function correlation(aCloses, bCloses, p) {
    p = p || 60;
    if (!aCloses || !bCloses) return { available: false, value: null };
    const n = Math.min(aCloses.length, bCloses.length);
    if (n < p + 2) return { available: false, value: null };
    const ra = [], rb = [];
    for (let i = n - p; i < n; i++) {
      if (!aCloses[i - 1] || !bCloses[i - 1]) continue;
      ra.push(aCloses[i] / aCloses[i - 1] - 1);
      rb.push(bCloses[i] / bCloses[i - 1] - 1);
    }
    if (ra.length < 10) return { available: false, value: null };
    const ma = mean(ra), mb = mean(rb);
    let cov = 0, va = 0, vb = 0;
    for (let i = 0; i < ra.length; i++) { const x = ra[i] - ma, y = rb[i] - mb; cov += x * y; va += x * x; vb += y * y; }
    const d = Math.sqrt(va * vb);
    return { available: !!d, value: d ? cov / d : null };
  }

  /**
   * Портфельный риск: три лонга в коррелированных монетах — это одна ставка
   * тройным размером, а не три идеи. Движок обязан это видеть.
   */
  function portfolioRisk(o) {
    const open = o.openPositions || [];
    const dir = o.direction;
    const out = { ok: true, blockers: [], warnings: [], sameSide: 0, exposurePct: 0, maxCorr: null };
    out.sameSide = open.filter(p => p.side === dir).length;
    const balance = nz(o.balance, 1);
    out.exposurePct = balance ? open.reduce((s, p) => s + nz(p.margin) * nz(p.lev, 1), 0) / balance * 100 : 0;

    if (out.sameSide >= nz(o.maxSameSide, 2)) out.blockers.push('уже ' + out.sameSide + ' позиц. в ту же сторону (корреляционный риск)');
    if (open.length >= nz(o.maxPositions, 3)) out.blockers.push('достигнут лимит одновременных позиций');
    // Дневной результат. Раньше поле называлось dailyLossPct и при этом
    // ожидало ОТРИЦАТЕЛЬНОЕ число: передав «потерял 5%» как 5, вызывающий
    // молча отключал дневной стоп. Теперь однозначно:
    //   dailyPnlPct  — знаковый результат дня (-5 = минус 5%);
    //   dailyLossPct — величина убытка без знака (5 = минус 5%).
    const dailyLoss = o.dailyPnlPct != null ? -nz(o.dailyPnlPct)
      : (o.dailyLossPct != null ? Math.abs(nz(o.dailyLossPct)) : null);
    if (dailyLoss != null && o.dailyStopPct != null && dailyLoss >= Math.abs(nz(o.dailyStopPct))) {
      out.blockers.push('сработал дневной стоп (минус ' + dailyLoss.toFixed(2) + '% при лимите ' + Math.abs(nz(o.dailyStopPct)) + '%)');
    }
    const dd = o.drawdownPct != null ? Math.abs(nz(o.drawdownPct)) : null;
    if (dd != null && o.maxDrawdownPct != null && dd >= Math.abs(nz(o.maxDrawdownPct))) {
      out.blockers.push('достигнута максимальная просадка (' + dd.toFixed(2) + '% при лимите ' + Math.abs(nz(o.maxDrawdownPct)) + '%)');
    }

    // Корреляция с уже открытыми — если вызывающий передал ценовые ряды.
    if (o.closesBySymbol && o.symbol) {
      let mx = null;
      open.forEach(p => {
        if (!p.symbol || p.symbol === o.symbol) return;
        const c = correlation(o.closesBySymbol[o.symbol], o.closesBySymbol[p.symbol]);
        if (c.available && (mx == null || Math.abs(c.value) > Math.abs(mx))) mx = c.value;
      });
      out.maxCorr = mx;
      if (mx != null && mx > 0.8 && out.sameSide >= 1) out.warnings.push('высокая корреляция с открытой позицией (' + mx.toFixed(2) + ')');
    }
    out.ok = out.blockers.length === 0;
    return out;
  }

  const risk = { positionSize, correlation, portfolioRisk };

  /* ==========================================================================
     12. ENTRY / STOP / TARGET ENGINE
     Стоп привязан к СТРУКТУРЕ (за экстремум + буфер ATR), а не к круглому
     проценту. Цели — к реальным уровням, а не к «хочу 3R».
     ========================================================================== */
  function buildTrade(ctx, dir, thresholds) {
    const { k, st, rg, conf } = ctx;
    const thr = Object.assign({}, DEFAULT_THRESHOLDS, thresholds || {});
    const n = k.length - 1, price = k[n].c;
    const atr = nz(last(atrArr(k, 14)));
    const out = {
      entry: price, sl: null, tps: [], rr: null, riskPct: null, invalidation: null,
      setup: null, target: null, targetSource: null, obstacles: [], cappedBy: null, slClamped: null,
    };
    if (!atr || !price) return out;

    const isLong = dir === 'LONG';
    // Стоп: за последним значимым экстремумом + буфер волатильности.
    const swingRef = isLong
      ? (st.lastLow ? st.lastLow.p : price - atr * 2)
      : (st.lastHigh ? st.lastHigh.p : price + atr * 2);
    let sl = isLong ? swingRef - atr * 0.5 : swingRef + atr * 0.5;

    // Санитарные границы стопа. Клампим ВНУТРЬ границ (коэффициент 1.05/0.95),
    // иначе стоп садится ровно на порог и NO-TRADE блокирует собственный же
    // результат клампа. Факт клампа сохраняем — это диагностика сетапа,
    // а не тихая правка чисел.
    const minDist = price * (thr.minRiskPct / 100) * 1.05;
    const maxDist = price * (thr.maxRiskPct / 100) * 0.95;
    let dist = Math.abs(price - sl);
    if (dist < minDist) { sl = isLong ? price - minDist : price + minDist; out.slClamped = 'MIN'; }
    else if (dist > maxDist) { sl = isLong ? price - maxDist : price + maxDist; out.slClamped = 'MAX'; }
    dist = Math.abs(price - sl);
    out.sl = sl;
    out.riskPct = dist / price * 100;
    const R = dist;

    /* --- ЦЕЛЬ ---------------------------------------------------------------
       Важное различие, которого не было в первой версии: БЛИЖАЙШАЯ зона по
       направлению сделки — это ПРЕПЯТСТВИЕ, а не цель. Если брать её за TP,
       получается арифметика вида «риск 2%, цель 0.3%» — RR 0.15, и движок сам
       себя блокирует на каждой второй свече.
       Правильно: цель — первый уровень ДАЛЬШЕ, чем minRR*R. Всё, что ближе, —
       препятствия: они не отменяют сделку сами по себе, но сильная зона
       внутри 1R означает, что идти некуда, и это честный отказ.
    -------------------------------------------------------------------------*/
    const dirOf = (p) => (isLong ? p - price : price - p);   // расстояние «по ходу» сделки
    const cands = [];
    (conf.zones || []).forEach(z => {
      if (dirOf(z.center) > 0) cands.push({ p: z.center, w: z.strength, src: (z.labels || []).slice(0, 2).join(' / ') || 'зона совпадения' });
    });
    const structLevels = isLong ? (st.resistance || []) : (st.support || []);
    structLevels.forEach(s => { if (dirOf(s.p) > 0) cands.push({ p: s.p, w: 2, src: isLong ? 'структурное сопротивление' : 'структурная поддержка' }); });
    // Измеренные цели графических паттернов — если паттерн смотрит туда же.
    ((ctx.pats && ctx.pats.chart) || []).forEach(pt => {
      if (pt.dir === dir && pt.target && isFinite(pt.target) && dirOf(pt.target) > 0) {
        cands.push({ p: pt.target, w: 2, src: 'цель паттерна «' + pt.name + '»' });
      }
    });
    cands.sort((a, b) => dirOf(a.p) - dirOf(b.p));

    const minTargetDist = R * thr.minRR;
    out.obstacles = cands.filter(c => dirOf(c.p) < minTargetDist)
      .map(c => ({ price: c.p, strength: c.w, distR: +(dirOf(c.p) / R).toFixed(2), label: c.src }));

    // Сильная зона на пути КЭПИРУЕТ реалистичную цель — отдельный блокер для
    // этого не нужен. Если до неё меньше minRR*R, RR провалится сам, и отказ
    // придёт с честной причиной «плохое RR», а не с ещё одним магическим
    // порогом. Слабые зоны (2 источника) путь не перекрывают — только warning.
    const capper = cands.find(c => c.w >= 3);
    const hit = cands.find(c => dirOf(c.p) >= minTargetDist);
    let target, targetSource;
    if (capper && (!hit || dirOf(capper.p) < dirOf(hit.p))) {
      target = capper.p;
      targetSource = 'первая сильная зона на пути: ' + capper.src;
      out.cappedBy = { price: capper.p, strength: capper.w, distR: +(dirOf(capper.p) / R).toFixed(2), label: capper.src };
    } else if (hit) { target = hit.p; targetSource = hit.src; }
    else {
      // Ни одного уровня достаточно далеко. Не выдумываем цель «на глазок»:
      // берём проекцию по диапазону последнего свинга и честно помечаем источник.
      const swingRange = (st.lastHigh && st.lastLow) ? Math.abs(st.lastHigh.p - st.lastLow.p) : atr * 3;
      const proj = Math.max(swingRange, atr * 2);
      target = isLong ? price + proj : price - proj;
      targetSource = 'проекция по диапазону свинга (сильных уровней впереди нет)';
    }
    // Верхняя граница: цель дальше 10R — это фантазия, а не план (потолок 1:10).
    if (dirOf(target) > R * 10) { target = isLong ? price + R * 10 : price - R * 10; targetSource += ' (обрезано до 1:10)'; }
    out.target = target;
    out.targetSource = targetSource;

    out.tps = [
      { label: 'TP1 (1R)', p: isLong ? price + R : price - R, part: 0.4 },
      { label: 'TP2 (2R)', p: isLong ? price + R * 2 : price - R * 2, part: 0.4 },
      { label: 'TP3 (' + targetSource + ')', p: target, part: 0.2 },
    ];
    out.rr = R ? Math.abs(target - price) / R : null;
    out.invalidation = isLong
      ? { price: sl, text: 'закрытие ниже ' + sl.toFixed(6) + ' (за структурным минимумом)' }
      : { price: sl, text: 'закрытие выше ' + sl.toFixed(6) + ' (за структурным максимумом)' };

    // Тип входа определяется режимом и тем, что реально произошло на графике.
    if (st.sweep && st.sweep.dir === dir) out.setup = 'LIQUIDITY_SWEEP';
    else if (rg.primary === 'BREAKOUT' || rg.primary === 'BREAKDOWN') out.setup = 'BREAKOUT';
    else if (rg.allow.meanRev) out.setup = 'MEAN_REVERSION';
    else if (st.bos && st.bos.dir === dir) out.setup = 'TREND_CONTINUATION';
    else if (st.choch && st.choch.dir === dir) out.setup = 'REVERSAL';
    else out.setup = 'PULLBACK';
    return out;
  }

  /* ==========================================================================
     13. NO-TRADE ENGINE
     Приоритетный модуль. Лучше пропустить двадцать движений, чем системно
     входить в плохие. Возвращает список блокеров — каждый с причиной.
     ========================================================================== */
  function noTradeCheck(ctx, dir, confidence, trade, thr) {
    const { rg, tfs, liq, k } = ctx;
    const blockers = [], warnings = [];
    const relVol = ctx.groups.volume.relVolume;

    if (!dir) blockers.push('направление не определено');
    if (rg.primary === 'CHOP') blockers.push('рынок в чопе — нет устойчивой структуры');
    if (confidence < thr.minConfidence) blockers.push('качество сетапа ниже порога (' + confidence + ' < ' + thr.minConfidence + ')');

    const align = ctx.alignment;
    if (align && align.counted && align.conflict.length >= 2) blockers.push('таймфреймы противоречат друг другу');
    if (align && align.counted && align.conflict.includes('htf')) blockers.push('старший таймфрейм против сделки');

    if (relVol != null && relVol < thr.minRelVolume) blockers.push('объём ниже нормы (' + relVol.toFixed(2) + ')');
    if (rg.volPercentile > thr.maxVolPercentile) blockers.push('аномальная волатильность');
    if (liq.spreadPct != null && liq.spreadPct > thr.maxSpreadPct) blockers.push('слишком широкий спред');

    if (trade) {
      if (trade.riskPct != null && trade.riskPct < thr.minRiskPct) blockers.push('стоп слишком близко — это шум, а не уровень');
      if (trade.riskPct != null && trade.riskPct > thr.maxRiskPct) warnings.push('широкий стоп: сетап рыхлый');
      if (trade.rr != null && trade.rr < thr.minRR) blockers.push('плохое соотношение риск/прибыль (1:' + nz(trade.rr).toFixed(2) + ')');
      if (trade.cappedBy && trade.cappedBy.distR < thr.minRR) {
        warnings.push('цель ограничена сильной зоной в ' + trade.cappedBy.distR + 'R (' + trade.cappedBy.label + ')');
      }
      if (trade.slClamped === 'MIN') warnings.push('структурный стоп был бы шумовым — расширен до минимально допустимого');
      if (trade.slClamped === 'MAX') warnings.push('структурный стоп слишком широк — обрезан до максимально допустимого, инвалидация сетапа наступит раньше структурного уровня');
      if (trade.obstacles && trade.obstacles.length) {
        warnings.push('на пути к цели ' + trade.obstacles.length + ' зона(ы) сопротивления движению');
      }
    }
    if (rg.primary === 'PANIC') warnings.push('паническое движение — исполнение может быть хуже расчётного');
    if (!liq.available) warnings.push('нет данных стакана — фактор ликвидности оценён только по структуре');
    if (ctx.dataQuality && ctx.dataQuality.synthetic) blockers.push('данные не биржевые (синтетические свечи)');

    return { blockers, warnings, allow: blockers.length === 0 };
  }

  /* ==========================================================================
     14. ГЛАВНАЯ ФУНКЦИЯ: analyze()
     ========================================================================== */
  function analyze(input) {
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const cfg = input || {};
    const weights = Object.assign({}, DEFAULT_WEIGHTS, cfg.weights || {});
    const thr = Object.assign({}, DEFAULT_THRESHOLDS, cfg.thresholds || {});
    const candles = cfg.candles || {};
    const primaryTf = cfg.primaryTf || '4h';
    const k = candles[primaryTf];

    const result = {
      version: VERSION, symbol: cfg.symbol || null, tf: primaryTf, ts: cfg.now || Date.now(),
      ok: false, direction: null, confidence: 0, band: 'NO_TRADE', entry_quality: 'F',
      regime: 'UNKNOWN', decision: 'NO_TRADE',
      reasons: [], risks: [], blockers: [],
      recommended_entry: null, stop_loss: null, take_profit: [], invalidation: null,
      rr: null, position_size: null, setup: null,
      analysis: null, ms: 0,
    };

    if (!k || k.length < 210) {
      result.blockers.push('недостаточно истории для анализа (нужно ≥210 баров ' + primaryTf + ')');
      result.ms = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0;
      return result;
    }

    // --- слои анализа ---
    const st = analyzeStructure(k);
    const rg = detectRegime(k, st);
    const sw = st.swings || [];
    const divs = findDivergences(k, sw);
    const pats = { candle: candlePatterns(k), chart: chartPatterns(k, sw) };
    const liq = analyzeLiquidity(st, cfg.orderbook);
    const conf = buildConfluence(k, st, candles[cfg.htfTf || '1d']);

    const tfs = {
      htf: candles[cfg.htfTf || '1d'] ? tfSummary(candles[cfg.htfTf || '1d']) : { ok: false },
      mid: tfSummary(k),
      ltf: candles[cfg.ltfTf || '1h'] ? tfSummary(candles[cfg.ltfTf || '1h']) : { ok: false },
    };

    const ctx = { k, st, rg, tfs, liq, conf, cands: candles, divs, pats, dataQuality: cfg.dataQuality || null };
    const groups = scoreGroups(ctx);
    ctx.groups = groups;

    // Предварительное направление — по взвешенной сумме без HTF-фактора.
    let pre = 0, preW = 0;
    Object.keys(weights).forEach(key => {
      if (key === 'htf') return;
      const gr = groups[key]; if (!gr) return;
      pre += weights[key] * gr.score; preW += weights[key];
    });
    const dir = pre > 0 ? 'LONG' : pre < 0 ? 'SHORT' : null;

    // Теперь HTF-фактор считается ОТНОСИТЕЛЬНО кандидата.
    const align = dir ? mtfAlignment(tfs, dir) : { score: 0, agree: [], conflict: [], counted: false };
    groups.htf = {
      score: align.score * (dir === 'SHORT' ? -1 : 1),
      note: align.counted ? ('согласны: ' + (align.agree.join(', ') || '—') + '; против: ' + (align.conflict.join(', ') || '—')) : 'старшие ТФ недоступны',
    };
    ctx.alignment = align;

    let total = 0, totalW = 0;
    Object.keys(weights).forEach(key => {
      const gr = groups[key]; if (!gr) return;
      total += weights[key] * gr.score; totalW += weights[key];
    });
    const raw = totalW ? total / totalW : 0;                 // -1..+1
    const confidence = Math.round(clamp(Math.abs(raw) * 100, 0, 100));
    const bandInfo = confidenceBand(confidence);

    const trade = dir ? buildTrade(ctx, dir, thr) : null;
    const nt = noTradeCheck(ctx, dir, confidence, trade, thr);

    // --- размер позиции и портфельные ограничения ---
    let size = null, port = null;
    if (dir && trade && cfg.account) {
      port = portfolioRisk({
        direction: dir, openPositions: cfg.account.openPositions || [], balance: cfg.account.balance,
        maxSameSide: thr.maxSameSide, maxPositions: cfg.account.maxPositions,
        dailyLossPct: cfg.account.dailyLossPct, dailyStopPct: cfg.account.dailyStopPct,
        drawdownPct: cfg.account.drawdownPct, maxDrawdownPct: cfg.account.maxDrawdownPct,
        closesBySymbol: cfg.closesBySymbol, symbol: cfg.symbol,
      });
      port.blockers.forEach(b => nt.blockers.push(b));
      port.warnings.forEach(w => nt.warnings.push(w));
      size = positionSize({
        balance: cfg.account.balance, riskPct: cfg.account.riskPct, entry: trade.entry, sl: trade.sl,
        maxLev: cfg.account.maxLev, freeMargin: cfg.account.freeMargin, volPercentile: rg.volPercentile,
      });
      if (!size.ok) nt.blockers.push('размер позиции: ' + size.reason);
    }

    // --- причины и риски человеческим языком (Market Explanation Engine) ---
    const reasons = [], risks = [];
    const dirWord = dir === 'LONG' ? 'вверх' : 'вниз';
    if (dir) {
      Object.keys(weights).forEach(key => {
        const gr = groups[key]; if (!gr) return;
        const aligned = (dir === 'LONG' && gr.score > 0.15) || (dir === 'SHORT' && gr.score < -0.15);
        const against = (dir === 'LONG' && gr.score < -0.15) || (dir === 'SHORT' && gr.score > 0.15);
        const nameMap = { trend: 'Тренд', structure: 'Структура', volume: 'Объём', liquidity: 'Ликвидность', momentum: 'Моментум', htf: 'Старшие ТФ', pattern: 'Паттерны', volatility: 'Волатильность' };
        if (aligned) reasons.push(nameMap[key] + ' за ' + dirWord + (gr.note ? ' (' + gr.note + ')' : ''));
        else if (against) risks.push(nameMap[key] + ' против сделки' + (gr.note ? ' (' + gr.note + ')' : ''));
      });
      if (st.bos && st.bos.dir === dir) reasons.push('BOS: слом структуры по направлению сделки');
      if (st.choch) risks.push('CHoCH: характер структуры менялся — тренд неустойчив');
      if (conf.nearestAbove && dir === 'LONG') risks.push('зона сопротивления в ' + conf.nearestAbove.distPct.toFixed(2) + '% выше (' + conf.nearestAbove.labels.join(', ') + ')');
      if (conf.nearestBelow && dir === 'SHORT') risks.push('зона поддержки в ' + Math.abs(conf.nearestBelow.distPct).toFixed(2) + '% ниже (' + conf.nearestBelow.labels.join(', ') + ')');
      if (rg.volatility === 'HIGH') risks.push('повышенная волатильность (перцентиль ' + Math.round(rg.volPercentile * 100) + ')');
    }
    nt.warnings.forEach(w => risks.push(w));

    // --- финальное решение ---
    const allow = nt.allow && !!dir && !!trade && (!size || size.ok);
    result.ok = true;
    result.direction = dir;
    result.confidence = confidence;
    result.band = bandInfo.band;
    result.entry_quality = bandInfo.quality;
    result.regime = rg.primary;
    result.decision = allow ? 'TRADE' : 'NO_TRADE';
    result.reasons = reasons;
    result.risks = risks;
    result.blockers = nt.blockers;
    result.setup = trade ? trade.setup : null;
    result.recommended_entry = trade ? trade.entry : null;
    result.stop_loss = trade ? trade.sl : null;
    result.take_profit = trade ? trade.tps : [];
    result.invalidation = trade ? trade.invalidation : null;
    result.rr = trade ? trade.rr : null;
    result.position_size = size && size.ok ? { margin: size.margin, lev: size.lev, qty: size.qty, riskMoney: size.riskMoney, notional: size.notional } : null;
    result.analysis = {
      groups, weights, alignment: align, regimeFull: rg, structure: st,
      divergences: divs, patterns: pats, liquidity: liq, confluence: conf,
      timeframes: {
        htf: tfs.htf.ok ? { dir: tfs.htf.dir, regime: tfs.htf.regime, adx: tfs.htf.adx, sequence: tfs.htf.sequence } : null,
        mid: tfs.mid.ok ? { dir: tfs.mid.dir, regime: tfs.mid.regime, adx: tfs.mid.adx, sequence: tfs.mid.sequence } : null,
        ltf: tfs.ltf.ok ? { dir: tfs.ltf.dir, regime: tfs.ltf.regime, adx: tfs.ltf.adx, sequence: tfs.ltf.sequence } : null,
      },
      portfolio: port, rawScore: Math.round(raw * 100),
    };
    result.ms = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0;
    return result;
  }

  /* ==========================================================================
     15. POSITION MANAGEMENT
     После входа анализ не заканчивается. Если сетап перестал быть валидным —
     позиция закрывается, не дожидаясь тейка.
     ========================================================================== */
  function managePosition(pos, ctx) {
    // pos: {side, entry, sl, tp, qty, openedAt, initialR}
    const actions = [];
    if (!pos || !ctx || !ctx.k) return actions;
    const k = ctx.k, n = k.length - 1, price = k[n].c;
    const atr = nz(last(atrArr(k, 14)));
    const isLong = pos.side === 'LONG';
    const R = Math.abs(nz(pos.entry) - nz(pos.sl));
    if (!R || !atr) return actions;
    const profitR = (isLong ? price - pos.entry : pos.entry - price) / R;

    // 1R -> частичная фиксация и перевод стопа в безубыток.
    if (profitR >= 1 && !pos.partialDone) actions.push({ type: 'PARTIAL_CLOSE', part: 0.4, reason: 'достигнут 1R' });
    if (profitR >= 1 && !pos.breakevenDone) actions.push({ type: 'MOVE_SL', to: pos.entry, reason: 'стоп в безубыток после 1R' });

    // Трейлинг по волатильности после 2R.
    if (profitR >= 2) {
      const trail = isLong ? price - atr * 1.5 : price + atr * 1.5;
      const better = isLong ? trail > nz(pos.sl) : trail < nz(pos.sl);
      if (better) actions.push({ type: 'MOVE_SL', to: trail, reason: 'трейлинг по ATR после 2R' });
    }
    // Трейлинг по структуре: за последним свингом.
    const st = ctx.st || analyzeStructure(k);
    if (profitR >= 1.5 && st.ok) {
      const ref = isLong ? (st.lastLow ? st.lastLow.p - atr * 0.3 : null) : (st.lastHigh ? st.lastHigh.p + atr * 0.3 : null);
      if (ref != null) {
        const better = isLong ? ref > nz(pos.sl) : ref < nz(pos.sl);
        if (better) actions.push({ type: 'MOVE_SL', to: ref, reason: 'трейлинг по структуре' });
      }
    }
    // Сетап сломан — выходим независимо от тейка.
    if (st.ok && st.choch && st.choch.dir !== pos.side) {
      actions.push({ type: 'EXIT', reason: 'CHoCH против позиции — исходный сетап больше не валиден' });
    }
    if (ctx.rg && ctx.rg.primary === 'PANIC') actions.push({ type: 'EXIT', reason: 'паническая волатильность' });
    return actions;
  }

  /* ==========================================================================
     ЭКСПОРТ
     ========================================================================== */
  return {
    VERSION, DEFAULT_WEIGHTS, DEFAULT_THRESHOLDS,
    analyze, managePosition, confidenceBand,
    indicators, structure, regime, divergence, levels, patterns, risk,
    tfSummary, mtfAlignment, analyzeLiquidity, scoreGroups, buildTrade, noTradeCheck,
    _util: { nz, clamp, mean, stdev, percentileOf },
  };
});

