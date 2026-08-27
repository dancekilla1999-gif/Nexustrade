// Проверка подлинности Telegram initData и определение админа.
// Файл начинается с "_", поэтому Vercel не публикует его как эндпоинт.
//
// ЗАЧЕМ ЭТО ПОЯВИЛОСЬ
//
// Раньше админские эндпоинты доверяли полю, которое присылал клиент:
//
//     GET  /api/admin?admin=566501781
//     POST /api/payments {action:'review', admin:'566501781', decision:'approved'}
//
// А сам этот ID — публичная константа в index.html в публичном репозитории.
// То есть любой человек, открывший исходник, мог читать выручку и список
// пользователей, подтверждать чужие оплаты и включать режим обслуживания.
// Идентификатор — это не пароль: он говорит, кем пользователь себя называет,
// и ничего не доказывает.
//
// Telegram подписывает initData HMAC-ключом, производным от токена бота.
// Токен — настоящий секрет и живёт только на сервере, поэтому подделать
// подпись нельзя, а проверить — можно. Именно подпись, а не ID, и является
// здесь доказательством.

import crypto from 'crypto';

/** Сколько живёт подпись. Защита от повтора перехваченного initData. */
const MAX_AGE_SECONDS = 24 * 60 * 60;

/**
 * Telegram-ID владельца.
 *
 * Значение по умолчанию не является секретом и не даёт доступа: этот же ID
 * лежит открытым текстом в index.html, а пройти проверку можно только с
 * действительной подписью Telegram. Переменная окружения ADMIN_TG_ID
 * перекрывает его, если владельца потребуется сменить.
 */
const DEFAULT_ADMIN_TG_ID = '566501781';

export function adminTgId() {
  return String(process.env.ADMIN_TG_ID || DEFAULT_ADMIN_TG_ID).trim();
}

/**
 * Проверяет подпись initData и возвращает пользователя Telegram либо null.
 *
 * @returns {{id:number, first_name?:string, username?:string}|null}
 */
export function verifyInitData(initData, botToken, maxAgeSeconds = MAX_AGE_SECONDS) {
  if (!initData || !botToken) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');

    const dataCheck = [...params.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const calc = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');

    // Сравнение постоянного времени: обычное === выходит раньше на первом
    // несовпавшем байте и по времени ответа выдаёт, сколько символов угадано.
    const a = Buffer.from(calc, 'hex');
    const b = Buffer.from(hash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    // Свежесть. Без неё однажды перехваченный initData работает вечно.
    const authDate = Number(params.get('auth_date') || 0);
    if (!authDate) return null;
    const age = Math.floor(Date.now() / 1000) - authDate;
    if (age < -60 || age > maxAgeSeconds) return null;

    const user = JSON.parse(params.get('user') || '{}');
    return user && user.id ? user : null;
  } catch (e) {
    return null;
  }
}

/**
 * Достаёт initData из запроса: тело для POST, query для GET.
 * Заголовок поддержан отдельно — с ним удобнее звать API из внешних клиентов.
 */
function initDataFrom(req) {
  return (
    (req.headers && (req.headers['x-telegram-init-data'] || req.headers['X-Telegram-Init-Data'])) ||
    (req.body && req.body.initData) ||
    (req.query && req.query.initData) ||
    null
  );
}

/**
 * Единственная проверка админа, которой стоит доверять.
 *
 * @returns {{ok:true, user:object} | {ok:false, status:number, error:string, detail:string}}
 */
export function requireAdmin(req) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    // Без токена подпись проверить нечем. Пропускать в этом случае нельзя:
    // отсутствие возможности проверить — это не то же самое, что проверка пройдена.
    return {
      ok: false, status: 503, error: 'unconfigured',
      detail: 'На сервере не задан TELEGRAM_BOT_TOKEN — подпись проверить нечем, доступ закрыт.',
    };
  }

  const initData = initDataFrom(req);
  if (!initData) {
    return {
      ok: false, status: 401, error: 'no_init_data',
      detail: 'Нет подписи Telegram. Откройте приложение через бота.',
    };
  }

  const user = verifyInitData(initData, token);
  if (!user) {
    return {
      ok: false, status: 401, error: 'bad_signature',
      detail: 'Подпись Telegram недействительна или устарела.',
    };
  }

  if (String(user.id) !== adminTgId()) {
    return {
      ok: false, status: 403, error: 'forbidden',
      detail: 'Этот аккаунт не является владельцем.',
    };
  }

  return { ok: true, user };
}
