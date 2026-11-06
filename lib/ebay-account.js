// Your own eBay account, read with your permission (a one-time eBay sign-in).
// It gives the site two things eBay's public search can't:
//   - the exact list of your active listings, straight from your account (like Seller Hub),
//     so listings don't flicker in and out when eBay's search is behind
//   - each listing's watcher count, used only to order the "Most popular" sort
//   - your recently sold cards (title and photo only; never prices or buyer details)
// Used by src/worker.js. Never runs in the browser.

import { ebayPhotoUrl } from './ebay.js';

const AUTH_URL = 'https://auth.ebay.com/oauth2/authorize';
const TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const TRADING_URL = 'https://api.ebay.com/ws/api.dll';
const SCOPE = 'https://api.ebay.com/oauth/api_scope';
const TRADING_VERSION = '1349';
const TOKEN_EXPIRED_CODES = new Set(['21917053', '932', '21916984']); // eBay's "token expired/invalid" errors

export class AccountError extends Error {
  constructor(message, { code = null, needsSignIn = false } = {}) {
    super(message);
    this.name = 'AccountError';
    this.code = code;
    this.needsSignIn = needsSignIn; // the saved sign-in no longer works: sign in again
  }
}

// ---------- Signing in ----------

// runame: the "RuName" eBay gives you when you add the sign-in redirect in the developer site.
export function signInUrl(cfg, runame, state) {
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: 'code',
    redirect_uri: runame,
    scope: SCOPE,
    state,
  });
  return `${AUTH_URL}?${params}`;
}

async function tokenRequest(cfg, form, fetchImpl) {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${cfg.clientId}:${cfg.clientSecret}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(form).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const invalid = data.error === 'invalid_grant';
    throw new AccountError(`eBay sign-in token request failed (${res.status}): ${data.error || ''} ${data.error_description || ''}`.trim(), {
      code: data.error || String(res.status),
      needsSignIn: invalid,
    });
  }
  return data;
}

// After you approve on eBay, it sends back a one-time code; this swaps it for tokens.
export async function finishSignIn(cfg, runame, code, { now = Date.now(), fetchImpl = fetch } = {}) {
  const data = await tokenRequest(cfg, { grant_type: 'authorization_code', code, redirect_uri: runame }, fetchImpl);
  return {
    accessToken: data.access_token,
    accessExpiresAt: now + (Number(data.expires_in) || 7200) * 1000,
    refreshToken: data.refresh_token,
    refreshExpiresAt: now + (Number(data.refresh_token_expires_in) || 47304000) * 1000,
    connectedAt: new Date(now).toISOString(),
  };
}

// The access token lasts about 2 hours; the saved refresh token (about 18 months) gets a new one.
export async function freshAccessToken(cfg, account, { now = Date.now(), fetchImpl = fetch } = {}) {
  if (account.accessToken && account.accessExpiresAt - now > 2 * 60e3) return { account, changed: false };
  if (!account.refreshToken) throw new AccountError('No saved eBay sign-in.', { needsSignIn: true });
  if (account.refreshExpiresAt && account.refreshExpiresAt <= now) {
    throw new AccountError('The saved eBay sign-in has expired.', { needsSignIn: true });
  }
  const data = await tokenRequest(cfg, { grant_type: 'refresh_token', refresh_token: account.refreshToken, scope: SCOPE }, fetchImpl);
  return {
    account: { ...account, accessToken: data.access_token, accessExpiresAt: now + (Number(data.expires_in) || 7200) * 1000 },
    changed: true,
  };
}

// ---------- eBay's Trading API (XML) ----------

const xmlText = (xml, tag) => {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : null;
};
const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const xmlDecode = (s) =>
  String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export async function tradingCall(callName, accessToken, innerXml, fetchImpl = fetch) {
  const body = `<?xml version="1.0" encoding="utf-8"?>\n<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">${innerXml}</${callName}Request>`;
  const res = await fetchImpl(TRADING_URL, {
    method: 'POST',
    headers: {
      'X-EBAY-API-CALL-NAME': callName,
      'X-EBAY-API-SITEID': '0',
      'X-EBAY-API-COMPATIBILITY-LEVEL': TRADING_VERSION,
      'X-EBAY-API-IAF-TOKEN': accessToken,
      'Content-Type': 'text/xml; charset=utf-8',
    },
    body,
  });
  const xml = await res.text();
  const ack = xmlText(xml, 'Ack');
  if (!res.ok || (ack !== 'Success' && ack !== 'Warning')) {
    const code = xmlText(xml, 'ErrorCode');
    const message = xmlText(xml, 'LongMessage') || xmlText(xml, 'ShortMessage') || `HTTP ${res.status}`;
    throw new AccountError(`eBay ${callName} failed: ${message}`, { code, needsSignIn: false });
  }
  return xml;
}

const isExpiredToken = (err) => err instanceof AccountError && TOKEN_EXPIRED_CODES.has(String(err.code));

