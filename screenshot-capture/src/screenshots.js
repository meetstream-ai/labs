import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { MeetStreamError, errorMessageFrom, parseBody } from './client.js';
import { collectDownloadUrls, downloadUrlToFile, guessExtension } from './download.js';
import { log } from './log.js';
import { extractTime, formatElapsed, normalizeSpeakerTimeline, speakerAt } from './timeline.js';

/**
 * Fetch, download and timeline-map meeting screenshots.
 */

/**
 * `GET /bots/{bot_id}/get_screenshots`
 *
 * @param {import('./client.js').MeetStreamClient} client
 * @param {string} botId
 * @returns {Promise<{ ready: boolean, status: number, data: any, message: string }>}
 */
export async function fetchScreenshots(client, botId) {
  const res = await client.raw('GET', `/bots/${botId}/get_screenshots`);
  const data = await parseBody(res);

  if (res.status === 202) {
    return { ready: false, status: 202, data, message: errorMessageFrom(data, res) || 'in_progress' };
  }
  if (res.status === 404) {
    return { ready: false, status: 404, data, message: errorMessageFrom(data, res) };
  }
  if (!res.ok && res.status !== 507) {
    throw new MeetStreamError(res.status, errorMessageFrom(data, res), data);
  }

  return { ready: true, status: res.status, data, message: '' };
}

/**
 * `GET /bots/{bot_id}/get_speaker_timeline` - optional enrichment. Returns
 * null rather than throwing, since a screenshot download should not fail just
 * because the speaker timeline is unavailable.
 *
 * @param {import('./client.js').MeetStreamClient} client
 * @param {string} botId
 * @returns {Promise<any|null>}
 */
export async function fetchSpeakerTimeline(client, botId) {
  try {
    const res = await client.raw('GET', `/bots/${botId}/get_speaker_timeline`);
    const data = await parseBody(res);
    if (res.status === 200 || res.status === 507) return data;
    log.warn(`Speaker timeline unavailable (HTTP ${res.status}: ${errorMessageFrom(data, res)}).`);
    return null;
  } catch (err) {
    log.warn(`Speaker timeline request failed: ${err.message}`);
    return null;
  }
}

/**
 * Turn the screenshots payload into an ordered list of downloadable shots.
 *
 * The payload shape varies, so this walks the JSON for `http(s)` URLs and then
 * looks for a time value on the object each URL was found on. When there is no
 * usable time field the shots keep their original response order and the
 * timeline report says so explicitly rather than inventing timestamps.
 *
 * @param {any} data
 * @returns {Array<{ url: string, index: number, timeKey: string|null, rawTime: unknown, ms: number|null, absolute: boolean|null }>}
 */
export function extractScreenshots(data) {
  const entries = collectDownloadUrls(data);

  const shots = entries.map((entry, index) => {
    const time = extractTime(entry.context);
    return {
      url: entry.url,
      index,
      timeKey: time?.key ?? null,
      rawTime: time?.raw ?? null,
      ms: time?.ms ?? null,
      absolute: time?.absolute ?? null,
    };
  });

  const timed = shots.filter((shot) => shot.ms !== null);
  if (timed.length === shots.length && shots.length > 1) {
    shots.sort((a, b) => a.ms - b.ms);
    shots.forEach((shot, index) => {
      shot.index = index;
    });
  }

  return shots;
}

/**
 * Download every screenshot into `<destDir>/screenshots/`.
 *
 * @param {object} params
 * @param {ReturnType<typeof extractScreenshots>} params.shots
 * @param {string} params.destDir
 * @returns {Promise<Array<{ shot: any, file: string|null, error: string|null }>>}
 */
export async function downloadScreenshots({ shots, destDir }) {
  const imagesDir = path.join(destDir, 'screenshots');
  await mkdir(imagesDir, { recursive: true });

  const results = [];
  const width = String(shots.length).length;

  for (const shot of shots) {
    const ext = guessExtension(null, shot.url, 'png');
    const fileName = `shot_${String(shot.index + 1).padStart(Math.max(width, 3), '0')}.${ext}`;
    const destPath = path.join(imagesDir, fileName);
    try {
      await downloadUrlToFile(shot.url, destPath, { label: fileName });
      results.push({ shot, file: path.join('screenshots', fileName), error: null });
    } catch (err) {
      log.error(`${fileName} failed: ${err.message}`);
      results.push({ shot, file: null, error: err.message });
    }
  }

  return results;
}

