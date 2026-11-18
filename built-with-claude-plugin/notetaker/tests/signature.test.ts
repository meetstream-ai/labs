import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { secretPathMatches, verifyWebhookSignature } from '../src/webhook/signature.js';

const SECRET = 'whsec_test_secret';
const NOW_MS = 1_763_000_000_000;
const TIMESTAMP = new Date(NOW_MS).toISOString();

/** What MeetStream sends: sha256=<hex HMAC of the raw body>, timestamp separate. */
function sign(rawBody: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

function verify(overrides: {
  rawBody: string;
  headers: Record<string, string | undefined>;
  nowMs?: number;
}) {
  return verifyWebhookSignature({
    rawBody: overrides.rawBody,
    headers: overrides.headers,
    secret: SECRET,
    signatureHeader: 'x-meetstream-signature',
    timestampHeader: 'x-meetstream-timestamp',
    toleranceSeconds: 300,
    now: () => overrides.nowMs ?? NOW_MS,
  });
}

describe('verifyWebhookSignature', () => {
  const body = JSON.stringify({ event: 'transcription.processed', bot_id: 'bot_1' });

  it('accepts a sha256= prefixed digest over the raw body', () => {
    const result = verify({
      rawBody: body,
      headers: {
        'x-meetstream-signature': sign(body),
        'x-meetstream-timestamp': TIMESTAMP,
      },
    });
    expect(result).toEqual({ valid: true });
  });

  it('accepts a bare hex digest with no sha256= prefix', () => {
    const result = verify({
      rawBody: body,
      headers: {
        'x-meetstream-signature': createHmac('sha256', SECRET).update(body).digest('hex'),
        'x-meetstream-timestamp': TIMESTAMP,
      },
    });
    expect(result).toEqual({ valid: true });
  });

  it('rejects a digest that signed "timestamp.body" instead of the body', () => {
    // The construction this app shipped with: it mismatched every real delivery.
    const result = verify({
      rawBody: body,
      headers: {
        'x-meetstream-signature': createHmac('sha256', SECRET)
          .update(`${TIMESTAMP}.${body}`)
          .digest('hex'),
        'x-meetstream-timestamp': TIMESTAMP,
      },
    });
    expect(result).toEqual({ valid: false, reason: 'mismatch' });
  });

  it('rejects a digest in base64 rather than hex', () => {
    const result = verify({
      rawBody: body,
      headers: {
        'x-meetstream-signature': createHmac('sha256', SECRET).update(body).digest('base64'),
        'x-meetstream-timestamp': TIMESTAMP,
      },
    });
    expect(result).toEqual({ valid: false, reason: 'mismatch' });
  });

  it('matches headers case-insensitively', () => {
    const result = verify({
      rawBody: body,
      headers: { 'X-MeetStream-Signature': sign(body), 'X-MeetStream-Timestamp': TIMESTAMP },
    });
    expect(result).toEqual({ valid: true });
  });

  it('rejects a body that was altered in flight', () => {
    const result = verify({
      rawBody: body.replace('bot_1', 'bot_2'),
      headers: { 'x-meetstream-signature': sign(body), 'x-meetstream-timestamp': TIMESTAMP },
    });
    expect(result).toEqual({ valid: false, reason: 'mismatch' });
  });

  it('rejects a signature made with the wrong secret', () => {
    const result = verify({
      rawBody: body,
      headers: {
        'x-meetstream-signature': sign(body, 'wrong_secret'),
        'x-meetstream-timestamp': TIMESTAMP,
      },
    });
    expect(result).toEqual({ valid: false, reason: 'mismatch' });
  });

  it('rejects a replayed delivery outside the tolerance window', () => {
    const result = verify({
      rawBody: body,
      headers: { 'x-meetstream-signature': sign(body), 'x-meetstream-timestamp': TIMESTAMP },
      nowMs: NOW_MS + 301_000,
    });
    expect(result).toEqual({ valid: false, reason: 'stale' });
  });

  it('accepts a delivery just inside the tolerance window', () => {
    const result = verify({
      rawBody: body,
      headers: { 'x-meetstream-signature': sign(body), 'x-meetstream-timestamp': TIMESTAMP },
      nowMs: NOW_MS + 299_000,
    });
    expect(result).toEqual({ valid: true });
  });

  it('rejects a missing signature header', () => {
    const result = verify({ rawBody: body, headers: { 'x-meetstream-timestamp': TIMESTAMP } });
    expect(result).toEqual({ valid: false, reason: 'missing_signature' });
  });

  it('rejects a delivery with no timestamp header', () => {
    const result = verify({ rawBody: body, headers: { 'x-meetstream-signature': sign(body) } });
    expect(result).toEqual({ valid: false, reason: 'missing_timestamp' });
  });

  it('handles epoch seconds as well as the ISO-8601 MeetStream sends', () => {
    const epoch = String(Math.floor(NOW_MS / 1000));
    const result = verify({
      rawBody: body,
      headers: { 'x-meetstream-signature': sign(body), 'x-meetstream-timestamp': epoch },
    });
    expect(result).toEqual({ valid: true });
  });
});

describe('secretPathMatches', () => {
  it('accepts the exact token', () => {
    expect(secretPathMatches('abcdef0123456789', 'abcdef0123456789')).toBe(true);
  });

  it('rejects a different token of the same length', () => {
    expect(secretPathMatches('abcdef0123456789', 'abcdef0123456780')).toBe(false);
  });

  it('rejects a token of a different length without throwing', () => {
    expect(secretPathMatches('short', 'abcdef0123456789')).toBe(false);
  });
});
