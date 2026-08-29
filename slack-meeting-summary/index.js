/**
 * Slack Meeting Summary
 *
 * A MeetStream bot records the meeting, and this script posts the AI summary
 * plus extracted action items into a Slack channel as Block Kit blocks.
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
import { assertSlackConfig, postToSlack } from "./src/slack.js";
import { buildSummaryMessage, buildTranscriptMessage } from "./src/blocks.js";
import { extractActionItems } from "./src/actions.js";
import { describeLlm } from "./src/llm.js";

/** Merge consecutive segments from the same speaker into one turn. */
function groupTurns(segments) {
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

run({
  name: "Slack Meeting Summary",

  preflight() {
    const mode = assertSlackConfig();
    console.log(`Slack mode: ${mode}`);
    console.log(`LLM for action items: ${describeLlm()}`);
  },

  async onMeetingComplete({ botId, transcriptId, segments }) {
    /* 1. MeetStream's AI summary. */
    let summary = "";
    if (botId) {
      const payload = await getBotSummary(botId);
      if (payload) summary = summaryToText(payload);
      else console.warn("  GET /bots/{id}/summary returned 202, the summary is still generating.");
    }

    /* 2. Participants, for the context line. */
    let participants = [];
    if (botId) {
      try {
        participants = normalizeParticipants(await getParticipants(botId))
          .map((p) => p.name || p.email)
          .filter(Boolean);
      } catch (error) {
        console.warn(`  Could not read participants: ${error.message}`);
      }
    }
    if (participants.length === 0) {
      participants = [...new Set(segments.map((segment) => segment.speaker))];
    }

    /* 3. Action items, if an LLM key is configured. */
    let actionItems = [];
    try {
      actionItems = await extractActionItems(segments, summary);
      console.log(`Extracted ${actionItems.length} action items.`);
    } catch (error) {
      console.warn(`  Action item extraction failed, posting without it: ${error.message}`);
    }

    /* 4. Post the summary. */
    const title = (process.env.SLACK_MESSAGE_TITLE || "Meeting notes - {date}").replace(
      "{date}",
      new Date().toLocaleDateString("en-US", { dateStyle: "medium" })
    );

    const message = buildSummaryMessage({
      title,
      summary,
      actionItems,
      participants,
      botId,
      segmentCount: segments.length,
    });

    const result = await postToSlack(message);
    console.log(
      `Posted to Slack via ${result.mode}${result.channel ? ` in ${result.channel}` : ""}.`
    );

    /* 5. With a bot token we also get a `ts`, so the transcript can go in a thread. */
    if (result.ts && process.env.POST_TRANSCRIPT_IN_THREAD === "true") {
      const turns = groupTurns(segments);
      const reply = buildTranscriptMessage(turns, Number(process.env.TRANSCRIPT_THREAD_TURNS || 60));
      await postToSlack({ ...reply, threadTs: result.ts });
      console.log(`Posted the transcript as a thread reply (${turns.length} turns).`);
    } else if (process.env.POST_TRANSCRIPT_IN_THREAD === "true") {
      console.warn(
        "  POST_TRANSCRIPT_IN_THREAD needs a bot token. Incoming webhooks cannot reply in threads."
      );
    }

    console.log(`transcript_id: ${transcriptId}`);
  },
}).catch((error) => {
  console.error(`\n  ${error.message}`);
  process.exit(1);
});
