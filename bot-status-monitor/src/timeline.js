/**
 * Terminal rendering for the bot lifecycle.
 *
 * When stdout is a TTY the whole view is redrawn in place so it reads like a
 * live dashboard. When it is not (piped to a file, running in CI) it falls back
 * to append-only log lines, which is what you actually want in a log.
 */

import { LIFECYCLE_ORDER, describe, isTerminal } from "./statuses.js";

const IS_TTY = Boolean(process.stdout.isTTY);

export class Timeline {
  constructor(botId) {
    this.botId = botId;
    this.entries = []; // { status, firstSeen, lastSeen, polls }
    this.startedAt = Date.now();
    this.detail = null;
  }

  /** Records one poll result. Returns true when the status changed. */
  record(status) {
    const now = Date.now();
    const current = this.entries[this.entries.length - 1];

    if (current && current.status === status) {
      current.lastSeen = now;
      current.polls += 1;
      return false;
    }

    this.entries.push({ status, firstSeen: now, lastSeen: now, polls: 1 });
    return true;
  }

  setDetail(detail) {
    this.detail = detail;
  }

  render() {
    const lines = this.#buildLines();
    if (IS_TTY) {
      process.stdout.write("\x1b[2J\x1b[H");
      process.stdout.write(lines.join("\n") + "\n");
    } else {
      const latest = this.entries[this.entries.length - 1];
      if (latest) {
        console.log(
          `[${new Date(latest.firstSeen).toISOString()}] ${latest.status} - ${
            describe(latest.status)?.meaning ?? "unrecognised status"
          }`
        );
      }
    }
  }

  /** Final append-only summary, printed once polling ends. */
  renderSummary() {
    const lines = this.#buildLines();
    lines.push("");
    lines.push(`Total elapsed: ${fmtDuration(Date.now() - this.startedAt)}`);
    console.log("\n" + lines.join("\n") + "\n");
  }

  #buildLines() {
    const lines = [];
    lines.push("MeetStream bot lifecycle");
    lines.push(`bot_id: ${this.botId}`);
    lines.push("=".repeat(72));
    lines.push("");

    const seen = new Set(this.entries.map((e) => e.status));
    const current = this.entries[this.entries.length - 1];

    // Scaffold: the expected happy path, with anything actually observed
    // marked. States the session skipped stay dim.
    lines.push("Expected path");
    for (const stage of LIFECYCLE_ORDER) {
      const hit = seen.has(stage);
      const isNow = current?.status === stage;
      const marker = isNow ? ">" : hit ? "x" : ".";
      lines.push(`  ${marker} ${stage}`);
    }
    lines.push("");

    lines.push("Observed");
    if (this.entries.length === 0) {
      lines.push("  (no status yet)");
    }
    for (const entry of this.entries) {
      const at = new Date(entry.firstSeen).toLocaleTimeString();
      const held = fmtDuration(entry.lastSeen - entry.firstSeen);
      const info = describe(entry.status);
      const tag = info?.terminal ? " [terminal]" : "";
      lines.push(`  ${at}  ${entry.status}${tag}`);
      lines.push(`            held ${held} over ${entry.polls} poll(s)`);
      if (info) lines.push(`            ${info.meaning}`);
    }

    if (current && isTerminal(current.status)) {
      const info = describe(current.status);
      lines.push("");
      lines.push("Session over");
      if (info) lines.push(`  ${info.note}`);
    }

    if (this.detail) {
      lines.push("");
      lines.push("Detail (GET /bots/{id}/detail)");
      for (const [key, value] of interestingFields(this.detail)) {
        lines.push(`  ${key.padEnd(22)} ${value}`);
      }
    }

    return lines;
  }
}

/**
 * The detail payload carries a lot of session metadata and the shape varies
 * with how the bot was configured, so pick out the fields that are useful for
 * a lifecycle view and skip anything absent rather than assuming a schema.
 */
function interestingFields(detail) {
  if (!detail || typeof detail !== "object") return [];

  const candidates = [
    "bot_id",
    "bot_name",
    "bot_status",
    "status",
    "platform",
    "meeting_url",
    "meeting_link",
    "transcript_id",
    "caption_file",
    "duration",
    "created_at",
    "join_at",
    "joined_at",
    "left_at",
    "started_at",
    "ended_at",
  ];

  const out = [];
  for (const key of candidates) {
    const value = detail[key];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "object") continue;
    out.push([key, String(value)]);
  }
  return out;
}

export function fmtDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
