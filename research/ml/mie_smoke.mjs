// Дымовой тест MIE: грузим РОВНО тот файл mie.js, который пойдёт в прод,
// и прогоняем analyze() по реальным историческим свечам.
// Задача теста — не «показать прибыль», а убедиться, что движок:
//   1) не падает и не выдаёт NaN;
//   2) даёт вменяемое распределение режимов/confidence/решений;
//   3) не торгует «всегда» и не молчит «всегда».
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(process.cwd());
const src = fs.readFileSync(path.join(ROOT, 'mie.js'), 'utf8');
const mod = { exports: {} };
new Function('module', 'globalThis', src)(mod, globalThis);
const MIE = mod.exports;

const DATA = '/tmp/bt';
const files = fs.readdirSync(DATA).filter(f => f.endsWith('-USDT.json'));

/** Агрегация 1h -> N часов. Строго причинная: бар закрыт только когда набран целиком. */
function agg(k1h, hours) {
  const out = [];
  for (let i = 0; i + hours <= k1h.length; i += hours) {
    const s = k1h.slice(i, i + hours);
    out.push({
      t: s[0].t, o: s[0].o,
      h: Math.max(...s.map(x => x.h)), l: Math.min(...s.map(x => x.l)),
      c: s[s.length - 1].c, v: s.reduce((a, x) => a + x.v, 0),
    });
  }
  return out;
}

function deepFindBad(obj, pathStr = '', found = [], depth = 0) {
  if (depth > 6 || found.length > 5) return found;
  if (typeof obj === 'number') {
    if (!isFinite(obj)) found.push(pathStr + ' = ' + obj);
    return found;
  }
  if (Array.isArray(obj)) {
    for (let i = 0; i < Math.min(obj.length, 40); i++) deepFindBad(obj[i], pathStr + '[' + i + ']', found, depth + 1);
    return found;
  }
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) deepFindBad(obj[k], pathStr + '.' + k, found, depth + 1);
  }
  return found;
}

const stats = {
  calls: 0, ok: 0, trade: 0, noTrade: 0, errors: [],
  dirs: {}, regimes: {}, bands: {}, setups: {}, blockers: {},
  conf: [], rr: [], ms: [], nanSamples: [],
};

for (const f of files) {
  const k1h = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
  const k4h = agg(k1h, 4);
  const k1d = agg(k1h, 24);
  const sym = f.replace('.json', '').replace('-', '');

  // Идём по 4h-барам с шагом 6 (раз в сутки), начиная с 260-го — чтобы был прогрев.
  for (let i = 260; i < k4h.length; i += 6) {
    const tNow = k4h[i].t + 4 * 3600e3; // момент закрытия бара i
    const c4 = k4h.slice(0, i + 1);
    const cd = k1d.filter(b => b.t + 24 * 3600e3 <= tNow);
    const c1 = k1h.filter(b => b.t + 3600e3 <= tNow).slice(-600);

    let r;
    try {
      r = MIE.analyze({
        symbol: sym, primaryTf: '4h', now: tNow,
        candles: { '4h': c4, '1d': cd, '1h': c1 },
        account: { balance: 10000, riskPct: 1, maxLev: 20, freeMargin: 10000, openPositions: [] },
      });
    } catch (e) {
      stats.errors.push(sym + '@' + i + ': ' + e.message + '\n' + (e.stack || '').split('\n')[1]);
      if (stats.errors.length > 3) { console.log(stats.errors.join('\n\n')); process.exit(1); }
      continue;
    }
    stats.calls++;
    if (r.ok) stats.ok++;
    if (r.decision === 'TRADE') stats.trade++; else stats.noTrade++;
    stats.dirs[r.direction || 'null'] = (stats.dirs[r.direction || 'null'] || 0) + 1;
    stats.regimes[r.regime] = (stats.regimes[r.regime] || 0) + 1;
    stats.bands[r.band] = (stats.bands[r.band] || 0) + 1;
    if (r.setup) stats.setups[r.setup] = (stats.setups[r.setup] || 0) + 1;
    r.blockers.forEach(b => {
      const key = b.split('(')[0].trim().slice(0, 46);
      stats.blockers[key] = (stats.blockers[key] || 0) + 1;
    });
    stats.conf.push(r.confidence);
    if (r.rr != null) stats.rr.push(r.rr);
    stats.ms.push(r.ms);

    if (stats.nanSamples.length < 5) {
      const bad = deepFindBad({
        confidence: r.confidence, rr: r.rr, entry: r.recommended_entry, sl: r.stop_loss,
        tp: r.take_profit, size: r.position_size, groups: r.analysis && r.analysis.groups,
      });
      if (bad.length) stats.nanSamples.push(sym + '@' + i + ': ' + bad.join(', '));
    }
  }
}

const pctl = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(p * (s.length - 1))] : NaN; };
const sortEnt = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]);

console.log('=== MIE SMOKE TEST ===');
console.log('версия:', MIE.VERSION, '| пар:', files.length);
console.log('вызовов analyze():', stats.calls, '| ok:', stats.ok, '| ошибок:', stats.errors.length);
console.log('решение TRADE:', stats.trade, '(' + (100 * stats.trade / stats.calls).toFixed(1) + '%)  NO_TRADE:', stats.noTrade);
console.log('время analyze(): median', pctl(stats.ms, 0.5).toFixed(1) + 'ms, p95', pctl(stats.ms, 0.95).toFixed(1) + 'ms, max', Math.max(...stats.ms).toFixed(1) + 'ms');
console.log('\nconfidence: min', Math.min(...stats.conf), 'p25', pctl(stats.conf, .25), 'median', pctl(stats.conf, .5), 'p75', pctl(stats.conf, .75), 'p95', pctl(stats.conf, .95), 'max', Math.max(...stats.conf));
if (stats.rr.length) console.log('RR (когда сетап построен): median', pctl(stats.rr, .5).toFixed(2), 'p25', pctl(stats.rr, .25).toFixed(2), 'p95', pctl(stats.rr, .95).toFixed(2));
console.log('\nнаправление:', sortEnt(stats.dirs).map(([k, v]) => k + ' ' + v).join(', '));
console.log('\nрежимы:'); sortEnt(stats.regimes).forEach(([k, v]) => console.log('  ' + k.padEnd(22), v, (100 * v / stats.calls).toFixed(1) + '%'));
console.log('\nband:'); sortEnt(stats.bands).forEach(([k, v]) => console.log('  ' + k.padEnd(22), v, (100 * v / stats.calls).toFixed(1) + '%'));
console.log('\nsetup:'); sortEnt(stats.setups).forEach(([k, v]) => console.log('  ' + k.padEnd(22), v));
console.log('\nтоп блокеров NO-TRADE:'); sortEnt(stats.blockers).slice(0, 15).forEach(([k, v]) => console.log('  ' + String(v).padStart(6), k));
if (stats.nanSamples.length) { console.log('\n!!! NaN/Infinity:'); stats.nanSamples.forEach(s => console.log('  ' + s)); }
else console.log('\nNaN/Infinity: не найдено');
if (stats.errors.length) { console.log('\n!!! ОШИБКИ:'); stats.errors.slice(0, 3).forEach(e => console.log(e)); }
