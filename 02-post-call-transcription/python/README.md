# meetstream-post-call-transcription / Python

This repo creates a MeetStream bot configured with a full Deepgram nova-3
transcription setup, including speaker diarization and utterance splitting,
joins a meeting, and retrieves the post-call transcript once the meeting
ends. It produces both a raw JSON transcript and a formatted markdown
transcript, along with a presigned URL for the recorded audio. The flow can
be triggered two ways: from the command line (`transcription.py`, with
normal and headless modes) or from a local web dashboard (`ui_server.py`).

## How it works

1. The script creates a MeetStream bot with a full Deepgram transcription configuration
2. The bot joins the meeting and records all audio
3. The script polls the bot status every 10 seconds until the meeting ends
4. After the meeting ends, MeetStream processes the audio through Deepgram
5. The script fetches the transcript using the transcript_id returned at creation
6. The script also fetches the presigned audio URL for the recorded WAV file
7. Three output files are saved: raw JSON, formatted markdown, and audio URL

## Prerequisites

- Python 3.9 or higher
- A MeetStream account and API key (sign up at app.meetstream.ai)
- A Google Meet, Zoom, or Microsoft Teams meeting link

## Deepgram configuration

This section explains every parameter in the `DEEPGRAM_CONFIG` dict. This is
the most important section in this README because it is what differentiates
this repo from the quickstart.

| Parameter       | Value   | What it does                                                    |
|-----------------|---------|-----------------------------------------------------------------|
| model           | nova-3  | Deepgram's most accurate model                                  |
| language        | en      | Language code for the audio                                     |
| punctuate       | true    | Adds punctuation automatically                                  |
| smart_format    | true    | Formats numbers, dates, times intelligently                     |
| diarize         | true    | Labels each segment with the speaker who said it                |
| paragraphs      | true    | Groups sentences into paragraphs based on natural pauses        |
| numerals        | true    | Converts spoken numbers to numerals                             |
| filler_words    | false   | Excludes um, uh, you know from the transcript                   |
| utterances      | true    | Splits transcript into complete spoken phrases with timestamps  |
| utt_split       | 0.8     | Pause length in seconds that starts a new utterance             |
| detect_language | false   | Auto-detects language when true, uses language field when false |

Three concrete examples of what `smart_format` and `diarize` produce:

Example 1: Without smart_format
```
"the meeting is on january fifteenth twenty twenty six at two pm"
```

With smart_format enabled:
```
"The meeting is on January 15th, 2026 at 2 PM"
```

Example 2: Without diarize, all speech is attributed to one speaker:
```
[Unknown] Hello can you hear me? Yes loud and clear. Great let us start.
```

With diarize enabled, each speaker gets their own label:
```
[Speaker 0] Hello can you hear me?
[Speaker 1] Yes loud and clear.
[Speaker 0] Great let us start.
```

Example 3: With filler_words set to false:
```
"Let us look at the, um, the API design"
```

With filler_words set to true (preserved):
```
"Let us look at the, um, the API design"
```

With filler_words set to false (removed):
```
"Let us look at the, the API design"
```

## Setup

1. Navigate to the python directory

From the root of the meetstream-sample-apps repository:
```
cd sample-apps/02-post-call-transcription/python
```

2. Install dependencies
```
pip install -r requirements.txt
```

3. Configure environment variables
```
cp .env.example .env
```
Open `.env` and set `MEETSTREAM_API_KEY` to your MeetStream API key.

## Usage - Normal mode

```
python transcription.py "https://meet.google.com/abc-defg-hij"
```

Full expected output:
```
Creating bot with Deepgram nova-3 transcription...
Bot created: f8025eaa-6b0d-48b9-b2a5-d085befa9b83
Transcript ID: f7fc9d94-7b54-44e9-a7f3-590147320e80
Polling status every 10 seconds...
Status: Joining    <- open your meeting and admit the bot now
Status: Active
Status: Active
Status: Done

Meeting ended. Waiting 30 seconds for post-processing...
Fetching transcript (attempt 1/3)...
Fetching audio URL...

Transcript (3 entries):

[00:01] Speaker 0
Hello, can everyone hear me?

[00:04] Speaker 1
Yes, loud and clear.

[00:07] Speaker 0
Great. Let us get started.

Saved: output/transcript_f8025eaa.json
Saved: output/transcript_f8025eaa.md
Saved: output/audio_f8025eaa_url.txt
Done.
```

