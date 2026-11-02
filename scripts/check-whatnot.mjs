// One-time look at what Whatnot's Seller API returns for your account.
//   npm run check:whatnot
// Reads WHATNOT_API_TOKEN from .dev.vars. Prints a summary and saves the details to
// whatnot-check.json (git-ignored, since it includes sales numbers). It never saves the token.

import { writeFileSync } from 'node:fs';
import { whatnotToken, whatnotGet, currentUser, listShows, showAnalytics, refreshStats, summarizeStats, isSale, compactCount } from '../lib/whatnot.js';

const token = whatnotToken(process.env);
if (!token) {
  console.error('Add WHATNOT_API_TOKEN=... to .dev.vars first.');
  process.exit(1);
}

const out = { checkedAt: new Date().toISOString(), errors: [] };
const attempt = async (label, fn) => {
  try {
    return await fn();
  } catch (err) {
    console.error(`  ${label}: ${err.message}`);
    out.errors.push({ label, status: err.status ?? null, message: err.message });
    return null;
  }
};

console.log('Asking Whatnot about your account...\n');

const me = await attempt('users/me', () => currentUser(token));
if (me) {
  out.user = { id: me.id, username: me.username, display_name: me.display_name, image: me.image?.url ?? null, can_go_live: me.can_go_live };
  console.log(`Account: ${me.username}${me.display_name ? ` (${me.display_name})` : ''}`);
}

for (const status of ['live', 'scheduled', 'stopped', 'ended', 'cancelled']) {
  const res = await attempt(`shows ${status}`, () =>
    listShows(token, { status, limit: 50, reverse: status === 'scheduled' ? false : undefined, maxPages: status === 'ended' ? 20 : 2 })
  );
  if (!res) continue;
  out[status] = { count: res.shows.length, countIsAtLeast: res.more, shows: res.shows };
  console.log(`${status.padEnd(10)} ${res.more ? 'at least ' : ''}${res.shows.length} show(s)`);
  for (const s of res.shows.slice(0, status === 'ended' ? 3 : 5)) {
    console.log(`           ${s.scheduled_start_at || '(no time)'}  ${s.title}`);
  }
}

// Analytics for your most recent ended shows.
const recent = (out.ended?.shows || []).slice(0, 25);
out.analytics = [];
if (recent.length) console.log(`\nShow analytics for your last ${recent.length} show(s):`);
for (const s of recent) {
  const a = await attempt(`analytics ${s.id}`, () => showAnalytics(token, s.id));
  if (!a) continue;
  out.analytics.push(a);
  console.log(
    `  ${(a.start_time || '').slice(0, 10)}  ${String(a.calculation_status).padEnd(10)}` +
      ` orders ${a.orders_count ?? '-'}, buyers ${a.buyers_count ?? '-'}, peak viewers ${a.max_concurrent_viewers ?? '-'},` +
      ` rating ${a.average_rating ?? '-'}  ${a.title}`
  );
}

const done = out.analytics.filter((a) => a.calculation_status === 'GENERATED');
const sum = (key) => done.reduce((n, a) => n + (Number(a[key]) || 0), 0);
const rated = done.filter((a) => a.average_rating != null);
out.totals = {
  showsWithAnalytics: done.length,
  orders: sum('orders_count'),
  buyers: sum('buyers_count'),
  totalViews: sum('total_views'),
  peakViewers: Math.max(0, ...done.map((a) => a.max_concurrent_viewers || 0)),
  averageRating: rated.length ? rated.reduce((n, a) => n + a.average_rating, 0) / rated.length : null,
};
console.log('\nAcross those shows:', out.totals);

// Lifetime totals, worked out the same way the site does (here in one go, every show).
console.log('\nWorking out lifetime totals across every show (this takes a moment)...');
const lifetime = await attempt('lifetime stats', () => refreshStats(token, null, { maxRequests: 1000 }));
// (The site's sales number comes from orders, counted below; this part is where the rating comes from.)
if (lifetime) {
  const t = summarizeStats(lifetime);
  out.lifetime = { ...t, endedShows: lifetime.endedShows };
  console.log(`  Sales (Whatnot orders): ${t.sales.toLocaleString('en-US')}  (giveaway orders: ${t.giveaways.toLocaleString('en-US')})`);
  console.log(`  Average show rating:    ${t.rating == null ? 'none yet' : t.rating.toFixed(2)} across ${t.ratedShows} rated shows`);
  console.log(`  Shows with sales:       ${t.shows}`);
  console.log(`  Every show counted:     ${t.complete ? 'yes' : 'no'}`);
  // Which shows have numbers, by month (to see how far back Whatnot's show analytics go).
  out.lifetimeShows = Object.entries(lifetime.shows)
    .map(([id, v]) => ({ id, start: v.start, status: v.status, orders: v.orders, rating: v.rating }))
    .sort((a, b) => String(a.start).localeCompare(String(b.start)));
}

// Every order, counted by status and how it sold (no buyer details are read or saved).
console.log('\nCounting every order (about one request per 50 orders, so this can take a minute)...');
const tally = { pages: 0, total: 0, sales: 0, byStatus: {}, byType: {}, byTypeAndStatus: {}, inShows: 0, outsideShows: 0, byMonth: {}, oldest: null, newest: null };
let cursor = null;
const counted = await attempt('orders', async () => {
  do {
    const res = await whatnotGet(token, '/orders', { limit: 50, cursor });
    tally.pages++;
    for (const o of res.data || []) {
      tally.total++;
      tally.byStatus[o.status] = (tally.byStatus[o.status] || 0) + 1;
      const type = o.transaction_type || 'unknown';
      tally.byType[type] = (tally.byType[type] || 0) + 1;
      const key = `${type} / ${o.status}`;
      tally.byTypeAndStatus[key] = (tally.byTypeAndStatus[key] || 0) + 1;
      if (isSale(o)) tally.sales++;
      if (o.show_id) tally.inShows++; else tally.outsideShows++;
      const month = (o.created_at || 'unknown').slice(0, 7);
      tally.byMonth[month] = (tally.byMonth[month] || 0) + 1;
      if (o.created_at && (!tally.oldest || o.created_at < tally.oldest)) tally.oldest = o.created_at;
      if (o.created_at && (!tally.newest || o.created_at > tally.newest)) tally.newest = o.created_at;
    }
    cursor = res.next_cursor;
    if (tally.pages % 20 === 0) process.stdout.write(`  ...${tally.total} so far\n`);
  } while (cursor && tally.pages < 1000);
  return true;
});
if (counted) {
  out.orders = tally;
  const ok = tally.total - (tally.byStatus.cancelled || 0) - (tally.byStatus.failed || 0);
  console.log(`  Orders: ${tally.total.toLocaleString('en-US')} in all, ${ok.toLocaleString('en-US')} not cancelled or failed`);
  console.log(`  Sales the site shows: ${tally.sales.toLocaleString('en-US')} (shown as ${compactCount(tally.sales)})`);
  console.log('  By type and status:', tally.byTypeAndStatus);
  console.log(`  In shows: ${tally.inShows}, elsewhere: ${tally.outsideShows}, from ${String(tally.oldest).slice(0, 10)} to ${String(tally.newest).slice(0, 10)}`);
}

writeFileSync(new URL('../whatnot-check.json', import.meta.url), JSON.stringify(out, null, 2));
console.log('\nSaved the details to whatnot-check.json.');
if (out.errors.length) console.log(`${out.errors.length} request(s) failed; see "errors" in the file.`);
