"""
Create a MeetStream bot and send it into a meeting with live per-participant
audio streaming enabled.

Run this after audio_server.py and your ngrok tunnel are already running.
"""

import os

import requests
from dotenv import load_dotenv

load_dotenv()

API_KEY = os.environ.get("MEETSTREAM_API_KEY")
MEETING_LINK = os.environ.get("MEETING_LINK")

if not API_KEY:
    raise ValueError("MEETSTREAM_API_KEY is not set. Add it to your .env file.")
if not MEETING_LINK:
    raise ValueError("MEETING_LINK is not set. Add it to your .env file.")

# Replace this with your ngrok wss:// URL before running.
# Run: ngrok http 8765 --host-header="localhost:8765"
# Then copy the Forwarding URL and change https:// to wss://
WEBSOCKET_URL = "wss://differentiable-margarett-singlehandedly.ngrok-free.dev"

API_URL = "https://api.meetstream.ai/api/v1/bots/create_bot"


def main():
    headers = {
        "Authorization": f"Token {API_KEY}",
        "Content-Type": "application/json",
    }

    payload = {
        "meeting_link": MEETING_LINK,
        "bot_name": "MeetStream Audio Bot",
        "video_required": False,
        "live_audio_required": {
            "websocket_url": WEBSOCKET_URL
        }
    }

    response = requests.post(API_URL, headers=headers, json=payload)

    if response.status_code == 201:
        data = response.json()
        print("Bot created successfully")
        print(f"Bot ID:      {data.get('bot_id')}")
        print(f"Meeting URL: {data.get('meeting_url')}")
        print(f"Status:      {data.get('status')}")
        print()
        print("Admit the bot in your meeting to start receiving audio.")
    else:
        print(f"Error {response.status_code}: {response.text}")


if __name__ == "__main__":
    main()