## Usage - Headless mode

Basic headless usage:
```
python transcription.py "https://meet.google.com/abc-defg-hij" --headless
```

With all options:
```
python transcription.py "https://meet.google.com/abc-defg-hij" \
  --headless \
  --timeout 3600 \
  --poll-interval 15 \
  --output-dir /tmp/meetstream-output
```

Full expected headless output:
```
[headless] Creating bot with Deepgram nova-3 transcription...
[headless] Bot created: f8025eaa-6b0d-48b9-b2a5-d085befa9b83
[headless] Transcript ID: f7fc9d94-7b54-44e9-a7f3-590147320e80
[headless] Polling status every 10 seconds (timeout: 3600s)
[headless] Status: Joining (10s elapsed)
[headless] Status: Active (30s elapsed)
[headless] Status: Done (120s elapsed)
[headless] Waiting 30s for post-processing...
[headless] Fetching transcript (attempt 1/3)...
[headless] Fetching audio URL...
[headless] Saved: /tmp/meetstream-output/transcript_f8025eaa.json
[headless] Saved: /tmp/meetstream-output/transcript_f8025eaa.md
[headless] Saved: /tmp/meetstream-output/audio_f8025eaa_url.txt
[headless] Exiting with code 0
```

Exit codes:
- 0: success
- 1: failure (timeout, auth error, network error, terminal bot status)

GitHub Actions CI example:
```yaml
- name: Run MeetStream transcription
  run: |
    python transcription.py "${{ secrets.MEETING_LINK }}" \
      --headless \
      --timeout 3600 \
      --output-dir ./transcripts
  env:
    MEETSTREAM_API_KEY: ${{ secrets.MEETSTREAM_API_KEY }}

- name: Upload transcripts
  uses: actions/upload-artifact@v3
  with:
    name: meeting-transcripts
    path: ./transcripts/
```

## Usage - UI mode

In addition to the command-line script above, this repo includes a local
web dashboard that drives the exact same MeetStream API calls. It is
useful when you want to trigger a bot, watch its status, and read the
transcript without touching a terminal.

Start the dashboard:
```
python ui_server.py
```

Then open `http://localhost:8000` in a browser.

1. Paste your MeetStream API key into the "MeetStream API key" field. The
   key is only sent to the local server process and to the MeetStream API;
   it is never written to disk.
2. Paste the meeting link into the "Meeting link" field.
3. Click "Deploy Agent".
4. Watch the status tiles (Status, Elapsed, Speakers Detected, Files
   Saved), the current session table, and the live log panel update every
   1.5 seconds.
5. Once the bot reaches "Done", the dashboard waits 30 seconds for
   post-processing, fetches the transcript and audio URL, and writes the
   same three output files as the CLI (`transcript_{bot_id}.json`,
   `transcript_{bot_id}.md`, `audio_{bot_id}_url.txt`) into `output/`.
6. The "Output files" panel lists everything currently in `output/` and
   lets you open each file directly from the browser.

The UI mode reuses the same helper functions as `transcription.py`
(`create_bot`, `get_bot_status`, `fetch_transcript`, `fetch_audio_url`,
`save_outputs`) so the underlying API behavior is identical between the
CLI and the dashboard. Only one agent can be deployed at a time; the
"Deploy Agent" button is disabled while a session is running.

Note: `ui_server.py` runs a local Flask development server bound to
`127.0.0.1` only. It is meant for local testing, not for deployment on a
shared or public host.

## Arguments reference

| Argument        | Type   | Default  | Description                                    |
|-----------------|--------|----------|------------------------------------------------|
| meeting_link    | string | required | The meeting URL to join                        |
| --headless      | flag   | false    | Run without interactive prompts                |
| --timeout       | int    | 3600     | Max seconds to wait in headless mode           |
| --poll-interval | int    | 10       | Seconds between status checks                  |
| --output-dir    | string | output   | Directory to save output files                 |

## Output files

File 1: `transcript_{bot_id[:8]}.json`

The raw API response from MeetStream. Contains every utterance with
speaker label, text, start time, end time, and confidence score.

Example:
```json
{
  "message": [
    {
      "speaker": "Speaker 0",
      "text": "Hello, can everyone hear me?",
      "start": 1.2,
      "end": 3.4,
      "confidence": 0.98
    }
  ]
}
```