/**
 * Write `timeline.md` and `timeline.json` mapping each screenshot onto the
 * meeting timeline, with the active speaker when that can be determined.
 *
 * @param {object} params
 * @param {string} params.botId
 * @param {string} params.destDir
 * @param {Array<{ shot: any, file: string|null, error: string|null }>} params.results
 * @param {any} params.speakerTimelineData
 * @returns {Promise<{ markdownPath: string, jsonPath: string }>}
 */
export async function writeTimelineReport({ botId, destDir, results, speakerTimelineData }) {
  const { entries: speakerEntries, absolute: speakersAbsolute } =
    normalizeSpeakerTimeline(speakerTimelineData);

  const timedShots = results.filter((row) => row.shot.ms !== null);
  const shotsAbsolute = timedShots.length ? timedShots[0].shot.absolute : null;
  const baseMs = timedShots.length ? Math.min(...timedShots.map((row) => row.shot.ms)) : null;

  // Only correlate speakers when both timelines use the same time basis.
  const canCorrelate =
    speakerEntries.length > 0 &&
    timedShots.length > 0 &&
    speakersAbsolute !== null &&
    speakersAbsolute === shotsAbsolute;

  const rows = results.map((row, position) => {
    const { shot } = row;
    const elapsedMs = shot.ms !== null && baseMs !== null ? shot.ms - baseMs : null;
    return {
      order: position + 1,
      file: row.file,
      url: shot.url,
      time_field: shot.timeKey,
      raw_time: shot.rawTime,
      elapsed: elapsedMs === null ? null : formatElapsed(elapsedMs),
      elapsed_ms: elapsedMs,
      speaker: canCorrelate && shot.ms !== null ? speakerAt(speakerEntries, shot.ms) : null,
      error: row.error,
    };
  });

  const jsonPath = path.join(destDir, 'timeline.json');
  await writeFile(
    jsonPath,
    JSON.stringify(
      {
        bot_id: botId,
        generated_at: new Date().toISOString(),
        screenshot_count: results.length,
        timestamps_available: timedShots.length > 0,
        timestamp_field: timedShots[0]?.shot.timeKey ?? null,
        speaker_timeline_turns: speakerEntries.length,
        speaker_correlation: canCorrelate,
        screenshots: rows,
      },
      null,
      2
    )
  );

  const lines = [];
  lines.push(`# Screenshot timeline - ${botId}`);
  lines.push('');
  lines.push(`Generated ${new Date().toISOString()} - ${results.length} screenshot(s).`);
  lines.push('');

  if (timedShots.length === 0) {
    lines.push(
      '> The screenshots response carried no recognisable time field, so these are listed in the ' +
        'order the API returned them. Elapsed times are not shown rather than guessed.'
    );
    lines.push('');
  } else {
    lines.push(
      `Elapsed times are measured from the earliest screenshot, using the \`${timedShots[0].shot.timeKey}\` field.`
    );
    lines.push('');
  }

  if (speakerEntries.length === 0) {
    lines.push('> No speaker timeline was available, so the speaker column is omitted.');
    lines.push('');
  } else if (!canCorrelate) {
    lines.push(
      `> The speaker timeline has ${speakerEntries.length} turn(s), but it uses a different time ` +
        'basis than the screenshots (absolute vs relative), so the two cannot be correlated safely. ' +
        'Raw values for both are in `raw_get_speaker_timeline_response.json` and `timeline.json`.'
    );
    lines.push('');
  }

  const showSpeaker = canCorrelate;
  lines.push(showSpeaker ? '| # | Elapsed | Speaking | File |' : '| # | Elapsed | File |');
  lines.push(showSpeaker ? '|---|---------|----------|------|' : '|---|---------|------|');
  for (const row of rows) {
    const elapsed = row.elapsed ?? '-';
    const file = row.file ?? `(download failed: ${row.error})`;
    lines.push(
      showSpeaker
        ? `| ${row.order} | ${elapsed} | ${row.speaker ?? '-'} | ${file} |`
        : `| ${row.order} | ${elapsed} | ${file} |`
    );
  }
  lines.push('');

  const markdownPath = path.join(destDir, 'timeline.md');
  await writeFile(markdownPath, lines.join('\n'));

  return { markdownPath, jsonPath };
}

/**
 * @param {string} destDir
 * @param {string} name
 * @param {unknown} data
 * @returns {Promise<string>}
 */
export async function dumpRaw(destDir, name, data) {
  await mkdir(destDir, { recursive: true });
  const target = path.join(destDir, name);
  await writeFile(target, JSON.stringify(data, null, 2));
  return target;
}
