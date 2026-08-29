import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { log } from './log.js';
import { backoffDelay, formatBytes, sleep } from './util.js';

/**
 * Streaming downloads with a progress meter.
 *
 * Everything here works off a `Response` object, so the same code handles both
 * cases MeetStream can return: the API streaming the media file back directly,
 * and the API returning JSON that points at a presigned storage URL.
 */

/**
 * Pipe a response body to disk, printing progress as it goes.
 *
 * @param {Response} res
 * @param {string} destPath
 * @param {object} [opts]
 * @param {string} [opts.label] - shown in the progress line
 * @returns {Promise<{ path: string, bytes: number }>}
 */
export async function saveResponseToFile(res, destPath, { label } = {}) {
  if (!res.body) throw new Error(`Response for ${destPath} had no body to download.`);

  await mkdir(path.dirname(destPath), { recursive: true });

  const totalHeader = Number(res.headers.get('content-length'));
  const total = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : null;
  const name = label || path.basename(destPath);

  let received = 0;
  let lastRender = 0;

  const render = (force = false) => {
    const now = Date.now();
    if (!force && now - lastRender < 200) return;
    lastRender = now;
    const size = formatBytes(received);
    const line = total
      ? `${name}  ${size} / ${formatBytes(total)}  (${Math.floor((received / total) * 100)}%)`
      : `${name}  ${size}`;
    if (log.isTty) {
      log.raw(`\r  ${line}${force ? '\n' : '   '}`);
    } else if (force) {
      log.info(`Downloaded ${line}`);
    }
  };

  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      render();
      callback(null, chunk);
    },
  });

  await pipeline(Readable.fromWeb(res.body), meter, createWriteStream(destPath));
  render(true);

  const { size } = await stat(destPath);
  return { path: destPath, bytes: size };
}

/**
 * Download a plain URL (typically a presigned storage URL) to disk.
 * Presigned URLs must NOT carry your API key, so no auth header is sent
 * unless you pass one explicitly.
 *
 * @param {string} url
 * @param {string} destPath
 * @param {object} [opts]
 * @param {Record<string,string>} [opts.headers]
 * @param {string} [opts.label]
 * @param {number} [opts.maxRetries]
 * @returns {Promise<{ path: string, bytes: number }>}
 */
export async function downloadUrlToFile(url, destPath, { headers, label, maxRetries = 3 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${res.statusText} ${text.slice(0, 200)}`.trim());
      }
      return await saveResponseToFile(res, destPath, { label });
    } catch (err) {
      lastError = err;
      if (attempt === maxRetries) break;
      const waitMs = backoffDelay(attempt, 1000);
      log.warn(`Download of ${label || destPath} failed (${err.message}). Retrying in ${Math.round(waitMs)}ms.`);
      await sleep(waitMs);
    }
  }
  throw new Error(`Could not download ${label || url}: ${lastError?.message}`);
}

/**
 * Guess a file extension from the response content-type, then from the URL.
 *
 * @param {Response|null} res
 * @param {string} [url]
 * @param {string} [fallback]
 * @returns {string} extension without the leading dot
 */
export function guessExtension(res, url = '', fallback = 'bin') {
  const contentType = (res?.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const byType = {
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/wave': 'wav',
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/flac': 'flac',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'video/x-matroska': 'mkv',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'application/zip': 'zip',
  }[contentType];
  if (byType) return byType;

  const withoutQuery = String(url).split(/[?#]/)[0];
  const fromUrl = /\.([a-z0-9]{2,5})$/i.exec(withoutQuery);
  if (fromUrl) return fromUrl[1].toLowerCase();

  return fallback;
}

/**
 * Walk an arbitrary JSON body and collect every downloadable http(s) URL,
 * along with whatever naming hints sit next to it.
 *
 * MeetStream's media endpoints return JSON whose exact shape varies by
 * endpoint and account (single object, array of objects, or nested
 * participants -> streams -> segments). Rather than hardcode one shape and
 * break on the others, this walks the tree. The raw JSON is always written to
 * disk alongside the media so you can see exactly what came back.
 *
 * @param {unknown} data
 * @returns {Array<{ url: string, hints: string[], context: Record<string, unknown> }>}
 */
export function collectDownloadUrls(data) {
  /** @type {Array<{ url: string, hints: string[], context: Record<string, unknown> }>} */
  const found = [];
  const seenUrls = new Set();
  const HINT_KEYS = [
    'participant_name',
    'participant',
    'speaker',
    'name',
    'filename',
    'file_name',
    'type',
    'stream_type',
    'media_type',
    'label',
    'id',
  ];

  /**
   * @param {unknown} node
   * @param {string[]} inheritedHints
   */
  const walk = (node, inheritedHints) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, inheritedHints);
      return;
    }
    if (!node || typeof node !== 'object') return;

    const localHints = [...inheritedHints];
    for (const key of HINT_KEYS) {
      const value = node[key];
      if (typeof value === 'string' && value.trim() && !/^https?:\/\//i.test(value)) {
        localHints.push(value.trim());
      } else if (value && typeof value === 'object' && typeof value.name === 'string') {
        localHints.push(value.name.trim());
      }
    }

    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
        if (seenUrls.has(value)) continue;
        seenUrls.add(value);
        found.push({
          url: value,
          hints: [...localHints, key.replace(/_?url$/i, '')].filter(Boolean),
          context: node,
        });
      } else if (value && typeof value === 'object') {
        walk(value, localHints);
      }
    }
  };

  walk(data, []);
  return found;
}
