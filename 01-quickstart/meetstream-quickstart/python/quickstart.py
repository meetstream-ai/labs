"""
MeetStream quickstart script.

Creates a MeetStream bot, sends it into a meeting, polls its status until
the meeting ends, then fetches and saves the post-call transcript.

Two modes of operation, controlled by the --headless flag:

Normal mode (default):
    Runs interactively. When the bot status is "Joining", the script prints
    a message asking you to admit the bot in your meeting. Open the meeting
    in your browser, admit the bot, and the script continues automatically.

    Example:
        python quickstart.py "https://meet.google.com/abc-defg-hij"

Headless mode (--headless):
    Runs without any interactive prompts. All output is prefixed with
    [headless]. Exits with code 0 on success and code 1 on any failure.
    Suitable for CI pipelines, cron jobs, and background automation.

    Example:
        python quickstart.py "https://meet.google.com/abc-defg-hij" --headless --timeout 1800

Required environment variable:
    MEETSTREAM_API_KEY - your MeetStream API key, read from a .env file
                          (see .env.example) or the environment.
"""

import argparse
import json
import os
import sys
import time
import requests
from dotenv import load_dotenv

load_dotenv()

API_KEY = os.getenv("MEETSTREAM_API_KEY")
if not API_KEY:
    print("Error: MEETSTREAM_API_KEY is not set in your .env file")
    sys.exit(1)

POST_PROCESSING_WAIT, TRANSCRIPT_MAX_ATTEMPTS, TRANSCRIPT_RETRY_WAIT = 30, 3, 15


def log(message: str, headless: bool) -> None:
    prefix = "[headless] " if headless else ""
    print(f"{prefix}{message}")


def create_bot(meeting_link: str, api_key: str, headless: bool) -> dict:
    log("Creating bot...", headless)
    url = "https://api.meetstream.ai/api/v1/bots/create_bot"
    headers = {"Authorization": f"Token {api_key}", "Content-Type": "application/json"}
    payload = {
        "meeting_link": meeting_link,
        "bot_name": "MeetStream Quickstart Bot",
        "video_required": False,
        "recording_config": {"transcript": {"provider": {"deepgram": {"model": "nova-3"}}}},
    }
    try:
        response = requests.post(url, json=payload, headers=headers, timeout=15)
    except requests.exceptions.RequestException as e:
        log(f"Network error: {e}", headless)
        sys.exit(1)
    if response.status_code == 201:
        data = response.json()
        log(f"Bot created: {data['bot_id']}", headless)
        return data
    if response.status_code == 401:
        log("Authentication failed. Check your MEETSTREAM_API_KEY.", headless)
    elif response.status_code == 400:
        log(f"Bad request: {response.json()}", headless)
    else:
        log(f"Unexpected error {response.status_code}: {response.text}", headless)
    sys.exit(1)


def get_bot_status(bot_id: str, api_key: str) -> str | None:
    url = f"https://api.meetstream.ai/api/v1/bots/{bot_id}/status"
    headers = {"Authorization": f"Token {api_key}"}
    try:
        response = requests.get(url, headers=headers, timeout=10)
        return response.json().get("status") if response.status_code == 200 else None
    except requests.exceptions.RequestException:
        return None


def fetch_transcript(transcript_id: str, api_key: str, headless: bool) -> dict | None:
    log("Fetching transcript...", headless)
    url = f"https://api.meetstream.ai/api/v1/transcript/{transcript_id}/get_transcript"
    headers = {"Authorization": f"Token {api_key}"}
    try:
        response = requests.get(url, headers=headers, timeout=10)
        if response.status_code == 200:
            return response.json()
        log(f"Transcript not ready yet (status {response.status_code})", headless)
        return None
    except requests.exceptions.RequestException as e:
        log(f"Error fetching transcript: {e}", headless)
        return None


def print_transcript(transcript_data: dict, headless: bool) -> None:
    messages = transcript_data.get("message", [])
    if not messages:
        log("No transcript content found. The meeting may have had no speech.", headless)
        return
    log("", headless)
    for entry in messages:
        log(f"[{entry.get('speaker', 'Unknown')}] {entry.get('text', '')}", headless)
    log("", headless)


def save_transcript(transcript_data: dict, bot_id: str, headless: bool) -> str:
    filename = f"transcript_{bot_id[:8]}.json"
    with open(filename, "w", encoding="utf-8") as f:
        json.dump(transcript_data, f, indent=2, ensure_ascii=False)
    log(f"Transcript saved to: {filename}", headless)
    return filename


def main():
    parser = argparse.ArgumentParser(description="MeetStream quickstart - create a bot, wait for the meeting to end, fetch transcript")
    parser.add_argument("meeting_link", help="The meeting URL to join (e.g. https://meet.google.com/abc-defg-hij)")
    parser.add_argument("--headless", action="store_true", help="Run without interactive prompts. Suitable for CI pipelines and automation.")
    parser.add_argument("--timeout", type=int, default=3600, help="Maximum seconds to wait for the meeting to end (default: 3600).")
    parser.add_argument("--poll-interval", type=int, default=10, help="Seconds between status checks (default: 10)")
    args = parser.parse_args()
    bot = create_bot(args.meeting_link, API_KEY, args.headless)
    bot_id, transcript_id = bot["bot_id"], bot.get("transcript_id") or bot["bot_id"]
    log(f"Polling status every {args.poll_interval} seconds (timeout: {args.timeout}s)" if args.headless else f"Polling status every {args.poll_interval} seconds...", args.headless)

    start_time, status, last_status = time.time(), None, None
    while status != "Done":
        time.sleep(args.poll_interval)
        status = get_bot_status(bot_id, API_KEY)
        elapsed = int(time.time() - start_time)
        if args.headless:
            log(f"Status: {status} ({elapsed}s elapsed)", args.headless)
        elif status != last_status:
            if status == "Joining":
                log("Status: Joining    <- open your meeting and admit the bot now", args.headless)
            else:
                log(f"Status: {status}", args.headless)
        last_status = status
        if status in ("Fatal", "PermissionDenied", "NotAllowed"):
            log(f"Status: {status}", args.headless)
            sys.exit(1)
        if status != "Done" and elapsed >= args.timeout:
            log(f"Timeout reached after {args.timeout}s. Bot status was: {status}", args.headless)
            sys.exit(1)

    if not args.headless:
        log("Meeting ended. Fetching transcript...", args.headless)
    log("Waiting 30 seconds for post-processing..." if not args.headless else "Meeting ended. Waiting 30s for post-processing...", args.headless)
    time.sleep(POST_PROCESSING_WAIT)

    transcript_data = None
    for attempt in range(TRANSCRIPT_MAX_ATTEMPTS):
        transcript_data = fetch_transcript(transcript_id, API_KEY, args.headless)
        if transcript_data is not None:
            break
        if attempt < TRANSCRIPT_MAX_ATTEMPTS - 1:
            time.sleep(TRANSCRIPT_RETRY_WAIT)
    if transcript_data is None:
        log(f"Transcript not ready. Fetch it manually later using transcript_id: {transcript_id}", args.headless)
        sys.exit(1)

    print_transcript(transcript_data, args.headless)
    save_transcript(transcript_data, bot_id, args.headless)
    log("Exiting with code 0" if args.headless else "Done.", args.headless)
    if args.headless:
        sys.exit(0)


if __name__ == "__main__":
    main()
