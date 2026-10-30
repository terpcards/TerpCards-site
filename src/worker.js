// Cloudflare Worker for the site.
//   /api/listings  ->  your active eBay listings as JSON (runs here, keys stay secret)
//   /api/contact   ->  the contact form; emails the message to you
//   everything else ->  the static page in /public (served free, the Worker isn't involved)

import { EmailMessage } from 'cloudflare:email';
import { readConfig, fetchSellerListings, sellerSearchUrl, ConfigError } from '../lib/ebay.js';
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

async function listings(request, env, ctx) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: 'Method not allowed' }, 405, { Allow: 'GET, HEAD' });
  }

  const now = Date.now();
  if (memo && now - memo.savedAt < FRESH_SECONDS * 1000) {
    return ok(memo.body, request);
  }

  // Cloudflare's edge cache, shared by every visitor near the same data center.
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheKey = new Request(new URL('/api/listings', request.url).toString(), { method: 'GET' });
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return request.method === 'HEAD' ? new Response(null, hit) : hit;
  }

  try {
    const cfg = readConfig(env);
    const items = await fetchSellerListings(cfg);
    const body = JSON.stringify({
      seller: cfg.seller,
      sellerUrl: sellerSearchUrl(cfg.seller),
      updatedAt: new Date(now).toISOString(),
      count: items.length,
      items,
    });
    memo = { body, savedAt: now };

    const res = ok(body, request);
    if (cache && request.method === 'GET') {
      ctx.waitUntil(cache.put(cacheKey, ok(body, request)));
    }
    return res;
  } catch (err) {
    console.error('[listings]', err);
    if (memo && now - memo.savedAt < STALE_LIMIT_MS) {
      return ok(memo.body, request, { 'X-Listings-Stale': '1' });
    }
    const status = err instanceof ConfigError ? 500 : 502;
    return json(
      { error: err.publicMessage || 'Could not load listings right now.' },
      status,
      { 'Cache-Control': 'no-store' }
    );
  }
}

function ok(body, request, extra = {}) {
  return new Response(request.method === 'HEAD' ? null : body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=60, s-maxage=${FRESH_SECONDS}`,
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
