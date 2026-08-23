// /api/payments — заявки на оплату челленджей, подписок и выплат.
//   POST {action:'create', user, name, kind, plan, amount, network, address, proof, meta}
//   GET  ?user=ID&status=approved        -> свои заявки (для активации счёта)
//   GET  ?admin=<tgId>&status=pending    -> список заявок (только админ)
//   POST {action:'review', admin, id, decision}   -> подтвердить/отклонить (админ)
//   POST {action:'applied', user, id}    -> отметить, что счёт активирован
// env: SUPABASE_URL, SUPABASE_SERVICE_KEY, ADMIN_TG_ID, TELEGRAM_BOT_TOKEN

import { isDown, readSettings } from './_settings.js';

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
    if (req.method === 'GET') {
      // --- свои заявки (для пользователя) ---
      if (req.query.user) {
        const st = req.query.status ? `&status=eq.${encodeURIComponent(req.query.status)}` : '';
        const r = await fetch(
          `${cfg.url}/rest/v1/payments?user_id=eq.${encodeURIComponent(req.query.user)}${st}&order=created_at.desc&limit=30`,
          { headers: H });
        const rows = await r.json();
        return res.status(200).json({ payments: Array.isArray(rows) ? rows : [] });
      }
      // --- админский список ---
      if (!isAdmin(req.query.admin)) return res.status(403).json({ error: 'forbidden' });
      const status = req.query.status || 'pending';
      const r = await fetch(
        `${cfg.url}/rest/v1/payments?status=eq.${encodeURIComponent(status)}&order=created_at.desc&limit=100`,
        { headers: H });
      const rows = await r.json();
      return res.status(200).json({ payments: Array.isArray(rows) ? rows : [] });
    }

    if (req.method === 'POST') {
      const body = req.body || {};

      // --- создать заявку ---
      if (body.action === 'create') {
        // Проп-фирма на обслуживании — новые оплаты не принимаем.
        //
        // Без этой проверки режим обслуживания был бы чисто косметическим: экран
        // техработ рисуется на клиенте, а любой сохранённый запрос или устаревшая
        // вкладка по-прежнему создали бы заявку на оплату во время работ — то есть
        // человек заплатил бы за счёт, который никто не активирует.
        // Владельцу платить не мешаем: ему нужно проверять оплату после выкатки.
        if (!isAdmin(body.admin) && await isDown('prop')) {
          const s = await readSettings();
          return res.status(503).json({
            error: 'maintenance',
            message: s.prop.message || 'Идут технические работы, оплата временно недоступна.',
            until: s.prop.until || '',
          });
        }

        const row = {
          user_id: body.user || null,
          user_name: body.name || null,
          kind: body.kind || 'challenge',
          plan: body.plan || '',
          amount: body.amount || 0,
          network: body.network || '',
          address: body.address || '',
          proof_url: body.proof || null,
          meta: body.meta || null,
          status: 'pending',
          applied: false,
        };
        const r = await fetch(`${cfg.url}/rest/v1/payments`, {
          method: 'POST', headers: { ...H, Prefer: 'return=representation' }, body: JSON.stringify(row),
        });
        const saved = await r.json();
        notifyAdmin(row).catch(() => {});
        return res.status(200).json({ ok: true, payment: Array.isArray(saved) ? saved[0] : saved });
      }

      // --- подтвердить / отклонить (админ) ---
      if (body.action === 'review') {
        if (!isAdmin(body.admin)) return res.status(403).json({ error: 'forbidden' });
        const decision = body.decision === 'approved' ? 'approved' : 'rejected';
        const r = await fetch(`${cfg.url}/rest/v1/payments?id=eq.${encodeURIComponent(body.id)}`, {
          method: 'PATCH', headers: { ...H, Prefer: 'return=representation' },
          body: JSON.stringify({ status: decision, reviewed_at: new Date().toISOString() }),
        });
        const upd = await r.json();
        const pay = Array.isArray(upd) ? upd[0] : upd;
        if (decision === 'approved' && pay) notifyUser(pay).catch(() => {});
        return res.status(200).json({ ok: true, payment: pay });
      }

      // --- отметить как активированную (счёт выдан на устройстве) ---
      if (body.action === 'applied') {
        if (!body.id) return res.status(400).json({ error: 'id' });
        await fetch(`${cfg.url}/rest/v1/payments?id=eq.${encodeURIComponent(body.id)}`, {
          method: 'PATCH', headers: H, body: JSON.stringify({ applied: true }),
        });
        return res.status(200).json({ ok: true });
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
    `${row.kind === 'subscription' ? 'Подписка' : row.kind === 'payout' ? 'ВЫПЛАТА' : 'Челлендж'}: ${row.plan}\n` +
    `Сумма: $${row.amount} · Сеть: ${row.network}\n` +
    `Пользователь: ${row.user_name || row.user_id}\n` +
    `Подтвердите в админ-панели приложения.`;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: admin, text }),
  });
}

async function notifyUser(pay) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !pay.user_id) return;
  const tgId = String(pay.user_id).startsWith('tg_') ? String(pay.user_id).slice(3) : null;
  if (!tgId) return;
  const text = pay.kind === 'payout'
    ? `✅ Выплата одобрена\nСумма: $${pay.amount} · ${pay.network}\nСредства будут отправлены на указанный адрес.`
    : `✅ Оплата подтверждена\n${pay.plan}\nОткройте приложение — счёт активируется автоматически.`;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: tgId, text }),
  });
}
