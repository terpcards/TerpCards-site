// Talks to eBay's Browse API with an application (client-credentials) token.
// Used by the Cloudflare Worker (src/worker.js) and by scripts/check-ebay.mjs locally.
// Nothing in here ever runs in the visitor's browser, so your secret stays private.

const TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const SEARCH_URL = 'https://api.ebay.com/buy/browse/v1/item_summary/search';
const ITEM_URL = 'https://api.ebay.com/buy/browse/v1/item/';
const SCOPE = 'https://api.ebay.com/oauth/api_scope';
const PAGE_SIZE = 200; // Browse API maximum per request

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
    this.publicMessage = 'The listings feed is not configured yet.';
  }
}

export class EbayError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'EbayError';
    this.status = status;
    this.publicMessage = 'Could not load listings from eBay right now.';
  }
}

// On Cloudflare, `env` is the Worker's env object. In Node scripts it defaults to process.env.
export function readConfig(env = globalThis.process?.env ?? {}) {
  const clientId = (env.EBAY_CLIENT_ID || '').trim();
  const clientSecret = (env.EBAY_CLIENT_SECRET || '').trim();
  const seller = (env.EBAY_SELLER || '').trim();

  const missing = [];
  if (!clientId) missing.push('EBAY_CLIENT_ID');
  if (!clientSecret) missing.push('EBAY_CLIENT_SECRET');
  if (!seller) missing.push('EBAY_SELLER');
  if (missing.length) throw new ConfigError(`Missing environment variables: ${missing.join(', ')}`);

  // One category per Browse API request, and it can't be a top-level (L1) category
  // without a keyword. 212 = Sports Trading Cards. Add more with commas, e.g. "212,183454".
  const categoryIds = (env.EBAY_CATEGORY_IDS || '212')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const maxItems = Math.min(Math.max(parseInt(env.EBAY_MAX_ITEMS || '200', 10) || 200, 1), 1000);

  return {
    clientId,
    clientSecret,
    seller,
    categoryIds,
    maxItems,
    marketplaceId: (env.EBAY_MARKETPLACE_ID || 'EBAY_US').trim(),
  };
}

export function sellerSearchUrl(seller) {
  return `https://www.ebay.com/sch/i.html?_ssn=${encodeURIComponent(seller)}`;
}

// ---------- OAuth application token (cached while the server instance is warm) ----------

let cachedToken = null; // { value, expiresAt }

export function clearTokenCache() {
  cachedToken = null;
}

export async function getAppToken(cfg, fetchImpl = fetch) {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;

  const basic = btoa(`${cfg.clientId}:${cfg.clientSecret}`); // works in Workers and Node
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: SCOPE }).toString(),
  });

  if (!res.ok) {
    const detail = await safeText(res);
    throw new EbayError(`eBay token request failed (${res.status}): ${detail}`, res.status);
  }

  const data = await res.json();
  const ttlSeconds = Number(data.expires_in) || 7200;
  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + Math.max(ttlSeconds - 120, 60) * 1000, // refresh 2 min early
  };
  return cachedToken.value;
}

// ---------- Listings ----------

export async function fetchSellerListings(cfg, fetchImpl = fetch) {
  return (await fetchSellerData(cfg, fetchImpl)).items;
}

export function feedbackProfileUrl(seller) {
  return `https://www.ebay.com/fdbk/feedback_profile/${encodeURIComponent(seller)}`;
}

// Your listings, plus your eBay feedback (percent positive and score), which comes
// along with every search result.
export async function fetchSellerData(cfg, fetchImpl = fetch) {
  const seen = new Map();
  const limit = Math.min(PAGE_SIZE, cfg.maxItems);
  let feedback = null;

  for (const categoryId of cfg.categoryIds) {
    let offset = 0;
    while (seen.size < cfg.maxItems && offset < 10000) {
      const page = await searchPage(cfg, { categoryId, limit, offset }, fetchImpl);
      const summaries = page.itemSummaries || [];

      for (const s of summaries) {
        // Guard against the occasional result from another seller.
        const username = s.seller && s.seller.username;
        if (username && username.toLowerCase() !== cfg.seller.toLowerCase()) continue;
        if (!feedback) feedback = readFeedback(s.seller);
        if (!seen.has(s.itemId)) seen.set(s.itemId, normalizeItem(s));
      }

      if (!page.next || summaries.length < limit) break;
      offset += limit; // offset must stay a multiple of limit
    }
  }

  const items = [...seen.values()]
    .sort((a, b) => (Date.parse(b.listedAt || 0) || 0) - (Date.parse(a.listedAt || 0) || 0))
    .slice(0, cfg.maxItems);
  return { items, feedback };
}

