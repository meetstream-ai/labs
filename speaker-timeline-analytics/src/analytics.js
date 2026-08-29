/**
 * Turn a raw speaker timeline into conversation metrics.
 *
 * `GET /bots/{bot_id}/get_speaker_timeline` returns:
 *
 *   {
 *     "chunks": [
 *       { "chunkIndex": 0, "timestamp": "...", "sampleRate": 48000,
 *         "speakerId": "...", "speakerName": "Alice",
 *         "startByte": 0, "endByte": 192000 }
 *     ],
 *     "lastUpdated": "...",
 *     "audioFilePath": "...",
 *     "totalFileSize": 123456789
 *   }
 *
 * The critical gotcha: `startByte` / `endByte` are **byte offsets into the
 * recorded audio file**, not time offsets. To express them as seconds you
 * need the audio encoding:
 *
 *   seconds = bytes / (sampleRate * bytesPerSample * channels)
 *
 * `sampleRate` comes from the chunk itself. MeetStream's audio pipeline is
 * 16-bit signed little-endian mono PCM, so `bytesPerSample = 2` and
 * `channels = 1` are the defaults here - both are overridable via env vars in
 * case your account is configured differently.
 *
 * Talk-time SHARES are exact regardless of that assumption, because they are
 * ratios of byte counts and the conversion constant cancels out. Only the
 * ABSOLUTE second figures depend on it.
 */

/** Stable identity for a speaker across chunks. */
function speakerKey(chunk) {
  if (chunk.speakerId !== undefined && chunk.speakerId !== null && chunk.speakerId !== '') {
    return String(chunk.speakerId);
  }
  if (chunk.speakerName) return `name:${chunk.speakerName}`;
  return 'unknown';
}

function chunkBytes(chunk) {
  const start = Number(chunk.startByte);
  const end = Number(chunk.endByte);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, end - start);
}

