/**
 * The exact provider config sent to POST /bots/{id}/transcribe for each
 * provider. This file is the whole of the "how was each provider configured"
 * question, and every run copies it into its run.json so a published number
 * can always be traced back to the request that produced it.
 *
 * The rule applied here: each provider's documented model, English where the
 * provider documents an English code, and every other option left at the
 * provider's default. No custom vocabulary, no keyterm prompts, nothing tuned
 * to the sample clip.
 *
 * Every provider except `meetstream` needs that provider's key configured in
 * the MeetStream dashboard (Integrations -> Transcription) first. A provider
 * that is not configured shows up in the results as "not run" with the API's
 * reason rather than being dropped from the table.
 */
const PROVIDERS = {
  // MeetStream's own engine ("Mia Transcribe" in the dashboard). Left on
  // "auto": the docs do not confirm that an English code is accepted, and
  // auto-detection can only cost it accuracy, never gain it.
  meetstream: { meetstream: { language: "auto", translate: false } },

  deepgram: { deepgram: { model: "nova-3", language: "en" } },

  assemblyai: { assemblyai: { speech_models: ["universal-2"], language_code: "en_us" } },

  // en-IN is the only English code Sarvam's MeetStream docs list.
  sarvam: { sarvam: { model: "saaras:v3", mode: "transcribe", language_code: "en-IN" } },

  jigsawstack: { jigsawstack: { language: "en", translate: false } },
};

// Not benchmarked: `meeting_captions` reads the platform's own live captions
// during the call, so it cannot be re-run against a finished recording and
// would not be hearing the same audio as the others.

function selectProviders(names) {
  if (!names) return Object.keys(PROVIDERS);
  const wanted = names.split(",").map((n) => n.trim()).filter(Boolean);
  const unknown = wanted.filter((n) => !PROVIDERS[n]);
  if (unknown.length) {
    throw new Error(
      `Unknown provider(s): ${unknown.join(", ")}. Known: ${Object.keys(PROVIDERS).join(", ")}`
    );
  }
  return wanted;
}

// What people read: the API's provider keys stay as they are in configs and
// results.json; reports and the UI show these names.
const DISPLAY_NAMES = {
  meetstream: "Mia Transcribe",
  deepgram: "Deepgram",
  assemblyai: "AssemblyAI",
  sarvam: "Sarvam",
  jigsawstack: "JigsawStack",
};
const displayName = (key) => DISPLAY_NAMES[key] ?? key;

module.exports = { PROVIDERS, selectProviders, DISPLAY_NAMES, displayName };
