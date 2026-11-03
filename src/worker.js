// Cloudflare Worker for the site.
//   /api/listings  ->  your active eBay listings as JSON (runs here, keys stay secret)
//   /api/whatnot   ->  your next Whatnot shows, and whether you're live right now
//   /api/contact   ->  the contact form; emails the message to you
//   everything else ->  the static page in /public (served free, the Worker isn't involved)

import { EmailMessage } from 'cloudflare:email';
import { readConfig, fetchSellerData, sellerSearchUrl, feedbackProfileUrl, ConfigError } from '../lib/ebay.js';
import { readSubmission, buildEmail, toMime, ContactError } from '../lib/contact.js';
import { whatnotToken, fetchSchedule, refreshStats, summarizeStats, refreshOrderStats, orderSales } from '../lib/whatnot.js';

const FRESH_SECONDS = 900;          // refresh from eBay at most every 15 minutes
const STALE_LIMIT_MS = 24 * 3600e3; // if eBay is down, keep showing the last good list for up to a day

// Kept in memory while Cloudflare keeps this Worker warm.
let memo = null;              // { body, savedAt }
const recentSends = new Map(); // visitor IP -> times they used the contact form recently

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/listings') return listings(request, env, ctx);
    if (url.pathname === '/api/whatnot') return whatnot(request, env, ctx);
    if (url.pathname === '/api/contact') return contact(request, env);
    if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404);

    return env.ASSETS.fetch(request);
  },

  // Runs on the schedule in wrangler.jsonc ("triggers"): keeps the lifetime Whatnot stats current.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(updateWhatnotStats(env).catch((err) => console.error('[whatnot stats]', err)));
  },
};

// ---------- Contact form ----------

const NOT_SET_UP = "The contact form isn't set up yet. Message me on X or Instagram instead.";
const SEND_FAILED = "Your message couldn't be sent right now. Message me on X or Instagram instead.";

async function contact(request, env) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, { Allow: 'POST' });

  // Only accept submissions from this site's own page.
  const origin = request.headers.get('Origin');
  if (origin && new URL(origin).host !== new URL(request.url).host) {
    return json({ error: 'Not allowed' }, 403);
  }

  if (!env.CONTACT_EMAIL || !env.CONTACT_FROM || !env.CONTACT_TO) {
    return json({ error: NOT_SET_UP, code: 'not_configured' }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Something went wrong with the form. Please try again.' }, 400);
  }

  try {
    const submission = readSubmission(body);
    if (submission.isBot) return json({ ok: true }); // looks like spam: accept quietly, send nothing

    // Soft limit: 5 messages per visitor per 10 minutes (per Worker instance).
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const now = Date.now();
    const times = (recentSends.get(ip) || []).filter((t) => now - t < 10 * 60e3);
    if (times.length >= 5) {
      return json({ error: "That's a lot of messages in a row. Please try again in a few minutes." }, 429);
    }
    if (recentSends.size > 5000) recentSends.clear();
    recentSends.set(ip, [...times, now]);

    const mail = buildEmail(submission, { siteHost: new URL(request.url).host, now: new Date(now) });
    const raw = toMime({
      from: env.CONTACT_FROM,
      fromName: 'TerpCards site',
      to: env.CONTACT_TO,
      replyTo: mail.replyTo,
      subject: mail.subject,
      text: mail.text,
      date: new Date(now),
    });
    await env.CONTACT_EMAIL.send(new EmailMessage(env.CONTACT_FROM, env.CONTACT_TO, raw));
    return json({ ok: true });
  } catch (err) {
    if (err instanceof ContactError) return json({ error: err.publicMessage }, err.status);
    console.error('[contact]', err);
    return json({ error: SEND_FAILED }, 502);
  }
}

// ---------- eBay listings ----------
// Every saved copy carries the time it was fetched from eBay (X-Listings-Saved-At), and that
// time decides whether it's fresh. Cache expiry is never trusted on its own.

const FRESH_MS = FRESH_SECONDS * 1000;
const SAVED_AT = 'X-Listings-Saved-At';

