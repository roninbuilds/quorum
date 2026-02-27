/**
 * sms-loop.ts
 * Polls chat.db every 3 seconds for new inbound fan messages.
 * Routes them through chat-agent.ts (LLM) and sends replies via AppleScript.
 *
 * Filters:
 *   - Ignores messages from KYD 2FA sender (22395)
 *   - Ignores outbound messages (is_from_me = 1)
 *   - Only processes messages newer than loop start time
 *
 * Usage: npx ts-node bot/sms-loop.ts
 *        npm run sms
 */

import { getRecentMessages } from './imessage-reader';
import { sendMessage } from './imessage-sender';
import { processMessage } from './chat-agent';
import { scrapeEvents, getCachedEvents } from './scraper';
import * as dotenv from 'dotenv';

dotenv.config();

const POLL_INTERVAL_MS = 3000;
const KYD_2FA_SENDER = process.env.KYD_2FA_SENDER || '22395';
const BOT_PHONE = process.env.KYD_PHONE_NUMBER || '';

// Echo guard: map of recently-sent reply text → timestamp sent (ms)
// Prevents the bot from processing its own outbound messages if they
// appear as inbound (e.g. SMS stored with is_from_me = 0 due to OS quirks)
const sentTexts = new Map<string, number>();
const SENT_TEXT_TTL_MS = 60_000;

// Per-phone cooldown: don't process more than 1 message per number per 10s
const phoneCooldowns = new Map<string, number>(); // normalizedPhone → lastProcessedMs
const COOLDOWN_MS = 10_000;

function ts(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function log(msg: string) {
  console.log(`[${ts()}] ${msg}`);
}

// Track highest seen rowid so we never process the same message twice
let lastSeenRowId = 0;

// Track start time — don't process messages that existed before loop started
const loopStartTimestamp = Math.floor(Date.now() / 1000) - 5; // 5s buffer for clock skew

/**
 * Normalize a phone number to a consistent format for deduplication.
 * chat.db may store as "+1XXXXXXXXXX" or "1XXXXXXXXXX" etc.
 */
function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '').replace(/^1(\d{10})$/, '$1');
}

/**
 * Check if an inbound number is our own phone (bot texting itself).
 * We still want to handle self-texts for testing purposes.
 */
function isSelfTest(sender: string): boolean {
  if (!BOT_PHONE) return false;
  return normalizePhone(sender) === normalizePhone(BOT_PHONE);
}

async function tick(): Promise<void> {
  try {
    const now = Date.now();

    // Prune expired sent-text entries so the map doesn't grow forever
    for (const [text, sentAt] of sentTexts) {
      if (now - sentAt > SENT_TEXT_TTL_MS) sentTexts.delete(text);
    }

    const messages = getRecentMessages(loopStartTimestamp);

    for (const msg of messages) {
      // Skip already-processed messages
      if (msg.rowid <= lastSeenRowId) continue;

      // Update high-water mark
      lastSeenRowId = Math.max(lastSeenRowId, msg.rowid);

      // Skip outbound (belt-and-suspenders — SQL already filters is_from_me = 0)
      if (msg.isFromMe) continue;

      // Skip KYD 2FA short code
      if (msg.sender === KYD_2FA_SENDER) continue;

      // Skip messages with no text
      if (!msg.text || msg.text.trim() === '') continue;

      // Echo guard: skip if this text matches something we recently sent
      if (sentTexts.has(msg.text)) {
        log(`  🔄 Echo detected — skipping "${msg.text.slice(0, 60)}..."`);
        continue;
      }

      // Per-phone cooldown: max 1 processed message per number per 10s
      const normalized = normalizePhone(msg.sender);
      const lastProcessed = phoneCooldowns.get(normalized) ?? 0;
      if (now - lastProcessed < COOLDOWN_MS) {
        log(`  ⏱ Cooldown active for ${msg.sender} (${Math.ceil((COOLDOWN_MS - (now - lastProcessed)) / 1000)}s left) — skipping`);
        continue;
      }

      // We have a new inbound fan message
      log(`[INBOUND] ${msg.sender}: ${msg.text.slice(0, 80)}${msg.text.length > 80 ? '...' : ''}`);

      // Get current events (use cache if fresh, otherwise fetch)
      let events = getCachedEvents();
      if (events.length === 0) {
        log('  Fetching fresh event list...');
        try {
          events = await scrapeEvents();
        } catch (scrapeErr: any) {
          log(`  ⚠️ Scrape failed: ${scrapeErr.message} — using empty list`);
          events = [];
        }
      }

      // Route to LLM agent
      let reply: string;
      try {
        reply = await processMessage(msg.sender, msg.text, events);
      } catch (agentErr: any) {
        log(`  ❌ Agent error: ${agentErr.message}`);
        reply = 'QUORUM 🎫 Something went wrong on our end — try again in a moment!';
      }

      log(`[OUTBOUND] ${msg.sender}: ${reply.slice(0, 80)}${reply.length > 80 ? '...' : ''}`);

      // Send reply via iMessage/SMS
      try {
        await sendMessage(msg.sender, reply);
        // Record sent text so we don't echo-process it if it surfaces as inbound
        sentTexts.set(reply, Date.now());
        // Update cooldown for this phone
        phoneCooldowns.set(normalizePhone(msg.sender), Date.now());
        log(`  ✅ Sent to ${msg.sender}`);
      } catch (sendErr: any) {
        log(`  ❌ Send failed to ${msg.sender}: ${sendErr.message}`);
      }
    }
  } catch (err: any) {
    log(`⚠️  Poll error: ${err.message}`);
  }
}

async function run(): Promise<void> {
  log('=== QUORUM SMS LOOP STARTED ===');
  log(`Polling chat.db every ${POLL_INTERVAL_MS / 1000}s for fan messages`);
  log(`Filtering: KYD 2FA (${KYD_2FA_SENDER}), outbound (is_from_me=0 in SQL)`);
  log(`Echo guard: TTL ${SENT_TEXT_TTL_MS / 1000}s | Cooldown: ${COOLDOWN_MS / 1000}s per number`);
  log(`Bot phone: ${BOT_PHONE || '(not configured)'}`);
  log('');

  // Initial scrape so first messages have event context immediately
  log('📋 Pre-fetching event list...');
  try {
    const events = await scrapeEvents();
    log(`✅ ${events.length} events loaded`);
  } catch (err: any) {
    log(`⚠️  Initial scrape failed: ${err.message}`);
  }

  log('QUORUM SMS BOT READY — waiting for inbound texts\n');

  // Poll loop
  while (true) {
    await tick();
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

// Only run when invoked directly (not when imported by server/index.ts)
if (require.main === module) {
  run().catch(err => {
    console.error('Fatal SMS loop error:', err);
    process.exit(1);
  });
}

export { run as startSMSLoop };
