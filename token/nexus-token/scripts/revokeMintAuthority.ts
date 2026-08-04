/**
 * После fair-launch: отзывает mint authority — больше нельзя допечатать токены.
 * ВНИМАНИЕ: необратимо.
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { Connection, Keypair } from '@solana/web3.js';
import { setAuthority, AuthorityType } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';

function loadKeypair(): Keypair {
  const raw = process.env.DEPLOYER_SECRET!;
  if (raw.trim().startsWith('[')) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  }
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.resolve(raw), 'utf8')))
  );
}

async function main() {
  const cfg = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'token-config.json'), 'utf8')
  );
  const connection = new Connection(process.env.SOLANA_RPC || cfg.network, 'confirmed');
  const payer = loadKeypair();
  const mint = new PublicKey(cfg.mint);

  await setAuthority(
    connection,
    payer,
    mint,
    payer.publicKey,
    AuthorityType.MintTokens,
    null // revoke
  );
  console.log('✅ Mint authority revoked for', mint.toBase58());
}

main().catch(console.error);
