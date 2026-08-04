# NexusTrade Token (Solana)

SPL-токен **NEXUS** + скрипты деплоя и план внутреннего кошелька.

## Быстрый старт (devnet)

```bash
# 1. Solana CLI: https://docs.solana.com/cli/install-solana-cli-tools
solana-keygen new -o deployer.json
solana config set --url devnet
solana airdrop 2

# 2. Node deps
cp .env.example .env
# в .env: DEPLOYER_SECRET=./deployer.json

npm install
npm run create-token
# → token-config.json с адресом mint

# 3. Метаданные (имя в Phantom / Solflare)
# загрузите metadata.example.json + logo на публичный URL
# TOKEN_URI=https://... npm run metadata
```

## Структура

| Путь | Назначение |
|------|------------|
| `scripts/createToken.ts` | Создание mint + initial supply |
| `scripts/setMetadata.ts` | Metaplex name/symbol/image |
| `scripts/revokeMintAuthority.ts` | Зафиксировать supply |
| `programs/nexus_token` | Опциональный Anchor-program |
| `NEXUS_WALLET_INTEGRATION.md` | Как встроить в NexusTrade |

## Mainnet

1. Купить SOL на fees (~0.05–0.2 SOL)
2. `SOLANA_RPC=https://api.mainnet-beta.solana.com`
3. Повторить create-token / metadata
4. Листинг: Raydium / Meteora / Jupiter (отдельный liquidity pool)

Токен **не является** инвестиционной рекомендацией. Соблюдайте регуляторику вашей юрисдикции.
