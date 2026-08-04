/**
 * Создаёт SPL Token на Solana (devnet/mainnet).
 * Запуск: npm run create-token
 *
 * После успеха сохраните MINT address — он нужен для кошелька NexusTrade.
 */
import 'dotenv/config';
import {
  Connection,
  Keypair,
  clusterApiUrl,
  PublicKey,
} from '@solana/web3.js';
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getMint,
  setAuthority,
  AuthorityType,
} from '@solana/spl-token';
import * as fs from 'fs';
import * as path from 'path';

function loadKeypair(): Keypair {
  const raw = process.env.DEPLOYER_SECRET;
  if (!raw) throw new Error('DEPLOYER_SECRET не задан в .env');
  // JSON array [1,2,...] или путь к файлу id.json
  if (raw.trim().startsWith('[')) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  }
  const file = path.resolve(raw);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, 'utf8'))));
}

async function main() {
  const rpc = process.env.SOLANA_RPC || clusterApiUrl('devnet');
  const decimals = Number(process.env.TOKEN_DECIMALS || 9);
  const supplyUi = Number(process.env.TOKEN_SUPPLY || 1_000_000_000); // human units
  const connection = new Connection(rpc, 'confirmed');
  const payer = loadKeypair();

  console.log('Network:', rpc);
  console.log('Deployer:', payer.publicKey.toBase58());

  const bal = await connection.getBalance(payer.publicKey);
  console.log('SOL balance:', bal / 1e9);
  if (bal < 0.05 * 1e9) {
    console.warn('Мало SOL. На devnet: solana airdrop 2');
  }

  // 1) Create mint
  const mint = await createMint(
    connection,
    payer,
    payer.publicKey, // mint authority
    payer.publicKey, // freeze authority (можно null)
    decimals
  );
  console.log('✅ MINT:', mint.toBase58());

  // 2) ATA for deployer + initial supply
  const ata = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mint,
    payer.publicKey
  );
  const amount = BigInt(Math.floor(supplyUi * 10 ** decimals));
  await mintTo(connection, payer, mint, ata.address, payer, amount);
  console.log('✅ Minted', supplyUi, 'tokens to', ata.address.toBase58());

  const info = await getMint(connection, mint);
  console.log('Supply (raw):', info.supply.toString());
  console.log('Decimals:', info.decimals);

  // Save local config for NexusTrade integration
  const out = {
    network: rpc,
    mint: mint.toBase58(),
    decimals,
    supply: supplyUi,
    deployer: payer.publicKey.toBase58(),
    createdAt: new Date().toISOString(),
    symbol: process.env.TOKEN_SYMBOL || 'NEXUS',
    name: process.env.TOKEN_NAME || 'NexusTrade Token',
  };
  fs.writeFileSync(
    path.join(__dirname, '..', 'token-config.json'),
    JSON.stringify(out, null, 2)
  );
  console.log('Saved token-config.json');
  console.log('\nДальше: npm run metadata  (имя/символ/картинка в кошельках)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
