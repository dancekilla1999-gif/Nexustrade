// /api/config — глобальные настройки приложения (режим обслуживания).
//   GET                                                          -> { prop:{...}, bot:{...}, maintenance, message, until }
//   POST { initData, scope:'prop'|'bot', maintenance, message, until }  -> изменить (только владелец)
//   POST { initData, maintenance, message, until }                      -> то же для контура prop
// Права проверяются по подписи Telegram initData, а не по присланному ID.
// env: SUPABASE_URL, SUPABASE_SERVICE_KEY, ADMIN_TG_ID, TELEGRAM_BOT_TOKEN

import { SCOPES, readSettings, toPublic, writeSettings } from './_settings.js';
import { requireAdmin } from './_telegram.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    // Читать настройки должны все и всегда — поэтому здесь нет ни одной ветки,
    // которая может вернуть ошибку: при недоступной базе считаем, что всё работает,
    // и приложение не блокируется из-за проблем с самим переключателем.
    res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=30');
    // Публичный TON-адрес приёма депозитов задаётся владельцем через env
    // (TON_DEPOSIT_ADDRESS) — приватный ключ этого кошелька в приложении
    // не хранится и не нужен: получать средства можно, зная только адрес.
    // Пока адрес не задан, клиент честно показывает, что депозиты не настроены,
    // а не отправляет реальные деньги на выдуманный адрес.
    const pub = toPublic(await readSettings());
    pub.wallet = { tonDeposit: String(process.env.TON_DEPOSIT_ADDRESS || '').trim() };
    return res.status(200).json(pub);
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    // Подпись Telegram, а не присланный клиентом идентификатор. См. _telegram.js.
    const auth = requireAdmin(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error, detail: auth.detail });

    const scope = SCOPES.includes(body.scope) ? body.scope : 'prop';
    const current = await readSettings();

    const next = {
      prop: { ...current.prop },
      bot: { ...current.bot },
      updated_scope: scope,
    };
    next[scope] = {
      maintenance: !!body.maintenance,
      message: String(body.message || '').slice(0, 400),
      until: String(body.until || '').slice(0, 60),
    };

    try {
      // Здесь ошибка обязана дойти до администратора: если запись не удалась,
      // а мы ответили «ок», он будет уверен, что работы объявлены, хотя это не так.
      await writeSettings(next);
    } catch (e) {
      return res.status(500).json({ error: 'save_failed', detail: String(e.message || e).slice(0, 300) });
    }

    notifyAdminMode(scope, next[scope]).catch(() => {});
    return res.status(200).json({
      ok: true,
      scope,
      ...toPublic({ ...next, updated_at: new Date().toISOString() }),
    });
  }

  return res.status(405).json({ error: 'method' });
}

const LABEL = { prop: 'Проп-фирма (мини-приложение)', bot: 'Telegram-бот' };

async function notifyAdminMode(scope, v) {
  const token = process.env.TELEGRAM_BOT_TOKEN, admin = process.env.ADMIN_TG_ID;
  if (!token || !admin) return;
  const what = LABEL[scope] || scope;
  const text = v.maintenance
    ? `🔧 Обслуживание ВКЛЮЧЕНО\n${what}\n` +
      (scope === 'bot'
        ? 'Уведомления пользователям приостановлены.'
        : 'Пользователи видят экран техработ, новые оплаты не принимаются.') +
      (v.until ? `\nОкончание: ${v.until}` : '')
    : `✅ Обслуживание ВЫКЛЮЧЕНО\n${what}\nРаботает в обычном режиме.`;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: admin, text }),
  });
}
