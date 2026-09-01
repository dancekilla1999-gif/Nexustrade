// Адаптеры бирж: подпись запросов и приведение ответов к общему виду.
//
// Всё, что здесь есть, выполняется ТОЛЬКО на сервере. Секрет никогда не
// покидает эту функцию: клиент шлёт намерение («купить 0.01 BTC»), сервер
// подписывает и отправляет на биржу.
//
// Поддержаны три площадки с разными схемами подписи:
//   Binance  — HMAC-SHA256 (hex) от query-строки, ключ в заголовке X-MBX-APIKEY
//   Bybit v5 — HMAC-SHA256 (hex) от ts+apiKey+recvWindow+(query|body)
//   OKX v5   — HMAC-SHA256 (base64) от ts+METHOD+path+body, плюс passphrase
//
// Добавить биржу = добавить объект в ADAPTERS с теми же методами.

import crypto from 'crypto';

const RECV_WINDOW = '10000';
const TIMEOUT_MS = 12000;

/** fetch с таймаутом: висящий запрос к бирже не должен держать функцию до конца лимита. */
async function jfetch(url, opts) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...(opts || {}), signal: ac.signal });
    const text = await r.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (e) { body = { raw: text.slice(0, 400) }; }
    return { status: r.status, ok: r.ok, body };
  } finally { clearTimeout(t); }
}

const hmacHex = (secret, msg) => crypto.createHmac('sha256', secret).update(msg).digest('hex');
const hmacB64 = (secret, msg) => crypto.createHmac('sha256', secret).update(msg).digest('base64');
const qs = (o) => Object.keys(o).filter(k => o[k] !== undefined && o[k] !== null)
  .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(o[k])).join('&');

const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };

/* ==========================================================================
   BINANCE (USDT-M фьючерсы + спот-баланс)
   ========================================================================== */
const binance = {
  id: 'binance',
  name: 'Binance',
  needsPassphrase: false,
  // Ключ создаётся на binance.com -> API Management. Права: Enable Futures / Reading.
  helpUrl: 'https://www.binance.com/ru/my/settings/api-management',

  async call(creds, { base, path, method = 'GET', params = {} }) {
    const ts = Date.now();
    const query = qs({ ...params, timestamp: ts, recvWindow: RECV_WINDOW });
    const sig = hmacHex(creds.apiSecret, query);
    const url = base + path + '?' + query + '&signature=' + sig;
    return jfetch(url, { method, headers: { 'X-MBX-APIKEY': creds.apiKey } });
  },

  /** Проверка ключа + КРИТИЧНО: разрешён ли вывод средств. */
  async probe(creds) {
    const r = await this.call(creds, { base: 'https://api.binance.com', path: '/sapi/v1/account/apiRestrictions' });
    if (!r.ok) return { ok: false, error: (r.body && (r.body.msg || r.body.raw)) || ('HTTP ' + r.status) };
    const b = r.body || {};
    return {
      ok: true,
      canWithdraw: !!b.enableWithdrawals,
      canTrade: !!(b.enableSpotAndMarginTrading || b.enableFutures),
      canFutures: !!b.enableFutures,
      ipRestricted: !!b.ipRestrict,
    };
  },

  async balances(creds) {
    const r = await this.call(creds, { base: 'https://fapi.binance.com', path: '/fapi/v2/balance' });
    if (!r.ok) return { ok: false, error: (r.body && (r.body.msg || r.body.raw)) || ('HTTP ' + r.status) };
    const rows = Array.isArray(r.body) ? r.body : [];
    return {
      ok: true,
      assets: rows.filter(x => num(x.balance) > 0).map(x => ({
        asset: x.asset, free: num(x.availableBalance), total: num(x.balance),
      })),
    };
  },

  async positions(creds) {
    const r = await this.call(creds, { base: 'https://fapi.binance.com', path: '/fapi/v2/positionRisk' });
    if (!r.ok) return { ok: false, error: (r.body && (r.body.msg || r.body.raw)) || ('HTTP ' + r.status) };
    const rows = Array.isArray(r.body) ? r.body : [];
    return {
      ok: true,
      positions: rows.filter(p => num(p.positionAmt) !== 0).map(p => ({
        symbol: p.symbol, side: num(p.positionAmt) > 0 ? 'LONG' : 'SHORT',
        qty: Math.abs(num(p.positionAmt)), entry: num(p.entryPrice), mark: num(p.markPrice),
        pnl: num(p.unRealizedProfit), lev: num(p.leverage), liq: num(p.liquidationPrice),
      })),
    };
  },

  async order(creds, o) {
    const params = {
      symbol: o.symbol, side: o.side, type: o.type === 'LIMIT' ? 'LIMIT' : 'MARKET', quantity: o.qty,
    };
    if (o.type === 'LIMIT') { params.price = o.price; params.timeInForce = 'GTC'; }
    if (o.reduceOnly) params.reduceOnly = 'true';
    const r = await this.call(creds, { base: 'https://fapi.binance.com', path: '/fapi/v1/order', method: 'POST', params });
    if (!r.ok) return { ok: false, error: (r.body && (r.body.msg || r.body.raw)) || ('HTTP ' + r.status) };
    return { ok: true, orderId: String(r.body.orderId || ''), status: r.body.status || 'NEW' };
  },
};

