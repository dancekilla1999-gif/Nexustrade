// Тесты шифрования ключей и подписи биржевых запросов.
// Запуск: node api/exchange.test.mjs
process.env.EXCHANGE_ENC_KEY = process.env.EXCHANGE_ENC_KEY || 'test-master-key-for-unit-tests-only-32b';

const { seal, open, maskKey, encryptionReady } = await import('./_crypto.js');
const { ADAPTERS, adapterFor, exchangeCatalog, _internal } = await import('./_exchanges.js');
const crypto = (await import('crypto')).default;

let pass = 0, fail = 0; const fails = [];
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; fails.push(name + ' -> ' + e.message); console.log('  FAIL ' + name + ' -> ' + e.message); }
}
const eq = (a, b, m) => { if (a !== b) throw new Error((m || '') + ' ожидалось ' + JSON.stringify(b) + ', получено ' + JSON.stringify(a)); };
const ok = (c, m) => { if (!c) throw new Error(m || 'ожидалось true'); };

console.log('\n--- шифрование ключей ---');
t('encryptionReady() истинно при заданном env', () => ok(encryptionReady() === true));
t('seal -> open возвращает исходную строку', () => {
  const s = 'my-super-secret-api-key-value';
  eq(open(seal(s, 'tg_1'), 'tg_1'), s);
});
t('шифротекст не содержит открытый текст', () => {
  const s = 'SECRETVALUE12345';
  ok(seal(s, 'tg_1').indexOf(s) === -1, 'секрет виден в шифротексте');
});
t('два шифрования одного текста дают РАЗНЫЙ шифротекст (случайный IV)', () => {
  const a = seal('same', 'tg_1'), b = seal('same', 'tg_1');
  ok(a !== b, 'IV не рандомизируется — это утечка по сравнению');
  eq(open(a, 'tg_1'), 'same');
  eq(open(b, 'tg_1'), 'same');
});
t('чужой AAD не расшифровывается (нельзя переставить строку другому юзеру)', () => {
  const c = seal('secret', 'tg_111');
  eq(open(c, 'tg_222'), null, 'строка другого пользователя открылась:');
  eq(open(c, 'tg_111'), 'secret');
});
t('порча шифротекста даёт null, а не мусор', () => {
  const c = seal('secret', 'tg_1');
  const parts = c.split('.');
  parts[3] = parts[3].slice(0, -2) + (parts[3].slice(-2) === 'AA' ? 'BB' : 'AA');
  eq(open(parts.join('.'), 'tg_1'), null);
});
t('порча тега аутентификации даёт null', () => {
  const c = seal('secret', 'tg_1').split('.');
  c[2] = c[2].slice(0, -2) + (c[2].slice(-2) === 'AA' ? 'BB' : 'AA');
  eq(open(c.join('.'), 'tg_1'), null);
});
t('мусор на входе не роняет open()', () => {
  [null, undefined, '', 'nonsense', 'v1.a.b', 'v2.a.b.c'].forEach(x => eq(open(x, 'tg_1'), null, String(x) + ':'));
});
t('пустая строка шифруется и открывается', () => eq(open(seal('', 'tg_1'), 'tg_1'), ''));
t('длинный секрет (2КБ) переживает цикл', () => {
  const s = 'x'.repeat(2048);
  eq(open(seal(s, 'tg_1'), 'tg_1'), s);
});
t('юникод в секрете не портится', () => {
  const s = 'пароль-Ω-🔑';
  eq(open(seal(s, 'tg_1'), 'tg_1'), s);
});

console.log('\n--- маска ключа ---');
t('маска показывает только края', () => eq(maskKey('ABCDEFGHIJKLMNOP'), 'ABCD…MNOP'));
t('короткий ключ не раскрывается целиком', () => ok(maskKey('short').length <= 3));
t('пустой ключ -> пустая маска', () => eq(maskKey(''), ''));

console.log('\n--- подпись Binance ---');
t('HMAC-SHA256 hex совпадает с эталоном из документации Binance', () => {
  // Пример из docs.binance.com (Signed Endpoint Examples)
  const secret = 'NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j';
  const query = 'symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559';
  eq(_internal.hmacHex(secret, query), 'c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71');
});
t('qs() кодирует и пропускает undefined/null', () => {
  eq(_internal.qs({ a: 1, b: undefined, c: null, d: 'x y' }), 'a=1&d=x%20y');
});

console.log('\n--- подпись OKX ---');
t('HMAC-SHA256 base64 совпадает с ручным расчётом', () => {
  const secret = 'testsecret';
  const msg = '2020-12-08T09:08:57.715Z' + 'GET' + '/api/v5/account/balance';
  const expect = crypto.createHmac('sha256', secret).update(msg).digest('base64');
  eq(_internal.hmacB64(secret, msg), expect);
});
t('base64-подпись отличается от hex-подписи того же сообщения', () => {
  ok(_internal.hmacB64('s', 'm') !== _internal.hmacHex('s', 'm'));
});

