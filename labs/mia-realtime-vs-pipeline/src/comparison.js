function createComparisonTracker() {
  const runs = new Map();

  function ensure(mode) {
    if (!runs.has(mode)) {
      runs.set(mode, {
        mode,
        label: mode,
        botId: undefined,
        events: [],
        firstEventAt: undefined,
        inMeetingAt: undefined,
        stoppedAt: undefined,
      });
    }
    return runs.get(mode);
  }

  function registerBot({ mode, label, botId }) {
    const run = ensure(mode);
    run.label = label;
    run.botId = botId;
  }

  function record(payload) {
    const mode = payload.custom_attributes?.mode || payload.customAttributes?.mode || "unknown";
    const run = ensure(mode);
    const timestamp = new Date();
    const event = payload.event || payload.type || "unknown";

    if (!run.firstEventAt) run.firstEventAt = timestamp;
    if (event === "bot.inmeeting") run.inMeetingAt = timestamp;
    if (event === "bot.stopped") run.stoppedAt = timestamp;

    if (payload.bot_id || payload.botId) {
      run.botId = payload.bot_id || payload.botId;
    }

    run.events.push({
      event,
      at: timestamp,
      status: payload.bot_status || payload.status,
      message: payload.message,
    });
  }

  function printSummary() {
    console.log("\nComparison summary");
    console.log("==================");

    for (const run of runs.values()) {
      console.log(`\n${run.label || run.mode}`);
      console.log(`  bot_id        : ${run.botId ?? "(unknown)"}`);
      console.log(`  events        : ${run.events.length}`);
      console.log(`  first event   : ${formatTime(run.firstEventAt)}`);
      console.log(`  in meeting    : ${formatTime(run.inMeetingAt)}`);
      console.log(`  stopped       : ${formatTime(run.stoppedAt)}`);

      if (run.firstEventAt && run.inMeetingAt) {
        console.log(`  join latency  : ${run.inMeetingAt.getTime() - run.firstEventAt.getTime()} ms from first event`);
      }

      const counts = countEvents(run.events);
      console.log(`  event counts  : ${JSON.stringify(counts)}`);
    }

    console.log("\nInterpretation");
    console.log("- Realtime mode is optimized for direct, low-latency voice interaction.");
    console.log("- Pipeline mode adds transcription and orchestration, which increases latency but improves flexibility.");
    console.log("- Exact speech-to-response latency requires prompting both agents during the live meeting and timing the response.");
  }

  return { registerBot, record, printSummary };
}

function countEvents(events) {
  return events.reduce((counts, item) => {
    counts[item.event] = (counts[item.event] || 0) + 1;
    return counts;
  }, {});
}

function formatTime(value) {
  return value ? value.toISOString() : "(not observed)";
}

module.exports = { createComparisonTracker };
