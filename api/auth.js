import crypto from 'crypto';

function verifyTelegram(initData, botToken) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');
    const dataCheck = [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, v]) => `${k}=${v}`).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const calc = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');
    if (calc !== hash) return null;
    const user = JSON.parse(params.get('user') || '{}');
    return user && user.id ? user : null;
  } catch (e) { return null; }
}

async function upsertUser(u) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return u;
  try {
    await fetch(`${url}/rest/v1/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: key, Authorization: `Bearer ${key}`,
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({ id: u.id, name: u.name, via: u.via, email: u.email || null }),
    });
  } catch (e) {}
  return u;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const { provider, email, initData } = req.body || {};
  let user = null;

  if (provider === 'telegram' && initData) {
    const tu = verifyTelegram(initData, process.env.TELEGRAM_BOT_TOKEN || '');
    if (!tu) return res.status(401).json({ error: 'telegram' });
    user = { id: 'tg_' + tu.id, name: tu.first_name || tu.username || 'Трейдер', via: 'telegram', username: tu.username };
  } else if (provider === 'email' && email) {
    user = { id: 'em_' + Buffer.from(email).toString('hex').slice(0, 16), name: email.split('@')[0], via: 'email', email };
  } else if (provider === 'google') {
    user = { id: 'g_' + Date.now(), name: 'Google User', via: 'google' };
  } else {
    return res.status(400).json({ error: 'provider' });
  }

  user = await upsertUser(user);
  return res.status(200).json({ user });
}
