"""
MeetStream Live Transcription Bot Creator.

Creates a MeetStream bot configured for live transcription using the
Deepgram Streaming provider. Unlike post-call transcription, the bot
payload uses live_transcription_required with a nested webhook_url instead
of the callback_url field used by the lifecycle webhook, and the
recording_config.transcript.provider uses deepgram_streaming instead of
deepgram.

Run in normal mode to create a bot and see interactive follow-up
instructions, or pass --headless to run without prompts, useful for CI and
automation. In both modes the script exits after the bot is created; the
transcription_server.py process handles the live payloads separately.
"""

import argparse
import os
import sys
import requests
from dotenv import load_dotenv

load_dotenv()

API_KEY = os.getenv("MEETSTREAM_API_KEY")
WEBHOOK_URL = os.getenv("WEBHOOK_URL")

parser = argparse.ArgumentParser(
    description="MeetStream live transcription demo - create a bot that streams "
                "transcription sentences to your server in real time"
)
parser.add_argument(
    "meeting_link",
    help="The meeting URL to join"
)
parser.add_argument(
    "--headless",
    action="store_true",
    help="Run without interactive prompts. Exits after bot creation."
)
args = parser.parse_args()


def log(message: str, headless: bool) -> None:
    if headless:
        print(f"[headless] {message}")
    else:
        print(message)


if not API_KEY:
    print("Error: MEETSTREAM_API_KEY is not set. Copy .env.example to .env and set your API key.")
    sys.exit(1)

if not WEBHOOK_URL or WEBHOOK_URL == "https://your-ngrok-url-here.ngrok-free.app/live-transcript":
    print("Error: WEBHOOK_URL is not set. Update .env with your ngrok forwarding URL "
          "followed by /live-transcript.")
    sys.exit(1)

# Deepgram Streaming configuration for live transcription
DEEPGRAM_STREAMING_CONFIG = {
    # nova-2 is used for streaming (not nova-3 which is for batch processing)
    "model": "nova-2",

    # sentence mode delivers one complete sentence per webhook payload
    # word mode delivers one word at a time (higher frequency, lower latency)
    # sentence mode is recommended for most use cases
    "transcription_mode": "sentence",

    "language": "en",

    # add punctuation automatically
    "punctuate": True,

    # format numbers, dates, times intelligently
    "smart_format": True,

    # silence threshold in milliseconds before declaring end of utterance
    # 300ms means a 300ms pause triggers a new sentence boundary
    "endpointing": 300,

    # voice activity detection events
    # fires events when speech starts and stops
    "vad_events": True,

    # milliseconds of silence after the last word before sending the utterance
    "utterance_end_ms": 1000,

    # audio encoding format
    "encoding": "linear16",

    # mono audio channel
    "channels": 1
}


def main() -> None:
    log("Creating bot with live transcription...", args.headless)

    payload = {
        "meeting_link": args.meeting_link,
        "bot_name": "MeetStream Live Transcription Bot",
        "video_required": False,
        "live_transcription_required": {
            "webhook_url": WEBHOOK_URL
        },
        "recording_config": {
            "transcript": {
                "provider": {
                    "deepgram_streaming": DEEPGRAM_STREAMING_CONFIG
                }
            }
        }
    }

    headers = {
        "Authorization": f"Token {API_KEY}",
        "Content-Type": "application/json"
    }

    try:
        response = requests.post(
            "https://api.meetstream.ai/api/v1/bots/create_bot",
            json=payload,
            headers=headers,
            timeout=30
        )
    except requests.exceptions.RequestException as e:
        print(f"Error: Failed to reach MeetStream API: {e}")
        sys.exit(1)

    if response.status_code == 201:
        data = response.json()
        log(f"Bot created: {data['bot_id']}", args.headless)
        log(f"Webhook URL: {WEBHOOK_URL}", args.headless)
        log(f"Status: {data['status']}", args.headless)
        log("", args.headless)

        if not args.headless:
            print("Bot is dispatched. Admit it in your meeting to start receiving live transcription.")
            print("Watch the transcription_server.py terminal for incoming sentences.")
            print()
            print("To save the transcript manually at any time, run:")
            print(f"  curl -X POST http://localhost:{os.getenv('SERVER_PORT', '4000')}/save/{{bot_id}}")

        if args.headless:
            log("Bot dispatched. Live transcription payloads will arrive at the webhook URL.", True)
            log("Exiting with code 0", True)
            sys.exit(0)

    elif response.status_code == 401:
        print("Error: Unauthorized. Check that MEETSTREAM_API_KEY is correct.")
        sys.exit(1)
    elif response.status_code == 400:
        print(f"Error: Bad request. {response.text}")
        sys.exit(1)
    else:
        print(f"Error: Unexpected status code {response.status_code}. {response.text}")
        sys.exit(1)


if __name__ == "__main__":
    main()
