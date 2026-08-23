// /api/notify — отправка уведомлений пользователю в Telegram.
//   POST { user:'tg_123456', type:'stage1'|'funded'|'fail'|'warn'|'payout', data:{...} }
// env: TELEGRAM_BOT_TOKEN, ADMIN_TG_ID (для копии владельцу)
//
// Уважает режим обслуживания бота: пока он включён, пользователям не пишем.

import { isDown } from './_settings.js';

const TEXTS = {
  stage1: (d) => `🏆 *Этап 1 пройден!*\n\n` +
    `Счёт: $${fmtNum(d.tier)}\n` +
    `Результат: +${(d.pct || 0).toFixed(2)}%\n\n` +
    `Открыт этап 2 — цель +${d.target2 || 8}%. Позиции закрыты, баланс зафиксирован.\n` +
    `Лимиты просадки прежние: дневной −${d.daily || 5}%, общий −${d.maxdd || 10}%.\n\n` +
    `Держите тот же риск, что и раньше — именно он вас сюда привёл.`,

  funded: (d) => `👑 *Челлендж пройден!*\n\n` +
    `Вы получили фандед-счёт $${fmtNum(d.tier)} с профит-сплитом 80%.\n\n` +
    `Что дальше:\n` +
    `• Целей по прибыли больше нет — важна стабильность\n` +
    `• Лимиты просадки остаются навсегда\n` +
    `• Первая заявка на выплату — через 14 дней\n\n` +
    `Совет: снизьте риск до 0.5% на сделку. Большинство теряет фандед не на плохой сделке, а на увеличении риска после успеха.`,

  fail: (d) => `📉 *Челлендж не пройден*\n\n` +
    `Счёт $${fmtNum(d.tier)} закрыт: ${d.reason || 'нарушен лимит просадки'}.\n\n` +
    `Но это не конец — это статистика.\n\n` +
    `Через это проходят почти все: по данным индустрии челлендж с первой попытки проходят менее 10% трейдеров. Разница между теми, кто в итоге получает капитал, и теми, кто уходит — только в одном: первые разбирают ошибки и возвращаются.\n\n` +
    `Что сделать сейчас:\n` +
    `1. Откройте «Портфель → Статистика» — посмотрите, где реально теряли\n` +
    `2. Проверьте: сколько сделок были вне вашей системы?\n` +
    `3. Отработайте слабое место на демо — он бесплатный и всегда доступен\n\n` +
    `Рынок никуда не денется. Возвращайтесь подготовленным.`,

  warn: (d) => `⚠️ *Внимание: приближение к лимиту*\n\n` +
    `Счёт $${fmtNum(d.tier)}\n` +
    `Использовано ${(d.used || 0).toFixed(0)}% дневного лимита.\n\n` +
    `Оставшийся буфер — ваша страховка на завтра, а не топливо для отыгрыша. Лучшее решение сейчас — закрыть терминал.`,

  milestone: (d) => `📈 *Половина пути пройдена*\n\n` +
    `Счёт $${fmtNum(d.tier)} · до цели этапа осталось ${(d.left || 0).toFixed(2)}%.\n\n` +
    `Самая частая ошибка на этом отрезке — увеличить риск, чтобы «добить быстрее». Именно так теряют уже заработанное. Держите прежний размер позиции.`,

  payout: (d) => `💰 *Выплата одобрена*\n\n` +
    `Сумма: $${fmtNum(d.amount)}\n` +
    `Сеть: ${d.network || '—'}\n\n` +
    `Средства будут отправлены на указанный адрес. Спасибо за вашу работу — вы в числе тех, кто дошёл.`,

  payout_ready: (d) => `🔓 *Выплата доступна*\n\n` +
    `Период удержания 14 дней пройден.\n` +
    `Доступно к выводу: $${fmtNum(d.amount)} (80% профита).\n\n` +
    `Заявку можно подать в разделе «Кошелёк».`,
};

function fmtNum(n) {
  return Number(n || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return res.status(200).json({ ok: false, note: 'нет TELEGRAM_BOT_TOKEN' });

  const { user, type, data } = req.body || {};
  const build = TEXTS[type];
  if (!build) return res.status(400).json({ error: 'type' });

  // ID чата берём из user вида tg_123456
  const chatId = String(user || '').startsWith('tg_') ? String(user).slice(3) : null;
  if (!chatId) return res.status(200).json({ ok: false, note: 'не Telegram-пользователь' });

  // Бот на обслуживании — пользователю не пишем.
  //
  // Это и есть смысл режима: во время работ человек не должен получать
  // «Челлендж провален» или «Выплата одобрена», пока за ботом стоит незаконченная
  // выкатка. Копию владельцу ниже отправляем всё равно — админ обязан видеть,
  // что произошло, даже когда бот молчит для остальных.
  if (await isDown('bot')) {
    await notifyAdminCopy(token, type, data, chatId, ' (бот на обслуживании, пользователю не отправлено)');
    return res.status(200).json({ ok: false, skipped: 'bot_maintenance' });
  }

  try {
    const text = build(data || {});
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    });

    await notifyAdminCopy(token, type, data, chatId, '');

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'server', detail: String(e).slice(0, 200) });
  }
}

/** Копия владельцу о важных событиях. */
async function notifyAdminCopy(token, type, data, chatId, suffix) {
  const admin = process.env.ADMIN_TG_ID;
  if (!admin || !['funded', 'fail', 'payout'].includes(type)) return;
  const label = type === 'funded' ? '👑 Трейдер получил фандед' :
                type === 'fail' ? '📉 Челлендж провален' : '💰 Выплата одобрена';
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: admin,
      text: `${label}${suffix}\nПользователь: ${data && data.name ? data.name : chatId}\nСчёт: $${fmtNum(data && data.tier)}`,
    }),
  }).catch(() => {});
}
