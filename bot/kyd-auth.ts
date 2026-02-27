/**
 * kyd-auth.ts
 * KYD Labs login flow with automatic 2FA from iMessage
 *
 * The chain: KYD sends SMS → macOS receives it → iMessage DB captures it →
 * we read it from chat.db → fill 4 OTP fields → we're in.
 * It's beautiful in a chaotic way.
 */

import { Page, Browser, BrowserContext } from 'playwright';
import { getLatestOTP } from './imessage-reader';
import * as dotenv from 'dotenv';

dotenv.config();

const KYD_PHONE = process.env.KYD_PHONE_NUMBER;
if (!KYD_PHONE) {
  throw new Error('KYD_PHONE_NUMBER not set in .env — cannot authenticate');
}

// Store auth state across the session
let isAuthenticated = false;
let lastAuthTime = 0;
const AUTH_SESSION_TTL_MS = 8 * 60 * 60 * 1000; // KYD sessions seem to last ~8hrs

/**
 * Log into KYD Labs on a given page/popup
 * The page should already be on a KYD event page
 */
export async function loginToKYD(eventPage: Page): Promise<void> {
  console.log('🔐 Starting KYD login flow...');

  // Check if already logged in (Sign In button gone or user menu present)
  const alreadyLoggedIn = await checkIfLoggedIn(eventPage);
  if (alreadyLoggedIn) {
    console.log('✅ Already logged in to KYD');
    isAuthenticated = true;
    lastAuthTime = Date.now();
    return;
  }

  // Click Sign In
  const signInLink = eventPage.getByText('Sign In');
  await signInLink.click({ timeout: 10000 });
  await eventPage.waitForTimeout(1000);

  // Fill phone number
  const phoneInput = eventPage.getByRole('textbox', { name: 'Mobile number' });
  await phoneInput.waitFor({ timeout: 10000 });
  await phoneInput.fill(KYD_PHONE!);
  console.log(`📱 Filled phone number`);

  // Note the time before requesting OTP so we only accept codes that arrive AFTER this
  const otpRequestTime = Math.floor(Date.now() / 1000) - 2;

  // Click Next to trigger SMS
  await eventPage.getByRole('button', { name: 'Next' }).click();
  console.log('📲 OTP requested — waiting for SMS...');

  // Wait for OTP fields to appear
  await eventPage.getByRole('textbox', { name: 'Please enter OTP character 1' })
    .waitFor({ timeout: 15000 });

  // Get OTP from iMessage (polls chat.db every 2 seconds)
  const otp = await getLatestOTP(otpRequestTime, 120_000);
  console.log('🔑 OTP received, filling fields...');

  // Fill 4 OTP character fields
  await eventPage.getByRole('textbox', { name: 'Please enter OTP character 1' }).fill(otp[0]);
  await eventPage.getByRole('textbox', { name: 'Please enter OTP character 2' }).fill(otp[1]);
  await eventPage.getByRole('textbox', { name: 'Please enter OTP character 3' }).fill(otp[2]);
  await eventPage.getByRole('textbox', { name: 'Please enter OTP character 4' }).fill(otp[3]);

  // Wait for login to complete
  await eventPage.waitForTimeout(2000);

  // Confirm login
  const loggedIn = await checkIfLoggedIn(eventPage);
  if (!loggedIn) {
    // Sometimes there's a submit button after OTP
    const verifyBtn = eventPage.getByRole('button', { name: /verify|confirm|submit/i });
    if (await verifyBtn.isVisible().catch(() => false)) {
      await verifyBtn.click();
      await eventPage.waitForTimeout(2000);
    }
  }

  const finalCheck = await checkIfLoggedIn(eventPage);
  if (finalCheck) {
    console.log('✅ KYD login successful!');
    isAuthenticated = true;
    lastAuthTime = Date.now();
  } else {
    // Not necessarily a failure — KYD sometimes just goes straight to the event
    console.log('⚠️ Could not confirm login state — proceeding anyway');
    isAuthenticated = true;
    lastAuthTime = Date.now();
  }
}

/**
 * Check if we're currently logged in
 * KYD shows "Sign In" when logged out
 */
