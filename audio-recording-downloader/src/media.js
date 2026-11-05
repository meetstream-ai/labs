import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { MeetStreamError, errorMessageFrom, parseBody } from './client.js';
import { collectDownloadUrls, downloadUrlToFile, guessExtension, saveResponseToFile } from './download.js';
import { log } from './log.js';
import { dedupeName, sanitizeFilename } from './util.js';

/**
 * Fetch a finished recording from `GET /bots/{id}/get_audio` or
 * `GET /bots/{id}/get_video` and write it to disk.
 *
 * Status handling:
 *   200 -> the recording is ready (body is either the media itself or JSON
 *          containing a storage URL - both are handled)
 *   202 -> MeetStream is still processing; poll again later
 *   404 -> processing has not started yet (bot may still be in the meeting)
 *   507 -> idempotent replay, treated as success
 *   anything else -> throws MeetStreamError carrying the API's `message`
 *
 * @param {object} params
 * @param {import('./client.js').MeetStreamClient} params.client
 * @param {string} params.botId
 * @param {'audio'|'video'} params.kind
 * @param {string} params.destDir
 * @returns {Promise<{ ready: boolean, reason?: string, files: Array<{path: string, bytes: number}> }>}
 */
export async function fetchRecording({ client, botId, kind, destDir }) {
  const endpoint = kind === 'video' ? 'get_video' : 'get_audio';
  const apiPath = `/bots/${botId}/${endpoint}`;
  const fallbackExt = kind === 'video' ? 'mp4' : 'mp3';

  const res = await client.raw('GET', apiPath, { headers: { Accept: '*/*' } });

  if (res.status === 202) {
    await res.body?.cancel?.();
    return { ready: false, reason: 'MeetStream returned 202 - recording is still processing.', files: [] };
  }

  if (res.status === 404) {
    const body = await parseBody(res);
    return {
      ready: false,
      reason: `MeetStream returned 404 - ${errorMessageFrom(body, res)}`,
      files: [],
    };
  }

  if (!res.ok && res.status !== 507) {
    const body = await parseBody(res);
    throw new MeetStreamError(res.status, errorMessageFrom(body, res), body);
  }

  await mkdir(destDir, { recursive: true });

  const contentType = (res.headers.get('content-type') || '').toLowerCase();

  // Case A: the endpoint streams the media file straight back.
  if (!contentType.includes('json')) {
    const ext = guessExtension(res, apiPath, fallbackExt);
    const destPath = path.join(destDir, `${kind}.${ext}`);
    log.info(`Downloading ${kind} recording to ${destPath}`);
    const file = await saveResponseToFile(res, destPath, { label: `${kind}.${ext}` });
    return { ready: true, files: [file] };
  }

  // Case B: the endpoint returns JSON pointing at storage URLs.
  const data = await res.json().catch(() => null);
  const debugPath = path.join(destDir, `raw_${endpoint}_response.json`);
  await writeFile(debugPath, JSON.stringify(data, null, 2));
  log.debug(`Raw ${endpoint} JSON written to ${debugPath}`);

  const entries = collectDownloadUrls(data);
  if (entries.length === 0) {
    return {
      ready: false,
      reason: `${endpoint} returned JSON with no download URL yet (see ${debugPath}).`,
      files: [],
    };
  }

  const usedNames = new Set();
  const files = [];
  for (const entry of entries) {
    const base = sanitizeFilename(entry.hints.filter(Boolean).join(' - ') || kind, kind);
    const name = dedupeName(base, usedNames);
    const ext = guessExtension(null, entry.url, fallbackExt);
    const destPath = path.join(destDir, `${name}.${ext}`);
    log.info(`Downloading ${kind} recording to ${destPath}`);
    files.push(await downloadUrlToFile(entry.url, destPath, { label: `${name}.${ext}` }));
  }

  return { ready: true, files };
}