/* ==========================================================================
   BYBIT v5 (unified)
   ========================================================================== */
const bybit = {
  id: 'bybit',
  name: 'Bybit',
  needsPassphrase: false,
  helpUrl: 'https://www.bybit.com/app/user/api-management',

  async call(creds, { path, method = 'GET', params = {} }) {
    const base = 'https://api.bybit.com';
    const ts = String(Date.now());
    let url = base + path, body = '';
    let payload;
    if (method === 'GET') { const q = qs(params); if (q) url += '?' + q; payload = q; }
    else { body = JSON.stringify(params); payload = body; }
    const sig = hmacHex(creds.apiSecret, ts + creds.apiKey + RECV_WINDOW + payload);
    const headers = {
      'X-BAPI-API-KEY': creds.apiKey, 'X-BAPI-TIMESTAMP': ts,
      'X-BAPI-RECV-WINDOW': RECV_WINDOW, 'X-BAPI-SIGN': sig,
    };
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    const r = await jfetch(url, { method, headers, body: method === 'GET' ? undefined : body });
    // Bybit отдаёт HTTP 200 даже на логическую ошибку — смотрим retCode.
    const code = r.body && r.body.retCode;
    return { ...r, ok: r.ok && code === 0, err: r.body && r.body.retMsg };
  },

  async probe(creds) {
    const r = await this.call(creds, { path: '/v5/user/query-api' });
    if (!r.ok) return { ok: false, error: r.err || ('HTTP ' + r.status) };
    const d = (r.body && r.body.result) || {};
    const p = d.permissions || {};
    const has = (arr) => Array.isArray(arr) && arr.length > 0;
    return {
      ok: true,
      canWithdraw: has(p.Withdraw),
      canTrade: has(p.ContractTrade) || has(p.Spot) || has(p.Derivatives),
      canFutures: has(p.ContractTrade) || has(p.Derivatives),
      ipRestricted: String(d.ips || '').length > 0 && String(d.ips) !== '*',
    };
  },

  async balances(creds) {
    const r = await this.call(creds, { path: '/v5/account/wallet-balance', params: { accountType: 'UNIFIED' } });
    if (!r.ok) return { ok: false, error: r.err || ('HTTP ' + r.status) };
    const list = ((r.body.result || {}).list) || [];
    const coins = (list[0] && list[0].coin) || [];
    return {
      ok: true,
      assets: coins.filter(c => num(c.walletBalance) > 0).map(c => ({
        asset: c.coin, free: num(c.availableToWithdraw) || num(c.walletBalance), total: num(c.walletBalance),
      })),
    };
  },

  async positions(creds) {
    const r = await this.call(creds, { path: '/v5/position/list', params: { category: 'linear', settleCoin: 'USDT' } });
    if (!r.ok) return { ok: false, error: r.err || ('HTTP ' + r.status) };
    const list = ((r.body.result || {}).list) || [];
    return {
      ok: true,
      positions: list.filter(p => num(p.size) > 0).map(p => ({
        symbol: p.symbol, side: p.side === 'Buy' ? 'LONG' : 'SHORT', qty: num(p.size),
        entry: num(p.avgPrice), mark: num(p.markPrice), pnl: num(p.unrealisedPnl),
        lev: num(p.leverage), liq: num(p.liqPrice),
      })),
    };
  },

  async order(creds, o) {
    const params = {
      category: 'linear', symbol: o.symbol, side: o.side === 'BUY' ? 'Buy' : 'Sell',
      orderType: o.type === 'LIMIT' ? 'Limit' : 'Market', qty: String(o.qty),
    };
    if (o.type === 'LIMIT') { params.price = String(o.price); params.timeInForce = 'GTC'; }
    if (o.reduceOnly) params.reduceOnly = true;
    const r = await this.call(creds, { path: '/v5/order/create', method: 'POST', params });
    if (!r.ok) return { ok: false, error: r.err || ('HTTP ' + r.status) };
    return { ok: true, orderId: String(((r.body.result || {}).orderId) || ''), status: 'NEW' };
  },
};

