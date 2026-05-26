/**
 * meta-scraper.mjs
 * Pulls competitor ads from Meta Ad Library API.
 * Uses APP_ID|APP_SECRET as access token — no OAuth, no expiry.
 *
 * Env vars required:
 *   META_APP_ID
 *   META_APP_SECRET
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, '../data/ads.json');

const APP_ID     = process.env.META_APP_ID;
const APP_SECRET = process.env.META_APP_SECRET;

if (!APP_ID || !APP_SECRET) {
  console.error('❌  META_APP_ID and META_APP_SECRET must be set');
  process.exit(1);
}

const ACCESS_TOKEN = `${APP_ID}|${APP_SECRET}`;
const API_VERSION  = 'v21.0';
const BASE_URL     = `https://graph.facebook.com/${API_VERSION}/ads_archive`;

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
// These target ragebait / pain-point / demo UGC ad patterns

const SEARCH_QUERIES = [
  'stop wasting',
  'you are doing it wrong',
  'nobody tells you',
  'tired of',
  'let me show you',
  'this changed everything',
  'why I switched',
  'I tried every',
  'honest review',
  'watch this before',
  'the real reason',
  'most people don\'t know',
];

// Fields we want back from the API
const FIELDS = [
  'id',
  'ad_creation_time',
  'ad_creative_bodies',
  'ad_creative_link_titles',
  'ad_creative_link_descriptions',
  'ad_delivery_start_time',
  'ad_delivery_stop_time',
  'ad_snapshot_url',
  'impressions',
  'spend',
  'page_name',
  'page_id',
  'publisher_platforms',
  'languages',
  'estimated_audience_size',
].join(',');

// ── API fetch ──────────────────────────────────────────────────────────────

async function fetchAdsForQuery(searchTerm) {
  const params = new URLSearchParams({
    search_terms:          searchTerm,
    ad_reached_countries:  '["US"]',
    ad_type:               'ALL',
    fields:                FIELDS,
    limit:                 '100',
    access_token:          ACCESS_TOKEN,
  });

  const ads  = [];
  let url    = `${BASE_URL}?${params}`;
  let pages  = 0;

  while (url && pages < 3) {
    const res = await fetch(url);
    const data = await res.json();

    if (data.error) {
      console.error(`  ⚠️  GraphAPI error for "${searchTerm}": ${JSON.stringify(data.error)}`);
      break;
    }

    ads.push(...(data.data ?? []));
    url = data.paging?.next ?? null;
    pages++;
  }

  return ads;
}

// ── Transform raw Meta ad → our schema ────────────────────────────────────

function transformAd(ad) {
  const body     = ad.ad_creative_bodies?.[0] ?? '';
  const title    = ad.ad_creative_link_titles?.[0] ?? '';
  const hookText = body || title;
  const hookLine = hookText.split(/[.!?\n]/)[0].trim().slice(0, 200);
  const hookLabel = classifyHook(hookLine);

  const impMin = ad.impressions?.lower_bound;
  const impMax = ad.impressions?.upper_bound;
  const impressions = impMin
    ? `${Number(impMin).toLocaleString()}–${Number(impMax).toLocaleString()}`
    : null;

  const spendMin = ad.spend?.lower_bound;
  const spend = spendMin ? `$${Number(spendMin).toLocaleString()}+` : null;

  return {
    id:           ad.id,
    first_seen:   ad.ad_delivery_start_time?.slice(0, 10) ?? ad.ad_creation_time?.slice(0, 10) ?? null,
    last_seen:    ad.ad_delivery_stop_time?.slice(0, 10) ?? null,
    active:       !ad.ad_delivery_stop_time,
    hook:         hookLine || body.slice(0, 120),
    hook_label:   hookLabel,
    body:         body.slice(0, 600),
    title:        title,
    brand:        ad.page_name ?? '',
    page_id:      ad.page_id ?? '',
    platforms:    ad.publisher_platforms ?? [],
    impressions,
    spend,
    snapshot_url: ad.ad_snapshot_url ?? '',
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
  console.log('🔍  Fetching Meta Ad Library data…');

  const allRaw = [];
  for (const query of SEARCH_QUERIES) {
    process.stdout.write(`  → "${query}" … `);
    try {
      const ads = await fetchAdsForQuery(query);
      console.log(`${ads.length} ads`);
      allRaw.push(...ads);
    } catch (e) {
      console.log(`ERR: ${e.message}`);
    }
    // Courtesy pause to stay well under rate limits
    await new Promise(r => setTimeout(r, 600));
  }

  // Deduplicate by id
  const seen   = new Set();
  const unique = allRaw.filter(a => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });

  const fresh = unique.map(transformAd);

  // Merge with existing ads (keep history, update any changed records)
  const existing   = loadData();
  const existingMap = new Map(existing.ads.map(a => [a.id, a]));
  for (const ad of fresh) existingMap.set(ad.id, ad);

  const merged = [...existingMap.values()]
    .sort((a, b) => (b.first_seen ?? '').localeCompare(a.first_seen ?? ''));

  const today = new Date().toISOString().slice(0, 10);
  saveData({ last_run: today, ads: merged });

  console.log(`\n✅  Done — ${merged.length} total ads (${fresh.length} from this run)`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
