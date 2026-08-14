"""
MeetStream Bot Creation Script

Creates a MeetStream bot with a callback_url pointing to a webhook
server exposed via ngrok. MeetStream will send lifecycle events to
that callback_url as the bot joins, records, and leaves the meeting.

Run without --headless for interactive use (you admit the bot manually).
Run with --headless for CI and automation (exits immediately after the
bot is created; events still arrive asynchronously at the webhook server).
"""

import argparse
import os
import sys
import requests
from dotenv import load_dotenv

load_dotenv()

API_KEY = os.getenv("MEETSTREAM_API_KEY")
CALLBACK_URL = os.getenv("CALLBACK_URL")

if not API_KEY:
    print("Error: MEETSTREAM_API_KEY is not set in .env")
    sys.exit(1)

if not CALLBACK_URL:
    print("Error: CALLBACK_URL is not set in .env")
    sys.exit(1)

if CALLBACK_URL == "https://your-ngrok-url-here.ngrok-free.app/webhooks/meetstream":
    print("Error: CALLBACK_URL in .env still has the placeholder value.")
    print("Run ngrok and update CALLBACK_URL with your actual ngrok URL.")
    sys.exit(1)

parser = argparse.ArgumentParser(
    description="MeetStream webhook lifecycle demo - create a bot with a callback URL "
                "to receive lifecycle events"
)
parser.add_argument(
    "meeting_link",
    help="The meeting URL to join (e.g. https://meet.google.com/abc-defg-hij)"
)
parser.add_argument(
    "--headless",
    action="store_true",
    help="Run without interactive prompts. Exits after bot creation."
)
args = parser.parse_args()


def log(message: str, headless: bool) -> None:
    prefix = "[headless] " if headless else ""
    print(f"{prefix}{message}")


log("Creating bot...", args.headless)

payload = {
    "meeting_link": args.meeting_link,
    "bot_name": "MeetStream Webhook Bot",
    "video_required": False,
    "callback_url": CALLBACK_URL
}

headers = {
    "Authorization": f"Token {API_KEY}",
    "Content-Type": "application/json"
}

try:
    response = requests.post(
        "https://api.meetstream.ai/api/v1/bots/create_bot",
        json=payload,
        headers=headers
    )
except requests.exceptions.RequestException as e:
    log(f"Request failed: {e}", args.headless)
    sys.exit(1)

if response.status_code == 201:
    data = response.json()
    log(f"Bot created: {data['bot_id']}", args.headless)
    log(f"Callback URL: {CALLBACK_URL}", args.headless)
    log(f"Status: {data['status']}", args.headless)
    log("", args.headless)

    if not args.headless:
        print("Bot is now dispatched. Admit it in your meeting to see lifecycle events.")
        print("Watch the webhook_server.py terminal for incoming events.")

    if args.headless:
        log("Bot dispatched. Webhook events will arrive at the callback URL.", True)
        log("Exiting with code 0", True)
        sys.exit(0)
elif response.status_code == 401:
    log("Authentication failed. Check your MEETSTREAM_API_KEY.", args.headless)
    sys.exit(1)
elif response.status_code == 400:
    log(f"Bad request: {response.json()}", args.headless)
    sys.exit(1)
else:
    log(f"Unexpected error: {response.status_code} {response.text}", args.headless)
    sys.exit(1)