/** The most common positive sampleRate across chunks, or null. */
function modalSampleRate(chunks) {
  const counts = new Map();
  for (const c of chunks) {
    const rate = Number(c.sampleRate);
    if (Number.isFinite(rate) && rate > 0) counts.set(rate, (counts.get(rate) || 0) + 1);
  }
  if (counts.size === 0) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * @param {any} payload the raw get_speaker_timeline response
 * @param {{ bytesPerSample?: number, channels?: number }} [opts]
 */
export function analyzeTimeline(payload, { bytesPerSample = 2, channels = 1 } = {}) {
  const chunks = Array.isArray(payload?.chunks) ? payload.chunks : [];

  const base = {
    chunkCount: chunks.length,
    speakers: [],
    turns: [],
    turnCount: 0,
    totalBytes: 0,
    totalSeconds: null,
    secondsAvailable: false,
    sampleRate: null,
    audioBytes: Number(payload?.totalFileSize) || null,
    audioSeconds: null,
    silenceSeconds: null,
    longestMonologue: null,
    overlaps: [],
    overlapCount: 0,
    lastUpdated: payload?.lastUpdated ?? null,
    audioFilePath: payload?.audioFilePath ?? null,
  };

  if (chunks.length === 0) return base;

  const rate = modalSampleRate(chunks);
  const bytesPerSecond = rate ? rate * bytesPerSample * channels : null;
  const toSeconds = (b) => (bytesPerSecond ? b / bytesPerSecond : null);

  base.sampleRate = rate;
  base.secondsAvailable = bytesPerSecond !== null;

  // chunkIndex is the authoritative ordering; fall back to startByte.
  const ordered = [...chunks].sort((a, b) => {
    const ai = Number(a.chunkIndex);
    const bi = Number(b.chunkIndex);
    if (Number.isFinite(ai) && Number.isFinite(bi) && ai !== bi) return ai - bi;
    return Number(a.startByte || 0) - Number(b.startByte || 0);
  });

  // --- Group consecutive chunks from the same speaker into turns ---------
  /** @type {Array<{key:string,name:string,startByte:number,endByte:number,bytes:number,chunks:number,firstChunkIndex:any,timestamp:any}>} */
  const turns = [];
  for (const chunk of ordered) {
    const key = speakerKey(chunk);
    const name = chunk.speakerName || (key === 'unknown' ? 'Unknown speaker' : key);
    const start = Number(chunk.startByte) || 0;
    const end = Number(chunk.endByte) || start;
    const last = turns[turns.length - 1];

    if (last && last.key === key) {
      last.endByte = Math.max(last.endByte, end);
      last.bytes += chunkBytes(chunk);
      last.chunks += 1;
    } else {
      turns.push({
        key,
        name,
        startByte: start,
        endByte: end,
        bytes: chunkBytes(chunk),
        chunks: 1,
        firstChunkIndex: chunk.chunkIndex ?? null,
        timestamp: chunk.timestamp ?? null,
      });
    }
  }

  // --- Per-speaker rollup ------------------------------------------------
  /** @type {Map<string, any>} */
  const bySpeaker = new Map();
  for (const chunk of ordered) {
    const key = speakerKey(chunk);
    if (!bySpeaker.has(key)) {
      bySpeaker.set(key, {
        key,
        name: chunk.speakerName || (key === 'unknown' ? 'Unknown speaker' : key),
        speakerId: chunk.speakerId ?? null,
        bytes: 0,
        chunks: 0,
        turns: 0,
        longestTurnBytes: 0,
      });
    }
    const entry = bySpeaker.get(key);
    entry.bytes += chunkBytes(chunk);
    entry.chunks += 1;
    if (!entry.name && chunk.speakerName) entry.name = chunk.speakerName;
  }

  for (const turn of turns) {
    const entry = bySpeaker.get(turn.key);
    if (!entry) continue;
    entry.turns += 1;
    if (turn.bytes > entry.longestTurnBytes) entry.longestTurnBytes = turn.bytes;
  }

  const totalBytes = [...bySpeaker.values()].reduce((sum, s) => sum + s.bytes, 0);

  const speakers = [...bySpeaker.values()]
    .map((s) => ({
      ...s,
      seconds: toSeconds(s.bytes),
      share: totalBytes > 0 ? s.bytes / totalBytes : 0,
      longestTurnSeconds: toSeconds(s.longestTurnBytes),
      averageTurnSeconds: s.turns > 0 ? toSeconds(s.bytes / s.turns) : null,
    }))
    .sort((a, b) => b.bytes - a.bytes);

  // --- Longest monologue -------------------------------------------------
  const longest = turns.reduce((best, t) => (best === null || t.bytes > best.bytes ? t : best), null);

  // --- Overlap ("interruption-ish") detection ----------------------------
  // Two adjacent turns from different speakers whose byte ranges overlap
  // occupy the same stretch of the audio file, i.e. they were talking over
  // each other. This is the closest honest proxy for an interruption that
  // the timeline data supports.
  const overlaps = [];
  for (let i = 1; i < turns.length; i += 1) {
    const prev = turns[i - 1];
    const next = turns[i];
    if (prev.key === next.key) continue;
    const overlapBytes = Math.min(prev.endByte, next.endByte) - next.startByte;
    if (overlapBytes > 0) {
      overlaps.push({
        interrupter: next.name,
        interrupterKey: next.key,
        interrupted: prev.name,
        interruptedKey: prev.key,
        bytes: overlapBytes,
        seconds: toSeconds(overlapBytes),
        atByte: next.startByte,
        timestamp: next.timestamp,
      });
    }
  }

  const overlapsBySpeaker = new Map();
  for (const o of overlaps) {
    overlapsBySpeaker.set(o.interrupterKey, (overlapsBySpeaker.get(o.interrupterKey) || 0) + 1);
  }
  for (const s of speakers) {
    s.interruptions = overlapsBySpeaker.get(s.key) || 0;
  }

  const totalSeconds = toSeconds(totalBytes);
  const audioSeconds = base.audioBytes !== null ? toSeconds(base.audioBytes) : null;

  return {
    ...base,
    speakers,
    turns,
    turnCount: turns.length,
    totalBytes,
    totalSeconds,
    audioSeconds,
    silenceSeconds:
      audioSeconds !== null && totalSeconds !== null ? Math.max(0, audioSeconds - totalSeconds) : null,
    longestMonologue: longest
      ? {
          speaker: longest.name,
          bytes: longest.bytes,
          seconds: toSeconds(longest.bytes),
          chunks: longest.chunks,
          startByte: longest.startByte,
          endByte: longest.endByte,
          timestamp: longest.timestamp,
        }
      : null,
    overlaps,
    overlapCount: overlaps.length,
  };
}
