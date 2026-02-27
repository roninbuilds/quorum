/**
 * seed-options.ts
 * Creates sample option contracts on Solana devnet
 * Run after anchor deploy to populate the venue intelligence dashboard
 *
 * Usage: ts-node server/seed-options.ts
 *
 * This demonstrates the on-chain data that powers the venue intelligence panel.
 * In production, these would be created by real fans paying real SOL.
 */

import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import * as fs from 'fs';
import * as os from 'os';
import * as dotenv from 'dotenv';

dotenv.config();

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const PROGRAM_ID_STR = process.env.QUORUM_PROGRAM_ID || 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS';

async function loadWallet(): Promise<Keypair> {
  const keyPath = os.homedir() + '/.config/solana/id.json';
  const keyData = JSON.parse(fs.readFileSync(keyPath, 'utf-8'));
  return Keypair.fromSecretKey(new Uint8Array(keyData));
}

interface SeedOption {
  optionId: string;
  eventName: string;
  eventDate: string;
  ticketType: string;
  quantity: number;
  premiumSOL: number;
  daysFromNow: number;
  status: 'Active' | 'Exercised' | 'Expired';
}

const SEED_OPTIONS: SeedOption[] = [
  {
    optionId: 'florist-001',
    eventName: 'Florist',
    eventDate: '2026-03-01',
    ticketType: 'General Admission',
    quantity: 2,
    premiumSOL: 3,
    daysFromNow: 3, // expires in 3 days
    status: 'Active',
  },
  {
    optionId: 'gimme-disco-001',
    eventName: 'Gimme Gimme Disco',
    eventDate: '2026-03-07',
    ticketType: 'VIP',
    quantity: 4,
    premiumSOL: 8, // sold out = higher premium
    daysFromNow: 3,
    status: 'Active',
  },
  {
    optionId: 'emo-night-001',
    eventName: 'Emo Night Brooklyn',
    eventDate: '2026-03-14',
    ticketType: 'General Admission',
    quantity: 1,
    premiumSOL: 2,
    daysFromNow: -1, // expired yesterday
    status: 'Exercised',
  },
  {
    optionId: 'matinee-001',
    eventName: 'Matinee Social Club',
    eventDate: '2026-03-15',
    ticketType: 'General Admission',
    quantity: 2,
    premiumSOL: 5,
    daysFromNow: -2, // expired 2 days ago
    status: 'Expired',
  },
];

async function main() {
  console.log('🌱 Seeding option contracts on Solana devnet...');
  console.log(`   RPC: ${RPC_URL}`);
  console.log(`   Program: ${PROGRAM_ID_STR}`);

  const connection = new Connection(RPC_URL, 'confirmed');
  const wallet = await loadWallet();
  const programId = new PublicKey(PROGRAM_ID_STR);

  console.log(`   Wallet: ${wallet.publicKey.toBase58()}`);

  const balance = await connection.getBalance(wallet.publicKey);
  console.log(`   Balance: ${balance / 1e9} SOL\n`);

  if (balance < 1e9) {
    console.log('⚠️ Low balance — requesting airdrop...');
    const sig = await connection.requestAirdrop(wallet.publicKey, 2e9);
    await connection.confirmTransaction(sig);
    console.log('✅ Airdrop confirmed');
  }

  for (const seed of SEED_OPTIONS) {
    console.log(`\n📜 Creating option: ${seed.optionId}`);
    console.log(`   Event: ${seed.eventName} · ${seed.quantity}x ${seed.ticketType}`);
    console.log(`   Premium: ${seed.premiumSOL} SOL · Status: ${seed.status}`);

    try {
      // Derive PDA
      const [pda, bump] = PublicKey.findProgramAddressSync(
        [Buffer.from('option'), Buffer.from(seed.optionId)],
        programId
      );

      // Check if already exists
      const existing = await connection.getAccountInfo(pda);
      if (existing) {
        console.log(`   ⏭️ Already exists at ${pda.toBase58()}`);
        continue;
      }

      const now = Math.floor(Date.now() / 1000);
      const expiry = now + seed.daysFromNow * 86400;

      // For demo: just log what would be created
      // Full on-chain creation requires the Anchor program IDL
      console.log(`   📍 PDA: ${pda.toBase58()}`);
      console.log(`   ⏰ Expiry: ${new Date(expiry * 1000).toISOString()}`);
      console.log(`   ✅ Would create on-chain (requires deployed program)`);

    } catch (err: any) {
      console.error(`   ❌ Error: ${err.message}`);
    }
  }

  console.log('\n✅ Seed complete');
  console.log('\nNote: For full on-chain seeding, run after anchor deploy and update QUORUM_PROGRAM_ID in .env');
  console.log('The server/solana.ts file uses these same values as fallback seed data for the demo.');
}

main().catch(console.error);
