/**
 * Language selection, per provider.
 *
 * There is no single MeetStream language parameter. Each provider takes its own
 * upstream vendor's field, with its own code format, and MeetStream passes the
 * value straight through:
 *
 *   deepgram    -> "language":      "en"     "es"     "hi"      "ja"
 *   assemblyai  -> "language_code": "en_us"  "es"     "fr"      "de"
 *   sarvam      -> "language_code": "hi-IN"  "ta-IN"  "en-IN"
 *   jigsawstack -> "language":      "auto"   (or an ISO code) + "translate"
 *   meetstream  -> "language":      "auto"   (or an ISO code) + "translate"
 *
 * Two different failure modes follow from getting this wrong:
 *   - Wrong FIELD name (e.g. `language` on assemblyai): the option is not
 *     applied, the provider falls back to its default, and you get a confident
 *     English transcription of a Tamil call.
 *   - Wrong CODE FORMAT (e.g. "hi-IN" on deepgram): usually an HTTP 400, but
 *     some providers just ignore it.
 *
 * The catalogues below are common, useful examples - not the providers' full
 * supported lists. Check the vendor's own documentation for the complete set.
 */

export const LANGUAGE_FIELD = {
  deepgram: "language",
  assemblyai: "language_code",
  sarvam: "language_code",
  jigsawstack: "language",
  meetstream: "language",
};

/** Common codes per provider. Not exhaustive - see each vendor's docs. */
export const LANGUAGE_EXAMPLES = {
  deepgram: {
    format: 'ISO 639-1, optionally with a region: "en", "en-US", "es", "hi"',
    codes: {
      en: "English",
      "en-US": "English (US)",
      "en-GB": "English (UK)",
      es: "Spanish",
      fr: "French",
      de: "German",
      pt: "Portuguese",
      it: "Italian",
      nl: "Dutch",
      hi: "Hindi",
      ja: "Japanese",
      ko: "Korean",
      zh: "Chinese",
    },
  },
  assemblyai: {
    format: 'lowercase, underscore for region: "en_us", "en_uk", "es", "fr"',
    codes: {
      en: "English (global)",
      en_us: "English (US)",
      en_uk: "English (UK)",
      en_au: "English (Australia)",
      es: "Spanish",
      fr: "French",
      de: "German",
      it: "Italian",
      pt: "Portuguese",
      nl: "Dutch",
      hi: "Hindi",
      ja: "Japanese",
      zh: "Chinese",
    },
  },
  sarvam: {
    format: 'BCP-47 with the -IN region: "hi-IN", "ta-IN", "en-IN"',
    codes: {
      "en-IN": "Indian English",
      "hi-IN": "Hindi",
      "bn-IN": "Bengali",
      "gu-IN": "Gujarati",
      "kn-IN": "Kannada",
      "ml-IN": "Malayalam",
      "mr-IN": "Marathi",
      "od-IN": "Odia",
      "pa-IN": "Punjabi",
      "ta-IN": "Tamil",
      "te-IN": "Telugu",
    },
  },
  jigsawstack: {
    format: '"auto" to detect, or an ISO 639-1 code',
    codes: { auto: "Detect automatically" },
  },
  meetstream: {
    format: '"auto" to detect, or an ISO 639-1 code',
    codes: { auto: "Detect automatically" },
  },
};

/**
 * Format heuristics. These catch the common mix-ups before the API does.
 * They return warnings, never hard errors - a valid code this list does not
 * know about must still be allowed through.
 *
 * @returns {string[]} warnings
 */
export function checkLanguageFormat(provider, code) {
  if (!code) return [];
  const warnings = [];

  switch (provider) {
    case "deepgram":
      if (code.includes("_")) {
        warnings.push(
          `Deepgram uses hyphens, not underscores: "${code}" looks like an AssemblyAI code. ` +
            `Try "${code.replace(/_/g, "-")}".`,
        );
      }
      if (/-IN$/i.test(code)) {
        warnings.push(
          `"${code}" is a Sarvam-style Indic code. Deepgram wants a plain code like "hi". ` +
            "For Indic languages, sarvam is usually the better provider.",
        );
      }
      break;

    case "assemblyai":
      if (code.includes("-")) {
        warnings.push(
          `AssemblyAI uses underscores, not hyphens: try "${code.replace(/-/g, "_").toLowerCase()}".`,
        );
      }
      if (code !== code.toLowerCase()) {
        warnings.push(`AssemblyAI codes are lowercase: try "${code.toLowerCase()}".`);
      }
      break;

    case "sarvam":
      if (!/^[a-z]{2}-IN$/i.test(code)) {
        warnings.push(
          `Sarvam expects an Indic code of the form "xx-IN" (for example "hi-IN"). Got "${code}".`,
        );
      }
      break;

    default:
      break;
  }

  return warnings;
}

/** Human-readable catalogue for `node index.js --languages`. */
export function describeLanguages(provider) {
  const entry = LANGUAGE_EXAMPLES[provider];
  if (!entry) return `Unknown provider "${provider}".`;

  const lines = [
    `${provider} - field: ${LANGUAGE_FIELD[provider]}`,
    `  format: ${entry.format}`,
  ];
  for (const [code, name] of Object.entries(entry.codes)) {
    lines.push(`    ${code.padEnd(8)} ${name}`);
  }
  return lines.join("\n");
}
