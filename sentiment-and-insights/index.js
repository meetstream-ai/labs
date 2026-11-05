/**
 * Sentiment and Insights
 *
 * Analyses a MeetStream transcript for sentiment trends, topics and talk-time
 * balance, and produces a coaching-style report as Markdown plus JSON.
 *
 *   node index.js --meeting "https://meet.google.com/abc-defg-hij"
 *   node index.js --bot <bot_id>            # replay a meeting that already ended
 */

import "dotenv/config";

import { run } from "./src/pipeline.js";
import { getBotSummary, summaryToText } from "./src/meetstream.js";
import { describeLlm, isLlmConfigured } from "./src/llm.js";
import { balanceScore, computeTalkTime } from "./src/talktime.js";
import { analyzeTranscript } from "./src/analyze.js";
import { renderReport, writeOutputs } from "./src/report.js";

run({
  name: "Sentiment and Insights",

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
    if (segments.length === 0) {
      throw new Error("The transcript is empty, so there is nothing to analyse.");
    }

    /* 1. Talk time. Real measurements from get_speaker_timeline where possible. */
    const talkTime = await computeTalkTime(botId, segments);
    console.log(
      `Talk time source: ${talkTime.source}. ` +
        `${talkTime.speakers.length} speakers, ${talkTime.totalSeconds}s total.`
    );

    /* 2. MeetStream's own summary, as framing for the model. */
    let summary = "";
    if (botId) {
      try {
        const payload = await getBotSummary(botId);
        if (payload) summary = summaryToText(payload);
      } catch (error) {
        console.warn(`  Could not read the AI summary: ${error.message}`);
      }
    }

    /* 3. LLM analysis. */
    const analysis = await analyzeTranscript({
      segments,
      summary,
      talkTimeSpeakers: talkTime.speakers,
    });

    /* 4. Report. */
    const model = describeLlm();
    const markdown = renderReport({
      analysis,
      talkTime,
      botId,
      transcriptId,
      segmentCount: segments.length,
      model,
    });

    const json = {
      bot_id: botId ?? null,
      transcript_id: transcriptId,
      generated_at: new Date().toISOString(),
      model,
      segment_count: segments.length,
      talk_time: {
        source: talkTime.source,
        total_seconds: talkTime.totalSeconds,
        balance_score: Number(balanceScore(talkTime.speakers).toFixed(3)),
        speakers: talkTime.speakers,
      },
      analysis,
    };

    const { jsonPath, markdownPath } = await writeOutputs({
      dir: process.env.OUTPUT_DIR || "output",
      transcriptId,
      json,
      markdown,
    });

    console.log(`\nWrote ${jsonPath}`);
    console.log(`Wrote ${markdownPath}`);

    if (process.env.PRINT_REPORT !== "false") {
      console.log(`\n${markdown}`);
    }
  },
}).catch((error) => {
  console.error(`\n  ${error.message}`);
  process.exit(1);
});
