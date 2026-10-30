// Contact form: checks a submission and turns it into a plain-text email to you.
// Used by src/worker.js. No outside packages, so it runs the same in Workers and Node.

export const TOPICS = {
  offer: 'Make an offer',
  card: 'Question about a card',
  other: 'Something else',
};

const LIMITS = { name: 100, contact: 200, message: 4000 };
const MIN_FILL_MS = 2500; // people take longer than this to fill in a form; bots usually don't

export class ContactError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ContactError';
    this.status = status;
    this.publicMessage = message;
  }
}

export function readSubmission(body) {
  if (!body || typeof body !== 'object') {
    throw new ContactError('Something went wrong with the form. Please try again.');
  }

  const clean = (value, max) =>
    String(value ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);
  const oneLine = (value, max) => clean(value, max).replace(/\s+/g, ' ');

  const topic = Object.hasOwn(TOPICS, body.topic) ? body.topic : 'other';
  const name = oneLine(body.name, LIMITS.name);
  const contact = oneLine(body.contact, LIMITS.contact);
  const message = clean(body.message, LIMITS.message);

  // Spam guards: a hidden field only bots fill in, and a minimum time on the form.
  const elapsed = Number(body.elapsedMs);
  const isBot =
    String(body.website ?? '').trim() !== '' || !Number.isFinite(elapsed) || elapsed < MIN_FILL_MS;

  if (!isBot) {
    if (!contact) {
      throw new ContactError('Add how I can reach you: an email, phone number, or your X or Instagram handle.');
    }
    if (message.length < 2) throw new ContactError('Add a message before sending.');
  }

  return { topic, name, contact, message, isBot };
}

export function isEmail(value) {
  return /^[^\s@<>()[\]"',;:\\]+@[^\s@<>()[\]"',;:\\]+\.[a-z]{2,}$/i.test(value);
}

export function buildEmail({ topic, name, contact, message }, { siteHost, now = new Date() }) {
  const who = name || contact;
  const when = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(now);
  const canReply = isEmail(contact);

  const text = [
    `${TOPICS[topic]}`,
    '',
    `Name: ${name || '(not given)'}`,
    `Reach them at: ${contact}`,
    '',
    'Message:',
    message,
    '',
    '--',
    `Sent from the contact form on ${siteHost}, ${when} ET.`,
    canReply
      ? 'They left an email address, so you can reply to this email to answer them.'
      : "They didn't leave an email address. Use the contact info above to get back to them.",
  ].join('\n');

  return {
    subject: `${TOPICS[topic]}: ${who} (TerpCards site)`,
    text,
    replyTo: canReply ? contact : null,
  };
}

// A minimal RFC 5322 message: UTF-8 plain text, base64 body, encoded subject.
export function toMime({ from, fromName, to, replyTo, subject, text, date = new Date() }) {
  const domain = from.split('@')[1] || 'localhost';
  const headers = [
    `From: ${encodeWord(fromName)} <${from}>`,
    `To: <${to}>`,
    replyTo && isEmail(replyTo) ? `Reply-To: <${replyTo}>` : null,
    `Subject: ${encodeWord(subject)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ].filter(Boolean);

  const body = base64Utf8(text).replace(/.{1,76}/g, '$&\r\n');
  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}

function encodeWord(value) {
  return `=?UTF-8?B?${base64Utf8(value)}?=`;
}

function base64Utf8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
