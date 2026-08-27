// Проверка сессионных токенов и того, что чужое состояние больше не достать.
//   node api/_session.test.mjs
//
// До этой правки /api/state брал идентификатор прямо из запроса:
//   GET  /api/state?user=tg_1124112745            → чужие счета и заявки на вывод
//   POST /api/state {user:'tg_1124112745', ...}   → перезапись чужого состояния
// Проверено на живом продакшене — работало. Здесь эти же вызовы должны падать.

process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token:AAH-fake';
process.env.SUPABASE_URL = 'https://stub.local';
process.env.SUPABASE_SERVICE_KEY = 'stub-key';

const store = new Map();
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('/rest/v1/user_state')) {
    if ((opts.method || 'GET') === 'GET') {
      const m = u.match(/user_id=eq\.([^&]+)/);
      const id = m ? decodeURIComponent(m[1]) : '';
      const row = store.get(id);
      return { ok: true, status: 200, json: async () => (row ? [{ state: row }] : []) };
    }
    const body = JSON.parse(opts.body);
    store.set(body.user_id, body.state);
    return { ok: true, status: 201, json: async () => ([]), text: async () => '' };
  }
  return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
};

const { issueSession, verifySession } = await import('./_session.js');
const { default: state } = await import('./state.js');

function mockRes() {
  return {
    statusCode: 0, body: null,
    setHeader() {}, status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }, end() { return this; },
  };
}
const call = async (req) => { const res = mockRes(); await state(req, res); return res; };

const ALICE = 'tg_1124112745';
const BOB = 'tg_999000111';
const aliceToken = issueSession(ALICE);
const bobToken = issueSession(BOB);

let failed = 0;
const check = (n, c, x) => {
  if (c) console.log('  ok   ' + n);
  else { failed++; console.log('  FAIL ' + n + (x ? '\n       ' + JSON.stringify(x) : '')); }
};

console.log('\nтокены');
check('свой токен читается', verifySession(aliceToken) === ALICE);
check('подделанный токен отвергается', verifySession('v1.abc.def') === null);
check('мусор отвергается', verifySession('не токен') === null);
check('токен с испорченной подписью отвергается',
  verifySession(aliceToken.slice(0, -3) + 'AAA') === null);
check('просроченный токен отвергается', verifySession(issueSession(ALICE, -1000)) === null);

// Подмена полезной нагрузки без пересчёта подписи.
const forged = (() => {
  const payload = Buffer.from(JSON.stringify({ u: BOB, e: Date.now() + 1e6 })).toString('base64url');
  return 'v1.' + payload + '.' + aliceToken.split('.')[2];
})();
check('подмена пользователя в токене отвергается', verifySession(forged) === null);

console.log('\nсостояние: чужое недоступно');

// Алиса сохраняет своё состояние.
let r = await call({
  method: 'POST', headers: { authorization: 'Bearer ' + aliceToken },
  query: {}, body: { state: { secret: 'счета Алисы', accounts: [{ id: 'a1' }] } },
});
check('со своим токеном состояние сохраняется', r.statusCode === 200, r.body);

r = await call({ method: 'GET', headers: { authorization: 'Bearer ' + aliceToken }, query: {}, body: {} });
check('и читается обратно', r.body.state && r.body.state.secret === 'счета Алисы', r.body);

// Ровно старая атака.
r = await call({ method: 'GET', headers: {}, query: { user: ALICE }, body: {} });
check('?user=<чужой id> без токена больше не работает', r.statusCode === 401, r.body);

r = await call({
  method: 'POST', headers: {}, query: {},
  body: { user: ALICE, state: { secret: 'подменено злоумышленником' } },
});
check('POST с чужим user id без токена отвергается', r.statusCode === 401, r.body);

// Боб со своим настоящим токеном не видит и не трогает Алису.
r = await call({ method: 'GET', headers: { authorization: 'Bearer ' + bobToken }, query: { user: ALICE }, body: {} });
check('Боб не может прочитать состояние Алисы, даже указав её id',
  !r.body.state || r.body.state.secret !== 'счета Алисы', r.body);

r = await call({
  method: 'POST', headers: { authorization: 'Bearer ' + bobToken }, query: {},
  body: { user: ALICE, state: { secret: 'затёрто Бобом' } },
});
check('и не может перезаписать её состояние', r.statusCode === 200, r.body);

r = await call({ method: 'GET', headers: { authorization: 'Bearer ' + aliceToken }, query: {}, body: {} });
check('состояние Алисы цело', r.body.state.secret === 'счета Алисы', r.body);
check('запись Боба ушла в его собственную строку', store.get(BOB).secret === 'затёрто Бобом');

console.log('\nбез токена на сервере');
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.SESSION_SECRET;
r = await call({ method: 'GET', headers: { authorization: 'Bearer ' + aliceToken }, query: {}, body: {} });
check('без секрета доступ закрыт, а не открыт', r.statusCode === 503, r.body);
process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token:AAH-fake';

console.log(failed ? `\n${failed} проверок упало\n` : '\nвсе проверки пройдены\n');
process.exit(failed ? 1 : 0);
