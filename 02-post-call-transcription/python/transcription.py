"""
meetstream-post-call-transcription

Creates a MeetStream bot configured with a full Deepgram nova-3 transcription
setup (speaker diarization, utterance splitting, smart formatting), waits for
the meeting to end, then fetches the post-call transcript and audio URL.
Saves the transcript as both raw JSON and a formatted markdown file.

Two modes of operation:

Normal mode (default, no --headless flag):
    Runs interactively. Prints human-readable status updates and tells the
    developer when to admit the bot into the meeting.

    Example:
        python transcription.py "https://meet.google.com/abc-defg-hij"

Headless mode (--headless flag):
    Runs without interactive prompts. All output is prefixed with [headless].
    Exits with code 0 on success, code 1 on failure. Suitable for CI
    pipelines and other automation.

    Example:
        python transcription.py "https://meet.google.com/abc-defg-hij" \\
          --headless \\
          --timeout 3600 \\
          --output-dir /tmp/meetstream-output
"""

import argparse
import json
import os
import sys
import time
from datetime import date

import requests
from dotenv import load_dotenv

load_dotenv()


# Callables registered here receive every formatted log line in addition to
# it being printed to stdout. ui_server.py uses this to stream progress into
# the web dashboard without changing any CLI-facing behavior.
_log_listeners: list = []


def add_log_listener(fn) -> None:
    _log_listeners.append(fn)


def log(message: str, headless: bool) -> None:
    prefix = "[headless] " if headless else ""
    line = f"{prefix}{message}"
    print(line)
    for listener in _log_listeners:
        listener(line)


# Deepgram transcription configuration.
# Defined as a module-level constant so developers can find and modify the
# transcription settings without reading through the main logic below.
DEEPGRAM_CONFIG = {
    # nova-3 is Deepgram's most accurate model as of 2026
    "model": "nova-3",

    # language code for the meeting audio
    "language": "en",

    # add punctuation to the transcript automatically
    "punctuate": True,

    # format numbers, dates, and times intelligently
    # example: "twenty twenty six" becomes "2026"
    "smart_format": True,

    # identify who is speaking and label each segment with a speaker number
    # required for multi-speaker transcripts
    "diarize": True,

    # group sentences into paragraphs based on natural pauses
    "paragraphs": True,

    # convert spoken numbers to numerals
    # example: "fifty percent" becomes "50%"
    "numerals": True,

    # exclude filler words like "um", "uh", "you know" from the transcript
    # set to True for cleaner transcripts, False to preserve natural speech
    "filler_words": False,

    # split the transcript into utterances (complete spoken phrases)
    # required for the per-entry timestamp formatting used in this script
    "utterances": True,

    # silence threshold in seconds for splitting utterances
    # 0.8 means a pause of 0.8 seconds or more starts a new utterance
    "utt_split": 0.8,

    # set to True to auto-detect language instead of using the language field
    # leave False when you know the language in advance for faster processing
    "detect_language": False,

    # custom keywords to boost recognition accuracy for domain-specific terms
    "keywords": ["MeetStream", "recording", "transcript"],

    # terms to search for in the transcript
    # the API will return timestamps for each occurrence
    "search": ["MeetStream", "recording"],

    # custom tags for categorizing this transcript in your system
    "tag": ["meetstream-sample"]
}


def create_bot(meeting_link: str, api_key: str, headless: bool) -> dict:
    log("Creating bot with Deepgram nova-3 transcription...", headless)

    url = "https://api.meetstream.ai/api/v1/bots/create_bot"
    headers = {"Authorization": f"Token {api_key}"}
    payload = {
        "meeting_link": meeting_link,
        "bot_name": "MeetStream Transcription Bot",
        "video_required": False,
        "recording_config": {
            "transcript": {
                "provider": {
                    "deepgram": DEEPGRAM_CONFIG
                }
            }
        }
    }

    try:
        response = requests.post(url, headers=headers, json=payload, timeout=10)
    except requests.exceptions.RequestException as e:
        log(f"Network error creating bot: {e}", headless)
        sys.exit(1)

    if response.status_code == 201:
        data = response.json()
        log(f"Bot created: {data.get('bot_id')}", headless)
        log(f"Transcript ID: {data.get('transcript_id')}", headless)
        return data
    elif response.status_code == 401:
        log("Authentication failed. Check your MEETSTREAM_API_KEY.", headless)
        sys.exit(1)
    elif response.status_code == 400:
        log(f"Bad request: {response.json()}", headless)
        sys.exit(1)
    else:
        log(f"Unexpected error {response.status_code}: {response.text}", headless)
        sys.exit(1)


