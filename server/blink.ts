/**
 * blink.ts
 * Solana Actions (Blinks) for Quorum option contract payments.
 * GET  /api/blink/:holdId        — returns Action JSON descriptor
 * POST /api/blink/:holdId/pay   — returns base64 transaction for wallet signing
 *
 * Uses @solana/kit for PDA derivation + RPC.
 * Uses manual borsh encoding — no Anchor IDL required at runtime.
 * Wire-format transaction serialized to base64 so any Solana wallet can sign it.
 */

import { Router, Request, Response } from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { getHoldState } from './state';
import {
  address,
  createSolanaRpc,
  getProgramDerivedAddress,
} from '@solana/kit';

const router = Router();

const PROGRAM_ID = process.env.QUORUM_PROGRAM_ID || 'FC1476pqPa9YtMiXVk2QTFMNEjfh8P16HiEM3DihHhqy';
const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';

// Blink CORS headers — required by Solana Actions spec
const blinkCors = cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Action-Version', 'X-Blockchain-Ids'],
});

router.use(blinkCors);
router.options('/{*path}', blinkCors); // preflight — Express v5 / path-to-regexp v8 syntax

// ─── Anchor instruction discriminator ────────────────────────────────────────
function discriminator(name: string): Buffer {
  const hash = crypto.createHash('sha256').update(`global:${name}`).digest();
  return hash.slice(0, 8);
}

// ─── Minimal borsh encoder ────────────────────────────────────────────────────
function borshString(s: string): Buffer {
  const bytes = Buffer.from(s, 'utf-8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([len, bytes]);
}

function borshU8(n: number): Buffer {
  const b = Buffer.alloc(1);
  b.writeUInt8(n, 0);
  return b;
}

function borshU64(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n, 0);
  return b;
}

function borshI64(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(n, 0);
  return b;
}

function borshU16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
}

// ─── Compact-u16 (Solana wire format) ────────────────────────────────────────
function compactU16(n: number): Buffer {
  if (n <= 0x7f) return Buffer.from([n]);
  if (n <= 0x3fff) return Buffer.from([(n & 0x7f) | 0x80, n >> 7]);
  return Buffer.from([(n & 0x7f) | 0x80, ((n >> 7) & 0x7f) | 0x80, n >> 14]);
}

// ─── Base58 decode ────────────────────────────────────────────────────────────
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Decode(s: string): Buffer {
  let num = BigInt(0);
  const base = BigInt(58);
  for (const char of s) {
    const idx = BASE58_ALPHABET.indexOf(char);
    if (idx < 0) throw new Error(`Invalid base58 char: ${char}`);
    num = num * base + BigInt(idx);
  }
  const hex = num.toString(16).padStart(64, '0');
  return Buffer.from(hex, 'hex');
}

// ─── Pricing ──────────────────────────────────────────────────────────────────
const DURATION_CONFIG: Record<string, { lamports: bigint; label: string }> = {
  '3': { lamports: BigInt(30_000_000), label: '$5 (0.03 SOL) — 3-day hold' },
  '7': { lamports: BigInt(60_000_000), label: '$10 (0.06 SOL) — 7-day hold' },
};

