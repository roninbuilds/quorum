/**
 * imessage-reader.ts
 * Reads 2FA codes and fan messages from macOS Messages database (chat.db)
 * Uses better-sqlite3 (synchronous) — no callback hell, just vibes
 *
 * IMPORTANT: Requires Full Disk Access for the Terminal/Node process.
 * System Settings > Privacy & Security > Full Disk Access > add Terminal
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as os from 'os';
import * as dotenv from 'dotenv';

dotenv.config();

// chat.db dates are nanoseconds since 2001-01-01 00:00:00 UTC
// macOS epoch offset: 978307200 seconds from Unix epoch
const MACOS_EPOCH_OFFSET = 978307200;

const DB_PATH = (process.env.IMESSAGE_DB_PATH || '~/Library/Messages/chat.db')
  .replace('~', os.homedir());

const KYD_2FA_SENDER = process.env.KYD_2FA_SENDER || '22395';

export interface Message {
  rowid: number;
  text: string;
  sender: string; // phone number or short code
  timestamp: number; // unix timestamp in seconds
  isFromMe: boolean;
}

function openDB(): Database.Database {
  try {
    // Read-only — we're observers, not participants (in the DB at least)
    const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    return db;
  } catch (err: any) {
    if (err.message?.includes('EACCES') || err.message?.includes('permission')) {
      console.error('❌ FULL DISK ACCESS NEEDED — enable in System Settings > Privacy & Security > Full Disk Access for Terminal');
    }
    throw err;
  }
}

function chatDbDateToUnix(chatDbDate: number): number {
  // chatDbDate is in nanoseconds
  return Math.floor(chatDbDate / 1_000_000_000) + MACOS_EPOCH_OFFSET;
}

/**
 * Get the handle_id for a given phone/short code
 */
function getHandleId(db: Database.Database, sender: string): number | null {
  const row = db.prepare(`SELECT ROWID FROM handle WHERE id = ?`).get(sender) as { ROWID: number } | undefined;
  return row ? row.ROWID : null;
}

/**
 * Get the most recent message from a specific sender
 */
function getLatestMessageFromSender(db: Database.Database, handleId: number): { text: string; date: number } | null {
  const row = db.prepare(`
    SELECT text, date FROM message
    WHERE handle_id = ?
    AND is_from_me = 0
    ORDER BY date DESC
    LIMIT 1
  `).get(handleId) as { text: string; date: number } | undefined;
  return row || null;
}

/**
 * Parse OTP from KYD verification message
 * Format: "Your kyd labs verification code is: XXXX"
 */
function parseOTP(text: string): string | null {
  // Try multiple patterns because KYD might change their copy
  const patterns = [
    /verification code is:?\s*(\d{4})/i,
    /code[:\s]+(\d{4})/i,
    /\b(\d{4})\b/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return null;
}

/**
 * Poll for a new OTP from KYD 2FA sender.
 * Returns the 4-digit code once a new one arrives.
 * Polls every 2 seconds, up to timeoutMs.
 */
export async function getLatestOTP(
  afterTimestamp?: number,
  timeoutMs = 120_000
): Promise<string> {
  const db = openDB();
  const handleId = getHandleId(db, KYD_2FA_SENDER);

  if (!handleId) {
    // Handle might not exist yet if no messages from this sender
    console.log(`⏳ No handle found for ${KYD_2FA_SENDER} yet — will keep polling...`);
  }

  const startTime = Date.now();
  const baselineTimestamp = afterTimestamp || Math.floor(Date.now() / 1000) - 5;

  console.log(`⏳ Waiting for OTP from ${KYD_2FA_SENDER}...`);

  while (Date.now() - startTime < timeoutMs) {
    try {
      // Re-query handle each iteration in case it just appeared
      const hid = handleId || getHandleId(db, KYD_2FA_SENDER);
      if (hid) {
        const msg = getLatestMessageFromSender(db, hid);
        if (msg) {
          const msgUnixTime = chatDbDateToUnix(msg.date);
          if (msgUnixTime > baselineTimestamp) {
            const otp = parseOTP(msg.text);
            if (otp) {
              if (process.env.NODE_ENV !== 'production') {
                console.log(`✅ Got OTP: ${otp} (from message at ${new Date(msgUnixTime * 1000).toISOString()})`);
              } else {
                console.log(`✅ OTP received`);
              }
              db.close();
              return otp;
            }
          }
        }
      }
    } catch (err: any) {
      if (err.message?.includes('EACCES') || err.message?.includes('permission')) {
        console.error('❌ FULL DISK ACCESS NEEDED — enable in System Settings > Privacy & Security > Full Disk Access for Terminal');
        db.close();
        throw err;
      }
    }

    // Poll every 2 seconds
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  db.close();
  throw new Error(`Timeout waiting for OTP after ${timeoutMs}ms`);
}

/**
 * Get all recent messages since a given Unix timestamp.
 * Used for fan command polling.
 */
export function getRecentMessages(sinceTimestamp: number): Message[] {
  const db = openDB();

  // Convert unix timestamp to chat.db nanoseconds
  const chatDbSince = (sinceTimestamp - MACOS_EPOCH_OFFSET) * 1_000_000_000;

  const rows = db.prepare(`
    SELECT
      m.ROWID as rowid,
      m.text,
      h.id as sender,
      m.date,
      m.is_from_me as isFromMe
    FROM message m
    LEFT JOIN handle h ON m.handle_id = h.ROWID
    WHERE m.date > ?
    AND m.is_from_me = 0
    AND m.text IS NOT NULL
    AND m.text != ''
    ORDER BY m.date ASC
  `).all(chatDbSince) as Array<{ rowid: number; text: string; sender: string; date: number; isFromMe: number }>;

  db.close();

  return rows.map(row => ({
    rowid: row.rowid,
    text: row.text,
    sender: row.sender || 'unknown',
    timestamp: chatDbDateToUnix(row.date),
    isFromMe: row.isFromMe === 1,
  }));
}

/**
 * Get all messages from a specific phone number since a timestamp
 */
export function getMessagesFromNumber(phoneNumber: string, sinceTimestamp: number): Message[] {
  return getRecentMessages(sinceTimestamp).filter(
    m => m.sender === phoneNumber && !m.isFromMe
  );
}

// Quick test: run this file directly to check chat.db access
if (require.main === module) {
  console.log('Testing iMessage reader...');
  try {
    const db = openDB();
    console.log('✅ chat.db opened successfully');

    const count = (db.prepare('SELECT COUNT(*) as count FROM message').get() as { count: number }).count;
    console.log(`📱 Total messages in DB: ${count}`);

    const recentTime = Math.floor(Date.now() / 1000) - 3600; // last hour
    const recent = getRecentMessages(recentTime);
    console.log(`📩 Messages in last hour: ${recent.length}`);
    if (recent.length > 0) {
      console.log('Last message:', {
        sender: recent[recent.length - 1].sender,
        timestamp: new Date(recent[recent.length - 1].timestamp * 1000).toISOString(),
        preview: recent[recent.length - 1].text.slice(0, 50),
      });
    }

    db.close();
    console.log('✅ iMessage reader test complete');
  } catch (err: any) {
    console.error('❌ iMessage reader test failed:', err.message);
  }
}
