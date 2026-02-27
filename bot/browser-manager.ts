/**
 * browser-manager.ts
 * Manages the shared Playwright browser instance lifecycle
 * One browser to rule them all, one browser to hold them
 */

import { Browser, BrowserContext, chromium } from 'playwright';
import * as dotenv from 'dotenv';

dotenv.config();

const IS_DEV = process.env.NODE_ENV !== 'production';

let browser: Browser | null = null;
let launchCount = 0;

export async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    launchCount++;
    console.log(`🌐 Launching browser (launch #${launchCount})...`);

    browser = await chromium.launch({
      headless: !IS_DEV, // visible in dev, headless in prod
      slowMo: IS_DEV ? 100 : 0,
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled', // less bot-detectable
      ],
    });

    // Auto-cleanup on process exit
    process.once('SIGTERM', () => closeBrowser());
    process.once('SIGINT', () => closeBrowser());

    console.log(`✅ Browser launched`);
  }
  return browser;
}

export async function newContext(): Promise<BrowserContext> {
  const b = await getBrowser();
  return b.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
    console.log('🌐 Browser closed');
  }
}

export function isBrowserOpen(): boolean {
  return browser !== null && browser.isConnected();
}
