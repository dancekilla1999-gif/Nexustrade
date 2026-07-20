export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const key = process.env.COINGECKO_API_KEY || '';
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const perPage = 120;

  const base = 'https://api.coingecko.com/api/v3/coins/markets';
  const url = base +
    '?vs_currency=usd&order=market_cap_desc&per_page=' + perPage +
    '&page=' + page + '&price_change_percentage=24h&sparkline=true';

  try {
    const headers = { accept: 'application/json' };
    if (key) headers['x-cg-demo-api-key'] = key;
    const r = await fetch(url, { headers });
    if (!r.ok) {
      const t = await r.text();
      return res.status(502).json({ error: 'coingecko', detail: t.slice(0, 300) });
    }
    const raw = await r.json();
    const coins = (Array.isArray(raw) ? raw : []).map(c => ({
      id: c.id,
      sym: (c.symbol || '').toUpperCase(),
      name: c.name,
      price: c.current_price,
      change: c.price_change_percentage_24h,
      cap: c.market_cap,
      img: c.image,
      spark: (c.sparkline_in_7d && c.sparkline_in_7d.price) ? c.sparkline_in_7d.price.filter((_, i) => i % 6 === 0) : [],
    })).filter(c => c.price != null);
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    return res.status(200).json({ coins, page });
  } catch (e) {
    return res.status(500).json({ error: 'server', detail: String(e).slice(0, 200) });
  }
}
