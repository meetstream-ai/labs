/**
 * What each provider charges, as published on its pricing page on the date
 * below, and how a run's cost is worked out from what the provider actually
 * billed on (read from its raw response, saved as transcripts/*.raw.json).
 *
 * Prices change: update PRICES_AS_OF and the rates together, and say so in
 * the results you publish. Costs are transcription only. MeetStream's bot fee
 * ($0.35/hr) applies whichever provider transcribes, so it is left out, and
 * third-party providers are billed on your own key with no MeetStream markup.
 */
const PRICES_AS_OF = "2026-09-28";
const INR_PER_USD = 96.16; // for Sarvam, which prices in rupees; rate on PRICES_AS_OF

const RATES = {
  meetstream: {
    source: "https://www.meetstream.ai/pricing",
    describe: () => "$0.10/hr (MeetStream transcription add-on)",
    cost: ({ seconds }) => (seconds == null ? null : (seconds / 3600) * 0.10),
  },
  deepgram: {
    source: "https://deepgram.com/pricing",
    describe: () => "$0.0043/min (Nova-3 pre-recorded)",
    cost: ({ seconds }) => (seconds == null ? null : (seconds / 60) * 0.0043),
  },
  assemblyai: {
    source: "https://www.assemblyai.com/pricing",
    // Speaker labels are on unless the config turns them off (MeetStream's default).
    describe: ({ config }) => (labels(config, "speaker_labels") ? "$0.15/hr Universal-2 + $0.02/hr speaker labels" : "$0.15/hr (Universal-2)"),
    cost: ({ seconds, config }) => (seconds == null ? null : (seconds / 3600) * (0.15 + (labels(config, "speaker_labels") ? 0.02 : 0))),
  },
  sarvam: {
    source: "https://www.sarvam.ai/api-pricing",
    // Diarization is on unless the config turns it off (MeetStream's default).
    describe: ({ config }) => `₹${labels(config, "with_diarization") ? 45 : 30}/hr batch${labels(config, "with_diarization") ? " with diarization" : ""}, at ₹${INR_PER_USD}/$`,
    cost: ({ seconds, config }) => (seconds == null ? null : ((seconds / 3600) * (labels(config, "with_diarization") ? 45 : 30)) / INR_PER_USD),
  },
  jigsawstack: {
    source: "https://jigsawstack.com/pricing",
    // Billed per token (1 ms of processing = 1 token, plus characters in and out),
    // so the cost comes from the usage in its own response, not the audio length.
    describe: () => "$0.99 per 1M tokens (from the response's own usage)",
    cost: ({ raw }) => {
      const tokens = raw?._usage?.total_tokens;
      return typeof tokens === "number" ? (tokens * 0.99) / 1e6 : null;
    },
  },
};

function labels(config, key) {
  const inner = config ? Object.values(config)[0] : null;
  return inner?.[key] !== false;
}

/** The billed audio length, from whichever provider's raw response reports it. */
function audioSeconds(raws) {
  for (const raw of raws) {
    if (typeof raw?.metadata?.duration === "number") return raw.metadata.duration; // Deepgram
    if (typeof raw?.audio_duration === "number") return raw.audio_duration;        // AssemblyAI
  }
  return null;
}

/**
 * @returns {{ cost_usd: number|null, per_hour_usd: number|null, basis: string, source: string }|null}
 */
function costOf(provider, { seconds, raw, config }) {
  const rate = RATES[provider];
  if (!rate) return null;
  const cost = rate.cost({ seconds, raw, config });
  return {
    cost_usd: cost,
    per_hour_usd: cost != null && seconds ? cost / (seconds / 3600) : null,
    basis: rate.describe({ config }),
    source: rate.source,
  };
}

module.exports = { PRICES_AS_OF, INR_PER_USD, RATES, audioSeconds, costOf };
