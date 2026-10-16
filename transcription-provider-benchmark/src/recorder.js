/**
 * Step 1: get the reference clip recorded as a real meeting.
 *
 * Two bots join the same call:
 *   - the listener records it, exactly as a customer's notetaker would;
 *   - the speaker plays the clip into the call over its control WebSocket
 *     (the `sendaudio` command), so no human has to press play and the audio
 *     goes through the meeting platform's own codec and mixing.
 *
 * The output is recordings/<listener_bot_id>.json. Step 2 (benchmark) sends
 * that one recording to every provider.
 */
const fs = require("fs");
const http = require("http");
const path = require("path");
const { WebSocketServer } = require("ws");
const api = require("./api");
const { decodeToPcm, sha256File, textSha256 } = require("./audio");
const { startTunnel } = require("./tunnel");
const { PROVIDERS } = require("./providers");

const SEND_RATE = 48_000;           // what sendaudio expects
const CHUNK_SECONDS = 1;
// Keep this much audio queued on the bot. With 0.5s a live Meet run drifted
// ~4.6s behind real time over 3 minutes, which looks like the bot running
// dry and padding with silence.
const LEAD_SECONDS = 2;
const SETTLE_SECONDS = 5;           // silence before the clip
// Wait this long after the last chunk is sent before removing the bots. The
// bot is still playing its queue (plus any drift) after we finish sending,
// and removing it at +5s cut the last ~13s of a 191s clip from the recording.
const TAIL_SECONDS = 20;
const JOIN_TIMEOUT_MS = 10 * 60_000; // time allowed for someone to admit the bots
// In the call: on Zoom, granting the bot recording permission moves it to
// RecordingPermissionAllowed, which is still in the call.
const IN_CALL = new Set(["InMeeting", "Recording", "RecordingPermissionAllowed"]);
// Statuses that mean a bot has left or will not record. Anything else (new or
// platform-specific statuses included) is not treated as leaving.
const LEFT = new Set(["Leaving", "Stopped", "Done", "Failed", "Error", "Denied", "NotAllowed", "RecordingPermissionDenied"]);
const FAILED = new Set(["Failed", "Denied", "NotAllowed", "Stopped", "Done", "Error"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)));
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function waitInCall(botId, label) {
  const deadline = Date.now() + JOIN_TIMEOUT_MS;
  let last = "";
  while (Date.now() < deadline) {
    const status = await api.getBotStatus(botId).catch((e) => `error (${api.describeError(e)})`);
    if (status !== last) {
      console.log(`   ${label.padEnd(8)} ${status}${status === "InWaitingRoom" ? "  <- admit it from the meeting" : ""}`);
      last = status;
    }
    if (IN_CALL.has(status)) return;
    if (FAILED.has(status)) {
      // MeetStream keeps the reason in the bot's status timeline, e.g. "Zoom
      // authentication failed ... AUTHRET_JWTTOKENWRONG" (wrong Zoom SDK credentials).
      const why = await api.getFailureReason(botId).catch(() => null);
      throw new Error(`${label} bot ended with status ${status} before the clip was played${why ? `: ${why}` : ""}`);
    }
    await sleep(3000);
  }
  throw new Error(`${label} bot was not admitted within ${JOIN_TIMEOUT_MS / 60_000} minutes`);
}

/** Resolves with the first WebSocket the speaker bot opens to us. */
function startControlServer(port) {
  const server = http.createServer((_req, res) => res.end("ok"));
  const wss = new WebSocketServer({ server, path: "/control" });
  let resolveSocket;
  const socket = new Promise((r) => (resolveSocket = r));
  wss.on("connection", (ws) => {
    console.log("   speaker  control socket connected");
    let logged = 0;
    ws.on("message", (raw) => {
      // Log the first few messages so an unexpected handshake is visible.
      if (logged++ < 3) console.log(`   speaker  says: ${raw.toString().slice(0, 160)}`);
    });
    resolveSocket(ws);
  });
  return new Promise((resolve) => server.listen(port, () => resolve({ server, wss, socket })));
}

