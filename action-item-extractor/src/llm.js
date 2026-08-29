/**
 * Pluggable LLM client - OpenAI or Anthropic, chosen from env.
 *
 *   LLM_PROVIDER=openai     + OPENAI_API_KEY     (+ optional OPENAI_MODEL)
 *   LLM_PROVIDER=anthropic  + ANTHROPIC_API_KEY  (+ optional ANTHROPIC_MODEL)
 *
 * If LLM_PROVIDER is unset we pick whichever key is present. Real HTTP calls,
 * built-in fetch, no SDK.
 */

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/** Which provider will be used, or null if no key is configured. */
export function resolveProvider() {
  const explicit = (process.env.LLM_PROVIDER || "").trim().toLowerCase();
  if (explicit === "openai") return process.env.OPENAI_API_KEY ? "openai" : null;
  if (explicit === "anthropic") return process.env.ANTHROPIC_API_KEY ? "anthropic" : null;
  if (explicit) throw new Error(`Unknown LLM_PROVIDER "${explicit}". Use "openai" or "anthropic".`);
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return null;
}

export function isLlmConfigured() {
  return resolveProvider() !== null;
}

export function describeLlm() {
  const provider = resolveProvider();
  if (!provider) return "none";
  return provider === "openai"
    ? `openai/${process.env.OPENAI_MODEL || "gpt-4o-mini"}`
    : `anthropic/${process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5"}`;
}

/**
 * Send a system + user prompt and get plain text back.
 * @returns {Promise<string>}
 */
export async function completeText({ system, user, maxTokens = 1500, temperature = 0.2 }) {
  const provider = resolveProvider();
  if (!provider) {
    throw new Error(
      "No LLM configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY (and optionally LLM_PROVIDER)."
    );
  }
  return provider === "openai"
    ? callOpenAI({ system, user, maxTokens, temperature })
    : callAnthropic({ system, user, maxTokens, temperature });
}

/**
 * Same as `completeText` but asks for and parses a JSON object.
 * Uses OpenAI's JSON mode where available and tolerant extraction otherwise.
 * @returns {Promise<any>}
 */
export async function completeJson({ system, user, maxTokens = 2000, temperature = 0 }) {
  const provider = resolveProvider();
  if (!provider) {
    throw new Error(
      "No LLM configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY (and optionally LLM_PROVIDER)."
    );
  }

  const jsonSystem = `${system}\n\nRespond with a single valid JSON object and nothing else. No markdown fences, no commentary.`;

  const raw =
    provider === "openai"
      ? await callOpenAI({ system: jsonSystem, user, maxTokens, temperature, json: true })
      : await callAnthropic({ system: jsonSystem, user, maxTokens, temperature });

  return parseJsonLoose(raw);
}

/* ------------------------------------------------------------------ */

async function callOpenAI({ system, user, maxTokens, temperature, json = false }) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const body = {
    model,
    temperature,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
  if (json) body.response_format = { type: "json_object" };

  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`OpenAI ${res.status}: ${data?.error?.message || res.statusText}`);
  }
  return data?.choices?.[0]?.message?.content ?? "";
}

async function callAnthropic({ system, user, maxTokens, temperature }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Anthropic ${res.status}: ${data?.error?.message || res.statusText}`);
  }
  return (data?.content ?? [])
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

/** Parse JSON that may be wrapped in prose or ```json fences. */
export function parseJsonLoose(raw) {
  const text = String(raw ?? "").trim();
  if (!text) throw new Error("LLM returned an empty response.");

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;

  try {
    return JSON.parse(candidate);
  } catch {
    /* fall through */
  }

  const start = candidate.search(/[[{]/);
  const end = Math.max(candidate.lastIndexOf("}"), candidate.lastIndexOf("]"));
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      /* fall through */
    }
  }

  throw new Error(`Could not parse JSON from the LLM response:\n${text.slice(0, 500)}`);
}

/**
 * Keep long transcripts inside a sane prompt budget.
 * Roughly 4 characters per token, so the default keeps us well under 40k tokens.
 */
export function truncateForPrompt(text, maxChars = Number(process.env.LLM_MAX_TRANSCRIPT_CHARS || 60000)) {
  const value = String(text ?? "");
  if (value.length <= maxChars) return value;
  const head = value.slice(0, Math.floor(maxChars * 0.7));
  const tail = value.slice(-Math.floor(maxChars * 0.3));
  return `${head}\n\n[... ${value.length - maxChars} characters of transcript omitted ...]\n\n${tail}`;
}
