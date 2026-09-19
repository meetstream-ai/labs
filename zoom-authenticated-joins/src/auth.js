// Small request helpers shared by the routes.

import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string comparison. The length check comes first because
 * timingSafeEqual throws on buffers of different lengths; leaking only the
 * length of the secret is acceptable, leaking its contents byte by byte is not.
 */
export function safeEqual(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Express parses `?x=1&x=2` into an array. Every query value this server reads
 * goes through here so a duplicated parameter never turns into "1,2" or a crash.
 * Returns { value, count } so callers can warn about duplicates.
 */
export function firstValue(raw) {
  if (Array.isArray(raw)) return { value: raw.length > 0 ? String(raw[0]) : undefined, count: raw.length };
  if (raw === undefined || raw === null || raw === '') return { value: undefined, count: 0 };
  if (typeof raw === 'object') return { value: undefined, count: 1 }; // ?x[a]=1 style, reject
  return { value: String(raw), count: 1 };
}

/** Your own user key, used as the token-store key. Kept boring on purpose. */
export const USER_ID_PATTERN = /^[A-Za-z0-9._@-]{1,128}$/;

/** Replace the auth secret in a URL before it is printed anywhere. */
export function redactUrl(value) {
  try {
    const url = new URL(value);
    if (url.searchParams.has('auth')) url.searchParams.set('auth', '***');
    return url.toString();
  } catch {
    return '[unprintable url]';
  }
}
