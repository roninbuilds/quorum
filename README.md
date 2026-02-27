# QUORUM
### Lock in ticket prices while your group chat makes up its mind

> Built for the Solana Graveyard Hackathon × KYD Labs $5K Ticketing Bounty

---

## Act 1: The Vision

Ticket options are a new financial primitive for live events.

Right now, every group attending a show goes through the same painful loop: "Are we doing this?" "I don't know, let me check." "It sold out while you were checking." The coordination problem is real, and it costs venues revenue and fans experiences.

**Quorum fixes this with a call options market on tickets.**

- **Fans** pay a small SOL premium to lock in their right to buy tickets at face value for up to 30 days. No more FOMO, no more group chat paralysis.
- **Venues** earn royalties on option premiums — and more importantly, they get demand intelligence they currently leave on the table. When fans pay 8 SOL to lock in a sold-out show, that's a signal. Add a late show. Book a bigger venue next time.
- **Options premiums reveal real demand intensity** — something a flat-price waitlist can *never* capture. Your waitlist tells you *how many* people want tickets. The options market tells you *how badly*.

---

## Act 2: The Hack

KYD Labs has no API. Tickets aren't programmatically transferable. Everything is manual.

So we built a bot.

```
KYD checkout has a ~4:55 hold timer
                    ↓
Bot clicks "Get N Tickets"
                    ↓
Timer starts. Tickets held.
                    ↓
Bot waits 4:55 for "Continue Shopping"
                    ↓
Bot clicks it. Resets. Repeat.
                    ↓
Tickets held indefinitely. For pennies.
```

The bot:
1. **Reads 2FA codes from iMessage** via macOS `chat.db` SQLite — no manual copy-paste
2. **Logs into KYD via Playwright** — full browser rendering, handles React SPAs
3. **Cycles the checkout timer in a loop** — click Add → Get N Tickets → wait → Continue Shopping → repeat
4. **Accepts fan commands via SMS** — text "HOLD 2 Florist" and the bot starts holding
5. **Creates Solana option contracts** — fans pay SOL premium, get on-chain proof of their option

Fans text a phone number. The bot holds their tickets and charges them `$0.10/cycle`. The options market generates demand intelligence for venues.

Yes, this is absurd. That's the point.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      Fan's Phone                         │
│  "HOLD 2 Florist" → SMS → iMessage on Mac Mini          │
└───────────────────────┬─────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────┐
│                   bot/imessage-reader.ts                 │
│   Polls ~/Library/Messages/chat.db every 5 seconds      │
│   Parses commands: hold/buy/drop/status/events           │
└───────────┬─────────────────────────────────────────────┘
            │                          │
            ▼                          ▼
┌───────────────────┐    ┌────────────────────────────────┐
│  bot/holder.ts    │    │      server/solana.ts           │
│  Playwright loop  │    │  Creates on-chain OptionContract│
│  Cycles KYD       │    │  PDA on Solana devnet          │
│  checkout timer   │    │  programs/quorum/src/lib.rs    │
└───────┬───────────┘    └────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────┐
│                  server/index.ts (Express)               │
│                                                         │
│  GET  /api/events       → scraped LPR event listings    │
│  POST /api/hold         → start hold cycle              │
│  GET  /api/options      → on-chain option contracts     │
│  GET  /api/venue-intel  → demand intelligence           │
└───────────────────────┬─────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────┐
│                    web/index.html                        │
│  Events grid · Active holds with live timer             │
│  Option contracts from chain · Buy/Drop buttons         │
│                                                         │
│                 web/venue-intel.html                    │
│  Demand signals · Revenue intelligence · Insights       │
└─────────────────────────────────────────────────────────┘
```

---

## Tech Stack

| Layer | Tech |
|-------|------|
| On-chain program | Anchor 0.30.1 on Solana devnet |
| Client-side Solana | @solana/kit (new school, not legacy web3.js) |
| Bot/automation | Playwright (Chromium) |
| iMessage integration | better-sqlite3 → macOS chat.db |
| SMS commands | osascript AppleScript |
| API server | Express.js + TypeScript |
| Frontend | Vanilla JS, single HTML files, dark theme |
| Runtime | Node.js + ts-node |

---

## Running Locally

### Prerequisites
- macOS with iMessage set up (for 2FA + fan commands)
- Full Disk Access for Terminal: System Settings → Privacy & Security → Full Disk Access
- Solana CLI + Anchor 0.30.1
- Node.js 18+

### Setup

```bash
# Clone and install
git clone https://github.com/roninbuilds/quorum
cd quorum
npm install

# Install Playwright browsers
npx playwright install chromium

# Configure environment
cp .env.example .env  # or edit .env directly

# Set up Solana wallet (requires keypair)
mkdir -p ~/.config/solana
# copy your devnet keypair to ~/.config/solana/id.json

# Verify balance (need ~2+ devnet SOL)
solana balance --url devnet
```

### Start the server

```bash
npm run dev
# → http://localhost:3000
# → http://localhost:3000/venue-intel
```

### Test iMessage integration

```bash
npm run test:imessage
# Should show recent messages from chat.db
# If fails: enable Full Disk Access for Terminal
```

### Test KYD scraper

```bash
npm run test:scraper
# Scrapes real LPR events from kydlabs.com
```

### Deploy Anchor program (optional for full demo)

```bash
# Install Anchor CLI
cargo install --git https://github.com/coral-xyz/anchor --tag v0.30.1 anchor-cli --locked

# Build and deploy
anchor build
anchor deploy --provider.cluster devnet

# Update .env with deployed program ID
echo "QUORUM_PROGRAM_ID=<your_program_id>" >> .env

# Seed demo data
ts-node server/seed-options.ts
```

---

## SMS Command Reference

Text the bot's phone number:

```
EVENTS                  → List upcoming LPR shows
HOLD 2 Florist          → Hold 2 tickets to Florist
STATUS                  → Check current hold status
BUY                     → Purchase the held tickets
DROP                    → Release the hold
```

---

## Security

- Phone numbers and API keys in `.env` only — never in source
- Fan personal data (name, email) held in memory only — never persisted to disk
- OTP codes not logged in production (`NODE_ENV=production`)
- Run `npm run security-audit` before every commit

---

## Act 3: The Ask

Dear KYD Labs:

**Please build an API.**

With proper programmatic access to Tix, Quorum becomes a real options protocol:

- Fans get proper financial instruments — on-chain call options with price protection
- Venues set royalty rates on option premiums and earn from demand they currently give away to StubHub
- The options market generates demand intelligence that transforms how you book, price, and expand shows
- Every option contract on-chain is a data point: this event has 12 active options averaging 6 SOL premium. That means something.

We built the janky version — a bot exploiting your checkout timeout to hold tickets in a loop. It works, it's hilarious, and it proves the concept.

Now build the real one. The options market for live events is waiting.

---

**Deployed Program:** [`FJiPMReDe4hdixbgqNQ7MZUHTszYXdXG8FPXKxoKe9vQ`](https://explorer.solana.com/address/FJiPMReDe4hdixbgqNQ7MZUHTszYXdXG8FPXKxoKe9vQ?cluster=devnet)

*Built with 🫠 and checkout timeouts*
*Solana Graveyard Hackathon × KYD Labs $5K Ticketing Bounty*