def get_bot_status(bot_id: str, api_key: str) -> str | None:
    url = f"https://api.meetstream.ai/api/v1/bots/{bot_id}/status"
    headers = {"Authorization": f"Token {api_key}"}
    try:
        response = requests.get(url, headers=headers, timeout=10)
        if response.status_code == 200:
            return response.json().get("status")
        return None
    except requests.exceptions.RequestException:
        return None


def fetch_transcript(transcript_id: str, api_key: str, headless: bool) -> dict | None:
    url = f"https://api.meetstream.ai/api/v1/transcript/{transcript_id}/get_transcript"
    headers = {"Authorization": f"Token {api_key}"}

    for attempt in range(1, 4):
        log(f"Fetching transcript (attempt {attempt}/3)...", headless)
        try:
            response = requests.get(url, headers=headers, timeout=10)
            if response.status_code == 200:
                data = response.json()
                messages = data.get("message", [])
                if messages:
                    return data
                log("Transcript not ready yet, retrying in 15 seconds...", headless)
            else:
                log(f"Transcript fetch returned {response.status_code}, retrying...", headless)
        except requests.exceptions.RequestException as e:
            log(f"Network error fetching transcript: {e}", headless)

        if attempt < 3:
            time.sleep(15)

    log("Transcript not available after 3 attempts.", headless)
    log(f"You can fetch it manually using transcript_id in your .env or logs.", headless)
    return None


def fetch_audio_url(bot_id: str, api_key: str, headless: bool) -> str | None:
    log("Fetching audio URL...", headless)
    url = f"https://api.meetstream.ai/api/v1/bots/{bot_id}/get_audio"
    headers = {"Authorization": f"Token {api_key}"}
    try:
        response = requests.get(url, headers=headers, timeout=10)
        if response.status_code == 200:
            data = response.json()
            audio_url = data.get("audio_url") or data.get("url")
            if audio_url:
                return audio_url
            log("Audio URL not found in response.", headless)
            return None
        log(f"Audio fetch returned {response.status_code}.", headless)
        return None
    except requests.exceptions.RequestException as e:
        log(f"Network error fetching audio URL: {e}", headless)
        return None


def format_timestamp(seconds: float) -> str:
    minutes = int(seconds) // 60
    secs = int(seconds) % 60
    return f"{minutes:02d}:{secs:02d}"


def format_transcript_markdown(transcript_data: dict, bot_id: str) -> str:
    messages = transcript_data.get("message", [])

    if not messages:
        return (
            f"# Meeting Transcript\n"
            f"Bot ID: {bot_id}\n"
            f"Generated: {date.today().isoformat()}\n\n"
            f"---\n\n"
            f"No transcript content found. The meeting may have had no speech.\n"
        )

    lines = [
        "# Meeting Transcript",
        f"Bot ID: {bot_id}",
        f"Generated: {date.today().isoformat()}",
        "",
        "---",
        "",
    ]

    for entry in messages:
        speaker = entry.get("speaker", "Unknown Speaker")
        text = entry.get("text", "")
        start = entry.get("start", 0)
        timestamp = format_timestamp(start)
        lines.append(f"[{timestamp}] {speaker}")
        lines.append(text)
        lines.append("")

    return "\n".join(lines)


