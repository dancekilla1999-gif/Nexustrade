const SYSTEM = `Ты — ИИ-аналитик криптотрейдинг-платформы Nexus Prop. Общайся на русском, кратко и по делу.
Тебе передают контекст с рыночными данными и рассчитанными тех-индикаторами (RSI, EMA, MACD, Stochastic, VWAP, Bollinger) и итогом "фильтров подтверждения" (сколько из 18 условий выполнено).
Правила:
- Давай обдуманный разбор: направление (LONG/SHORT), обоснование по индикаторам, ориентиры входа/тейка/стопа из контекста.
- Всегда указывай уровень подтверждения (например "14/18 фильтров").
- Не обещай прибыль и не давай гарантий. Добавляй, что это не финансовый совет и рынок рискован.
- Если данных мало — честно скажи, что ждём более чистой точки входа.
- Будь конкретным, без воды.`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'ANTHROPIC_API_KEY не задан' });

  try {
    const { message, context } = req.body || {};
    const userText =
      'Вопрос пользователя: ' + (message || 'дай разбор') + '\n\n' +
      'Контекст (данные и индикаторы):\n' + JSON.stringify(context || {}, null, 2);

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 700,
        system: SYSTEM,
        messages: [{ role: 'user', content: userText }],
      }),
    });

    if (!r.ok) {
      const t = await r.text();
      return res.status(502).json({ error: 'anthropic', detail: t.slice(0, 300) });
    }
    const data = await r.json();
    const reply = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    return res.status(200).json({ reply: reply || 'Пустой ответ модели.' });
  } catch (e) {
    return res.status(500).json({ error: 'server', detail: String(e).slice(0, 200) });
  }
}
