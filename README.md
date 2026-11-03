# TerpCards site

A one-page card shop site. The main section is a live grid of your active eBay listings. Each card links to its eBay listing and has a **Make an offer** button that opens the contact form with that card filled in. Below the grid, an **I buy cards** section invites people selling cards to get in touch. Above the grid, visitors can narrow the cards to graded or raw, and your eBay feedback shows next to the listings heading. There's also a Whatnot block that counts down to your Wednesday 5:30 PM ET show and converts the time for visitors in other time zones.

It runs on **Cloudflare Workers' free plan**. The page files are served free with no limit, and only the listings feed (`/api/listings`) counts toward the free 100,000 requests a day, which caching keeps to a tiny fraction. Your only ongoing cost is the yearly domain renewal.

```
public/index.html       the page
public/robots.txt, sitemap.xml  for search engines
public/styles.css       all styling (colors and fonts are at the top)
public/app.js           page behavior; your links and show schedule are at the top
src/worker.js           Cloudflare Worker: /api/listings (eBay), /api/whatnot (your shows) and /api/contact (the form)
lib/ebay.js             talks to eBay's Browse API (token, paging, cleanup)
lib/whatnot.js          talks to Whatnot's Seller API (your show schedule and live status)
lib/contact.js          checks contact form messages and turns them into an email
wrangler.jsonc          Cloudflare settings, including your eBay username
scripts/check-ebay.mjs  tests your eBay keys from the terminal
scripts/check-whatnot.mjs  shows what Whatnot's API returns for your account
```

Your eBay secret only ever lives on Cloudflare. The browser just calls `/api/listings`.

---

## 1. Fill in your details

In `public/app.js`, edit the `SITE` block at the top:

```js
ebaySeller: 'terpcards',
ebayStoreUrl: 'https://www.ebay.com/str/terpcards',
whatnotUrl: 'https://www.whatnot.com/user/terpcards',
youtubeUrl: '',
instagramUrl: 'https://www.instagram.com/terpcards/',
xUrl: 'https://x.com/TerpCards',
```

These are filled in already except YouTube. Any link left empty is hidden. The show schedule is in the same block if it ever moves.

`wrangler.jsonc` has `"EBAY_SELLER": "terpcards"`. That has to be your eBay *username*, which can differ from your store name. If `npm run check` (step 3) finds no listings, look up your username on your eBay profile and put it in both places.

Once you know your domain, replace `yourdomain.com` in `public/index.html` (one place, the `og:image` line). That's what shows your logo when someone shares a link to the site in a text or on social media.

**You can launch before your eBay keys arrive.** Until the listings feed has your keys, visitors see a "Shop my eBay store" section with a big button to your store. As soon as you add the keys in Cloudflare (step 4), the live grid replaces it on its own, with no code changes or redeploy. The same store section also covers you if eBay is ever down for more than a day.

On your own computer (opening `public/index.html`, or `npm run dev`), you see clearly labeled sample cards instead, so you can work on the look of the grid before the keys arrive. Visitors to your real domain never see them.

## 2. Get eBay API keys (free, about 10 minutes)

1. Sign up at **developer.ebay.com** with your eBay account and wait for the approval email (usually quick).
2. Go to **Application Keys** and create a **Production** keyset. Copy the **App ID (Client ID)** and **Cert ID (Client Secret)**.
3. eBay disables new production keys until you handle *Marketplace Account Deletion notifications*. Since this site stores no eBay user data, choose **opt out / exempt** on that screen and give the reason "does not store any eBay user data." The keyset activates once that's done.

That's all the access this needs: the public Browse API with an app token. It allows 5,000 calls a day; with caching the site uses a few hundred at most.

## 3. Try it on your computer

Needs Node 20.6 or newer.

```bash
npm install
cp .dev.vars.example .dev.vars    # then add your two eBay keys
npm run check                     # prints your listings, to confirm the keys work
npm run dev                       # the full site at http://localhost:8787
```

If `npm run check` finds nothing, double-check `EBAY_SELLER` (your exact username) and `EBAY_CATEGORY_IDS` in `wrangler.jsonc`:

| Category ID | What it covers |
|---|---|
| `212` (default) | Sports Trading Cards: singles, sealed, lots, supplies |
| `183454` | Collectible card game singles (Pokémon, Dragon Ball, etc.) |
| `183050` | Non-sport trading card singles (Disney, SpongeBob, etc.) |

Use several with commas. The site is set to `"212,183454,183050"`, which covers everything you list today. eBay only allows one category per request, so each one is fetched separately and merged. If your eBay store ever shows more listings than the site, a listing is probably in a category that isn't on this list: open it on eBay, and the last link in the category trail at the top has the ID in its address.

## 4. Put it online

Make a free account at **cloudflare.com** first.

**Recommended: connect GitHub, so every push redeploys the site.**

1. Push this folder to a GitHub repo (private is fine). `.dev.vars` is git-ignored, so your keys stay off GitHub.
2. In the Cloudflare dashboard, go to **Workers & Pages → Create application → GitHub**, sign in to GitHub if asked, and pick your repo. Name the Worker **terpcards-site**. It has to match `"name"` in `wrangler.jsonc`, or the build fails. Then **Save and Deploy**.
3. Open the new Worker, go to **Settings → Variables and Secrets**, and add `EBAY_CLIENT_ID` and `EBAY_CLIENT_SECRET` with the type **Secret**.
4. Visit `https://terpcards-site.<your-subdomain>.workers.dev/api/listings`. You should see JSON with your items, and the home page switches from the store section to the real grid. (No keys yet? Skip adding them and this check for now; the site works without them.)

**Or deploy from your terminal:**

```bash
npx wrangler login
npx wrangler secret put EBAY_CLIENT_ID
npx wrangler secret put EBAY_CLIENT_SECRET
npm run deploy
```

Keep non-secret settings like `EBAY_SELLER` in `wrangler.jsonc`. Each deploy uses the values in that file.

## 5. Get your domain

**If you don't have a domain yet (simplest):** buy it from Cloudflare. Cloudflare sells domains at cost with free WHOIS privacy, and the domain is ready to use right away with no nameserver changes.

1. In the Cloudflare dashboard, go to **Domain Registration → Register Domains**, search for the name you want (for example `terpcards.com`), and buy it.
2. Open your Worker, go to **Settings → Domains & Routes → Add → Custom Domain**, and enter `yourdomain.com`. Repeat for `www.yourdomain.com`. Cloudflare creates the DNS records and the HTTPS certificate for you.
3. In `public/index.html`, replace `yourdomain.com` in the `og:image` line with your domain and push.

**If your domain is registered somewhere else, like Squarespace:** the domain stays registered there (renew it there as usual), and Cloudflare takes over answering for it.

1. In Cloudflare, choose **Add a domain**, enter `yourdomain.com`, and pick the **Free** plan. Cloudflare copies your existing DNS records.
   - Check that your email records came across: MX, and TXT records such as SPF.
   - Delete any A or CNAME records for `@` and `www` that point to Squarespace's website servers. Step 5 below replaces them.
2. If DNSSEC is turned on for the domain in Squarespace, turn it off before the next step. You can turn it on again in Cloudflare afterward.
3. In Squarespace, open the domain, then **DNS → Domain Nameservers → Use Custom Nameservers**. Enter the two nameservers Cloudflare gave you and save.
4. Wait for Cloudflare to email you that the domain is active. Often that's within an hour, but it can take up to a day.
5. Open your Worker, go to **Settings → Domains & Routes → Add → Custom Domain**, and enter `yourdomain.com`. Repeat for `www.yourdomain.com`. Cloudflare creates the DNS records and the HTTPS certificate for you.

If a Squarespace website is currently on this domain, it stops showing there once the nameservers switch.

## 6. Turn on the contact form

The form emails each message to terpcards@gmail.com using Cloudflare Email Routing, which is free. It needs your domain on Cloudflare first (step 5). Until then, the form tells visitors to message you on X or Instagram instead.

1. In the Cloudflare dashboard, open your domain, go to **Email → Email Routing**, and turn it on. Cloudflare adds the email records it needs for the domain.
2. Under **Destination addresses**, add `terpcards@gmail.com`. Cloudflare emails you a verification link; click it.
3. In `wrangler.jsonc`:
   - set `"CONTACT_FROM"` to an address on your domain, such as `"contact@yourdomain.com"`. It doesn't need to be a real inbox; it's just the sender name on the emails.
   - delete the `//` at the start of the three `"send_email"` lines.
