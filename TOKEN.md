# NEXUS (Solana) + внутренний кошелёк

## 1. Создать токен
См. папку `token/` — `npm run create-token` на devnet/mainnet.

## 2. Env на Vercel
```
NEXUS_MINT=<mint address>
NEXUS_VAULT=<treasury ATA or wallet>
NEXUS_DECIMALS=9
NEXUS_SYMBOL=NEXUS
NEXUS_NETWORK=solana-devnet
NEXUS_DEMO_CREDIT=1
SUPABASE_URL=...
SUPABASE_SERVICE_KEY=...
```

## 3. Supabase SQL
Выполнить `api/nexus_schema.sql` в SQL Editor.

## 4. В приложении
Кошелёк → блок **◎ NEXUS** → Пополнить / Вывести / +100 демо.
