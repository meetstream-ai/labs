import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterEach, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { Bridge, withoutWakeWord } from "../src/bridge.js";
import { checkConnectivity } from "../src/config.js";
import { createSessionSchema, defaultWakeWords, platformFor } from "../src/schema.js";
import { buildApp } from "../src/server.js";
import { ensureMeetStreamAgent } from "../scripts/install-meetstream.js";

const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

const baseInput = {
  meeting_url: "https://meet.google.com/abc-defg-hij",
  openclaw: {
    base_url: "https://openclaw.test/v1",
    api_key: "openclaw-secret"
  },
  meetstream: {
    base_url: "https://meetstream.test",
    api_key: "meetstream-secret",
    mia: { reuse_by_name: true }
  },
  wake_words: [],
  output: "chat" as const
};

type Call = { url: string; method: string; headers: Headers; body?: Record<string, unknown> };

function fakeFetch(calls: Call[]): typeof fetch {
  return async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ url, method, headers, body });
    if (url === "https://meetstream.test/api/v1/mia" && method === "GET") {
      return Response.json({ agent_configs: [], count: 0 });
    }
    if (url === "https://meetstream.test/api/v1/mia" && method === "POST") {
      return Response.json({ agent_config_id: "mia-123" });
    }
    if (url.endsWith("/api/v1/bots/create_bot")) {
      return Response.json({ bot_id: "bot-123", transcript_id: "transcript-123" }, { status: 201 });
    }
    if (url.endsWith("/send_message")) {
      return Response.json({ status: "accepted", bot_id: "bot-123", command: "sendmsg" });
    }
    if (url.endsWith("/remove_bot")) return Response.json({ status: "accepted" });
    if (url === "https://openclaw.test/v1/models") {
      return Response.json({ object: "list", data: [{ id: "openclaw/default" }] });
    }
    if (url === "https://openclaw.test/v1/responses") {
      return Response.json({
        id: "resp-1",
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "OpenClaw says hello." }]
        }]
      });
    }
    if (url === "https://openclaw.test/v1/chat/completions") {
      return Response.json({ choices: [{ message: { role: "assistant", content: "OpenClaw says hello." } }] });
    }
    if (url === "https://speech.test/v1/audio/speech") {
      return new Response(Buffer.alloc(128, 1));
    }
    return Response.json({ error: "not found" }, { status: 404 });
  };
}

test("validates supported meeting platforms and voice configuration", () => {
  for (const [url, platform] of [
    ["https://meet.google.com/abc-defg-hij", "google_meet"],
    ["https://acme.zoom.us/j/123", "zoom"],
    ["https://teams.microsoft.com/l/meetup-join/abc", "microsoft_teams"]
  ] as const) {
    assert.equal(createSessionSchema.safeParse({ ...baseInput, meeting_url: url }).success, true);
    assert.equal(platformFor(url), platform);
  }
  assert.equal(createSessionSchema.safeParse({ ...baseInput, meeting_url: "https://example.com" }).success, false);
  assert.equal(createSessionSchema.safeParse({ ...baseInput, output: "voice" }).success, false);
});

test("uses the requested wake words and strips them before OpenClaw", () => {
  assert.deepEqual(defaultWakeWords, ["hey assistant", "hey openclaw", "hey bot", "okay agent", "okay bot"]);
  assert.equal(withoutWakeWord("Hey Assistant, what did we decide?", ["hey assistant"]), "what did we decide?");
  assert.equal(withoutWakeWord("Hey, assistant, what did we decide?", ["hey assistant"]), "what did we decide?");
  assert.equal(
    withoutWakeWord(
      "Hey, assistant! What is two times two? Hey assistant! What are LLMs?",
      ["hey assistant"]
    ),
    "What are LLMs?"
  );
  assert.equal(withoutWakeWord("okay bot: summarize this", ["okay bot"]), "summarize this");
  assert.equal(withoutWakeWord("Can someone ask Hey OpenClaw a question?", ["hey openclaw"]), undefined);
  assert.equal(withoutWakeWord("Hey OpenClaw", ["hey openclaw"]), undefined);
});

