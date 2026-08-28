// Проверка /api/payments после добавления сессионных токенов.
//   node api/payments.test.mjs
//
// Существует ради одной находки: когда requireUser() появился на сервере,
// клиентский код не обновили — index.html продолжал слать заявки без
// Authorization. Результат проверен на живом продакшене: КАЖДЫЙ вызов
// action:'create' и GET своих одобренных заявок отвечал 401. То есть с
// момента того коммита ни один пользователь не мог купить челлендж,
// оформить подписку или запросить выплату, и ни одна одобренная оплата
// не применялась автоматически — тихая регрессия посреди работы над
// безопасностью.
//
// Тесты ниже держат оба конца одновременно: сервер обязан требовать токен
// (иначе исходная дыра открылась бы снова), и с настоящим токеном обычный
// путь обязан работать (иначе открывается новая, обратная поломка).

process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token:AAH-fake';
process.env.SUPABASE_URL = 'https://stub.local';
process.env.SUPABASE_SERVICE_KEY = 'stub-key';
process.env.ADMIN_TG_ID = '566501781';

let nextId = 1;
const rows = new Map(); // id -> row

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = opts.method || 'GET';

  if (u.includes('/rest/v1/rpc/rate_limit_hit')) {
    // Миграция ещё не выполнена в тестовом окружении — открытый отказ:
    // модуль _ratelimit.js должен пропускать запрос, когда RPC недоступен.
    return { ok: false, status: 404, json: async () => ({}) };
  }

  if (u.includes('/rest/v1/payments')) {
    if (method === 'GET') {
      const userMatch = u.match(/user_id=eq\.([^&]+)/);
      const statusMatch = u.match(/status=eq\.([^&]+)/);
      let list = [...rows.values()];
      if (userMatch) list = list.filter((r) => r.user_id === decodeURIComponent(userMatch[1]));
      if (statusMatch) list = list.filter((r) => r.status === decodeURIComponent(statusMatch[1]));
      return { ok: true, status: 200, json: async () => list };
    }
    if (method === 'POST') {
      const body = JSON.parse(opts.body);
      const row = { id: nextId++, applied: false, status: 'pending', ...body };
      rows.set(row.id, row);
      return { ok: true, status: 201, json: async () => [row] };
    }
    if (method === 'PATCH') {
      const idMatch = u.match(/id=eq\.([^&]+)/);
      const userMatch = u.match(/user_id=eq\.([^&]+)/);
      const id = idMatch ? Number(decodeURIComponent(idMatch[1])) : null;
      const row = id != null ? rows.get(id) : null;
      // Симулируем PostgREST: фильтр по user_id в URL — если не совпадает,
      // ни одна строка не подходит и обновление молча ничего не меняет.
      if (row && (!userMatch || row.user_id === decodeURIComponent(userMatch[1]))) {
        Object.assign(row, JSON.parse(opts.body));
        return { ok: true, status: 200, json: async () => [row] };
      }
      return { ok: true, status: 200, json: async () => [] };
    }
  }
  return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
};

const { issueSession } = await import('./_session.js');
const { default: payments } = await import('./payments.js');

function mockRes() {
  return {
    statusCode: 0, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end() { return this; },
  };
}
const call = async (req) => { const res = mockRes(); await payments(req, res); return res; };

const ALICE = 'tg_1124112745';
const MALLORY = 'tg_666000111';
const aliceToken = issueSession(ALICE);
const malloryToken = issueSession(MALLORY);

let failed = 0;
const check = (n, c, x) => {
  if (c) console.log('  ok   ' + n);
  else { failed++; console.log('  FAIL ' + n + (x ? '\n       ' + JSON.stringify(x) : '')); }
};

console.log('\nсоздание заявки (action:create)');

// Ровно то, что делал клиент до исправления: без Authorization.
let r = await call({
  method: 'POST', headers: {}, query: {},
  body: { action: 'create', user: ALICE, kind: 'challenge', plan: 'Test', amount: 25, network: 'TON' },
});
check('без токена отклоняется', r.statusCode === 401, r.body);
check('и заявка не создаётся', rows.size === 0);

// Ровно то, что теперь делает исправленный клиент: c Authorization, без user в теле.
r = await call({
  method: 'POST', headers: { authorization: 'Bearer ' + aliceToken }, query: {},
  body: { action: 'create', kind: 'challenge', plan: 'Challenge $25,000', amount: 25, network: 'TON' },
});
check('с токеном заявка создаётся', r.statusCode === 200 && r.body.ok, r.body);
check('user_id берётся из токена, а не из тела', r.body.payment.user_id === ALICE, r.body);

// Даже если тело пытается назвать другого пользователя — токен главнее.
r = await call({
  method: 'POST', headers: { authorization: 'Bearer ' + malloryToken }, query: {},
  body: { action: 'create', user: ALICE, kind: 'challenge', plan: 'x', amount: 10, network: 'TON' },
});
check('подмена user в теле не работает — заявка уходит настоящему автору',
  r.body.payment.user_id === MALLORY, r.body);

console.log('\nсвои одобренные заявки (для автоприменения)');

const approvedId = [...rows.values()].find((row) => row.user_id === ALICE).id;
rows.get(approvedId).status = 'approved';

r = await call({ method: 'GET', headers: {}, query: { user: ALICE, status: 'approved' }, body: {} });
check('без токена — 401 (старая дыра закрыта)', r.statusCode === 401, r.body);

r = await call({ method: 'GET', headers: { authorization: 'Bearer ' + aliceToken }, query: { status: 'approved' }, body: {} });
check('с токеном возвращает именно свою одобренную заявку',
  r.statusCode === 200 && r.body.payments.length === 1 && r.body.payments[0].id === approvedId, r.body);

r = await call({ method: 'GET', headers: { authorization: 'Bearer ' + malloryToken }, query: { status: 'approved' }, body: {} });
check('чужой токен не видит заявку Алисы',
  !r.body.payments.some((p) => p.id === approvedId), r.body);

console.log('\nотметка «применена» (action:applied)');

r = await call({
  method: 'POST', headers: { authorization: 'Bearer ' + malloryToken }, query: {},
  body: { action: 'applied', id: approvedId },
});
check('чужим токеном пометить заявку Алисы не выйдет', r.statusCode === 200, r.body);
check('и она остаётся неприменённой', rows.get(approvedId).applied === false);

r = await call({
  method: 'POST', headers: { authorization: 'Bearer ' + aliceToken }, query: {},
  body: { action: 'applied', id: approvedId },
});
check('своим токеном — применяется', r.statusCode === 200 && rows.get(approvedId).applied === true, r.body);

console.log(failed ? `\n${failed} проверок упало\n` : '\nвсе проверки пройдены\n');
process.exit(failed ? 1 : 0);
