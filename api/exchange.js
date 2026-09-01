// /api/exchange — подключение биржи по API-ключу и торговля реальным балансом.
//
//   GET  ?action=catalog                     -> список поддерживаемых бирж (без авторизации)
//   GET  ?action=status                      -> какие биржи подключены у пользователя
//   POST {action:'connect', exchange, apiKey, apiSecret, passphrase}
//   POST {action:'disconnect', exchange}
//   POST {action:'balances', exchange}
//   POST {action:'positions', exchange}
//   POST {action:'order', exchange, symbol, side, type, qty, price, reduceOnly}
//
// ЧТО ЗДЕСЬ ВАЖНО.
//
// 1. Секрет никогда не возвращается клиенту. Ни в одном ответе. Совсем.
//    Наружу уходит только маска ключа (первые/последние 4 символа).
//
// 2. Ключ с правом ВЫВОДА СРЕДСТВ не сохраняется — запрос отклоняется с
//    объяснением. Это единственная защита, которая работает даже если
//    скомпрометирован сервер: украсть можно, вывести — нет.
//
// 3. Пользователь берётся из токена сеанса, никогда из тела запроса.
//    Ключи шифруются с AAD = userId, поэтому чужую строку не расшифровать.
//
// 4. Это РЕАЛЬНЫЕ деньги на бирже пользователя, в отличие от остального
//    приложения (проп-симулятор). Поэтому ордера идут только по явному
//    действию человека: автоторговля сюда намеренно не подключена —
//    см. блок про AUTO_TRADE_FORBIDDEN ниже.

import { requireUser } from './_session.js';
import { seal, open, maskKey, encryptionReady } from './_crypto.js';
import { adapterFor, exchangeCatalog } from './_exchanges.js';

/* Автоторговля реальным балансом сознательно не реализована.
   Движок сигналов этого приложения честно измерен на истории
   (research/MIE_BACKTEST.md): средний R −0,169 при t = −3,44, то есть
   систематический убыток, значимо хуже случайного входа. Подключить такой
   движок к реальным деньгам — это не фича, а способ гарантированно слить
   счёт пользователя. Ручная торговля через этот эндпоинт разрешена:
   решение принимает человек. */
const AUTO_TRADE_FORBIDDEN = true;

function sb() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  return url && key ? { url, key } : null;
}

