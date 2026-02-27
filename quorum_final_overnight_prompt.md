# QUORUM — Overnight Build Prompt
# "Lock in ticket prices while your group chat makes up its mind"
# Solana Graveyard Hackathon — KYD Labs $5K Ticketing Bounty
# DEADLINE: ~13 hours from now. This must be mostly done by morning.

## WHAT YOU ARE BUILDING

Quorum is a ticket options protocol that exploits KYD Labs' 5-minute checkout timeout to hold tickets indefinitely for fans while their group chat decides. Fans pay a premium (in devnet SOL) to lock in a call option on tickets at face value. The options market generates demand intelligence for venues — premium prices reveal how badly fans want tickets, something a flat-price waitlist can never capture.

The KYD Labs founder has explicitly approved this approach and loves it.

## SECURITY — DO THIS FIRST BEFORE ANYTHING ELSE

### Step 1: Create .gitignore IMMEDIATELY
```
.env
node_modules/
target/
*-keypair.json
dist/
playwright/.auth/
.playwright/
*.log
.DS_Store
```

### Step 2: Create .env file
```
KYD_PHONE_NUMBER=+1 (408) 219-1575
IMESSAGE_DB_PATH=~/Library/Messages/chat.db
KYD_2FA_SENDER=22395
HOLD_RATE_CENTS=10
PORT=3000
SOLANA_RPC_URL=https://api.devnet.solana.com
NODE_ENV=development
```

### Security Rules (follow throughout entire build):
- NEVER hardcode any credentials, phone numbers, or keys in source files
- ALL sensitive values must come from .env
- NEVER log OTP codes in production mode (check NODE_ENV)
- NEVER commit .env or any keypair files
- Before ANY git operation, run: `git diff --cached --name-only` and verify no sensitive files
- Playwright session cookies/storage must be in a gitignored directory
- Fan personal data (name, email, phone) must never be persisted to disk — in-memory only
- Solana wallet keypair must be in default location (~/.config/solana/id.json), never in repo

### Pre-commit audit checklist (run before every git commit):
```bash
# Check for leaked secrets
grep -r "408.*219.*1575" --include="*.ts" --include="*.js" --include="*.html" .
grep -r "keypair" --include="*.ts" --include="*.js" . | grep -v node_modules | grep -v .gitignore
grep -r "private" --include="*.json" . | grep -v node_modules | grep -v package
# Verify .gitignore exists and covers sensitive paths
cat .gitignore
# Check staged files
git diff --cached --name-only
```

## PROJECT STRUCTURE

Build in ~/quorum/ (repo already exists with package.json and playwright installed).

```
quorum/
├── programs/
│   └── quorum/
│       └── src/
│           └── lib.rs              # Anchor escrow/options program
├── bot/
│   ├── kyd-auth.ts                 # KYD login + auto 2FA from iMessage
│   ├── imessage-reader.ts          # Reads SMS from macOS chat.db
│   ├── imessage-sender.ts          # Sends SMS via AppleScript
│   ├── scraper.ts                  # Scrapes LPR event listings
│   ├── holder.ts                   # The hold cycling loop
│   ├── sms-handler.ts              # Parses inbound texts, routes commands
│   └── browser-manager.ts          # Playwright browser lifecycle
├── server/
│   ├── index.ts                    # Express API server
│   ├── routes.ts                   # API endpoints
│   ├── state.ts                    # In-memory state for active holds
│   └── solana.ts                   # On-chain interaction helpers
├── web/
│   ├── index.html                  # Main dashboard (single page app)
│   └── venue-intel.html            # Venue intelligence panel
├── tests/
│   └── security-audit.sh           # Pre-commit security checks
├── Anchor.toml
├── Cargo.toml
├── package.json
├── tsconfig.json
├── .env
├── .gitignore
└── README.md
```

## COMPONENT 1: iMessage Integration (bot/imessage-reader.ts + bot/imessage-sender.ts)

### Reader — Reads 2FA codes and fan messages from macOS Messages

The Mac Mini has iMessage forwarding set up. All texts appear in ~/Library/Messages/chat.db (SQLite).

```typescript
// imessage-reader.ts
// Opens chat.db READ-ONLY
// KYD 2FA comes from sender "22395"
// Message format: "Your kyd labs verification code is: XXXX"

// To find handle: SELECT ROWID FROM handle WHERE id = '22395'
// To get latest message: SELECT text, date FROM message WHERE handle_id = ? ORDER BY date DESC LIMIT 1

// For fan messages: query all recent messages, filter by known fan numbers
// Use better-sqlite3 package (synchronous, simpler): npm install better-sqlite3

// Functions needed:
// getLatestOTP(): Promise<string> — polls every 2s until new OTP arrives, returns 4-digit code
// getRecentMessages(sinceTimestamp): Message[] — returns all messages since timestamp
// The date field in chat.db is nanoseconds since 2001-01-01. Convert accordingly.
```