// ─── GET /api/blink/:holdId ───────────────────────────────────────────────────
router.get('/:holdId', (req: Request, res: Response) => {
  const holdId = String(req.params.holdId);
  const hold = getHoldState(holdId);

  const eventName = hold?.eventName || 'LPR Event';
  const quantity = hold?.quantity || 2;
  const ticketType = hold?.ticketType || 'GA';
  const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;

  res.setHeader('X-Action-Version', '2.4');
  res.setHeader('X-Blockchain-Ids', 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1');
  res.json({
    type: 'action',
    icon: `${PUBLIC_URL}/favicon.ico`,
    title: `QUORUM — Lock in ${quantity}x ${ticketType} for ${eventName}`,
    description: `Hold your ticket price on-chain while your group decides. Option premium paid in SOL. Cancel anytime.`,
    label: 'Lock In Price',
    links: {
      actions: [
        {
          label: '$5 — 3-Day Hold (0.03 SOL)',
          href: `${PUBLIC_URL}/api/blink/${holdId}/pay?duration=3`,
        },
        {
          label: '$10 — 7-Day Hold (0.06 SOL)',
          href: `${PUBLIC_URL}/api/blink/${holdId}/pay?duration=7`,
        },
      ],
    },
  });
});

// ─── POST /api/blink/:holdId/pay ─────────────────────────────────────────────
router.post('/:holdId/pay', async (req: Request, res: Response) => {
  try {
    const holdId = String(req.params.holdId);
    const durationStr = String(req.query.duration || '3');
    const { account } = req.body;

    if (!account) {
      res.status(400).json({ error: 'account (buyer pubkey) required in body' });
      return;
    }

    const config = DURATION_CONFIG[durationStr];
    if (!config) {
      res.status(400).json({ error: 'duration must be 3 or 7' });
      return;
    }

    const hold = getHoldState(holdId);
    const eventName = hold?.eventName || 'LPR Event';
    const eventDate = '2026-03-15';
    const ticketType = hold?.ticketType || 'GA';
    const quantity = hold?.quantity || 1;

    // Generate a unique option ID
    const optionId = `${holdId}-${durationStr}d-${Date.now()}`;
    const expiry = BigInt(Math.floor(Date.now() / 1000) + parseInt(durationStr) * 86400);

    // Derive PDA: seeds = ["option", optionId]
    const programAddr = address(PROGRAM_ID);
    const [pdaAddr] = await getProgramDerivedAddress({
      programAddress: programAddr,
      seeds: [
        Buffer.from('option'),
        Buffer.from(optionId, 'utf-8'),
      ],
    });

    // Fetch recent blockhash
    const rpc = createSolanaRpc(RPC_URL);
    const blockhashResp = await rpc.getLatestBlockhash({ commitment: 'finalized' }).send();
    const blockhash = blockhashResp.value.blockhash as string;

    // Build instruction data
    const disc = discriminator('create_option');
    const instructionData = Buffer.concat([
      disc,
      borshString(optionId),
      borshString(eventName),
      borshString(eventDate),
      borshString(ticketType),
      borshU8(quantity),
      borshU64(config.lamports),
      borshI64(expiry),
      borshU16(1000), // venue_royalty_bps = 10%
    ]);

    // Decode account keys
    const buyerKey = base58Decode(account);
    const pdaKey = base58Decode(String(pdaAddr));
    const systemKey = Buffer.from('0000000000000000000000000000000000000000000000000000000000000000', 'hex');
    const programKey = base58Decode(PROGRAM_ID);
    const blockhashBytes = base58Decode(blockhash);

    // Account indices in the message
    // 0 = buyer (feePayer, writable signer)
    // 1 = option_contract PDA (writable)
    // 2 = system_program (readonly)
    // 3 = program itself (for invocation)

    const accountKeys = [buyerKey, pdaKey, systemKey, programKey];

    // Build compiled instruction
    const compiledInstruction = Buffer.concat([
      Buffer.from([3]),               // program_id_index (index 3 = programKey)
      compactU16(3),                  // account count = 3
      Buffer.from([0, 1, 2]),         // account indices: buyer, pda, system_program
      compactU16(instructionData.length),
      instructionData,
    ]);

    // Build v0 message
    // Header: [num_required_signatures=1, num_readonly_signed=0, num_readonly_unsigned=2]
    const messageHeader = Buffer.from([1, 0, 2]);

    const accountSection = Buffer.concat([
      compactU16(accountKeys.length),
      ...accountKeys,
    ]);

    const instructionsSection = Buffer.concat([
      compactU16(1), // 1 instruction
      compiledInstruction,
    ]);

    // v0 message = prefix(0) + header + accounts + blockhash + instructions + address_table_lookups(0)
    const message = Buffer.concat([
      Buffer.from([0x80]),  // v0 prefix
      messageHeader,
      accountSection,
      blockhashBytes,
      instructionsSection,
      compactU16(0),        // no address table lookups
    ]);

    // Wire-format transaction = compact_u16(1) + 64 zero bytes (placeholder sig) + message
    const transaction = Buffer.concat([
      compactU16(1),
      Buffer.alloc(64, 0), // placeholder signature — wallet replaces this
      message,
    ]);

    res.json({
      transaction: transaction.toString('base64'),
      message: `Hold locked! ${config.label} for ${quantity}x ${ticketType} — ${eventName}. Your group has ${durationStr} days to decide.`,
    });
  } catch (err: any) {
    console.error('[blink] Error building transaction:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
