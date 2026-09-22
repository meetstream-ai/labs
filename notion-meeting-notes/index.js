/**
 * Notion Meeting Notes
 *
 * A MeetStream bot records the meeting, and this script files one Notion page
 * per meeting with the summary, participants, action items and full transcript.
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
import { assertNotionConfig, createMeetingPage } from "./src/notion.js";
import { buildMeetingBlocks } from "./src/page.js";
import { extractActionItems } from "./src/actions.js";
import { describeLlm } from "./src/llm.js";

run({
  name: "Notion Meeting Notes",

  preflight() {
    assertNotionConfig();
    console.log(
      `Notion target: ${
        process.env.NOTION_DATABASE_ID
          ? `database ${process.env.NOTION_DATABASE_ID}`
          : `page ${process.env.NOTION_PARENT_PAGE_ID}`
      }`
    );
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

    /* 2. Participants, falling back to the distinct speakers in the transcript. */
    let participants = [];
    if (botId) {
      try {
        participants = normalizeParticipants(await getParticipants(botId))
          .map((person) => (person.email ? `${person.name ?? person.email} (${person.email})` : person.name))
          .filter(Boolean);
      } catch (error) {
        console.warn(`  Could not read participants: ${error.message}`);
      }
    }
    if (participants.length === 0) {
      participants = [...new Set(segments.map((segment) => segment.speaker))];
    }

    /* 3. Action items (optional, needs an LLM key). */
    let actionItems = [];
    try {
      actionItems = await extractActionItems(segments, summary);
      console.log(`Extracted ${actionItems.length} action items.`);
    } catch (error) {
      console.warn(`  Action item extraction failed, filing the page without it: ${error.message}`);
    }

    /* 4. Build and create the page. */
    const now = new Date();
    const title = (process.env.NOTION_PAGE_TITLE || "Meeting notes - {date}").replace(
      "{date}",
      now.toLocaleDateString("en-US", { dateStyle: "medium" })
    );

    const blocks = buildMeetingBlocks({
      summary,
      participants,
      actionItems,
      segments,
      botId,
      transcriptId,
      maxTranscriptTurns: Number(process.env.NOTION_MAX_TRANSCRIPT_TURNS || 400),
    });

    console.log(`Creating Notion page with ${blocks.length} blocks...`);
    const page = await createMeetingPage({
      title,
      blocks,
      isoDate: now.toISOString().slice(0, 10),
    });

    console.log(`Notion page created: ${page.url}`);
  },
}).catch((error) => {
  console.error(`\n  ${error.message}`);
  process.exit(1);
});