File 2: `transcript_{bot_id[:8]}.md`

Human-readable formatted transcript with speaker labels and timestamps.
Suitable for sharing with meeting participants or storing in a documentation system.

Example:
```
# Meeting Transcript
Bot ID: f8025eaa-6b0d-48b9-b2a5-d085befa9b83
Generated: 2026-07-06

---

[00:01] Speaker 0
Hello, can everyone hear me?

[00:04] Speaker 1
Yes, loud and clear.
```

File 3: `audio_{bot_id[:8]}_url.txt`

A presigned AWS S3 URL that gives temporary access to the recorded WAV file.
The URL expires after 1 hour. To download the audio:

```
# View the URL
cat output/audio_f8025eaa_url.txt

# Download the audio file using curl
curl -o meeting_audio.wav "$(cat output/audio_f8025eaa_url.txt)"
```

## Customizing the Deepgram configuration

The Deepgram configuration is defined as `DEEPGRAM_CONFIG` at the top of
`transcription.py`. To customize it, open the file and modify the values
before running.

Example: switching to a different language:
```python
DEEPGRAM_CONFIG = {
    "model": "nova-3",
    "language": "hi",        # Hindi
    "punctuate": True,
    "smart_format": True,
    "diarize": True,
    ...
}
```

Example: preserving filler words for speech analysis:
```python
DEEPGRAM_CONFIG = {
    ...
    "filler_words": True,    # keep um, uh, you know in the transcript
    ...
}
```

Example: adding domain-specific keywords for better accuracy:
```python
DEEPGRAM_CONFIG = {
    ...
    "keywords": ["Kubernetes", "Terraform", "CI/CD", "microservices"],
    ...
}
```

## Troubleshooting

Issue 1: Transcript returns empty message array

Symptom:
```
No transcript content found. The meeting may have had no speech.
```

Cause: The bot was in the meeting but no speech was detected. This happens
when the meeting was silent, when the bot was removed too quickly before
capturing enough audio, or when the audio quality was too low for Deepgram
to process.

Fix: Run a fresh meeting. Speak clearly for at least 30 seconds before
removing the bot. Say something like "Hello, this is a test of the
MeetStream transcription pipeline."

Issue 2: Transcript not available after 3 attempts

Symptom:
```
Fetching transcript (attempt 1/3)...
Transcript not ready yet, retrying in 15 seconds...
Fetching transcript (attempt 2/3)...
Transcript not ready yet, retrying in 15 seconds...
Fetching transcript (attempt 3/3)...
Transcript not available after 3 attempts.
```

Cause: Deepgram post-processing is still running. For longer meetings this
can take several minutes.

Fix: Wait 3 to 5 minutes after the meeting ends and fetch manually:
```python
import requests
transcript_id = "your-transcript-id-here"
headers = {"Authorization": "Token your-api-key-here"}
response = requests.get(
    f"https://api.meetstream.ai/api/v1/transcript/{transcript_id}/get_transcript",
    headers=headers
)
print(response.json())
```

Issue 3: Audio URL returns 404 in get_audio response

Cause: The audio file has not been processed yet, or the bot session did
not record any audio.

Fix: Wait 2 to 3 minutes after the meeting ends and run the script again
with the same meeting link. The audio file is usually available within
2 minutes of the bot leaving the meeting.

Issue 4: Speaker labels show "Speaker 0", "Speaker 1" instead of real names

Cause: This is expected behavior. Deepgram's diarization identifies speakers
by voice characteristics and labels them numerically. It does not have access
to the participant names from the meeting platform.

To map speaker labels to real names, compare the diarized transcript with
the participant metadata from the bot:
```python
response = requests.get(
    f"https://api.meetstream.ai/api/v1/bots/{bot_id}?type=participants",
    headers=headers
)
participants = response.json()
```

Cross-reference speaking start times with participant join times to build
a speaker-to-name mapping.

## Related MeetStream documentation

- MeetStream docs: https://docs.meetstream.ai
- Create Bot with Post Call Transcription: https://docs.meetstream.ai/guides/transcription-recordings/create-bot-with-post-call-transcription
- Bot API reference: https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/create-bot
- Transcript API reference: https://docs.meetstream.ai/api-reference/api-endpoints/transcript-endpoints
- Deepgram nova-3 documentation: https://developers.deepgram.com/docs/models-languages-overview

## License

This repo is MIT licensed. See LICENSE for details.
