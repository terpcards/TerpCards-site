// Talks to Whatnot's Seller API with your personal access token (read-only is enough).
// Used by scripts/check-whatnot.mjs, and later by the Worker. Never runs in the browser.

const API_BASE = 'https://api.whatnot.com/seller-api/rest/v2';

export class WhatnotError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'WhatnotError';
    this.status = status;
  }
}

export function whatnotToken(env = globalThis.process?.env ?? {}) {
  return (env.WHATNOT_API_TOKEN || '').trim();
}

export async function whatnotGet(token, path, params = {}, fetchImpl = fetch) {
  if (!token) throw new WhatnotError('WHATNOT_API_TOKEN is not set.', 0);
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) query.set(k, String(v));
  const qs = query.toString();
  const url = `${API_BASE}${path}${qs ? `?${qs}` : ''}`;
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch {}
    throw new WhatnotError(`Whatnot ${path} failed (${res.status}): ${detail}`, res.status);
  }
  return res.json();
}

// Shows with one status: 'scheduled', 'live', 'stopped', 'ended' or 'cancelled'.
// Follows next_cursor for up to maxPages pages.
export async function listShows(token, { status, limit = 50, reverse, maxPages = 1 } = {}, fetchImpl = fetch) {
  const shows = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    const res = await whatnotGet(token, '/shows', { status, limit, reverse, cursor }, fetchImpl);
    shows.push(...(res.data || []));
    cursor = res.next_cursor;
    if (!cursor) return { shows, more: false };
  }
  return { shows, more: Boolean(cursor) };
}

export function showAnalytics(token, showId, fetchImpl = fetch) {
  return whatnotGet(token, `/analytics/shows/${encodeURIComponent(showId)}`, {}, fetchImpl);
}

export function currentUser(token, fetchImpl = fetch) {
  return whatnotGet(token, '/users/me', {}, fetchImpl);
}

// ---------- Show schedule for the site ----------
// Only what the page needs: no dashboard links, sales or other private details.

const STALE_SCHEDULED_MS = 6 * 3600e3; // scheduled shows that never started are dropped after 6 hours

export function publicShow(s) {
  return { id: String(s.id), title: String(s.title || '').trim(), startsAt: s.scheduled_start_at || null };
}

// The show that's live right now (if any) and the next few scheduled shows, soonest first.
export async function fetchSchedule(token, { now = Date.now(), fetchImpl = fetch } = {}) {
  const [live, scheduled] = await Promise.all([
    listShows(token, { status: 'live', limit: 5 }, fetchImpl),
    listShows(token, { status: 'scheduled', reverse: false, limit: 20 }, fetchImpl),
  ]);
  const isPublic = (s) => s && s.visibility !== 'private';
  const liveShow = live.shows.find(isPublic) || null;
  const upcoming = scheduled.shows
    .filter((s) => isPublic(s) && s.scheduled_start_at && Date.parse(s.scheduled_start_at) > now - STALE_SCHEDULED_MS)
    .sort((a, b) => Date.parse(a.scheduled_start_at) - Date.parse(b.scheduled_start_at))
    .slice(0, 4);
  return { live: liveShow ? publicShow(liveShow) : null, upcoming: upcoming.map(publicShow) };
}

// ---------- Lifetime stats ----------
// A show's analytics never change once Whatnot has calculated them, so each show is fetched
// once and kept (in Cloudflare KV, by the Worker). After the first run, only new shows are fetched.

const FINAL_STATUSES = new Set(['GENERATED', 'WILL_NOT_BE_CALCULATED', 'UNAVAILABLE']);
const GIVE_UP_MS = 14 * 864e5; // Whatnot never calculated stats for some older shows; stop asking after 2 weeks

// state: what was saved last time (or null). Makes at most maxRequests calls to Whatnot,
// so a big first run is spread over a few runs.
export async function refreshStats(token, state, { maxRequests = 35, now = Date.now(), fetchImpl = fetch } = {}) {
  const shows = { ...(state?.shows || {}) };
  let used = 0;

  const ended = [];
  let cursor = null;
  // Once every show has been counted, new ones are always on the first page (newest first).
  const maxPages = state?.complete ? 1 : 10;
  do {
    const res = await whatnotGet(token, '/shows', { status: 'ended', limit: 50, cursor }, fetchImpl);
    used++;
    ended.push(...(res.data || []));
    cursor = res.next_cursor;
  } while (cursor && used < maxPages);
  if (state?.complete) cursor = null;

  // Shows never looked at come first, then ones Whatnot was still calculating last time.
  const todo = [...ended.filter((s) => !shows[s.id]), ...ended.filter((s) => shows[s.id] && !FINAL_STATUSES.has(shows[s.id].status))];
  for (const s of todo) {
    if (used >= maxRequests) break;
    used++;
    try {
      const a = await showAnalytics(token, s.id, fetchImpl);
      const endedAt = Date.parse(s.ended_at || s.scheduled_start_at || '') || now;
      const stuck = a.calculation_status === 'PENDING' && now - endedAt > GIVE_UP_MS;
      shows[s.id] = {
        status: stuck ? 'UNAVAILABLE' : a.calculation_status || null,
        start: a.start_time || s.scheduled_start_at || null,
        orders: a.orders_count ?? null,
        giveaways: a.giveaway_orders_count ?? null,
        rating: typeof a.average_rating === 'number' ? a.average_rating : null,
      };
    } catch (err) {
      console.error(`[whatnot stats] show ${s.id}:`, err.message);
    }
  }

  const missing = ended.filter((s) => !shows[s.id]).length;
  return {
    version: 1,
    checkedAt: new Date(now).toISOString(),
    endedShows: state?.complete ? Math.max(state.endedShows || 0, ended.length) : ended.length,
    complete: !cursor && missing === 0, // every ended show has been looked at at least once
    shows,
  };
}

