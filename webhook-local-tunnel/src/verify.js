import { randomUUID } from 'node:crypto';
import { assertDeliverable } from './tunnel.js';
import { log } from './logger.js';

/**
 * Prove the tunnel actually works BEFORE you spend a bot on it.
 *
 * Three checks, cheapest first:
 *   1. the URL is shaped like something MeetStream can deliver to (https, public host)
 *   2. GET <public>/health round-trips through the tunnel
 *   3. POST <public><webhookPath> with a synthetic envelope lands in your handler
 *
 * Check 3 is the one that matters. It exercises the exact path MeetStream will
 * use, including any tunnel interstitial page or proxy that might eat POSTs.
 */
export async function verifyTunnel({ publicUrl, webhookPath, waitForNonce, timeoutMs = 15_000 }) {
  const results = [];

  // ---- 1. shape ----------------------------------------------------------
  try {
    assertDeliverable(publicUrl);
    results.push({ check: 'url is deliverable (https, public host)', ok: true });
    log.ok(`URL check passed: ${publicUrl}`);
  } catch (err) {
    results.push({ check: 'url is deliverable', ok: false, detail: err.message });
    log.error(`URL check failed: ${err.message}`);
    return { ok: false, results };
  }

  // ---- 2. inbound GET ----------------------------------------------------
  try {
    const res = await fetch(`${publicUrl}/health`, {
      // ngrok free shows a browser interstitial unless this header is present.
      // MeetStream's delivery agent is not a browser and is unaffected, but
      // curl and this check are.
      headers: { 'ngrok-skip-browser-warning': 'true' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json().catch(() => null);
    const ok = res.ok && body?.ok === true;
    results.push({ check: 'GET /health through the tunnel', ok, detail: `HTTP ${res.status}` });
    ok ? log.ok(`GET /health through tunnel: HTTP ${res.status}`) : log.error(`GET /health returned HTTP ${res.status}`);
    if (!ok) return { ok: false, results };
  } catch (err) {
    results.push({ check: 'GET /health through the tunnel', ok: false, detail: err.message });
    log.error(`GET /health failed: ${err.message}`);
    return { ok: false, results };
  }

  // ---- 3. inbound POST of a real-shaped envelope -------------------------
  const nonce = randomUUID();
  const envelope = {
    // Key is `event`. Using anything else here would be testing the wrong thing.
    event: 'bot.joining',
    bot_id: `tunnel-selftest-${nonce.slice(0, 8)}`,
    bot_status: 'Joining',
    message: 'Synthetic self-test delivery from webhook-local-tunnel',
    status_code: 200,
    custom_attributes: { verify_nonce: nonce, source: 'self-test' },
  };

  const arrival = waitForNonce(nonce, timeoutMs);
  let postStatus;
  try {
    const res = await fetch(`${publicUrl}${webhookPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(timeoutMs),
    });
    postStatus = res.status;
  } catch (err) {
    results.push({ check: 'POST webhook through the tunnel', ok: false, detail: err.message });
    log.error(`POST failed: ${err.message}`);
    return { ok: false, results };
  }

  try {
    await arrival;
    results.push({
      check: 'POST webhook through the tunnel',
      ok: postStatus === 200,
      detail: `HTTP ${postStatus}, handler received it`,
    });
    log.ok(`POST ${webhookPath} through tunnel: HTTP ${postStatus}, handler received it`);
  } catch (err) {
    results.push({
      check: 'POST webhook through the tunnel',
      ok: false,
      detail: `HTTP ${postStatus} but the handler never saw it: ${err.message}`,
    });
    log.error(`POST returned HTTP ${postStatus} but nothing reached the handler. Something in between is swallowing it.`);
    return { ok: false, results };
  }

  return { ok: results.every((r) => r.ok), results };
}
