// Проверка авторизации админа по подписи Telegram.
//   node api/_telegram.test.mjs
//
// Главное, что здесь утверждается: одного идентификатора недостаточно.
// Раньше запрос вида ?admin=566501781 проходил, а этот ID лежит открытым
// текстом в index.html публичного репозитория — то есть подтвердить чужую
// оплату мог любой. Теперь нужна подпись, а её нельзя получить без токена бота.

import crypto from 'crypto';

const TOKEN = 'test-bot-token:AAH-fake';
process.env.TELEGRAM_BOT_TOKEN = TOKEN;
process.env.ADMIN_TG_ID = '566501781';

const { requireAdmin, verifyInitData, adminTgId } = await import('./_telegram.js');

/** Собирает подлинный initData так же, как это делает Telegram. */
function sign(user, { token = TOKEN, authDate = Math.floor(Date.now() / 1000) } = {}) {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    query_id: 'AAF',
    user: JSON.stringify(user),
  });
  const dataCheck = [...params.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dataCheck).digest('hex'));
  return params.toString();
}

const OWNER = { id: 566501781, first_name: 'Egor', username: 'owner' };
const STRANGER = { id: 111222333, first_name: 'Кто-то' };

let failed = 0;
const check = (name, cond, extra) => {
  if (cond) console.log('  ok   ' + name);
  else { failed++; console.log('  FAIL ' + name + (extra ? '\n       ' + JSON.stringify(extra) : '')); }
};

console.log('\nавторизация владельца');

// ── подпись как таковая ──
check('подлинная подпись владельца проходит',
  verifyInitData(sign(OWNER), TOKEN)?.id === OWNER.id);

check('подпись чужим токеном отвергается',
  verifyInitData(sign(OWNER, { token: 'другой-токен' }), TOKEN) === null);

check('подделанные данные при чужой подписи отвергаются', (() => {
  const good = sign(STRANGER);
  const p = new URLSearchParams(good);
  p.set('user', JSON.stringify(OWNER)); // подменяем пользователя, hash оставляем
  return verifyInitData(p.toString(), TOKEN) === null;
})());

check('устаревшая подпись отвергается (защита от повтора)',
  verifyInitData(sign(OWNER, { authDate: Math.floor(Date.now() / 1000) - 48 * 3600 }), TOKEN) === null);

check('подпись из будущего отвергается',
  verifyInitData(sign(OWNER, { authDate: Math.floor(Date.now() / 1000) + 3600 }), TOKEN) === null);

check('пустая строка отвергается', verifyInitData('', TOKEN) === null);
check('мусор отвергается', verifyInitData('hash=deadbeef&user=%7B%7D', TOKEN) === null);

// ── requireAdmin ──
console.log('\nrequireAdmin');

const post = (body) => ({ method: 'POST', body, query: {}, headers: {} });
const get = (query) => ({ method: 'GET', body: {}, query, headers: {} });

check('владелец с подписью — доступ есть',
  requireAdmin(post({ initData: sign(OWNER) })).ok === true);

check('подпись в query тоже принимается',
  requireAdmin(get({ initData: sign(OWNER) })).ok === true);

check('подпись в заголовке тоже принимается',
  requireAdmin({ method: 'GET', body: {}, query: {}, headers: { 'x-telegram-init-data': sign(OWNER) } }).ok === true);

/** Ровно та атака, которая работала раньше. */
const oldAttack = requireAdmin(post({ admin: '566501781' }));
check('старый способ — прислать ID владельца — больше не работает', oldAttack.ok === false, oldAttack);
check('и объясняет, что нет подписи', oldAttack.error === 'no_init_data', oldAttack);

const stranger = requireAdmin(post({ initData: sign(STRANGER) }));
check('чужой аккаунт с подлинной подписью получает 403',
  stranger.ok === false && stranger.status === 403, stranger);

const forged = requireAdmin(post({ initData: sign(OWNER, { token: 'украденный-не-тот' }) }));
check('подпись чужим токеном — 401', forged.ok === false && forged.status === 401, forged);

// ── отсутствие токена на сервере ──
delete process.env.TELEGRAM_BOT_TOKEN;
const unconfigured = requireAdmin(post({ initData: sign(OWNER) }));
check('без TELEGRAM_BOT_TOKEN доступ закрыт, а не открыт',
  unconfigured.ok === false && unconfigured.status === 503, unconfigured);
process.env.TELEGRAM_BOT_TOKEN = TOKEN;

// ── ADMIN_TG_ID ──
console.log('\nидентификатор владельца');
check('берётся из переменной окружения, когда она задана', adminTgId() === '566501781');
delete process.env.ADMIN_TG_ID;
check('без переменной берётся значение по умолчанию — тот же владелец',
  adminTgId() === '566501781');
check('и доступ по подписи продолжает работать',
  requireAdmin(post({ initData: sign(OWNER) })).ok === true);
process.env.ADMIN_TG_ID = '566501781';

console.log(failed ? `\n${failed} проверок упало\n` : '\nвсе проверки пройдены\n');
process.exit(failed ? 1 : 0);
