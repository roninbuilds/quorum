/**
 * holder.ts
 * THE CORE PRODUCT — exploits KYD's 5-minute checkout timeout
 * to hold tickets indefinitely for fans who can't make up their minds.
 *
 * The loop:
 *   Add tickets → Get N Tickets (starts ~4:55 countdown) → wait for Continue Shopping
 *   → click Continue Shopping → back to event → Add again → repeat forever
 *
 * This is the financial primitive the music industry didn't know it needed.
 * (Or wanted. Or asked for. But here we are.)
 */

import { Page, Browser, chromium } from 'playwright';
import { loginToKYD, needsLogin } from './kyd-auth';
import { updateHoldState, HoldState } from '../server/state';
import * as dotenv from 'dotenv';

dotenv.config();

const HOLD_RATE_CENTS = parseInt(process.env.HOLD_RATE_CENTS || '10');
const CHECKOUT_TIMEOUT_MS = 310_000; // 5min 10sec — slightly more than KYD's ~4:55 timer
const MAX_RETRIES = 3;

export interface HoldConfig {
  holdId: string;
  eventUrl: string;
  eventName: string;
  ticketType: string;
  quantity: number;
  onStatusUpdate?: (state: HoldState) => void;
}

/**
 * Run the hold cycling loop for a fan.
 * This runs indefinitely until the fan sends BUY or DROP.
 *
 * Each cycle:
 *  1. Add N tickets to cart
 *  2. Click checkout (starts ~4:55 timer)
 *  3. Wait for "Continue Shopping" button (timer expired)
 *  4. Click Continue Shopping
 *  5. Repeat
 *
 * Stops when holdState.command is set to 'buy' or 'drop'
 */