test("ignores non-wake-word turns with default wake words", async () => {
  const calls: Call[] = [];
  const bridge = new Bridge(() => "https://bridge.ngrok.app", fakeFetch(calls));
  const { wake_words: _disabledForOtherTests, ...wakeEnabledInput } = baseInput;
  const session = await bridge.create(createSessionSchema.parse(wakeEnabledInput));
  assert.equal(bridge.accept(session, { command: "usermsg", event_id: "quiet", message: "What did we decide?" }), false);
  assert.equal(bridge.accept(session, { command: "usermsg", event_id: "awake", message: "Hey OpenClaw, what did we decide?" }), true);
  await session.queue;
  const request = calls.find((call) => call.url.endsWith("/chat/completions"));
  assert.deepEqual((request?.body?.messages as Array<{ content: string }>).at(-1)?.content, "[Participant] what did we decide?");
});

test("preflights MeetStream and OpenClaw without creating a bot", async () => {
  const calls: Call[] = [];
  await checkConnectivity(createSessionSchema.parse(baseInput), fakeFetch(calls));
  assert.deepEqual(calls.map(({ method, url }) => [method, url]), [
    ["GET", "https://meetstream.test/api/v1/mia"],
    ["GET", "https://openclaw.test/v1/models"]
  ]);
  assert.equal(calls.some(({ url }) => url.endsWith("/create_bot")), false);
});

test("installs the OpenClaw external-runtime agent into MeetStream MIA", async () => {
  const calls: Call[] = [];
  const result = await ensureMeetStreamAgent({
    baseUrl: "https://meetstream.test",
    apiKey: "meetstream-secret"
  }, fakeFetch(calls));
  assert.deepEqual(result, { id: "mia-123", created: true });
  assert.deepEqual(calls.slice(0, 2).map(({ method, url }) => [method, url]), [
    ["GET", "https://meetstream.test/api/v1/mia"],
    ["POST", "https://meetstream.test/api/v1/mia"]
  ]);
  assert.equal(calls[1]?.headers.get("authorization"), "Token meetstream-secret");
  assert.equal(calls[1]?.body?.agent_name, "OpenClaw External Runtime");
});

test("ships a detached cleanup guard for interrupted local runs", async () => {
  const guard = await readFile(new URL("../scripts/cleanup-guard.ts", import.meta.url), "utf8");
  assert.match(guard, /remove_bot/);
  assert.match(guard, /parentIsRunning/);
});

test("creates MIA and bot using the supplied Postman contract", async () => {
  const calls: Call[] = [];
  const bridge = new Bridge(() => "https://bridge.ngrok.app", fakeFetch(calls));
  const session = await bridge.create(createSessionSchema.parse({
    ...baseInput,
    openclaw: { ...baseInput.openclaw, mode: "auto" }
  }));
  assert.equal(session.miaConfigId, "mia-123");
  assert.equal(session.botId, "bot-123");
  assert.deepEqual(calls.slice(0, 3).map(({ url, method }) => [method, url]), [
    ["GET", "https://meetstream.test/api/v1/mia"],
    ["POST", "https://meetstream.test/api/v1/mia"],
    ["POST", "https://meetstream.test/api/v1/bots/create_bot"]
  ]);
  assert.equal(calls[2]?.headers.get("authorization"), "Token meetstream-secret");
  const body = calls[2]?.body as Record<string, unknown>;
  assert.equal(body.meeting_link, baseInput.meeting_url);
  assert.deepEqual(body.socket_connection_url, {
    websocket_url: `wss://bridge.ngrok.app/ws/meetstream/control/${session.token}`
  });
  assert.deepEqual(body.live_audio_required, {
    websocket_url: `wss://bridge.ngrok.app/ws/meetstream/audio/${session.token}`
  });
  assert.deepEqual(body.live_transcription_required, {
    webhook_url: "https://bridge.ngrok.app/webhooks/meetstream/transcription"
  });
});

test("routes a finalized turn to OpenClaw and back to meeting chat", async () => {
  const calls: Call[] = [];
  const sent: string[] = [];
  const bridge = new Bridge(() => "https://bridge.ngrok.app", fakeFetch(calls));
  const session = await bridge.create(createSessionSchema.parse(baseInput));
  bridge.bind(session.token, "bot-123", { readyState: 1, send: (message) => sent.push(message) });
  assert.equal(bridge.accept(session, {
    command: "usermsg",
    event_id: "turn-1",
    speaker_name: "Alice",
    message: "What did we decide?",
    is_final: true
  }), true);
  await session.queue;
  assert.equal(calls.find((call) => call.url.endsWith("/chat/completions"))?.headers.get("authorization"), "Bearer openclaw-secret");
  assert.deepEqual(JSON.parse(sent[0]!), {
    command: "sendmsg",
    bot_id: "bot-123",
    message: "OpenClaw says hello.",
    msg: "OpenClaw says hello."
  });
  assert.equal(bridge.accept(session, { command: "usermsg", event_id: "turn-1", message: "duplicate" }), false);
});