/* ==========================================================================
   OKX v5 — единственный из трёх, кому нужна passphrase
   ========================================================================== */
const okx = {
  id: 'okx',
  name: 'OKX',
  needsPassphrase: true,
  helpUrl: 'https://www.okx.com/account/my-api',

  async call(creds, { path, method = 'GET', params = {} }) {
    const base = 'https://www.okx.com';
    const ts = new Date().toISOString();
    let p = path, body = '';
    if (method === 'GET') { const q = qs(params); if (q) p += '?' + q; }
    else body = JSON.stringify(params);
    const sig = hmacB64(creds.apiSecret, ts + method.toUpperCase() + p + body);
    const headers = {
      'OK-ACCESS-KEY': creds.apiKey, 'OK-ACCESS-SIGN': sig, 'OK-ACCESS-TIMESTAMP': ts,
      'OK-ACCESS-PASSPHRASE': creds.passphrase || '', 'Content-Type': 'application/json',
    };
    const r = await jfetch(base + p, { method, headers, body: method === 'GET' ? undefined : body });
    const code = r.body && r.body.code;
    return { ...r, ok: r.ok && String(code) === '0', err: r.body && (r.body.msg || (r.body.data && r.body.data[0] && r.body.data[0].sMsg)) };
  },

  async probe(creds) {
    const r = await this.call(creds, { path: '/api/v5/account/config' });
    if (!r.ok) return { ok: false, error: r.err || ('HTTP ' + r.status) };
    const d = ((r.body.data || [])[0]) || {};
    // OKX отдаёт perm строкой вида "read_only,trade" или "read_only,withdraw,trade".
    const perm = String(d.perm || '');
    return {
      ok: true,
      canWithdraw: /withdraw/i.test(perm),
      canTrade: /trade/i.test(perm),
      canFutures: /trade/i.test(perm),
      ipRestricted: null,   // OKX не отдаёт это здесь — честно возвращаем «неизвестно»
    };
  },

  async balances(creds) {
    const r = await this.call(creds, { path: '/api/v5/account/balance' });
    if (!r.ok) return { ok: false, error: r.err || ('HTTP ' + r.status) };
    const details = (((r.body.data || [])[0]) || {}).details || [];
    return {
      ok: true,
      assets: details.filter(c => num(c.eq) > 0).map(c => ({
        asset: c.ccy, free: num(c.availBal) || num(c.availEq), total: num(c.eq),
      })),
    };
  },

  async positions(creds) {
    const r = await this.call(creds, { path: '/api/v5/account/positions', params: { instType: 'SWAP' } });
    if (!r.ok) return { ok: false, error: r.err || ('HTTP ' + r.status) };
    const list = r.body.data || [];
    return {
      ok: true,
      positions: list.filter(p => num(p.pos) !== 0).map(p => ({
        symbol: p.instId, side: num(p.pos) > 0 ? 'LONG' : 'SHORT', qty: Math.abs(num(p.pos)),
        entry: num(p.avgPx), mark: num(p.markPx), pnl: num(p.upl), lev: num(p.lever), liq: num(p.liqPx),
      })),
    };
  },

  async order(creds, o) {
    const params = {
      instId: o.symbol, tdMode: 'cross', side: o.side === 'BUY' ? 'buy' : 'sell',
      ordType: o.type === 'LIMIT' ? 'limit' : 'market', sz: String(o.qty),
    };
    if (o.type === 'LIMIT') params.px = String(o.price);
    if (o.reduceOnly) params.reduceOnly = true;
    const r = await this.call(creds, { path: '/api/v5/trade/order', method: 'POST', params });
    if (!r.ok) return { ok: false, error: r.err || ('HTTP ' + r.status) };
    const d = (r.body.data || [])[0] || {};
    return { ok: true, orderId: String(d.ordId || ''), status: 'NEW' };
  },
};

export const ADAPTERS = { binance, bybit, okx };

export function adapterFor(id) {
  return ADAPTERS[String(id || '').toLowerCase()] || null;
}

/** Публичный список бирж для интерфейса — без единой строчки секретов. */
export function exchangeCatalog() {
  return Object.values(ADAPTERS).map(a => ({
    id: a.id, name: a.name, needsPassphrase: a.needsPassphrase, helpUrl: a.helpUrl,
  }));
}

export const _internal = { hmacHex, hmacB64, qs };
