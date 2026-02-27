/**
 * state.ts
 * In-memory state for active holds.
 * No database needed — if the server restarts, fans re-text the bot.
 * (Persistence is overrated when you're exploiting checkout timeouts.)
 *
 * Fan personal data is NEVER persisted to disk — in-memory only.
 */

export interface HoldState {
  holdId: string;
  eventUrl: string;
  eventName: string;
  ticketType: string;
  quantity: number;
  status: 'active' | 'dropped' | 'buying' | 'bought' | 'error' | 'pending';
  cycleCount: number;
  startTime: number; // unix ms
  lastCycleTime: number; // unix ms
  totalFeeCents: number;
  command: 'buy' | 'drop' | null;
  fanPhone?: string; // phone number of fan who requested this hold (NOT persisted to disk)
  fanName?: string;  // collected at buy time (NOT persisted to disk)
  fanEmail?: string; // collected at buy time (NOT persisted to disk)
  solanaOptionId?: string; // on-chain option contract ID
}

// The in-memory holds map — lives and dies with the process
const holds = new Map<string, HoldState>();

export function createHoldState(config: {
  holdId: string;
  eventUrl: string;
  eventName: string;
  ticketType: string;
  quantity: number;
  fanPhone?: string;
}): HoldState {
  const state: HoldState = {
    holdId: config.holdId,
    eventUrl: config.eventUrl,
    eventName: config.eventName,
    ticketType: config.ticketType,
    quantity: config.quantity,
    status: 'pending',
    cycleCount: 0,
    startTime: Date.now(),
    lastCycleTime: Date.now(),
    totalFeeCents: 0,
    command: null,
    fanPhone: config.fanPhone,
  };
  holds.set(config.holdId, state);
  return state;
}

export function updateHoldState(holdId: string, updates: Partial<HoldState>): HoldState | null {
  const state = holds.get(holdId);
  if (!state) return null;

  Object.assign(state, updates);
  return state;
}

export function getHoldState(holdId: string): HoldState | null {
  return holds.get(holdId) || null;
}

export function getAllHolds(): HoldState[] {
  return Array.from(holds.values());
}

export function getActiveHolds(): HoldState[] {
  return getAllHolds().filter(h => h.status === 'active' || h.status === 'buying');
}

export function getHoldByPhone(phoneNumber: string): HoldState | null {
  return getAllHolds().find(h => h.fanPhone === phoneNumber) || null;
}

export function sendHoldCommand(holdId: string, command: 'buy' | 'drop'): boolean {
  const state = holds.get(holdId);
  if (!state) return false;
  state.command = command;
  return true;
}

export function generateHoldId(): string {
  return `hold-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Get a formatted status message for a hold — used in SMS replies
 */
export function getHoldStatusText(holdId: string): string {
  const state = getHoldState(holdId);
  if (!state) return 'QUORUM: No active hold found.';

  const elapsedMs = Date.now() - state.startTime;
  const elapsedMin = Math.floor(elapsedMs / 60000);
  const feeDollars = (state.totalFeeCents / 100).toFixed(2);

  switch (state.status) {
    case 'active':
      return `QUORUM 🎫 Hold active: ${state.quantity}x ${state.eventName}\n` +
             `${elapsedMin} min elapsed. Cycles: ${state.cycleCount}. Fees: $${feeDollars}\n` +
             `Reply BUY or DROP`;
    case 'buying':
      return `QUORUM 🎫 Processing purchase for ${state.quantity}x ${state.eventName}...`;
    case 'bought':
      return `QUORUM 🎫 Tickets secured! ${state.quantity}x ${state.eventName}\n` +
             `Total hold cost: $${feeDollars} over ${state.cycleCount} cycles.\n` +
             `Your group chat owes you.`;
    case 'dropped':
      return `QUORUM 🎫 Hold released for ${state.eventName}.\n` +
             `Held for ${elapsedMin} min ($${feeDollars}). No tickets purchased.`;
    case 'error':
      return `QUORUM 🎫 Hold error for ${state.eventName}. Text HOLD to try again.`;
    default:
      return `QUORUM 🎫 Hold status: ${state.status}`;
  }
}