test("falls back to OpenClaw Chat Completions when Responses is unavailable", async () => {
  const calls: Call[] = [];
  const baseFetch = fakeFetch(calls);
  const request: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === "https://openclaw.test/v1/responses") {
      calls.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers) });
      return Response.json({ error: "not found" }, { status: 404 });
    }
    if (url === "https://openclaw.test/v1/chat/completions") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body });
      return Response.json({ choices: [{ message: { role: "assistant", content: "Fallback works." } }] });
    }
    return baseFetch(input, init);
  };
  const sent: string[] = [];
  const bridge = new Bridge(() => "https://bridge.ngrok.app", request);
  const session = await bridge.create(createSessionSchema.parse({
    ...baseInput,
    openclaw: { ...baseInput.openclaw, mode: "auto" }
  }));
  bridge.bind(session.token, "bot-123", { readyState: 1, send: (message) => sent.push(message) });
  bridge.accept(session, { command: "usermsg", event_id: "fallback-turn", message: "Hello" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls.filter((call) => call.url.startsWith("https://openclaw.test")).map((call) => call.url), [
    "https://openclaw.test/v1/responses",
    "https://openclaw.test/v1/chat/completions"
  ]);
  assert.equal(JSON.parse(sent[0]!).message, "Fallback works.");
});

