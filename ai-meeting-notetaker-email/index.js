/**
 * AI Meeting Notetaker → Email
 *
 * A MeetStream bot joins the meeting, records and transcribes it, MeetStream
 * generates the AI summary, and this script emails the notes to the attendees.
 *
 *   node index.js --meeting "https://meet.google.com/abc-defg-hij"
 *   node index.js --bot <bot_id>            # replay a meeting that already ended
 */

import "dotenv/config";

import { run } from "./src/pipeline.js";
import {
  getBotSummary,
  getParticipants,
  normalizeParticipants,
  summaryToText,
} from "./src/meetstream.js";
import { renderEmail } from "./src/render.js";
import { assertEmailConfig, resolveEmailProvider, sendEmail } from "./src/email.js";

run({
  name: "AI Meeting Notetaker → Email",

  // Validate email config before we spend money creating a bot.
  preflight() {
    const provider = assertEmailConfig();
    const hasStaticRecipients = Boolean(process.env.EMAIL_TO);
    const usesParticipants = process.env.SEND_TO_PARTICIPANTS === "true";
    if (!hasStaticRecipients && !usesParticipants) {
      throw new Error(
        "Set EMAIL_TO to a comma-separated recipient list, or SEND_TO_PARTICIPANTS=true."
      );
    }
    console.log(`Email provider: ${provider}`);
  },

  async onMeetingComplete({ botId, transcriptId, segments }) {
    /* 1. MeetStream's own AI summary. */
    let summary = "";
    if (botId) {
      const payload = await getBotSummary(botId);
      if (payload) {
        summary = summaryToText(payload);
      } else {
        console.warn("  GET /bots/{id}/summary returned 202 - the summary is still generating.");
      }
    }

    /* 2. Who was in the room. */
    let participants = [];
    if (botId) {
      try {
        participants = normalizeParticipants(await getParticipants(botId));
      } catch (error) {
        console.warn(`  Could not read participants: ${error.message}`);
      }
    }

    /* 3. Work out the recipient list. */
    const recipients = new Set(
      (process.env.EMAIL_TO || "")
        .split(",")
        .map((address) => address.trim())
        .filter(Boolean)
    );

    if (process.env.SEND_TO_PARTICIPANTS === "true") {
      for (const participant of participants) {
        if (participant.email && participant.email.includes("@")) recipients.add(participant.email);
      }
      if (recipients.size === 0) {
        console.warn(
          "  SEND_TO_PARTICIPANTS=true but the meeting platform reported no attendee emails. " +
            "Set EMAIL_TO as a fallback."
        );
      }
    }

    /* 4. Build and send. */
    const subject = (process.env.EMAIL_SUBJECT || "Meeting notes - {date}").replace(
      "{date}",
      new Date().toLocaleDateString("en-US", { dateStyle: "medium" })
    );

    const { html, text } = renderEmail({
      subject,
      summary,
      participants,
      segments,
      botId,
      transcriptExcerptTurns: Number(process.env.TRANSCRIPT_EXCERPT_TURNS || 40),
    });

    console.log(`Sending via ${resolveEmailProvider()} to ${[...recipients].join(", ") || "(nobody)"}`);
    const result = await sendEmail({ to: [...recipients], subject, html, text });
    console.log(result);
    console.log(`transcript_id: ${transcriptId}`);
  },
}).catch((error) => {
  console.error(`\n  ${error.message}`);
  process.exit(1);
});
