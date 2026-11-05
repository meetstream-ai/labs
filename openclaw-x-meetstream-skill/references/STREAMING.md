# Custom live audio, video and control bridges

Verified 2026-09-11. Build a separate long-running service for a custom AI/media
pipeline. Do not supply custom bridge URLs when using hosted agent_config_id.

## Audio channel

Create with `live_audio_required:{"websocket_url":"wss://your-host/audio"}`.
The current protocol begins with a JSON ready handshake carrying bot_id, then
binary frames: byte 0 is 0x01; the next little-endian uint16 gives UTF-8
speaker-ID length; then ID bytes, uint16 speaker-name length, name bytes, and
remaining PCM bytes. Validate every length before decoding. Audio is 48 kHz,
signed 16-bit little-endian mono mixed audio; speaker metadata identifies the
dominant speaker and does not isolate their microphone. Handle NoSpeaker,
variable frame sizes, unknown frame types, bounded buffering and reconnects.
Legacy JSON PCMChunk messages carry base64 audioData and speakerName.
Source: [audio protocol](https://docs.meetstream.ai/guides/websockets/real-time-audio-streaming).

## Control channel

Set `socket_connection_url:{"websocket_url":"wss://your-host/bridge"}`.
Correlate its ready handshake with the audio connection's bot_id. JSON
commands include sendaudio, sendmsg/sendchat, interrupt, sendimg/sendimg_url;
inspect the command guide for platform-specific fields. Outgoing sendaudio
carries base64 audiochunk, sample_rate 48000, encoding pcm16, channels 1 and
endianness little. An interrupt with action clear_audio_queue cancels queued
speech. Incoming usermsg delivers meeting chat. Use explicit bot_id and
serialize writes to each socket.
Source: [commands](https://docs.meetstream.ai/guides/websockets/meeting-control-patterns).

Maintain one AI session per bot using a lock because the two sockets can
connect concurrently. Resample incoming audio to the model's rate and output
to 48 kHz. Bound queue sizes, cancel obsolete playback on interruption, and
clean up sessions after both channels close with a bounded reconnect grace
period. Keep the bot's own audio from feeding back into the agent. Authenticate
public endpoints and retain only the data the workflow needs. The official
bridge skeleton requires implementing its placeholder AI session; it is not
a ready-to-run voice agent merely by starting the HTTP server.
Source: [bridge architecture](https://docs.meetstream.ai/guides/websockets/bridge-server-architecture).

For live video read CreateBotRequestLiveVideoRequired in openapi.json and
[per-participant video](https://docs.meetstream.ai/guides/transcription-recordings/per-participant-video)
for recording/stream formats. Live transcription is a separate HTTPS webhook
configuration; see [OPERATIONS.md](OPERATIONS.md).
