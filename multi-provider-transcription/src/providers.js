/**
 * The five post-call transcription providers, behind one switch.
 *
 * In `create_bot` the provider lives at:
 *
 *   recording_config.transcript.provider = { "<provider_key>": { ...config } }
 *
 * Use EXACTLY ONE key. Two keys is an HTTP 400.
 *
 * The configs are deliberately not interchangeable - each provider exposes its
 * upstream vendor's own option names, and MeetStream passes them through rather
 * than inventing a lowest-common-denominator schema. The most-tripped-over
 * difference:
 *
 *   deepgram   -> { "model": "nova-3",          "language": "en" }
 *   assemblyai -> { "speech_models": ["..."],   "language_code": "en_us" }
 *                   ^^^^^^^^^^^^^ ARRAY, plural, and a different language key
 */

/** Split a comma-separated env var into a trimmed array. */
function csv(value) {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export const PROVIDERS = {
  deepgram: {
    label: "Deepgram",
    languageField: "language",
    languageExample: "en",
    diarizationField: "diarize",
    notes: "General-purpose default. nova-3 is fast and accurate for English.",
    build({ language, diarize }) {
      const config = {
        model: process.env.DEEPGRAM_MODEL || "nova-3",
        smart_format: true,
        punctuate: true,
      };
      if (language) config.language = language;
      if (diarize) config.diarize = true;
      return { deepgram: config };
    },
  },

  assemblyai: {
    label: "AssemblyAI",
    languageField: "language_code",
    languageExample: "en_us",
    diarizationField: "speaker_labels",
    notes: "Rich post-processing: speaker labels, PII redaction, auto chapters.",
    build({ language, diarize }) {
      const config = {};
      // `speech_models` is an ARRAY. Left out entirely unless you set it, so
      // the request never carries a model name the account may not have.
      const models = csv(process.env.ASSEMBLYAI_SPEECH_MODELS);
      if (models.length > 0) config.speech_models = models;
      // `language_code`, not `language`.
      if (language) config.language_code = language;
      if (diarize) config.speaker_labels = true;
      return { assemblyai: config };
    },
  },

  sarvam: {
    label: "Sarvam AI",
    languageField: "language_code",
    languageExample: "hi-IN",
    diarizationField: "with_diarization",
    notes: "Built for Indic languages. Use the xx-IN codes.",
    build({ language, diarize }) {
      const config = {};
      if (process.env.SARVAM_MODEL) config.model = process.env.SARVAM_MODEL;
      if (language) config.language_code = language;
      if (diarize) config.with_diarization = true;
      return { sarvam: config };
    },
  },

  jigsawstack: {
    label: "JigsawStack",
    languageField: "language",
    languageExample: "auto",
    diarizationField: "by_speaker",
    notes: "Auto language detection plus optional translation to English.",
    build({ language, diarize }) {
      const config = {
        language: language || "auto",
        translate: process.env.TRANSLATE === "true",
      };
      if (diarize) config.by_speaker = true;
      return { jigsawstack: config };
    },
  },

  meetstream: {
    label: "MeetStream (in-house)",
    languageField: "language",
    languageExample: "auto",
    diarizationField: null,
    notes: "MeetStream's own engine. Auto detection and optional translation.",
    build({ language }) {
      return {
        meetstream: {
          language: language || "auto",
          translate: process.env.TRANSLATE === "true",
        },
      };
    },
  },
};

export const PROVIDER_KEYS = Object.keys(PROVIDERS);

/**
 * @param {string} name
 * @param {{ language?: string, diarize?: boolean }} [options]
 * @returns {object} single-key provider block for recording_config.transcript.provider
 */
export function buildProviderBlock(name, options = {}) {
  const provider = PROVIDERS[name];
  if (!provider) {
    if (name.endsWith("_streaming") || name === "meeting_captions") {
      throw new Error(
        `"${name}" is a streaming provider. It delivers transcripts live and never\n` +
          "produces a post-call transcript, so this template cannot fetch one.\n" +
          "See the live-captions-overlay template for the streaming path.\n" +
          `Post-call providers: ${PROVIDER_KEYS.join(", ")}.`,
      );
    }
    throw new Error(`Unknown provider "${name}". Choose one of: ${PROVIDER_KEYS.join(", ")}.`);
  }
  return provider.build({
    language: options.language || undefined,
    diarize: Boolean(options.diarize),
  });
}
