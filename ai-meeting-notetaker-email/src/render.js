/**
 * Turns a MeetStream summary + transcript into an HTML and a plain-text email body.
 * No template engine - just string building, so it is easy to restyle.
 */

import { formatClock } from "./meetstream.js";

const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * @param {object} input
 * @param {string} input.subject
 * @param {string} input.summary            Plain text summary (may be empty)
 * @param {Array<{name: string|null, email: string|null}>} input.participants
 * @param {Array<{speaker: string, transcript: string, start_time: number|null}>} input.segments
 * @param {string} input.botId
 * @param {number} input.transcriptExcerptTurns  How many turns to inline in the email
 * @returns {{ html: string, text: string }}
 */
export function renderEmail({
  subject,
  summary,
  participants = [],
  segments = [],
  botId,
  transcriptExcerptTurns = 40,
}) {
  const turns = groupTurns(segments);
  const excerpt = turns.slice(0, transcriptExcerptTurns);
  const truncated = turns.length - excerpt.length;

  const participantLine =
    participants.length > 0
      ? participants.map((p) => p.name || p.email).filter(Boolean).join(", ")
      : "Not reported by the meeting platform";

  /* ---------------- plain text ---------------- */

  const textParts = [subject, "=".repeat(Math.min(subject.length, 70)), ""];
  textParts.push(`Participants: ${participantLine}`, "");

  if (summary) {
    textParts.push("SUMMARY", "-------", summary, "");
  } else {
    textParts.push(
      "SUMMARY",
      "-------",
      "(No AI summary was available for this meeting.)",
      ""
    );
  }

  textParts.push("TRANSCRIPT", "----------");
  for (const turn of excerpt) {
    const stamp = turn.start_time != null ? `[${formatClock(turn.start_time)}] ` : "";
    textParts.push(`${stamp}${turn.speaker}: ${turn.transcript}`);
  }
  if (truncated > 0) textParts.push("", `(+${truncated} more turns omitted)`);
  textParts.push("", `Recorded with MeetStream · bot ${botId ?? "unknown"}`);

  /* ---------------- html ---------------- */

  const summaryHtml = summary
    ? summary
        .split(/\n{2,}/)
        .map((block) => `<p style="margin:0 0 12px;">${escapeHtml(block).replace(/\n/g, "<br>")}</p>`)
        .join("")
    : `<p style="margin:0;color:#6b7280;">No AI summary was available for this meeting.</p>`;

  const transcriptHtml = excerpt
    .map((turn) => {
      const stamp =
        turn.start_time != null
          ? `<span style="color:#9ca3af;font-variant-numeric:tabular-nums;">${formatClock(
              turn.start_time
            )}</span> `
          : "";
      return `<p style="margin:0 0 10px;line-height:1.5;">${stamp}<strong>${escapeHtml(
        turn.speaker
      )}</strong><br>${escapeHtml(turn.transcript)}</p>`;
    })
    .join("");

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
    <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:28px;">
      <h1 style="margin:0 0 4px;font-size:20px;">${escapeHtml(subject)}</h1>
      <p style="margin:0 0 20px;font-size:13px;color:#6b7280;">${escapeHtml(participantLine)}</p>

      <h2 style="margin:0 0 8px;font-size:15px;text-transform:uppercase;letter-spacing:.04em;color:#374151;">Summary</h2>
      <div style="font-size:14px;line-height:1.6;">${summaryHtml}</div>

      <h2 style="margin:24px 0 8px;font-size:15px;text-transform:uppercase;letter-spacing:.04em;color:#374151;">Transcript</h2>
      <div style="font-size:13px;color:#1f2937;">${transcriptHtml || "<p>(empty transcript)</p>"}</div>
      ${
        truncated > 0
          ? `<p style="margin:12px 0 0;font-size:12px;color:#9ca3af;">+${truncated} more turns omitted.</p>`
          : ""
      }

      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0 12px;">
      <p style="margin:0;font-size:12px;color:#9ca3af;">Recorded with MeetStream · bot ${escapeHtml(
        botId ?? "unknown"
      )}</p>
    </div>
  </body>
</html>`;

  return { html, text: textParts.join("\n") };
}

/** Merge consecutive segments from the same speaker into one readable turn. */
export function groupTurns(segments) {
  const turns = [];
  for (const segment of segments) {
    const previous = turns[turns.length - 1];
    if (previous && previous.speaker === segment.speaker) {
      previous.transcript += ` ${segment.transcript}`;
    } else {
      turns.push({ ...segment });
    }
  }
  return turns;
}