IMPORTANT: macOS chat.db date format is nanoseconds since 2001-01-01 00:00:00 UTC. To convert:
```
unix_timestamp = (chat_db_date / 1000000000) + 978307200
```

IMPORTANT: The process needs Full Disk Access to read chat.db. If it fails, log a clear error message about enabling Full Disk Access in System Settings > Privacy & Security.

### Sender — Sends messages via AppleScript

```typescript
// imessage-sender.ts
// Uses osascript to send iMessages/SMS

// Function: sendMessage(phoneNumber: string, message: string): Promise<void>
// Implementation:
// exec(`osascript -e 'tell application "Messages" to send "${escapedMessage}" to buddy "${phoneNumber}" of service "SMS"'`)

// IMPORTANT: Escape single quotes and special characters in the message
// IMPORTANT: "service" might need to be "iMessage" instead of "SMS" depending on setup — try both
```

### SMS Handler — Parses fan texts, routes commands

```typescript
// sms-handler.ts
// No LLM needed. Pure keyword matching.

// Inbound message parsing:
// "hold 2 florist" → { action: 'hold', quantity: 2, eventQuery: 'florist' }
// "buy" → { action: 'buy' }
// "drop" → { action: 'drop' }
// "status" → { action: 'status' }
// "events" or "shows" → { action: 'list' }
// anything else → { action: 'help' }

// Use simple regex/includes matching. Fuzzy match event names against scraped events.
// Respond with structured text messages (not conversational).

// Example responses:
// "QUORUM 🎫 LPR Events:\n1. Florist Sat 6:30PM $25 (LOW TIX)\n2. Emo Night Fri 11PM $30\nReply: HOLD [qty] [#]"
// "QUORUM 🎫 Holding 2x Florist. Pay 5 SOL to lock in: [blink URL]\nOption expires in 3 days."
// "QUORUM 🎫 Hold active. 35min elapsed. Cycles: 7. Fees: $0.70\nReply BUY or DROP"
```

## COMPONENT 2: Playwright Engine (bot/kyd-auth.ts, bot/scraper.ts, bot/holder.ts)

### KYD Auth — Login with auto 2FA

```typescript
// kyd-auth.ts
// 1. Navigate to event page
// 2. Click 'Sign In'
// 3. Fill phone number from env
// 4. Click 'Next'
// 5. Call imessageReader.getLatestOTP() — this polls chat.db until code arrives
// 6. Fill OTP into 4 separate character fields
// 7. Wait for login confirmation (Sign In button disappears or user menu appears)
```

### Scraper — Real LPR events

```typescript
// scraper.ts
// Navigate to https://kydlabs.com/p/lpr/bio
// Wait for React app to render
// Extract all event cards:
//   - name (from link text or heading)
//   - date/time
//   - image URL
//   - event page URL (href)
//   - availability: look for "Sold Out", "Low Tickets" text, or assume available
//   - price: extract from event detail page if possible, or set as null

// Return as structured array:
// { name, date, time, imageUrl, eventUrl, status: 'available'|'low'|'sold_out', price? }
```

### Holder — The hold cycling loop

THIS IS THE CORE PRODUCT. Get this right.

```typescript
// holder.ts
// The hold cycle:
// 1. Navigate to event page URL
// 2. Click Add button N times for desired quantity
//    - Add button is inside table rows: getByRole('row', { name: /ticket_type/ }).getByLabel('Add')
//    - Or simpler: getByRole('button', { name: 'Add' }) and click N times
// 3. Click "Get N Tickets" button: getByRole('button', { name: /Get \d+ Tickets/ })
//    - This starts the ~4:55 countdown
// 4. Wait for "Continue Shopping" button to appear (timeout 310000ms = 5min 10sec)
//    - getByRole('button', { name: 'Continue Shopping' })
// 5. Click "Continue Shopping"
// 6. Back on event page — go to step 2
// 7. Increment cycle counter, update state

// IMPORTANT: Events open in POPUPS. Use page.waitForEvent('popup') to get the new page.
// IMPORTANT: After login, subsequent event pages should stay authenticated.
// IMPORTANT: Each KYD account can only hold tickets for ONE event at a time.
// IMPORTANT: Be resilient — if any step fails, log error and retry.
// IMPORTANT: Use headless: false during development so we can see what's happening.

// The cycle runs continuously until:
// - Fan sends BUY → complete the purchase (enter name, email, pay)
// - Fan sends DROP → let current hold expire, don't restart
// - System error → log and attempt recovery

// On BUY: need to complete checkout with actual payment. For hackathon,
// we just demonstrate the flow up to the payment step.
```

