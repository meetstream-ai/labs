/**
 * Streaming transcription providers.
 *
 * `live_transcription_required` REQUIRES a streaming provider. Pairing it with
 * a post-call provider (`deepgram`, `assemblyai`, `sarvam`, `jigsawstack`,
 * `meetstream`) is an HTTP 400 at create_bot - post-call engines transcribe the
 * finished recording and have nothing to send while the meeting is running.
 *
 * The trade-off runs the other way too: a bot configured with a streaming
 * provider produces NO post-call transcript. Its lifecycle ends at
 * `audio.processed` - no `transcription.processed`, no `bot.done` - and
 * `GET /transcript/{id}/get_transcript` returns HTTP 202 forever.
 */

export const STREAMING_PROVIDERS = [
  "deepgram_streaming",
  "assemblyai_streaming",
  "jigsawstack_streaming",
  "meetstream_streaming",
];

export const POST_CALL_PROVIDERS = [
  "deepgram",
  "assemblyai",
  "sarvam",
  "jigsawstack",
  "meetstream",
];

/**
 * Reject a provider that cannot drive live captions, with an explanation
 * instead of an HTTP 400 from the API.
 */
export function assertStreamingProvider(provider) {
  if (STREAMING_PROVIDERS.includes(provider)) return;

  if (provider === "meeting_captions") {
    throw new Error(
      '"meeting_captions" uses the meeting platform\'s own captions and does not\n' +
        "deliver chunks to live_transcription_required.webhook_url. Read the caption\n" +
        "file from GET /bots/{bot_id}/detail after the meeting instead.",
    );
  }

  if (POST_CALL_PROVIDERS.includes(provider)) {
    throw new Error(
      `"${provider}" is a post-call provider. Combining it with\n` +
        "live_transcription_required is an HTTP 400: post-call engines only run once\n" +
        "the recording is finished, so there is nothing to stream during the meeting.\n" +
        `Use "${provider}_streaming" if it exists, or one of: ${STREAMING_PROVIDERS.join(", ")}.`,
    );
  }

  throw new Error(
    `Unknown provider "${provider}". Streaming providers: ${STREAMING_PROVIDERS.join(", ")}.`,
  );
}

/**
 * Build the single-key provider block for
 * `recording_config.transcript.provider`.
 *
 * @param {string} provider
 * @param {{ language?: string }} [options]
 */
export function buildProviderBlock(provider, options = {}) {
  const { language } = options;

  switch (provider) {
    case "deepgram_streaming": {
      const config = {
        model: process.env.DEEPGRAM_MODEL || "nova-3",
        language: language || "en",
        // "sentence" emits punctuated sentences, which is what captions want.
        transcription_mode: process.env.TRANSCRIPTION_MODE || "sentence",
        punctuate: true,
        smart_format: true,
        // Milliseconds of silence before Deepgram closes an utterance. Lower is
        // snappier captions; too low fragments sentences mid-thought.
        endpointing: Number.parseInt(process.env.ENDPOINTING_MS ?? "300", 10),
        vad_events: true,
      };
      return { deepgram_streaming: config };
    }

    case "assemblyai_streaming": {
      const config = {
        transcription_mode: process.env.TRANSCRIPTION_MODE || "raw",
        sample_rate: Number.parseInt(process.env.SAMPLE_RATE ?? "48000", 10),
        encoding: process.env.ENCODING || "pcm_s16le",
      };
      if (process.env.ASSEMBLYAI_SPEECH_MODEL) {
        // Singular `speech_model` on the streaming provider - note that the
        // post-call `assemblyai` provider uses `speech_models` (an array).
        config.speech_model = process.env.ASSEMBLYAI_SPEECH_MODEL;
      }
      return { assemblyai_streaming: config };
    }

    case "jigsawstack_streaming": {
      const config = {};
      if (language) config.language = language;
      return { jigsawstack_streaming: config };
    }

    case "meetstream_streaming": {
      return { meetstream_streaming: { language: language || "auto" } };
    }

    default:
      // assertStreamingProvider runs first, so this is unreachable in practice.
      throw new Error(`Unknown streaming provider "${provider}".`);
  }
}
