// Проверяет апгрейд: премиальная палитра, TradingView как основной график,
// экран «Своя биржа» и безопасность формы ключей.
import path from 'path';
import fs from 'fs';
import http from 'http';
import { createRequire } from 'module';
const require_ = createRequire(import.meta.url);
const { chromium } = require_(process.env.PW_PATH || '/opt/node22/lib/node_modules/playwright');

// Под file:// относительный fetch('/api/...') падает на уровне схемы ДО того,
// как его увидит page.route — поэтому раздаём каталог по настоящему http,
// и перехват маршрутов начинает работать как в проде.
const ROOT = path.resolve(process.cwd());
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(String(req.url).split('?')[0]);
  const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
  // Не выпускаем за пределы каталога проекта.
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const FILE = 'http://127.0.0.1:' + server.address().port + '/index.html';
let pass = 0, fail = 0;
const t = (n, c, e) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (e ? ' -> ' + e : '')); } };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

let statusCalls = 0, connectBody = null;
const orderBodies = [];
// confirm()/alert() в тестах принимаем автоматически, но запоминаем текст.
const dialogs = [];
page.on('dialog', d => { dialogs.push({ type: d.type(), msg: d.message() }); d.accept(); });
await page.route('**/api/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
await page.route('**/api/config**', r => r.fulfill({
  status: 200, contentType: 'application/json',
  body: JSON.stringify({ prop: { maintenance: false }, bot: { maintenance: false }, pub: { wallet: {} } }),
}));
await page.route('**/api/exchange**', r => {
  const req = r.request();
  const url = req.url();
  if (url.includes('action=status')) {
    statusCalls++;
    return r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        exchanges: [
          { id: 'binance', name: 'Binance', needsPassphrase: false, helpUrl: 'https://example.test/b' },
          { id: 'okx', name: 'OKX', needsPassphrase: true, helpUrl: 'https://example.test/o' },
        ],
        connected: [{ exchange: 'binance', keyMask: 'ABCD…WXYZ', canTrade: true, canFutures: true, ipRestricted: false }],
        autoTradeAllowed: false,
      }),
    });
  }
  let b = {};
  try { b = JSON.parse(req.postData() || '{}'); } catch (e) {}
  if (b.action === 'connect') { connectBody = b; return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, exchange: b.exchange, keyMask: 'AAAA…ZZZZ' }) }); }
  if (b.action === 'balances') return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, assets: [{ asset: 'USDT', free: 900, total: 1000.5 }] }) });
  if (b.action === 'positions') return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, positions: [{ symbol: 'BTCUSDT', side: 'LONG', qty: 0.1, entry: 60000, mark: 61000, pnl: 100, lev: 5 }] }) });
  if (b.action === 'order') { orderBodies.push(b); return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, orderId: '424242', status: 'NEW' }) }); }
  return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});
await page.route(/(crypto\.com|binance\.com|coingecko\.com|tradingview\.com)/, r => r.abort());

await page.addInitScript(() => {
  if (localStorage.getItem('nx_state')) return;
  const acc = { id: 'a1', label: 'F', kind: 'funded', tier: 10000, balance: 10000, status: 'PASS', positions: [] };
  localStorage.setItem('nx_state', JSON.stringify({
    accounts: [acc], activeAccId: 'a1', acc, positions: [], history: [], tier: 'vip',
    wallet: { balance: 0 }, chat: [], equityHist: [], appliedPays: [], bot: {}, spot: {}, adminQueue: [],
  }));
  localStorage.setItem('nx_token', 'v1.test.token');
  localStorage.setItem('nx_user', JSON.stringify({ id: 1, username: 'test' }));
});

await page.goto(FILE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2200);
await page.click('#onbSkip', { timeout: 3000 }).catch(() => {});
await page.waitForTimeout(400);