// The eBay username the token belongs to.
export async function accountUsername(accessToken, fetchImpl = fetch) {
  const xml = await tradingCall('GetUser', accessToken, '', fetchImpl);
  return xmlText(xml, 'UserID');
}

// Every active listing in the account: legacy item ID (the number in the listing's URL) -> watcher count.
export async function activeListings(accessToken, { maxPages = 5, fetchImpl = fetch } = {}) {
  const watch = new Map();
  for (let page = 1; page <= maxPages; page++) {
    const xml = await tradingCall(
      'GetMyeBaySelling',
      accessToken,
      `<ActiveList><Include>true</Include><IncludeNotes>false</IncludeNotes><Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${xmlEscape(page)}</PageNumber></Pagination></ActiveList>`,
      fetchImpl
    );
    const active = xmlText(xml, 'ActiveList') || '';
    for (const m of active.matchAll(/<Item>([\s\S]*?)<\/Item>/g)) {
      const id = xmlText(m[1], 'ItemID');
      if (!id) continue;
      watch.set(id, Number(xmlText(m[1], 'WatchCount')) || 0);
    }
    const pages = Number(xmlText(active, 'TotalNumberOfPages')) || 1;
    if (page >= pages) return { watch, complete: true };
  }
  return { watch, complete: false };
}

// Cards sold in the last `days` days (1 to 60, eBay's limit), newest first, one entry per listing.
// Only what the site shows is read: the listing number, title, photo and when it sold.
// Buyer details, prices and order numbers in eBay's answer are never kept.
export async function soldListings(accessToken, { days = 60, maxPages = 5, fetchImpl = fetch } = {}) {
  const sold = new Map();
  const window = Math.min(60, Math.max(1, Math.ceil(days)));
  for (let page = 1; page <= maxPages; page++) {
    const xml = await tradingCall(
      'GetMyeBaySelling',
      accessToken,
      `<SoldList><Include>true</Include><IncludeNotes>false</IncludeNotes><DurationInDays>${window}</DurationInDays><Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${xmlEscape(page)}</PageNumber></Pagination></SoldList>`,
      fetchImpl
    );
    const list = xmlText(xml, 'SoldList') || '';
    for (const t of list.matchAll(/<Transaction>([\s\S]*?)<\/Transaction>/g)) {
      const item = xmlText(t[1], 'Item') || '';
      const id = xmlText(item, 'ItemID');
      if (!id || !/^\d+$/.test(id)) continue;
      const soldAt = Date.parse(xmlText(t[1], 'CreatedDate') || '') || Date.parse(xmlText(item, 'EndTime') || '') || 0;
      const title = xmlText(item, 'Title');
      const photo = xmlText(item, 'GalleryURL');
      const prev = sold.get(id);
      if (prev && prev.soldAt >= soldAt) continue;
      sold.set(id, {
        id,
        title: title ? xmlDecode(title) : null,
        image: photo ? ebayPhotoUrl(xmlDecode(photo)) : null,
        soldAt,
      });
    }
    const pages = Number(xmlText(list, 'TotalNumberOfPages')) || 1;
    if (page >= pages) break;
  }
  return [...sold.values()].sort((a, b) => b.soldAt - a.soldAt);
}

// The main photo of each listing (sold ones included), straight from the listing itself.
// One request per listing, so callers keep the list short. Listings eBay won't return are skipped.
export async function listingPhotos(accessToken, ids, { fetchImpl = fetch } = {}) {
  const photos = new Map();
  for (const id of ids) {
    if (!/^\d+$/.test(String(id))) continue;
    try {
      const xml = await tradingCall('GetItem', accessToken, `<ItemID>${xmlEscape(id)}</ItemID>`, fetchImpl);
      const pictures = xmlText(xml, 'PictureDetails') || '';
      const url = [...pictures.matchAll(/<PictureURL>([\s\S]*?)<\/PictureURL>/g)].map((m) => ebayPhotoUrl(xmlDecode(m[1].trim()))).find(Boolean)
        || ebayPhotoUrl(xmlDecode(xmlText(pictures, 'GalleryURL') || ''));
      if (url) photos.set(String(id), url);
    } catch (err) {
      console.error(`[ebay photo] ${id}:`, err.message);
    }
  }
  return photos;
}

// Runs fn with a working access token, refreshing it once if eBay says it expired.
// Returns the result plus the (possibly updated) account to save.
export async function withAccount(cfg, account, fn, { now = Date.now(), fetchImpl = fetch } = {}) {
  let { account: acc, changed } = await freshAccessToken(cfg, account, { now, fetchImpl });
  try {
    return { result: await fn(acc.accessToken), account: acc, changed };
  } catch (err) {
    if (!isExpiredToken(err)) throw err;
    ({ account: acc } = await freshAccessToken(cfg, { ...acc, accessExpiresAt: 0 }, { now, fetchImpl }));
    return { result: await fn(acc.accessToken), account: acc, changed: true };
  }
}