def save_outputs(transcript_data: dict | None, audio_url: str | None, bot_id: str,
                  output_dir: str, headless: bool) -> None:
    os.makedirs(output_dir, exist_ok=True)
    short_id = bot_id[:8]

    json_path = os.path.join(output_dir, f"transcript_{short_id}.json")
    with open(json_path, "w") as f:
        json.dump(transcript_data if transcript_data is not None else {}, f, indent=2)
    log(f"Saved: {json_path}", headless)

    md_path = os.path.join(output_dir, f"transcript_{short_id}.md")
    markdown = format_transcript_markdown(transcript_data if transcript_data is not None else {}, bot_id)
    with open(md_path, "w") as f:
        f.write(markdown)
    log(f"Saved: {md_path}", headless)

    audio_path = os.path.join(output_dir, f"audio_{short_id}_url.txt")
    with open(audio_path, "w") as f:
        f.write(audio_url if audio_url else "Audio URL not available.")
    log(f"Saved: {audio_path}", headless)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="MeetStream post-call transcription - create a bot with Deepgram "
                    "transcription, wait for the meeting to end, fetch transcript and audio"
    )
    parser.add_argument(
        "meeting_link",
        help="The meeting URL to join (e.g. https://meet.google.com/abc-defg-hij)"
    )
    parser.add_argument(
        "--headless",
        action="store_true",
        help="Run without interactive prompts. Suitable for CI pipelines and automation."
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=3600,
        help="Maximum seconds to wait for the meeting to end in headless mode (default: 3600)"
    )
    parser.add_argument(
        "--poll-interval",
        type=int,
        default=10,
        help="Seconds between status checks (default: 10)"
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default="output",
        help="Directory to save output files (default: output/)"
    )
    args = parser.parse_args()

    api_key = os.getenv("MEETSTREAM_API_KEY")
    if not api_key:
        print("Error: MEETSTREAM_API_KEY is not set in your .env file")
        sys.exit(1)

    headless = args.headless

    os.makedirs(args.output_dir, exist_ok=True)

    bot_data = create_bot(args.meeting_link, api_key, headless)
    bot_id = bot_data.get("bot_id")
    transcript_id = bot_data.get("transcript_id")

    if headless:
        log(f"Polling status every {args.poll_interval} seconds (timeout: {args.timeout}s)", headless)
    else:
        log(f"Polling status every {args.poll_interval} seconds...", headless)

    elapsed = 0
    while True:
        time.sleep(args.poll_interval)
        elapsed += args.poll_interval
        status = get_bot_status(bot_id, api_key)

        if headless:
            log(f"Status: {status} ({elapsed}s elapsed)", headless)
        else:
            if status == "Joining":
                log("Status: Joining    <- open your meeting and admit the bot now", headless)
            elif status == "Active":
                log("Status: Active", headless)

        if status == "Done":
            break
        elif status in ("Fatal", "PermissionDenied"):
            if not headless:
                log(f"Status: {status}", headless)
            sys.exit(1)

        if headless and elapsed >= args.timeout:
            log(f"Timed out after {args.timeout} seconds waiting for the meeting to end.", headless)
            sys.exit(1)

    log("Meeting ended. Waiting 30 seconds for post-processing...", headless)
    time.sleep(30)

    transcript_data = fetch_transcript(transcript_id, api_key, headless)
    audio_url = fetch_audio_url(bot_id, api_key, headless)

    if transcript_data is not None:
        messages = transcript_data.get("message", [])
        log(f"Transcript ({len(messages)} entries):", headless)
        log("", headless)
        for entry in messages:
            speaker = entry.get("speaker", "Unknown Speaker")
            text = entry.get("text", "")
            start = entry.get("start", 0)
            timestamp = format_timestamp(start)
            log(f"[{timestamp}] {speaker}", headless)
            log(text, headless)
            log("", headless)

    save_outputs(transcript_data, audio_url, bot_id, args.output_dir, headless)

    if headless:
        log("Exiting with code 0", headless)
        sys.exit(0)
    else:
        log("Done.", headless)


if __name__ == "__main__":
    main()
