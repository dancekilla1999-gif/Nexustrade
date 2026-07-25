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
  const plain = { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` };

  try {
    const countOf = async (path) => {
      const r = await fetch(`${cfg.url}/rest/v1/${path}`, { headers: { ...H, Range: '0-0' } });
      const cr = r.headers.get('content-range') || '*/0';
      return parseInt(cr.split('/')[1] || '0', 10);
    };
    const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

    const users = await countOf('users?select=id');
    const active24 = await countOf('users?select=id&last_seen=gte.' + iso(864e5));
    const active7d = await countOf('users?select=id&last_seen=gte.' + iso(7 * 864e5));
    const newToday = await countOf('users?select=id&created_at=gte.' + iso(864e5));

    const pending = await countOf('payments?select=id&status=eq.pending');
    const approved = await countOf('payments?select=id&status=eq.approved');
    const rejected = await countOf('payments?select=id&status=eq.rejected');

    const rr = await fetch(`${cfg.url}/rest/v1/payments?status=eq.approved&select=amount,kind,created_at`, { headers: plain });
    const rows = await rr.json();
    const list = Array.isArray(rows) ? rows : [];
    const revenue = list.reduce((s, x) => s + (x.amount || 0), 0);
    const rev30 = list
      .filter(x => x.created_at && new Date(x.created_at).getTime() > Date.now() - 30 * 864e5)
      .reduce((s, x) => s + (x.amount || 0), 0);

    const lr = await fetch(`${cfg.url}/rest/v1/payments?order=created_at.desc&limit=10&select=plan,amount,network,status,user_name,created_at`, { headers: plain });
    const recent = await lr.json();

    return res.status(200).json({
      users, active24, active7d, newToday,
      payments: { pending, approved, rejected },
      revenue, rev30,
      recent: Array.isArray(recent) ? recent : [],
    });
  } catch (e) {
    return res.status(500).json({ error: 'server', detail: String(e).slice(0, 200) });
  }
}
