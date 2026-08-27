// /api/nexus — внутренний ledger NEXUS + заявки deposit/withdraw
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, TELEGRAM_BOT_TOKEN
// Optional: NEXUS_MINT, NEXUS_VAULT, NEXUS_DECIMALS, ADMIN_TG_ID
//
// Права владельца проверяются подписью Telegram initData (см. _telegram.js),
// а не идентификатором, присланным клиентом.

import { requireAdmin } from './_telegram.js';

function sb() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  return url && key ? { url, key } : null;
}
const MINT = process.env.NEXUS_MINT || '';
const VAULT = process.env.NEXUS_VAULT || '';
const DECIMALS = Number(process.env.NEXUS_DECIMALS || 9);
const SYMBOL = process.env.NEXUS_SYMBOL || 'NEXUS';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const cfg = sb();
  const H = cfg
    ? { 'Content-Type': 'application/json', apikey: cfg.key, Authorization: `Bearer ${cfg.key}` }
    : null;

  // Публичная инфа о токене (без БД)
  if (req.method === 'GET' && req.query.info === '1') {
    return res.status(200).json({
      symbol: SYMBOL,
      mint: MINT || null,
      vault: VAULT || null,
      decimals: DECIMALS,
      network: process.env.NEXUS_NETWORK || 'solana-devnet',
      note: MINT ? 'live' : 'mint not configured — set NEXUS_MINT env',
    });
  }

  if (!cfg) {
    // offline mode — клиент держит ledger в localStorage
    return res.status(200).json({ offline: true, mint: MINT || null, vault: VAULT || null, symbol: SYMBOL, decimals: DECIMALS });
  }

  try {
    if (req.method === 'GET') {
      const user = req.query.user;
      if (!user) return res.status(400).json({ error: 'user required' });

      // баланс
      const br = await fetch(
        `${cfg.url}/rest/v1/nexus_balances?user_id=eq.${encodeURIComponent(user)}&select=balance,updated_at`,
        { headers: H }
      );
      const brows = await br.json();
      const balance = Array.isArray(brows) && brows[0] ? Number(brows[0].balance) || 0 : 0;

      // история
      const hr = await fetch(
        `${cfg.url}/rest/v1/nexus_txs?user_id=eq.${encodeURIComponent(user)}&order=created_at.desc&limit=40`,
        { headers: H }
      );
      const history = await hr.json();

      return res.status(200).json({
        balance,
        history: Array.isArray(history) ? history : [],
        mint: MINT || null,
        vault: VAULT || null,
        symbol: SYMBOL,
        decimals: DECIMALS,
      });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const user = body.user;
      if (!user) return res.status(400).json({ error: 'user' });

      // --- заявка на депозит (пользователь прислал tx signature) ---
      if (body.action === 'deposit_request') {
        const row = {
          user_id: user,
          user_name: body.name || null,
          kind: 'deposit',
          amount: Number(body.amount) || 0,
          tx_sig: body.txSig || null,
          status: 'pending',
          meta: body.meta || null,
        };
        await fetch(`${cfg.url}/rest/v1/nexus_txs`, {
          method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(row),
        });
        return res.status(200).json({ ok: true, status: 'pending' });
      }

      // --- заявка на вывод ---
      if (body.action === 'withdraw_request') {
        const amount = Number(body.amount) || 0;
        const to = String(body.to || '').trim();
        if (amount <= 0) return res.status(400).json({ error: 'amount' });
        if (to.length < 32) return res.status(400).json({ error: 'invalid solana address' });

        // проверить баланс
        const br = await fetch(
          `${cfg.url}/rest/v1/nexus_balances?user_id=eq.${encodeURIComponent(user)}&select=balance`,
          { headers: H }
        );
        const brows = await br.json();
        const bal = Array.isArray(brows) && brows[0] ? Number(brows[0].balance) || 0 : 0;
        if (amount > bal + 1e-9) return res.status(400).json({ error: 'insufficient', balance: bal });

        // резервируем (списываем сразу, админ отправит on-chain)
        const newBal = Math.max(0, bal - amount);
        await fetch(`${cfg.url}/rest/v1/nexus_balances`, {
          method: 'POST',
          headers: { ...H, Prefer: 'resolution=merge-duplicates' },
          body: JSON.stringify({ user_id: user, balance: newBal, updated_at: new Date().toISOString() }),
        });
        await fetch(`${cfg.url}/rest/v1/nexus_txs`, {
          method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
          body: JSON.stringify({
            user_id: user, user_name: body.name || null, kind: 'withdraw',
            amount, to_address: to, status: 'pending',
          }),
        });
        return res.status(200).json({ ok: true, balance: newBal, status: 'pending' });
      }

      // --- админ: подтвердить депозит / выплатить вывод / credit ---
      if (body.action === 'admin_credit') {
        // Начисление баланса — это выпуск стоимости. Только по подписи Telegram.
        const auth = requireAdmin(req);
        if (!auth.ok) return res.status(auth.status).json({ error: auth.error, detail: auth.detail });
        const amount = Number(body.amount) || 0;
        const target = body.targetUser;
        if (!target || amount === 0) return res.status(400).json({ error: 'params' });
        const br = await fetch(
          `${cfg.url}/rest/v1/nexus_balances?user_id=eq.${encodeURIComponent(target)}&select=balance`,
          { headers: H }
        );
        const brows = await br.json();
        const bal = Array.isArray(brows) && brows[0] ? Number(brows[0].balance) || 0 : 0;
        const newBal = bal + amount;
        await fetch(`${cfg.url}/rest/v1/nexus_balances`, {
          method: 'POST',
          headers: { ...H, Prefer: 'resolution=merge-duplicates' },
          body: JSON.stringify({ user_id: target, balance: newBal, updated_at: new Date().toISOString() }),
        });
        if (body.txId) {
          await fetch(`${cfg.url}/rest/v1/nexus_txs?id=eq.${encodeURIComponent(body.txId)}`, {
            method: 'PATCH', headers: H,
            body: JSON.stringify({ status: 'done', reviewed_at: new Date().toISOString() }),
          });
        }
        return res.status(200).json({ ok: true, balance: newBal });
      }

      // --- demo credit (для теста без админа, только если NEXUS_DEMO_CREDIT=1) ---
      if (body.action === 'demo_credit' && process.env.NEXUS_DEMO_CREDIT === '1') {
        const amount = Math.min(1000, Number(body.amount) || 100);
        const br = await fetch(
          `${cfg.url}/rest/v1/nexus_balances?user_id=eq.${encodeURIComponent(user)}&select=balance`,
          { headers: H }
        );
        const brows = await br.json();
        const bal = Array.isArray(brows) && brows[0] ? Number(brows[0].balance) || 0 : 0;
        const newBal = bal + amount;
        await fetch(`${cfg.url}/rest/v1/nexus_balances`, {
          method: 'POST',
          headers: { ...H, Prefer: 'resolution=merge-duplicates' },
          body: JSON.stringify({ user_id: user, balance: newBal, updated_at: new Date().toISOString() }),
        });
        return res.status(200).json({ ok: true, balance: newBal, demo: true });
      }

      return res.status(400).json({ error: 'unknown action' });
    }

    return res.status(405).json({ error: 'method' });
  } catch (e) {
    return res.status(500).json({ error: 'server', detail: String(e).slice(0, 200) });
  }
}
