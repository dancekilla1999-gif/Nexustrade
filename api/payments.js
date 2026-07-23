// /api/payments — заявки на оплату челленджей и подписок.
//   POST  {action:'create', user, name, kind, plan, amount, network, proof}       -> создать заявку
//   GET   ?admin=<tgId>&status=pending                                            -> список заявок (только админ)
//   POST  {action:'review', admin:<tgId>, id, decision:'approved'|'rejected'}     -> подтвердить/отклонить (только админ)
// Требует env: SUPABASE_URL, SUPABASE_SERVICE_KEY, ADMIN_TG_ID.

function sb() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  return url && key ? { url, key } : null;
}
function isAdmin(id) {
  const admin = String(process.env.ADMIN_TG_ID || '').trim();
  return admin && String(id || '').trim() === admin;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const cfg = sb();
  if (!cfg) return res.status(500).json({ error: 'supabase не настроен' });
  const H = { 'Content-Type': 'application/json', apikey: cfg.key, Authorization: `Bearer ${cfg.key}` };

  try {
    // -------- список заявок (админ) --------
    if (req.method === 'GET') {
      if (!isAdmin(req.query.admin)) return res.status(403).json({ error: 'forbidden' });
      const status = req.query.status || 'pending';
      const r = await fetch(`${cfg.url}/rest/v1/payments?status=eq.${encodeURIComponent(status)}&order=created_at.desc&limit=100`, { headers: H });
      const rows = await r.json();
      return res.status(200).json({ payments: Array.isArray(rows) ? rows : [] });
    }

    if (req.method === 'POST') {
      const body = req.body || {};

      // -------- создать заявку --------
      if (body.action === 'create') {
        const row = {
          user_id: body.user || null,
          user_name: body.name || null,
          kind: body.kind || 'challenge',
          plan: body.plan || '',
          amount: body.amount || 0,
          network: body.network || '',
          address: body.address || '',
          proof_url: body.proof || null,
          status: 'pending',
        };
        const r = await fetch(`${cfg.url}/rest/v1/payments`, {
          method: 'POST', headers: { ...H, Prefer: 'return=representation' }, body: JSON.stringify(row),
        });
        const saved = await r.json();
        // уведомим админа в Telegram (если задан бот-токен)
        notifyAdmin(row).catch(() => {});
        return res.status(200).json({ ok: true, payment: Array.isArray(saved) ? saved[0] : saved });
      }

      // -------- подтвердить / отклонить (админ) --------
      if (body.action === 'review') {
        if (!isAdmin(body.admin)) return res.status(403).json({ error: 'forbidden' });
        const decision = body.decision === 'approved' ? 'approved' : 'rejected';
        const r = await fetch(`${cfg.url}/rest/v1/payments?id=eq.${encodeURIComponent(body.id)}`, {
          method: 'PATCH', headers: { ...H, Prefer: 'return=representation' },
          body: JSON.stringify({ status: decision, reviewed_at: new Date().toISOString() }),
        });
        const upd = await r.json();
        return res.status(200).json({ ok: true, payment: Array.isArray(upd) ? upd[0] : upd });
      }

      return res.status(400).json({ error: 'action' });
    }

    return res.status(405).json({ error: 'method' });
  } catch (e) {
    return res.status(500).json({ error: 'server', detail: String(e).slice(0, 200) });
  }
}

async function notifyAdmin(row) {
  const token = process.env.TELEGRAM_BOT_TOKEN, admin = process.env.ADMIN_TG_ID;
  if (!token || !admin) return;
  const text = `🧾 Новая заявка на оплату\n` +
    `${row.kind === 'subscription' ? 'Подписка' : 'Челлендж'}: ${row.plan}\n` +
    `Сумма: $${row.amount} · Сеть: ${row.network}\n` +
    `Пользователь: ${row.user_name || row.user_id}\n` +
    `Подтвердите в админ-панели приложения.`;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: admin, text }),
  });
}
