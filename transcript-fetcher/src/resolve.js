/**
 * Resolving a transcript_id - the #1 MeetStream gotcha.
 *
 * `transcript_id` is NOT `bot_id`, and it is NOT included in webhook payloads.
 * There are exactly three places it can come from:
 *
 *   1. The `POST /bots/create_bot` response  → `{ bot_id, transcript_id, ... }`
 *      Cheapest option: store it when you create the bot and you never have to
 *      look it up again.
 *   2. `GET /bots/{bot_id}/detail`           → full session metadata
 *   3. `GET /bots/{bot_id}/transcriptions`   → every transcription run for the
 *      bot, including re-transcriptions
 *
 * This module implements (2) then (3) as a fallback, for the common case where
 * all you kept was the bot_id.
 */

import { api } from "./client.js";

/**
 * Depth-first search for a non-empty string value stored under `key`.
 * `GET /bots/{id}/detail` returns a large nested object whose exact layout
 * varies by platform and bot configuration, so we look for the field rather
 * than assuming a fixed path.
 */
function findStringKey(node, key, seen = new Set()) {
  if (!node || typeof node !== "object" || seen.has(node)) return null;
  seen.add(node);

  if (!Array.isArray(node)) {
    const value = node[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }

  for (const value of Object.values(node)) {
    const hit = findStringKey(value, key, seen);
    if (hit) return hit;
  }
  return null;
}

/** Read the transcription runs for a bot. Newest usable run wins. */
export async function listTranscriptions(botId) {
  const { data } = await api(`/bots/${encodeURIComponent(botId)}/transcriptions`);

  // Documented shape: { bot_id, transcriptions: [ { transcript_id, provider,
  // status, created_at, config, download_urls } ] }
  const runs = Array.isArray(data?.transcriptions)
    ? data.transcriptions
    : Array.isArray(data)
      ? data
      : [];

  return runs.filter((run) => typeof run?.transcript_id === "string" && run.transcript_id);
}

/** Sort newest-first by created_at, tolerating missing / unparseable values. */
function byNewest(a, b) {
  const ta = Date.parse(a?.created_at ?? "");
  const tb = Date.parse(b?.created_at ?? "");
  if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
  if (Number.isNaN(ta)) return 1;
  if (Number.isNaN(tb)) return -1;
  return tb - ta;
}

/**
 * Pick the best transcription run: prefer a successful one, otherwise the most
 * recent run of any status (so you can still see a failure and act on it).
 */
export function pickTranscription(runs) {
  if (runs.length === 0) return null;
  const sorted = [...runs].sort(byNewest);
  const succeeded = sorted.find((run) => String(run.status).toLowerCase() === "success");
  return succeeded ?? sorted[0];
}

/**
 * Resolve a transcript_id from a bot_id.
 *
 * @param {string} botId
 * @param {(msg: string) => void} [log]
 * @returns {Promise<{ transcriptId: string, source: string, run: object|null }>}
 */
export async function resolveTranscriptId(botId, log = () => {}) {
  // ── Source 2: GET /bots/{bot_id}/detail ────────────────────────────────────
  log(`Looking up transcript_id via GET /bots/${botId}/detail`);
  try {
    const { data } = await api(`/bots/${encodeURIComponent(botId)}/detail`);
    const fromDetail = findStringKey(data, "transcript_id");
    if (fromDetail) {
      return { transcriptId: fromDetail, source: "bots/{id}/detail", run: null };
    }
    log("  No transcript_id in /detail - falling back to /transcriptions");
  } catch (err) {
    // A 404 here just means "no detail yet"; keep going to /transcriptions.
    log(`  /detail failed (${err.message}) - falling back to /transcriptions`);
  }

  // ── Source 3: GET /bots/{bot_id}/transcriptions ────────────────────────────
  log(`Looking up transcript_id via GET /bots/${botId}/transcriptions`);
  const runs = await listTranscriptions(botId);

  if (runs.length === 0) {
    throw new Error(
      `No transcriptions exist for bot ${botId}.\n` +
        "Likely causes:\n" +
        "  - the bot was created without a transcript provider\n" +
        "  - the bot used a *_streaming provider (streaming-only bots produce no post-call transcript)\n" +
        "  - transcription has not started yet (wait for the transcription.processed webhook)",
    );
  }

  const run = pickTranscription(runs);
  log(
    `  Found ${runs.length} transcription run(s); using ${run.transcript_id} ` +
      `(provider: ${run.provider ?? "unknown"}, status: ${run.status ?? "unknown"})`,
  );

  return { transcriptId: run.transcript_id, source: "bots/{id}/transcriptions", run };
}
