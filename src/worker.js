// Cloudflare Worker for the site.
//   /api/listings  ->  your active eBay listings as JSON (runs here, keys stay secret)
//   /api/ebay/connect, /api/ebay/callback -> the one-time eBay sign-in (see README)
//   /api/whatnot   ->  your next Whatnot shows, and whether you're live right now
//   /api/contact   ->  the contact form; emails the message to you
//   everything else ->  the static page in /public (served free, the Worker isn't involved)

import { EmailMessage } from 'cloudflare:email';
import { readConfig, fetchSellerData, checkListings, fetchItemsByLegacyId, sellerSearchUrl, feedbackProfileUrl, ConfigError } from '../lib/ebay.js';
import { signInUrl, finishSignIn, accountUsername, activeListings, withAccount, AccountError } from '../lib/ebay-account.js';
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
    if (url.pathname === '/api/ebay/connect') return ebayConnect(request, env);
    if (url.pathname === '/api/ebay/callback') return ebayCallback(request, env);
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
const LISTINGS_VERSION = 2; // 2: calculated shipping left out of direct lookups too

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
    const fetched = await fetchSellerData(cfg);
    // With your eBay account connected, your account's own list decides what's for sale;
    // otherwise, cards eBay's search drops are checked one by one.
    const account = await readAccountListings(env, cfg, now);
    const { items, held } = account
      ? await mergeWithAccount(cfg, fetched.items, account, memo, now)
      : await holdOnToMissing(cfg, fetched.items, memo, now);
    // Popularity comes only from the account; cards carried over from an earlier copy drop it.
    if (!account) for (const i of items) delete i.popular;
    const feedback = fetched.feedback;
    const body = JSON.stringify({
      version: LISTINGS_VERSION,
      seller: cfg.seller,
      sellerUrl: sellerSearchUrl(cfg.seller),
      feedback: feedback ? { ...feedback, url: feedbackProfileUrl(cfg.seller) } : null,
      updatedAt: new Date(now).toISOString(),
      count: items.length,
      items,
      held, // cards eBay's search left out but that are still for sale: id -> when they went missing
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

// eBay's search sometimes leaves out listings that are still for sale, especially while you're
// listing or editing. Any card from the last saved copy that's missing now is looked up on its
// own: it stays if it's still for sale and comes off once eBay says it sold or ended.
const MAX_LOOKUPS = 25;               // per refresh, to stay well inside Cloudflare's limits
const HOLD_UNCONFIRMED_MS = 6 * 3600e3; // if eBay won't say either way, keep a card at most 6 hours

async function holdOnToMissing(cfg, items, previous, now) {
  let before;
  try {
    before = previous ? JSON.parse(previous.body) : null;
  } catch {
    before = null;
  }
  const have = new Set(items.map((i) => i.id));
  const missing = (before?.items || []).filter(
    (i) => !have.has(i.id) && !(i.isAuction && i.endsAt && Date.parse(i.endsAt) <= now) // ended auctions just go
  );
  if (!missing.length) return { items, held: {} };

  const status = await checkListings(cfg, missing.slice(0, MAX_LOOKUPS).map((i) => i.id), { now }).catch(() => new Map());
  const heldBefore = before.held || {};
  const kept = [];
  const held = {};
  for (const item of missing) {
    const since = heldBefore[item.id] || now;
    const state = status.get(item.id) || 'unknown';
    if (state === 'gone') continue;
    if (state === 'unknown' && now - since > HOLD_UNCONFIRMED_MS) continue;
    kept.push(item);
    held[item.id] = since;
  }
  if (kept.length) console.log(`[listings] kept ${kept.length} card(s) eBay's search left out, still for sale`);
  const newest = (a, b) => (Date.parse(b.listedAt || 0) || 0) - (Date.parse(a.listedAt || 0) || 0);
  return { items: [...items, ...kept].sort(newest), held };
}

// ---------- Your eBay account (optional, one-time sign-in) ----------
// Saved in the same Cloudflare KV storage as the Whatnot stats (the WHATNOT_STATS binding).

const ACCOUNT_KEY = 'ebay-account';
const STATE_PREFIX = 'ebay-signin-state:';
const RENEW_WARNING_MS = 30 * 864e5; // email you a month before the sign-in runs out

function page(title, message, status = 200) {
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>` +
      `<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#121417;color:#F2F4F6;font:17px/1.5 system-ui,sans-serif}main{max-width:34rem;padding:2rem}h1{font-size:1.6rem;margin:0 0 .5rem}a{color:#fff}</style></head>` +
      `<body><main><h1>${esc(title)}</h1><p>${esc(message)}</p><p><a href="/">Back to the site</a></p></main></body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }
  );
}

// Step 1: send you to eBay to approve. Anyone can open this link, but the sign-in is only saved
// if it's the eBay account in EBAY_SELLER (checked in step 2).
async function ebayConnect(request, env) {
  let cfg;
  try {
    cfg = readConfig(env);
  } catch {
    return page('eBay keys missing', 'Add your eBay keys in Cloudflare first (README step 4).', 500);
  }
  const runame = (env.EBAY_RUNAME || '').trim();
  if (!runame) return page('Almost there', 'Add your eBay RuName to EBAY_RUNAME in wrangler.jsonc, push, then open this link again.', 500);
  if (!env.WHATNOT_STATS) return page('Storage missing', 'The site needs its Cloudflare KV storage (the WHATNOT_STATS binding in wrangler.jsonc).', 500);
  const state = crypto.randomUUID();
  await env.WHATNOT_STATS.put(STATE_PREFIX + state, '1', { expirationTtl: 600 });
  return Response.redirect(signInUrl(cfg, runame, state), 302);
}

// Step 2: eBay sends you back here after you approve (or decline).
async function ebayCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state') || '';
  if (!code) return page('Not connected', 'eBay sign-in was cancelled, so nothing changed. You can try again any time.');
  if (!env.WHATNOT_STATS || !(await env.WHATNOT_STATS.get(STATE_PREFIX + state))) {
    return page('Link expired', 'That sign-in link expired or was already used. Open /api/ebay/connect again.', 400);
  }
  await env.WHATNOT_STATS.delete(STATE_PREFIX + state);
  try {
    const cfg = readConfig(env);
    const account = await finishSignIn(cfg, (env.EBAY_RUNAME || '').trim(), code);
    const user = await accountUsername(account.accessToken);
    if (!user || user.toLowerCase() !== cfg.seller.toLowerCase()) {
      return page('Wrong eBay account', `You signed in as ${user || 'an unknown account'}, but this site is set up for ${cfg.seller}. Nothing was saved.`, 403);
    }
    await env.WHATNOT_STATS.put(ACCOUNT_KEY, JSON.stringify({ ...account, user }));
    memo = null; // use the account on the next listings refresh
    return page('eBay connected', `The site now reads your listings straight from your ${user} account. It shows up within 15 minutes, and the "Most popular" sort appears once it does.`);
  } catch (err) {
    console.error('[ebay sign-in]', err);
    return page('Something went wrong', "eBay didn't finish the sign-in. Try /api/ebay/connect again in a minute.", 502);
  }
}

// Your active listings and their watcher counts, or null if the account isn't connected or eBay didn't answer.
async function readAccountListings(env, cfg, now) {
  if (!env.WHATNOT_STATS) return null;
  let saved;
  try {
    saved = await env.WHATNOT_STATS.get(ACCOUNT_KEY, 'json');
  } catch {
    return null;
  }
  if (!saved || !saved.refreshToken || saved.broken) return null;
  try {
    const { result, account, changed } = await withAccount(cfg, saved, (token) => activeListings(token), { now });
    if (changed) await env.WHATNOT_STATS.put(ACCOUNT_KEY, JSON.stringify(account));
    if (account.refreshExpiresAt && account.refreshExpiresAt - now < RENEW_WARNING_MS) {
      await alertOnce(env, 'ebay-renew', 'TerpCards site: renew the eBay sign-in',
        `The site's eBay sign-in runs out on ${new Date(account.refreshExpiresAt).toDateString()}. Open https://terp.cards/api/ebay/connect and sign in again to keep the "Most popular" sort and the account listing check working.`);
    }
    return result.complete ? result : null;
  } catch (err) {
    console.error('[ebay account]', err);
    if (err instanceof AccountError && err.needsSignIn) {
      await env.WHATNOT_STATS.put(ACCOUNT_KEY, JSON.stringify({ ...saved, broken: err.message }));
      await alertOnce(env, 'ebay-signin', 'TerpCards site: sign in to eBay again',
        `The site's eBay sign-in stopped working (${err.message}). Open https://terp.cards/api/ebay/connect and sign in again. Until then, listings still show, without the "Most popular" sort.`);
    }
    return null;
  }
}

