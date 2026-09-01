// /api/positions — админский обзор и принудительное закрытие позиций пользователя.
//   GET  ?initData=...&user=tg_X            -> счета и открытые позиции пользователя
//   POST {initData, action:'forceClose', user, accId, posId}     -> закрыть одну
//   POST {initData, action:'forceCloseAll', user, accId}         -> закрыть все на счёте
//
// Права — по подписи Telegram (requireAdmin), а не по присланному ID.
// Реальные деньги не двигаются: это виртуальные позиции проп-симулятора.
// Закрытие ставится в очередь adminQueue внутри состояния пользователя и
// исполняется на его устройстве по живой цене (там же, где считается PnL) —
// так закрытие получает корректную цену и не расходится с клиентом-владельцем
// счёта. Прямая правка баланса на сервере не выбрана намеренно: клиент —
// источник истины по своим счетам, и серверная правка до него не доехала бы.

import { requireAdmin } from './_telegram.js';

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
  if (!cfg) return res.status(500).json({ error: 'supabase не настроен' });
  const H = { 'Content-Type': 'application/json', apikey: cfg.key, Authorization: `Bearer ${cfg.key}` };

  const auth = requireAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error, detail: auth.detail });

  const target = (req.method === 'GET' ? req.query.user : (req.body || {}).user) || '';
  if (!target) return res.status(400).json({ error: 'user' });

  async function readState() {
    const r = await fetch(`${cfg.url}/rest/v1/user_state?user_id=eq.${encodeURIComponent(target)}&select=state`, { headers: H });
    const rows = await r.json();
    return rows && rows[0] ? (rows[0].state || {}) : null;
  }
  async function writeState(state) {
    await fetch(`${cfg.url}/rest/v1/user_state`, {
      method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ user_id: target, state, updated_at: new Date().toISOString() }),
    });
  }

  try {
    if (req.method === 'GET') {
      const state = await readState();
      if (!state) return res.status(200).json({ found: false, accounts: [], positions: [] });
      const accounts = (state.accounts || []).map(a => ({
        id: a.id, label: a.label, kind: a.kind, tier: a.tier, balance: a.balance, status: a.status,
        openCount: (a.positions || []).length,
      }));
      const positions = [];
      (state.accounts || []).forEach(a => (a.positions || []).forEach(p => positions.push({
        accId: a.id, accLabel: a.label, id: p.id, symbol: p.symbol, side: p.side,
        lev: p.lev, margin: p.margin, entry: p.entry, qty: p.qty, tp: p.tp, sl: p.sl, paper: !!p.paper,
      })));
      return res.status(200).json({ found: true, accounts, positions, queued: (state.adminQueue || []).length });
    }

    // POST — постановка команды в очередь
    const body = req.body || {};
    const action = body.action;
    if (action !== 'forceClose' && action !== 'forceCloseAll') return res.status(400).json({ error: 'action' });

    const state = await readState();
    if (!state) return res.status(404).json({ error: 'no_state' });
    state.adminQueue = Array.isArray(state.adminQueue) ? state.adminQueue : [];
    const cmd = {
      cid: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      type: action === 'forceCloseAll' ? 'closeAll' : 'close',
      accId: body.accId || null,
      posId: (body.posId != null ? body.posId : null),
      by: auth.user && auth.user.id ? String(auth.user.id) : 'admin',
      ts: Date.now(),
    };
    state.adminQueue.push(cmd);
    // Ограничим очередь, чтобы не разрасталась при неактивном клиенте.
    if (state.adminQueue.length > 50) state.adminQueue = state.adminQueue.slice(-50);
    await writeState(state);
    return res.status(200).json({ ok: true, cmd });
  } catch (e) {
    return res.status(500).json({ error: 'server', detail: String(e).slice(0, 200) });
  }
}