### PLAYWRIGHT SELECTORS FROM REAL RECORDINGS:

```javascript
// Navigate to events
await page.goto('https://kydlabs.com/p/lpr/bio');
await page.getByRole('button', { name: 'See All Upcoming Events' }).click();

// Click event (OPENS POPUP)
const pagePromise = page.waitForEvent('popup');
await page.getByRole('link', { name: 'EVENT_NAME_HERE' }).click();
const eventPage = await pagePromise;

// Login
await eventPage.getByText('Sign In').click();
await eventPage.getByRole('textbox', { name: 'Mobile number' }).fill(PHONE_FROM_ENV);
await eventPage.getByRole('button', { name: 'Next' }).click();

// OTP — 4 separate single-char fields
await eventPage.getByRole('textbox', { name: 'Please enter OTP character 1' }).fill(code[0]);
await eventPage.getByRole('textbox', { name: 'Please enter OTP character 2' }).fill(code[1]);
await eventPage.getByRole('textbox', { name: 'Please enter OTP character 3' }).fill(code[2]);
await eventPage.getByRole('textbox', { name: 'Please enter OTP character 4' }).fill(code[3]);

// Add tickets
await eventPage.getByRole('row', { name: /TICKET_TYPE/ }).getByLabel('Add').click();
// OR simpler for re-adds:
await eventPage.getByRole('button', { name: 'Add' }).click();

// Checkout
await eventPage.getByRole('button', { name: /Get \d+ Tickets/ }).click();

// Wait for hold to expire
await eventPage.getByRole('button', { name: 'Continue Shopping' }).click({ timeout: 310000 });

// Re-add (same page, no navigation needed)
await eventPage.getByRole('button', { name: 'Add' }).click();
await eventPage.getByRole('button', { name: /Get \d+ Tickets/ }).click();
```

## COMPONENT 3: Solana Options Program (programs/quorum/src/lib.rs)

Simple Anchor program on devnet. Three instructions, one PDA type.

```rust
// OptionContract account (PDA seeded by option_id)
pub struct OptionContract {
    pub option_id: String,          // unique ID
    pub event_name: String,         // "Florist"
    pub event_date: String,         // "2026-02-28"
    pub ticket_type: String,        // "GA Early Bird"
    pub quantity: u8,               // number of tickets
    pub premium_lamports: u64,      // premium paid in lamports
    pub holder: Pubkey,             // fan's wallet
    pub expiry: i64,                // unix timestamp
    pub status: u8,                 // 0=Active, 1=Exercised, 2=Expired
    pub created_at: i64,            // unix timestamp
    pub venue_royalty_bps: u16,     // basis points for venue (e.g., 1000 = 10%)
    pub bump: u8,
}

// Instructions:
// 1. create_option — fan pays premium SOL, creates OptionContract PDA
// 2. exercise_option — fan exercises, status → Exercised  
// 3. expire_option — anyone can call after expiry, status → Expired

// Keep it simple. No complex escrow needed for hackathon.
// The premium transfer happens in create_option via system_program::transfer.
// Venue royalty is just a field — actual split can be demonstrated but doesn't need to be enforced.
```

### Anchor Setup:
- Use Anchor 0.30.1 (most stable for current Solana)
- Deploy to devnet
- Program name: "quorum"
- If Anchor dependency issues arise, try different versions. The program compiling and deploying matters more than the version.

### Seed Data:
After deploying, create 3-4 sample option contracts on devnet using different events and premiums:
- Florist: 2 tickets, premium 3 SOL, expires in 3 days, status Active
- Gimme Gimme Disco: 4 tickets, premium 8 SOL (sold out show = higher), status Active  
- Emo Night: 1 ticket, premium 2 SOL, status Exercised
- Matinee Social Club: 2 tickets, premium 5 SOL, status Expired

This seed data powers the Venue Intelligence dashboard.

## COMPONENT 4: Express API Server (server/)

