import { createHash, randomUUID } from "node:crypto";
import { defaultMia, platformFor, type CreateSessionInput } from "./schema.js";

export type Fetch = typeof fetch;
type Socket = { readyState: number; send(data: string): void };

export class BridgeError extends Error {
  constructor(
    message: string,
    readonly code = "bridge_error",
    readonly statusCode = 500,
    readonly details?: unknown
  ) {
    super(message);
  }
}

export type SessionState = "creating" | "joining" | "waiting_room" | "in_meeting" |
  "leaving" | "stopped" | "failed";

export type Session = {
  id: string;
  token: string;
  botId?: string;
  miaConfigId: string;
  request: CreateSessionInput;
  state: SessionState;
  lifecycleEvent?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  control?: Socket;
  controlConnected: boolean;
  audioConnected: boolean;
  controlEvents: number;
  finalizedTurns: number;
  hermesResponses: number;
  lastControlEvent?: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  seen: Set<string>;
  seenOrder: string[];
  turn: number;
  queue: Promise<void>;
  abort?: AbortController;
};

function trimSlash(value: string): string {
  return value.replace(/\/$/, "");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Returns the participant request only when a configured wake phrase starts the turn. */
export function withoutWakeWord(text: string, wakeWords: string[]): string | undefined {
  if (wakeWords.length === 0) return text.trim() || undefined;
  // Google Meet captions commonly insert punctuation between words ("Hey, assistant").
  // Treat ordinary separators like whitespace while preserving phrase boundaries.
  const phrases = wakeWords.map((phrase) => phrase.trim().split(/\s+/)
    .map(escapeRegex).join("[\\s,.-]+")).join("|");
  // Captions can combine several sentences into one finalized turn. A wake phrase
  // starts a new request only at the start of a sentence; the latest complete
  // request wins so retries do not make Hermes answer an older question.
  const matcher = new RegExp(
    `(?:^|[.!?]\\s+)\\s*(?:${phrases})(?=\\s|[,:;.!?]|$)\\s*[,.:;!?-]*\\s*`,
    "ig"
  );
  let request: string | undefined;
  for (let match = matcher.exec(text); match; match = matcher.exec(text)) {
    const candidate = text.slice(match.index + match[0].length).trim();
    if (candidate) request = candidate;
  }
  return request;
}

async function json(response: Response, service: string): Promise<Record<string, unknown>> {
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new BridgeError(
      `${service} returned HTTP ${response.status}`,
      `${service.toLowerCase()}_error`,
      response.status === 401 || response.status === 403 ? 401 : 502,
      payload
    );
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new BridgeError(`${service} returned invalid JSON`, `${service.toLowerCase()}_error`, 502);
  }
  return payload as Record<string, unknown>;
}

export class Bridge {
  readonly sessions = new Map<string, Session>();
  private readonly byToken = new Map<string, Session>();
  private readonly byBot = new Map<string, Session>();

  constructor(
    private readonly getPublicUrl: () => string,
    private readonly request: Fetch = fetch
  ) {}

  view(session: Session) {
    return {
      id: session.id,
      bot_id: session.botId ?? null,
      meeting_url: session.request.meeting_url,
      platform: platformFor(session.request.meeting_url),
      mia_config_id: session.miaConfigId,
      output: session.request.output,
      state: session.state,
      lifecycle_event: session.lifecycleEvent ?? null,
      created_at: session.createdAt,
      updated_at: session.updatedAt,
      last_error: session.lastError ?? null,
      transport: {
        control_connected: session.controlConnected,
        audio_connected: session.audioConnected,
        control_events: session.controlEvents,
        finalized_turns: session.finalizedTurns,
        hermes_responses: session.hermesResponses,
        last_control_event: session.lastControlEvent ?? null
      }
    };
  }

