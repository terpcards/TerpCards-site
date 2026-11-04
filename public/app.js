// ---------------------------------------------------------------------------
// Edit these to match your accounts. Leave a URL empty to hide its links.
// ---------------------------------------------------------------------------
const SITE = {
  ebaySeller: 'terpcards',
  ebayStoreUrl: 'https://www.ebay.com/str/terpcards',   // every eBay link on the page goes here
  whatnotUrl: 'https://www.whatnot.com/user/terpcards',
  youtubeUrl: '',   // e.g. 'https://www.youtube.com/@yourchannel'
  instagramUrl: 'https://www.instagram.com/terpcards/',
  xUrl: 'https://x.com/TerpCards',

  // Weekly Whatnot show. weekday: 0 = Sunday ... 3 = Wednesday.
  // When the Whatnot connection is set up (WHATNOT_API_TOKEN in Cloudflare), the box uses
  // your real schedule and live status from Whatnot, and this is only the backup.
  show: { weekday: 3, hour: 17, minute: 30, timeZone: 'America/New_York', lengthMinutes: 120 },

  // Link to one show on Whatnot; {id} is replaced with the show's ID.
  whatnotShowUrl: 'https://www.whatnot.com/live/{id}',

  // Your Whatnot reviews, copied from your Whatnot profile (Whatnot's API doesn't share them).
  // Update these now and then. count is shown like Whatnot shows it: 1700 -> "1.7k reviews".
  // Set count to 0 to show the average show rating from Whatnot's show stats instead.
  whatnotReviews: { rating: 5.0, count: 1800 },

  apiUrl: '/api/listings',
  whatnotApiUrl: '/api/whatnot',
  contactUrl: '/api/contact',

  // How many cards to show per page in the listings grid.
  perPage: 24,

  // Your eBay feedback shows next to the "On eBay now" heading, but only while it's at
  // least this percent positive. Set it to 101 to hide it.
  feedbackMinPercent: 98,

  // When the eBay feed has no listings to give (no API keys yet, or a long eBay outage):
  //   'local' = show sample cards only when you open the site on your own computer,
  //             and a "Shop my eBay store" section everywhere else (recommended)
  //   true    = always show sample cards     false = never show them
  sampleWhenOffline: 'local',
};

// True when the page is opened from your computer rather than your real domain.
function isLocalPreview() {
  const host = location.hostname;
  return location.protocol === 'file:' || host === '' || host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

function useSamples() {
  return SITE.sampleWhenOffline === true || (SITE.sampleWhenOffline === 'local' && isLocalPreview());
}

// ---------------------------------------------------------------------------

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  items: [],
  filter: 'all',
  grade: 'any', // 'any' | 'graded' | 'raw'
  query: '',
  sort: 'new',
  page: 1,
  sellerUrl: '',
  updatedAt: null,
  sample: false,
};

document.addEventListener('DOMContentLoaded', () => {
  $('[data-year]').textContent = new Date().getFullYear();
  wireLinks();
  startShowClock();
  bindCalendar();
  showWhatnotStats(null);
  loadWhatnot();
  showSkeletons(8);
  bindControls();
  bindContactForm();
  loadListings();
});

// ---------- Links ----------

function sellerUrl(seller) {
  return seller ? `https://www.ebay.com/sch/i.html?_ssn=${encodeURIComponent(seller)}` : '';
}

// Your eBay Store page if set, otherwise a search for everything you have listed.
function ebayLink() {
  return SITE.ebayStoreUrl || state.sellerUrl || sellerUrl(SITE.ebaySeller);
}

