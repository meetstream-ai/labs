const http = require("node:http");

function startWebhookServer({ port, onEvent }) {
  const server = http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      return sendJson(response, 200, { status: "ok" });
    }

    if (request.method === "POST" && request.url === "/webhooks/meetstream") {
      const payload = await readJson(request);
      sendJson(response, 200, { received: true });
      logEvent(payload);
      onEvent?.(payload);
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  });

  server.listen(port, () => {
    console.log(`Webhook server listening on http://localhost:${port}`);
    console.log("  POST /webhooks/meetstream");
    console.log("  GET  /health\n");
  });

  return server;
}

function logEvent(payload) {
  const mode = payload.custom_attributes?.mode || payload.customAttributes?.mode || "unknown";
  const event = payload.event || payload.type || "unknown";
  const botId = payload.bot_id || payload.botId || "?";
  const status = payload.bot_status || payload.status || "";
  const message = payload.message ? ` - ${payload.message}` : "";

  console.log(`[${new Date().toISOString()}] [${mode}] [${botId}] ${event}${status ? ` (${status})` : ""}${message}`);
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

module.exports = { startWebhookServer };
