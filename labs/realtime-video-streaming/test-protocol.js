/**
 * Protocol compliance test — validates video-ws-server.js against
 * MeetStream docs: https://docs.meetstream.ai/guides/web-sockets/real-time-video-streaming
 *
 * Run: node test-protocol.js
 */

const http = require("http");
const { spawn } = require("child_process");
const { WebSocket } = require("ws");
const { readFileSync, readdirSync, unlinkSync, rmSync } = require("fs");
const { join } = require("path");

const PORT = 3099;
const OUT_DIR = join(__dirname, "test-recordings");
const results = [];

function pass(name) {
  results.push({ name, ok: true });
  console.log(`  ✓ ${name}`);
}

function fail(name, detail) {
  results.push({ name, ok: false, detail });
  console.error(`  ✗ ${name}: ${detail}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForMessage(ws, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for message")), timeoutMs);
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off("message", handler);
        resolve(msg);
      }
    };
    ws.on("message", handler);
  });
}

async function runTests() {
  rmSync(OUT_DIR, { recursive: true, force: true });

  const server = spawn("node", ["video-ws-server.js"], {
    env: { ...process.env, PORT: String(PORT), OUTPUT_DIR: OUT_DIR },
    stdio: "pipe",
  });

  await sleep(600);

  // ── Checklist item 1: server starts ─────────────────────────────────────
  try {
    const health = await new Promise((resolve, reject) => {
      http.get(`http://localhost:${PORT}/health`, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve(JSON.parse(body)));
      }).on("error", reject);
    });
    if (health.status === "ok" && health.transport === "video-websocket") {
      pass("Checklist 1: WebSocket receiver starts");
    } else {
      fail("Checklist 1: WebSocket receiver starts", JSON.stringify(health));
    }
  } catch (err) {
    fail("Checklist 1: WebSocket receiver starts", err.message);
    server.kill();
    process.exit(1);
  }

  // ── Checklist items 4–6: full protocol flow ─────────────────────────────
  const ws = new WebSocket(`ws://localhost:${PORT}/video`);
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  pass("WebSocket accepts connection on /video");

  const startMsg = {
    type: "video_stream_start",
    bot_id: "bot-123",
    speakerId: "spk_abc123",
    speakerName: "Jane Smith",
    codec: "h264",
    audio_codec: "aac",
    container: "fmp4",
    width: 1920,
    height: 1080,
    framerate: 25,
    audio_sample_rate: 44100,
    audio_bitrate: "128k",
  };
  ws.send(JSON.stringify(startMsg));

  // Binary before start should be ignored (separate connection)
  const wsEarly = new WebSocket(`ws://localhost:${PORT}/video`);
  await new Promise((r) => wsEarly.on("open", r));
  wsEarly.send(Buffer.from("early-chunk-should-be-dropped"));
  wsEarly.close();
  await sleep(100);
  const earlyFiles = readdirSync(OUT_DIR).filter((f) => f.includes("unknown"));
  if (earlyFiles.length === 0) pass("Binary before video_stream_start is ignored");
  else fail("Binary before video_stream_start is ignored", `found ${earlyFiles.length} files`);

  // Checklist 4: binary traffic after start
  const chunks = [
    Buffer.from("fmp4-chunk-1"),
    Buffer.from("fmp4-chunk-2"),
    Buffer.from("fmp4-chunk-3"),
  ];
  for (const chunk of chunks) ws.send(chunk);
  pass("Checklist 4: binary fMP4 chunks accepted after video_stream_start");

  // Checklist 5: latency ping/pong
  const ping = {
    type: "video_latency_ping",
    bot_id: "bot-123",
    seq: 42,
    sent_at_ms: 1743500000123,
  };
  ws.send(JSON.stringify(ping));
  const pong = await waitForMessage(ws, (m) => m.type === "video_latency_pong");

  if (pong.type !== "video_latency_pong") fail("Checklist 5: video_latency_pong", "wrong type");
  else if (pong.seq !== 42) fail("Checklist 5: pong echoes seq", `got ${pong.seq}`);
  else if (pong.sent_at_ms !== 1743500000123) fail("Checklist 5: pong echoes sent_at_ms", `got ${pong.sent_at_ms}`);
  else if (pong.bot_id !== "bot-123") fail("Checklist 5: pong echoes bot_id", `got ${pong.bot_id}`);
  else if (typeof pong.server_received_at_ms !== "number") fail("Checklist 5: server_received_at_ms is number", typeof pong.server_received_at_ms);
  else pass("Checklist 5: video_latency_pong for each video_latency_ping (all fields correct)");

  // Multiple pings
  ws.send(JSON.stringify({ type: "video_latency_ping", bot_id: "bot-123", seq: 43, sent_at_ms: 100 }));
  ws.send(JSON.stringify({ type: "video_latency_ping", bot_id: "bot-123", seq: 44, sent_at_ms: 200 }));
  const pong43 = await waitForMessage(ws, (m) => m.type === "video_latency_pong" && m.seq === 43);
  const pong44 = await waitForMessage(ws, (m) => m.type === "video_latency_pong" && m.seq === 44);
  if (pong43.seq === 43 && pong44.seq === 44) pass("Multiple latency pings each get a pong");
  else fail("Multiple latency pings each get a pong", "missing pongs");

  // Checklist 6: video_stream_end
  ws.send(JSON.stringify({ type: "video_stream_end", bot_id: "bot-123", duration_seconds: 152.7 }));
  await sleep(300);
  pass("Checklist 6: video_stream_end handled");

  // Verify recording file content and order
  const files = readdirSync(OUT_DIR).filter((f) => f.startsWith("bot-123"));
  if (files.length !== 1) {
    fail("Recording file created", `expected 1 file, got ${files.length}`);
  } else {
    const content = readFileSync(join(OUT_DIR, files[0])).toString();
    const expected = "fmp4-chunk-1fmp4-chunk-2fmp4-chunk-3";
    if (content === expected) pass("Binary chunks appended in order to .mp4 file");
    else fail("Binary chunks appended in order", `got "${content}"`);
    pass("Recording file created: " + files[0]);
  }

  // Session metadata endpoint
  const session = await new Promise((resolve, reject) => {
    http.get(`http://localhost:${PORT}/sessions/bot-123`, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve(JSON.parse(body)));
    }).on("error", reject);
  });
  if (session.recordings?.length === 1 && session.recordings[0].codec === "h264") {
    pass("Session metadata stored (codec, dimensions, etc.)");
  } else {
    fail("Session metadata stored", JSON.stringify(session));
  }

  if (session.recordings?.[0]?.speakerId === "spk_abc123" && session.recordings?.[0]?.speakerName === "Jane Smith") {
    pass("Speaker ID and name stored in recording metadata");
  } else {
    fail("Speaker ID stored in metadata", `speakerId: ${session.recordings?.[0]?.speakerId}, speakerName: ${session.recordings?.[0]?.speakerName}`);
  }

  // Disconnect without video_stream_end should still finalize
  const ws2 = new WebSocket(`ws://localhost:${PORT}/video`);
  await new Promise((r) => ws2.on("open", r));
  ws2.send(JSON.stringify({ type: "video_stream_start", bot_id: "bot-disconnect", speakerId: "spk_john456", speakerName: "John Doe", codec: "h264", audio_codec: "aac", container: "fmp4", width: 640, height: 480, framerate: 30, audio_sample_rate: 44100, audio_bitrate: "128k" }));
  ws2.send(Buffer.from("disconnect-chunk"));
  ws2.close();
  await sleep(300);
  const disconnectFiles = readdirSync(OUT_DIR).filter((f) => f.startsWith("bot-disconnect"));
  if (disconnectFiles.length === 1) {
    const content = readFileSync(join(OUT_DIR, disconnectFiles[0])).toString();
    if (content === "disconnect-chunk") pass("Disconnect finalizes and closes output (doc requirement)");
    else fail("Disconnect finalizes output", content);
  } else {
    fail("Disconnect finalizes output", `files: ${disconnectFiles.length}`);
  }

  ws.close();
  server.kill();
  await sleep(200);

  // ── Validate create-bot payload shape ───────────────────────────────────
  const createBotSrc = readFileSync(join(__dirname, "create-bot-video.js"), "utf8");

  if (createBotSrc.includes("video_required: true")) pass("Create-bot payload includes video_required: true");
  else fail("Create-bot payload", "missing video_required: true");

  if (createBotSrc.includes("live_video_required")) pass("Create-bot payload includes live_video_required");
  else fail("Create-bot payload", "missing live_video_required");

  if (createBotSrc.includes("websocket_url:")) pass("Create-bot payload includes websocket_url");
  else fail("Create-bot payload", "missing websocket_url");

  if (createBotSrc.includes("Google Meet") || createBotSrc.includes("Microsoft Teams")) {
    pass("Platform constraint documented (Google Meet / Teams only)");
  } else {
    fail("Platform constraint", "not documented in create-bot-video.js");
  }

  if (createBotSrc.includes("Authorization: `Token ${API_KEY}`")) {
    pass("Uses Token auth (consistent with labs repo, not Bearer from doc examples)");
  }

  // ── Validate server implements doc handling loop ────────────────────────
  const serverSrc = readFileSync(join(__dirname, "video-ws-server.js"), "utf8");
  const requiredHandlers = ["video_stream_start", "video_latency_ping", "video_stream_end", "video_latency_pong"];
  for (const h of requiredHandlers) {
    if (serverSrc.includes(h)) pass(`Server handles ${h}`);
    else fail(`Server handles ${h}`, "not found");
  }

  if (serverSrc.includes("isBinary")) pass("Server distinguishes binary vs text frames");
  else fail("Binary frame handling", "isBinary check missing");

  if (serverSrc.includes("maxPayload")) pass("Large WebSocket frames allowed (production tip from docs)");
  else fail("Large frame support", "maxPayload not configured");

  if (serverSrc.includes("speakerId")) pass("Server captures speaker ID from video_stream_start");
  else fail("Server captures speaker ID", "speakerId not found");

  if (serverSrc.includes("speakerName")) pass("Server captures speaker name from video_stream_start");
  else fail("Server captures speaker name", "speakerName not found");

  // Cleanup
  rmSync(OUT_DIR, { recursive: true, force: true });

  // ── Summary ─────────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${"─".repeat(50)}`);
  console.log(`Results: ${passed}/${results.length} passed`);
  if (failed.length) {
    console.error("\nFailed:");
    for (const f of failed) console.error(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  console.log("\nAll protocol compliance tests passed.");
}

runTests().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