4. Push (or `npm run deploy`), then send yourself a test message from the site. The first one may land in Gmail's spam folder; mark it "Not spam" and the rest will arrive normally.

What the emails look like: the subject says what it's about and who sent it, for example *Make an offer: Jane on 2023 Bowman Chrome 1st Auto Prospect /250 BGS 9.5 (TerpCards site)*. Offers and card questions sent from a card's button include the card title and a link to its eBay listing. If the person left an email address, you can hit **Reply** in Gmail and it goes straight to them. Otherwise the email shows the phone number or handle they left.

Bonus: with Email Routing on, you can also create addresses like `hello@yourdomain.com` that forward to your Gmail.

**Spam protection:** the form has a hidden field that only bots fill in, ignores anything submitted faster than a person could type it, and limits each visitor to 5 messages per 10 minutes. If spam still gets through, Cloudflare Turnstile (a free, mostly invisible "are you human" check) can be added.

**A note on eBay's rules:** eBay doesn't allow steering buyers to off-eBay deals through eBay itself, in listings or eBay messages. The "Make me an offer" note lives on your own site, which is fine, but keep the site and your X/Instagram handles out of your eBay listings and messages.

## Search engines

- `public/robots.txt` lets search engines crawl the whole site and points them to `public/sitemap.xml`.
- In Google Search Console, go to **Sitemaps**, enter `sitemap.xml` and submit it once. Bing Webmaster Tools has the same option.
- `public/index.html` has a canonical tag (`https://terp.cards/` is the one official address) and a hidden block of structured data that tells Google this site and your eBay, Whatnot, X and Instagram pages are all TerpCards. If one of those links changes, update it there as well as in `public/app.js`. You can check the block with Google's Rich Results Test (search.google.com/test/rich-results).

## Changing the look later

Everything visual is plain HTML and CSS in `public/`. Edit, open `public/index.html` in a browser to check (it shows the sample listings), then push. Cloudflare redeploys in about a minute.

Logo files:

| File | Used for |
|---|---|
| `public/img/logo-600.webp`, `logo-1200.webp`, `logo-1200.png` | the hero logo (sharp on phones and big screens) |
| `public/img/mark-160.webp`, `mark-160.png` | the footer icon |
| `public/favicon.ico`, `favicon-32.png` | the browser tab icon |
| `public/apple-touch-icon.png`, `icon-512.png` | home-screen icon when someone saves the site to their phone |
| `public/og-image.png` | the picture shown in link previews (1200 × 630) |
| `public/img/show-table-*`, `show-crowd-*` | the two card show photos in the footer |

If the logo ever changes, replace these with files of the same names and sizes.

## Listings per page

The grid shows 24 cards per page with page numbers underneath. To change that, edit `perPage: 24` in the settings block at the top of `public/app.js`.

## Graded / Raw buttons

The **Graded** and **Raw** buttons above the grid sort cards by their titles. A title counts as graded when it names a grading company with a grade ("PSA 10", "BGS 9.5", "SGC Mint 9", "PSA10"), says "Authentic", or uses the words "graded" or "slab". Words like "raw", "candidate", "worthy" or "PSA ready" mark a card as raw, even when a grading company is named. Tap a button again to show everything.

The grading companies it knows are in `GRADERS` in `public/app.js` (PSA, BGS, BVG, SGC, CGC, CSG, TAG, HGA, Beckett, MBA, ISA, GMA, KSA). Add another with a `|` if you sell cards graded elsewhere.

## eBay feedback badge

Next to the "On eBay now" heading, the site shows your eBay feedback, like "99.8% positive feedback (1,234)", linked to your feedback page. It comes from eBay along with your listings, so it stays current on its own. It only shows while your feedback is at least `feedbackMinPercent` (98 by default) in the settings block of `public/app.js`; set that to 101 to hide it.

## Connect your eBay account (Most popular sort)

Signing in to eBay once, through the site, lets it read your own account the way Seller Hub does. That gives the site two things eBay's public search can't:

