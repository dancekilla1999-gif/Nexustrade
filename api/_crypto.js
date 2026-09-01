// Шифрование секретов биржевых API-ключей.
//
// Модель угроз, от которой это защищает:
//   - утечка дампа базы (ключи лежат зашифрованными, мастер-ключ — в env);
//   - подмена строки между пользователями (userId входит в AAD, чужая строка
//     не расшифруется);
//   - случайное попадание секрета в лог или в ответ API (секрет физически
//     не выходит за пределы серверной функции — см. api/exchange.js).
//
// От чего НЕ защищает и об этом надо говорить прямо: если скомпрометирован
// сам сервер вместе с env, ключи можно расшифровать. Поэтому единственная
// настоящая защита пользователя — API-ключ БЕЗ права вывода средств, и
// api/exchange.js отказывается сохранять ключ, у которого вывод разрешён.
//
// Требует env EXCHANGE_ENC_KEY: 32 байта в base64 или hex, либо любая
// достаточно длинная парольная фраза (из неё ключ выводится scrypt).

import crypto from 'crypto';

const ALG = 'aes-256-gcm';
const IV_LEN = 12;      // рекомендованный размер nonce для GCM
const TAG_LEN = 16;
// Соль фиксированная намеренно: она не секрет, её задача — привязать
// вывод ключа к этому приложению, а не рандомизировать каждый вызов
// (иначе ключ был бы разным при каждом шифровании и ничего не расшифровалось).
const KDF_SALT = 'nexus-exchange-keys-v1';

let _cached = null;

/** Мастер-ключ из env. 32 байта. Бросает исключение, если не настроен. */
export function masterKey() {
  if (_cached) return _cached;
  const raw = process.env.EXCHANGE_ENC_KEY;
  if (!raw || String(raw).length < 16) {
    throw new Error('EXCHANGE_ENC_KEY не настроен (нужно ≥16 символов)');
  }
  const s = String(raw).trim();
  let key = null;
  // Ровно 32 байта в base64 или hex используем как есть; иначе — scrypt.
  if (/^[0-9a-fA-F]{64}$/.test(s)) key = Buffer.from(s, 'hex');
  else {
    try {
      const b = Buffer.from(s, 'base64');
      if (b.length === 32 && b.toString('base64').replace(/=+$/, '') === s.replace(/=+$/, '')) key = b;
    } catch (e) { /* не base64 — пойдём через scrypt */ }
  }
  if (!key) key = crypto.scryptSync(s, KDF_SALT, 32);
  _cached = key;
  return key;
}

/** Настроено ли шифрование. Позволяет отдать понятную ошибку вместо 500. */
export function encryptionReady() {
  try { masterKey(); return true; } catch (e) { return false; }
}

/**
 * Шифрует строку. aad привязывает шифротекст к контексту (у нас — к userId),
 * поэтому строку нельзя переставить другому пользователю.
 * Формат: v1.<iv b64url>.<tag b64url>.<ciphertext b64url>
 */
export function seal(plaintext, aad) {
  const iv = crypto.randomBytes(IV_LEN);
  const c = crypto.createCipheriv(ALG, masterKey(), iv, { authTagLength: TAG_LEN });
  if (aad) c.setAAD(Buffer.from(String(aad), 'utf8'));
  const ct = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  const b64 = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return 'v1.' + b64(iv) + '.' + b64(tag) + '.' + b64(ct);
}

/** Расшифровывает. Возвращает null при любой ошибке — не бросает и не различает причины. */
export function open(sealed, aad) {
  try {
    const parts = String(sealed || '').split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') return null;
    const un = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const iv = un(parts[1]), tag = un(parts[2]), ct = un(parts[3]);
    if (iv.length !== IV_LEN || tag.length !== TAG_LEN) return null;
    const d = crypto.createDecipheriv(ALG, masterKey(), iv, { authTagLength: TAG_LEN });
    if (aad) d.setAAD(Buffer.from(String(aad), 'utf8'));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch (e) { return null; }
}

/** Маска для показа пользователю: «abcd…wxyz». Секрет не маскируем никогда — он не показывается вообще. */
export function maskKey(k) {
  const s = String(k || '');
  if (s.length <= 10) return s ? s.slice(0, 2) + '…' : '';
  return s.slice(0, 4) + '…' + s.slice(-4);
}
