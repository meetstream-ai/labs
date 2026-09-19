import { createHmac, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import websocket from "@fastify/websocket";
import type { Listener as NgrokListener } from "@ngrok/ngrok";
import type { RawData, WebSocket } from "ws";
import { Bridge, BridgeError } from "./bridge.js";
import { createSessionSchema } from "./schema.js";

declare module "fastify" {
  interface FastifyRequest { rawBody?: Buffer }
}

export type Settings = {
  port: number;
  host: string;
  publicBaseUrl?: string;
  apiKey?: string;
  webhookSecret?: string;
};

export function settingsFromEnv(): Settings {
  return {
    port: Number(process.env.PORT ?? 3000),
    host: process.env.HOST ?? "127.0.0.1",
    publicBaseUrl: process.env.PUBLIC_BASE_URL,
    apiKey: process.env.BRIDGE_API_KEY ?? process.env.MIA_HERMES_API_KEY,
    webhookSecret: process.env.MIA_HERMES_WEBHOOK_SECRET
  };
}

export type RunningBridgeServer = {
  app: FastifyInstance;
  bridge: Bridge;
  publicUrl: string;
  stop(): Promise<void>;
};

function sameSecret(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function buildApp(
  settings: Settings,
  runtime: { publicUrl: string },
  bridge = new Bridge(() => runtime.publicUrl)
): Promise<FastifyInstance> {
  // The CLI provides concise lifecycle status. Set LOG_LEVEL=info when raw HTTP
  // request logs are useful for debugging a webhook or transport issue.
  const app = Fastify({ logger: process.env.LOG_LEVEL ? { level: process.env.LOG_LEVEL } : false });
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (request, body, done) => {
    request.rawBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
    try { done(null, JSON.parse(request.rawBody.toString())); }
    catch (error) { done(error as Error); }
  });
  await app.register(websocket);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof BridgeError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details }
      });
    }
    if ((error as { validation?: unknown }).validation) {
      return reply.code(422).send({
        error: { code: "validation_error", message: error instanceof Error ? error.message : "Invalid request" }
      });
    }
    app.log.error(error);
    return reply.code(500).send({ error: { code: "internal_error", message: "Internal error" } });
  });

  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/v1/") || !settings.apiKey) return;
    if (!sameSecret(String(request.headers["x-integration-key"] ?? ""), settings.apiKey)) {
      return reply.code(401).send({ error: { code: "unauthorized", message: "Invalid API key" } });
    }
  });

  app.get("/health", async () => ({ status: "ok", public_url: runtime.publicUrl || null }));

  app.post("/v1/meeting-sessions", async (request, reply) => {
    const parsed = createSessionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(422).send({
        error: { code: "validation_error", message: parsed.error.issues[0]?.message ?? "Invalid request" }
      });
    }
    const session = await bridge.create(parsed.data);
    return reply.code(201).send(bridge.view(session));
  });

  app.get("/v1/meeting-sessions", async () =>
    [...bridge.sessions.values()].map((session) => bridge.view(session))
  );

  app.get<{ Params: { id: string } }>("/v1/meeting-sessions/:id", async (request, reply) => {
    const session = bridge.sessions.get(request.params.id);
    return session ? bridge.view(session) : reply.code(404).send({ error: { message: "Meeting session not found" } });
  });

  app.post<{ Params: { id: string } }>("/v1/meeting-sessions/:id/stop", async (request, reply) => {
    const session = bridge.sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: { message: "Meeting session not found" } });
    await bridge.stop(session);
    return bridge.view(session);
  });

  app.post("/webhooks/meetstream", async (request, reply) => {
    if (settings.webhookSecret) {
      const expected = createHmac("sha256", settings.webhookSecret).update(request.rawBody ?? "").digest("hex");
      const supplied = String(request.headers["x-meetstream-signature"] ?? "").replace(/^sha256=/, "");
      if (!sameSecret(supplied, expected)) return reply.code(401).send({ error: "Invalid webhook signature" });
    }
    if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
      return reply.code(422).send({ error: "Invalid lifecycle event" });
    }
    bridge.lifecycle(request.body as Record<string, unknown>);
    return reply.code(202).send({ accepted: true });
  });

  app.post("/webhooks/meetstream/transcription", async (request, reply) => {
    if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
      return reply.code(422).send({ error: "Invalid transcription event" });
    }
    return reply.code(202).send({ accepted: bridge.transcription(request.body as Record<string, unknown>) });
  });

  type WsParams = { token: string; botId?: string };
  const controlEndpoint = (socket: WebSocket, request: FastifyRequest<{ Params: WsParams }>) => {
    let session: ReturnType<Bridge["bind"]> | undefined;
    socket.once("message", (raw: RawData) => {
      try {
        const hello = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (hello.type !== "ready" || typeof hello.bot_id !== "string") return socket.close(1003);
        if (request.params.botId && request.params.botId !== hello.bot_id) return socket.close(1008);
        session = bridge.bind(request.params.token, hello.bot_id, socket);
        socket.send(JSON.stringify({ command: "ack", bot_id: hello.bot_id, message: "control channel bound" }));
        socket.on("message", (message: RawData) => {
          try {
            bridge.accept(session!, JSON.parse(message.toString()) as Record<string, unknown>);
          } catch {
            socket.close(1003);
          }
        });
      } catch (error) {
        socket.close(error instanceof BridgeError ? 1008 : 1003);
      }
    });
    socket.on("close", () => { if (session) bridge.unbindControl(session, socket); });
  };
  app.get<{ Params: WsParams }>("/ws/meetstream/control/:token", { websocket: true }, controlEndpoint);
  app.get<{ Params: WsParams }>("/:botId/ws/meetstream/control/:token", { websocket: true }, controlEndpoint);

  const audioEndpoint = (socket: WebSocket, request: FastifyRequest<{ Params: WsParams }>) => {
    let session: ReturnType<Bridge["bindAudio"]> | undefined;
    socket.once("message", (raw: RawData) => {
      try {
        const hello = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (hello.type !== "ready" || typeof hello.bot_id !== "string") return socket.close(1003);
        if (request.params.botId && request.params.botId !== hello.bot_id) return socket.close(1008);
        session = bridge.bindAudio(request.params.token, hello.bot_id);
        socket.send(JSON.stringify({ command: "ack", bot_id: hello.bot_id, message: "audio channel bound" }));
      } catch (error) {
        socket.close(error instanceof BridgeError ? 1008 : 1003);
      }
    });
    socket.on("close", () => { if (session) bridge.unbindAudio(session); });
  };
  app.get<{ Params: WsParams }>("/ws/meetstream/audio/:token", { websocket: true }, audioEndpoint);
  app.get<{ Params: WsParams }>("/:botId/ws/meetstream/audio/:token", { websocket: true }, audioEndpoint);

  return app;
}

