// Проверяет, что mie.js реально грузится страницей и панель разбора рисуется.
// Живой URL из песочницы недоступен (прокси рвёт соединение у Chromium),
// поэтому грузим file:// и мокаем сеть через page.route().
// Playwright стоит глобально, а ESM не смотрит в NODE_PATH — резолвим явно.
// PW_PATH позволяет переопределить путь, если окружение другое.
import path from 'path';
import { createRequire } from 'module';
const require_ = createRequire(import.meta.url);
const PW = process.env.PW_PATH || '/opt/node22/lib/node_modules/playwright';
const { chromium } = require_(PW);

const FILE = 'file://' + path.resolve(process.cwd(), 'index.html');
let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + extra : '')); }
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

// Порядок важен: Playwright отдаёт приоритет ПОСЛЕДНЕМУ подходящему маршруту,
// поэтому конкретные правила регистрируются ПОСЛЕ общего.
await page.route('**/api/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
await page.route('**/api/config**', r => r.fulfill({
  status: 200, contentType: 'application/json',
  body: JSON.stringify({ prop: { maintenance: false }, bot: { maintenance: false }, pub: { wallet: {} } }),
}));
// Внешние котировки — блокируем, приложение обязано пережить это без падения.
await page.route(/(crypto\.com|binance\.com|coingecko\.com)/, r => r.abort());

// Панель бота живёт на экране сигналов, а туда не попасть без счёта —
// поэтому засеваем состояние до загрузки страницы.
// addInitScript выполняется при КАЖДОЙ навигации, включая reload, поэтому
// засеваем только пустое хранилище — иначе перезагрузка затирала бы то,
// что мы как раз и проверяем на выживание.
await page.addInitScript(() => {
  if (localStorage.getItem('nx_state')) return;
  const acc = {
    id: 'a1', label: 'Funded 10K', kind: 'funded', tier: 10000,
    balance: 10000, status: 'PASS', positions: [], startedAt: Date.now(),
  };
  localStorage.setItem('nx_state', JSON.stringify({
    accounts: [acc], activeAccId: 'a1', acc, positions: [], history: [],
    tier: 'vip', wallet: { balance: 0 }, chat: [], equityHist: [], appliedPays: [],
    bot: {}, spot: {}, adminQueue: [],
  }));
});

await page.goto(FILE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);

console.log('\n--- MIE в браузере ---');
const mieLoaded = await page.evaluate(() => typeof window.MIE === 'object' && !!window.MIE.analyze);
t('mie.js загружен и MIE.analyze доступен', mieLoaded);

const ver = await page.evaluate(() => window.MIE && window.MIE.VERSION);
t('версия движка отдаётся: ' + ver, !!ver);

// Прогоняем analyze() прямо в браузере — тот же файл, что в Node.
const res = await page.evaluate(() => {
  const k = [];
  let p = 100;
  for (let i = 0; i < 400; i++) {
    const prev = p; p = p * (1 + (Math.sin(i / 11) * 0.004) + 0.0012);
    k.push({ t: Date.now() - (400 - i) * 14400e3, o: prev, h: Math.max(prev, p) * 1.002, l: Math.min(prev, p) * 0.998, c: p, v: 100 + i });
  }
  const r = window.MIE.analyze({ symbol: 'TESTUSDT', primaryTf: '4h', candles: { '4h': k } });
  return { ok: r.ok, decision: r.decision, conf: r.confidence, regime: r.regime, blockers: r.blockers.length, ms: r.ms };
});
t('analyze() отработал в браузере', res.ok === true, JSON.stringify(res));
t('решение — TRADE или NO_TRADE', ['TRADE', 'NO_TRADE'].includes(res.decision), res.decision);
t('confidence в диапазоне 0..100', res.conf >= 0 && res.conf <= 100, String(res.conf));
t('режим определён', res.regime && res.regime !== 'UNKNOWN', res.regime);
t('analyze() быстрее 300мс в браузере', res.ms < 300, res.ms + 'ms');

console.log('\n--- аварийная остановка ---');
// Приложение открывается с онбординг-шитом, который перехватывает клики.
await page.click('#onbSkip', { timeout: 4000 }).catch(() => {});
await page.waitForTimeout(500);
// Кнопка появляется только на экране сигналов, где отрисована панель бота.
// В headless-раскладке нижний таб-бар не проходит проверку кликабельности
// Playwright, поэтому диспатчим клик напрямую — нам нужен обработчик, а не
// проверка попадания пальцем.
await page.$eval('.tab[data-go="signals"]', el => el.click());
await page.waitForTimeout(2000);
const emg2 = await page.evaluate(() => {
  const el = document.getElementById('botEmergency');
  return { present: !!el, label: el ? el.textContent.trim() : null };
});
t('кнопка аварийной остановки отрисована', emg2.present, JSON.stringify(emg2));
if (emg2.present) t('по умолчанию предлагает остановить', emg2.label === 'Остановить', emg2.label);

if (emg2.present) {
  // Нажимаем «Остановить» и проверяем, что флаг реально записался в состояние.
  await page.$eval('#botEmergency', el => el.click());
  await page.waitForTimeout(800);
  const st = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('nx_state') || '{}').bot || {}; } catch (e) { return {}; }
  });
  t('аварийный стоп записан в состояние', st.emergencyStop === true, JSON.stringify(st).slice(0, 160));
  t('бот выключен аварийным стопом', st.on !== true, 'on=' + st.on);
  t('причина остановки сохранена', typeof st.emergencyReason === 'string' && st.emergencyReason.length > 0, st.emergencyReason);

  // Перезагрузка: стоп обязан пережить рестарт приложения.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  await page.click('#onbSkip', { timeout: 3000 }).catch(() => {});
  await page.$eval('.tab[data-go="signals"]', el => el.click()).catch(() => {});
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => {
    const el = document.getElementById('botEmergency');
    let bot = {};
    try { bot = JSON.parse(localStorage.getItem('nx_state') || '{}').bot || {}; } catch (e) {}
    return { label: el ? el.textContent.trim() : null, stop: bot.emergencyStop };
  });
  t('стоп пережил перезагрузку', after.stop === true, JSON.stringify(after));
  t('кнопка предлагает снять стоп', after.label === 'Снять', after.label);
}

console.log('\n--- ошибки страницы ---');
// Ошибки самой песочницы, а не приложения: под file:// fetch к /api/* невозможен
// в принципе, и внешние котировки мы намеренно рвём.
const real = errors.filter(e => !/net::ERR|Failed to fetch|NetworkError|aborted|URL scheme "file"|scheme "file" is not supported/i.test(e));
t('нет JS-ошибок на странице', real.length === 0, real.slice(0, 3).join(' | '));

await browser.close();
console.log('\nпройдено: ' + pass + ', провалено: ' + fail);
process.exit(fail ? 1 : 0);
