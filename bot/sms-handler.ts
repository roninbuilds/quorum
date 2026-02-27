/**
 * sms-handler.ts
 * Parses inbound fan texts and routes them to hold commands.
 * No LLM needed — just vibes and regex.
 *
 * Command vocabulary:
 *   "hold 2 florist"  → hold 2 tickets to Florist
 *   "buy"             → complete the purchase
 *   "drop"            → release the hold
 *   "status"          → how long has this been running and how much have I spent
 *   "events" / "shows" → list available events
 *   anything else     → help
 */

import { sendMessage } from './imessage-sender';
import { getCachedEvents, scrapeEvents, Event } from './scraper';
import {
  getHoldByPhone,
  getHoldState,
  getAllHolds,
  sendHoldCommand,
  getHoldStatusText,
} from '../server/state';

export interface ParsedCommand {
  action: 'hold' | 'buy' | 'drop' | 'status' | 'list' | 'help';
  quantity?: number;
  eventQuery?: string;
  rawText: string;
}

/**
 * Parse a fan's text message into a command
 */
export function parseCommand(text: string): ParsedCommand {
  const lower = text.toLowerCase().trim();

  // BUY
  if (/^buy\b/.test(lower) || lower === 'buy') {
    return { action: 'buy', rawText: text };
  }

  // DROP / CANCEL / RELEASE
  if (/^(drop|cancel|release|stop|quit)\b/.test(lower)) {
    return { action: 'drop', rawText: text };
  }

  // STATUS / CHECK / HOW LONG
  if (/^(status|check|how long|update|info)\b/.test(lower)) {
    return { action: 'status', rawText: text };
  }

  // LIST EVENTS
  if (/^(events|shows|list|what's on|whats on|lineup|schedule)\b/.test(lower)) {
    return { action: 'list', rawText: text };
  }

  // HOLD [qty] [event]
  const holdMatch = lower.match(/^hold\s+(\d+)\s+(.+)/) ||
                    lower.match(/^hold\s+(.+)/);
  if (holdMatch) {
    if (holdMatch.length >= 3 && /^\d+$/.test(holdMatch[1])) {
      return {
        action: 'hold',
        quantity: parseInt(holdMatch[1]),
        eventQuery: holdMatch[2].trim(),
        rawText: text,
      };
    } else {
      return {
        action: 'hold',
        quantity: 1,
        eventQuery: holdMatch[1].trim(),
        rawText: text,
      };
    }
  }

  // HOLD [event] [qty] (alternative order)
  const holdAlt = lower.match(/^hold\s+(.+?)\s+(\d+)$/);
  if (holdAlt) {
    return {
      action: 'hold',
      quantity: parseInt(holdAlt[2]),
      eventQuery: holdAlt[1].trim(),
      rawText: text,
    };
  }

  return { action: 'help', rawText: text };
}

/**
 * Fuzzy match an event query against the event list
 * Returns the best matching event or null
 */
export function findEvent(query: string, events: Event[]): Event | null {
  if (!query || events.length === 0) return null;

  const q = query.toLowerCase();

  // Exact name match first
  const exact = events.find(e => e.name.toLowerCase() === q);
  if (exact) return exact;

  // Contains match
  const contains = events.find(e =>
    e.name.toLowerCase().includes(q) ||
    q.includes(e.name.toLowerCase().split(' ')[0])
  );
  if (contains) return contains;

  // Word overlap scoring
  const queryWords = q.split(/\s+/).filter(w => w.length > 2);
  let bestScore = 0;
  let bestEvent: Event | null = null;

  for (const event of events) {
    const eventWords = event.name.toLowerCase().split(/\s+/);
    const overlap = queryWords.filter(w => eventWords.some(ew => ew.includes(w) || w.includes(ew)));
    if (overlap.length > bestScore) {
      bestScore = overlap.length;
      bestEvent = event;
    }
  }

  return bestScore > 0 ? bestEvent : null;
}

/**
 * Handle an inbound SMS from a fan.
 * Returns the response message to send back.
 */
export async function handleInboundSMS(
  phoneNumber: string,
  messageText: string,
  startHoldCallback: (phoneNumber: string, event: Event, quantity: number) => Promise<string>
): Promise<string> {

  const command = parseCommand(messageText);
  console.log(`📩 SMS from ${phoneNumber}: "${messageText}" → ${command.action}`);

  switch (command.action) {

    case 'list': {
      const events = getCachedEvents().length > 0
        ? getCachedEvents()
        : await scrapeEvents().catch(() => getCachedEvents());

      if (events.length === 0) {
        return 'QUORUM 🎫 No events available right now. Try again in a few minutes.';
      }

      const lines = ['QUORUM 🎫 LPR Events:'];
      events.slice(0, 5).forEach((e, i) => {
        const statusBadge = e.status === 'sold_out' ? '❌ SOLD OUT' :
                           e.status === 'low' ? '⚠️ LOW TIX' : '✅';
        lines.push(`${i + 1}. ${e.name} ${e.date} ${e.time} ${e.price || ''} ${statusBadge}`);
      });
      lines.push('\nReply: HOLD [qty] [event name]');
      return lines.join('\n');
    }

    case 'hold': {
      // Check if they already have an active hold
      const existing = getHoldByPhone(phoneNumber);
      if (existing && (existing.status === 'active' || existing.status === 'pending')) {
        return `QUORUM 🎫 You already have an active hold for ${existing.eventName}.\n` +
               `Reply STATUS to check, BUY to purchase, or DROP to cancel.`;
      }

      const events = getCachedEvents().length > 0
        ? getCachedEvents()
        : await scrapeEvents().catch(() => getCachedEvents());

      const matchedEvent = command.eventQuery
        ? findEvent(command.eventQuery, events)
        : events[0];

      if (!matchedEvent) {
        const eventNames = events.slice(0, 3).map(e => e.name).join(', ');
        return `QUORUM 🎫 Event not found.\nAvailable: ${eventNames}\nReply: HOLD [qty] [event name]`;
      }

      if (matchedEvent.status === 'sold_out') {
        return `QUORUM 🎫 ${matchedEvent.name} is sold out.\n` +
               `But we can hold an OPTION on it — future admission if tickets drop!\n` +
               `Reply HOLD ${command.quantity || 1} ${matchedEvent.name} to create an options contract.`;
      }

      const qty = command.quantity || 1;

      // Estimate premium (for the Solana options contract)
      const premiumSOL = qty * (matchedEvent.status === 'low' ? 3 : 1.5);

      const response = `QUORUM 🎫 Locking in ${qty}x ${matchedEvent.name} ${matchedEvent.date}.\n` +
                       `Hold fee: $${(qty * 0.10).toFixed(2)}/cycle (~$1.20/hr)\n` +
                       `Lock price with ${premiumSOL} SOL option → [sol:${process.env.SOLANA_RPC_URL?.includes('devnet') ? 'devnet' : 'mainnet'}]\n` +
                       `Reply BUY to purchase or DROP to cancel.`;

      // Start the hold asynchronously
      startHoldCallback(phoneNumber, matchedEvent, qty).catch(err => {
        console.error(`Hold start failed for ${phoneNumber}:`, err.message);
        sendMessage(phoneNumber, `QUORUM 🎫 Hold failed to start: ${err.message}`);
      });

      return response;
    }

    case 'buy': {
      const hold = getHoldByPhone(phoneNumber);
      if (!hold) {
        return 'QUORUM 🎫 No active hold. Reply EVENTS to see shows, or HOLD [qty] [event] to start.';
      }
      sendHoldCommand(hold.holdId, 'buy');
      return `QUORUM 🎫 Processing purchase for ${hold.quantity}x ${hold.eventName}!\n` +
             `Reply with your name: "NAME [Your Full Name]"`;
    }

    case 'drop': {
      const hold = getHoldByPhone(phoneNumber);
      if (!hold) {
        return 'QUORUM 🎫 No active hold to drop.';
      }
      sendHoldCommand(hold.holdId, 'drop');
      const feeDollars = (hold.totalFeeCents / 100).toFixed(2);
      return `QUORUM 🎫 Releasing hold for ${hold.eventName}.\n` +
             `Held for ${Math.floor((Date.now() - hold.startTime) / 60000)} min. ` +
             `Total hold fees: $${feeDollars}.\n` +
             `Your group chat really owes you one.`;
    }

    case 'status': {
      const hold = getHoldByPhone(phoneNumber);
      if (!hold) {
        return 'QUORUM 🎫 No active hold. Reply EVENTS to see shows.';
      }
      return getHoldStatusText(hold.holdId);
    }

    case 'help':
    default: {
      return 'QUORUM 🎫 Ticket options for slow group chats.\n\n' +
             'Commands:\n' +
             'EVENTS — see upcoming shows\n' +
             'HOLD [qty] [event] — start holding tickets\n' +
             'STATUS — check your hold\n' +
             'BUY — purchase the tickets\n' +
             'DROP — release the hold\n\n' +
             'Powered by Solana ⚡';
    }
  }
}