export async function startBridgeServer(settings = settingsFromEnv()): Promise<RunningBridgeServer> {
  const runtime = { publicUrl: settings.publicBaseUrl?.replace(/\/$/, "") ?? "" };
  const bridge = new Bridge(() => runtime.publicUrl);
  const app = await buildApp(settings, runtime, bridge);
  let tunnel: NgrokListener | undefined;
  try {
    await app.listen({ host: settings.host, port: settings.port });
    if (!runtime.publicUrl) {
      const ngrok = (await import("@ngrok/ngrok")).default;
      tunnel = await ngrok.forward({
        addr: settings.port,
        authtoken_from_env: true,
        domain: process.env.NGROK_DOMAIN || undefined
      });
      runtime.publicUrl = tunnel.url()!.replace(/\/$/, "");
    }
  } catch (error) {
    await tunnel?.close();
    await app.close();
    throw error;
  }
  app.log.info({ publicUrl: runtime.publicUrl }, "MeetStream bridge is public");

  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      // Shutdown is deliberately best-effort: a tunnel that has already closed must not
      // prevent removal requests for bots or keep the local process alive.
      await Promise.allSettled([
        ...[...bridge.sessions.values()].map((session) => bridge.stop(session)),
        ...(tunnel ? [tunnel.close()] : []),
        app.close()
      ]);
    })();
    return stopPromise;
  };
  return { app, bridge, publicUrl: runtime.publicUrl, stop };
}

async function main(): Promise<void> {
  try { process.loadEnvFile(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const running = await startBridgeServer();
  process.once("SIGINT", () => void running.stop());
  process.once("SIGTERM", () => void running.stop());
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  await main();
}