async function play(ws, botId, pcm, { stopped = () => null, out = process.stdout } = {}) {
  const bytesPerChunk = SEND_RATE * 2 * CHUNK_SECONDS;
  const started = Date.now();
  const total = Math.ceil(pcm.length / bytesPerChunk);
  for (let i = 0; i < total; i++) {
    // Stop at once if the recorder has left: playing on records nothing.
    const why = stopped();
    if (why) {
      out.write("\n");
      throw new Error(`stopped playing at ${i * CHUNK_SECONDS}s: ${why}`);
    }
    const chunk = pcm.subarray(i * bytesPerChunk, (i + 1) * bytesPerChunk);
    ws.send(JSON.stringify({
      command: "sendaudio",
      bot_id: botId,
      audiochunk: chunk.toString("base64"),
      sample_rate: SEND_RATE,
      encoding: "pcm16",
      channels: 1,
      endianness: "little",
    }));
    if (i % 10 === 0) out.write(`\r   playing  ${i * CHUNK_SECONDS}s / ${total * CHUNK_SECONDS}s`);
    // Pace against the wall clock rather than sleeping a fixed amount per
    // chunk, so small delays don't accumulate into drift.
    const nextAt = started + ((i + 1) * CHUNK_SECONDS - LEAD_SECONDS) * 1000;
    await sleep(Math.max(0, nextAt - Date.now()));
  }
  out.write(`\r   playing  done (${(pcm.length / 2 / SEND_RATE).toFixed(1)}s)          \n`);
}

const MIN_CLIP_SECONDS = 3;
const SILENT_PEAK = 330; // about -40 dBFS of 16-bit audio: nothing a provider could transcribe

/**
 * Refuses audio that can't make a meaningful run, before any bot is sent (two
 * bots in a meeting cost money): too short, or silent.
 */
function checkClip(pcm) {
  const seconds = pcm.length / 2 / SEND_RATE;
  if (seconds < MIN_CLIP_SECONDS) throw new Error(`The audio is ${seconds.toFixed(2)} s long; use at least ${MIN_CLIP_SECONDS} s of speech.`);
  let peak = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
  if (peak < SILENT_PEAK) throw new Error("The audio is silent (or nearly): there is nothing to transcribe.");
  return seconds;
}