  private meetstream(session: Session, path: string, init: RequestInit = {}) {
    return this.request(`${trimSlash(session.request.meetstream.base_url)}${path}`, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Token ${session.request.meetstream.api_key}`,
        "Content-Type": "application/json",
        ...init.headers
      }
    });
  }

  private async resolveMia(input: CreateSessionInput): Promise<string> {
    const config = input.meetstream;
    const call = (path: string, init: RequestInit = {}) => this.request(
      `${trimSlash(config.base_url)}${path}`,
      {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(30_000),
        headers: {
          Authorization: `Token ${config.api_key}`,
          "Content-Type": "application/json"
        }
      }
    );
    if (config.mia.agent_config_id) {
      await json(await call(`/api/v1/mia?agent_config_id=${encodeURIComponent(config.mia.agent_config_id)}`), "MeetStream");
      return config.mia.agent_config_id;
    }
    const desired = config.mia.create ?? defaultMia;
    if (config.mia.reuse_by_name) {
      const listed = await json(await call("/api/v1/mia"), "MeetStream");
      const configs = Array.isArray(listed.agent_configs) ? listed.agent_configs : [];
      const existing = configs.find((candidate) =>
        candidate && typeof candidate === "object" &&
        (candidate as Record<string, unknown>).AgentName === desired.agent_name
      ) as Record<string, unknown> | undefined;
      if (typeof existing?.AgentConfigID === "string") return existing.AgentConfigID;
    }
    const created = await json(await call("/api/v1/mia", {
      method: "POST",
      body: JSON.stringify(desired)
    }), "MeetStream");
    const nested = created.agent_config as Record<string, unknown> | undefined;
    const id = created.agent_config_id ?? nested?.AgentConfigID;
    if (typeof id !== "string") throw new BridgeError("MIA response omitted agent_config_id", "meetstream_error", 502);
    return id;
  }

  async create(input: CreateSessionInput): Promise<Session> {
    const publicUrl = trimSlash(this.getPublicUrl());
    if (!publicUrl) throw new BridgeError("Public bridge URL is not ready", "bridge_not_ready", 503);
    const id = randomUUID();
    const token = randomUUID();
    const now = new Date().toISOString();
    const session: Session = {
      id,
      token,
      miaConfigId: await this.resolveMia(input),
      request: input,
      state: "creating",
      createdAt: now,
      updatedAt: now,
      history: [],
      seen: new Set(),
      seenOrder: [],
      turn: 0,
      queue: Promise.resolve(),
      controlConnected: false,
      audioConnected: false,
      controlEvents: 0,
      finalizedTurns: 0,
      hermesResponses: 0
    };
    this.sessions.set(id, session);
    this.byToken.set(token, session);
    try {
      const wsUrl = publicUrl.replace(/^http/, "ws");
      const payload = await json(await this.meetstream(session, "/api/v1/bots/create_bot", {
        method: "POST",
        body: JSON.stringify({
          meeting_link: input.meeting_url,
          bot_name: input.meetstream.bot_name,
          video_required: input.meetstream.video_required,
          agent_config_id: session.miaConfigId,
          bot_message: input.meetstream.bot_message,
          socket_connection_url: { websocket_url: `${wsUrl}/ws/meetstream/control/${token}` },
          live_audio_required: { websocket_url: `${wsUrl}/ws/meetstream/audio/${token}` },
          live_transcription_required: { webhook_url: `${publicUrl}/webhooks/meetstream/transcription` },
          callback_url: `${publicUrl}/webhooks/meetstream`,
          deduplication_key: `mia-hermes-${id}`,
          custom_attributes: { integration: "mia-hermes-bridge", integration_session_id: id },
          automatic_leave: input.meetstream.automatic_leave,
          recording_config: {
            transcript: {
              provider: {
                deepgram_streaming: {
                  transcription_mode: "sentence",
                  model: "nova-2",
                  language: "en",
                  punctuate: true,
                  smart_format: true,
                  endpointing: 300,
                  vad_events: true,
                  utterance_end_ms: 1000,
                  encoding: "linear16",
                  channels: 1
                }
              }
            }
          }
        })
      }), "MeetStream");
      const botId = payload.bot_id ?? payload.BotID ?? payload.id;
      if (typeof botId !== "string") throw new BridgeError("Bot response omitted bot_id", "meetstream_error", 502);
      this.bindBot(session, botId);
      session.state = "joining";
      session.updatedAt = new Date().toISOString();
      return session;
    } catch (error) {
      this.sessions.delete(id);
      this.byToken.delete(token);
      throw error;
    }
  }

  bind(token: string, botId: string, control?: Socket): Session {
    const session = this.byToken.get(token);
    if (!session) throw new BridgeError("Unknown bridge token", "invalid_bridge_token", 404);
    this.bindBot(session, botId);
    if (control) {
      session.control = control;
      session.controlConnected = true;
    }
    return session;
  }

  bindAudio(token: string, botId: string): Session {
    const session = this.bind(token, botId);
    session.audioConnected = true;
    return session;
  }

  private bindBot(session: Session, botId: string): void {
    const existing = this.byBot.get(botId);
    if (existing && existing !== session) throw new BridgeError("bot_id already bound", "invalid_bot_id", 409);
    if (session.botId && session.botId !== botId) throw new BridgeError("Session already bound", "invalid_bot_id", 409);
    session.botId = botId;
    this.byBot.set(botId, session);
  }

  unbindControl(session: Session, socket: Socket): void {
    if (session.control === socket) {
      session.control = undefined;
      session.controlConnected = false;
    }
  }

  unbindAudio(session: Session): void {
    session.audioConnected = false;
  }

  async stop(session: Session): Promise<void> {
    session.abort?.abort();
    if (session.botId) await json(await this.meetstream(session, `/api/v1/bots/${session.botId}/remove_bot`), "MeetStream");
    session.state = "leaving";
    session.updatedAt = new Date().toISOString();
  }

  accept(session: Session, payload: Record<string, unknown>): boolean {
    const command = payload.command ?? payload.type;
    session.controlEvents++;
    session.lastControlEvent = String(command ?? "unknown");
    session.updatedAt = new Date().toISOString();
    if (command === "interrupt") {
      session.abort?.abort();
      this.send(session, { command: "interrupt", bot_id: session.botId, action: "clear_audio_queue" });
      return true;
    }
    if (!["usermsg", "transcript", "transcription.final"].includes(String(command))) return false;
    if (payload.is_final === false || payload.final === false) return false;
    const text = String(payload.message ?? payload.text ?? "").trim();
    if (!text) return false;
    const activatedText = withoutWakeWord(text, session.request.wake_words);
    if (!activatedText) return false;
    const key = String(payload.event_id ?? payload.id ?? createHash("sha256")
      .update([session.botId, payload.speaker_id, payload.speaker_name, activatedText, payload.timestamp].join("\u001f"))
      .digest("hex"));
    if (session.seen.has(key)) return false;
    session.seen.add(key);
    session.seenOrder.push(key);
    if (session.seenOrder.length > 512) session.seen.delete(session.seenOrder.shift()!);
    session.finalizedTurns++;
    const turn = ++session.turn;
    const speaker = String(payload.speaker_name ?? payload.speaker_id ?? "Participant");
    // Hermes can take longer than the pause between two spoken questions. Queue
    // finalized wake-word turns so a follow-up never cancels an answer in flight.
    session.queue = session.queue.catch(() => undefined).then(async () => {
      if (["leaving", "stopped", "failed"].includes(session.state)) return;
      const abort = new AbortController();
      session.abort = abort;
      try {
        await this.runTurn(session, activatedText, speaker, turn, abort);
      } finally {
        if (session.abort === abort) session.abort = undefined;
      }
    });
    return true;
  }

  private async runTurn(session: Session, text: string, speaker: string, turn: number, abort: AbortController): Promise<void> {
    try {
      const signal = AbortSignal.any([
        abort.signal,
        AbortSignal.timeout(session.request.hermes.timeout_seconds * 1000)
      ]);
      const answer = await this.askHermes(session, `[${speaker}] ${text}`, signal);
      if (abort.signal.aborted) return;
      session.history.push({ role: "user", content: `[${speaker}] ${text}` }, { role: "assistant", content: answer });
      session.hermesResponses++;
      session.history = session.history.slice(-40);
      if (session.request.output !== "voice") await this.publishChat(session, answer);
      if (session.request.output !== "chat") await this.publishVoice(session, answer, signal);
      session.lastError = undefined;
    } catch (error) {
      if (abort.signal.aborted) return;
      session.lastError = error instanceof Error ? error.message : String(error);
      await this.publishChat(session, "I couldn't complete that request. Please try again.");
    } finally {
      session.updatedAt = new Date().toISOString();
    }
  }

  private async askHermes(session: Session, input: string, signal: AbortSignal): Promise<string> {
    const config = session.request.hermes;
    const call = (path: string, body: unknown) => this.request(`${trimSlash(config.base_url)}${path}`, {
      method: "POST",
      signal,
      headers: { Authorization: `Bearer ${config.api_key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (config.mode !== "chat_completions") {
      const response = await call("/responses", {
        model: config.model,
        input,
        instructions: config.instructions,
        conversation: `meetstream:${session.botId ?? session.id}`,
        store: true
      });
      if (![404, 405].includes(response.status) || config.mode === "responses") {
        const payload = await json(response, "Hermes");
        const direct = typeof payload.output_text === "string" ? payload.output_text : undefined;
        const output = Array.isArray(payload.output) ? payload.output : [];
        const parts = output.flatMap((item) => {
          if (!item || typeof item !== "object" || (item as Record<string, unknown>).type !== "message") return [];
          const content = (item as Record<string, unknown>).content;
          if (!Array.isArray(content)) return [];
          return content.flatMap((part) => part && typeof part === "object" &&
            ["output_text", "text"].includes(String((part as Record<string, unknown>).type)) &&
            typeof (part as Record<string, unknown>).text === "string"
            ? [(part as Record<string, string>).text] : []);
        });
        const answer = (direct ?? parts.join("")).trim();
        if (!answer) throw new BridgeError("Hermes returned no assistant text", "hermes_error", 502);
        return answer;
      }
    }
    const payload = await json(await call("/chat/completions", {
      model: config.model,
      messages: [{ role: "system", content: config.instructions }, ...session.history, { role: "user", content: input }],
      stream: false
    }), "Hermes");
    const choices = payload.choices;
    const answer = Array.isArray(choices) && choices[0] && typeof choices[0] === "object"
      ? (choices[0] as { message?: { content?: unknown } }).message?.content : undefined;
    if (typeof answer !== "string" || !answer.trim()) throw new BridgeError("Hermes returned no assistant text", "hermes_error", 502);
    return answer.trim();
  }

  private send(session: Session, payload: unknown): boolean {
    if (!session.control || session.control.readyState !== 1) return false;
    session.control.send(JSON.stringify(payload));
    return true;
  }

  private async publishChat(session: Session, text: string): Promise<void> {
    if (!session.botId) throw new BridgeError("Bot is not ready");
    if (this.send(session, { command: "sendmsg", bot_id: session.botId, message: text, msg: text })) return;
    await json(await this.meetstream(session, `/api/v1/bots/${session.botId}/send_message`, {
      method: "POST",
      body: JSON.stringify({ message: text, metadata: { message_type: "public" } })
    }), "MeetStream");
  }

  private async publishVoice(session: Session, text: string, signal: AbortSignal): Promise<void> {
    const config = session.request.speech;
    if (!config || !session.botId) throw new BridgeError("Voice output is not configured");
    const response = await this.request(`${trimSlash(config.base_url)}/audio/speech`, {
      method: "POST",
      signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeout_seconds * 1000)]),
      headers: { Authorization: `Bearer ${config.api_key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.model, voice: config.voice, input: text, response_format: "pcm" })
    });
    if (!response.ok) throw new BridgeError(`Speech returned HTTP ${response.status}`, "speech_error", 502);
    const pcm = Buffer.from(await response.arrayBuffer());
    const size = config.sample_rate * 2;
    for (let offset = 0; offset < pcm.length; offset += size) {
      if (!this.send(session, {
        command: "sendaudio",
        bot_id: session.botId,
        audiochunk: pcm.subarray(offset, offset + size).toString("base64"),
        sample_rate: config.sample_rate,
        encoding: "pcm16",
        channels: 1,
        endianness: "little"
      })) throw new BridgeError("Control WebSocket unavailable", "meetstream_error", 502);
    }
  }

  lifecycle(event: Record<string, unknown>): Session | undefined {
    const botId = String(event.bot_id ?? "");
    let session = this.byBot.get(botId);
    const attributes = event.custom_attributes;
    if (!session && attributes && typeof attributes === "object") {
      session = this.sessions.get(String((attributes as Record<string, unknown>).integration_session_id ?? ""));
      if (session) this.bindBot(session, botId);
    }
    if (!session) return;
    const name = String(event.bot_event ?? "");
    session.lifecycleEvent = name;
    if (name === "bot.inmeeting") session.state = "in_meeting";
    else if (name === "bot.in_waiting_room") session.state = "waiting_room";
    else if (name === "bot.leaving") session.state = "leaving";
    else if (["bot.stopped", "bot.kicked"].includes(name)) session.state = "stopped";
    else if (["bot.failed", "bot.denied", "bot.notallowed"].includes(name)) session.state = "failed";
    else if (["bot.joining", "bot.scheduled"].includes(name)) session.state = "joining";
    if (session.state === "stopped" || session.state === "failed") session.abort?.abort();
    if (Number(event.status_code) >= 400) session.lastError = String(event.message ?? "MeetStream error");
    session.updatedAt = new Date().toISOString();
    return session;
  }

  transcription(event: Record<string, unknown>): boolean {
    const session = this.byBot.get(String(event.bot_id ?? ""));
    if (!session || event.end_of_turn !== true) return false;
    return this.accept(session, {
      command: "usermsg",
      event_id: event.id,
      speaker_name: event.speakerName ?? event.speaker,
      message: event.utterance || event.transcript || event.new_text,
      timestamp: event.timestamp,
      is_final: true
    });
  }
}