// Totals across every show Whatnot has finished calculating. Shows still being calculated
// (usually your most recent one, for a few hours) are added on a later run.
export function summarizeStats(state) {
  const done = Object.values(state?.shows || {}).filter((s) => s.status === 'GENERATED');
  const sum = (key) => done.reduce((n, s) => n + (Number(s[key]) || 0), 0);
  const rated = done.filter((s) => typeof s.rating === 'number');
  return {
    sales: sum('orders'),
    giveaways: sum('giveaways'),
    shows: done.filter((s) => Number(s.orders) > 0).length,
    rating: rated.length ? rated.reduce((n, s) => n + s.rating, 0) / rated.length : null,
    ratedShows: rated.length,
    complete: Boolean(state?.complete),
  };
}

// ---------- Lifetime sales, from your orders ----------
// Whatnot's show stats only go back to late 2025, but the order list goes back to your first
// show. Sales are counted the way your Whatnot profile's "sold" number adds up:
//   auctions and Buy It Now: completed, or paid and waiting to ship
//   giveaways: only while waiting to ship
// Cancelled and failed orders never count.
// Orders older than 3 days are counted once and kept; newer ones are recounted every run,
// since a payment can still fail or an order be cancelled in the first few days.

const SETTLE_MS = 3 * 864e5;
const ORDER_PAGE = 50; // the most Whatnot returns per page

const SOLD = new Set(['completed', 'pending_fulfillment', 'pending']);
const WAITING_TO_SHIP = new Set(['pending_fulfillment', 'pending']);

export function isSale(order) {
  return order.transaction_type === 'giveaway' ? WAITING_TO_SHIP.has(order.status) : SOLD.has(order.status);
}
const orderTime = (o) => (o.created_at ? Date.parse(o.created_at) || 0 : 0); // no date recorded = very old

// state: what was saved last time (or null). The first count goes through every order,
// newest to oldest, spread over as many runs as it takes (maxRequests calls per run).
export async function refreshOrderStats(token, state, { maxRequests = 25, now = Date.now(), fetchImpl = fetch } = {}) {
  const s = state && state.version === 2 ? JSON.parse(JSON.stringify(state)) : { version: 2, settled: null, backfill: null, recent: 0 };
  const cutoff = now - SETTLE_MS;
  let used = 0;

  if (!s.settled) {
    const fresh = () => ({ cursor: null, count: 0, cutoff, lastAt: null, lastIds: [] });
    let b = s.backfill || fresh();
    while (used < maxRequests) {
      let res;
      try {
        res = await whatnotGet(token, '/orders', { limit: ORDER_PAGE, cursor: b.cursor }, fetchImpl);
      } catch (err) {
        used++;
        // A saved cursor Whatnot no longer accepts: start the count over.
        if (b.cursor && err.status >= 400 && err.status < 500) { b = fresh(); continue; }
        throw err;
      }
      used++;
      for (const o of res.data || []) {
        const t = orderTime(o);
        if (t > b.cutoff) continue; // newer than the count's starting point: counted below once settled
        // Skip anything already counted, in case new orders shifted the list between runs.
        if (b.lastAt != null && (t > b.lastAt || (t === b.lastAt && b.lastIds.includes(o.id)))) continue;
        if (isSale(o)) b.count++;
        if (t !== b.lastAt) { b.lastAt = t; b.lastIds = []; }
        if (b.lastIds.length < 200) b.lastIds.push(o.id);
      }
      b.cursor = res.next_cursor || null;
      if (!b.cursor) {
        s.settled = { count: b.count, through: b.cutoff };
        b = null;
        break;
      }
    }
    s.backfill = b;
  }

  // Orders since the last settled point: settle the ones now older than 3 days, recount the rest.
  if (s.settled && used < maxRequests) {
    let cursor = null;
    let added = 0;
    let recent = 0;
    let reached = false;
    while (used < maxRequests && !reached) {
      const res = await whatnotGet(token, '/orders', { limit: ORDER_PAGE, cursor }, fetchImpl);
      used++;
      for (const o of res.data || []) {
        const t = orderTime(o);
        if (t <= s.settled.through) { reached = true; break; }
        if (!isSale(o)) continue;
        if (t <= cutoff) added++;
        else recent++;
      }
      cursor = res.next_cursor || null;
      if (!cursor) reached = true;
    }
    if (reached) {
      s.settled = { count: s.settled.count + added, through: Math.max(s.settled.through, cutoff) };
      s.recent = recent;
    }
  }

  s.complete = Boolean(s.settled);
  s.checkedAt = new Date(now).toISOString();
  return s;
}

export function orderSales(state) {
  return state && state.settled ? state.settled.count + (state.recent || 0) : null;
}

// 8,636 -> "8.7k", the way Whatnot shows counts: rounded up to the next tenth of a thousand
// (or million). Under 1,000 the exact number is shown. Kept in step with compactCount in public/app.js.
export function compactCount(n) {
  n = Math.max(0, Math.floor(Number(n) || 0));
  if (n < 1000) return String(n);
  const tenths = (unit) => Math.ceil(n / (unit / 10)) / 10;
  const k = tenths(1e3);
  if (k < 1000) return `${String(k).replace(/\.0$/, '')}k`;
  return `${String(tenths(1e6)).replace(/\.0$/, '')}M`;
}