function wireLinks() {
  const urls = {
    ebay: ebayLink(),
    whatnot: SITE.whatnotUrl,
    youtube: SITE.youtubeUrl,
    instagram: SITE.instagramUrl,
    x: SITE.xUrl,
  };
  for (const el of $$('[data-link]')) {
    const url = urls[el.dataset.link];
    if (url) {
      el.href = url;
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }
  // The offer note and "message directly" line only make sense with X or Instagram set.
  const hasSocial = Boolean(SITE.xUrl || SITE.instagramUrl);
  for (const el of $$('[data-needs-social]')) el.hidden = !hasSocial;
}

// ---------- Contact form ----------

// Message box hint for each topic.
const TOPIC_HINTS = {
  offer: 'Your offer, and anything else I should know',
  card: 'Which card, and what would you like to know?',
  sell: 'What do you have? Players, sets, grades or condition, and your asking price if you have one.',
  other: 'Your message',
};
const OFFER_START = 'My offer: $';

// Set by bindContactForm; lets each tile's "Make an offer" button fill in the form.
let contactForm = null;

function startOffer(item) {
  if (!contactForm) return;
  contactForm.setTopic('offer', { title: item.title, url: item.url });
  const message = contactForm.form.elements.message;
  if (!message.value.trim() || message.value.startsWith(OFFER_START)) message.value = OFFER_START;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  $('#contact').scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  // Put the cursor right after the "$" so they can type their number.
  setTimeout(() => {
    message.focus({ preventScroll: true });
    message.setSelectionRange(message.value.length, message.value.length);
  }, reduce ? 0 : 450);
}

function bindContactForm() {
  const form = $('[data-contact-form]');
  if (!form) return;
  const status = $('[data-form-status]');
  const button = $('[data-contact-submit]');
  const topic = $('[data-topic-select]');
  const chip = $('[data-offer-card]');
  const shownAt = performance.now();

  // The card an offer or question is about, shown above the message box.
  const setCard = (card) => {
    form.elements.cardTitle.value = card ? card.title : '';
    form.elements.cardUrl.value = card ? card.url || '' : '';
    $('[data-offer-card-title]').textContent = card ? card.title : '';
    chip.hidden = !card;
  };
  const setTopic = (value, card = null) => {
    topic.value = value;
    form.elements.message.placeholder = TOPIC_HINTS[value] || TOPIC_HINTS.other;
    setCard(value === 'offer' || value === 'card' ? card : null);
  };
  contactForm = { form, setTopic };

  topic.addEventListener('change', () => {
    const keep = form.elements.cardTitle.value ? { title: form.elements.cardTitle.value, url: form.elements.cardUrl.value } : null;
    setTopic(topic.value, keep);
  });
  $('[data-offer-card-clear]').addEventListener('click', () => {
    setCard(null);
    if (form.elements.message.value === OFFER_START) form.elements.message.value = '';
    form.elements.message.focus();
  });
  setTopic(topic.value);

  // Links like "Or use the contact form" and "Tell me what you have" preselect the topic.
  for (const link of $$('a[data-topic]')) {
    link.addEventListener('click', () => {
      setTopic(link.dataset.topic);
      setTimeout(() => form.elements.contact.focus({ preventScroll: true }), 400);
    });
  }

  const setStatus = (state, ...parts) => {
    status.dataset.state = state;
    status.replaceChildren(...parts);
  };

  // "Message me on X or Instagram instead", with whichever of those links are set.
  const dmFallback = () => {
    const links = [
      SITE.xUrl && el('a', { href: SITE.xUrl, target: '_blank', rel: 'noopener' }, 'X'),
      SITE.instagramUrl && el('a', { href: SITE.instagramUrl, target: '_blank', rel: 'noopener' }, 'Instagram'),
    ].filter(Boolean);
    if (!links.length) return [];
    return [' Message me on ', ...links.flatMap((a, i) => (i ? [' or ', a] : [a])), ' instead.'];
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;

    const data = Object.fromEntries(new FormData(form));
    data.elapsedMs = Math.round(performance.now() - shownAt);

    button.disabled = true;
    button.textContent = 'Sending…';
    setStatus('pending', '');

    try {
      const res = await fetch(SITE.contactUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(data),
      });
      const out = await res.json().catch(() => ({}));

      if (res.ok && out.ok) {
        form.reset();
        setTopic(topic.value);
        setStatus('ok', 'Sent. Thanks! I’ll get back to you using the contact info you left.');
      } else if (out.error && res.status !== 503) {
        setStatus('error', out.error);
      } else {
        throw new Error(out.error || `Contact form returned ${res.status}`);
      }
    } catch (err) {
      console.warn('Contact form:', err.message);
      if (isLocalPreview()) {
        setStatus('error', 'The form isn’t connected yet. It starts sending once the site is live and email is set up (README, step 6).');
      } else {
        setStatus('error', 'Your message couldn’t be sent right now.', ...dmFallback());
      }
    } finally {
      button.disabled = false;
      button.textContent = 'Send message';
    }
  });
}

// ---------- Whatnot show countdown ----------

function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

