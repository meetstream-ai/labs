/**
 * The two anti-duplicate mechanisms in create_bot, and the calls that show the
 * difference between them.
 *
 *   Idempotency-Key   a header. Scoped to one retried request. A replay comes
 *                     back as HTTP 507 carrying the original bot.
 *   deduplication_key a body field. Scoped to a logical booking. A replay of
 *                     the same booking comes back 200. Reusing the key for a
 *                     different meeting is a 409 conflict.
 */

import { request, errorMessage } from "./api.js";

/** POST /bots/create_bot, returning the raw status so callers can inspect it. */
export async function createBot(body, { idempotencyKey } = {}) {
  const headers = idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {};
  const { status, data } = await request("/bots/create_bot", {
    method: "POST",
    body,
    headers,
  });
  return { status, data, botId: data?.bot_id ?? null };
}

/**
 * Turns a create_bot status code into a verdict.
 *
 * 507 is the one that trips people up: it is not an error. It means the request
 * was recognised as a replay of an earlier one with the same Idempotency-Key,
 * so nothing new was created and nothing extra was charged.
 */
export function verdict(status) {
  if (status === 201) return { ok: true, label: "created", note: "A new bot was created." };
  if (status === 200) {
    return {
      ok: true,
      label: "replayed",
      note: "The existing bot was returned. Nothing new was created.",
    };
  }
  if (status === 507) {
    return {
      ok: true,
      label: "idempotent replay",
      note: "SUCCESS. The original bot is returned, no duplicate, no double charge.",
    };
  }
  if (status === 409) {
    return {
      ok: false,
      label: "dedup conflict",
      note: "The deduplication_key is already bound to a different request.",
    };
  }
  return { ok: false, label: `HTTP ${status}`, note: "Unexpected." };
}

export function report(title, { status, data, botId }) {
  const v = verdict(status);
  console.log(`\n${title}`);
  console.log(`  HTTP ${status}  ${v.label}`);
  console.log(`  ${v.note}`);
  if (botId) console.log(`  bot_id: ${botId}`);
  if (!v.ok && status !== 409) {
    console.log(`  message: ${errorMessage(data, status)}`);
  }
  if (status === 409) {
    console.log(`  message: ${errorMessage(data, status)}`);
  }
  return v;
}

/** GET /bots/{id}/remove_bot, best effort. Cleanup must never fail the demo. */
export async function tryRemove(botId) {
  try {
    const { status } = await request(`/bots/${botId}/remove_bot`);
    console.log(`  removed ${botId} (HTTP ${status})`);
  } catch (err) {
    console.log(`  could not remove ${botId}: ${err.message}`);
  }
}

export function printComparison() {
  console.log(`
IDEMPOTENCY-KEY vs DEDUPLICATION_KEY
${"=".repeat(72)}

                    Idempotency-Key            deduplication_key
  where             HTTP header                create_bot body field
  scope             one retried request        one logical booking
  you generate      a fresh UUID per attempt   a stable id from your own data
                    at the call site           (calendar event id, row id)
  replay result     HTTP 507 + original bot    HTTP 200 + original bot
  same key,
  different meeting  n/a                       HTTP 409 conflict
  solves            "my POST timed out, is it  "two workers picked up the same
                     safe to retry?"            calendar event"

  Reach for Idempotency-Key when a single call might be sent twice by the
  network or a retry wrapper. Reach for deduplication_key when two independent
  code paths might both decide to book the same meeting.

  They compose. A scheduler can send a stable deduplication_key for the booking
  and a fresh Idempotency-Key for each transport-level attempt.

  The 507 is the part worth burning into your error handling: it is in the 5xx
  range, so a naive "retry on 5xx" wrapper will loop on it, and a naive
  "throw on !res.ok" wrapper will report a successful booking as a failure.
  Treat 507 as success.
`);
}
