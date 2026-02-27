/**
 * routes.ts
 * Express API endpoints for Quorum
 * The REST layer between the web UI and the chaos beneath
 */

import { Router, Request, Response } from 'express';
import { scrapeEvents, getCachedEvents, Event } from '../bot/scraper';
import {
  createHoldState,
  updateHoldState,
  getHoldState,
  getAllHolds,
  getActiveHolds,
  sendHoldCommand,
  generateHoldId,
  getHoldStatusText,
} from './state';
import { getOptionContracts, getVenueIntel } from './solana';
import { handleInboundSMS, parseCommand } from '../bot/sms-handler';
import { runHoldCycle, getSharedBrowser } from '../bot/holder';

const router = Router();

// GET /api/events — scraped LPR event listings
router.get('/events', async (req: Request, res: Response) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    const events = await scrapeEvents();
    res.json({ success: true, events, count: events.length });
  } catch (err: any) {
    console.error('Events fetch error:', err.message);
    // Return cached events as fallback
    const cached = getCachedEvents();
    if (cached.length > 0) {
      res.json({ success: true, events: cached, count: cached.length, cached: true });
    } else {
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

// GET /api/events/:id — single event details
router.get('/events/:id', async (req: Request, res: Response) => {
  const events = getCachedEvents();
  const event = events.find(e => e.id === req.params.id);
  if (!event) {
    res.status(404).json({ success: false, error: 'Event not found' });
    return;
  }
  res.json({ success: true, event });
});

// POST /api/hold — start a new hold
router.post('/hold', async (req: Request, res: Response) => {
  const { eventUrl, eventName, quantity, ticketType, fanPhone } = req.body;

  if (!eventUrl || !quantity) {
    res.status(400).json({ success: false, error: 'eventUrl and quantity required' });
    return;
  }

  const holdId = generateHoldId();
  const name = eventName || 'Unknown Event';

  // Create hold state
  createHoldState({
    holdId,
    eventUrl,
    eventName: name,
    ticketType: ticketType || 'GA',
    quantity: parseInt(quantity),
    fanPhone,
  });

  // Start hold cycle in background (don't await — it runs indefinitely)
  getSharedBrowser().then(browser => {
    runHoldCycle({
      holdId,
      eventUrl,
      eventName: name,
      ticketType: ticketType || 'GA',
      quantity: parseInt(quantity),
    }, browser).catch(err => {
      console.error(`Hold ${holdId} failed:`, err.message);
      updateHoldState(holdId, { status: 'error' });
    });
  });

  res.json({ success: true, holdId, message: 'Hold started' });
});

// GET /api/hold/:id/status — current hold state
router.get('/hold/:id/status', (req: Request, res: Response) => {
  const holdId = String(req.params.id);
  const state = getHoldState(holdId);
  if (!state) {
    res.status(404).json({ success: false, error: 'Hold not found' });
    return;
  }

  const elapsedMs = Date.now() - state.startTime;
  res.json({
    success: true,
    hold: {
      ...state,
      fanPhone: undefined, // never expose phone in API response
      fanEmail: undefined,
      elapsedMs,
      elapsedMinutes: Math.floor(elapsedMs / 60000),
      feeDollars: (state.totalFeeCents / 100).toFixed(2),
    },
  });
});

// POST /api/hold/:id/buy — complete purchase
router.post('/hold/:id/buy', (req: Request, res: Response) => {
  const holdId = String(req.params.id);
  const state = getHoldState(holdId);
  if (!state) {
    res.status(404).json({ success: false, error: 'Hold not found' });
    return;
  }

  // Store fan data in-memory only (never to disk)
  const { name, email } = req.body;
  updateHoldState(holdId, {
    fanName: name,
    fanEmail: email,
    command: 'buy',
    status: 'buying',
  });

  res.json({ success: true, message: 'Purchase initiated', holdId });
});

// POST /api/hold/:id/drop — release hold
router.post('/hold/:id/drop', (req: Request, res: Response) => {
  const holdId = String(req.params.id);
  const dropped = sendHoldCommand(holdId, 'drop');
  if (!dropped) {
    res.status(404).json({ success: false, error: 'Hold not found' });
    return;
  }
  updateHoldState(holdId, { status: 'dropped' });
  res.json({ success: true, message: 'Hold released' });
});

// GET /api/holds — all active holds
router.get('/holds', (req: Request, res: Response) => {
  const holds = getActiveHolds().map(h => ({
    ...h,
    fanPhone: undefined, // sanitize
    fanEmail: undefined,
    elapsedMs: Date.now() - h.startTime,
    feeDollars: (h.totalFeeCents / 100).toFixed(2),
  }));
  res.json({ success: true, holds, count: holds.length });
});

// GET /api/options — on-chain option contracts
router.get('/options', async (req: Request, res: Response) => {
  try {
    const options = await getOptionContracts();
    res.json({ success: true, options, count: options.length });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/venue-intel — aggregated demand intelligence
router.get('/venue-intel', async (req: Request, res: Response) => {
  try {
    const options = await getOptionContracts();
    const intel = getVenueIntel(options);
    res.json({ success: true, intel });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/sms/incoming — webhook for iMessage handler
router.post('/sms/incoming', async (req: Request, res: Response) => {
  const { phoneNumber, message } = req.body;

  if (!phoneNumber || !message) {
    res.status(400).json({ success: false, error: 'phoneNumber and message required' });
    return;
  }

  try {
    const response = await handleInboundSMS(
      phoneNumber,
      message,
      async (phone: string, event: Event, qty: number) => {
        const holdId = generateHoldId();
        createHoldState({
          holdId,
          eventUrl: event.eventUrl,
          eventName: event.name,
          ticketType: 'GA',
          quantity: qty,
          fanPhone: phone,
        });

        // Start hold in background
        getSharedBrowser().then(browser => {
          runHoldCycle({ holdId, eventUrl: event.eventUrl, eventName: event.name, ticketType: 'GA', quantity: qty }, browser)
            .catch(err => {
              console.error(`Hold failed:`, err.message);
              updateHoldState(holdId, { status: 'error' });
            });
        });

        return holdId;
      }
    );

    res.json({ success: true, response });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/health — sanity check
router.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    activeHolds: getActiveHolds().length,
    solana: process.env.SOLANA_RPC_URL,
  });
});

export default router;
