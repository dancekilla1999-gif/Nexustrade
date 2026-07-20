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
  if (!cfg) return res.status(200).json({ state: null, note: 'no supabase' });
  const H = { 'Content-Type': 'application/json', apikey: cfg.key, Authorization: `Bearer ${cfg.key}` };

  if (req.method === 'GET') {
    const user = req.query.user;
    if (!user) return res.status(400).json({ error: 'user' });
    try {
      const r = await fetch(`${cfg.url}/rest/v1/user_state?user_id=eq.${encodeURIComponent(user)}&select=state`, { headers: H });
      const rows = await r.json();
      return res.status(200).json({ state: rows && rows[0] ? rows[0].state : null });
    } catch (e) { return res.status(500).json({ error: 'db', detail: String(e).slice(0, 200) }); }
  }

  if (req.method === 'POST') {
    const { user, state } = req.body || {};
    if (!user) return res.status(400).json({ error: 'user' });
    try {
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
