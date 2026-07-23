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
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  if (!isAdmin(req.query.admin)) return res.status(403).json({ error: 'forbidden' });

  const cfg = sb();
  if (!cfg) return res.status(500).json({ error: 'supabase не настроен' });
  const H = { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, Prefer: 'count=exact' };

  try {
    const countOf = async (path) => {
      const r = await fetch(`${cfg.url}/rest/v1/${path}`, { headers: { ...H, Range: '0-0' } });
      const cr = r.headers.get('content-range') || '*/0';
      return parseInt(cr.split('/')[1] || '0', 10);
    };

    const users = await countOf('users?select=id');
    const pending = await countOf('payments?select=id&status=eq.pending');
    const approved = await countOf('payments?select=id&status=eq.approved');
    const rejected = await countOf('payments?select=id&status=eq.rejected');

    const rr = await fetch(`${cfg.url}/rest/v1/payments?status=eq.approved&select=amount`, {
      headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` },
    });
    const rows = await rr.json();
    const revenue = (Array.isArray(rows) ? rows : []).reduce((s, x) => s + (x.amount || 0), 0);

    const lr = await fetch(`${cfg.url}/rest/v1/payments?order=created_at.desc&limit=10&select=plan,amount,network,status,user_name,created_at`, {
      headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` },
    });
    const recent = await lr.json();

    return res.status(200).json({
      users,
      payments: { pending, approved, rejected },
      revenue,
      recent: Array.isArray(recent) ? recent : [],
    });
  } catch (e) {
    return res.status(500).json({ error: 'server', detail: String(e).slice(0, 200) });
  }
}
