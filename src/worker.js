// Cloudflare Worker for the site.
//   /api/listings  ->  your active eBay listings as JSON (runs here, keys stay secret)
//   /api/contact   ->  the contact form; emails the message to you
//   everything else ->  the static page in /public (served free, the Worker isn't involved)

import { EmailMessage } from 'cloudflare:email';
import { readConfig, fetchSellerData, sellerSearchUrl, feedbackProfileUrl, ConfigError } from '../lib/ebay.js';
import { readSubmission, buildEmail, toMime, ContactError } from '../lib/contact.js';

const FRESH_SECONDS = 900;          // refresh from eBay at most every 15 minutes
const STALE_LIMIT_MS = 24 * 3600e3; // if eBay is down, keep showing the last good list for up to a day

// Kept in memory while Cloudflare keeps this Worker warm.
let memo = null;              // { body, savedAt }
const recentSends = new Map(); // visitor IP -> times they used the contact form recently

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/listings') return listings(request, env, ctx);
    if (url.pathname === '/api/contact') return contact(request, env);
    if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404);

    return env.ASSETS.fetch(request);
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

  // 1. This server's own copy, if fresh.
  if (memo && now - memo.savedAt < FRESH_MS) {
    return ok(memo.body, request, memo.savedAt, now, 'memory');
  }

  // 2. The copy shared by Cloudflare's servers in this location, if fresh.
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheKey = new Request(new URL('/api/listings', request.url).toString(), { method: 'GET' });
  let shared = null; // { body, savedAt }
  if (cache) {
    try {
      const hit = await cache.match(cacheKey);
      const savedAt = hit ? Number(hit.headers.get(SAVED_AT)) : 0;
      if (hit && savedAt > 0) shared = { body: await hit.text(), savedAt };
    } catch (err) {
      console.error('[listings] cache read failed', err);
    }
  }
  if (shared && now - shared.savedAt < FRESH_MS) {
    if (!memo || shared.savedAt > memo.savedAt) memo = shared;
    return ok(shared.body, request, shared.savedAt, now, 'shared');
  }

  // 3. Fetch from eBay.
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
    // 4. eBay failed: use the newest copy we have, if it's less than a day old.
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
