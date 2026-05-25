/**
 * tiktok-scraper.mjs
 * Scrapes TikTok Creative Center for ragebait→demo UGC ads in software/app categories.
 * Runs daily via GitHub Actions. Writes new ads to data/ads.json (committed back to repo).
 *
 * Env vars required:
 *   TIKTOK_COOKIES  — JSON array of cookies exported by export-cookies.mjs
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, '../data/ads.json');

function loadData() {
  try {
    return JSON.parse(readFileSync(DATA_PATH, 'utf8'));
  } catch {
    return { last_run: null, ads: [] };
  }
}

function saveData(data) {
  mkdirSync(dirname(DATA_PATH), { recursive: true });
  writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
}

// ── Hook classifier ──────────────────────────────────────────────────────────
const PATTERNS = {
  RAGEBAIT: [
    /you'?re? (wasting|doing .{0,20} wrong|missing out)/i,
    /(stop|quit) .{0,30}(doing|using|wasting|manually|writing|sending)/i,
    /(most people|everyone|everybody) (don'?t|doesn'?t|never|still)/i,
    /(nobody|no one) (told|knows|talks)/i,
    /still doing .{0,20}manually/i,
    /doing (it|this) wrong/i,
    /you'?ve? been .{0,20}wrong/i,
    /they don'?t want you to/i,
  ],
  PAIN_POINT: [
    /(tired|sick) of/i,
    /(struggling|struggle) (with|to)/i,
    /(wasting|waste) (hours|time|money)/i,
    /takes (forever|too long|hours)/i,
    /so frustrating/i,
  ],
  CURIOSITY_GAP: [
    /here'?s how/i,
    /this is why/i,
    /watch what happens/i,
    /you won'?t believe/i,
    /(secret|hidden) (trick|feature|hack|method)/i,
    /what (happens|happened) when/i,
  ],
  DEMO: [
    /(let me show|watch me|i'?ll show)/i,
    /(demo|tutorial|walkthrough)/i,
    /in (seconds|minutes)/i,
    /effortless(ly)?/i,
    /instantly/i,
    /generate .{0,20}(guide|doc|content)/i,
    /animate .{0,20}(pic|photo|image)/i,
    /swipe to (learn|see)/i,
  ],
};

function classifyHook(text) {
  if (!text) return 'OTHER';
  for (const [label, patterns] of Object.entries(PATTERNS)) {
    if (patterns.some(p => p.test(text))) return label;
  }
  return 'OTHER';
}

// ── Relevant industries ──────────────────────────────────────────────────────
const RELEVANT = [
  'app', 'it service', 'business', 'productivity', 'software',
  'technology', 'marketing', 'photography', 'saas', 'tool', 'utility',
  'game', 'office', 'recruitment',
];

function isRelevant(industry = '') {
  const lower = industry.toLowerCase();
  return RELEVANT.some(r => lower.includes(r));
}

// ── Scrape card list page ────────────────────────────────────────────────────
async function scrapeCardList(page) {
  await page.waitForTimeout(3500);
  return page.evaluate(() => {
    const links = [...document.querySelectorAll('a[href*="/creativecenter/topads/"]')];
    const cards = [];
    links.forEach(link => {
      const id = link.href.match(/topads\/(\d+)/)?.[1];
      if (!id) return;
      let el = link;
      for (let i = 0; i < 15; i++) {
        el = el?.parentElement;
        const txt = el?.innerText || '';
        if (txt.includes('Likes') && txt.includes('CTR')) {
          const lines = txt.split('\n').map(l => l.trim()).filter(Boolean);
          const li = lines.findIndex(l => l === 'Likes');
          const ci = lines.findIndex(l => l === 'CTR');
          cards.push({
            id,
            industry: lines[1] || '',
            likes: li > 0 ? lines[li - 1] : '',
            ctr: ci > 0 ? lines[ci - 1] : '',
            objective: lines[0] || '',
          });
          break;
        }
      }
    });
    return cards;
  });
}

// ── Scrape individual ad detail page ────────────────────────────────────────
async function scrapeDetail(page, id) {
  await page.goto(`https://ads.tiktok.com/business/creativecenter/topads/${id}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForTimeout(2500);

  return page.evaluate(() => {
    const t = document.querySelector('main')?.innerText || '';
    const get = (label) => {
      const i = t.indexOf(label + '\n');
      if (i < 0) return '';
      return t.substring(i + label.length + 1, i + label.length + 300).split('\n')[0].trim();
    };
    return {
      hook: get('Ad caption'),
      industry: get('Industry'),
      brand: get('Brand name'),
      lp: get('Landing Page').split('?')[0],
      likes: get('Likes'),
      ctr: get('CTR'),
      objective: get('Objective'),
    };
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🔍 TikTok Competitor Scanner starting...');

  // Load cookies
  const cookiesRaw = process.env.TIKTOK_COOKIES;
  if (!cookiesRaw) throw new Error('TIKTOK_COOKIES env var not set');
  const cookies = JSON.parse(cookiesRaw);

  // Load existing data
  const store = loadData();
  const seenIds = new Set(store.ads.map(a => a.id));
  console.log(`📦 ${seenIds.size} ads already stored`);

  // Launch browser
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
  });
  await context.addCookies(cookies);
  const page = await context.newPage();

  // Navigate to Creative Center — CTR sorted
  console.log('🌐 Navigating to Creative Center...');
  await page.goto(
    'https://ads.tiktok.com/business/creativecenter/inspiration/topads/pc/en?period=30&region=US&order_by=ctr',
    { waitUntil: 'domcontentloaded' }
  );

  // Check if still logged in
  const url = page.url();
  if (url.includes('login') || url.includes('i18n/login')) {
    console.error('❌ Session expired — re-run export-cookies.mjs and update TIKTOK_COOKIES secret');
    await browser.close();
    process.exit(1);
  }

  // Scrape the card list
  console.log('📋 Scraping card list...');
  const cards = await scrapeCardList(page);
  console.log(`   Found ${cards.length} cards`);

  const relevantNew = cards.filter(c => isRelevant(c.industry) && !seenIds.has(c.id));
  console.log(`   ${relevantNew.length} relevant & new`);

  // Scrape detail pages for new relevant ads
  const newAds = [];
  for (const card of relevantNew) {
    console.log(`   → Scraping detail: ${card.id} (${card.industry})`);
    try {
      const detail = await scrapeDetail(page, card.id);
      if (!detail.hook) {
        console.log(`     ⚠️  No hook text found, skipping`);
        continue;
      }
      const hookLabel = classifyHook(detail.hook);
      const brand = detail.brand && detail.brand !== '-'
        ? detail.brand
        : (detail.lp ? new URL(detail.lp.startsWith('http') ? detail.lp : 'https://' + detail.lp).hostname.replace('www.', '') : '-');

      newAds.push({
        id: card.id,
        first_seen: new Date().toISOString().split('T')[0],
        hook: detail.hook,
        hook_label: hookLabel,
        industry: detail.industry || card.industry,
        brand,
        lp: detail.lp,
        likes: detail.likes || card.likes,
        ctr: detail.ctr || card.ctr,
        objective: detail.objective || card.objective,
        url: `https://ads.tiktok.com/business/creativecenter/topads/${card.id}`,
      });
    } catch (e) {
      console.warn(`     ⚠️  Failed scraping ${card.id}: ${e.message}`);
    }
  }

  await browser.close();

  // Merge and save
  if (newAds.length > 0) {
    console.log(`\n💾 Saving ${newAds.length} new ads to data/ads.json...`);
    store.ads = [...newAds, ...store.ads]; // newest first
  }
  store.last_run = new Date().toISOString().split('T')[0];
  saveData(store);
  console.log('   ✅ Saved');

  // Summary
  console.log('\n📊 Summary:');
  console.log(`   Cards scraped:  ${cards.length}`);
  console.log(`   Relevant & new: ${relevantNew.length}`);
  console.log(`   Saved:          ${newAds.length}`);
  console.log(`   Total stored:   ${store.ads.length}`);

  const ragebait = newAds.filter(a => ['RAGEBAIT', 'PAIN_POINT', 'DEMO'].includes(a.hook_label));
  if (ragebait.length > 0) {
    console.log('\n🎯 New high-signal ads:');
    ragebait.forEach(a => console.log(`   [${a.hook_label}] "${a.hook}" — ${a.brand} (${a.ctr})`));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