async function record({ meetingLink, audioPath, referencePath, port, liveProvider, synthetic = null }) {
  const pcm = await decodeToPcm(audioPath, SEND_RATE);
  const clipSeconds = checkClip(pcm);
  console.log(`  Clip       ${audioPath} (${clipSeconds.toFixed(1)}s)`);
  console.log(`  Reference  ${referencePath ?? "none (turnaround only, no accuracy)"}`);
  console.log(`  Meeting    ${meetingLink}\n`);

  const { server, socket } = await startControlServer(port);
  const tunnel = await startTunnel(port);
  const controlUrl = tunnel.replace(/^http/, "ws") + "/control";

  const bots = {};
  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    // In parallel: remove_bot only answers once the bot has left (~15s each).
    await Promise.all(
      Object.entries(bots).map(([label, id]) =>
        api.removeBot(id).then(
          () => console.log(`   ${label.padEnd(8)} removed`),
          (e) => console.warn(`   ${label.padEnd(8)} could not be removed: ${api.describeError(e)}`)
        )
      )
    );
    server.close();
  };

  try {
    const listener = await api.createBot({
      meeting_link: meetingLink,
      bot_name: "Benchmark Recorder",
      video_required: false,
      // Meeting captions by default: MeetStream runs each provider once per
      // recording, and those runs belong to the benchmark, where they are
      // timed. --live-provider spends one provider's run here instead, for a
      // provider the re-transcribe endpoint will not run (AssemblyAI, as of
      // 2026-09-28); the benchmark then scores this live transcript for it.
      recording_config: { transcript: { provider: liveProvider ? PROVIDERS[liveProvider] : { meeting_captions: {} } } },
    });
    bots.listener = listener.bot_id ?? listener.id;
    console.log(`  Listener bot ${bots.listener}`);

    const speaker = await api.createBot({
      meeting_link: meetingLink,
      bot_name: "Benchmark Speaker",
      video_required: false,
      socket_connection_url: { websocket_url: controlUrl },
    });
    bots.speaker = speaker.bot_id ?? speaker.id;
    console.log(`  Speaker bot  ${bots.speaker}\n`);

    console.log("  Waiting for both bots to be in the call (keep everyone else muted)...");
    await Promise.all([waitInCall(bots.listener, "listener"), waitInCall(bots.speaker, "speaker")]);
    const ws = await withTimeout(socket, 60_000, "speaker bot never opened its control WebSocket");

    // Watch the recorder while the clip plays and through the tail: it can
    // leave mid-clip (on Zoom, when the host doesn't grant recording
    // permission within a minute), and then nothing is being recorded.
    let recorderGone = null;
    let playedAt;
    const watch = setInterval(async () => {
      const status = await api.getBotStatus(bots.listener).catch(() => null);
      if (status && LEFT.has(status) && !recorderGone) {
        const why = await api.getFailureReason(bots.listener).catch(() => null);
        recorderGone = `the recorder bot left the call (${status}${why ? `: ${why}` : ""})`;
      }
    }, 5000);
    try {
      await sleep(SETTLE_SECONDS * 1000);
      playedAt = new Date().toISOString();
      await play(ws, bots.speaker, pcm, { stopped: () => recorderGone });
      console.log(`   waiting ${TAIL_SECONDS}s for the bot to finish playing its queue`);
      await sleep(TAIL_SECONDS * 1000);
      if (recorderGone) throw new Error(`no full recording: ${recorderGone}`);
    } finally {
      clearInterval(watch);
    }

    await cleanup();
    const leftAt = Date.now();
    const live = liveProvider ? await timeLiveTranscript(bots.listener, liveProvider, leftAt) : null;

    const recording = {
      bot_id: bots.listener,
      speaker_bot_id: bots.speaker,
      meeting_platform: new URL(meetingLink).hostname,
      played_at: playedAt,
      live_provider: liveProvider ?? "meeting_captions",
      // Only for a --live-provider: from both bots having left the call to
      // the first poll that saw the live transcript finished.
      live_transcript: live,
      clip: {
        path: path.relative(process.cwd(), audioPath).split(path.sep).join("/"),
        sha256: sha256File(audioPath),
        seconds: +clipSeconds.toFixed(3),
        // Set when the clip is text-to-speech of a typed script (which engine).
        ...(synthetic ? { synthetic_speech: synthetic } : {}),
      },
      reference: referencePath
        ? { path: path.relative(process.cwd(), referencePath).split(path.sep).join("/"), sha256: textSha256(referencePath), sha256_line_endings: "lf" }
        : null,
    };
    fs.mkdirSync("recordings", { recursive: true });
    const out = path.join("recordings", `${bots.listener}.json`);
    fs.writeFileSync(out, JSON.stringify(recording, null, 2) + "\n");
    console.log(`\n  Recording saved -> ${out}`);
    console.log(`  Next: npm run benchmark -- --bot-id ${bots.listener}\n`);
    return recording;
  } finally {
    await cleanup();
  }
}

/**
 * Recorder-only mode (--no-speaker): one bot joins and records whatever the
 * people in the call say or play, with no speaker bot. It stays until the
 * meeting ends, someone removes it, or `maxMinutes` pass. A reference
 * transcript is optional: without one the benchmark reports turnaround only.
 */