function offsetMs(date, timeZone) {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

// Wall-clock time in a time zone -> real instant (handles daylight saving changes).
function zonedTime(year, month, day, hour, minute, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let t = guess - offsetMs(new Date(guess), timeZone);
  const corrected = guess - offsetMs(new Date(t), timeZone);
  if (corrected !== t) t = corrected;
  return new Date(t);
}

function nextShow(now, show) {
  const today = zonedParts(now, show.timeZone);
  for (let add = 0; add <= 7; add++) {
    const day = new Date(Date.UTC(today.year, today.month - 1, today.day + add));
    if (day.getUTCDay() !== show.weekday) continue;
    const start = zonedTime(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), show.hour, show.minute, show.timeZone);
    const end = new Date(start.getTime() + show.lengthMinutes * 60000);
    if (now < end) return { start, end, live: now >= start };
  }
  return null;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function untilText(ms) {
  const mins = Math.max(1, Math.round(ms / 60000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return h ? `${plural(d, 'day')}, ${plural(h, 'hour')}` : plural(d, 'day');
  if (h > 0) return m ? `${plural(h, 'hour')}, ${plural(m, 'minute')}` : plural(h, 'hour');
  return plural(m, 'minute');
}

// ---------- Your real schedule from Whatnot ----------
// /api/whatnot says whether you're live and lists your next scheduled shows. Until it
// answers (or if Whatnot isn't connected), the box uses the weekly schedule in SITE.show.

let whatnot = null; // { live, upcoming: [{ id, title, startsAt }], stale, at }

async function loadWhatnot() {
  try {
    const res = await fetch(SITE.whatnotApiUrl, { cache: 'no-store', headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Whatnot feed returned ${res.status}`);
    const data = await res.json();
    whatnot = {
      live: data.live || null,
      upcoming: Array.isArray(data.upcoming) ? data.upcoming.filter((s) => s.startsAt && !Number.isNaN(Date.parse(s.startsAt))) : [],
      stale: res.headers.get('X-Listings-Stale') === '1',
      at: Date.now(),
    };
    showWhatnotStats(data.stats);
  } catch (err) {
    if (whatnot && Date.now() - whatnot.at > 10 * 60000) whatnot = null; // too old to trust
    if (!whatnot) console.info('Using the weekly show schedule:', err.message);
  }
  // Check again every minute while the page is open, so "We're live now!" appears on time.
  clearTimeout(loadWhatnot.timer);
  loadWhatnot.timer = setTimeout(() => {
    if (document.visibilityState === 'visible') loadWhatnot();
    else document.addEventListener('visibilitychange', loadWhatnot, { once: true });
  }, 60000);
}

// 8,636 -> "8.7k", the way Whatnot shows counts: rounded up to the next tenth of a thousand
// (or million). Under 1,000 the exact number is shown. Same as compactCount in lib/whatnot.js.
function compactCount(n) {
  n = Math.max(0, Math.floor(Number(n) || 0));
  if (n < 1000) return String(n);
  const tenths = (unit) => Math.ceil(n / (unit / 10)) / 10;
  const k = tenths(1e3);
  if (k < 1000) return `${String(k).replace(/\.0$/, '')}k`;
  return `${String(tenths(1e6)).replace(/\.0$/, '')}M`;
}

// "8.7k sold on Whatnot" and "5.0★ 1.7k reviews" at the bottom of the box. Reviews come
// from SITE.whatnotReviews; without them, the average show rating from Whatnot is shown.
function showWhatnotStats(stats) {
  const box = $('[data-show-stats]');
  const reviews = SITE.whatnotReviews;
  const hasReviews = Boolean(reviews) && reviews.count > 0 && typeof reviews.rating === 'number';
  const hasSales = Boolean(stats) && stats.sales > 0;
  const rating = hasReviews ? reviews.rating : stats && typeof stats.rating === 'number' ? stats.rating : null;
  const hasRating = rating != null;
  if (!hasSales && !hasRating) {
    box.hidden = true;
    return;
  }
  $('[data-stat-sales-wrap]').hidden = !hasSales;
  if (hasSales) {
    const sales = $('[data-stat-sales]');
    sales.textContent = compactCount(stats.sales);
    sales.title = `${stats.sales.toLocaleString('en-US')} sold`;
  }
  $('[data-stat-rating-wrap]').hidden = !hasRating;
  if (hasRating) {
    $('[data-stat-rating-label]').textContent = hasReviews ? `${compactCount(reviews.count)} reviews` : 'Average show rating';
    $('[data-stat-rating]').replaceChildren(
      rating.toFixed(1),
      el('span', { className: 'stat-star', 'aria-hidden': 'true' }, '★'),
      el('span', { className: 'sr-only' }, ' out of 5')
    );
  }
  box.hidden = false;
}

function showUrl(show) {
  if (show && show.id && SITE.whatnotShowUrl) return SITE.whatnotShowUrl.replace('{id}', encodeURIComponent(show.id));
  return SITE.whatnotUrl;
}

// What the box should show right now:
//   { start, end, state: 'upcoming' | 'starting' | 'live', title?, url? }
// 'starting' means the scheduled time has passed but Whatnot doesn't say you're live yet.
function currentShow(now = new Date()) {
  const lengthMs = SITE.show.lengthMinutes * 60000;
  if (whatnot) {
    if (whatnot.live && !whatnot.stale) {
      const start = whatnot.live.startsAt ? new Date(whatnot.live.startsAt) : now;
      return { start, end: new Date(Math.max(now, start.getTime() + lengthMs)), state: 'live', title: whatnot.live.title, url: showUrl(whatnot.live) };
    }
    const graceMs = Math.min(lengthMs, 60 * 60000); // how long to say "starting any minute"
    const next = whatnot.upcoming
      .map((s) => ({ ...s, start: new Date(s.startsAt) }))
      .find((s) => now - s.start < graceMs && !(whatnot.live && whatnot.live.id === s.id));
    if (next) {
      const state = now >= next.start ? 'starting' : 'upcoming';
      return { start: next.start, end: new Date(next.start.getTime() + lengthMs), state, title: next.title, url: showUrl(next), id: next.id };
    }
  }
  const fixed = nextShow(now, SITE.show);
  if (!fixed) return null;
  // With Whatnot connected, only Whatnot can say you're live.
  const state = fixed.live ? (whatnot ? 'starting' : 'live') : 'upcoming';
  return { start: fixed.start, end: fixed.end, state };
}

function startShowClock() {
  const box = $('[data-show]');
  const next = $('[data-show-next]');
  const local = $('[data-show-local]');
  const cta = $('[data-show-cta]');
  const name = $('[data-show-name]');
  const nameLabel = $('[data-show-name-label]');
  const nameLink = $('[data-show-name-link]');
  const clock = $('[data-countdown]');
  const digits = Object.fromEntries($$('[data-cd]').map((n) => [n.dataset.cd, n]));
  const labels = Object.fromEntries($$('[data-cd-label]').map((n) => [n.dataset.cdLabel, n]));
  const pad = (n) => String(n).padStart(2, '0');
  let spoken = '';
  let heading = '';

  const tick = () => {
    const now = new Date();
    const show = currentShow(now);
    if (!show) return;

    box.dataset.live = String(show.state === 'live');

    // The show's title from Whatnot, linked to its page: above the countdown, or under
    // "We're live now!" while you're live.
    const nameAfter = show.state === 'live';
    if (nameAfter && next.nextElementSibling !== name) next.after(name);
    if (!nameAfter && name.nextElementSibling !== next) next.before(name);
    if (show.title) {
      nameLabel.textContent = show.state === 'live' ? 'On now' : 'Up next';
      if (nameLink.textContent !== show.title) nameLink.textContent = show.title;
      nameLink.href = show.url;
      name.hidden = false;
    } else {
      name.hidden = true;
    }

    const viewerZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const sameClock = offsetMs(show.start, viewerZone) === offsetMs(show.start, SITE.show.timeZone);
    const fmt = (timeZone) =>
      new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(show.start);
    const when = sameClock ? `${fmt(SITE.show.timeZone)} ET` : `That's ${fmt(viewerZone)} your time.`;

    if (show.state === 'live' || show.state === 'starting') {
      const text = show.state === 'live' ? "We're live now!" : 'Starting any minute';
      if (heading !== text) {
        heading = text;
        next.replaceChildren(...(show.state === 'live' ? [el('span', { className: 'live-dot', 'aria-hidden': 'true' })] : []), text);
      }
      clock.hidden = true;
      local.textContent = show.state === 'live' ? '' : when;
      cta.textContent = show.state === 'live' ? 'Join the show' : 'Go to the show';
      cta.href = show.url || SITE.whatnotUrl;
      spoken = '';
      return;
    }

    cta.textContent = 'Follow on Whatnot';
    cta.href = SITE.whatnotUrl;
    clock.hidden = false;

    // The ticking digits are for the eye; screen readers get one sentence that changes
    // once a minute instead of every second.
    const ms = Math.max(0, show.start - now);
    const secs = Math.floor(ms / 1000);
    const d = Math.floor(secs / 86400);
    const h = Math.floor((secs % 86400) / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const sec = secs % 60;
    digits.d.textContent = d;
    digits.h.textContent = pad(h);
    digits.m.textContent = pad(m);
    digits.s.textContent = pad(sec);
    labels.d.textContent = d === 1 ? 'day' : 'days';

    const lead = show.title ? 'Starts in' : 'Next show starts in';
    const sentence = untilText(ms);
    if (sentence !== spoken || heading !== lead) {
      spoken = sentence;
      heading = lead;
      next.replaceChildren(lead, el('span', { className: 'sr-only' }, ` ${sentence}.`));
    }
    local.textContent = when;
  };

  // Tick right on each new second so the digits change in step with the real clock.
  const loop = () => {
    tick();
    setTimeout(loop, 1000 - (Date.now() % 1000) + 5);
  };
  loop();
}

// ---------- Add next show to calendar ----------
// Uses your next show from Whatnot when it's connected, otherwise the weekly schedule in SITE.show.

const SHOW_TITLE = 'TerpCards live on Whatnot';

// The show to add: the next one that hasn't started yet.
function calendarShow(now = new Date()) {
  const lengthMs = SITE.show.lengthMinutes * 60000;
  if (whatnot) {
    const next = whatnot.upcoming
      .map((s) => ({ ...s, start: new Date(s.startsAt) }))
      .find((s) => s.start > now && !(whatnot.live && whatnot.live.id === s.id));
    if (next) return { start: next.start, end: new Date(next.start.getTime() + lengthMs), title: next.title, url: showUrl(next) };
  }
  const show = nextShow(now, SITE.show);
  if (!show) return null;
  return show.live ? nextShow(new Date(show.end.getTime() + 1000), SITE.show) : show;
}

function calendarTitle(show) {
  return show.title ? `TerpCards on Whatnot: ${show.title}` : SHOW_TITLE;
}

function showDetails(show) {
  const lines = ['Live sports card show from TerpCards on Whatnot.'];
  const url = show.url || SITE.whatnotUrl;
  if (url) lines.push(`Join here: ${url}`);
  return lines.join('\n');
}

// 2026-11-04T22:30:00.000Z -> 20261104T223000Z
const calTime = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function googleCalendarUrl(show) {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: calendarTitle(show),
    dates: `${calTime(show.start)}/${calTime(show.end)}`,
    details: showDetails(show),
  });
  const url = show.url || SITE.whatnotUrl;
  if (url) params.set('location', url);
  return `https://calendar.google.com/calendar/render?${params}`;
}

// A standard calendar file (.ics) with a 15-minute reminder. Opens in Apple Calendar,
// Outlook and most other calendar apps.
function icsFile(show, now = new Date()) {
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  const fold = (line) => {
    if (line.length <= 75) return line;
    let out = line.slice(0, 75);
    for (let i = 75; i < line.length; i += 74) out += `\r\n ${line.slice(i, i + 74)}`;
    return out;
  };
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//TerpCards//Site//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:whatnot-show-${calTime(show.start)}@terpcards`,
    `DTSTAMP:${calTime(now)}`,
    `DTSTART:${calTime(show.start)}`,
    `DTEND:${calTime(show.end)}`,
    `SUMMARY:${esc(calendarTitle(show))}`,
    `DESCRIPTION:${esc(showDetails(show))}`,
    (show.url || SITE.whatnotUrl) && `LOCATION:${esc(show.url || SITE.whatnotUrl)}`,
    (show.url || SITE.whatnotUrl) && `URL:${show.url || SITE.whatnotUrl}`,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'TRIGGER:-PT15M',
    `DESCRIPTION:${esc(`${SHOW_TITLE} starts in 15 minutes`)}`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean).map(fold).join('\r\n') + '\r\n';
}

function bindCalendar() {
  const menu = $('details.cal');
  if (!menu) return;
  const google = $('[data-cal-google]');
  const ics = $('[data-cal-ics]');
  let fileUrl = null;

  const refresh = () => {
    const show = calendarShow();
    if (!show) return;
    google.href = googleCalendarUrl(show);
    if (fileUrl) URL.revokeObjectURL(fileUrl);
    fileUrl = URL.createObjectURL(new Blob([icsFile(show)], { type: 'text/calendar;charset=utf-8' }));
    ics.href = fileUrl;
    ics.download = 'terpcards-whatnot-show.ics';
  };

  refresh();
  menu.addEventListener('toggle', () => { if (menu.open) refresh(); });

  // Close the menu after a choice, on a click elsewhere, or with Escape.
  for (const link of [google, ics]) link.addEventListener('click', () => setTimeout(() => { menu.open = false; }, 0));
  document.addEventListener('click', (e) => { if (menu.open && !menu.contains(e.target)) menu.open = false; });
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menu.open) {
      menu.open = false;
      menu.querySelector('summary').focus();
    }
  });
}