console.log('\n--- каталог адаптеров ---');
t('три биржи зарегистрированы', () => eq(Object.keys(ADAPTERS).sort().join(','), 'binance,bybit,okx'));
t('adapterFor нечувствителен к регистру', () => ok(adapterFor('BINANCE') === adapterFor('binance')));
t('adapterFor на мусор возвращает null', () => {
  [null, '', 'kraken', '../etc', {}].forEach(x => eq(adapterFor(x), null, String(x) + ':'));
});
t('passphrase требуется только у OKX', () => {
  eq(ADAPTERS.okx.needsPassphrase, true);
  eq(ADAPTERS.binance.needsPassphrase, false);
  eq(ADAPTERS.bybit.needsPassphrase, false);
});
t('каталог не содержит ни ключей, ни секретов, ни функций', () => {
  const j = JSON.stringify(exchangeCatalog());
  ok(!/secret|apiKey|passphrase"\s*:\s*"/i.test(j), 'в каталоге есть что-то похожее на секрет: ' + j);
  exchangeCatalog().forEach(e => {
    Object.values(e).forEach(v => ok(typeof v !== 'function', 'функция утекла в каталог'));
  });
});
t('у каждого адаптера есть полный набор методов', () => {
  Object.values(ADAPTERS).forEach(a => {
    ['probe', 'balances', 'positions', 'order'].forEach(m => ok(typeof a[m] === 'function', a.id + ' без метода ' + m));
  });
});

console.log('\n--- подпись реально уходит на биржу (fetch замокан) ---');
const realFetch = globalThis.fetch;
async function capture(fn) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts: opts || {} });
    return { ok: true, status: 200, text: async () => JSON.stringify({ retCode: 0, code: '0', result: {}, data: [{}] }) };
  };
  try { await fn(); } finally { globalThis.fetch = realFetch; }
  return calls;
}

const creds = { apiKey: 'KEY123456789', apiSecret: 'SECRET123456789', passphrase: 'pass' };

