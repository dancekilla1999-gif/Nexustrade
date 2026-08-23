// Общие настройки приложения — режим технического обслуживания.
// Файл начинается с "_", поэтому Vercel не публикует его как эндпоинт;
// это внутренний модуль, который импортируют config.js, notify.js и payments.js.
//
// Два независимых контура:
//   prop — витрина проп-фирмы (мини-приложение): челленджи, терминал, оплаты
//   bot  — Telegram-бот: уведомления пользователям
// Их можно включать и выключать по отдельности: обновление платформы не обязано
// затыкать бота, а профилактика бота не обязана закрывать людям доступ к счетам.
//
// env: SUPABASE_URL, SUPABASE_SERVICE_KEY, ADMIN_TG_ID

export const SCOPES = ['prop', 'bot'];

export const EMPTY_SCOPE = { maintenance: false, message: '', until: '' };

export function sb() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  return url && key ? { url, key } : null;
}

export function isAdmin(id) {
  const admin = String(process.env.ADMIN_TG_ID || '').trim();
  return !!admin && String(id || '').trim() === admin;
}

function headers(cfg) {
  return { 'Content-Type': 'application/json', apikey: cfg.key, Authorization: `Bearer ${cfg.key}` };
}

/** Приводит любую сохранённую форму к каноничной {prop, bot}. */
export function normalize(raw) {
  const v = raw && typeof raw === 'object' ? raw : {};
  const one = (s) => ({
    maintenance: !!(s && s.maintenance),
    message: String((s && s.message) || '').slice(0, 400),
    until: String((s && s.until) || '').slice(0, 60),
  });

  // Обратная совместимость: раньше настройка была одна и плоская
  // ({maintenance, message, until}) и означала мини-приложение. Старые записи
  // в базе читаются как контур prop, иначе включённое обслуживание молча
  // потерялось бы при выкатке этой версии.
  const legacy = ('maintenance' in v || 'message' in v || 'until' in v)
    ? one(v)
    : EMPTY_SCOPE;

  return {
    prop: v.prop ? one(v.prop) : legacy,
    bot: v.bot ? one(v.bot) : EMPTY_SCOPE,
    updated_at: v.updated_at || null,
    updated_scope: v.updated_scope || null,
  };
}

/**
 * Ответ для клиента: каноничные контуры плюс плоское зеркало контура prop.
 *
 * Зеркало нужно, потому что GET кэшируется на 15 секунд, а у части пользователей
 * ещё живёт предыдущая версия index.html, которая читает только плоские поля.
 * Без зеркала для них обслуживание просто не включилось бы.
 */
export function toPublic(s) {
  return {
    prop: { maintenance: s.prop.maintenance, message: s.prop.message, until: s.prop.until },
    bot: { maintenance: s.bot.maintenance, message: s.bot.message, until: s.bot.until },
    maintenance: s.prop.maintenance,
    message: s.prop.message,
    until: s.prop.until,
    updated_at: s.updated_at,
  };
}

/** Читает настройки. При любой недоступности базы возвращает «всё работает». */
export async function readSettings() {
  const cfg = sb();
  if (!cfg) return normalize(null);
  try {
    const r = await fetch(`${cfg.url}/rest/v1/app_settings?key=eq.main&select=value`, { headers: headers(cfg) });
    if (!r.ok) return normalize(null);
    const rows = await r.json();
    return normalize(Array.isArray(rows) && rows[0] ? rows[0].value : null);
  } catch (e) {
    return normalize(null);
  }
}

/**
 * Записывает настройки. В отличие от чтения — бросает исключение при ошибке.
 *
 * Молчаливый сбой здесь опаснее всего: администратор нажал «Включить», интерфейс
 * отрисовал успех, а на самом деле ничего не сохранилось и пользователи продолжают
 * торговать во время работ. Поэтому статус ответа обязательно проверяется.
 */
export async function writeSettings(next) {
  const cfg = sb();
  if (!cfg) throw new Error('Supabase не настроен: нет SUPABASE_URL / SUPABASE_SERVICE_KEY');

  const value = {
    prop: { ...next.prop },
    bot: { ...next.bot },
    updated_at: new Date().toISOString(),
    updated_scope: next.updated_scope || null,
  };

  const r = await fetch(`${cfg.url}/rest/v1/app_settings`, {
    method: 'POST',
    headers: { ...headers(cfg), Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ key: 'main', value }),
  });

  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    // 404/42P01 — таблицы нет. Это самая частая причина, и сообщение должно
    // называть её прямо, а не прятать за «ошибка сервера».
    const hint = /relation .*app_settings.* does not exist|42P01|PGRST205/i.test(detail)
      ? ' Похоже, таблица app_settings не создана — выполните api/app_settings.sql в Supabase SQL Editor.'
      : '';
    throw new Error(`Не удалось сохранить настройки (${r.status}).${hint} ${detail.slice(0, 200)}`.trim());
  }

  return value;
}

/** Идёт ли сейчас обслуживание в этом контуре. */
export async function isDown(scope) {
  const s = await readSettings();
  return !!(s[scope] && s[scope].maintenance);
}
