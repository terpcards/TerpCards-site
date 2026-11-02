# TerpCards site

A one-page card shop site. The main section is a live grid of your active eBay listings. Each card links to its eBay listing and has a **Make an offer** button that opens the contact form with that card filled in. Below the grid, an **I buy cards** section invites people selling cards to get in touch. Above the grid, visitors can narrow the cards to graded or raw, and your eBay feedback shows near the top of the page. There's also a Whatnot block that counts down to your Wednesday 5:30 PM ET show and converts the time for visitors in other time zones.

It runs on **Cloudflare Workers' free plan**. The page files are served free with no limit, and only the listings feed (`/api/listings`) counts toward the free 100,000 requests a day, which caching keeps to a tiny fraction. Your only ongoing cost is the yearly domain renewal.

```
public/index.html       the page
public/styles.css       all styling (colors and fonts are at the top)
public/app.js           page behavior; your links and show schedule are at the top
src/worker.js           Cloudflare Worker: /api/listings (your eBay listings) and /api/contact (the form)
lib/ebay.js             talks to eBay's Browse API (token, paging, cleanup)
lib/contact.js          checks contact form messages and turns them into an email
wrangler.jsonc          Cloudflare settings, including your eBay username
scripts/check-ebay.mjs  tests your eBay keys from the terminal
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
| `183454` | Non-sport trading card singles (Pokémon etc.) |

Use several with commas: `"212,183454"`. eBay only allows one category per request, so each one is fetched separately and merged.

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

If the logo ever changes, replace these with files of the same names and sizes.

## Listings per page

The grid shows 24 cards per page with page numbers underneath. To change that, edit `perPage: 24` in the settings block at the top of `public/app.js`.

## Graded / Raw buttons

The **Graded** and **Raw** buttons above the grid sort cards by their titles. A title counts as graded when it names a grading company with a grade ("PSA 10", "BGS 9.5", "SGC Mint 9", "PSA10"), says "Authentic", or uses the words "graded" or "slab". Words like "raw", "candidate", "worthy" or "PSA ready" mark a card as raw, even when a grading company is named. Tap a button again to show everything.

The grading companies it knows are in `GRADERS` in `public/app.js` (PSA, BGS, BVG, SGC, CGC, CSG, TAG, HGA, Beckett, MBA, ISA, GMA, KSA). Add another with a `|` if you sell cards graded elsewhere.

## eBay feedback badge

Under the buttons at the top, the site shows your eBay feedback, like "99.8% positive feedback on eBay (1,234)", linked to your feedback page. It comes from eBay along with your listings, so it stays current on its own. It only shows while your feedback is at least `feedbackMinPercent` (98 by default) in the settings block of `public/app.js`; set that to 101 to hide it.

## The Whatnot box

The countdown, the "Join the show" switch while you're live, and the **Add next show to calendar** button all come from one setting in `public/app.js`:

```js
show: { weekday: 3, hour: 17, minute: 30, timeZone: 'America/New_York', lengthMinutes: 120 },
```

`lengthMinutes: 120` is the live window: from 5:30 to 7:30 PM ET the box says "We're live now!" and the button becomes "Join the show". If the show moves or runs longer, change it there (and the "Every Wednesday at 5:30 PM ET" line in `public/index.html`). The calendar options add the upcoming show (next week's, if you're live right now) with your Whatnot link and a 15-minute reminder: one opens Google Calendar, the other downloads a calendar file for Apple Calendar, Outlook and others.

## How the feed works

- `lib/ebay.js` gets an OAuth app token (cached for about two hours), then calls `item_summary/search` filtered to your seller name, for both Buy It Now and auction listings. Auctions with bids are left out by eBay unless you ask for them, so the filter asks.
- It pages through up to `EBAY_MAX_ITEMS` (default 200), drops duplicates, upgrades photo URLs to a sharper size, and returns newest first.
- The Worker asks eBay at most once every 15 minutes (`FRESH_SECONDS` in `src/worker.js`). Each saved copy carries the time it was fetched, and that time decides whether it's still fresh. Copies are shared between Cloudflare's servers in the same location, so one fetch serves everyone nearby.
- Browsers don't cache the feed; they always ask the Worker, which answers from its saved copy.
- If eBay has an outage, the Worker serves the newest copy it has, up to a day old.
- Two response headers tell you what happened: `X-Listings-Source` (`memory`, `shared`, `ebay` or `backup`) and `X-Listings-Age` (seconds since that copy was fetched). Check them with `curl -sI https://terp.cards/api/listings`.
- Errors return a generic message to the browser. The details show up in the Worker's **Logs** tab in the dashboard.

## Hosting somewhere else

The Worker uses the standard `fetch(request) → Response` handler, so it also ports to Netlify or Vercel. Note that Vercel's free plan doesn't allow commercial sites, so there a shop site needs its $20/month Pro plan.
