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

const FINAL_STATUSES = new Set(['GENERATED', 'WILL_NOT_BE_CALCULATED']);

// state: what was saved last time (or null). Makes at most maxRequests calls to Whatnot,
// so a big first run is spread over a few runs.
export async function refreshStats(token, state, { maxRequests = 35, now = Date.now(), fetchImpl = fetch } = {}) {
  const shows = { ...(state?.shows || {}) };
  let used = 0;

  const ended = [];
  let cursor = null;
  do {
    const res = await whatnotGet(token, '/shows', { status: 'ended', limit: 50, cursor }, fetchImpl);
    used++;
    ended.push(...(res.data || []));
    cursor = res.next_cursor;
  } while (cursor && used < 10);

  // Shows never looked at come first, then ones Whatnot was still calculating last time.
  const todo = [...ended.filter((s) => !shows[s.id]), ...ended.filter((s) => shows[s.id] && !FINAL_STATUSES.has(shows[s.id].status))];
  for (const s of todo) {
    if (used >= maxRequests) break;
    used++;
    try {
      const a = await showAnalytics(token, s.id, fetchImpl);
      shows[s.id] = {
        status: a.calculation_status || null,
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
    endedShows: ended.length,
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