async function listings(request, env, ctx) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: 'Method not allowed' }, 405, { Allow: 'GET, HEAD' });
  }

  const now = Date.now();

  // 1. The newest saved copy: this server's own, or the one shared by Cloudflare's servers in
  //    this location, whichever was fetched from eBay more recently. Checking both every time
  //    means a reload can't land on a server with an older copy and lose your newest listings.
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheKey = new Request(new URL('/api/listings', request.url).toString(), { method: 'GET' });
  let shared = null; // { body, savedAt }, only read when it's newer than this server's copy
  if (cache) {
    try {
      const hit = await cache.match(cacheKey);
      const savedAt = hit ? Number(hit.headers.get(SAVED_AT)) : 0;
      if (hit && savedAt > 0 && (!memo || savedAt > memo.savedAt)) shared = { body: await hit.text(), savedAt };
    } catch (err) {
      console.error('[listings] cache read failed', err);
    }
  }
  if (shared) memo = shared;
  if (memo && now - memo.savedAt < FRESH_MS) {
    return ok(memo.body, request, memo.savedAt, now, shared ? 'shared' : 'memory');
  }

  // 2. Nothing fresh enough: ask eBay (below).

  // Fetch from eBay.
  try {
    const cfg = readConfig(env);
    const { items, feedback } = await fetchSellerData(cfg);
    const body = JSON.stringify({
      seller: cfg.seller,
      sellerUrl: sellerSearchUrl(cfg.seller),
      feedback: feedback ? { ...feedback, url: feedbackProfileUrl(cfg.seller) } : null,
      updatedAt: new Date(now).toISOString(),
      count: items.length,
      items,
    });
    memo = { body, savedAt: now };
    if (cache) {
      // Kept for a day so it can stand in during an eBay outage; freshness is checked by time above.
      const copy = new Response(body, {
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, s-maxage=86400', [SAVED_AT]: String(now) },
      });
      ctx.waitUntil(cache.put(cacheKey, copy).catch((err) => console.error('[listings] cache write failed', err)));
    }
    return ok(body, request, now, now, 'ebay');
  } catch (err) {
    console.error('[listings]', err);
    // eBay failed: use the newest copy we have, if it's less than a day old.
    const backup = [memo, shared].filter(Boolean).sort((a, b) => b.savedAt - a.savedAt)[0];
    if (backup && now - backup.savedAt < STALE_LIMIT_MS) {
      return ok(backup.body, request, backup.savedAt, now, 'backup', { 'X-Listings-Stale': '1' });
    }
    const status = err instanceof ConfigError ? 500 : 502;
    return json(
      { error: err.publicMessage || 'Could not load listings right now.' },
      status,
      { 'Cache-Control': 'no-store' }
    );
  }
}

// ---------- Whatnot schedule ----------
// Checked at most once a minute per Cloudflare location, so "live now" shows up quickly.
// If Whatnot can't be reached, the last good copy is used for up to a day (marked stale,
// so the page uses it for the schedule but doesn't claim you're live).

const WHATNOT_FRESH_MS = 60 * 1000;
let whatnotMemo = null; // { body, savedAt }

async function whatnot(request, env, ctx) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: 'Method not allowed' }, 405, { Allow: 'GET, HEAD' });
  }
  const token = whatnotToken(env);
  if (!token) return json({ error: 'not_configured' }, 503, { 'Cache-Control': 'no-store' });

  const now = Date.now();
  if (whatnotMemo && now - whatnotMemo.savedAt < WHATNOT_FRESH_MS) {
    return ok(whatnotMemo.body, request, whatnotMemo.savedAt, now, 'memory');
  }

  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheKey = new Request(new URL('/api/whatnot', request.url).toString(), { method: 'GET' });
  let shared = null;
  if (cache) {
    try {
      const hit = await cache.match(cacheKey);
      const savedAt = hit ? Number(hit.headers.get(SAVED_AT)) : 0;
      if (hit && savedAt > 0) shared = { body: await hit.text(), savedAt };
    } catch (err) {
      console.error('[whatnot] cache read failed', err);
    }
  }
  if (shared && now - shared.savedAt < WHATNOT_FRESH_MS) {
    if (!whatnotMemo || shared.savedAt > whatnotMemo.savedAt) whatnotMemo = shared;
    return ok(shared.body, request, shared.savedAt, now, 'shared');
  }

  try {
    const [schedule, stats] = await Promise.all([fetchSchedule(token, { now }), readWhatnotStats(env, ctx)]);
    const body = JSON.stringify({ ...schedule, stats, updatedAt: new Date(now).toISOString() });
    whatnotMemo = { body, savedAt: now };
    if (cache) {
      const copy = new Response(body, {
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, s-maxage=86400', [SAVED_AT]: String(now) },
      });
      ctx.waitUntil(cache.put(cacheKey, copy).catch((err) => console.error('[whatnot] cache write failed', err)));
    }
    return ok(body, request, now, now, 'whatnot');
  } catch (err) {
    console.error('[whatnot]', err);
    const backup = [whatnotMemo, shared].filter(Boolean).sort((a, b) => b.savedAt - a.savedAt)[0];
    if (backup && now - backup.savedAt < STALE_LIMIT_MS) {
      return ok(backup.body, request, backup.savedAt, now, 'backup', { 'X-Listings-Stale': '1' });
    }
    return json({ error: 'Could not reach Whatnot right now.' }, 502, { 'Cache-Control': 'no-store' });
  }
}