- **A "Most popular" sort**, ordered by how many people are watching each card on eBay. The site only ever gets each card's place in that order (`popular: 1` is the most watched). The watcher counts themselves stay in the Worker and never reach the page.
- **An exact listing count.** Your account's own list of active listings decides what's on the site, so cards don't drop off while eBay's search is behind, and sold cards come off at the next refresh.

The site only reads. The Worker makes two eBay calls with the sign-in: `GetUser`, to check it's your account, and `GetMyeBaySelling`, for your active listings. Nothing in the code lists, edits, ends or buys anything. The sign-in itself is saved in Cloudflare KV storage, not in the code or on the page.

**One-time setup:**

1. On [developer.ebay.com](https://developer.ebay.com), go to **Application Keys**. Next to your **Production** keyset, click **User Tokens**.
2. Under **Get a Token from eBay via Your Application**, click **Add eBay Redirect URL** and fill in:
   - **Display title:** TerpCards
   - **Your privacy policy URL:** `https://terp.cards/`
   - **Your auth accepted URL:** `https://terp.cards/api/ebay/callback`
   - **Your auth declined URL:** `https://terp.cards/api/ebay/callback`
   - Choose **OAuth** (not Auth'n'Auth), then **Save**.
3. Copy the **RuName** eBay shows for it. It looks like `Jason_Burtnick-JasonBur-TerpCa-abcdefg`. It isn't secret. Put it in `wrangler.jsonc`:
   ```jsonc
   "EBAY_RUNAME": "paste-the-runame-here",
   ```
4. Push. Once the Worker is deployed, open **https://terp.cards/api/ebay/connect**, sign in as **terpcards**, and click **Agree**. You'll land on an "eBay connected" page. It only accepts the `EBAY_SELLER` account, so signing in as anyone else is refused.
5. Within 15 minutes, **Most popular** appears in the sort menu.

The sign-in is saved in the same Cloudflare KV storage as the Whatnot stats, so the KV setup under "Whatnot stats" is needed for this too. It lasts about 18 months. A month before it runs out, the site emails `CONTACT_TO` a reminder, and it emails again if it ever stops working (for example after you change your eBay password). In both cases, open the connect link again. Until you do, the site keeps working from eBay's search the old way, without the Most popular sort. To disconnect, remove the app under **eBay → Account settings → Third-party app access**.

## The Whatnot box

With your Whatnot token connected (below), the box follows your real Whatnot schedule:

- **Up next:** the title of your next scheduled show, linked to its page on Whatnot, with a ticking countdown to its actual start time. Bonus shows, skipped weeks and time changes show up on their own.
- **Live:** when Whatnot says you're live, the box switches to "We're live now!" with the show's title, and the button becomes **Join the show**, linked straight to it. The site checks about once a minute.
- **Starting any minute:** if the scheduled time passes and you haven't gone live yet, the box says so instead of claiming you're live.
- **Add next show to calendar** adds your next scheduled show, with its title and link.

Without the token, or if Whatnot can't be reached, the box falls back to the weekly schedule in `public/app.js`:

```js
show: { weekday: 3, hour: 17, minute: 30, timeZone: 'America/New_York', lengthMinutes: 120 },
```

`lengthMinutes` is how long a show runs, used for calendar entries and for the fallback "We're live now!" window. If your regular day or time changes, update it there and in the "Every Wednesday at 5:30 PM ET" line in `public/index.html`.

### Connecting Whatnot

1. In Whatnot's developer dashboard, create a personal access token with read-only permissions (`read:shows` is all the box needs).
2. In Cloudflare, open your Worker, go to **Settings → Variables and Secrets**, and add `WHATNOT_API_TOKEN` with the type **Secret**.
3. For testing on your computer, add `WHATNOT_API_TOKEN=...` to `.dev.vars`. `npm run check:whatnot` prints what Whatnot returns for your account and saves the details to `whatnot-check.json` (git-ignored, since it includes sales numbers).

The page only ever receives your shows' IDs, titles and start times, plus the two lifetime stats below. Show links use `whatnotShowUrl` in the settings block of `public/app.js`.

### Whatnot stats

At the bottom of the box: your lifetime **sold on Whatnot** count and your **reviews**, like "5.0 ★ · 1.7k reviews".

- **Sold** is counted from your order list, back to your first show, the same way your Whatnot profile's "sold" number adds up: auctions and Buy It Now that are completed or paid and waiting to ship, plus giveaways that are waiting to ship. Cancelled and failed orders don't count. It's shown the way Whatnot shows it, like **8.7k** (rounded up to the next hundred; under 1,000 the exact number). Hover over it to see the exact count. The rule is `isSale` in `lib/whatnot.js`, and the rounding is `compactCount` in `public/app.js`.
- **Reviews** are typed in by you, because Whatnot's API doesn't share them. Copy the star rating and review count from your Whatnot profile into `whatnotReviews` in the settings block of `public/app.js` every month or two:
  ```js
  whatnotReviews: { rating: 5.0, count: 1700 },   // shows "5.0 ★" and "1.7k reviews"
  ```
  These show even before the Whatnot connection is set up. If you set `count` to 0, the box shows the average of your shows' viewer ratings from Whatnot's show stats instead (November 2025 on; Whatnot didn't calculate stats for earlier shows).

How it stays current: every 15 minutes (the `"triggers"` line in `wrangler.jsonc`), the Worker adds new orders and newly finished shows. Orders older than 3 days are counted once and saved in Cloudflare KV storage; newer ones are recounted each time, in case a payment fails or an order is cancelled. The very first count goes through your whole history over a couple of hours, and each stat appears once it's fully counted. During a show, the sales number climbs as you sell.

The stats need a KV namespace, which is free:

1. In the Cloudflare dashboard, go to **Storage & databases → Workers KV → Create instance**, name it `terpcards-whatnot-stats`, and create it.
2. Copy its **ID** and put it in `wrangler.jsonc`:
   ```jsonc
   "kv_namespaces": [
     { "binding": "WHATNOT_STATS", "id": "paste-the-id-here" }
   ],
   ```
3. Push. The stats show up within a few hours.

`npm run check:whatnot` also prints the sales number the site will show, plus a breakdown of your orders, if you want to check it.

## How the feed works

- `lib/ebay.js` gets an OAuth app token (cached for about two hours), then calls `item_summary/search` filtered to your seller name, for both Buy It Now and auction listings. Auctions with bids are left out by eBay unless you ask for them, so the filter asks.
- It pages through up to `EBAY_MAX_ITEMS` (500 in `wrangler.jsonc`), drops duplicates, upgrades photo URLs to a sharper size, and returns newest first.
- The Worker asks eBay at most once every 15 minutes (`FRESH_SECONDS` in `src/worker.js`). Each saved copy carries the time it was fetched, and that time decides whether it's still fresh. Copies are shared between Cloudflare's servers in the same location, so one fetch serves everyone nearby, and every request uses the newest copy available, so a reload never goes back to an older list.
- Browsers don't cache the feed; they always ask the Worker, which answers from its saved copy.
- With your eBay account connected (above), each refresh also reads your active listings from the account itself (`lib/ebay-account.js`). Cards eBay's search left out are looked up directly and added, and cards that are no longer active come off, so the site matches your account. If that read fails, the refresh falls back to the search alone, as below.
- Without the account connected, eBay's search sometimes leaves out listings that are still for sale, especially while you're listing or editing. When a card the site already had goes missing from the search, the Worker looks that listing up directly: it stays on the site while it's still for sale and comes off once eBay says it sold or ended. If eBay won't answer either way, a card is kept for at most 6 hours. Brand-new listings appear once eBay's search has included them at least once.
- If eBay has an outage, the Worker serves the newest copy it has, up to a day old.
- Two response headers tell you what happened: `X-Listings-Source` (`memory`, `shared`, `ebay` or `backup`) and `X-Listings-Age` (seconds since that copy was fetched). Check them with `curl -sI https://terp.cards/api/listings`.
- Errors return a generic message to the browser. The details show up in the Worker's **Logs** tab in the dashboard.

## Hosting somewhere else

The Worker uses the standard `fetch(request) → Response` handler, so it also ports to Netlify or Vercel. Note that Vercel's free plan doesn't allow commercial sites, so there a shop site needs its $20/month Pro plan.