// eBay sends the percentage as a string ("99.8") and the score as a number.
export function readFeedback(seller) {
  if (!seller) return null;
  const percent = Number(seller.feedbackPercentage);
  if (seller.feedbackPercentage == null || !Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  const score = Number(seller.feedbackScore);
  return { percent, score: Number.isInteger(score) && score >= 0 ? score : null };
}

async function searchPage(cfg, { categoryId, limit, offset }, fetchImpl, retried = false) {
  const token = await getAppToken(cfg, fetchImpl);
  const params = new URLSearchParams({
    category_ids: categoryId,
    // Auctions with bids are left out unless AUCTION is asked for explicitly.
    filter: `sellers:{${cfg.seller}},buyingOptions:{FIXED_PRICE|AUCTION}`,
    sort: 'newlyListed',
    limit: String(limit),
    offset: String(offset),
  });

  const res = await fetchImpl(`${SEARCH_URL}?${params}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': cfg.marketplaceId,
      Accept: 'application/json',
    },
  });

  if (res.status === 401 && !retried) {
    clearTokenCache();
    return searchPage(cfg, { categoryId, limit, offset }, fetchImpl, true);
  }
  if (!res.ok) {
    const detail = await safeText(res);
    throw new EbayError(`eBay search failed (${res.status}): ${detail}`, res.status);
  }
  return res.json();
}

export function normalizeItem(s) {
  const options = s.buyingOptions || [];
  const image =
    (s.image && s.image.imageUrl) ||
    (s.thumbnailImages && s.thumbnailImages[0] && s.thumbnailImages[0].imageUrl) ||
    null;
  const ship = s.shippingOptions && s.shippingOptions[0] && s.shippingOptions[0].shippingCost;

  return {
    id: s.itemId,
    title: s.title || 'Untitled listing',
    url: s.itemWebUrl,
    image: upsizeImage(image),
    price: money(s.price),
    currentBid: money(s.currentBidPrice),
    bidCount: Number(s.bidCount) || 0,
    isAuction: options.includes('AUCTION'),
    isBuyItNow: options.includes('FIXED_PRICE'),
    acceptsOffers: options.includes('BEST_OFFER'),
    condition: s.condition || null,
    shipping: money(ship),
    listedAt: s.itemCreationDate || null,
    endsAt: s.itemEndDate || null,
  };
}

// ---------- Listings that drop out of eBay's search ----------
// eBay's search sometimes leaves out live listings for a while (often right after you list or
// edit). Looking a listing up directly doesn't go through search, so it says whether the
// listing is really still for sale.
//   'live'    - still for sale
//   'gone'    - sold, ended, or no longer exists
//   'unknown' - eBay didn't answer properly this time
export async function checkListings(cfg, ids, { now = Date.now(), fetchImpl = fetch } = {}) {
  const token = await getAppToken(cfg, fetchImpl);
  const results = await Promise.all(ids.map(async (id) => {
    try {
      const res = await fetchImpl(ITEM_URL + encodeURIComponent(id), {
        headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': cfg.marketplaceId, Accept: 'application/json' },
      });
      if (res.status === 404 || res.status === 410) return [id, 'gone'];
      if (!res.ok) return [id, res.status === 400 ? 'gone' : 'unknown'];
      const item = await res.json();
      const seller = item.seller && item.seller.username;
      const ended = item.itemEndDate && Date.parse(item.itemEndDate) <= now;
      const soldOut = (item.estimatedAvailabilities || []).some((a) => a.estimatedAvailabilityStatus === 'OUT_OF_STOCK');
      if ((seller && seller.toLowerCase() !== cfg.seller.toLowerCase()) || ended || soldOut) return [id, 'gone'];
      return [id, 'live'];
    } catch {
      return [id, 'unknown'];
    }
  }));
  return new Map(results);
}

function money(m) {
  if (!m || m.value == null) return null;
  const value = Number(m.value);
  if (!Number.isFinite(value)) return null;
  return { value, currency: m.currency || 'USD' };
}

// eBay serves the same photo at many sizes; search results point at a small one.
export function upsizeImage(url, size = 500) {
  if (!url) return null;
  return url.replace(/\/s-l\d+\.(jpe?g|png|webp)/i, `/s-l${size}.$1`);
}

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '';
  }
}
