/**
 * Slack delivery - incoming webhook or bot token.
 *
 *   SLACK_WEBHOOK_URL   https://hooks.slack.com/services/...
 *                       Simplest option. One fixed channel, no thread replies.
 *
 *   SLACK_BOT_TOKEN     xoxb-... plus SLACK_CHANNEL (#name or channel ID)
 *                       Needs the `chat:write` scope. Returns a message `ts`
 *                       so we can post the transcript as a thread reply.
 *
 * If both are set, the bot token wins because it can thread.
 */

const CHAT_POST_MESSAGE = "https://slack.com/api/chat.postMessage";

export function resolveSlackMode() {
  if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_CHANNEL) return "bot";
  if (process.env.SLACK_WEBHOOK_URL) return "webhook";
  return null;
}

/** Fail fast before we create a bot. */
export function assertSlackConfig() {
  const mode = resolveSlackMode();
  if (!mode) {
    throw new Error(
      "Slack is not configured. Set SLACK_WEBHOOK_URL, or SLACK_BOT_TOKEN together with SLACK_CHANNEL."
    );
  }
  if (process.env.SLACK_BOT_TOKEN && !process.env.SLACK_CHANNEL) {
    throw new Error("SLACK_BOT_TOKEN is set but SLACK_CHANNEL is missing.");
  }
  return mode;
}

/**
 * Post a message.
 * @param {object} message
 * @param {string} message.text     Fallback text (notifications, screen readers)
 * @param {Array}  message.blocks   Block Kit blocks
 * @param {string} [message.threadTs] Reply into this thread (bot token only)
 * @returns {Promise<{ ts: string|null, channel: string|null, mode: string }>}
 */
export async function postToSlack({ text, blocks, threadTs }) {
  const mode = resolveSlackMode();
  if (mode === "bot") return postWithBotToken({ text, blocks, threadTs });
  if (mode === "webhook") return postWithWebhook({ text, blocks });
  throw new Error("Slack is not configured.");
}

async function postWithBotToken({ text, blocks, threadTs }) {
  const res = await fetch(CHAT_POST_MESSAGE, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel: process.env.SLACK_CHANNEL,
      text,
      blocks,
      thread_ts: threadTs || undefined,
      unfurl_links: false,
    }),
  });

  const data = await res.json().catch(() => null);

  // Slack answers 200 even for logical failures - `ok` is the real signal.
  if (!res.ok || !data?.ok) {
    const reason = data?.error || res.statusText;
    throw new Error(
      `Slack chat.postMessage failed: ${reason}` +
        (reason === "not_in_channel"
          ? " (invite the bot to the channel first: /invite @your-bot)"
          : reason === "missing_scope"
            ? " (the bot token needs the chat:write scope)"
            : "")
    );
  }

  return { ts: data.ts ?? null, channel: data.channel ?? null, mode: "bot" };
}

async function postWithWebhook({ text, blocks }) {
  const res = await fetch(process.env.SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, blocks }),
  });

  const body = await res.text().catch(() => "");
  if (!res.ok || body.trim() !== "ok") {
    throw new Error(`Slack incoming webhook failed (${res.status}): ${body || res.statusText}`);
  }
  return { ts: null, channel: null, mode: "webhook" };
}
