/**
 * meta-scraper.mjs
 * Pulls competitor ads from Meta Ad Library via Apify actor.
 * No Meta account or identity verification needed.
 *
 * Env vars required:
 *   APIFY_API_TOKEN  — from apify.com → Settings → Integrations
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, '../data/ads.json');

const APIFY_TOKEN = process.env.APIFY_API_TOKEN;

if (!APIFY_TOKEN) {
  console.error('❌  APIFY_API_TOKEN must be set');
  process.exit(1);
}

// Actor: https://apify.com/apify/facebook-ads-library-scraper
const ACTOR_ID = 'apify~facebook-ads-scraper';

// ── Hook classifier ────────────────────────────────────────────────────────

const HOOK_PATTERNS = {
  RAGEBAIT:      [/stop wasting/i, /you'?re doing.*wrong/i, /nobody tells you/i, /they don'?t want/i, /unpopular opinion/i, /this is why.*fail/i, /most people don'?t/i, /biggest mistake/i],
  PAIN_POINT:    [/tired of/i, /struggling with/i, /sick of/i, /frustrated/i, /hate when/i, /worst part/i, /the problem with/i, /can'?t stand/i, /stop losing/i, /why (is|does) .* so hard/i],
  CURIOSITY_GAP: [/you won'?t believe/i, /secret (to|that)/i, /this one (thing|trick|hack)/i, /what they don'?t tell/i, /wait until you see/i, /\?.*\?/i, /here'?s what/i],
  DEMO:          [/let me show/i, /watch (me|this|how)/i, /here'?s how/i, /step by step/i, /tutorial/i, /how to use/i, /swipe to see/i, /before (and|&) after/i],
};

function classifyHook(text = '') {
  for (const [label, patterns] of Object.entries(HOOK_PATTERNS)) {
    if (patterns.some(p => p.test(text))) return label;
  }
  return 'OTHER';
}

// ── Search queries ─────────────────────────────────────────────────────────

const SEARCH_QUERIES = [
  'stop wasting',
  'you are doing it wrong',
  'nobody tells you',
  'tired of',
  'let me show you',
  'this changed everything',
  'why I switched',
  'honest review',
  'watch this before',
  'the real reason',
  "most people don't know",
];

// ── Apify actor call ───────────────────────────────────────────────────────

async function fetchAdsForQuery(searchTerm) {
  console.log(`  → "${searchTerm}" …`);

  // Start the actor run
  const startRes = await fetch(
    `https://api.apify.com/v2/acts/${ACTOR_ID}/runs`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${APIFY_TOKEN}`,
      },
      body: JSON.stringify({
        startUrls: [
          {
            url: `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=US&q=${encodeURIComponent(searchTerm)}&search_type=keyword_unordered`,
          },
        ],
        maxItems: 50,
      }),
    }
  );

  if (!startRes.ok) {
    const err = await startRes.text();
    console.log(`  ERR starting run: ${err}`);
    return [];
  }

  const { data: run } = await startRes.json();
  const runId = run.id;

  // Poll until finished (max 3 min)
  const deadline = Date.now() + 3 * 60 * 1000;
  let status = run.status;

  while (!['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) {
    if (Date.now() > deadline) {
      console.log(`  ⚠️  Timed out waiting for run ${runId}`);
      return [];
    }
    await new Promise(r => setTimeout(r, 5000));
    const statusRes = await fetch(
      `https://api.apify.com/v2/actor-runs/${runId}`,
      { headers: { 'Authorization': `Bearer ${APIFY_TOKEN}` } }
    );
    const { data: runData } = await statusRes.json();
    status = runData.status;
  }

  if (status !== 'SUCCEEDED') {
    console.log(`  ⚠️  Run ${runId} ended with status: ${status}`);
    return [];
  }

  // Fetch dataset items
  const itemsRes = await fetch(
    `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?format=json`,
    { headers: { 'Authorization': `Bearer ${APIFY_TOKEN}` } }
  );

  if (!itemsRes.ok) {
    console.log(`  ERR fetching items: ${await itemsRes.text()}`);
    return [];
  }

  const items = await itemsRes.json();
  console.log(`  ✓ ${items.length} ads`);
  return items;
}

// ── Transform Apify ad → our schema ───────────────────────────────────────

function transformAd(ad) {
  // Apify's facebook-ads-library-scraper field names
  const body  = ad.bodyText ?? ad.adCardBodyText ?? ad.ad_creative_bodies?.[0] ?? '';
  const title = ad.title ?? ad.adCardTitle ?? ad.ad_creative_link_titles?.[0] ?? '';
  const hookText = body || title;
  const hookLine  = hookText.split(/[.!?\n]/)[0].trim().slice(0, 200);
  const hookLabel = classifyHook(hookLine);

  // Impressions / spend may come as strings or objects
  const impRaw = ad.impressions ?? ad.impressionsBound;
  const impressions = typeof impRaw === 'string'
    ? impRaw
    : (impRaw?.lower_bound
        ? `${Number(impRaw.lower_bound).toLocaleString()}–${Number(impRaw.upper_bound ?? impRaw.lower_bound).toLocaleString()}`
        : null);

  const spendRaw = ad.spend ?? ad.spendBound;
  const spend = typeof spendRaw === 'string'
    ? spendRaw
    : (spendRaw?.lower_bound ? `$${Number(spendRaw.lower_bound).toLocaleString()}+` : null);

  return {
    id:           ad.id ?? ad.adArchiveId ?? ad.adId ?? String(Math.random()),
    first_seen:   (ad.startDate ?? ad.adDeliveryStartTime ?? ad.ad_delivery_start_time ?? '').slice(0, 10) || null,
    last_seen:    (ad.endDate ?? ad.adDeliveryStopTime ?? ad.ad_delivery_stop_time ?? '').slice(0, 10) || null,
    active:       !(ad.endDate ?? ad.adDeliveryStopTime ?? ad.ad_delivery_stop_time),
    hook:         hookLine || body.slice(0, 120),
    hook_label:   hookLabel,
    body:         body.slice(0, 600),
    title:        title,
    brand:        ad.pageName ?? ad.page_name ?? '',
    page_id:      ad.pageId ?? ad.page_id ?? '',
    platforms:    ad.publisherPlatforms ?? ad.publisher_platforms ?? [],
    impressions,
    spend,
    snapshot_url: ad.adSnapshotUrl ?? ad.ad_snapshot_url ?? ad.snapshotUrl ?? '',
    languages:    ad.languages ?? [],
  };
}

// ── File I/O ───────────────────────────────────────────────────────────────

function loadData() {
  try   { return JSON.parse(readFileSync(DATA_PATH, 'utf8')); }
  catch { return { last_run: null, ads: [] }; }
}

function saveData(data) {
  mkdirSync(dirname(DATA_PATH), { recursive: true });
  writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('🔍  Fetching Meta Ad Library data via Apify…');

  const allRaw = [];
  for (const query of SEARCH_QUERIES) {
    try {
      const ads = await fetchAdsForQuery(query);
      allRaw.push(...ads);
    } catch (e) {
      console.log(`  ERR: ${e.message}`);
    }
    // Brief pause between runs
    await new Promise(r => setTimeout(r, 1000));
  }

  // Deduplicate by id
  const seen   = new Set();
  const unique = allRaw.filter(a => {
    const key = a.id ?? a.adArchiveId;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const fresh = unique.map(transformAd);

  // Merge with existing (keep history, update changed records)
  const existing    = loadData();
  const existingMap = new Map(existing.ads.map(a => [a.id, a]));
  for (const ad of fresh) existingMap.set(ad.id, ad);

  const merged = [...existingMap.values()]
    .sort((a, b) => (b.first_seen ?? '').localeCompare(a.first_seen ?? ''));

  const today = new Date().toISOString().slice(0, 10);
  saveData({ last_run: today, ads: merged });

  console.log(`\n✅  Done — ${merged.length} total ads (${fresh.length} from this run)`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