```typescript
// Endpoints:
GET  /api/events              // scraped LPR event listings
GET  /api/events/:id          // single event details
POST /api/hold                // { eventUrl, quantity, ticketType } → start hold
GET  /api/hold/:id/status     // current hold state
POST /api/hold/:id/buy        // { name, email } → complete purchase
POST /api/hold/:id/drop       // release hold
GET  /api/holds               // all active holds
GET  /api/options             // on-chain option contracts (read from Solana)
GET  /api/venue-intel         // aggregated demand intelligence
POST /api/sms/incoming        // webhook for iMessage handler (internal)
```

## COMPONENT 5: Web Frontend (web/)

### Main Dashboard (web/index.html)
Single HTML file. Vanilla JS. No frameworks. Dark theme.

**Header:**
- "QUORUM" logo/text
- Tagline: "Lock in ticket prices while your group chat makes up its mind"
- Subtle: "Built for Solana Graveyard Hackathon × KYD Labs"

**Events Section:**
- Cards showing real LPR events scraped from kydlabs.com
- Each card: event image, name, date/time, price, availability badge
- "HOLD" button on each card → opens a modal:
  - Select ticket type
  - Select quantity (1-10)
  - Select hold duration: "3 days — 5 SOL" (active), "7 days — 10 SOL" (active), "30 days — 25 SOL" (greyed out, "coming soon")
  - "Lock It In" button → generates Blink URL / shows Solana pay prompt
  - For demo: just simulates the payment and starts the hold

**Active Holds Section:**
- Shows running holds with:
  - Event name + ticket details
  - Animated timer counting UP (elapsed hold time)
  - Running fee counter: "$X.XX in hold fees (Y cycles)"
  - Cycle indicator: pulsing dot every ~5 min to show the bot is re-holding
  - BUY button (green) → prompts for name + email
  - DROP button (red) → releases with confirmation
  - Playful copy: "Your friends owe you $X.XX in hold fees so far"

**Option Contracts Section:**
- Shows on-chain option contracts from Solana devnet
- Each contract: event, tickets, premium paid, expiry date, status badge (Active/Exercised/Expired)
- Link to Solana Explorer for each transaction
- This section uses the seed data created during deployment

### Venue Intelligence Panel (web/venue-intel.html)
Separate page linked from main dashboard. This is the "why venues should care" demo.

**Dashboard showing:**
- Event cards with demand indicators:
  - "Florist Sat" — 3 active options, avg premium 4.3 SOL, demand: 🟢 HIGH
  - "Gimme Gimme Disco Fri" — 5 active options, avg premium 7.8 SOL, demand: 🔴 CRITICAL (sold out)
  - "Matinee Social Club Sat" — 0 active options, demand: ⚪ LOW
- Revenue summary: "Total premium revenue: 23 SOL (venue share: 2.3 SOL at 10%)"
- Insight callouts:
  - "💡 Gimme Gimme Disco premiums suggest adding a late show could capture unmet demand"
  - "💡 Florist demand is growing — consider larger venue for next booking"
- This data comes from the seed option contracts + scraped event data
- Make it look like a real analytics dashboard

