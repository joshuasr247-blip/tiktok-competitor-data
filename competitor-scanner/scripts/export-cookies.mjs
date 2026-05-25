/**
 * export-cookies.mjs
 * Run this ONCE locally to export your TikTok Ads session cookies.
 * Then add the output as a GitHub Actions secret called TIKTOK_COOKIES.
 *
 * Usage:
 *   npm install playwright
 *   npx playwright install chromium
 *   node scripts/export-cookies.mjs
 */

import { chromium } from 'playwright';
import { writeFileSync } from 'fs';

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();

console.log('\n🔐 Opening TikTok Ads login...');
await page.goto('https://ads.tiktok.com/i18n/login');
console.log('👉 Log in manually in the browser window.');
console.log('   Waiting up to 2 minutes...\n');

try {
  // Wait until we land on the main dashboard after login
  await page.waitForURL(
    url => url.toString().includes('/home') || url.toString().includes('/dashboard') || url.toString().includes('/creativecenter'),
    { timeout: 120_000 }
  );

  // Small pause to let all session cookies settle
  await page.waitForTimeout(2000);

  const cookies = await context.cookies([
    'https://ads.tiktok.com',
    'https://business.tiktok.com',
  ]);

  const cookieJson = JSON.stringify(cookies, null, 2);
  writeFileSync('tiktok-cookies.json', cookieJson);

  console.log(`✅ Exported ${cookies.length} cookies → tiktok-cookies.json`);
  console.log('\nNext steps:');
  console.log('1. Copy the contents of tiktok-cookies.json');
  console.log('2. Add it as a GitHub Actions secret named TIKTOK_COOKIES');
  console.log('3. Add it as a Vercel env var named TIKTOK_COOKIES (if needed)');
  console.log('4. Delete tiktok-cookies.json from your machine after adding the secret\n');
} catch (e) {
  console.error('❌ Timed out waiting for login. Try again.', e.message);
} finally {
  await browser.close();
}
