// Проверка режима обслуживания без реальной базы.
//   node api/_settings.test.mjs
//
// Supabase подменяется на объект в памяти, Telegram — на заглушку.
// Проверяем то, что легко сломать глазами: независимость контуров,
// совместимость со старым плоским форматом и то, что ошибка записи
// действительно доходит до администратора, а не превращается в «ок».

import crypto from 'crypto';

process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token:AAH-fake';
process.env.SUPABASE_URL = 'https://stub.local';
process.env.SUPABASE_SERVICE_KEY = 'stub-key';
process.env.ADMIN_TG_ID = '777';

/** Подлинный initData — так его собирает Telegram. Права теперь только по подписи. */
function sign(id, token = process.env.TELEGRAM_BOT_TOKEN) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id, first_name: 'T' }),
  });
  const dataCheck = [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dataCheck).digest('hex'));
  return params.toString();
}
const OWNER = sign(777);
const STRANGER = sign(999);

let store = null;          // содержимое строки app_settings.value
let tableMissing = false;  // имитация «таблица не создана»

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('/rest/v1/app_settings')) {
    if (tableMissing) {
      return { ok: false, status: 404, text: async () => 'relation "public.app_settings" does not exist' };
    }
    if ((opts.method || 'GET') === 'GET') {
      return { ok: true, status: 200, json: async () => (store ? [{ value: store }] : []) };
    }
    store = JSON.parse(opts.body).value;
    return { ok: true, status: 201, text: async () => '' };
  }
  return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
};

const { default: config } = await import('./config.js');

function mockRes() {
  return {
    statusCode: 0, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end() { return this; },
  };
}
const call = async (req) => { const res = mockRes(); await config(req, res); return res; };
const get = () => call({ method: 'GET', query: {}, body: {}, headers: {} });
const post = (body) => call({ method: 'POST', body, query: {}, headers: {} });

let failed = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '\n       ' + JSON.stringify(extra) : '')); }
}

console.log('\nрежим обслуживания');

// --- исходное состояние ---
store = null;
let r = await get();
check('по умолчанию оба контура работают',
  r.statusCode === 200 && r.body.prop.maintenance === false && r.body.bot.maintenance === false, r.body);

// --- доступ ---
r = await post({ initData: STRANGER, scope: 'bot', maintenance: true });
check('чужой Telegram-аккаунт получает 403', r.statusCode === 403, r.body);
r = await get();
check('и ничего не меняет', r.body.bot.maintenance === false, r.body);

// --- присланный ID больше не является пропуском ---
r = await post({ admin: '777', scope: 'bot', maintenance: true });
check('присланный ID без подписи не даёт доступа', r.statusCode === 401, r.body);
r = await get();
check('и ничего не меняет', r.body.bot.maintenance === false, r.body);

// --- независимость контуров: главное требование ---
r = await post({ initData: OWNER, scope: 'bot', maintenance: true, message: 'бот обновляется', until: '21:00' });
check('бота можно включить на обслуживание', r.statusCode === 200 && r.body.bot.maintenance === true, r.body);
check('проп-фирма при этом продолжает работать', r.body.prop.maintenance === false, r.body);

r = await post({ initData: OWNER, scope: 'prop', maintenance: true, message: 'обновляем терминал' });
r = await get();
check('оба контура держатся одновременно',
  r.body.bot.maintenance === true && r.body.prop.maintenance === true, r.body);
check('у каждого свой текст',
  r.body.bot.message === 'бот обновляется' && r.body.prop.message === 'обновляем терминал', r.body);

r = await post({ initData: OWNER, scope: 'bot', maintenance: false });
r = await get();
check('бота выключили — проп-фирма осталась на обслуживании',
  r.body.bot.maintenance === false && r.body.prop.maintenance === true, r.body);

// --- совместимость: старый клиент читает плоские поля ---
check('плоское зеркало повторяет контур prop',
  r.body.maintenance === true && r.body.message === 'обновляем терминал', r.body);

// --- совместимость: старая запись в базе ---
store = { maintenance: true, message: 'старый формат', until: 'скоро' };
r = await get();
check('старая плоская запись читается как контур prop',
  r.body.prop.maintenance === true && r.body.prop.message === 'старый формат', r.body);
check('и не включает бота заодно', r.body.bot.maintenance === false, r.body);

// --- старый клиент шлёт POST без scope ---
store = null;
r = await post({ initData: OWNER, maintenance: true, message: 'без scope' });
check('POST без scope трактуется как prop',
  r.body.prop.maintenance === true && r.body.bot.maintenance === false, r.body);

// --- ошибка записи обязана быть видимой ---
store = null; tableMissing = true;
r = await post({ initData: OWNER, scope: 'prop', maintenance: true });
check('нет таблицы — отвечаем 500, а не «ок»', r.statusCode === 500, r.body);
check('и объясняем причину', /app_settings/.test(String(r.body && r.body.detail)), r.body);

// --- чтение не должно падать никогда ---
r = await get();
check('GET при недоступной базе не блокирует приложение',
  r.statusCode === 200 && r.body.prop.maintenance === false, r.body);

tableMissing = false;
console.log(failed ? `\n${failed} проверок упало\n` : '\nвсе проверки пройдены\n');
process.exit(failed ? 1 : 0);
