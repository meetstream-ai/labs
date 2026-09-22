import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { MeetStreamError, errorMessageFrom, parseBody } from './client.js';
import { collectDownloadUrls, downloadUrlToFile, guessExtension } from './download.js';
import { log } from './log.js';
import { dedupeName, sanitizeFilename } from './util.js';

/**
 * Fetch and download per-participant audio from
 * `GET /bots/{bot_id}/get_audio_streams`.
 *
 * The important status here is **202**: it means MeetStream is still splitting
 * the recording into per-participant streams. Poll again. A bot configured
 * with a *streaming-only* transcription provider never produces post-call
 * per-participant audio at all, so it returns 202 forever - which is exactly
 * why every poll loop in this template is capped.
 */

/**
 * @param {import('./client.js').MeetStreamClient} client
 * @param {string} botId
 * @returns {Promise<{ ready: boolean, status: number, data: any, message: string }>}
 */
export async function fetchAudioStreams(client, botId) {
  const res = await client.raw('GET', `/bots/${botId}/get_audio_streams`);
  const data = await parseBody(res);

  if (res.status === 202) {
    // The 202 body usually carries a progress hint such as
    // { "message": "in_progress" }. Surface whatever it says.
    return {
      ready: false,
      status: 202,
      data,
      message: errorMessageFrom(data, res) || 'in_progress',
    };
  }

  if (res.status === 404) {
    return {
      ready: false,
      status: 404,
      data,
      message: errorMessageFrom(data, res),
    };
  }

  if (!res.ok && res.status !== 507) {
    throw new MeetStreamError(res.status, errorMessageFrom(data, res), data);
  }

  return { ready: true, status: res.status, data, message: '' };
}

/**
 * Turn the get_audio_streams body into a flat list of downloadable items
 * grouped by participant.
 *
 * MeetStream returns one of a few shapes depending on account and meeting:
 *   - a top-level array of stream objects
 *   - `{ participants: [ { participant_name, streams: [ { segments: [...] } ] } ] }`
 *   - a single object with a URL on it
 * All of them are handled, and anything unrecognised falls back to a generic
 * walk of the JSON for http(s) URLs. The raw body is always saved to disk so
 * you can see the real shape your account returns.
 *
 * @param {any} data
 * @returns {Array<{ participant: string, items: Array<{ url: string, label: string }> }>}
 */
export function groupStreamsByParticipant(data) {
  /** @type {Map<string, Array<{ url: string, label: string }>>} */
  const groups = new Map();

  const push = (participant, url, label) => {
    if (!url) return;
    const name = sanitizeFilename(participant || 'unknown participant', 'unknown participant');
    if (!groups.has(name)) groups.set(name, []);
    const bucket = groups.get(name);
    if (bucket.some((item) => item.url === url)) return;
    bucket.push({ url, label: sanitizeFilename(label || 'audio', 'audio') });
  };

  const urlOf = (node) => node?.download_url ?? node?.url ?? node?.audio_url ?? null;
  const nameOf = (node) =>
    node?.participant_name ?? node?.participant?.name ?? node?.speaker ?? node?.name ?? null;

  const records = Array.isArray(data)
    ? data
    : Array.isArray(data?.participants)
      ? data.participants
      : Array.isArray(data?.recordings)
        ? data.recordings
        : data && typeof data === 'object'
          ? [data]
          : [];

  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const participant = nameOf(record);

    // Flat shape: the record itself is one downloadable stream.
    const directUrl = urlOf(record);
    if (directUrl) {
      push(participant, directUrl, record.type ?? record.stream_type ?? 'audio');
    }

    // Nested shape: participant -> streams -> segments.
    for (const stream of record.streams ?? []) {
      const streamType = stream?.type ?? stream?.stream_type ?? 'audio';
      const streamUrl = urlOf(stream);
      if (streamUrl) push(participant ?? nameOf(stream), streamUrl, streamType);

      const segments = stream?.segments ?? [];
      segments.forEach((segment, index) => {
        const segUrl = urlOf(segment);
        if (segUrl) {
          push(
            participant ?? nameOf(stream),
            segUrl,
            segments.length > 1 ? `${streamType}_${String(index + 1).padStart(3, '0')}` : streamType
          );
        }
      });
    }
  }

  // Nothing recognised - fall back to a generic URL walk so the user still
  // gets their media instead of an empty folder.
  if (groups.size === 0) {
    for (const entry of collectDownloadUrls(data)) {
      push(entry.hints[0] ?? 'unknown participant', entry.url, entry.hints.slice(1).join('_') || 'audio');
    }
  }

  return [...groups.entries()].map(([participant, items]) => ({ participant, items }));
}

/**
 * Write the raw API body next to the downloads for debugging.
 *
 * @param {string} destDir
 * @param {any} data
 * @returns {Promise<string>}
 */
export async function dumpRawResponse(destDir, data) {
  await mkdir(destDir, { recursive: true });
  const target = path.join(destDir, 'raw_get_audio_streams_response.json');
  await writeFile(target, JSON.stringify(data, null, 2));
  return target;
}

/**
 * Download every participant's audio into its own folder.
 *
 * @param {object} params
 * @param {Array<{ participant: string, items: Array<{ url: string, label: string }> }>} params.groups
 * @param {string} params.destDir
 * @returns {Promise<{ saved: number, failed: number }>}
 */
export async function downloadParticipantAudio({ groups, destDir }) {
  let saved = 0;
  let failed = 0;
  const usedFolders = new Set();

  for (const group of groups) {
    const folderName = dedupeName(group.participant, usedFolders);
    const participantDir = path.join(destDir, folderName);
    await mkdir(participantDir, { recursive: true });

    const usedFiles = new Set();
    for (const item of group.items) {
      const ext = guessExtension(null, item.url, 'webm');
      const fileName = `${dedupeName(item.label, usedFiles)}.${ext}`;
      const destPath = path.join(participantDir, fileName);
      try {
        log.info(`${folderName}: downloading ${fileName}`);
        await downloadUrlToFile(item.url, destPath, { label: `${folderName}/${fileName}` });
        saved += 1;
      } catch (err) {
        failed += 1;
        log.error(`${folderName}/${fileName} failed: ${err.message}`);
      }
    }
  }

  return { saved, failed };
}