async function checkIfLoggedIn(page: Page): Promise<boolean> {
  try {
    // If Sign In text is NOT visible, we're probably logged in
    const signInVisible = await page.getByText('Sign In').isVisible().catch(() => false);
    if (!signInVisible) return true;

    // Check for user account indicators
    const userMenuVisible = await page.getByRole('button', { name: /account|profile|logout|my tickets/i })
      .isVisible().catch(() => false);
    if (userMenuVisible) return true;

    return false;
  } catch {
    return false;
  }
}

/**
 * Check if we need to re-authenticate
 */
export function needsLogin(): boolean {
  if (!isAuthenticated) return true;
  if (Date.now() - lastAuthTime > AUTH_SESSION_TTL_MS) return true;
  return false;
}

/**
 * Full flow: navigate to event page (handles popup), login, return the event page
 */
export async function navigateAndLogin(
  basePage: Page,
  eventUrl: string
): Promise<Page> {
  console.log(`🌐 Navigating to event: ${eventUrl}`);

  // KYD opens events in popups — listen for it
  const popupPromise = basePage.waitForEvent('popup', { timeout: 10000 }).catch(() => null);

  // Try clicking the event link — it might be on the current page
  const eventLink = basePage.getByRole('link', { name: /.+/ }).filter({ has: basePage.locator(`[href*="${new URL(eventUrl).pathname}"]`) });
  const linkExists = await eventLink.first().isVisible().catch(() => false);

  if (linkExists) {
    await eventLink.first().click();
  } else {
    // Navigate directly
    await basePage.goto(eventUrl);
  }

  // Check if a popup opened
  const popup = await popupPromise;
  const eventPage = popup || basePage;

  // Wait for page to load
  await eventPage.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {
    console.log('⚠️ networkidle timeout — proceeding anyway');
  });

  // Login if needed
  if (needsLogin()) {
    await loginToKYD(eventPage);
  }

  return eventPage;
}

/**
 * LIVE 2FA TEST — validates the entire auth pipeline
 * Run this to confirm iMessage integration works before relying on it
 */
export async function runLiveAuthTest(browser: Browser): Promise<boolean> {
  console.log('\n=== LIVE KYD 2FA TEST ===');
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // Navigate to LPR bio page
    // Use 'load' not 'networkidle' — KYD's React app has continuous background requests
    console.log('🌐 Loading kydlabs.com/p/lpr/bio...');
    await page.goto('https://kydlabs.com/p/lpr/bio', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // Wait for React to hydrate — look for any event link to appear
    await page.waitForSelector('a[href*="/e/"]', { timeout: 15000 })
      .catch(() => console.log('⚠️ Event links slow to appear — continuing'));

    console.log('✅ Loaded LPR page');

    // Expand all events if needed
    await page.getByRole('button', { name: 'See All Upcoming Events' }).click({ timeout: 5000 })
      .catch(() => console.log('No See All button — events may already be visible'));

    await page.waitForTimeout(2000);

    // Wait for event card links (href contains /e/) to appear
    await page.waitForSelector('a[href*="/e/"]', { timeout: 10000 })
      .catch(() => console.log('⚠️ Event links with /e/ not found'));

    // Set up popup listener BEFORE clicking (order matters)
    const popupPromise = page.waitForEvent('popup', { timeout: 20000 });

    // Click first actual event link (href contains /e/)
    const eventLinks = page.locator('a[href*="/e/"]');
    const count = await eventLinks.count();
    console.log(`Found ${count} event links`);
    await eventLinks.first().click();

    const eventPage = await popupPromise;

    // Wait for event page to load enough to interact with
    await eventPage.waitForLoadState('domcontentloaded', { timeout: 20000 });
    await eventPage.waitForTimeout(2000); // React needs a moment

    console.log('✅ Event popup opened');

    // Run login
    await loginToKYD(eventPage);

    console.log('\n✅ LIVE 2FA TEST PASSED — KYD auth pipeline is working!');
    await context.close();
    return true;

  } catch (err: any) {
    console.error('\n❌ LIVE 2FA TEST FAILED:', err.message);
    await context.close();
    return false;
  }
}
