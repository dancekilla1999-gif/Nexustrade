# Внутренний кошелёк NexusTrade + Solana NEXUS

## Архитектура (рекомендуемая)

```
Telegram Mini App (NexusTrade)
        │
        ▼
  «Внутренний баланс» NEXUS  ←→  custodial ledger (ваш backend)
        │
        │  deposit / withdraw
        ▼
  Solana SPL Token (mint из token-config.json)
```

### Почему так
- В Telegram WebView неудобно каждый раз подписывать транзакции.
- Для торговли/бонусов — **off-chain ledger** (быстро, как сейчас USDT-балансы).
- Ончейн — только **ввод/вывод** NEXUS на внешний Solana-кошелёк пользователя.

## Шаги запуска токена

1. Установить Solana CLI + Node 20+
2. `solana-keygen new -o deployer.json`
3. `solana config set --url devnet`
4. `solana airdrop 2` (devnet)
5. Скопировать `.env.example` → `.env`, указать `DEPLOYER_SECRET=./deployer.json`
6. `npm i`
7. `npm run create-token`  → появится `token-config.json` с **mint**
8. Залить `metadata.example.json` + лого на CDN, прописать `TOKEN_URI`
9. `npm run metadata`
10. На mainnet — то же с `SOLANA_RPC=https://api.mainnet-beta.solana.com` и реальным SOL
11. После дистрибуции: `npm run revoke-mint` (фиксированный supply)

## API для NexusTrade (backend)

```
POST /api/wallet/nexus/deposit-address
  → { address: "<user dedicated ATA or shared vault + memo>" }

POST /api/wallet/nexus/credit
  body: { txSignature }
  → проверяет on-chain transfer на vault → +balance в БД

POST /api/wallet/nexus/withdraw
  body: { amount, toSolanaAddress }
  → списывает off-chain → шлёт SPL transfer с hot-wallet
```

## UI в мини-аппе

Вкладка **Кошелёк**:
- Баланс NEXUS (внутренний)
- Кнопка «Пополнить» (показать адрес / QR)
- Кнопка «Вывести» (адрес Solana + amount)
- История депозитов/выводов

## Безопасность

- Hot-wallet ключ **только** на сервере (Vercel env / KMS), никогда в фронте
- Лимиты вывода в сутки
- Для крупных сумм — мультисиг (Squads)
- Не храните `DEPLOYER_SECRET` в GitHub

## Program ID

Anchor-программа `programs/nexus_token` — опциональна.
Для запуска токена достаточно SPL Token + Metadata (скрипты выше).
Свой program нужен, если хотите on-chain vesting / staking / fee-share.
