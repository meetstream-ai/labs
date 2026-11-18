import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * HMAC verification for workspace-level webhook endpoints.
 *
 * IMPORTANT: per-bot `callback_url` deliveries — which is what this app's CLI
 * creates — are NOT signed by MeetStream. The secret path segment in
 * `webhookPath()` is what protects that route. This module only does useful work
 * once you point a workspace endpoint at the server and set
 * WEBHOOK_SIGNING_SECRET. See docs/webhook-security.md.
 *
 * MeetStream signs a workspace endpoint like this:
 *
 *   X-MeetStream-Signature: sha256=<hex digest of HMAC-SHA256(secret, raw body)>
 *   X-MeetStream-Timestamp: <ISO-8601>
 *
 * The digest covers the **raw body alone** — the timestamp is not part of the
 * signed string, it only bounds replays. Signing `timestamp "." body` (the
 * Stripe-style construction) makes every real delivery fail as `mismatch`.
 */

export interface VerifyOptions {
  /** Exact bytes as received. Re-serialising parsed JSON will not match. */
  rawBody: Buffer | string;
  headers: Record<string, string | string[] | undefined>;
  secret: string;
  signatureHeader: string;
  timestampHeader: string;
  toleranceSeconds: number;
  /** Injectable clock, in ms, for deterministic tests. */
  now?: () => number;
}

export type VerifyResult =
  | { valid: true }
  | { valid: false; reason: 'missing_signature' | 'missing_timestamp' | 'stale' | 'mismatch' };

export function verifyWebhookSignature(options: VerifyOptions): VerifyResult {
  const provided = parseSignature(headerValue(options.headers, options.signatureHeader));
  if (!provided) return { valid: false, reason: 'missing_signature' };

  const rawTimestamp = headerValue(options.headers, options.timestampHeader);
  if (!rawTimestamp) return { valid: false, reason: 'missing_timestamp' };

  const timestamp = parseTimestamp(rawTimestamp);
  if (timestamp === null) return { valid: false, reason: 'missing_timestamp' };

  const now = options.now?.() ?? Date.now();
  if (Math.abs(now / 1000 - timestamp) > options.toleranceSeconds) {
    return { valid: false, reason: 'stale' };
  }

  const rawBody = Buffer.isBuffer(options.rawBody)
    ? options.rawBody
    : Buffer.from(options.rawBody, 'utf8');
  const expected = createHmac('sha256', options.secret).update(rawBody).digest();

  return constantTimeMatches(expected, provided)
    ? { valid: true }
    : { valid: false, reason: 'mismatch' };
}

/** The header is `sha256=<hex>`; the prefix is stripped before comparing. */
function parseSignature(value: string | null): string | null {
  if (!value) return null;
  const digest = value.trim().replace(/^sha256=/i, '');
  return digest || null;
}

/** MeetStream sends ISO-8601; epoch seconds are accepted too. */
function parseTimestamp(value: string): number | null {
  if (/^\d+$/.test(value)) return Number(value);
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed / 1000;
}

function constantTimeMatches(expected: Buffer, provided: string): boolean {
  if (!/^[0-9a-f]+$/i.test(provided)) return false;
  const candidate = Buffer.from(provided, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue;
    const resolved = Array.isArray(value) ? value[0] : value;
    return resolved ?? null;
  }
  return null;
}

/** Constant-time compare for the secret path segment guarding unsigned callbacks. */
export function secretPathMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