console.log('\n--- палитра ---');
const pal = await page.evaluate(() => {
  const cs = getComputedStyle(document.documentElement);
  const g = (n) => cs.getPropertyValue(n).trim();
  return { acc: g('--accent-rgb'), grn: g('--green-rgb'), red: g('--red-rgb'), gold: g('--gold'), bg: g('--bg'), ink: g('--ink') };
});
t('каналы палитры объявлены', !!pal.acc && !!pal.grn && !!pal.red, JSON.stringify(pal));
t('--gold собирается из канала акцента', /^rgb\(/.test(pal.gold) || /^#/.test(pal.gold), pal.gold);
t('фон обсидиановый, не сине-неоновый', pal.bg.toLowerCase() === '#07080b', pal.bg);

// Ключевая проверка: JS-палитра для canvas обязана совпадать с CSS.
// PAL живёт внутри IIFE и снаружи недоступна, поэтому читаем её из текста
// скрипта и сравниваем с тем, что реально применено в :root.
const srcPal = await page.evaluate(() => {
  const src = [...document.querySelectorAll('script')].map(s => s.textContent).join('\n');
  const m = src.match(/const PAL = \{ acc:'([^']+)', grn:'([^']+)', red:'([^']+)'/);
  return m ? { acc: m[1], grn: m[2], red: m[3] } : null;
});
t('палитра CSS и JS не разъехалась (acc)', srcPal && srcPal.acc === pal.acc, JSON.stringify([srcPal && srcPal.acc, pal.acc]));
t('палитра CSS и JS не разъехалась (grn)', srcPal && srcPal.grn === pal.grn, JSON.stringify([srcPal && srcPal.grn, pal.grn]));
t('палитра CSS и JS не разъехалась (red)', srcPal && srcPal.red === pal.red, JSON.stringify([srcPal && srcPal.red, pal.red]));

const leftovers = await page.evaluate(() => {
  const src = [...document.querySelectorAll('style')].map(s => s.textContent).join('\n');
  return (src.match(/rgba\((34,228,255|232,197,88|43,255,158|34,255,122)/g) || []).length;
});
t('в CSS не осталось литералов старых тем', leftovers === 0, String(leftovers));

const grid = await page.evaluate(() => getComputedStyle(document.body).backgroundImage);
t('сетка-миллиметровка убрана', !/repeating-linear-gradient/.test(grid), grid.slice(0, 90));

console.log('\n--- TradingView как основной график ---');
const tvDefault = await page.evaluate(() => {
  try { localStorage.removeItem('nx_chartsrc'); } catch (e) {}
  const src = [...document.querySelectorAll('script')].map(s => s.textContent).join('\n');
  return /localStorage\.getItem\('nx_chartsrc'\)\s*\|\|\s*'tv'/.test(src);
});
t('по умолчанию выбран TradingView', tvDefault);
const tvOverrides = await page.evaluate(() => {
  const src = [...document.querySelectorAll('script')].map(s => s.textContent).join('\n');
  return /mainSeriesProperties\.candleStyle\.upColor/.test(src) && /paneProperties\.background/.test(src);
});
t('свечи и фон виджета переопределены под палитру', tvOverrides);

console.log('\n--- экран «Своя биржа» ---');
await page.$eval('[data-go="exchange"]', el => el.click());
await page.waitForTimeout(1200);
const exVisible = await page.evaluate(() => {
  const s = document.getElementById('screen-exchange');
  return { active: !!s && s.classList.contains('active'), len: (document.getElementById('exBody') || {}).innerHTML?.length || 0 };
});
t('экран открывается', exVisible.active, JSON.stringify(exVisible));
t('содержимое отрисовано', exVisible.len > 500, String(exVisible.len));
t('статус запрошен с сервера', statusCalls >= 1, String(statusCalls));

const txt = await page.evaluate(() => (document.getElementById('exBody') || {}).textContent || '');
t('предупреждение о настоящих деньгах показано', /настоящие деньги/i.test(txt));
t('сказано, что ключ с выводом не примут', /вывод/i.test(txt));
t('подключённая биржа показана с маской ключа', /ABCD…WXYZ/.test(txt), txt.slice(0, 120));
t('неограниченный по IP ключ отмечен', /IP не ограничен/.test(txt));
t('отсутствие автоторговли объяснено цифрами', /Автоторговли здесь нет/.test(txt) && /45\.5%/.test(txt));

console.log('\n--- безопасность формы ---');
const inputs = await page.evaluate(() => {
  const s = document.getElementById('exSecret'), k = document.getElementById('exKey');
  return { secretType: s && s.type, keyAuto: k && k.getAttribute('autocomplete'), secretAuto: s && s.getAttribute('autocomplete') };
});
t('секрет вводится как password', inputs.secretType === 'password', JSON.stringify(inputs));
t('автозаполнение отключено', inputs.keyAuto === 'off' && inputs.secretAuto === 'new-password', JSON.stringify(inputs));

// OKX требует passphrase — поле должно появиться при выборе.
await page.selectOption('#exSelect', 'okx');
await page.waitForTimeout(500);
t('для OKX появляется поле passphrase', await page.evaluate(() => !!document.getElementById('exPass')));
await page.selectOption('#exSelect', 'binance');
await page.waitForTimeout(500);
t('для Binance поля passphrase нет', await page.evaluate(() => !document.getElementById('exPass')));

// Отправка ключа и очистка полей.
await page.fill('#exKey', 'MYKEY1234567890');
await page.fill('#exSecret', 'MYSECRET1234567890');
await page.$eval('#exConnectBtn', el => el.click());
await page.waitForTimeout(1500);
t('ключ и секрет ушли на сервер', connectBody && connectBody.apiKey === 'MYKEY1234567890' && connectBody.apiSecret === 'MYSECRET1234567890',
  JSON.stringify(connectBody));
const afterFields = await page.evaluate(() => {
  const k = document.getElementById('exKey'), s = document.getElementById('exSecret');
  return { k: k ? k.value : null, s: s ? s.value : null };
});
t('поля очищены после отправки', afterFields.k === '' && afterFields.s === '', JSON.stringify(afterFields));

const stored = await page.evaluate(() => {
  const all = JSON.stringify(localStorage);
  return { hasKey: all.indexOf('MYKEY1234567890') >= 0, hasSecret: all.indexOf('MYSECRET1234567890') >= 0 };
});
t('ключ НЕ сохранён в localStorage', !stored.hasKey, JSON.stringify(stored));
t('секрет НЕ сохранён в localStorage', !stored.hasSecret, JSON.stringify(stored));

// Баланс и позиции
await page.$eval('[data-exbal]', el => el.click());
await page.waitForTimeout(900);
t('баланс отображается', /1000\.5/.test(await page.evaluate(() => document.getElementById('exBody').textContent)));
await page.$eval('[data-expos]', el => el.click());
await page.waitForTimeout(900);
t('позиции отображаются', /BTCUSDT/.test(await page.evaluate(() => document.getElementById('exBody').textContent)));

console.log('\n--- торговля: форма ордера ---');
await page.$eval('[data-extrade]', el => el.click());
await page.waitForTimeout(900);
t('кнопка «Торговать» раскрывает форму', await page.evaluate(() => !!document.getElementById('exOrderBox')));
t('по умолчанию сторона BUY', await page.evaluate(() => document.getElementById('exoSend').classList.contains('btn-green')));
t('поле цены скрыто для рыночного ордера', await page.evaluate(() => document.getElementById('exoPrice').style.display === 'none'));
await page.selectOption('#exoType', 'LIMIT');
t('для лимита поле цены появляется', await page.evaluate(() => document.getElementById('exoPrice').style.display !== 'none'));
await page.selectOption('#exoType', 'MARKET');

// Без символа — не отправляем.
const before = orderBodies.length;
await page.$eval('#exoSend', el => el.click());
await page.waitForTimeout(400);
t('пустой символ -> ордер не отправлен', orderBodies.length === before);

// Переключаем на SELL, заполняем, отправляем.
await page.fill('#exoSym', 'ethusdt');
await page.$eval('[data-exside="SELL"]', el => el.click());
await page.waitForTimeout(500);
t('символ пережил перерисовку при смене стороны', (await page.inputValue('#exoSym')) === 'ethusdt');
t('кнопка отправки стала красной для SELL', await page.evaluate(() => document.getElementById('exoSend').classList.contains('btn-red')));
await page.fill('#exoQty', '0.5');
dialogs.length = 0;
await page.$eval('#exoSend', el => el.click());
await page.waitForTimeout(1200);
t('перед отправкой было подтверждение с текстом про реальные деньги',
  dialogs.some(d => d.type === 'confirm' && /настоящие деньги/i.test(d.msg) && /ПРОДАТЬ 0\.5 ETHUSDT/.test(d.msg)), JSON.stringify(dialogs));
const ord = orderBodies[orderBodies.length - 1];
t('ордер ушёл на сервер с правильным телом',
  ord && ord.action === 'order' && ord.exchange === 'binance' && ord.symbol === 'ETHUSDT' && ord.side === 'SELL' && ord.type === 'MARKET' && ord.qty === 0.5 && ord.reduceOnly === false && ord.auto === undefined,
  JSON.stringify(ord));
t('символ приведён к верхнему регистру', ord && ord.symbol === 'ETHUSDT');
t('поле объёма очищено после отправки', (await page.inputValue('#exoQty')) === '');

console.log('\n--- торговля: закрытие позиции ---');
await page.$eval('[data-expos]', el => el.click());
await page.waitForTimeout(900);
t('у позиции есть кнопка «Закрыть»', await page.evaluate(() => !!document.querySelector('[data-exclose]')));
dialogs.length = 0;
const n0 = orderBodies.length;
await page.$eval('[data-exclose]', el => el.click());
await page.waitForTimeout(1200);
const cls = orderBodies[orderBodies.length - 1];
t('закрытие запросило подтверждение', dialogs.some(d => d.type === 'confirm' && /ЗАКРЫТЬ ПОЗИЦИЮ/.test(d.msg)));
t('закрытие LONG = SELL на весь объём с reduceOnly',
  orderBodies.length === n0 + 1 && cls.side === 'SELL' && cls.qty === 0.1 && cls.reduceOnly === true && cls.type === 'MARKET' && cls.symbol === 'BTCUSDT',
  JSON.stringify(cls));

console.log('\n--- ошибки страницы ---');
const real = errors.filter(e => !/net::ERR|Failed to fetch|NetworkError|aborted|URL scheme "file"/i.test(e));
t('нет JS-ошибок', real.length === 0, real.slice(0, 3).join(' | '));

await browser.close();
server.close();
console.log('\nпройдено: ' + pass + ', провалено: ' + fail);
process.exit(fail ? 1 : 0);