const SYMBOL_RE = /^[A-Z0-9][A-Z0-9._-]{1,30}$/;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Ответы этого эндпоинта не должны попадать ни в какой кэш.
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Каталог бирж — единственное, что доступно без входа: там нет ничего личного.
  if (req.method === 'GET' && req.query.action === 'catalog') {
    return res.status(200).json({ exchanges: exchangeCatalog(), encryption: encryptionReady() });
  }

  const auth = requireUser(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error, detail: auth.detail });
  const userId = auth.userId;

  const cfg = sb();
  if (!cfg) return res.status(500).json({ error: 'supabase не настроен' });
  if (!encryptionReady()) {
    return res.status(503).json({
      error: 'encryption_not_configured',
      detail: 'Шифрование не настроено: нет ни EXCHANGE_ENC_KEY, ни TELEGRAM_BOT_TOKEN. Без ключа шифрования ключи бирж не хранятся.',
    });
  }
  const H = { 'Content-Type': 'application/json', apikey: cfg.key, Authorization: `Bearer ${cfg.key}` };

  /* ХРАНИЛИЩЕ. Зашифрованные ключи лежат в уже существующей таблице
     app_settings (key text, value jsonb) строками вида
       key = "exkeys:<userId>:<exchange>", value = { ...поля строки }
     Отдельная таблица exchange_keys (api/exchange_keys.sql) была бы чище,
     но требует ручного шага в Supabase SQL Editor. app_settings уже есть в
     проде, у неё включён RLS без политик, и /api/config читает из неё строго
     key=main — чужие строки оттуда не утекают. Защита данных здесь обеспечена
     шифрованием, а не именем таблицы, поэтому это честная замена, а не костыль.
     Переехать на отдельную таблицу можно, поменяв только эти пять функций. */
  const rowKey = (ex) => `exkeys:${userId}:${ex}`;
  const PREFIX = `exkeys:${userId}:`;

  async function readRows() {
    // PostgREST like: * — подстановочный символ.
    const r = await fetch(`${cfg.url}/rest/v1/app_settings?key=like.${encodeURIComponent(PREFIX + '*')}&select=key,value`, { headers: H });
    if (!r.ok) return [];
    const rows = await r.json();
    if (!Array.isArray(rows)) return [];
    // Страховка: like-фильтр мог бы зацепить лишнее — оставляем только строки этого пользователя.
    return rows.filter(x => typeof x.key === 'string' && x.key.startsWith(PREFIX) && x.value && typeof x.value === 'object')
      .map(x => ({ ...x.value, exchange: x.key.slice(PREFIX.length) }));
  }
  async function writeRow(exchange, value) {
    return fetch(`${cfg.url}/rest/v1/app_settings`, {
      method: 'POST',
      headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ key: rowKey(exchange), value, updated_at: new Date().toISOString() }),
    });
  }
  async function deleteRow(exchange) {
    return fetch(`${cfg.url}/rest/v1/app_settings?key=eq.${encodeURIComponent(rowKey(exchange))}`,
      { method: 'DELETE', headers: { ...H, Prefer: 'return=minimal' } });
  }
  async function readOne(exchange) {
    const rows = await readRows();
    return rows.find(x => x.exchange === exchange) || null;
  }
  /** Расшифровывает креды. Возвращает null, если строку не удалось открыть. */
  function credsOf(row) {
    if (!row) return null;
    const apiKey = open(row.api_key_enc, userId);
    const apiSecret = open(row.api_secret_enc, userId);
    const passphrase = row.passphrase_enc ? open(row.passphrase_enc, userId) : '';
    if (!apiKey || !apiSecret) return null;
    return { apiKey, apiSecret, passphrase: passphrase || '' };
  }

  const body = req.body || {};
  const action = (req.method === 'GET' ? req.query.action : body.action) || '';

  try {
    /* ---------------- статус ---------------- */
    if (action === 'status') {
      const rows = await readRows();
      return res.status(200).json({
        exchanges: exchangeCatalog(),
        connected: rows.map(r => ({
          exchange: r.exchange, keyMask: r.key_mask, label: r.label || null,
          canTrade: r.can_trade, canFutures: r.can_futures, ipRestricted: r.ip_restricted,
          connectedAt: r.created_at, lastUsedAt: r.last_used_at,
        })),
        autoTradeAllowed: !AUTO_TRADE_FORBIDDEN,
      });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

    /* ---------------- подключение ---------------- */
    if (action === 'connect') {
      const ad = adapterFor(body.exchange);
      if (!ad) return res.status(400).json({ error: 'unknown_exchange' });
      const apiKey = String(body.apiKey || '').trim();
      const apiSecret = String(body.apiSecret || '').trim();
      const passphrase = String(body.passphrase || '').trim();
      if (apiKey.length < 8 || apiSecret.length < 8) return res.status(400).json({ error: 'bad_key', detail: 'Ключ или секрет слишком короткие.' });
      if (ad.needsPassphrase && !passphrase) return res.status(400).json({ error: 'passphrase_required', detail: ad.name + ' требует passphrase.' });

      // Проверяем ключ на бирже ДО сохранения: заодно узнаём права.
      let probe;
      try { probe = await ad.probe({ apiKey, apiSecret, passphrase }); }
      catch (e) { return res.status(502).json({ error: 'exchange_unreachable', detail: String(e).slice(0, 160) }); }
      if (!probe.ok) return res.status(400).json({ error: 'key_rejected', detail: probe.error || 'Биржа отклонила ключ.' });

      // ЖЁСТКОЕ ПРАВИЛО: ключ с правом вывода не принимаем.
      if (probe.canWithdraw) {
        return res.status(400).json({
          error: 'withdrawal_enabled',
          detail: 'У этого ключа разрешён ВЫВОД СРЕДСТВ. Такой ключ мы не сохраняем: ' +
            'если он утечёт, деньги можно вывести. Создайте ключ заново, оставив только ' +
            'права на торговлю и чтение, и обязательно ограничьте его по IP.',
        });
      }
      if (!probe.canTrade) {
        return res.status(400).json({ error: 'no_trade_permission', detail: 'У ключа нет прав на торговлю — торговать им не получится.' });
      }

      const prev = await readOne(ad.id);
      const row = {
        api_key_enc: seal(apiKey, userId),
        api_secret_enc: seal(apiSecret, userId),
        passphrase_enc: passphrase ? seal(passphrase, userId) : null,
        key_mask: maskKey(apiKey),
        label: String(body.label || '').slice(0, 40) || null,
        can_trade: !!probe.canTrade,
        can_futures: !!probe.canFutures,
        ip_restricted: probe.ipRestricted === null ? null : !!probe.ipRestricted,
        created_at: (prev && prev.created_at) || new Date().toISOString(),
        updated_at: new Date().toISOString(),
        last_used_at: null,
      };
      const w = await writeRow(ad.id, row);
      if (!w.ok) {
        const t = await w.text();
        return res.status(500).json({ error: 'save_failed', detail: t.slice(0, 200) });
      }
      return res.status(200).json({
        ok: true, exchange: ad.id, keyMask: row.key_mask,
        canFutures: row.can_futures, ipRestricted: row.ip_restricted,
        warning: probe.ipRestricted === false
          ? 'Ключ не ограничен по IP. Рекомендуем добавить ограничение в настройках биржи.'
          : null,
      });
    }

    /* ---------------- отключение ---------------- */
    if (action === 'disconnect') {
      const ad = adapterFor(body.exchange);
      if (!ad) return res.status(400).json({ error: 'unknown_exchange' });
      const d = await deleteRow(ad.id);
      if (!d.ok) return res.status(500).json({ error: 'delete_failed' });
      return res.status(200).json({ ok: true });
    }

    /* ---------------- операции с подключённым ключом ---------------- */
    const ad = adapterFor(body.exchange);
    if (!ad) return res.status(400).json({ error: 'unknown_exchange' });
    const row = await readOne(ad.id);
    if (!row) return res.status(404).json({ error: 'not_connected', detail: ad.name + ' не подключена.' });
    const creds = credsOf(row);
    if (!creds) {
      return res.status(500).json({
        error: 'decrypt_failed',
        detail: 'Не удалось расшифровать ключ. Обычно это значит, что сменился ключ шифрования (EXCHANGE_ENC_KEY или токен бота). Переподключите биржу.',
      });
    }

    // Отметка использования — полезна, чтобы видеть «живой» ли ключ.
    // Строка целиком в jsonb, поэтому «отметить использование» = переписать значение.
    const { exchange: _ex, ...stored } = row;
    const touch = () => writeRow(ad.id, { ...stored, last_used_at: new Date().toISOString() }).catch(() => {});

    if (action === 'balances') {
      const r = await ad.balances(creds); touch();
      return r.ok ? res.status(200).json({ ok: true, assets: r.assets }) : res.status(502).json({ error: 'exchange', detail: r.error });
    }

    if (action === 'positions') {
      const r = await ad.positions(creds); touch();
      return r.ok ? res.status(200).json({ ok: true, positions: r.positions }) : res.status(502).json({ error: 'exchange', detail: r.error });
    }

    if (action === 'order') {
      // Автоматические заявки на реальные деньги не принимаются — см. комментарий вверху файла.
      if (body.auto && AUTO_TRADE_FORBIDDEN) {
        return res.status(403).json({
          error: 'auto_trade_forbidden',
          detail: 'Автоторговля реальным балансом отключена: движок сигналов на истории даёт ' +
            'отрицательное матожидание (research/MIE_BACKTEST.md). Ордер можно отправить только вручную.',
        });
      }
      const symbol = String(body.symbol || '').toUpperCase();
      if (!SYMBOL_RE.test(symbol)) return res.status(400).json({ error: 'bad_symbol' });
      const side = String(body.side || '').toUpperCase();
      if (side !== 'BUY' && side !== 'SELL') return res.status(400).json({ error: 'bad_side' });
      const type = String(body.type || 'MARKET').toUpperCase();
      if (type !== 'MARKET' && type !== 'LIMIT') return res.status(400).json({ error: 'bad_type' });
      const qty = Number(body.qty);
      if (!(qty > 0) || !isFinite(qty)) return res.status(400).json({ error: 'bad_qty' });
      const price = type === 'LIMIT' ? Number(body.price) : null;
      if (type === 'LIMIT' && !(price > 0)) return res.status(400).json({ error: 'bad_price' });

      const r = await ad.order(creds, { symbol, side, type, qty, price, reduceOnly: !!body.reduceOnly });
      touch();
      return r.ok
        ? res.status(200).json({ ok: true, orderId: r.orderId, status: r.status })
        : res.status(502).json({ error: 'exchange', detail: r.error });
    }

    return res.status(400).json({ error: 'unknown_action' });
  } catch (e) {
    // Наружу — только общая формулировка: в тексте исключения могут оказаться заголовки с ключом.
    return res.status(500).json({ error: 'server' });
  }
}
