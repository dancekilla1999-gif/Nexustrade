// Интеграционный тест эндпоинта /api/exchange целиком: авторизация по токену
// сеанса, шифрование без EXCHANGE_ENC_KEY (вывод из токена бота), хранение в
// app_settings, отказ ключу с правом вывода, отсутствие секрета в ответах.
// Supabase и биржа замоканы через globalThis.fetch — в сеть ничего не уходит.
// Запуск: node api/_exchange_handler.test.mjs
delete process.env.EXCHANGE_ENC_KEY;                  // проверяем именно запасной путь
process.env.TELEGRAM_BOT_TOKEN = '123456:TEST-BOT-TOKEN-FOR-UNIT-TESTS';
process.env.SUPABASE_URL = 'https://sb.test';
process.env.SUPABASE_SERVICE_KEY = 'service-test-key';

const { default: handler } = await import('./exchange.js');
const { issueSession } = await import('./_session.js');
const { encryptionReady, masterKey } = await import('./_crypto.js');
const crypto = (await import('crypto')).default;

let pass = 0, fail = 0; const fails = [];
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; fails.push(name + ' -> ' + e.message); console.log('  FAIL ' + name + ' -> ' + e.message); }
}
const eq = (a, b, m) => { if (a !== b) throw new Error((m || '') + ' ожидалось ' + JSON.stringify(b) + ', получено ' + JSON.stringify(a)); };
const ok = (c, m) => { if (!c) throw new Error(m || 'ожидалось true'); };

/* ---- фейковый Supabase (app_settings) + фейковая биржа ---- */
const db = new Map();                 // key -> value(jsonb)
const log = [];                       // все исходящие запросы
let probeBody = { enableWithdrawals: false, enableFutures: true, enableSpotAndMarginTrading: true, ipRestrict: true };

globalThis.fetch = async (url, opts = {}) => {
  url = String(url); log.push({ url, opts });
  const json = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body });
  if (url.startsWith('https://sb.test/rest/v1/app_settings')) {
    const u = new URL(url);
    if (opts.method === 'DELETE') { const k = (u.searchParams.get('key') || '').replace(/^eq\./, ''); db.delete(k); return json(204, null); }
    if (opts.method === 'POST') { const b = JSON.parse(opts.body); db.set(b.key, b.value); return json(201, null); }
    const like = (u.searchParams.get('key') || '').replace(/^like\./, '');
    const re = new RegExp('^' + like.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    return json(200, [...db.entries()].filter(([k]) => re.test(k)).map(([key, value]) => ({ key, value })));
  }
  if (url.startsWith('https://api.binance.com/sapi/v1/account/apiRestrictions')) return json(200, probeBody);
  if (url.startsWith('https://fapi.binance.com/fapi/v2/balance')) return json(200, [{ asset: 'USDT', balance: '500', availableBalance: '400' }]);
  return json(404, { msg: 'unmocked ' + url });
};

