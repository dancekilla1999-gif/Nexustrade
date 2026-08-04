/**
 * Metaplex Token Metadata — имя, символ, URI JSON.
 * URI должен указывать на JSON вида:
 * {
 *   "name": "NexusTrade Token",
 *   "symbol": "NEXUS",
 *   "description": "...",
 *   "image": "https://.../logo.png"
 * }
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import {
  createMetadataAccountV3,
  findMetadataPda,
  mplTokenMetadata,
} from '@metaplex-foundation/mpl-token-metadata';
import {
  keypairIdentity,
  publicKey,
  createSignerFromKeypair,
} from '@metaplex-foundation/umi';
import { fromWeb3JsKeypair } from '@metaplex-foundation/umi-web3js-adapters';
import { Keypair } from '@solana/web3.js';

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
  const rpc = process.env.SOLANA_RPC || cfg.network;
  const umi = createUmi(rpc).use(mplTokenMetadata());
  const kp = loadKeypair();
  const umiKp = umi.eddsa.createKeypairFromSecretKey(kp.secretKey);
  umi.use(keypairIdentity(umiKp));

  const mint = publicKey(cfg.mint);
  const metadata = findMetadataPda(umi, { mint });

  const name = process.env.TOKEN_NAME || cfg.name || 'NexusTrade Token';
  const symbol = process.env.TOKEN_SYMBOL || cfg.symbol || 'NEXUS';
  const uri = process.env.TOKEN_URI || 'https://example.com/nexus-metadata.json';

  await createMetadataAccountV3(umi, {
    metadata,
    mint,
    mintAuthority: umi.identity,
    payer: umi.identity,
    updateAuthority: umi.identity,
    data: {
      name,
      symbol,
      uri,
      sellerFeeBasisPoints: 0,
      creators: null,
      collection: null,
      uses: null,
    },
    isMutable: true,
    collectionDetails: null,
  }).sendAndConfirm(umi);

  console.log('✅ Metadata created for', cfg.mint);
  console.log('Name:', name, 'Symbol:', symbol);
  console.log('URI:', uri);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
