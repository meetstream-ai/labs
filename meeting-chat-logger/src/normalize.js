/**
 * Normalise the `GET /bots/{bot_id}/get_chats` response.
 *
 * The endpoint returns the in-meeting chat messages the bot captured. The
 * public API reference documents what it returns but not a field-level
 * schema, and the exact key names vary with the meeting platform (Google
 * Meet, Zoom and Teams expose chat differently).
 *
 * So rather than hardcode one guess, this module:
 *   1. finds the message list, whether the response is a bare array or an
 *      object wrapping one,
 *   2. picks author / text / timestamp from a list of candidate keys,
 *   3. keeps the original object on every message as `raw`, and
 *   4. reports which keys it actually used, so you can see what happened.
 *
 * The untouched response is always written to disk as well, so nothing is
 * lost. If your account returns key names not listed here, add them to the
 * arrays below - that is the only change needed.
 */

const AUTHOR_KEYS = [
  'sender',
  'senderName',
  'sender_name',
  'author',
  'authorName',
  'author_name',
  'speaker',
  'speakerName',
  'participant',
  'participantName',
  'participant_name',
  'displayName',
  'display_name',
  'fullName',
  'full_name',
  'from',
  'user',
  'userName',
  'user_name',
  'name',
];

const TEXT_KEYS = [
  'message',
  'text',
  'content',
  'body',
  'chat',
  'chatMessage',
  'chat_message',
  'messageText',
  'message_text',
];

const TIME_KEYS = [
  'timestamp',
  'time',
  'sentAt',
  'sent_at',
  'createdAt',
  'created_at',
  'lastUpdated',
  'date',
  'absoluteTime',
  'absolute_time',
];

const RECIPIENT_KEYS = ['recipient', 'to', 'target', 'audience', 'visibility', 'scope'];

const LIST_KEYS = ['chats', 'messages', 'chat_messages', 'chatMessages', 'data', 'results', 'items'];

function pick(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    if (typeof value === 'object') {
      // e.g. { sender: { name: "Alice" } } or { timestamp: { absolute: "..." } }
      const nested =
        value.name ?? value.full_name ?? value.fullName ?? value.displayName ?? value.absolute;
      if (typeof nested === 'string' && nested.trim()) return { key, value: nested };
      continue;
    }
    return { key, value };
  }
  return null;
}

/**
 * Locate the array of messages inside whatever came back.
 * @returns {{ list: any[], sourceKey: string|null }}
 */
export function findMessageList(payload) {
  if (Array.isArray(payload)) return { list: payload, sourceKey: null };
  if (!payload || typeof payload !== 'object') return { list: [], sourceKey: null };

  for (const key of LIST_KEYS) {
    if (Array.isArray(payload[key])) return { list: payload[key], sourceKey: key };
  }
  // Last resort: the first array-valued property.
  for (const [key, value] of Object.entries(payload)) {
    if (Array.isArray(value)) return { list: value, sourceKey: key };
  }
  return { list: [], sourceKey: null };
}

/**
 * @param {any} payload the raw get_chats response
 * @returns {{
 *   messages: Array<{ index: number, author: string|null, text: string|null, timestamp: string|null, recipient: string|null, raw: any }>,
 *   sourceKey: string|null,
 *   keysUsed: { author: string|null, text: string|null, timestamp: string|null, recipient: string|null },
 *   unmapped: string[],
 *   total: number
 * }}
 */
export function normalizeChats(payload) {
  const { list, sourceKey } = findMessageList(payload);

  const keysUsed = { author: null, text: null, timestamp: null, recipient: null };
  const seenKeys = new Set();

  const messages = list.map((item, index) => {
    if (typeof item === 'string') {
      return { index, author: null, text: item, timestamp: null, recipient: null, raw: item };
    }
    if (!item || typeof item !== 'object') {
      return { index, author: null, text: item === null ? null : String(item), timestamp: null, recipient: null, raw: item };
    }

    for (const k of Object.keys(item)) seenKeys.add(k);

    const author = pick(item, AUTHOR_KEYS);
    const text = pick(item, TEXT_KEYS);
    const time = pick(item, TIME_KEYS);
    const recipient = pick(item, RECIPIENT_KEYS);

    if (author && !keysUsed.author) keysUsed.author = author.key;
    if (text && !keysUsed.text) keysUsed.text = text.key;
    if (time && !keysUsed.timestamp) keysUsed.timestamp = time.key;
    if (recipient && !keysUsed.recipient) keysUsed.recipient = recipient.key;

    return {
      index,
      author: author ? String(author.value) : null,
      text: text ? String(text.value) : null,
      timestamp: time ? String(time.value) : null,
      recipient: recipient ? String(recipient.value) : null,
      raw: item,
    };
  });

  const mapped = new Set([keysUsed.author, keysUsed.text, keysUsed.timestamp, keysUsed.recipient].filter(Boolean));
  const unmapped = [...seenKeys].filter((k) => !mapped.has(k)).sort();

  return { messages, sourceKey, keysUsed, unmapped, total: messages.length };
}

/** Per-author message counts, most talkative first. */
export function authorCounts(messages) {
  const counts = new Map();
  for (const m of messages) {
    const key = m.author || 'Unknown';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