async function recordListenerOnly({ meetingLink, botName, referencePath, maxMinutes = 30 }) {
  console.log(`  Meeting    ${meetingLink}`);
  console.log(`  Bot name   ${botName}`);
  console.log(`  Reference  ${referencePath ?? "none (turnaround only, no accuracy)"}\n`);

  const bot = await api.createBot({
    meeting_link: meetingLink,
    bot_name: botName,
    video_required: false,
    recording_config: { transcript: { provider: { meeting_captions: {} } } },
  });
  const botId = bot.bot_id ?? bot.id;
  console.log(`  Recorder bot ${botId}`);

  let removed = false;
  const remove = async (why) => {
    if (removed) return;
    removed = true;
    console.log(`   ${why}; removing the bot`);
    await api.removeBot(botId).catch((e) => console.warn(`   could not remove the bot: ${api.describeError(e)}`));
  };
  process.once("SIGINT", () => remove("Ctrl+C").then(() => process.exit(130)));

  try {
    await waitInCall(botId, "recorder");
    const joinedAt = new Date().toISOString();
    console.log(`\n  Recording. Speak or play audio in the call now; it ends when the meeting ends,`);
    console.log(`  when you remove "${botName}", or after ${maxMinutes} minutes.\n`);

    const deadline = Date.now() + maxMinutes * 60_000;
    let status = "InMeeting";
    while (IN_CALL.has(status) && Date.now() < deadline) {
      await sleep(5000);
      status = await api.getBotStatus(botId).catch(() => status);
    }
    if (IN_CALL.has(status)) await remove(`${maxMinutes} minutes reached`);
    else console.log(`   recorder ${status}`);

    const recording = {
      bot_id: botId,
      bot_name: botName,
      speaker_bot_id: null,
      meeting_platform: new URL(meetingLink).hostname,
      joined_at: joinedAt,
      left_at: new Date().toISOString(),
      live_provider: "meeting_captions",
      clip: null,
      reference: referencePath
        ? { path: path.relative(process.cwd(), referencePath).split(path.sep).join("/"), sha256: textSha256(referencePath), sha256_line_endings: "lf" }
        : null,
    };
    fs.mkdirSync("recordings", { recursive: true });
    const out = path.join("recordings", `${botId}.json`);
    fs.writeFileSync(out, JSON.stringify(recording, null, 2) + "\n");
    console.log(`\n  Recording saved -> ${out}`);
    console.log(`  Next: npm run benchmark -- --bot-id ${botId}\n`);
    return recording;
  } catch (err) {
    await remove("stopping on an error");
    throw err;
  }
}

/**
 * A live provider's job starts by itself once the bot leaves, so its
 * turnaround is timed from then: post-call media processing plus the
 * provider, not comparable with a re-transcribe request's turnaround, which
 * starts from a recording MeetStream has already processed.
 */
async function timeLiveTranscript(botId, provider, leftAt, pollMs = 5000, timeoutMs = 30 * 60_000) {
  console.log(`   timing the live ${provider} transcript from the bots leaving...`);
  let lastPoll = leftAt;
  while (Date.now() - leftAt < timeoutMs) {
    await sleep(pollMs);
    const listed = await api.listTranscriptions(botId).catch(() => []);
    const now = Date.now();
    const job = listed.find((t) => t.provider === provider && t.status !== "Processing");
    if (job) {
      const result = {
        provider,
        transcript_id: job.transcript_id,
        status: job.status,
        left_call_at: new Date(leftAt).toISOString(),
        turnaround_after_leaving_s: +((now - leftAt) / 1000).toFixed(2),
        turnaround_after_leaving_lower_bound_s: +((lastPoll - leftAt) / 1000).toFixed(2),
        poll_seconds: pollMs / 1000,
      };
      console.log(`   ${provider.padEnd(12)} ${job.status} ${result.turnaround_after_leaving_s}s after the bots left`);
      return result;
    }
    lastPoll = now;
  }
  console.warn(`   ${provider} live transcript not finished ${timeoutMs / 60_000} minutes after the bots left`);
  return { provider, status: "TimedOut", left_call_at: new Date(leftAt).toISOString() };
}

module.exports = { record, recordListenerOnly, startControlServer, play, timeLiveTranscript, checkClip, waitInCall, IN_CALL, LEFT, SEND_RATE };
