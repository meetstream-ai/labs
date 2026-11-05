/**
 * Action Item Extractor
 *
 * Pulls a MeetStream transcript, runs an LLM over it to extract action items
 * with owners and due dates, and writes structured JSON plus a Markdown report.
 *
 *   node index.js --meeting "https://meet.google.com/abc-defg-hij"
 *   node index.js --bot <bot_id>            # replay a meeting that already ended
 */

import "dotenv/config";

import { run } from "./src/pipeline.js";
import { getBotSummary, summaryToText } from "./src/meetstream.js";
import { describeLlm, isLlmConfigured } from "./src/llm.js";
import { extractActionItems } from "./src/extract.js";
import { renderMarkdown, sortActionItems, writeOutputs } from "./src/render.js";

run({
  name: "Action Item Extractor",

  preflight() {
    if (!isLlmConfigured()) {
      throw new Error(
        "This template needs an LLM. Set OPENAI_API_KEY or ANTHROPIC_API_KEY " +
          "(and optionally LLM_PROVIDER to pick between them)."
      );
    }
    console.log(`LLM: ${describeLlm()}`);
  },

  async onMeetingComplete({ botId, transcriptId, segments }) {
    /* MeetStream's own summary gives the model useful framing. Optional. */
    let summary = "";
    if (botId) {
      try {
        const payload = await getBotSummary(botId);
        if (payload) summary = summaryToText(payload);
      } catch (error) {
        console.warn(`  Could not read the AI summary: ${error.message}`);
      }
    }

    const meetingDate = process.env.MEETING_DATE ? new Date(process.env.MEETING_DATE) : new Date();
    if (Number.isNaN(meetingDate.getTime())) {
      throw new Error(`MEETING_DATE is not a valid date: ${process.env.MEETING_DATE}`);
    }

    const result = await extractActionItems({ segments, summary, meetingDate });
    console.log(
      `Extracted ${result.action_items.length} action items, ` +
        `${result.decisions.length} decisions, ${result.open_questions.length} open questions.`
    );

    const json = {
      bot_id: botId ?? null,
      transcript_id: transcriptId,
      meeting_date: meetingDate.toISOString().slice(0, 10),
      extracted_at: new Date().toISOString(),
      model: describeLlm(),
      segment_count: segments.length,
      speakers: [...new Set(segments.map((segment) => segment.speaker))],
      action_items: sortActionItems(result.action_items),
      decisions: result.decisions,
      open_questions: result.open_questions,
    };

    const markdown = renderMarkdown({
      result,
      botId,
      transcriptId,
      meetingDate,
      segmentCount: segments.length,
    });

    const { jsonPath, markdownPath } = await writeOutputs({
      dir: process.env.OUTPUT_DIR || "output",
      transcriptId,
      json,
      markdown,
    });

    console.log(`\nWrote ${jsonPath}`);
    console.log(`Wrote ${markdownPath}`);

    if (process.env.PRINT_MARKDOWN !== "false") {
      console.log(`\n${markdown}`);
    }
  },
}).catch((error) => {
  console.error(`\n  ${error.message}`);
  process.exit(1);
});
