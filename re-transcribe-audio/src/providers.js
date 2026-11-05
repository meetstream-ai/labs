/**
 * Post-call transcription providers.
 *
 * `POST /bots/{bot_id}/transcribe` takes the same provider block that
 * `create_bot` takes under `recording_config.transcript.provider`:
 *
 *   { "provider": { "<provider_key>": { ...provider config... } } }
 *
 * Use exactly ONE provider key. Only post-call providers can be used here -
 * a `*_streaming` provider has nothing to re-run against a stored recording.
 *
 * Note the field-shape difference: Deepgram takes `model` + `language`,
 * AssemblyAI takes `speech_models` (an array) + `language_code`.
 */

export const POST_CALL_PROVIDERS = [
  "deepgram",
  "assemblyai",
  "sarvam",
  "jigsawstack",
  "meetstream",
];

/** Split a comma-separated env var into a trimmed array. */
function csv(value) {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Build the provider block for a re-transcription run.
 *
 * @param {string} provider  One of POST_CALL_PROVIDERS
 * @param {object} [options]
 * @param {string} [options.language]  Language code in the PROVIDER's format
 * @param {boolean} [options.diarize]  Ask for speaker labels where supported
 * @returns {object} e.g. { deepgram: { model: "nova-3", language: "en" } }
 */
export function buildProviderBlock(provider, options = {}) {
  const { language, diarize = false } = options;

  switch (provider) {
    case "deepgram": {
      // Deepgram: `model` (string) + `language` (string), e.g. "en", "es", "hi".
      const config = {
        model: process.env.DEEPGRAM_MODEL || "nova-3",
        smart_format: true,
        punctuate: true,
      };
      if (language) config.language = language;
      if (diarize) config.diarize = true;
      return { deepgram: config };
    }

    case "assemblyai": {
      // AssemblyAI: `speech_models` (ARRAY) + `language_code`, e.g. "en_us".
      // Different field names AND a different shape from Deepgram.
      const config = {};
      const models = csv(process.env.ASSEMBLYAI_SPEECH_MODELS);
      if (models.length > 0) config.speech_models = models;
      if (language) config.language_code = language;
      if (diarize) config.speaker_labels = true;
      return { assemblyai: config };
    }

    case "sarvam": {
      // Sarvam: `language_code` in BCP-47-ish Indic form, e.g. "hi-IN", "ta-IN".
      const config = {};
      if (process.env.SARVAM_MODEL) config.model = process.env.SARVAM_MODEL;
      if (language) config.language_code = language;
      if (diarize) config.with_diarization = true;
      return { sarvam: config };
    }

    case "jigsawstack": {
      // JigsawStack: `language` ("auto" detects), plus translate / by_speaker.
      const config = {
        language: language || "auto",
        translate: process.env.TRANSLATE === "true",
      };
      if (diarize) config.by_speaker = true;
      return { jigsawstack: config };
    }

    case "meetstream": {
      // MeetStream in-house: `language` ("auto" detects) + translate.
      return {
        meetstream: {
          language: language || "auto",
          translate: process.env.TRANSLATE === "true",
        },
      };
    }

    default:
      throw new Error(
        `Unknown provider "${provider}". Post-call providers: ${POST_CALL_PROVIDERS.join(", ")}.`,
      );
  }
}

/** Guard against the common mistake of passing a streaming provider here. */
export function assertPostCallProvider(provider) {
  if (provider.endsWith("_streaming") || provider === "meeting_captions") {
    throw new Error(
      `"${provider}" is not a post-call provider.\n` +
        "Streaming providers transcribe audio as it arrives; there is nothing to re-run\n" +
        "against a finished recording. Pick one of: " +
        `${POST_CALL_PROVIDERS.join(", ")}.`,
    );
  }
  if (!POST_CALL_PROVIDERS.includes(provider)) {
    throw new Error(
      `Unknown provider "${provider}". Post-call providers: ${POST_CALL_PROVIDERS.join(", ")}.`,
    );
  }
}