// ---------- Listings ----------

async function loadListings() {
  try {
    const res = await fetch(SITE.apiUrl, { cache: 'no-store', headers: { Accept: 'application/json' } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !Array.isArray(data.items)) throw new Error(data.error || `Feed returned ${res.status}`);

    state.items = data.items;
    state.feedback = data.feedback || null;
    state.sellerUrl = data.sellerUrl || '';
    state.updatedAt = data.updatedAt ? new Date(data.updatedAt) : new Date();
  } catch (err) {
    // No eBay keys yet (or eBay has been down for over a day). Once keys are added in
    // Cloudflare, the feed starts answering and the live grid shows up on its own.
    console.warn('Listings feed unavailable:', err.message);
    if (!useSamples()) {
      showStoreSection();
      return;
    }
    state.items = sampleListings();
    state.feedback = { percent: 100, score: 1234, url: '#' }; // sample, only on your computer
    state.sample = true;
    state.updatedAt = new Date();
    const notice = $('[data-notice]');
    notice.textContent = 'These are sample listings, shown only on your computer. On your live site, visitors see a "Shop my eBay store" section until your eBay keys are added.';
    notice.hidden = false;
  }

  for (const item of state.items) item.graded = isGraded(item.title);
  showPopularSort();
  wireLinks();
  showFeedback();
  $('[data-controls]').hidden = state.items.length === 0;
  render();
}

// "★ 99.8% positive feedback (1,234)" next to the "On eBay now" heading.
function showFeedback() {
  const badge = $('[data-feedback]');
  const fb = state.feedback;
  if (!fb || !(fb.percent >= (SITE.feedbackMinPercent ?? 0))) {
    badge.hidden = true;
    return;
  }
  const percent = `${fb.percent.toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;
  const score = fb.score != null ? fb.score.toLocaleString('en-US') : '';
  $('[data-feedback-percent]', badge).textContent = `${percent} positive feedback`;
  $('[data-feedback-score]', badge).textContent = score ? `(${score})` : '';
  badge.setAttribute('aria-label', `${percent} positive feedback on eBay${score ? `, feedback score ${score}` : ''}. Opens eBay.`);
  badge.href = fb.url || ebayLink();
  badge.hidden = false;
}

// Shown instead of the grid when there are no live listings to display.
function showStoreSection() {
  $('[data-grid]').replaceChildren();
  $('[data-grid]').hidden = true;
  $('[data-controls]').hidden = true;
  $('[data-status]').textContent = '';
  $('[data-status]').hidden = true;
  $('[data-see-all]').hidden = true; // the store section has its own, bigger button
  $('[data-store]').hidden = false;
}

function bindControls() {
  for (const btn of $$('[data-filter]')) {
    btn.addEventListener('click', () => {
      state.filter = btn.dataset.filter;
      state.page = 1;
      for (const b of $$('[data-filter]')) b.setAttribute('aria-pressed', String(b === btn));
      render();
    });
  }
  // Graded / Raw: pick one to narrow the grid, tap it again to show both.
  for (const btn of $$('[data-grade]')) {
    btn.addEventListener('click', () => {
      state.grade = state.grade === btn.dataset.grade ? 'any' : btn.dataset.grade;
      state.page = 1;
      for (const b of $$('[data-grade]')) b.setAttribute('aria-pressed', String(b.dataset.grade === state.grade));
      render();
    });
  }
  let timer;
  $('[data-search]').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.query = e.target.value; state.page = 1; render(); }, 120);
  });
  $('[data-sort]').addEventListener('change', (e) => { state.sort = e.target.value; state.page = 1; render(); });

  // Page buttons below the grid.
  $('[data-pager]').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-page]');
    if (!btn || btn.disabled) return;
    goToPage(Number(btn.dataset.page));
  });

  // Keep auction countdowns honest without refetching.
  setInterval(() => { if (state.items.some((i) => i.isAuction)) render(); }, 60000);
}

function shownPrice(item) {
  return item.isAuction && item.currentBid ? item.currentBid : item.price;
}

function matchesFilter(item) {
  if (state.grade === 'graded' && !item.graded) return false;
  if (state.grade === 'raw' && item.graded) return false;
  if (state.filter === 'bin') return item.isBuyItNow;
  if (state.filter === 'auction') return item.isAuction;
  return true;
}

// Graded or raw, from the listing title. A grading company with a grade ("PSA 10",
// "BGS 9.5", "SGC Mint 9", "PSA10") or "Authentic" counts as graded, as do the words
// "graded" and "slab". Words like "raw", "candidate" or "PSA ready" mean raw, even
// when a grading company is named.
const GRADERS = 'PSA|BGS|BVG|SGC|CGC|CSG|TAG|HGA|Beckett|MBA|ISA|GMA|KSA';
const GRADE_WORDS = '(?:gem|mint|mt|nm|pristine|black\\s*label|bl)';
const GRADED_RE = new RegExp(`\\b(?:${GRADERS})[\\s#:-]*(?:${GRADE_WORDS}\\b[\\s-]*)*(?:10|[1-9](?:\\.5)?)(?![\\d.])`, 'i');
const AUTH_RE = new RegExp(`\\b(?:${GRADERS})\\b[\\s#:-]*(?:authentic|auth|altered)\\b`, 'i');
const SLAB_RE = /\b(?:graded|slab|slabbed)\b/i;
const RAW_RE = new RegExp([
  '\\b(?:raw|ungraded|candidate|worthy|potential)\\b',
  '\\bnot\\s+graded\\b',
  '\\bgrad(?:e|ing)\\s+ready\\b',
  `\\b(?:${GRADERS})[\\s-]*ready\\b`,
  `\\b(?:${GRADERS})\\s*(?:10|[1-9](?:\\.5)?)\\s*\\?`,
].join('|'), 'i');

function isGraded(title) {
  const text = String(title || '');
  if (RAW_RE.test(text)) return false;
  return GRADED_RE.test(text) || AUTH_RE.test(text) || SLAB_RE.test(text);
}

function matchesQuery(item) {
  const words = state.query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${item.title} ${item.condition || ''}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

// "Most popular" orders cards by how many people watch them on eBay. The site only gets each
// card's position (popular: 1 = most watched), never the watcher counts, and the option only
// appears once your eBay account is connected (README: "Connect your eBay account").
function showPopularSort() {
  const select = $('[data-sort]');
  const has = state.items.some((i) => Number.isFinite(i.popular));
  let option = select.querySelector('option[value="popular"]');
  if (has && !option) {
    option = el('option', { value: 'popular' }, 'Most popular');
    select.insertBefore(option, select.options[1] || null);
  } else if (!has && option) {
    if (state.sort === 'popular') state.sort = 'new';
    option.remove();
    select.value = state.sort;
  }
}

const sorters = {
  popular: (a, b) => (a.popular ?? Infinity) - (b.popular ?? Infinity) || (Date.parse(b.listedAt) || 0) - (Date.parse(a.listedAt) || 0),
  new: (a, b) => (Date.parse(b.listedAt) || 0) - (Date.parse(a.listedAt) || 0),
  low: (a, b) => (shownPrice(a)?.value ?? Infinity) - (shownPrice(b)?.value ?? Infinity),
  high: (a, b) => (shownPrice(b)?.value ?? -Infinity) - (shownPrice(a)?.value ?? -Infinity),
  ending: (a, b) => (Date.parse(a.endsAt) || Infinity) - (Date.parse(b.endsAt) || Infinity),
};

function render() {
  const all = state.items;
  $('[data-count="all"]').textContent = all.length;
  $('[data-count="bin"]').textContent = all.filter((i) => i.isBuyItNow).length;
  $('[data-count="auction"]').textContent = all.filter((i) => i.isAuction).length;
  $('[data-count="graded"]').textContent = all.filter((i) => i.graded).length;
  $('[data-count="raw"]').textContent = all.filter((i) => !i.graded).length;

  const shown = all.filter(matchesFilter).filter(matchesQuery).sort(sorters[state.sort]);
  const perPage = Math.max(1, SITE.perPage || 24);
  const pages = Math.max(1, Math.ceil(shown.length / perPage));
  state.page = Math.min(Math.max(1, state.page), pages);
  const start = (state.page - 1) * perPage;
  const pageItems = shown.slice(start, start + perPage);
  $('[data-grid]').replaceChildren(...pageItems.map(tile));
  renderPager(shown.length, pages, start, pageItems.length);

  const status = $('[data-status]');
  if (state.sample) {
    status.textContent = `${plural(all.length, 'sample listing')}`;
  } else {
    status.textContent = `${plural(all.length, 'listing')}, updated ${agoText(state.updatedAt)}`;
  }

  const empty = $('[data-empty]');
  if (all.length === 0) {
    const url = ebayLink();
    empty.replaceChildren(
      el('p', {}, 'Nothing is listed on eBay right now. New cards usually show up after the weekly Whatnot show.'),
      SITE.whatnotUrl ? el('a', { className: 'btn btn-primary', href: SITE.whatnotUrl, target: '_blank', rel: 'noopener' }, 'Follow on Whatnot') : '',
      !SITE.whatnotUrl && url ? el('a', { className: 'btn btn-primary', href: url, target: '_blank', rel: 'noopener' }, 'Check eBay') : ''
    );
    empty.hidden = false;
  } else if (shown.length === 0) {
    const clear = el('button', { className: 'btn btn-outline', type: 'button' }, 'Show all listings');
    clear.addEventListener('click', resetView);
    const what = state.query.trim() ? `match “${state.query.trim()}”` : 'fit that filter';
    empty.replaceChildren(el('p', {}, `No listings ${what}.`), clear);
    empty.hidden = false;
  } else {
    empty.hidden = true;
  }
}

// Page numbers to show: always the first and last, plus the current page and its neighbours,
// with gaps marked by "…". For example, page 6 of 12: 1 … 5 6 7 … 12
function pageList(current, pages) {
  const want = new Set([1, pages, current - 1, current, current + 1]);
  if (current <= 3) [2, 3, 4].forEach((n) => want.add(n));
  if (current >= pages - 2) [pages - 1, pages - 2, pages - 3].forEach((n) => want.add(n));
  const nums = [...want].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  const out = [];
  nums.forEach((n, i) => {
    if (i && n - nums[i - 1] > 1) out.push(n - nums[i - 1] === 2 ? n - 1 : '…');
    out.push(n);
  });
  return out;
}

function renderPager(total, pages, start, count) {
  const pager = $('[data-pager]');
  if (pages <= 1) {
    pager.hidden = true;
    pager.replaceChildren();
    return;
  }
  pager.hidden = false;

  const button = (content, page, { disabled = false, current = false, aria } = {}) => {
    const b = el('button', { type: 'button', className: `page-btn${current ? ' is-current' : ''}` }, ...[content].flat());
    b.dataset.page = page;
    if (aria) b.setAttribute('aria-label', aria);
    if (current) b.setAttribute('aria-current', 'page');
    b.disabled = disabled;
    return b;
  };

  const list = el('div', { className: 'pager-pages' });
  // Words on wider screens, arrows on phones (CSS picks which one shows).
  const label = (long, short) => [el('span', { className: 'pg-long' }, long), el('span', { className: 'pg-short' }, short)];
  list.append(button(label('Previous', '‹'), state.page - 1, { disabled: state.page === 1, aria: 'Previous page' }));
  for (const n of pageList(state.page, pages)) {
    if (n === '…') list.append(el('span', { className: 'page-gap', 'aria-hidden': 'true' }, '…'));
    else list.append(button(String(n), n, { current: n === state.page, aria: `Page ${n}` }));
  }
  list.append(button(label('Next', '›'), state.page + 1, { disabled: state.page === pages, aria: 'Next page' }));

  pager.replaceChildren(
    el('p', { className: 'pager-count' }, `Showing ${start + 1}–${start + count} of ${total}`),
    list
  );
}

function goToPage(n) {
  state.page = n;
  render();
  // Bring the top of the grid back into view, and move keyboard focus there too.
  const top = $('[data-controls]').hidden ? $('#listings') : $('[data-controls]');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  top.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  $('[data-grid]').focus({ preventScroll: true });
}

function resetView() {
  state.filter = 'all';
  state.grade = 'any';
  state.query = '';
  state.page = 1;
  $('[data-search]').value = '';
  for (const b of $$('[data-filter]')) b.setAttribute('aria-pressed', String(b.dataset.filter === 'all'));
  for (const b of $$('[data-grade]')) b.setAttribute('aria-pressed', 'false');
  render();
}

function tile(item) {
  const price = shownPrice(item);
  const meta = [];

  if (item.isAuction) {
    meta.push(item.bidCount ? plural(item.bidCount, 'bid') : 'No bids yet');
    const left = timeLeft(item.endsAt);
    if (left) meta.push(left);
  } else if (item.acceptsOffers) {
    meta.push('or Best Offer');
  }
  if (item.shipping) {
    meta.push(item.shipping.value === 0 ? 'Free shipping' : `+${money(item.shipping)} ship`);
  }

  const metaEl = el('span', { className: 'tile-meta' });
  meta.forEach((part, i) => {
    if (i) metaEl.append(', ');
    metaEl.append(part); // a string, or a <span> for auctions ending soon
  });

  // The title is already in the tile's text, so the photo doesn't repeat it to screen readers.
  const photo = el('div', { className: 'tile-photo' },
    item.image ? cardPhoto(item.image) : el('span', { className: 'tile-photo-empty' }, 'Photo on eBay')
  );

  const kind = item.isAuction
    ? el('span', { className: 'kind kind-auction' }, 'Auction')
    : el('span', { className: 'kind kind-bin', title: 'Buy It Now' },
        el('span', { className: 'kind-long' }, 'Buy It Now'),
        el('span', { className: 'kind-short', 'aria-hidden': 'true' }, 'BIN'));

  const offer = el('button', { type: 'button', className: 'tile-offer', 'aria-label': `Make an offer on ${item.title}` },
    el('span', { className: 'offer-long' }, 'Make an offer'),
    el('span', { className: 'offer-short' }, 'Offer'));
  offer.addEventListener('click', () => startOffer(item));

  return el('li', { className: 'tile' },
    el('div', { className: 'tile-card' },
      el('a', { className: 'tile-link', href: item.url, target: '_blank', rel: 'noopener' },
        photo,
        el('div', { className: 'tile-info' },
          el('div', { className: 'tile-row' },
            el('span', { className: 'tile-price' }, price ? money(price) : ''),
            kind
          ),
          el('p', { className: 'tile-title' }, item.title),
          metaEl
        )
      ),
      offer
    )
  );
}

function timeLeft(endsAt) {
  const end = Date.parse(endsAt);
  if (!end) return '';
  const ms = end - Date.now();
  if (ms <= 0) return 'Ended';
  const mins = Math.floor(ms / 60000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  const text = d ? `${d}d ${h}h left` : h ? `${h}h ${m}m left` : `${Math.max(m, 1)}m left`;
  if (ms < 6 * 3600000) return el('span', { className: 'soon' }, text);
  return text;
}

function money(m) {
  const opts = { style: 'currency', currency: m.currency || 'USD' };
  if (Number.isInteger(m.value)) opts.maximumFractionDigits = 0;
  try {
    return new Intl.NumberFormat('en-US', opts).format(m.value);
  } catch {
    return `$${m.value}`;
  }
}

function agoText(date) {
  if (!date) return 'just now';
  const mins = Math.round((Date.now() - date.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${plural(mins, 'minute')} ago`;
  return `${plural(Math.round(mins / 60), 'hour')} ago`;
}

function showSkeletons(n) {
  const skel = () =>
    el('li', { className: 'tile tile-skel', 'aria-hidden': 'true' },
      el('div', { className: 'tile-card' },
        el('div', { className: 'tile-link' },
          el('div', { className: 'tile-photo' }),
          el('div', { className: 'tile-info' },
            el('div', { className: 'tile-row' },
              el('span', { className: 'tile-price' }, '$00'),
              el('span', { className: 'kind' }, 'Loading')
            ),
            el('p', { className: 'tile-title' }, '\u00a0'),
            el('span', { className: 'tile-meta' }, '\u00a0')
          )
        ),
        el('div', { className: 'tile-offer' }, '\u00a0')
      )
    );
  $('[data-grid]').replaceChildren(...Array.from({ length: n }, skel));
}

// Tiny DOM helper: el('a', { className, href }, 'text', childNode, ...)
// Card photos load from terp.cards itself (the Worker passes them through from eBay), because
// Firefox's tracking protection blocks photos from eBay's image server on other sites.
// If that copy fails, the photo is tried straight from eBay, then a placeholder is shown.
function photoSrc(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'i.ebayimg.com' && /^\/images\/g\//.test(u.pathname)) return `/api/img${u.pathname}`;
  } catch {}
  return url;
}

function cardPhoto(url) {
  const first = photoSrc(url);
  const img = el('img', { src: first, alt: '', loading: 'lazy', decoding: 'async' });
  let direct = first === url;
  img.addEventListener('error', () => {
    if (!direct) { direct = true; img.src = url; return; }
    img.replaceWith(el('span', { className: 'tile-photo-empty' }, 'Photo on eBay'));
  });
  return img;
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'className') node.className = v;
    else if (k in node && typeof v !== 'string') node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c === '' || c == null) continue;
    node.append(c);
  }
  return node;
}

// ---------- Sample data (only used while the eBay feed isn't connected) ----------

function sampleArt(name, face, frame) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 250 350">
<rect width="250" height="350" rx="12" fill="${frame}"/>
<rect x="13" y="13" width="224" height="324" rx="6" fill="${face}"/>
<path d="M13 205 L237 150 L237 337 L13 337Z" fill="${frame}" opacity=".35"/>
<circle cx="125" cy="128" r="40" fill="#111"/>
<path d="M48 300 C56 196 194 196 202 300Z" fill="#111"/>
<rect x="13" y="276" width="224" height="61" fill="#fff"/>
<rect x="13" y="276" width="224" height="7" fill="${frame}"/>
<text x="125" y="318" font-family="Arial Black,Arial,sans-serif" font-weight="900" font-size="22" text-anchor="middle" fill="#111">${name.toUpperCase()}</text>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function sampleListings() {
  const now = Date.now();
  const hrs = (h) => new Date(now + h * 3600000).toISOString();
  const ago = (h) => new Date(now - h * 3600000).toISOString();
  const usd = (v) => ({ value: v, currency: 'USD' });
  const base = { url: '#listings', bidCount: 0, currentBid: null, acceptsOffers: false, condition: null, endsAt: null };

  return [
    { ...base, id: 's1', title: '2024 Chrome Rookie Refractor #128 Marcus Bell PSA 10', image: sampleArt('Bell', '#1F5FBF', '#0B1F3F'), price: usd(145), isBuyItNow: true, isAuction: false, acceptsOffers: true, shipping: usd(0), listedAt: ago(2) },
    { ...base, id: 's2', title: '2025 Rookie Patch Auto /99 Jalen Okafor SGC 9', image: sampleArt('Okafor', '#C8102E', '#2B0A0F'), price: usd(99), currentBid: usd(180), bidCount: 14, isBuyItNow: false, isAuction: true, shipping: usd(0), listedAt: ago(30), endsAt: hrs(4.3) },
    { ...base, id: 's3', title: '2023 Silver Wave Parallel /199 Dante Ruiz RC Raw', image: sampleArt('Ruiz', '#9AA4AE', '#3A4048'), price: usd(20), currentBid: usd(38), bidCount: 7, isBuyItNow: false, isAuction: true, shipping: usd(4.99), listedAt: ago(20), endsAt: hrs(27) },
    { ...base, id: 's4', title: '2022 Draft Picks Auto Theo Kimura BGS 9.5', image: sampleArt('Kimura', '#0E7C5A', '#06281D'), price: usd(220), isBuyItNow: true, isAuction: false, shipping: usd(0), listedAt: ago(5) },
    { ...base, id: 's5', title: '1998 Vintage Insert Ray Coleman Raw NM', image: sampleArt('Coleman', '#E2B33C', '#4A3305'), price: usd(32.5), isBuyItNow: true, isAuction: false, shipping: usd(4.99), listedAt: ago(48) },
    { ...base, id: 's6', title: '2020 Rookie Ticket Auto Andre Pike CGC 9.5', image: sampleArt('Pike', '#5B2A86', '#1C0B2E'), price: usd(310), isBuyItNow: true, isAuction: false, acceptsOffers: true, shipping: usd(0), listedAt: ago(70) },
    { ...base, id: 's7', title: '2021 Gold Refractor /50 Eli Navarro Raw', image: sampleArt('Navarro', '#D4A017', '#3D2C00'), price: usd(95), isBuyItNow: true, isAuction: false, acceptsOffers: true, shipping: usd(0), listedAt: ago(9) },
    { ...base, id: 's8', title: '2024 Holiday Variation Sam Whitfield PSA 9', image: sampleArt('Whitfield', '#2E8B57', '#B22222'), price: usd(12), currentBid: usd(12), bidCount: 0, isBuyItNow: false, isAuction: true, shipping: usd(1.5), listedAt: ago(12), endsAt: hrs(54) },
    { ...base, id: 's9', title: '2024 Hometown Hawks Team Lot, 25 cards, base and inserts', image: sampleArt('Hawks', '#F26B21', '#3A1500'), price: usd(18), isBuyItNow: true, isAuction: false, shipping: usd(0), listedAt: ago(96) },
    { ...base, id: 's10', title: '2019 Chrome Update Rookie Leo Hartman PSA 8', image: sampleArt('Hartman', '#14213D', '#FCA311'), price: usd(24), isBuyItNow: true, isAuction: false, shipping: usd(4.99), listedAt: ago(130) },
  ];
}