### Design Guidelines:
- Dark background (#0a0a0a or similar)
- Accent colors: electric blue for active states, green for buy, red for drop
- Clean sans-serif font (system-ui)
- Cards with subtle borders, slight hover effects
- Mobile responsive (hackathon judges might view on phone)
- Include small "⚡ Powered by Solana" badge somewhere
- Include "Built with 🫠 and checkout timeouts" in footer

## COMPONENT 6: README.md

Write a compelling README with this arc:

### Act 1: The Vision
- Ticket options are a new financial primitive for live events
- Fans get price protection and hold optionality while coordinating with friends
- Venues get demand intelligence and premium revenue they currently lose to StubHub
- Options premiums reveal real demand intensity — something a face-value waitlist can never capture

### Act 2: The Hack
- KYD Labs has no API. Tickets aren't programmatically transferable. Everything is manual.
- So we built a bot that exploits the 5-minute checkout timeout to hold tickets indefinitely
- It reads 2FA codes from iMessage, logs into KYD via Playwright, and cycles checkouts in a loop
- Fans text a phone number. The bot holds their tickets and charges them pennies per cycle.
- Yes, this is absurd. That's the point.

### Act 3: The Ask
- Dear KYD Labs: please build an API
- With proper programmatic access, Quorum becomes a real options protocol on Tix
- Venues set royalty rates on option premiums. Fans get real financial instruments on tickets.
- The options market generates demand intelligence that transforms venue operations.
- We built the janky version. Now build the real one.

### Include:
- Architecture diagram (can be ASCII art)
- Screenshots of the web UI
- How to run locally
- Tech stack list
- Link to deployed program on Solana Explorer
- "Built for Solana Graveyard Hackathon — KYD Labs Ticketing Bounty"

### Tone: 
- Self-aware about the jankiness
- Technically credible underneath the humor
- Clearly demonstrates understanding of KYD/Tix thesis
- Add funny inline comments in the code too

## BUILD ORDER — PRIORITY SEQUENCE

Claude Code should build in this order, completing each before moving to the next:

1. **.gitignore + .env** (security first)
2. **imessage-reader.ts** — verify it can read from chat.db. Test by querying recent messages.
3. **imessage-sender.ts** — verify it can send an iMessage via AppleScript
4. **scraper.ts** — pull real LPR event data. Store in memory.
5. **kyd-auth.ts** — login flow with auto 2FA from iMessage reader
6. **holder.ts** — the hold cycling loop using recorded selectors
7. **state.ts** — in-memory hold state management
8. **server/index.ts + routes.ts** — Express API
9. **web/index.html** — main dashboard frontend
10. **web/venue-intel.html** — venue intelligence panel
11. **programs/quorum/src/lib.rs** — Anchor program
12. **Deploy Anchor program to devnet + create seed option contracts**
13. **solana.ts** — read on-chain data for frontend
14. **sms-handler.ts** — keyword parsing for inbound texts
15. **Wire SMS handler to iMessage reader/sender**
16. **README.md**
17. **Run security audit (tests/security-audit.sh)**

## IMPORTANT IMPLEMENTATION NOTES

- Use TypeScript for all bot/server code
- Use Playwright chromium, NOT firefox or webkit
- headless: false for development (switch to true only if explicitly told)
- KYD site is React — requires full browser rendering, not HTTP requests
- KYD events open in POPUPS (new tabs) — must use page.waitForEvent('popup')
- Login only needed once per browser session
- Each KYD account can only hold tickets for ONE event at a time
- But can hold multiple ticket types + any quantity for same event
- The hold cycle timer is ~4:55, not 5:00
- "Continue Shopping" button appears when timer expires
- After Continue Shopping, you're back on event page — re-add and re-checkout
- If any Playwright step fails, retry up to 3 times before logging error
- Log everything clearly to console — we need to debug in the morning
- For the demo, the "purchase" flow can stop at the payment step — we don't need to actually buy tickets
- The Solana program just needs to compile, deploy, and have seed data. It doesn't need to interact with the Playwright bot in real-time for the hackathon demo.
- If Anchor has dependency issues, try versions 0.30.1, 0.29.0, or 0.28.0 until one works
- better-sqlite3 is preferred over sqlite3 for the iMessage reader (synchronous, simpler)

## TESTING NOTES

- The iMessage reader can be tested immediately by reading recent messages from chat.db
- The scraper can be tested against the live site without login
- The auth + hold cycling CANNOT be fully tested without a human present (need real 2FA)
  - Build it, verify the code logic is sound, but expect to debug with real site in the morning
- The Anchor program can be tested with anchor test on devnet
- The web frontend can be tested by running the Express server and seeding with mock data

## FINAL PRE-COMMIT SECURITY AUDIT

Before any git push, run this:
```bash
#!/bin/bash
echo "=== QUORUM SECURITY AUDIT ==="

# Check for phone numbers in source
echo "Checking for hardcoded phone numbers..."
grep -rn "408" --include="*.ts" --include="*.js" --include="*.html" --include="*.rs" . | grep -v node_modules | grep -v .env

# Check for private keys
echo "Checking for private key patterns..."
grep -rn "private\|secret\|key\|token\|password" --include="*.ts" --include="*.js" --include="*.json" . | grep -v node_modules | grep -v .env | grep -v package.json | grep -v tsconfig

# Check for keypair files
echo "Checking for keypair files..."
find . -name "*keypair*" -not -path "./node_modules/*" -not -path "./.gitignore"

# Verify .gitignore
echo "Verifying .gitignore covers sensitive paths..."
for pattern in ".env" "node_modules" "target" "keypair" ; do
    if grep -q "$pattern" .gitignore; then
        echo "  ✅ $pattern in .gitignore"
    else
        echo "  ❌ WARNING: $pattern NOT in .gitignore!"
    fi
done

# Check git staged files
echo "Checking staged files..."
git diff --cached --name-only 2>/dev/null || echo "  No staged files"

echo "=== AUDIT COMPLETE ==="
```

Save this as tests/security-audit.sh and run before every commit.