export async function runHoldCycle(config: HoldConfig, browser: Browser): Promise<void> {
  const { holdId, eventUrl, eventName, ticketType, quantity } = config;
  let cycleCount = 0;
  let consecutiveErrors = 0;
  let page: Page | null = null;

  console.log(`\n🎫 Starting hold cycle for ${holdId}`);
  console.log(`   Event: ${eventName}`);
  console.log(`   Tickets: ${quantity}x ${ticketType}`);
  console.log(`   Rate: $${HOLD_RATE_CENTS / 100}/cycle (~$${HOLD_RATE_CENTS * 12}/hour if cycling every 5min)`);

  // Create browser context
  const context = await browser.newContext();

  try {
    // Open base page
    const basePage = await context.newPage();
    await basePage.goto('https://kydlabs.com/p/lpr/bio', { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Navigate to event (handles popup logic + auth)
    page = await navigateToEventPage(basePage, eventUrl, eventName);

    // Login if needed
    if (needsLogin()) {
      await loginToKYD(page);
    }

    // Update initial state
    updateHoldState(holdId, {
      status: 'active',
      cycleCount: 0,
      startTime: Date.now(),
      totalFeeCents: 0,
      lastCycleTime: Date.now(),
      command: null,
    });

    // THE LOOP — runs until BUY or DROP
    while (true) {
      const currentState = getHoldCommand(holdId);

      if (currentState === 'drop') {
        console.log(`🛑 [${holdId}] DROP command received — stopping hold`);
        updateHoldState(holdId, { status: 'dropped', command: 'drop' });
        break;
      }

      if (currentState === 'buy') {
        console.log(`💸 [${holdId}] BUY command received — proceeding to checkout`);
        updateHoldState(holdId, { status: 'buying', command: 'buy' });
        // The buy flow is handled separately — just exit the cycle
        break;
      }

      // Execute one hold cycle
      try {
        console.log(`\n🔄 [${holdId}] Cycle ${cycleCount + 1} starting...`);
        await executeOneCycle(page, quantity, ticketType, cycleCount);

        cycleCount++;
        consecutiveErrors = 0;

        const totalFeeCents = cycleCount * HOLD_RATE_CENTS;
        updateHoldState(holdId, {
          cycleCount,
          totalFeeCents,
          lastCycleTime: Date.now(),
          status: 'active',
        });

        console.log(`✅ [${holdId}] Cycle ${cycleCount} complete. Total fee: $${(totalFeeCents / 100).toFixed(2)}`);

      } catch (err: any) {
        consecutiveErrors++;
        console.error(`❌ [${holdId}] Cycle error (${consecutiveErrors}/${MAX_RETRIES}):`, err.message);

        if (consecutiveErrors >= MAX_RETRIES) {
          console.error(`💀 [${holdId}] Too many consecutive errors — attempting page recovery`);
          try {
            page = await recoverPage(context, eventUrl, eventName, page);
            consecutiveErrors = 0;
          } catch (recoveryErr: any) {
            console.error(`💀 [${holdId}] Page recovery failed:`, recoveryErr.message);
            updateHoldState(holdId, { status: 'error' });
            break;
          }
        } else {
          // Brief pause before retry
          await new Promise(r => setTimeout(r, 3000));
        }
      }
    }

  } finally {
    await context.close().catch(() => {});
    console.log(`🏁 [${holdId}] Hold cycle ended after ${cycleCount} cycles`);
  }
}

/**
 * Execute one hold cycle:
 * Add tickets → checkout → wait for Continue Shopping → click it
 */
async function executeOneCycle(
  page: Page,
  quantity: number,
  ticketType: string,
  cycleIndex: number
): Promise<void> {

  // On subsequent cycles, we're back on the event page after "Continue Shopping"
  // No need to navigate — just re-add tickets

  // Add tickets to cart
  await addTicketsToCart(page, quantity, ticketType, cycleIndex);

  // Click checkout button
  await clickCheckout(page, quantity);

  // Wait for the hold timer to expire (~4:55)
  console.log(`⏳ Holding... (waiting up to ${CHECKOUT_TIMEOUT_MS / 1000}s for Continue Shopping)`);
  await waitForContinueShopping(page);

  // Click Continue Shopping to restart the cycle
  await clickContinueShopping(page);

  // Brief pause to let the page reset
  await page.waitForTimeout(1500);
}

async function addTicketsToCart(
  page: Page,
  quantity: number,
  ticketType: string,
  cycleIndex: number
): Promise<void> {
  // On first cycle, use the row-specific selector
  // On subsequent cycles, simpler Add button works (we're already on the event page)

  if (cycleIndex === 0 && ticketType && ticketType !== 'GA') {
    // Try to find the specific ticket type row
    try {
      const row = page.getByRole('row', { name: new RegExp(ticketType, 'i') });
      const addBtn = row.getByLabel('Add');
      if (await addBtn.isVisible({ timeout: 5000 })) {
        for (let i = 0; i < quantity; i++) {
          await addBtn.click();
          await page.waitForTimeout(300);
        }
        console.log(`   Added ${quantity}x tickets from row: ${ticketType}`);
        return;
      }
    } catch {
      // Fall through to generic selector
    }
  }

  // Generic: click Add button N times
  const addBtn = page.getByRole('button', { name: 'Add' }).first();
  await addBtn.waitFor({ timeout: 10000 });

  for (let i = 0; i < quantity; i++) {
    await addBtn.click();
    await page.waitForTimeout(400); // KYD UI needs a moment between clicks
  }
  console.log(`   Added ${quantity}x tickets`);
}

async function clickCheckout(page: Page, quantity: number): Promise<void> {
  // The checkout button shows current count: "Get 2 Tickets", "Get 1 Ticket", etc.
  const checkoutBtn = page.getByRole('button', { name: /Get \d+ Tickets?/i });
  await checkoutBtn.waitFor({ timeout: 10000 });
  await checkoutBtn.click();
  console.log(`   Clicked checkout — hold timer starting`);
}

async function waitForContinueShopping(page: Page): Promise<void> {
  // "Continue Shopping" appears when the ~4:55 checkout timer expires
  const continueBtn = page.getByRole('button', { name: 'Continue Shopping' });
  await continueBtn.waitFor({ timeout: CHECKOUT_TIMEOUT_MS });
  console.log(`   "Continue Shopping" appeared — timer expired`);
}

async function clickContinueShopping(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Continue Shopping' }).click();
  await page.waitForTimeout(1000);
  console.log(`   Clicked "Continue Shopping" — back to event page`);
}

/**
 * Navigate to an event page, handling the popup pattern
 */
async function navigateToEventPage(
  basePage: Page,
  eventUrl: string,
  eventName: string
): Promise<Page> {
  console.log(`🌐 Navigating to event: ${eventName}`);

  // Try to navigate via the See All Events flow (more reliable for popup handling)
  try {
    await basePage.goto('https://kydlabs.com/p/lpr/bio', { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for event links to appear
    await basePage.waitForSelector('a[href*="/e/"]', { timeout: 10000 }).catch(() => {});

    // Expand events list if needed
    const seeAll = basePage.getByRole('button', { name: 'See All Upcoming Events' });
    if (await seeAll.isVisible({ timeout: 3000 }).catch(() => false)) {
      await seeAll.click();
      await basePage.waitForTimeout(1500);
    }

    // Set up popup listener BEFORE clicking (order is critical)
    const popupPromise = basePage.waitForEvent('popup', { timeout: 8000 }).catch(() => null);

    // Try href-based selector first (most reliable), then text-based
    const hrefSlug = eventUrl.split('/e/')[1]?.split('?')[0];
    let clicked = false;

    if (hrefSlug) {
      const directLink = basePage.locator(`a[href*="${hrefSlug}"]`).first();
      if (await directLink.isVisible({ timeout: 3000 }).catch(() => false)) {
        await directLink.click();
        clicked = true;
      }
    }

    if (!clicked) {
      const link = basePage.getByRole('link', { name: new RegExp(eventName.split(' ')[0], 'i') }).first();
      if (await link.isVisible({ timeout: 3000 }).catch(() => false)) {
        await link.click();
        clicked = true;
      }
    }

    if (clicked) {
      const popup = await popupPromise;
      if (popup) {
        await popup.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
        await popup.waitForTimeout(1500);
        return popup;
      }
    }
  } catch (err) {
    console.log('⚠️ Could not navigate via bio page, trying direct URL...');
  }

  // Fallback: navigate directly to event URL
  await basePage.goto(eventUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await basePage.waitForTimeout(1500);
  return basePage;
}

/**
 * Try to recover from page errors by navigating fresh
 */
async function recoverPage(
  context: any,
  eventUrl: string,
  eventName: string,
  oldPage: Page
): Promise<Page> {
  console.log('🔧 Attempting page recovery...');
  await oldPage.close().catch(() => {});

  const newBasePage = await context.newPage();
  await newBasePage.goto('https://kydlabs.com/p/lpr/bio', { waitUntil: 'domcontentloaded', timeout: 30000 });

  const eventPage = await navigateToEventPage(newBasePage, eventUrl, eventName);

  // Re-login if session expired
  if (needsLogin()) {
    await loginToKYD(eventPage);
  }

  console.log('✅ Page recovered');
  return eventPage;
}

/**
 * Check the current command for a hold (from in-memory state)
 */
function getHoldCommand(holdId: string): string | null {
  const { getHoldState } = require('../server/state');
  const state = getHoldState(holdId);
  return state?.command || null;
}

/**
 * Browser manager singleton — shared browser instance
 */
let sharedBrowser: Browser | null = null;

export async function getSharedBrowser(): Promise<Browser> {
  if (!sharedBrowser || !sharedBrowser.isConnected()) {
    sharedBrowser = await chromium.launch({
      headless: false, // visible during dev so we can see what's happening
      slowMo: 100, // slight delay for stability
    });
    console.log('🌐 Browser launched');
  }
  return sharedBrowser;
}

export async function closeSharedBrowser(): Promise<void> {
  if (sharedBrowser) {
    await sharedBrowser.close().catch(() => {});
    sharedBrowser = null;
  }
}