// ---------- Lifetime Whatnot stats ----------
// Saved in Cloudflare KV (the WHATNOT_STATS binding in wrangler.jsonc) and brought up to
// date by the scheduled run:
//   sales  - counted from your orders (back to your first show), see lib/whatnot.js
//   rating - the average of each show's viewer rating, from Whatnot's show stats
// The first count takes a few runs; each stat appears once it's fully counted.

const RATING_KEY = 'whatnot-stats';
const SALES_KEY = 'whatnot-orders';
let statsKickedAt = 0;

async function updateWhatnotStats(env) {
  const token = whatnotToken(env);
  if (!token || !env.WHATNOT_STATS) return;
  const kv = env.WHATNOT_STATS;
  // Kept under 50 calls in total, the per-run limit on Cloudflare's free plan.
  const [savedSales, savedRating] = await Promise.all([kv.get(SALES_KEY, 'json'), kv.get(RATING_KEY, 'json')]);
  const sales = await refreshOrderStats(token, savedSales, { maxRequests: 24 });
  await kv.put(SALES_KEY, JSON.stringify(sales));
  const rating = await refreshStats(token, savedRating, { maxRequests: 12 });
  await kv.put(RATING_KEY, JSON.stringify(rating));
  console.log(`[whatnot stats] sales ${orderSales(sales) ?? 'still counting'}, rating ${summarizeStats(rating).rating ?? '-'} (${Object.keys(rating.shows).length}/${rating.endedShows} shows checked)`);
}

// What the page shows. A stat stays hidden until it's fully counted, so a half-finished
// first run never shows a low number.
async function readWhatnotStats(env, ctx) {
  if (!env.WHATNOT_STATS) return null;
  let savedSales = null;
  let savedRating = null;
  try {
    [savedSales, savedRating] = await Promise.all([env.WHATNOT_STATS.get(SALES_KEY, 'json'), env.WHATNOT_STATS.get(RATING_KEY, 'json')]);
  } catch (err) {
    console.error('[whatnot stats] read failed', err);
    return null;
  }
  // Not finished yet (or never run): nudge it along now instead of waiting for the next scheduled run.
  if ((!savedSales?.complete || !savedRating?.complete) && Date.now() - statsKickedAt > 10 * 60e3) {
    statsKickedAt = Date.now();
    ctx.waitUntil(updateWhatnotStats(env).catch((err) => console.error('[whatnot stats]', err)));
  }
  const sales = orderSales(savedSales);
  const r = summarizeStats(savedRating);
  const rating = r.complete && r.rating != null ? Math.round(r.rating * 100) / 100 : null;
  if (!(sales > 0) && rating == null) return null;
  return { sales: sales > 0 ? sales : null, rating };
}

// Browsers always come back to the Worker (no-cache); the Worker decides how fresh to be.
// X-Listings-Source and X-Listings-Age say where a copy came from and how old it is.
function ok(body, request, savedAt, now, source, extra = {}) {
  return new Response(request.method === 'HEAD' ? null : body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Listings-Source': source,
      'X-Listings-Age': String(Math.max(0, Math.round((now - savedAt) / 1000))),
      ...extra,
    },
  });
}

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}
