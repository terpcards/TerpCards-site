// Quick check that your eBay keys and seller name work, before you deploy.
//   npm run check
// Reads your keys from .dev.vars and your settings (EBAY_SELLER etc.) from wrangler.jsonc.

import { readFileSync } from 'node:fs';
import { readConfig, fetchSellerListings, sellerSearchUrl } from '../lib/ebay.js';

// Use the "vars" from wrangler.jsonc, unless .dev.vars sets the same name.
try {
  const text = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  const vars = JSON.parse(text).vars || {};
  for (const [k, v] of Object.entries(vars)) {
    if (process.env[k] === undefined || process.env[k] === '') process.env[k] = String(v);
  }
} catch (err) {
  console.warn('Could not read wrangler.jsonc vars:', err.message);
}

try {
  const cfg = readConfig(process.env);
  console.log(`Looking up active listings for "${cfg.seller}" in categories ${cfg.categoryIds.join(', ')}...`);
  const items = await fetchSellerListings(cfg);
  console.log(`\nFound ${items.length} listing(s).\n`);

  for (const item of items.slice(0, 10)) {
    const p = item.isAuction && item.currentBid ? item.currentBid : item.price;
    const price = p ? `${p.currency} ${p.value.toFixed(2)}` : 'no price';
    const kind = item.isAuction ? 'Auction' : 'Buy It Now';
    console.log(`  ${price.padEnd(12)} ${kind.padEnd(11)} ${item.title}`);
  }
  if (items.length > 10) console.log(`  ...and ${items.length - 10} more`);
  if (items.length === 0) {
    console.log('No listings came back. Check that EBAY_SELLER in wrangler.jsonc is your exact eBay');
    console.log('username and that EBAY_CATEGORY_IDS covers what you sell. Compare with:', sellerSearchUrl(cfg.seller));
  }
} catch (err) {
  console.error('\nCheck failed:', err.message);
  if (/EBAY_SELLER/.test(err.message)) console.error('Add your eBay username to "EBAY_SELLER" in wrangler.jsonc.');
  if (/EBAY_CLIENT/.test(err.message)) console.error('Copy .dev.vars.example to .dev.vars and add your eBay keys.');
  process.exitCode = 1;
}
