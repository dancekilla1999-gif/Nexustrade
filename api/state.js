// /api/state — синхронизация состояния + автоматический учёт пользователей.
//   GET  /api/state            -> { state }                (по токену сеанса)
//   POST /api/state { state }  -> сохранить состояние       (по токену сеанса)
//
// Идентификатор пользователя берётся ИЗ ТОКЕНА и никогда из запроса.
// Раньше он приходил из ?user=/body.user без всякой проверки, и посторонний мог
// прочитать чужие счета и заявки на вывод или перезаписать чужое состояние.
//
// Требует env: SUPABASE_URL, SUPABASE_SERVICE_KEY, TELEGRAM_BOT_TOKEN.

import { requireUser } from './_session.js';

function sb() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  return url && key ? { url, key } : null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const cfg = sb();
  if (!cfg) return res.status(200).json({ state: null, note: 'Supabase не настроен' });
  const H = { 'Content-Type': 'application/json', apikey: cfg.key, Authorization: `Bearer ${cfg.key}` };

  if (req.method === 'GET') {
    const auth = requireUser(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error, detail: auth.detail });
    const user = auth.userId;
    try {
      const r = await fetch(`${cfg.url}/rest/v1/user_state?user_id=eq.${encodeURIComponent(user)}&select=state`, { headers: H });
      const rows = await r.json();
      return res.status(200).json({ state: rows && rows[0] ? rows[0].state : null });
    } catch (e) { return res.status(500).json({ error: 'db', detail: String(e).slice(0, 200) }); }
  }

  if (req.method === 'POST') {
    const auth = requireUser(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error, detail: auth.detail });
    const user = auth.userId;
    const { state, name, via } = req.body || {};
    try {
      // 1) Регистрируем/обновляем пользователя — учитываются все, включая демо
      await fetch(`${cfg.url}/rest/v1/users`, {
        method: 'POST',
        headers: { ...H, Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({
          id: user,
          name: name || null,
          via: via || 'demo',
          last_seen: new Date().toISOString(),
        }),
      }).catch(() => {});

      // 2) Сохраняем состояние
      await fetch(`${cfg.url}/rest/v1/user_state`, {
        method: 'POST',
        headers: { ...H, Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({ user_id: user, state, updated_at: new Date().toISOString() }),
      });
      return res.status(200).json({ ok: true });
    } catch (e) { return res.status(500).json({ error: 'db', detail: String(e).slice(0, 200) }); }
  }

  return res.status(405).json({ error: 'method' });
}
