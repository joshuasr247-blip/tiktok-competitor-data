/**
 * ugc-scraper.mjs
 * Scans TikTok & Instagram for UGC-style product demo videos
 * (ragebait/pain-point hook → app / extension demo format)
 *
 * Env vars required:
 *   APIFY_API_TOKEN  — from console.apify.com → Settings → Integrations
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

// ── Target hashtags ────────────────────────────────────────────────────────

const TIKTOK_HASHTAGS = [
  'ugccreator',
  'ugccontentcreator',
  'appextension',
  'chromextension',
  'softwarereview',
  'appoftheday',
  'techtok',
  'producttok',
];

const INSTAGRAM_HASHTAGS = [
  'ugccreator',
  'ugccontentcreator',
  'appextension',
  'chromextension',
  'softwarereview',
  'appoftheday',
];

// ── Product-demo signal filters ────────────────────────────────────────────

const PRODUCT_WORDS = /\b(extension|app|tool|plugin|software|chrome|download|free trial|sign[\s-]?up|install)\b/i;
const CTA_PATTERNS  = /link in bio|comment.{0,20}(link|access|code)|dm (me|for)|tap the link|get it (free|here)/i;

const HOOK_PATTERNS = {
  RAGEBAIT:      [/stop (doing|wasting|using)/i, /you'?re doing.*wrong/i, /nobody tells you/i, /they don'?t want/i, /unpopular opinion/i, /biggest mistake/i, /most people don'?t/i],
  PAIN_POINT:    [/tired of/i, /struggling with/i, /sick of/i, /frustrated/i, /worst part/i, /stop losing/i, /why (is|does) .* so hard/i],
  CURIOSITY_GAP: [/you won'?t believe/i, /secret (to|that)/i, /this one (thing|trick|hack)/i, /wait until you see/i, /here'?s what/i],
  DEMO:          [/let me show/i, /watch (me|this|how)/i, /here'?s how/i, /step by step/i, /how to use/i, /before (and|&) after/i],
};

function classifyHook(text = '') {
  for (const [label, patterns] of Object.entries(HOOK_PATTERNS)) {
    if (patterns.some(p => p.test(text))) return label;
  }
  return 'OTHER';
}

function hasProductSignal(caption = '') {
  return PRODUCT_WORDS.test(caption) || CTA_PATTERNS.test(caption);
}

// ── Generic Apify actor runner ─────────────────────────────────────────────

async function runActor(actorId, input, timeoutMs = 5 * 60 * 1000) {
  const startRes = await fetch(
    `https://api.apify.com/v2/acts/${actorId}/runs`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${APIFY_TOKEN}`,
      },
      body: JSON.stringify(input),
    }
  );

  if (!startRes.ok) {
    const err = await startRes.text();
    throw new Error(err);
  }

  const { data: run } = await startRes.json();
  const runId = run.id;

  // Poll until finished
  const deadline = Date.now() + timeoutMs;
  let status = run.status;

  while (!['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) {
    if (Date.now() > deadline) throw new Error(`Run ${runId} timed out`);
    await new Promise(r => setTimeout(r, 6000));
    const poll = await fetch(
      `https://api.apify.com/v2/actor-runs/${runId}`,
      { headers: { 'Authorization': `Bearer ${APIFY_TOKEN}` } }
    );
    ({ data: { status } } = await poll.json());
  }

  if (status !== 'SUCCEEDED') throw new Error(`Run ended with status: ${status}`);

  const itemsRes = await fetch(
    `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?format=json`,
    { headers: { 'Authorization': `Bearer ${APIFY_TOKEN}` } }
  );

  if (!itemsRes.ok) throw new Error(`Failed to fetch dataset: ${await itemsRes.text()}`);
  return itemsRes.json();
}

// ── TikTok ─────────────────────────────────────────────────────────────────

async function scrapeTikTok() {
  console.log('\n📱  TikTok…');
  const results = [];

  for (const hashtag of TIKTOK_HASHTAGS) {
    console.log(`  → #${hashtag}`);
    try {
      const items = await runActor('clockworks~tiktok-scraper', {
        hashtags: [hashtag],
        resultsPerPage: 30,
      });
      console.log(`    ✓ ${items.length} videos`);
      results.push(...items.map(v => transformTikTok(v, hashtag)));
    } catch (e) {
      console.log(`    ERR: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 1500));
  }

  return results;
}

function transformTikTok(v, sourceHashtag) {
  const caption  = v.text ?? v.desc ?? v.description ?? '';
  const hookLine = caption.split(/[.!?\n]/)[0].trim().slice(0, 200);
  const author   = v.authorMeta?.name ?? v.author?.uniqueId ?? v.author ?? '';
  return {
    id:          `tt_${v.id ?? v.videoId ?? String(Math.random())}`,
    platform:    'tiktok',
    url:         v.webVideoUrl ?? `https://www.tiktok.com/@${author}/video/${v.id}`,
    caption:     caption.slice(0, 600),
    hook:        hookLine,
    hook_label:  classifyHook(hookLine),
    has_product: hasProductSignal(caption),
    author,
    views:       v.playCount   ?? v.stats?.playCount   ?? null,
    likes:       v.diggCount   ?? v.stats?.diggCount   ?? null,
    comments:    v.commentCount ?? v.stats?.commentCount ?? null,
    shares:      v.shareCount  ?? v.stats?.shareCount  ?? null,
    thumbnail:   v.covers?.default ?? v.cover ?? '',
    hashtags:    (v.hashtags ?? []).map(h => h.name ?? h).filter(Boolean).concat([sourceHashtag]),
    created_at:  v.createTime ? new Date(v.createTime * 1000).toISOString().slice(0, 10) : null,
    scraped_at:  new Date().toISOString().slice(0, 10),
  };
}

// ── Instagram ──────────────────────────────────────────────────────────────

async function scrapeInstagram() {
  console.log('\n📸  Instagram…');
  const results = [];

  for (const hashtag of INSTAGRAM_HASHTAGS) {
    console.log(`  → #${hashtag}`);
    try {
      const items = await runActor('apify~instagram-scraper', {
        hashtags: [hashtag],
        resultsLimit: 30,
        resultsType: 'posts',
      });
      console.log(`    ✓ ${items.length} posts`);
      results.push(...items.map(v => transformInstagram(v, hashtag)));
    } catch (e) {
      console.log(`    ERR: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 1500));
  }

  return results;
}

function transformInstagram(v, sourceHashtag) {
  const caption  = v.caption ?? v.text ?? '';
  const hookLine = caption.split(/[.!?\n]/)[0].trim().slice(0, 200);
  return {
    id:          `ig_${v.id ?? v.shortCode ?? String(Math.random())}`,
    platform:    'instagram',
    url:         v.url ?? `https://www.instagram.com/p/${v.shortCode}/`,
    caption:     caption.slice(0, 600),
    hook:        hookLine,
    hook_label:  classifyHook(hookLine),
    has_product: hasProductSignal(caption),
    author:      v.ownerUsername ?? v.username ?? '',
    views:       v.videoViewCount ?? null,
    likes:       v.likesCount ?? v.likes ?? null,
    comments:    v.commentsCount ?? v.comments ?? null,
    shares:      null,
    thumbnail:   v.displayUrl ?? v.thumbnailUrl ?? '',
    hashtags:    (v.hashtags ?? [sourceHashtag]),
    created_at:  v.timestamp ? v.timestamp.slice(0, 10) : null,
    scraped_at:  new Date().toISOString().slice(0, 10),
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
  console.log('🔍  Scanning TikTok & Instagram for UGC product demo content…');

  // Run platforms in parallel
  const [ttResult, igResult] = await Promise.allSettled([
    scrapeTikTok(),
    scrapeInstagram(),
  ]);

  const fresh = [
    ...(ttResult.status === 'fulfilled' ? ttResult.value : []),
    ...(igResult.status === 'fulfilled' ? igResult.value : []),
  ];

  // Deduplicate by id
  const seen   = new Set();
  const unique = fresh.filter(v => {
    if (seen.has(v.id)) return false;
    seen.add(v.id);
    return true;
  });

  // Keep only content with a product signal OR a recognised hook
  const filtered = unique.filter(v => v.has_product || v.hook_label !== 'OTHER');

  // Merge with existing (preserves history across runs)
  const existing = loadData();
  const map = new Map(existing.ads.map(a => [a.id, a]));
  for (const v of filtered) map.set(v.id, v);

  const merged = [...map.values()]
    .sort((a, b) => (b.views ?? 0) - (a.views ?? 0));

  const today = new Date().toISOString().slice(0, 10);
  saveData({ last_run: today, ads: merged });

  console.log(`\n✅  Done — ${merged.length} total | ${filtered.length} new kept | ${unique.length - filtered.length} filtered out`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