function mkRes() {
  const r = { code: 200, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.end = () => r;
  return r;
}
const token = issueSession('tg_777');
async function call(method, { query = {}, body = null, auth = true } = {}) {
  const req = { method, query, body, headers: auth ? { authorization: 'Bearer ' + token } : {} };
  const res = mkRes(); await handler(req, res); return res;
}

console.log('\n--- шифрование без EXCHANGE_ENC_KEY ---');
t('ключ выводится из TELEGRAM_BOT_TOKEN', () => ok(encryptionReady()));
t('ключ шифрования ≠ секрету сессий (разные метки)', () => {
  const sess = crypto.createHash('sha256').update('nexus-session|' + process.env.TELEGRAM_BOT_TOKEN).digest();
  ok(!masterKey().equals(sess), 'одинаковый ключ для двух назначений');
});
{
  const r = await call('GET', { query: { action: 'catalog' }, auth: false });
  t('catalog доступен без токена и encryption:true', () => { eq(r.code, 200); eq(r.body.encryption, true); });
}

console.log('\n--- авторизация ---');
{
  const r = await call('GET', { query: { action: 'status' }, auth: false });
  t('status без токена -> 401', () => eq(r.code, 401));
}
{
  const r = await call('POST', { body: { action: 'balances', exchange: 'binance' }, auth: false });
  t('balances без токена -> 401', () => eq(r.code, 401));
}

console.log('\n--- подключение ---');
{
  const r = await call('POST', { body: { action: 'connect', exchange: 'binance', apiKey: 'KEY_ABCDEFGHIJKLMNOP', apiSecret: 'SECRET_0123456789ABCDEF' } });
  t('ключ без права вывода принят', () => { eq(r.code, 200, JSON.stringify(r.body)); eq(r.body.ok, true); });
  t('в ответе маска, а не ключ', () => { eq(r.body.keyMask, 'KEY_…MNOP'); ok(JSON.stringify(r.body).indexOf('SECRET_0123') === -1, 'секрет в ответе'); });
  t('строка легла в app_settings под exkeys:<user>:<exchange>', () => ok(db.has('exkeys:tg_777:binance'), [...db.keys()].join(',')));
  t('в базе секрет и ключ лежат ЗАШИФРОВАННЫМИ', () => {
    const v = JSON.stringify(db.get('exkeys:tg_777:binance'));
    ok(v.indexOf('SECRET_0123456789ABCDEF') === -1, 'секрет открытым текстом в базе!');
    ok(v.indexOf('KEY_ABCDEFGHIJKLMNOP') === -1, 'ключ открытым текстом в базе!');
    ok(/"api_secret_enc":"v1\./.test(v), 'нет шифротекста секрета');
  });
  t('маска сохранена для отображения', () => eq(db.get('exkeys:tg_777:binance').key_mask, 'KEY_…MNOP'));
}
{
  probeBody = { ...probeBody, enableWithdrawals: true };
  const r = await call('POST', { body: { action: 'connect', exchange: 'bybit_wrong', apiKey: 'K'.repeat(20), apiSecret: 'S'.repeat(20) } });
  t('неизвестная биржа -> 400', () => eq(r.code, 400));
  const r2 = await call('POST', { body: { action: 'connect', exchange: 'binance', apiKey: 'WITHDRAW_KEY_1234567', apiSecret: 'WITHDRAW_SEC_1234567' } });
  t('ключ С ПРАВОМ ВЫВОДА отклонён', () => { eq(r2.code, 400); eq(r2.body.error, 'withdrawal_enabled'); });
  t('отклонённый ключ НЕ записан (старая строка не тронута)', () => {
    eq(db.get('exkeys:tg_777:binance').key_mask, 'KEY_…MNOP');
    ok(JSON.stringify([...db.values()]).indexOf('WITHDRAW') === -1);
  });
  probeBody = { ...probeBody, enableWithdrawals: false };
}

console.log('\n--- статус и операции ---');
{
  const r = await call('GET', { query: { action: 'status' } });
  t('status перечисляет подключённую биржу', () => { eq(r.code, 200); eq(r.body.connected.length, 1); eq(r.body.connected[0].exchange, 'binance'); });
  t('status не содержит ни шифротекста, ни секрета', () => {
    const s = JSON.stringify(r.body);
    ok(!/api_secret_enc|api_key_enc|v1\./.test(s), 'внутренние поля утекли в status');
  });
  t('autoTradeAllowed = false', () => eq(r.body.autoTradeAllowed, false));
}
{
  const r = await call('POST', { body: { action: 'balances', exchange: 'binance' } });
  t('balances расшифровал ключ и сходил на биржу', () => { eq(r.code, 200, JSON.stringify(r.body)); eq(r.body.assets[0].asset, 'USDT'); });
  const last = log.filter(x => x.url.startsWith('https://fapi.binance.com')).pop();
  t('на биржу ушёл расшифрованный ключ в заголовке', () => eq(last.opts.headers['X-MBX-APIKEY'], 'KEY_ABCDEFGHIJKLMNOP'));
  t('секрет на биржу в URL не ушёл', () => ok(last.url.indexOf('SECRET_0123') === -1));
  t('last_used_at проставлен', () => ok(!!db.get('exkeys:tg_777:binance').last_used_at));
}
{
  const r = await call('POST', { body: { action: 'order', exchange: 'binance', symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', qty: 0.01, auto: true } });
  t('автоматический ордер запрещён (403 auto_trade_forbidden)', () => { eq(r.code, 403); eq(r.body.error, 'auto_trade_forbidden'); });
}
{
  const r = await call('POST', { body: { action: 'order', exchange: 'binance', symbol: 'bad symbol!', side: 'BUY', type: 'MARKET', qty: 1 } });
  t('кривой символ -> 400', () => eq(r.code, 400));
  const r2 = await call('POST', { body: { action: 'order', exchange: 'binance', symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', qty: -1 } });
  t('отрицательный объём -> 400', () => eq(r2.code, 400));
}
{
  const other = issueSession('tg_999');
  const req = { method: 'POST', query: {}, body: { action: 'balances', exchange: 'binance' }, headers: { authorization: 'Bearer ' + other } };
  const res = mkRes(); await handler(req, res);
  t('другой пользователь не видит чужую биржу (404 not_connected)', () => eq(res.code, 404));
}
{
  const r = await call('POST', { body: { action: 'disconnect', exchange: 'binance' } });
  t('disconnect удаляет строку', () => { eq(r.code, 200); ok(!db.has('exkeys:tg_777:binance')); });
}

console.log('\n=========================================');
console.log('пройдено: ' + pass + ', провалено: ' + fail);
if (fail) { console.log('\nПРОВАЛЫ:'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
