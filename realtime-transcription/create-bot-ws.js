/**
 * MeetStream Labs — Real-Time Transcription (WebSocket)
 * create-bot-ws.js
 *
 * Creates a MeetStream bot with live transcription delivered over WebSocket
 * instead of webhook POSTs.
 *
 * Usage:
 *   MEETSTREAM_API_KEY=<key> WEBSOCKET_URL=<url> node create-bot-ws.js <meeting_url>
 *
 * Example:
 *   MEETSTREAM_API_KEY=sk_live_xxx \
 *   WEBSOCKET_URL=wss://abc123.ngrok.io \
 *   node create-bot-ws.js https://meet.google.com/abc-defg-hij
 */

const API_KEY       = process.env.MEETSTREAM_API_KEY;
const WEBSOCKET_URL = process.env.WEBSOCKET_URL;
const MEETING_URL   = process.argv[2];

if (!API_KEY || !WEBSOCKET_URL || !MEETING_URL) {
  console.error(
    "Usage: MEETSTREAM_API_KEY=<key> WEBSOCKET_URL=<url> node create-bot-ws.js <meeting_url>"
  );
  process.exit(1);
}

const PROVIDER = "deepgram";

const providers = {
  deepgram: {
    deepgram_streaming: {
      transcription_mode: "sentence",
      model: "nova-2",
      language: "en",
      punctuate: true,
      smart_format: true,
      endpointing: 300,
      vad_events: true,
      utterance_end_ms: 1000,
      encoding: "linear16",
      channels: 1,
    },
  },
  assemblyai: {
    assemblyai_streaming: {
      transcription_mode: "raw",
      sample_rate: 48000,
      speech_model: "universal-streaming-english",
      format_turns: false,
      encoding: "pcm_s16le",
      vad_threshold: "0.4",
      end_of_turn_confidence_threshold: "0.4",
      inactivity_timeout: 300,
      min_end_of_turn_silence_when_confident: "400",
      max_turn_silence: "1280",
    },
  },
};

if (!providers[PROVIDER]) {
  console.error(`Unknown provider "${PROVIDER}". Use "deepgram" or "assemblyai".`);
  process.exit(1);
}

const payload = {
  meeting_link: MEETING_URL,
  bot_name: "MeetStream Transcription Bot (WebSocket)",

  live_transcription_required: {
    websocket_url: `${WEBSOCKET_URL}/ws`,
  },

  recording_config: {
    transcript: {
      provider: providers[PROVIDER],
    },
  },

  custom_attributes: {
    provider: PROVIDER,
    transport: "websocket",
  },
};

async function createBot() {
  console.log(`\nCreating bot with ${PROVIDER} live transcription (WebSocket)...`);
  console.log(`  Meeting   : ${MEETING_URL}`);
  console.log(`  WebSocket : ${WEBSOCKET_URL}/ws\n`);

  const res = await fetch("https://api.meetstream.ai/api/v1/bots/create_bot", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Token ${API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json();

  if (!res.ok) {
    console.error("Failed to create bot:", JSON.stringify(data, null, 2));
    process.exit(1);
  }

  const botId = data.bot_id ?? data.id;
  console.log("✓ Bot created");
  console.log(`  bot_id  : ${botId}`);
  console.log(`\nTranscription events → WS  ${WEBSOCKET_URL}/ws`);
  console.log(`Session dump          → GET ${WEBSOCKET_URL}/sessions/${botId}\n`);
}

createBot().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
