"""
WebSocket server that receives live per-participant audio frames from a
MeetStream bot and saves one WAV file per speaker when the meeting ends.

MeetStream's bot connects TO this server as a client. This server accepts
that connection, decodes the binary audio frames it receives, accumulates
audio per speaker_id, and writes one WAV file per speaker on disconnect.
"""

import asyncio
import json
import os
import wave

import websockets
from dotenv import load_dotenv

from decode_frame import decode_audio_frame, duration_ms

load_dotenv()

HOST = "0.0.0.0"
PORT = int(os.environ.get("WS_PORT", 8765))
OUTPUT_DIR = os.path.join(os.getcwd(), "output")

SAMPLE_RATE = 48000
CHANNELS = 1
SAMPLE_WIDTH = 2

NO_SPEAKER = "NoSpeaker"


def safe_filename(speaker_id: str, speaker_name: str) -> str:
    """Build the output WAV filename for a given speaker."""
    safe_name = speaker_name.replace(" ", "_").replace("/", "_")
    safe_id = speaker_id.replace(" ", "_").replace("/", "_")
    short_id = safe_id[:8]
    return f"{safe_name}_{short_id}.wav"


def save_wav(filepath: str, pcm_bytes: bytes):
    """Write raw PCM16 mono audio to a WAV file."""
    with wave.open(filepath, "wb") as wav_file:
        wav_file.setnchannels(CHANNELS)
        wav_file.setsampwidth(SAMPLE_WIDTH)
        wav_file.setframerate(SAMPLE_RATE)
        wav_file.writeframes(pcm_bytes)


async def handle_connection(websocket):
    """Handle a single bot session from connect to disconnect."""
    # Reset all speaker buffers for this session so sequential bot
    # sessions do not mix audio.
    speaker_buffers = {}
    speaker_names = {}

    print("Bot connected, waiting for audio frames...")

    try:
        async for message in websocket:
            if isinstance(message, str):
                # The first message is the JSON text handshake
                try:
                    handshake = json.loads(message)
                except json.JSONDecodeError:
                    continue
                bot_id = handshake.get("bot_id")
                print(f"Handshake received - Bot ID: {bot_id}")
                continue

            # Binary audio frame
            decoded = decode_audio_frame(message)
            if decoded is None:
                continue

            speaker_id, speaker_name, pcm_bytes = decoded

            if speaker_name == NO_SPEAKER:
                continue

            if speaker_id not in speaker_buffers:
                speaker_buffers[speaker_id] = bytearray()
                speaker_names[speaker_id] = speaker_name
                print(f"New speaker detected: {speaker_name} ({speaker_id})")

            speaker_buffers[speaker_id].extend(pcm_bytes)

            total_seconds = duration_ms(bytes(speaker_buffers[speaker_id]), SAMPLE_RATE) / 1000
            print(f"[{speaker_name}] frame: {len(message)} bytes | total: {total_seconds:.1f}s")

    finally:
        print("Bot disconnected. Saving per-speaker WAV files...")

        os.makedirs(OUTPUT_DIR, exist_ok=True)

        summary = {}
        for speaker_id, pcm_buffer in speaker_buffers.items():
            speaker_name = speaker_names[speaker_id]
            filename = safe_filename(speaker_id, speaker_name)
            filepath = os.path.join(OUTPUT_DIR, filename)

            save_wav(filepath, bytes(pcm_buffer))

            seconds = duration_ms(bytes(pcm_buffer), SAMPLE_RATE) / 1000
            summary[speaker_name] = seconds
            print(f"Saved: {filename} ({seconds:.1f} seconds)")

        print()
        print("Session summary:")
        for speaker_name, seconds in summary.items():
            print(f"  {speaker_name}: {seconds:.1f} seconds of audio captured")

        print()
        print(f"Files saved to: {OUTPUT_DIR}")


async def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    print("MeetStream Live Audio Server")
    print(f"Listening on ws://{HOST}:{PORT}")
    print(f"Output directory: {OUTPUT_DIR}")
    print("Waiting for bot connection...")

    async with websockets.serve(handle_connection, HOST, PORT):
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
