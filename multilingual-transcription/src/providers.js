/**
 * Provider blocks for non-English transcription.
 *
 * Same rule as everywhere else: exactly ONE key under
 * `recording_config.transcript.provider`. What changes here is which language
 * field each provider expects - see src/languages.js.
 */

import { LANGUAGE_FIELD } from "./languages.js";

/** Split a comma-separated env var into a trimmed array. */
function csv(value) {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export const PROVIDER_KEYS = ["deepgram", "assemblyai", "sarvam", "jigsawstack", "meetstream"];

/** Providers whose language field can take "auto" for detection. */
export const AUTO_DETECT_PROVIDERS = new Set(["jigsawstack", "meetstream"]);

/** Providers that can translate the result to English. */
export const TRANSLATING_PROVIDERS = new Set(["jigsawstack", "meetstream"]);

/**
 * @param {string} provider
 * @param {{ language?: string, diarize?: boolean, translate?: boolean }} options
 * @returns {object} single-key provider block
 */
export function buildProviderBlock(provider, options = {}) {
  const { language, diarize = false, translate = false } = options;

  switch (provider) {
    case "deepgram": {
      // language: "en", "es", "hi", "ja" ...
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
      // language_code: "en_us", "es", "fr" ... and speech_models is an ARRAY.
      const config = {};
      const models = csv(process.env.ASSEMBLYAI_SPEECH_MODELS);
      if (models.length > 0) config.speech_models = models;
      if (language) config.language_code = language;
      if (diarize) config.speaker_labels = true;
      return { assemblyai: config };
    }

    case "sarvam": {
      // language_code: "hi-IN", "ta-IN", "te-IN" ... - the Indic specialist.
      const config = {};
      if (process.env.SARVAM_MODEL) config.model = process.env.SARVAM_MODEL;
      if (process.env.SARVAM_MODE) config.mode = process.env.SARVAM_MODE;
      if (language) config.language_code = language;
      if (diarize) config.with_diarization = true;
      return { sarvam: config };
    }

    case "jigsawstack": {
      // language: "auto" detects; translate lifts the output into English.
      const config = { language: language || "auto", translate };
      if (diarize) config.by_speaker = true;
      return { jigsawstack: config };
    }

    case "meetstream": {
      return { meetstream: { language: language || "auto", translate } };
    }

    default:
      if (provider.endsWith("_streaming") || provider === "meeting_captions") {
        throw new Error(
          `"${provider}" is a streaming provider and produces no post-call transcript.\n` +
            "See the live-captions-overlay template for the streaming path.",
        );
      }
      throw new Error(`Unknown provider "${provider}". Choose one of: ${PROVIDER_KEYS.join(", ")}.`);
  }
}

/** The language field name this provider actually reads. */
export function languageFieldFor(provider) {
  return LANGUAGE_FIELD[provider] ?? "language";
}
