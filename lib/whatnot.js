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
