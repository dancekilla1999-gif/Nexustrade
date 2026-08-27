// Сессионные токены: доказательство того, что клиент — это именно тот
// пользователь, за которого себя выдаёт.
//
// ЗАЧЕМ ЭТО ПОЯВИЛОСЬ
//
// /api/state принимал идентификатор пользователя из тела запроса и не проверял
// ничего:
//
//     GET  /api/state?user=tg_1124112745          → всё состояние чужого счёта
//     POST /api/state {user:'tg_1124112745', ...} → перезапись чужого состояния
//
// То есть посторонний мог прочитать чужие счета, баланс и заявки на вывод,
// выдать себе фандед-счёт или стереть чужой прогресс. То же касалось /api/nexus,
// который двигал баланс токена по присланному user id.
//
// Теперь при входе выдаётся подписанный токен, и все пользовательские эндпоинты
// берут идентификатор ИЗ ТОКЕНА, а не из запроса. Подделать токен нельзя:
// он подписан HMAC на секрете, который есть только на сервере.
//
// Секрет производится от TELEGRAM_BOT_TOKEN, чтобы не заводить ещё одну
// переменную окружения. SESSION_SECRET, если задан, имеет приоритет.

import crypto from 'crypto';

const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 дней

function secret() {
  const s = process.env.SESSION_SECRET || process.env.TELEGRAM_BOT_TOKEN;
  if (!s) return null;
  return crypto.createHash('sha256').update('nexus-session|' + s).digest();
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** Выдаёт токен для пользователя. Вызывается только после реальной проверки входа. */
export function issueSession(userId, ttlMs = TTL_MS) {
  const key = secret();
  if (!key) return null;
  const payload = b64url(JSON.stringify({ u: String(userId), e: Date.now() + ttlMs }));
  const sig = crypto.createHmac('sha256', key).update(payload).digest('base64url');
  return `v1.${payload}.${sig}`;
}

/** @returns {string|null} идентификатор пользователя, либо null если токен недействителен. */
export function verifySession(token) {
  const key = secret();
  if (!key || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;

  const [, payload, sig] = parts;
  const expected = crypto.createHmac('sha256', key).update(payload).digest('base64url');

  // Постоянное время: обычное === выходит на первом несовпавшем байте и
  // по времени ответа выдаёт, сколько символов подписи угадано.
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const { u, e } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!u || !e || Date.now() > e) return null;
    return String(u);
  } catch (err) {
    return null;
  }
}

function tokenFrom(req) {
  const auth = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (auth && /^Bearer /i.test(auth)) return auth.slice(7).trim();
  return (req.body && req.body.token) || (req.query && req.query.token) || null;
}

/**
 * Кто выполняет запрос.
 *
 * @returns {{ok:true, userId:string} | {ok:false, status:number, error:string, detail:string}}
 */
export function requireUser(req) {
  if (!secret()) {
    // Проверить нечем — значит закрыто. Отсутствие возможности проверить
    // не равно успешной проверке.
    return {
      ok: false, status: 503, error: 'unconfigured',
      detail: 'На сервере не задан TELEGRAM_BOT_TOKEN — сессию проверить нечем.',
    };
  }
  const userId = verifySession(tokenFrom(req));
  if (!userId) {
    return {
      ok: false, status: 401, error: 'no_session',
      detail: 'Нужен действительный сеанс. Перезайдите в приложение.',
    };
  }
  return { ok: true, userId };
}
