// Проверка ограничения частоты запросов.
//   node api/_ratelimit.test.mjs
//
// Главное, что здесь защищается: отказ должен быть ОТКРЫТЫМ. Если Supabase
// недоступен или миграция rate_limits.sql ещё не выполнена, запросы обязаны
// проходить, а не блокироваться — иначе временная авария инфраструктуры,
// от которой лимит и не должен защищать, превращается в отказ всего входа
// для всех пользователей разом.

process.env.SUPABASE_URL = 'https://stub.local';
process.env.SUPABASE_SERVICE_KEY = 'stub-key';

let mode = 'allow'; // 'allow' | 'block' | 'unmigrated' | 'down'
const calls = [];
globalThis.fetch = async (url, opts = {}) => {
  calls.push(String(url));
  if (mode === 'down') throw new Error('network');
  if (mode === 'unmigrated') return { ok: false, status: 404, json: async () => ({}) };
  if (mode === 'block') {
    return { ok: true, status: 200, json: async () => ([{ allowed: false, remaining: 0, reset_in: 42 }]) };
  }
  return { ok: true, status: 200, json: async () => ([{ allowed: true, remaining: 4, reset_in: 60 }]) };
};

const { rateLimit, clientIp } = await import('./_ratelimit.js');

let failed = 0;
const check = (n, c, x) => {
  if (c) console.log('  ok   ' + n);
  else { failed++; console.log('  FAIL ' + n + (x ? '\n       ' + JSON.stringify(x) : '')); }
};

console.log('\nограничение частоты');

mode = 'allow';
let r = await rateLimit('auth:1.2.3.4', { limit: 20, windowSeconds: 300 });
check('в пределах лимита — пропускает', r.ok === true, r);

mode = 'block';
r = await rateLimit('auth:1.2.3.4', { limit: 20, windowSeconds: 300 });
check('лимит исчерпан — 429 с указанием, когда повторить',
  r.ok === false && r.status === 429 && r.retryAfter === 42, r);

console.log('\nоткрытый отказ');

mode = 'unmigrated';
r = await rateLimit('auth:1.2.3.4', { limit: 20, windowSeconds: 300 });
check('миграция не выполнена (RPC 404) — пропускает, а не блокирует', r.ok === true, r);

mode = 'down';
r = await rateLimit('auth:1.2.3.4', { limit: 20, windowSeconds: 300 });
check('Supabase недоступен — пропускает, а не блокирует', r.ok === true, r);

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;
const callsBefore = calls.length;
r = await rateLimit('auth:1.2.3.4', { limit: 20, windowSeconds: 300 });
check('не настроен вообще — пропускает без единого сетевого вызова',
  r.ok === true && calls.length === callsBefore, { added: calls.length - callsBefore });
process.env.SUPABASE_URL = 'https://stub.local';
process.env.SUPABASE_SERVICE_KEY = 'stub-key';

console.log('\nключи не хранятся сырыми');
mode = 'allow'; calls.length = 0;
await rateLimit('auth:203.0.113.7', { limit: 20, windowSeconds: 300 });
check('IP не попадает в URL запроса как есть — только хеш',
  calls.length > 0 && !calls[0].includes('203.0.113.7'), calls);

console.log('\nопределение IP клиента');
check('берёт первый адрес из X-Forwarded-For',
  clientIp({ headers: { 'x-forwarded-for': '198.51.100.9, 10.0.0.1' } }) === '198.51.100.9');
check('не падает без заголовков', clientIp({ headers: {} }) === 'unknown');

console.log(failed ? `\n${failed} проверок упало\n` : '\nвсе проверки пройдены\n');
process.exit(failed ? 1 : 0);
