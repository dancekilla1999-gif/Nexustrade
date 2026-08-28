// Ограничение частоты запросов.
//
// ПОЧЕМУ СЧЁТЧИК ЖИВЁТ В POSTGRES, А НЕ В ПАМЯТИ ПРОЦЕССА
//
// Vercel-функции не хранят состояние между вызовами и часто стартуют на
// новом инстансе — счётчик в переменной модуля обнулился бы на первом же
// холодном старте, а под реальной нагрузкой холодные старты как раз и
// учащаются. То есть лимит переставал бы действовать именно тогда, когда
// он нужнее всего. Поэтому счётчик хранится в одной строке на ключ в
// Supabase, и инкремент атомарный — его делает функция `rate_limit_hit`
// (api/rate_limits.sql), а не JS: между "прочитать счётчик" и "записать
// новый" через REST-запрос гонка была бы возможна.
//
// ЧЕСТНО О ГРАНИЦАХ
//
// Это защита от навязчивого клиента (скрипт, который спамит регистрации
// или заявки на оплату), а не периметр от DDoS: сама проверка лимита — это
// ещё один вызов Supabase, и его тоже можно перегрузить. Отказ — открытый:
// если Supabase недоступен, запрос пропускается, а не блокируется. Ограничение
// частоты не должно превращать чужую аварию в аварию для всех пользователей.

import crypto from 'crypto';

function sb() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  return url && key ? { url, key } : null;
}

/** IP клиента за прокси Vercel. Возвращает 'unknown', если определить нечем. */
export function clientIp(req) {
  const xf = req.headers && (req.headers['x-forwarded-for'] || req.headers['X-Forwarded-For']);
  if (xf) return String(xf).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/**
 * @param key Строка, идентифицирующая, что именно ограничивается — например
 *   `auth:203.0.113.5` или `payments:tg_12345`. IP или id пользователя, но
 *   не что-то, что подделывается запросом без проверки.
 * @param limit Сколько попаданий разрешено за окно.
 * @param windowSeconds Длина окна в секундах.
 * @returns {ok:true} — можно продолжать.
 *   {ok:false, status:429, retryAfter, detail} — лимит исчерпан.
 */
export async function rateLimit(key, { limit, windowSeconds }) {
  const cfg = sb();
  if (!cfg) return { ok: true };

  // Хешируем: сырой IP или id незачем хранить в первичном ключе таблицы
  // и в логах Supabase дольше, чем требуется для самого счётчика.
  const bucket = crypto.createHash('sha256').update(key).digest('hex').slice(0, 40);

  try {
    const r = await fetch(`${cfg.url}/rest/v1/rpc/rate_limit_hit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: cfg.key, Authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify({ p_key: bucket, p_window_seconds: windowSeconds, p_max: limit }),
    });
    // Функция не установлена (миграция ещё не выполнена) или сбой Supabase —
    // не блокируем реальных пользователей из-за отсутствующей инфраструктуры.
    if (!r.ok) return { ok: true };
    const rows = await r.json();
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row) return { ok: true };
    if (!row.allowed) {
      return {
        ok: false, status: 429, retryAfter: row.reset_in,
        detail: 'Слишком много запросов. Попробуйте через ' + Math.max(1, row.reset_in) + ' сек.',
      };
    }
    return { ok: true };
  } catch (e) {
    return { ok: true };
  }
}
