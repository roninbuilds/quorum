# QUORUM 🎫
### Lock in ticket prices while your group chat makes up its mind.
**Built for Solana Graveyard Hackathon × KYD Labs Ticketing Bounty**

---

## The Problem

Every friend group has that one person. "Let me check my schedule." "I think I might have something that day." "Can you send me the link again?" Meanwhile, tickets sell out or prices climb. Group coordination is where ticket purchases go to die.

## The Solution

Text Quorum. Tell it what show, how many tickets, and how long your flaky friends need to decide. Quorum holds your tickets at face value while your group chat sorts itself out. Pay a small premium ($5-$10), and an autonomous agent keeps your tickets locked in. When everyone commits, text BUY. If plans fall apart, text DROP.

## How It Works

```
Fan texts "Hey Quorum, hold 5 tickets to Emo Night"
  → LLM agent parses request, finds event, confirms details
    → Fan pays premium via Solana Blink
      → Anchor program creates on-chain options contract
        → Playwright bot logs into KYD, adds tickets, starts checkout
          → Every ~5 min, bot cycles checkout timeout to maintain hold
            → Fan texts BUY → purchase completed
            → Fan texts DROP → hold released
```

## Architecture

```
Fan (SMS) → iMessage (chat.db) → LLM Agent (Claude Sonnet)
                                       ↓
                               Playwright Bot → KYD Labs checkout
                                       ↓
                         Solana Blink → Anchor Program (devnet)
                                       ↓
                         Web Dashboard → Venue Intelligence Panel
```

## The Bigger Picture: Why Everyone Wins

**For Fans:** Price protection while coordinating with friends. No more "sorry, sold out."

**For Venues:** Right now, when a show sells out, the demand premium goes to scalpers. Venues see none of that money and learn nothing from that demand. Quorum turns the scalping premium into transparent on-chain options pricing. Venues earn royalties on every premium. When 50 people pay $8 each to hold Friday tickets, that's a signal — book a second night, raise base prices, rebook the artist. Options premiums are demand intelligence that waitlists can never provide.

**For Speculators:** Scalpers become legitimate market makers. Buy early bird tickets, write call options, profit from time premiums as the event approaches. The secondary market doesn't die — it becomes transparent, on-chain, and everyone gets a cut.

**For KYD/Tix Protocol:** This isn't a separate product. It's what KYD's waitlist should become. Quorum monetizes waitlists in data-informed, customer-savvy ways.

## The Hack (How We Actually Built This)

KYD Labs has no API. Tickets aren't programmatically transferable. The checkout flow is entirely manual. So we got creative:

- 🤖 Bot reads SMS 2FA codes directly from macOS iMessage (chat.db SQLite)
- 🎭 Playwright automates the entire KYD checkout flow in a real browser
- ⏱️ The 5-minute checkout timeout becomes a renewable reservation primitive
- 💬 Claude Sonnet parses natural language texts into structured ticket hold requests
- ⛓️ Solana Anchor program logs options contracts on-chain
- 🔗 Blinks enable wallet payments via text message links
- 📱 macOS AppleScript sends SMS responses (because Twilio rejected our A2P campaign)

Yes, this is absurd. That's the point.

## Hold Pricing

| Duration | Price | SOL (devnet) | Use Case |
|----------|-------|-------------|----------|
| 1 hour | $1 | 0.006 SOL | Same-week events, quick decisions |
| 3 hours | $2 | 0.012 SOL | Day-of coordination |
| 3 days | $5 | 0.03 SOL | Standard friend group deliberation |
| 7 days | $10 | 0.06 SOL | The Sam in your group needs extra time |
| 30 days | $25 | 0.15 SOL | Coming soon |

## Tech Stack

- **Solana** (Anchor, Blinks, @solana/kit) — on-chain options contracts + payments
- **Playwright** — autonomous browser agent for KYD checkout cycling
- **Anthropic Claude Sonnet** — natural language SMS chatbot
- **macOS iMessage + AppleScript** — SMS interface
- **Express + TypeScript** — API server
- **Vanilla HTML/JS** — dashboard + venue intelligence frontend

## Solana Program

- **Program ID:** FC1476pqPa9YtMiXVk2QTFMNEjfh8P16HiEM3DihHhqy
- **Explorer:** https://explorer.solana.com/address/FC1476pqPa9YtMiXVk2QTFMNEjfh8P16HiEM3DihHhqy?cluster=devnet
- **Instructions:** create_option, exercise_option, expire_option
- **Accounts:** PDA-based OptionContract with full lifecycle (Active → Exercised/Expired)

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/events | Scraped LPR event listings (83 events) |
| GET | /api/options | On-chain option contracts |
| GET | /api/venue-intel | Aggregated demand intelligence |
| POST | /api/hold | Start a ticket hold |
| GET | /api/hold/:id/status | Hold status, cycles, fees |
| POST | /api/hold/:id/buy | Complete purchase |
| POST | /api/hold/:id/drop | Release hold |
| GET | /api/blink/:holdId | Solana Action metadata |
| POST | /api/blink/:holdId/pay | Build payment transaction |

## Roadmap

🔜 **KYD API Integration** — Replace checkout timeout abuse with proper programmatic access. This is simultaneously a prototype and a feature request. Dear KYD: build the API. We'll build the options market.

🔜 **Waitlist-as-Options-Market** — Every sold-out show gets a derivatives market. The waitlist becomes an orderbook. People who want tickets most (highest premium) get served first. Venues capture revenue they currently lose to StubHub.

🔜 **Two-Sided Options Market** — Let speculators write calls on tickets they hold. Early bird buyers sell upside to latecomers. As events approach, willingness to pay increases, premiums adjust dynamically. Real price discovery for live events.

🔜 **Multi-Phone Scaling** — Each phone = one more concurrent event hold. A rack of phones = an options desk. (Yes, this is absurd. That's why KYD needs an API.)

🔜 **Venue Analytics Dashboard** — Premium-based demand forecasting. Dynamic pricing recommendations. Revenue attribution from options vs face-value sales.

🔜 **Twilio Integration** — We tried. They rejected our A2P 10DLC campaign registration. The "plug your phone into your Mac" approach is both our hack and a genuine gap in the agent developer ecosystem.

🔜 **Audius Integration** — Artist-specific demand signals from streaming data to predict ticket demand before events are even announced.

## Running Locally

```bash
git clone https://github.com/roninbuilds/quorum
cd quorum
npm install
npx playwright install chromium
cp .env.example .env  # add your credentials
npm run dev           # starts API server + SMS loop on localhost:3000
```

## Built With 🫠 and Checkout Timeouts

Solana Graveyard Hackathon 2026 — KYD Labs Ticketing Bounty

---

*"We built the janky version to prove the concept. Now build the real one."*