test("routes finalized MeetStream transcription webhooks to OpenClaw", async () => {
  const calls: Call[] = [];
  const sent: string[] = [];
  const bridge = new Bridge(() => "https://bridge.ngrok.app", fakeFetch(calls));
  const session = await bridge.create(createSessionSchema.parse(baseInput));
  bridge.bind(session.token, "bot-123", { readyState: 1, send: (message) => sent.push(message) });
  assert.equal(bridge.transcription({ bot_id: "bot-123", transcript: "partial", end_of_turn: false }), false);
  assert.equal(bridge.transcription({
    bot_id: "bot-123",
    speakerName: "Alice",
    transcript: "What did we decide?",
    timestamp: "2026-08-12T00:00:00Z",
    end_of_turn: true
  }), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(JSON.parse(sent[0]!).message, "OpenClaw says hello.");
  assert.equal(session.finalizedTurns, 1);
  assert.equal(session.openclawResponses, 1);
});

test("queues wake-word follow-ups instead of cancelling the earlier turn", async () => {
  const calls: Call[] = [];
  const sent: string[] = [];
  const bridge = new Bridge(() => "https://bridge.ngrok.app", fakeFetch(calls));
  const session = await bridge.create(createSessionSchema.parse({
    ...baseInput,
    wake_words: ["hey assistant"]
  }));
  bridge.bind(session.token, "bot-123", { readyState: 1, send: (message) => sent.push(message) });
  assert.equal(bridge.transcription({
    bot_id: "bot-123", id: "first", transcript: "Hey assistant, what is two times two?", end_of_turn: true
  }), true);
  assert.equal(bridge.transcription({
    bot_id: "bot-123", id: "second", transcript: "Hey assistant, and what is four times two?", end_of_turn: true
  }), true);
  await session.queue;
  assert.deepEqual(calls.filter((call) => call.url.endsWith("/chat/completions")).map((call) =>
    (call.body?.messages as Array<{ content: string }>).at(-1)?.content), [
      "[Participant] what is two times two?",
      "[Participant] and what is four times two?"
    ]);
  assert.equal(sent.length, 2);
  assert.equal(session.openclawResponses, 2);
});

test("supports hybrid chat and PCM voice output", async () => {
  const calls: Call[] = [];
  const sent: string[] = [];
  const bridge = new Bridge(() => "https://bridge.ngrok.app", fakeFetch(calls));
  const session = await bridge.create(createSessionSchema.parse({
    ...baseInput,
    output: "hybrid",
    speech: { base_url: "https://speech.test/v1", api_key: "speech-secret" }
  }));
  bridge.bind(session.token, "bot-123", { readyState: 1, send: (message) => sent.push(message) });
  bridge.accept(session, { command: "usermsg", event_id: "turn-1", message: "Speak" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(sent.map((message) => JSON.parse(message).command), ["sendmsg", "sendaudio"]);
  assert.equal(calls.find((call) => call.url.endsWith("/audio/speech"))?.headers.get("authorization"), "Bearer speech-secret");
});

test("management API and control WebSocket work end to end", async () => {
  const calls: Call[] = [];
  const runtime = { publicUrl: "https://bridge.ngrok.app" };
  const bridge = new Bridge(() => runtime.publicUrl, fakeFetch(calls));
  const app = await buildApp({ port: 3000, host: "127.0.0.1", apiKey: "manage-secret" }, runtime, bridge);
  apps.push(app);
  assert.equal((await app.inject({ method: "POST", url: "/v1/meeting-sessions", payload: baseInput })).statusCode, 401);
  const created = await app.inject({
    method: "POST",
    url: "/v1/meeting-sessions",
    headers: { "x-integration-key": "manage-secret" },
    payload: baseInput
  });
  assert.equal(created.statusCode, 201);
  const session = [...bridge.sessions.values()][0]!;
  const socket = await app.injectWS(`/ws/meetstream/control/${session.token}`);
  socket.send(JSON.stringify({ type: "ready", bot_id: "bot-123" }));
  assert.deepEqual(JSON.parse((await new Promise<Buffer>((resolve) => socket.once("message", resolve))).toString()), {
    command: "ack",
    bot_id: "bot-123",
    message: "control channel bound"
  });
  socket.send(JSON.stringify({ command: "usermsg", event_id: "ws-turn", message: "Hello" }));
  assert.equal(JSON.parse((await new Promise<Buffer>((resolve) => socket.once("message", resolve))).toString()).message, "OpenClaw says hello.");
  socket.terminate();

  const prefixed = await app.injectWS(`/bot-123/ws/meetstream/control/${session.token}`);
  prefixed.send(JSON.stringify({ type: "ready", bot_id: "bot-123" }));
  assert.equal(JSON.parse((await new Promise<Buffer>((resolve) => prefixed.once("message", resolve))).toString()).command, "ack");
  prefixed.terminate();
});

test("plugin routes keep upstream credentials server-side and list MIA configurations", async () => {
  const calls: Call[] = [];
  const runtime = { publicUrl: "https://bridge.ngrok.app" };
  const request = fakeFetch(calls);
  const bridge = new Bridge(() => runtime.publicUrl, request);
  let loadedUrl = "";
  const app = await buildApp({
    port: 3000,
    host: "127.0.0.1",
    apiKey: "manage-secret",
    meetstreamBaseUrl: "https://meetstream.test",
    meetstreamApiKey: "meetstream-secret"
  }, runtime, bridge, {
    request,
    loadConfig: async (meetingUrl) => {
      loadedUrl = meetingUrl;
      return { env: {}, warnings: [], input: createSessionSchema.parse({ ...baseInput, meeting_url: meetingUrl }) };
    }
  });
  apps.push(app);

  const configurations = await app.inject({
    method: "GET",
    url: "/v1/mia-configurations",
    headers: { "x-integration-key": "manage-secret" }
  });
  assert.equal(configurations.statusCode, 200);
  assert.deepEqual(configurations.json(), { agent_configs: [], count: 0 });
  assert.equal(calls[0]?.headers.get("authorization"), "Token meetstream-secret");

  const created = await app.inject({
    method: "POST",
    url: "/v1/meeting-sessions/from-env",
    headers: { "x-integration-key": "manage-secret" },
    payload: { meeting_url: "https://meet.google.com/plugin-test" }
  });
  assert.equal(created.statusCode, 201);
  assert.equal(loadedUrl, "https://meet.google.com/plugin-test");
  assert.equal(created.json().state, "joining");
});

test("verifies lifecycle webhook signatures", async () => {
  const runtime = { publicUrl: "https://bridge.ngrok.app" };
  const bridge = new Bridge(() => runtime.publicUrl, fakeFetch([]));
  const session = await bridge.create(createSessionSchema.parse(baseInput));
  const app = await buildApp({ port: 3000, host: "127.0.0.1", webhookSecret: "hook-secret" }, runtime, bridge);
  apps.push(app);
  const body = JSON.stringify({ bot_event: "bot.inmeeting", bot_id: "bot-123" });
  const signature = createHmac("sha256", "hook-secret").update(body).digest("hex");
  assert.equal((await app.inject({ method: "POST", url: "/webhooks/meetstream", payload: body,
    headers: { "content-type": "application/json", "x-meetstream-signature": `sha256=${signature}` }
  })).statusCode, 202);
  assert.equal(session.state, "in_meeting");
});