// Search results, corrected by your account's own list:
//   - anything not in your account's active list is dropped (it sold or ended)
//   - anything in your account but missing from search is added, from the last saved copy or
//     looked up by its listing number
//   - each card gets a "popular" position (1 = most watched); the watcher counts themselves stay here
async function mergeWithAccount(cfg, searchItems, account, previous, now) {
  const legacyId = (id) => String(id).split('|')[1] || String(id);
  const watch = account.watch;
  const fromSearch = searchItems.filter((i) => watch.has(legacyId(i.id)));
  const have = new Set(fromSearch.map((i) => legacyId(i.id)));

  let before = [];
  try {
    // Copies saved before the shipping fix may carry estimated shipping; those cards are looked up again.
    const body = previous ? JSON.parse(previous.body) : null;
    before = body && body.version >= LISTINGS_VERSION ? body.items || [] : [];
  } catch {}
  const earlier = new Map(before.map((i) => [legacyId(i.id), i]));
  const added = [];
  const lookup = [];
  for (const id of watch.keys()) {
    if (have.has(id)) continue;
    const prev = earlier.get(id);
    if (prev && !(prev.isAuction && prev.endsAt && Date.parse(prev.endsAt) <= now)) added.push(prev);
    else lookup.push(id);
  }
  added.push(...(await fetchItemsByLegacyId(cfg, lookup.slice(0, MAX_LOOKUPS), { now })));

  const newest = (a, b) => (Date.parse(b.listedAt || 0) || 0) - (Date.parse(a.listedAt || 0) || 0);
  const items = [...fromSearch, ...added].map((i) => ({ ...i })).sort(newest);
  const watchers = (i) => watch.get(legacyId(i.id)) || 0;
  [...items].sort((a, b) => watchers(b) - watchers(a) || newest(a, b)).forEach((i, n) => { i.popular = n + 1; });
  if (added.length) console.log(`[listings] added ${added.length} active listing(s) eBay's search left out`);
  return { items, held: {} };
}

// Emails you about something that needs your attention, at most once a week per topic.
async function alertOnce(env, topic, subject, text) {
  try {
    if (!env.WHATNOT_STATS || !env.CONTACT_EMAIL || !env.CONTACT_FROM || !env.CONTACT_TO) return;
    const key = `alert:${topic}`;
    if (await env.WHATNOT_STATS.get(key)) return;
    await env.WHATNOT_STATS.put(key, new Date().toISOString(), { expirationTtl: 7 * 86400 });
    const raw = toMime({ from: env.CONTACT_FROM, fromName: 'TerpCards site', to: env.CONTACT_TO, subject, text });
    await env.CONTACT_EMAIL.send(new EmailMessage(env.CONTACT_FROM, env.CONTACT_TO, raw));
  } catch (err) {
    console.error('[alert]', err);
  }
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