{
  const calls = await capture(() => ADAPTERS.binance.balances(creds));
  t('Binance: запрос ушёл', () => eq(calls.length, 1));
  t('Binance: X-MBX-APIKEY выставлен', () => eq(calls[0].opts.headers['X-MBX-APIKEY'], creds.apiKey));
  t('Binance: signature в URL присутствует', () => ok(/[?&]signature=[0-9a-f]{64}/.test(calls[0].url), calls[0].url));
  t('Binance: СЕКРЕТ в URL не попал', () => ok(calls[0].url.indexOf(creds.apiSecret) === -1, 'секрет в URL!'));
}
{
  const calls = await capture(() => ADAPTERS.bybit.positions(creds));
  t('Bybit: заголовки подписи выставлены', () => {
    const h = calls[0].opts.headers;
    eq(h['X-BAPI-API-KEY'], creds.apiKey);
    ok(/^[0-9a-f]{64}$/.test(h['X-BAPI-SIGN']), 'подпись не hex-SHA256: ' + h['X-BAPI-SIGN']);
    ok(Number(h['X-BAPI-TIMESTAMP']) > 1600000000000, 'timestamp неправдоподобный');
  });
  t('Bybit: секрет не в URL и не в заголовках', () => {
    const s = calls[0].url + JSON.stringify(calls[0].opts.headers);
    ok(s.indexOf(creds.apiSecret) === -1, 'секрет утёк в запрос!');
  });
}
{
  const calls = await capture(() => ADAPTERS.okx.balances(creds));
  t('OKX: заголовки подписи и passphrase выставлены', () => {
    const h = calls[0].opts.headers;
    eq(h['OK-ACCESS-KEY'], creds.apiKey);
    eq(h['OK-ACCESS-PASSPHRASE'], creds.passphrase);
    ok(/^[A-Za-z0-9+/]+=*$/.test(h['OK-ACCESS-SIGN']), 'подпись не base64');
    ok(/^\d{4}-\d{2}-\d{2}T/.test(h['OK-ACCESS-TIMESTAMP']), 'timestamp не ISO');
  });
  t('OKX: секрет не в URL и не в заголовках', () => {
    const s = calls[0].url + JSON.stringify(calls[0].opts.headers);
    ok(s.indexOf(creds.apiSecret) === -1, 'секрет утёк в запрос!');
  });
}
{
  const calls = await capture(() => ADAPTERS.binance.order(creds, { symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', qty: 0.01 }));
  t('Binance order: метод POST и параметры в query', () => {
    eq(calls[0].opts.method, 'POST');
    ok(/symbol=BTCUSDT/.test(calls[0].url) && /side=BUY/.test(calls[0].url) && /quantity=0.01/.test(calls[0].url), calls[0].url);
  });
}
{
  const calls = await capture(() => ADAPTERS.bybit.order(creds, { symbol: 'BTCUSDT', side: 'SELL', type: 'LIMIT', qty: 1, price: 50000 }));
  t('Bybit order: тело JSON, сторона переведена в Sell', () => {
    const b = JSON.parse(calls[0].opts.body);
    eq(b.side, 'Sell'); eq(b.orderType, 'Limit'); eq(b.price, '50000'); eq(b.category, 'linear');
  });
  t('Bybit order: подпись считается от ТЕЛА запроса', () => {
    const h = calls[0].opts.headers;
    const expect = crypto.createHmac('sha256', creds.apiSecret)
      .update(h['X-BAPI-TIMESTAMP'] + creds.apiKey + h['X-BAPI-RECV-WINDOW'] + calls[0].opts.body).digest('hex');
    eq(h['X-BAPI-SIGN'], expect);
  });
}

console.log('\n--- разбор ответов бирж ---');
async function withBody(json, fn) {
  const rf = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(json) });
  try { return await fn(); } finally { globalThis.fetch = rf; }
}
{
  const r = await withBody({ enableWithdrawals: true, enableFutures: true, ipRestrict: false },
    () => ADAPTERS.binance.probe(creds));
  t('Binance probe: право вывода распознано', () => { eq(r.ok, true); eq(r.canWithdraw, true); });
}
{
  const r = await withBody({ enableWithdrawals: false, enableFutures: true, ipRestrict: true },
    () => ADAPTERS.binance.probe(creds));
  t('Binance probe: ключ без вывода, с фьючерсами и IP-ограничением', () => {
    eq(r.canWithdraw, false); eq(r.canFutures, true); eq(r.ipRestricted, true);
  });
}
{
  const r = await withBody({ retCode: 0, result: { permissions: { Withdraw: ['x'], ContractTrade: ['y'] }, ips: '1.2.3.4' } },
    () => ADAPTERS.bybit.probe(creds));
  t('Bybit probe: Withdraw в permissions -> canWithdraw', () => { eq(r.canWithdraw, true); eq(r.canFutures, true); eq(r.ipRestricted, true); });
}
{
  const r = await withBody({ retCode: 0, result: { permissions: { ContractTrade: ['y'] }, ips: '' } },
    () => ADAPTERS.bybit.probe(creds));
  t('Bybit probe: без Withdraw -> canWithdraw false', () => { eq(r.canWithdraw, false); eq(r.ipRestricted, false); });
}
{
  const r = await withBody({ code: '0', data: [{ perm: 'read_only,withdraw,trade' }] }, () => ADAPTERS.okx.probe(creds));
  t('OKX probe: withdraw в perm распознан', () => { eq(r.canWithdraw, true); eq(r.canTrade, true); });
}
{
  const r = await withBody({ code: '0', data: [{ perm: 'read_only,trade' }] }, () => ADAPTERS.okx.probe(creds));
  t('OKX probe: без withdraw', () => { eq(r.canWithdraw, false); eq(r.canTrade, true); });
  t('OKX probe: ipRestricted честно null (биржа не сообщает)', () => eq(r.ipRestricted, null));
}
{
  const r = await withBody({ retCode: 10003, retMsg: 'API key is invalid' }, () => ADAPTERS.bybit.probe(creds));
  t('Bybit: retCode != 0 трактуется как ошибка, несмотря на HTTP 200', () => {
    eq(r.ok, false); ok(/invalid/i.test(r.error), r.error);
  });
}
{
  const r = await withBody({ code: '50111', msg: 'Invalid signature' }, () => ADAPTERS.okx.probe(creds));
  t('OKX: code != 0 трактуется как ошибка, несмотря на HTTP 200', () => { eq(r.ok, false); ok(/signature/i.test(r.error)); });
}
{
  const r = await withBody([{ asset: 'USDT', balance: '1000.5', availableBalance: '900.25' }, { asset: 'BNB', balance: '0' }],
    () => ADAPTERS.binance.balances(creds));
  t('Binance balances: нулевые активы отфильтрованы, числа приведены', () => {
    eq(r.assets.length, 1); eq(r.assets[0].asset, 'USDT'); eq(r.assets[0].total, 1000.5); eq(r.assets[0].free, 900.25);
  });
}
{
  const r = await withBody([{ symbol: 'BTCUSDT', positionAmt: '-0.5', entryPrice: '60000', markPrice: '59000', unRealizedProfit: '500', leverage: '10', liquidationPrice: '70000' }],
    () => ADAPTERS.binance.positions(creds));
  t('Binance positions: отрицательный объём -> SHORT, qty по модулю', () => {
    eq(r.positions[0].side, 'SHORT'); eq(r.positions[0].qty, 0.5); eq(r.positions[0].pnl, 500);
  });
}

console.log('\n=========================================');
console.log('пройдено: ' + pass + ', провалено: ' + fail);
if (fail) { console.log('\nПРОВАЛЫ:'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
